/**
 * The measurement queue (build spec §5 "Probe queue", plan §4.3): rounds of
 * questions × engines × repeats, asked one at a time through the probe host,
 * each answer checked, kept with its screenshot, and counted only when it is
 * an answer.
 *
 * Hidden knowledge:
 *
 * - **One ask at a time, across every process.** The probe host drives
 *   logged-in browser tabs and serves one request at a time (it answers 409
 *   when busy). `tickProbe` asks only while holding the Postgres advisory lock
 *   `hashtext('evimed_geo_probe')` (`GeoMeasureStore.withProbeLock`); a second
 *   worker finds it held and asks nothing. One question × one engine × a fresh
 *   chat per request, `deep=0` — five engines bundled in one request are atomic
 *   and a timeout loses all five (the owner's `probe_client.py`).
 * - **Always a fresh request.** There is no answer cache: every job is a new
 *   ask. A replayed answer would copy the last one ten times and make every
 *   stability, noise and re-measure verdict false (geo-skills decision 13).
 * - **Busy is a reason to wait, not a result.** 409/429 from the probe, or a
 *   vendor's own "busy" status word (`sanity.json` `retriable_raw_statuses`),
 *   puts the job back without using an attempt and backs off exponentially
 *   (`PROBE_BACKOFF_*`). After `PROBE_BACKOFF_MAX_RETRIES` busy answers in a
 *   row attempts are spent again, so a probe stuck busy cannot hold a round
 *   open forever, and the operator is told.
 * - **Suspect answers leave the denominator and are asked again.** A login
 *   page, captcha, empty shell, chrome-only page or capacity notice
 *   (`geoSanity.mjs`) is kept as a `suspect` snapshot, alerted, and its job
 *   re-queued up to `GEO_JOB_MAX_ATTEMPTS` asks: every question should end a
 *   round with the same number of valid answers per engine, because the
 *   metrics withdraw a pool's rates when its questions' denominators differ
 *   (package M, "evenness"). A refusal is an answer and stays.
 * - **A circuit breaker per engine.** `PROBE_CIRCUIT_BREAK_CONSECUTIVE`
 *   (the owner's catalogue constant when the metrics table carries it, 3 until
 *   then) suspect or failed answers in a row pause that engine: its jobs wait,
 *   the other engines go on, `/providers` is re-checked every 10 minutes and
 *   the engine resumes when its tab is found again. A round whose only
 *   remaining jobs are on a paused engine finishes with those jobs skipped, and
 *   the metrics then read that engine as absent for the round (「未测」), never
 *   as zero. The counters are per engine: one shared counter never reaches the
 *   threshold while any other engine answers (the owner's night run: doubao
 *   failed 14 times in a row between four healthy engines). A probe host that
 *   cannot be reached at all pauses every engine the same way.
 * - **Big rounds run at night.** Baseline, weekly and noise rounds of more
 *   than 60 asks are asked only inside `OPEN_SCIENCE_GEO_NIGHT_WINDOW`
 *   (`22-07` in `OPEN_SCIENCE_GEO_TIMEZONE`, Asia/Shanghai); other rounds —
 *   a confirmation, a sentinel, a post-publication check — any time. One
 *   project asks at most `OPEN_SCIENCE_GEO_WEEKLY_ASK_CAP` times a week
 *   (Monday 00:00 in the zone); past it its jobs wait for next week.
 * - **Leases survive a crash**: a job is leased for the ask's timeout plus a
 *   minute; an expired lease is re-queued.
 * - **Baidu is measured through the vendor's inclusion check** (package C's
 *   `GeoInclusionClient`) until the probe host has a Baidu tab: submit, poll,
 *   a snapshot with `surface.mode = 'inclusion'` and no answer text, and a
 *   facts row that says only whether the brand was found. Accuracy and
 *   citation for that engine are then `not_measurable`, never zero. It does
 *   not use the probe host, so it runs outside the probe lock and the night
 *   window.
 *
 * @module geoProbeQueue
 */

import { GEO_METRICS, geoConstant } from "@evimed/domain";
import { GEO_PROBE_ALLOWED_PROVIDERS, probeUpstream } from "./geoProbeGateway.mjs";
import { citationRows } from "./geoParse.mjs";
import { classifyProbeAnswer, isRetriableRawStatus } from "./geoSanity.mjs";
import { storeGeoScreenshot } from "./geoScreenshots.mjs";
import { HttpError, randomId } from "./security.mjs";

// ───────────────────────── vocabularies and limits ─────────────────────────

/** Round kinds (`rounds.kind`). */
export const GEO_ROUND_KINDS = Object.freeze(["baseline", "weekly", "sentinel", "post_publication", "confirm", "noise", "single_step"]);
/** Engines the probe host has tabs for. */
export const GEO_PROBE_ENGINES = Object.freeze([...GEO_PROBE_ALLOWED_PROVIDERS]);
/** Every engine a round may name: the probe's, and Baidu through the inclusion channel. */
export const GEO_MEASURE_ENGINES = Object.freeze([...GEO_PROBE_ENGINES, "baidu"]);

/** @param {string} name @param {number} fallback */
function catalogue(name, fallback) {
  try {
    const value = Number(geoConstant(name));
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Suspect or failed answers in a row that pause an engine (the owner's catalogue constant, in the domain's table). */
export const GEO_PROBE_BREAK_AFTER = Number(geoConstant("PROBE_CIRCUIT_BREAK_CONSECUTIVE"));
/** How often a paused engine's tab is re-checked. */
export const GEO_PROBE_RECHECK_MS = 10 * 60_000;
/**
 * The measurement queue's probe timeout: the probe host's own ceiling is about
 * five minutes a question, and an overnight round has no user waiting, so it
 * is not the runtime tool's 150 s cap (`geoProbeTimeoutMs`).
 */
export const GEO_QUEUE_PROBE_TIMEOUT_MS = 360_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
/** A job's lease: the ask, its screenshot, and a margin for the writes around them. */
const LEASE_MARGIN_MS = 60_000;
/**
 * How long a paused engine may hold a round open without a failed re-check:
 * a pause alone is not proof the engine is down (its tab may be back at the
 * next check), so its jobs are skipped only once a re-check since the pause
 * failed, or after this long.
 */
export const GEO_PROBE_SKIP_AFTER_MS = 30 * 60_000;
/** Asks one job may use before it is failed (the first and two retries). */
export const GEO_JOB_MAX_ATTEMPTS = 3;
/** Rounds of these kinds with more asks than this wait for the night window. */
export const GEO_NIGHT_MIN_ASKS = 60;
/** The most asks one round may plan: a bound on a mistyped request, not a product limit. */
export const GEO_ROUND_MAX_ASKS = 5_000;
const BACKOFF_START_MS = catalogue("PROBE_BACKOFF_START_SEC", 1) * 1_000;
const BACKOFF_CAP_MS = catalogue("PROBE_BACKOFF_CAP_SEC", 60) * 1_000;
const BUSY_MAX = catalogue("PROBE_BACKOFF_MAX_RETRIES", 6);
/** A suspect or failed ask is asked again after this times its attempt number. */
const RETRY_DELAY_MS = 2 * 60_000;
/** The inclusion channel: how long a submitted task is held, and how often it is polled. */
const INCLUSION_HOLD_MS = 30 * 60_000;
const INCLUSION_POLL_MS = 60_000;
const INCLUSION_PER_TICK = 5;
const DEFAULT_SURFACE = Object.freeze({ mode: "web", deep: false, newChat: true, city: null });

const BUSY_CODES = new Set(["geo_probe_busy", "geo_probe_rate_limited"]);
const CONFIG_CODES = new Set(["geo_probe_unconfigured", "geo_probe_endpoint_invalid", "geo_probe_plaintext_forbidden"]);

// ───────────────────────── time in the module's zone ─────────────────────────

/** @param {Record<string, any>} config */
const zoneOf = (config) => String(config?.geoTimeZone || "Asia/Shanghai");

/** @param {Date} at @param {string} timeZone */
function zonedParts(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "short",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour),
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(parts.weekday)),
    offset: wall - Math.floor(at.getTime() / 1_000) * 1_000,
  };
}

/** The calendar day in the zone, `YYYY-MM-DD`. @param {Date} at @param {string} timeZone */
export function zonedDay(at, timeZone) {
  const { year, month, day } = zonedParts(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Midnight of the zone's day, as an instant. @param {Date} at @param {string} timeZone */
export function zonedDayStart(at, timeZone) {
  const { year, month, day, offset } = zonedParts(at, timeZone);
  return new Date(Date.UTC(year, month - 1, day) - offset);
}

/** Monday 00:00 of the zone's week, as an instant. @param {Date} at @param {string} timeZone */
export function zonedWeekStart(at, timeZone) {
  const start = zonedDayStart(at, timeZone);
  const { weekday } = zonedParts(at, timeZone);
  return zonedDayStart(new Date(start.getTime() - weekday * 86_400_000 + 12 * 3_600_000), timeZone);
}

/**
 * The night window `HH-HH` (start inclusive, end exclusive, may wrap past
 * midnight); a malformed value falls back to 22-07, equal ends mean always.
 * @param {unknown} value
 */
export function parseNightWindow(value) {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/u.exec(String(value ?? ""));
  const start = match ? Number(match[1]) : 22;
  const end = match ? Number(match[2]) : 7;
  if (!match || start > 24 || end > 24) return { start: 22, end: 7 };
  return { start: start % 24, end: end % 24 };
}

/** Whether `at` is inside the configured night window. @param {Date} at @param {Record<string, any>} config */
export function nightWindowOpen(at, config) {
  const { start, end } = parseNightWindow(config?.geoNightWindow ?? "22-07");
  if (start === end) return true;
  const { hour } = zonedParts(at, zoneOf(config));
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ───────────────────────── the breaker and the worker's state ─────────────────────────

export class GeoProbeBreaker {
  /** @param {{ threshold?: number, recheckMs?: number, skipAfterMs?: number }} [options] */
  constructor({ threshold = GEO_PROBE_BREAK_AFTER, recheckMs = GEO_PROBE_RECHECK_MS, skipAfterMs = GEO_PROBE_SKIP_AFTER_MS } = {}) {
    this.threshold = threshold;
    this.recheckMs = recheckMs;
    this.skipAfterMs = skipAfterMs;
    /** @type {Map<string, { consecutive: number, pausedAt: number | null, lastCheckAt: number | null, failedCheckAt: number | null }>} */
    this.engines = new Map();
  }

  /** @param {string} engine */
  #entry(engine) {
    let entry = this.engines.get(engine);
    if (!entry) this.engines.set(engine, entry = { consecutive: 0, pausedAt: null, lastCheckAt: null, failedCheckAt: null });
    return entry;
  }

  /**
   * Seed from the newest stored statuses per engine (newest first): an engine
   * whose latest answers were all suspect or failed starts paused, and is
   * re-checked at once.
   * @param {Record<string, string[]>} byEngine @param {number} now
   */
  seed(byEngine, now) {
    for (const [engine, statuses] of Object.entries(byEngine)) {
      let consecutive = 0;
      for (const status of statuses) {
        if (status !== "suspect" && status !== "failed") break;
        consecutive += 1;
      }
      const entry = this.#entry(engine);
      entry.consecutive = consecutive;
      if (consecutive >= this.threshold) {
        entry.pausedAt = now;
        entry.failedCheckAt = null;
      }
    }
  }

  /**
   * One answer's status. Returns true when this answer paused the engine.
   * @param {string} engine @param {string} status @param {number} now
   */
  record(engine, status, now) {
    const entry = this.#entry(engine);
    if (status === "valid" || status === "refusal") {
      entry.consecutive = 0;
      return false;
    }
    entry.consecutive += 1;
    if (entry.pausedAt === null && entry.consecutive >= this.threshold) {
      entry.pausedAt = now;
      entry.lastCheckAt = now;
      entry.failedCheckAt = null;
      return true;
    }
    return false;
  }

  /** @returns {string[]} */
  paused() {
    return [...this.engines].filter(([, entry]) => entry.pausedAt !== null).map(([engine]) => engine).sort();
  }

  /** Paused engines due for a providers re-check. @param {number} now */
  due(now) {
    return this.paused().filter((engine) => {
      const entry = /** @type {{ lastCheckAt: number | null }} */ (this.engines.get(engine));
      return entry.lastCheckAt === null || now - entry.lastCheckAt >= this.recheckMs;
    });
  }

  /**
   * Paused engines whose remaining jobs a round may skip: a re-check since
   * the pause found the tab still gone, or the pause is older than
   * `skipAfterMs`. A freshly paused engine holds its round open.
   * @param {number} now
   */
  skippable(now) {
    return this.paused().filter((engine) => {
      const entry = /** @type {{ pausedAt: number, failedCheckAt: number | null }} */ (this.engines.get(engine));
      return (entry.failedCheckAt !== null && entry.failedCheckAt >= entry.pausedAt) || now - entry.pausedAt >= this.skipAfterMs;
    });
  }

  /** A re-check's result; true when the engine resumed. @param {string} engine @param {number} now @param {boolean} ready */
  checked(engine, now, ready) {
    const entry = this.#entry(engine);
    entry.lastCheckAt = now;
    if (!ready) {
      entry.failedCheckAt = now;
      return false;
    }
    entry.consecutive = 0;
    entry.pausedAt = null;
    entry.failedCheckAt = null;
    return true;
  }
}

/**
 * @typedef {object} GeoMeasureState
 * @property {GeoProbeBreaker} breaker
 * @property {{ until: number, backoffMs: number, consecutive: number }} busy
 * @property {number} hostPausedUntil
 * @property {number} hostFailures
 * @property {boolean} seeded
 * @property {Map<string, number>} retriable   job id → vendor-busy answers in a row
 * @property {Map<string, number>} judgeAttempts   snapshot id → the answer's own judge failures
 * @property {Map<string, { count: number, firstTick: number }>} judgeStops   snapshot id → provider-side failures it met, and the parse tick of the first
 * @property {number} parseTicks     parse ticks run by this worker
 * @property {number} lastJudgedTick the parse tick of the latest successful judgement
 * @property {any} judge
 * @property {any} upstream
 * @property {Set<string>} alerted
 * @property {string} owner
 */

const states = new WeakMap();

/**
 * The worker's in-memory measurement state: the breaker, the busy backoff,
 * the judge's attempt counts, the alerts already sent. Kept per store object,
 * so one worker's ticks share it; `deps.state` overrides.
 * @param {object} [key] @returns {GeoMeasureState}
 */
export function geoMeasureState(key) {
  const existing = key ? states.get(key) : undefined;
  if (existing) return existing;
  /** @type {GeoMeasureState} */
  const state = {
    breaker: new GeoProbeBreaker(),
    busy: { until: 0, backoffMs: 0, consecutive: 0 },
    hostPausedUntil: 0,
    hostFailures: 0,
    seeded: false,
    retriable: new Map(),
    judgeAttempts: new Map(),
    judgeStops: new Map(),
    parseTicks: 0,
    lastJudgedTick: -1,
    judge: null,
    upstream: null,
    alerted: new Set(),
    owner: `geo-probe-${process.pid}-${randomId().slice(0, 8)}`,
  };
  if (key) states.set(key, state);
  return state;
}

/**
 * @param {{ alertOperator?: (event: Record<string, any>) => unknown }} deps @param {GeoMeasureState} state
 * @param {Record<string, any> & { idempotencyKey: string }} event
 */
async function alert(deps, state, event) {
  if (state.alerted.has(event.idempotencyKey)) return;
  state.alerted.add(event.idempotencyKey);
  if (state.alerted.size > 5_000) state.alerted.clear();
  try {
    await deps.alertOperator?.(event);
  } catch {
    state.alerted.delete(event.idempotencyKey);
  }
}

/** @param {string} engine */
const engineLabel = (engine) => /** @type {Record<string, { display_name: string }>} */ (GEO_METRICS.engines)[engine]?.display_name ?? engine;

// ───────────────────────── rounds ─────────────────────────

/**
 * @typedef {object} GeoMeasureDeps
 * @property {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @property {Record<string, any>} config
 * @property {() => Date} [now]
 * @property {GeoMeasureState} [state]
 * @property {ReturnType<typeof probeUpstream>} [upstream]   the probe client (default `probeUpstream(config)`)
 * @property {typeof fetch} [fetchImpl]
 * @property {{ engines: () => string[], submit: Function, poll: Function } | null} [inclusion]   package C's GeoInclusionClient
 * @property {(event: Record<string, any>) => unknown} [alertOperator]
 * @property {(round: { id: string, status: string }) => unknown} [onRoundFinished]
 * @property {number} [maxAsks]
 */

/**
 * The engines a round can actually be asked on in this deployment.
 * @param {Pick<GeoMeasureDeps, "inclusion">} deps
 */
export function measurableEngines(deps) {
  const inclusion = deps.inclusion?.engines?.() ?? [];
  return [...GEO_PROBE_ENGINES, ...inclusion.filter((engine) => GEO_MEASURE_ENGINES.includes(engine) && !GEO_PROBE_ENGINES.includes(engine))];
}

/**
 * Queue a round: its jobs, question-major (every engine and repeat of the
 * first question before the second), so a round cut short still covers every
 * engine alike.
 *
 * Defaults by kind: the measured questions of the current locked set; a noise
 * round asks the `PROBE_NOISE_QUESTION_COUNT` highest-weight of them
 * `PROBE_NOISE_SAMPLE_N` times each; a sentinel round the
 * `MI_SENTINEL_QUESTION_COUNT` highest-weight; a confirmation round needs its
 * question and engine and asks `EC_CONFIRM_REPEATS` times. Engines default to
 * the project's; an engine this deployment cannot ask is kept on the round
 * (so the metrics say 「未测」) but gets no jobs.
 *
 * @param {Pick<GeoMeasureDeps, "store" | "now" | "inclusion">} deps
 * @param {{ geoProjectId: string, kind: string, questionIds?: string[] | null, engines?: string[] | null, repeat?: number | null,
 *   ref?: Record<string, unknown> | null }} request
 * @returns {Promise<{ roundId: string, planned: number, engines: string[], absentEngines: string[], setVersion: number | null }>}
 */
export async function enqueueRound(deps, { geoProjectId, kind, questionIds = null, engines = null, repeat = null, ref = null }) {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!GEO_ROUND_KINDS.includes(kind)) throw new HttpError(400, "geo_round_kind_invalid", "Unknown round kind.");
  const project = await store.project(geoProjectId);
  if (!project) throw new HttpError(404, "geo_project_not_found", "GEO project not found.");

  const requested = [...new Set((engines ?? project.engines).map((engine) => String(engine)))];
  if (!requested.length || requested.some((engine) => !GEO_MEASURE_ENGINES.includes(engine))) {
    throw new HttpError(400, "geo_round_engine_invalid", `Round engines must be drawn from: ${GEO_MEASURE_ENGINES.join(", ")}.`);
  }
  const channels = measurableEngines(deps);
  const jobEngines = requested.filter((engine) => channels.includes(engine));

  const { setVersion, questions: measured } = await store.measuredQuestions(geoProjectId);
  let questions;
  if (questionIds?.length) {
    const wanted = [...new Set(questionIds.map(String))];
    const found = await store.questions(geoProjectId, { ids: wanted });
    if (found.length !== wanted.length || found.some((question) => question.retired)) {
      throw new HttpError(400, "geo_round_question_invalid", "A round question is not a live question of this project.");
    }
    const order = new Map(wanted.map((id, index) => [id, index]));
    questions = found.sort((left, right) => /** @type {number} */ (order.get(left.id)) - /** @type {number} */ (order.get(right.id)));
  } else if (kind === "confirm") {
    throw new HttpError(400, "geo_round_question_invalid", "A confirmation round names its question.");
  } else if (kind === "noise") {
    questions = measured.slice(0, catalogue("PROBE_NOISE_QUESTION_COUNT", 10));
  } else if (kind === "sentinel") {
    questions = measured.slice(0, catalogue("MI_SENTINEL_QUESTION_COUNT", 10));
  } else {
    questions = measured;
  }
  const defaultRepeat = kind === "noise" ? catalogue("PROBE_NOISE_SAMPLE_N", 5) : kind === "confirm" ? catalogue("EC_CONFIRM_REPEATS", 10) : 1;
  const repeats = repeat == null ? defaultRepeat : Number(repeat);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new HttpError(400, "geo_round_repeat_invalid", "A round repeats each ask 1 to 20 times.");

  /** @type {Array<{ questionId: string, engine: string, repeatIndex: number }>} */
  const jobs = [];
  for (const question of questions) {
    for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
      for (const engine of jobEngines) jobs.push({ questionId: question.id, engine, repeatIndex });
    }
  }
  if (!jobs.length) throw new HttpError(409, "geo_round_empty", "Nothing to ask: no measured question or no engine this deployment can ask.");
  if (jobs.length > GEO_ROUND_MAX_ASKS) throw new HttpError(400, "geo_round_too_large", `A round plans at most ${GEO_ROUND_MAX_ASKS} asks.`);

  const roundId = randomId("gr_");
  await store.createRound({
    id: roundId, userId: project.userId, geoProjectId, kind,
    setVersion: questionIds?.length ? (questions[0]?.setVersion ?? setVersion) : setVersion,
    engines: requested, surface: { ...DEFAULT_SURFACE }, planned: jobs.length, ref: ref ?? null, now,
  }, jobs);
  return { roundId, planned: jobs.length, engines: jobEngines, absentEngines: requested.filter((engine) => !jobEngines.includes(engine)),
    setVersion: questionIds?.length ? (questions[0]?.setVersion ?? setVersion) : setVersion };
}

// ───────────────────────── the probe tick ─────────────────────────

/**
 * @typedef {object} GeoProbeCounts
 * @property {number} asked
 * @property {number} valid
 * @property {number} refusal
 * @property {number} suspect
 * @property {number} failed
 * @property {number} busy
 * @property {number} retried
 * @property {number} screenshotsStored
 * @property {string[]} paused     engines paused after this tick
 * @property {string[]} tripped    engines this tick paused
 * @property {string[]} resumed
 * @property {{ night: number, cap: number }} held
 * @property {number} roundsFinished
 * @property {{ submitted: number, polled: number, done: number, failed: number }} inclusion
 * @property {string | null} probe  why the probe asked nothing: locked, unconfigured, busy_backoff, host_paused, misconfigured
 */

/**
 * One pass of the queue: the inclusion channel, then (under the probe lock)
 * up to `maxAsks` asks, then close every round that has nothing left to ask.
 * @param {GeoMeasureDeps} deps
 * @returns {Promise<GeoProbeCounts>}
 */
export async function tickProbe(deps) {
  const { store, config } = deps;
  const state = deps.state ?? geoMeasureState(store);
  await store.ready();
  /** @type {GeoProbeCounts} */
  const counts = {
    asked: 0, valid: 0, refusal: 0, suspect: 0, failed: 0, busy: 0, retried: 0, screenshotsStored: 0,
    paused: [], tripped: [], resumed: [], held: { night: 0, cap: 0 }, roundsFinished: 0,
    inclusion: { submitted: 0, polled: 0, done: 0, failed: 0 }, probe: null,
  };
  const inclusionEngines = measurableEngines(deps).filter((engine) => !GEO_PROBE_ENGINES.includes(engine));
  if (deps.inclusion && inclusionEngines.length) await inclusionPass(deps, state, inclusionEngines, counts);

  const configured = Boolean(String(config.geoProbeUrl ?? "").trim());
  if (!configured) {
    counts.probe = "unconfigured";
  } else {
    const upstream = deps.upstream ?? (state.upstream ??= probeUpstream(config, { fetchImpl: deps.fetchImpl }));
    const lock = await store.withProbeLock(() => probePass(deps, state, upstream, counts));
    if (!lock.acquired) counts.probe = "locked";
  }
  counts.paused = state.breaker.paused();
  await closeRounds(deps, state, inclusionEngines, counts);
  return counts;
}

/**
 * @param {GeoMeasureDeps} deps @param {GeoMeasureState} state @param {ReturnType<typeof probeUpstream>} upstream @param {GeoProbeCounts} counts
 */
async function probePass(deps, state, upstream, counts) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const start = now();
  await store.recoverExpiredLeases(start);
  if (!state.seeded) {
    state.breaker.seed(await store.recentProbeStatuses([...GEO_PROBE_ENGINES], state.breaker.threshold), start.getTime());
    state.seeded = true;
  }
  if (state.hostPausedUntil > start.getTime()) {
    counts.probe = "host_paused";
    return;
  }
  if (state.busy.until > start.getTime()) {
    counts.probe = "busy_backoff";
    return;
  }
  // The queue's own ceiling, not the runtime tool's: an overnight ask may take the probe host's full five minutes.
  const timeoutMs = Math.max(1_000, Number(config.geoQueueProbeTimeoutMs) || GEO_QUEUE_PROBE_TIMEOUT_MS);

  // Paused engines whose tab may be back.
  const due = state.breaker.due(start.getTime());
  if (due.length) {
    let ready = /** @type {string[]} */ ([]);
    try {
      ready = (await upstream.providers({ signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)) })).ready;
    } catch { /* still paused; checked again in ten minutes */ }
    for (const engine of due) {
      // The providers list says only that a tab exists. A tab can exist and be
      // stuck (production, 2026-09-25: 豆包's tab answered every ask with
      // 「45000ms 内未出现用户气泡」 while /providers kept saying tab_found), so an
      // engine resumes only when one short test ask actually comes back.
      const healthy = ready.includes(engine) && await engineAnswers(upstream, engine, Math.min(timeoutMs, 120_000));
      if (state.breaker.checked(engine, start.getTime(), healthy)) counts.resumed.push(engine);
    }
  }

  const maxAsks = Math.max(1, Number(deps.maxAsks ?? 1));
  for (let index = 0; index < maxAsks; index += 1) {
    const at = now();
    const window = {
      now: at,
      engines: [...GEO_PROBE_ENGINES],
      nightOpen: nightWindowOpen(at, config),
      nightMinAsks: GEO_NIGHT_MIN_ASKS,
      weekStart: zonedWeekStart(at, zoneOf(config)),
      weeklyCap: Math.max(0, Number(config.geoWeeklyAskCap ?? 1_500) || 0),
    };
    const job = await store.leaseNextJob({
      ...window, owner: state.owner, leaseUntil: new Date(at.getTime() + timeoutMs + SCREENSHOT_TIMEOUT_MS + LEASE_MARGIN_MS), paused: state.breaker.paused(),
    });
    if (!job) {
      counts.held = await store.heldJobs(window);
      return;
    }
    await store.startRound(job.roundId, at, zonedDay(at, zoneOf(config)));
    const next = await askJob(deps, state, upstream, job, counts, timeoutMs);
    if (next === "stop") return;
  }
}

/**
 * Whether an engine answers at all: one short question on a new chat, and a
 * valid answer back. Busy, failed, suspect or thrown all read as "not yet".
 * @param {{ ask: (request: Record<string, any>) => Promise<{ results: any[] }> }} upstream @param {string} engine @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function engineAnswers(upstream, engine, timeoutMs) {
  try {
    const asked = await upstream.ask({ question: "请用一句话介绍一下你自己。", providers: [engine], deep: 0, newChat: 1, signal: AbortSignal.timeout(timeoutMs) });
    const row = asked?.results?.[0];
    // A short self-introduction is an answer; an empty shell, a login or
    // captcha page, a capacity notice or bare page chrome is not.
    const verdict = classifyProbeAnswer({ rawStatus: row?.status, answer: String(row?.answer ?? "") });
    return verdict.status === "valid" || verdict.status === "refusal" || verdict.reason === "too_short";
  } catch {
    return false;
  }
}

/**
 * Ask one leased job and record what came back.
 * @param {GeoMeasureDeps} deps @param {GeoMeasureState} state @param {ReturnType<typeof probeUpstream>} upstream
 * @param {ReturnType<typeof import("./geoMeasureStore.mjs").jobRow>} job @param {GeoProbeCounts} counts @param {number} timeoutMs
 * @returns {Promise<"next" | "stop">}
 */
async function askJob(deps, state, upstream, job, counts, timeoutMs) {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  const [question] = await store.questions(job.geoProjectId, { ids: [job.questionId] });
  if (!question) {
    await store.finishJob(job.id, { now: now(), status: "skipped", errorCode: "question_missing" });
    return "next";
  }
  const askedAt = now();
  /** @type {Awaited<ReturnType<ReturnType<typeof probeUpstream>["ask"]>>} */
  let answer;
  try {
    answer = await upstream.ask({ question: question.text, providers: [job.engine], deep: 0, newChat: 1, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? "geo_probe_failed");
    if (BUSY_CODES.has(code)) {
      await busy(deps, state, job, counts);
      return "stop";
    }
    if (CONFIG_CODES.has(code)) {
      await store.requeueJob(job.id, { now: now(), refundAttempt: true });
      counts.probe = "misconfigured";
      await alert(deps, state, { kind: "geo_probe_misconfigured", code, message: "The GEO probe endpoint is not usable; measurement is waiting.",
        idempotencyKey: `geo:probe_misconfigured:${code}` });
      return "stop";
    }
    // The host did not answer: not a measurement. Kept for the trail, asked again.
    const snapshotId = randomId("gs_");
    await store.insertSnapshot({
      id: snapshotId, userId: job.userId, roundId: job.roundId, geoProjectId: job.geoProjectId, questionId: job.questionId, engine: job.engine,
      askedAt, status: "failed", answerText: null, answerSha256: null, citations: [], screenshotSha256: null,
      surface: { ...DEFAULT_SURFACE }, latencyMs: now().getTime() - askedAt.getTime(), warnings: [`probe_error:${code}`], probeJobId: job.id,
    });
    counts.asked += 1;
    counts.failed += 1;
    await retryOrFail(deps, job, "failed", snapshotId, counts);
    state.hostFailures += 1;
    if (state.hostFailures >= GEO_PROBE_BREAK_AFTER) {
      state.hostPausedUntil = now().getTime() + GEO_PROBE_RECHECK_MS;
      state.hostFailures = 0;
      await alert(deps, state, { kind: "geo_probe_host_down", code, message: "The GEO probe host did not answer several times in a row; measurement pauses for ten minutes.",
        idempotencyKey: `geo:probe_host_down:${zonedDay(now(), zoneOf(config))}:${now().getUTCHours()}` });
      return "stop";
    }
    return "next";
  }
  state.hostFailures = 0;
  state.busy = { until: 0, backoffMs: 0, consecutive: 0 };

  // A reply without a result row is a probe that said nothing: not a measurement.
  const row = answer.results[0] ?? { status: "failed", answer: "", answerTruncated: false, answerDigest: null, screenshotName: null, latencyMs: null,
    error: "the probe returned no result" };
  const raw = /** @type {Record<string, any>} */ (answer.raw[0] ?? {});
  const rawStatus = String(raw.status ?? "").trim().toLowerCase();
  if (isRetriableRawStatus(rawStatus)) {
    // The vendor, not the probe host, is busy: this job waits, the others go on.
    const bounces = (state.retriable.get(job.id) ?? 0) + 1;
    state.retriable.set(job.id, bounces);
    if (bounces <= BUSY_MAX) {
      await store.requeueJob(job.id, { now: now(), refundAttempt: true, runAfter: new Date(now().getTime() + backoffMs(bounces)) });
      counts.busy += 1;
      return "next";
    }
    state.retriable.delete(job.id);
  }
  const verdict = classifyProbeAnswer({ rawStatus: row.status === "ok" ? "ok" : (rawStatus || "failed"), answer: row.answer });

  /** @type {string[]} */
  const warnings = [];
  if (verdict.reason) warnings.push(`sanity:${verdict.reason}${verdict.marker ? `:${verdict.marker}` : ""}`);
  if (row.answerTruncated) warnings.push("answer_truncated");
  if (row.error) warnings.push(`probe_error:${String(row.error).slice(0, 200)}`);
  if (answer.integrity.transport === "plaintext" && !answer.integrity.signed) warnings.push("plaintext_unsigned");
  let screenshotSha256 = null;
  if (row.screenshotName) {
    try {
      const shot = await upstream.screenshot({ name: row.screenshotName, signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS) });
      const stored = await storeGeoScreenshot(String(config.dataDir ?? ""), shot.bytes);
      screenshotSha256 = stored.sha256;
      if (stored.stored) counts.screenshotsStored += 1;
    } catch (error) {
      warnings.push(`screenshot_unavailable:${String(/** @type {any} */ (error)?.code ?? "error")}`);
    }
  }
  const snapshotId = randomId("gs_");
  await store.insertSnapshot({
    id: snapshotId, userId: job.userId, roundId: job.roundId, geoProjectId: job.geoProjectId, questionId: job.questionId, engine: job.engine,
    askedAt, status: verdict.status, answerText: row.answer || null, answerSha256: row.answerDigest,
    citations: citationRows(raw.search_results, row.answer, job.engine), screenshotSha256,
    surface: { ...DEFAULT_SURFACE, transport: answer.integrity.transport, signed: answer.integrity.signed, responseDigest: answer.integrity.responseDigest },
    latencyMs: row.latencyMs ?? now().getTime() - askedAt.getTime(), warnings, probeJobId: job.id,
  });
  counts.asked += 1;
  counts[/** @type {"valid" | "refusal" | "suspect" | "failed"} */ (verdict.status)] += 1;
  state.retriable.delete(job.id);

  if (state.breaker.record(job.engine, verdict.status, now().getTime())) {
    counts.tripped.push(job.engine);
    await alert(deps, state, {
      kind: "geo_probe_engine_paused", engine: job.engine,
      message: `${engineLabel(job.engine)} answered ${state.breaker.threshold} times in a row with a login page, an empty shell or an error; it is paused and re-checked every ten minutes.`,
      idempotencyKey: `geo:probe_engine_paused:${job.engine}:${now().toISOString().slice(0, 13)}`,
    });
  }
  if (verdict.status === "valid" || verdict.status === "refusal") {
    await store.finishJob(job.id, { now: now(), status: "done", snapshotId });
    return "next";
  }
  if (verdict.status === "suspect") {
    await alert(deps, state, {
      kind: "geo_probe_suspect", engine: job.engine, geoProjectId: job.geoProjectId, snapshotId, reason: verdict.reason,
      message: `${engineLabel(job.engine)} returned something that is not an answer (${verdict.reason}); it is out of the denominator and will be asked again.`,
      idempotencyKey: `geo:probe_suspect:${job.engine}:${now().toISOString().slice(0, 13)}`,
    });
  }
  await retryOrFail(deps, job, verdict.status, snapshotId, counts);
  return "next";
}

/** @param {number} attempt */
function backoffMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * The probe host is busy: the job goes back without using an attempt (until
 * the probe has been busy too long), and the queue backs off.
 * @param {GeoMeasureDeps} deps @param {GeoMeasureState} state @param {{ id: string, attempts: number }} job @param {GeoProbeCounts} counts
 */
async function busy(deps, state, job, counts) {
  const now = (deps.now ?? (() => new Date()))();
  state.busy.consecutive += 1;
  state.busy.backoffMs = backoffMs(state.busy.consecutive);
  state.busy.until = now.getTime() + state.busy.backoffMs;
  const refund = state.busy.consecutive <= BUSY_MAX;
  if (!refund && job.attempts >= GEO_JOB_MAX_ATTEMPTS) {
    // Busy past the limit with its asks used up: failed, not bounced forever.
    await deps.store.finishJob(job.id, { now, status: "failed", errorCode: "probe_busy" });
  } else {
    await deps.store.requeueJob(job.id, { now, refundAttempt: refund, errorCode: refund ? null : "probe_busy" });
  }
  counts.busy += 1;
  counts.probe = "busy_backoff";
  if (!refund) {
    await alert(deps, state, { kind: "geo_probe_busy", message: "The GEO probe has been busy for every ask in a row; jobs now spend attempts while it stays busy.",
      idempotencyKey: `geo:probe_busy:${now.toISOString().slice(0, 13)}` });
  }
}

/**
 * A suspect or failed ask: asked again later while attempts remain, else the
 * job fails (its snapshot stays, out of every denominator).
 * @param {GeoMeasureDeps} deps @param {{ id: string, attempts: number }} job @param {string} status @param {string} snapshotId @param {GeoProbeCounts} counts
 */
async function retryOrFail(deps, job, status, snapshotId, counts) {
  const now = (deps.now ?? (() => new Date()))();
  if (job.attempts < GEO_JOB_MAX_ATTEMPTS) {
    await deps.store.requeueJob(job.id, { now, runAfter: new Date(now.getTime() + RETRY_DELAY_MS * job.attempts), errorCode: status });
    counts.retried += 1;
    return;
  }
  await deps.store.finishJob(job.id, { now, status: "failed", snapshotId, errorCode: status });
}

// ───────────────────────── the inclusion channel ─────────────────────────

/**
 * Poll the tasks already submitted, then submit the next few.
 * @param {GeoMeasureDeps} deps @param {GeoMeasureState} state @param {string[]} engines @param {GeoProbeCounts} counts
 */
async function inclusionPass(deps, state, engines, counts) {
  const { store, config } = deps;
  const inclusion = /** @type {NonNullable<GeoMeasureDeps["inclusion"]>} */ (deps.inclusion);
  const now = deps.now ?? (() => new Date());
  const start = now();
  await store.recoverExpiredLeases(start);

  for (const job of await store.inclusionJobsToPoll({ now: start, engines, limit: 20 })) {
    const at = now();
    /** @type {any} */
    let result;
    try {
      result = await inclusion.poll(job.engine, job.externalRef);
      counts.inclusion.polled += 1;
    } catch {
      await store.holdInclusionJob(job.id, /** @type {string} */ (job.externalRef), {
        now: at, leaseUntil: new Date(at.getTime() + INCLUSION_HOLD_MS), runAfter: new Date(at.getTime() + 5 * INCLUSION_POLL_MS),
      });
      continue;
    }
    if (result.status === "pending") {
      await store.holdInclusionJob(job.id, /** @type {string} */ (job.externalRef), {
        now: at, leaseUntil: new Date(at.getTime() + INCLUSION_HOLD_MS), runAfter: new Date(at.getTime() + INCLUSION_POLL_MS),
      });
      continue;
    }
    const project = await store.project(job.geoProjectId);
    const snapshotId = randomId("gs_");
    const valid = result.status === "valid" && typeof result.hit === "boolean";
    await store.insertSnapshot({
      id: snapshotId, userId: job.userId, roundId: job.roundId, geoProjectId: job.geoProjectId, questionId: job.questionId, engine: job.engine,
      askedAt: at, status: valid ? "valid" : "failed", answerText: null, answerSha256: null, citations: [], screenshotSha256: null,
      surface: { mode: "inclusion", requestId: result.requestId ?? job.externalRef, hit: result.hit ?? null, keywordRes: String(result.keywordRes ?? "").slice(0, 300),
        shareUrl: result.shareUrl ?? null, screenshotUrl: result.screenshotUrl ?? null, checkedAt: result.checkedAt ?? null },
      latencyMs: null, warnings: valid ? [] : ["inclusion_failed"], probeJobId: job.id,
    });
    if (valid) {
      const name = String(project?.product?.brandName ?? "").trim() || "本品";
      await store.writeFacts({ id: snapshotId, userId: job.userId, geoProjectId: job.geoProjectId }, {
        // The channel says only whether the brand words were found.
        brands: result.hit ? [{ name, ours: true, competitor: false, position: null, inRecommendation: false, count: 1 }] : [],
        mentionsOurs: result.hit, brandsMentioned: result.hit ? 1 : 0, parserVersion: "inclusion-1", judgedAt: null,
        failureMode: result.hit ? null : "omitted",
      });
      await store.finishJob(job.id, { now: at, status: "done", snapshotId });
      counts.inclusion.done += 1;
      continue;
    }
    counts.inclusion.failed += 1;
    await retryOrFail(deps, job, "failed", snapshotId, counts);
  }

  for (let index = 0; index < INCLUSION_PER_TICK; index += 1) {
    const at = now();
    const job = await store.leaseNextJob({
      now: at, owner: state.owner, leaseUntil: new Date(at.getTime() + INCLUSION_HOLD_MS), engines, paused: [],
      // The vendor's check does not use the probe host: no night window.
      nightOpen: true, nightMinAsks: GEO_NIGHT_MIN_ASKS, weekStart: zonedWeekStart(at, zoneOf(config)),
      weeklyCap: Math.max(0, Number(config.geoWeeklyAskCap ?? 1_500) || 0),
    });
    if (!job) break;
    await store.startRound(job.roundId, at, zonedDay(at, zoneOf(config)));
    const [question] = await store.questions(job.geoProjectId, { ids: [job.questionId] });
    const project = await store.project(job.geoProjectId);
    if (!question || !project) {
      await store.finishJob(job.id, { now: at, status: "skipped", errorCode: "question_missing" });
      continue;
    }
    const product = project.product ?? {};
    const keywords = [product.brandName, ...(Array.isArray(product.aliases) ? product.aliases : [])]
      .map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 5);
    try {
      const { requestId } = await inclusion.submit({ engine: job.engine, keywords, question: question.text, thirdId: job.id });
      await store.holdInclusionJob(job.id, requestId, { now: at, leaseUntil: new Date(at.getTime() + INCLUSION_HOLD_MS), runAfter: new Date(at.getTime() + INCLUSION_POLL_MS) });
      counts.inclusion.submitted += 1;
    } catch (error) {
      const code = String(/** @type {any} */ (error)?.code ?? "inclusion_failed");
      if (job.attempts < GEO_JOB_MAX_ATTEMPTS) {
        await store.requeueJob(job.id, { now: at, runAfter: new Date(at.getTime() + RETRY_DELAY_MS * job.attempts), errorCode: code });
      } else {
        await store.finishJob(job.id, { now: at, status: "failed", errorCode: code });
      }
      counts.inclusion.failed += 1;
      break;
    }
  }
}

// ───────────────────────── closing rounds ─────────────────────────

/**
 * Close every open round with nothing left to ask. A round whose only
 * remaining jobs are on paused engines, or on engines this deployment can no
 * longer reach, skips those and closes: those engines are absent from it.
 * @param {GeoMeasureDeps} deps @param {GeoMeasureState} state @param {string[]} inclusionEngines @param {GeoProbeCounts} counts
 */
async function closeRounds(deps, state, inclusionEngines, counts) {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // An unconfigured probe is a wait, not an absence: its engines keep a channel.
  const channels = [...GEO_PROBE_ENGINES, ...inclusionEngines];
  // Only an engine confirmed down (a failed re-check since its pause, or a
  // long pause) lets a round close without it; a fresh pause holds the round.
  const paused = state.breaker.skippable(now.getTime());
  const open = await store.openRoundProgress({ paused, channels });
  if (counts.probe === "unconfigured" && open.some((round) => round.open > round.unchanneled)) {
    await alert(deps, state, { kind: "geo_probe_unconfigured", message: "GEO rounds are waiting for the probe host, which this deployment has not configured.",
      idempotencyKey: `geo:probe_unconfigured:${zonedDay(now, zoneOf(deps.config))}` });
  }
  for (const round of open) {
    if (round.open > 0 && (round.leased > 0 || round.open !== round.paused + round.unchanneled)) continue;
    const finished = await store.finishRound(round.id, {
      now,
      skip: [
        { engines: paused, code: "engine_paused" },
        { engines: GEO_MEASURE_ENGINES.filter((engine) => !channels.includes(engine)), code: "engine_unavailable" },
      ],
    });
    if (!finished) continue;
    counts.roundsFinished += 1;
    try {
      await deps.onRoundFinished?.({ id: round.id, status: finished.status });
    } catch { /* the round is closed either way; the hook's owner logs its own failure */ }
  }
}
