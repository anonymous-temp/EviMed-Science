/**
 * From a finished round's facts to the numbers the pages read (build spec §5
 * "Metrics", plan §4.4): `evimed_geo.metrics` rows for every scope — project,
 * pool, engine, pool × engine, group, arm — computed by the domain's
 * `computeGeoMetrics` (package M, golden-equal to the owner's
 * `compute_metrics.py`), the noise band, and the net effect.
 *
 * Hidden knowledge:
 *
 * - **No formula lives here.** Every number comes from `@evimed/domain`'s GEO
 *   metrics (the owner's `metrics.yaml` as `geo/metrics.json`); this job only
 *   chooses the rows and writes the cells, each with numerator, denominator,
 *   Wilson interval, status, reason and data type exactly as computed.
 * - **A round is measured once all its answers are read.** Until every valid
 *   answer has its facts, the round waits (a spent judge budget waits too);
 *   an answer the judge gave up on is passed without facts and counted as
 *   unparsed — never as an answer that said nothing. New facts after a
 *   computation (a late judgement) recompute the round.
 * - **A paused engine is absent from its round.** The queue skips a paused
 *   engine's remaining jobs to close a round; every answer that engine gave in
 *   the round is then left out, so it reads 「未测」 everywhere rather than
 *   half-measured — its partial answers would make the questions' valid
 *   counts uneven and withdraw every pool rate of the round.
 * - **Three row families besides the cells**, with ids this platform gives
 *   what the owner's yaml names without numbering (A's `GEO_METRIC_IDS`):
 *   `NOISE` (scope project, `variant` = the metric it is the band of: M-01,
 *   M-03, M-10; value = 2 × SD across the noise round's repeats),
 *   `NET` (the net effect: scope project with `variant` M-19 for the index,
 *   scope pool with `variant` = the pool's metric per
 *   `net_effect.metrics_by_pool`; `numerator` = the pilot's change,
 *   `denominator` = the control's change, `reason` = the verdict up / down /
 *   flat, or why it is not computable), and the index itself, which stays the
 *   owner's `M-19`. All three are `derived`.
 * - **Arms exclude contaminated controls**: a control group any article has
 *   touched leaves the control arm (net_effect.control_exclusion), and the
 *   net effect is not computable with fewer than the table's minimum of
 *   clean controls, or before a round after the baseline.
 * - **A net effect compares the same groups** (Q-3). A group leaves the
 *   control arm on the day it is touched, so the baseline's control arm is
 *   wider than today's; subtracting arms over different groups makes a change
 *   no group had. Each round records the groups its two arms were
 *   (`rounds.ref.balance.arms`), and the net effect is computed over the groups
 *   every compared round had: a round whose arm was wider has its arm cells
 *   computed again, from its own answers, over those groups. The cells a round
 *   stored are the record of its own measurement and stay as they were.
 * - After a diagnostic round (baseline, weekly, single step) the sources
 *   table gets this round's citation counts per engine and pool.
 *
 * @module geoMetricsJob
 */

import { GEO_METRICS, computeGeoMetrics, netEffect, noiseBand } from "@evimed/domain";

/** Round kinds whose metrics are computed. Confirmation rounds feed the errors only. */
export const GEO_METRIC_ROUND_KINDS = Object.freeze(["baseline", "weekly", "sentinel", "post_publication", "single_step", "noise"]);
/** The ids of the computed rows the yaml does not number (package A's `GEO_METRIC_IDS`). */
export const GEO_NET_METRIC_ID = "NET";
export const GEO_NOISE_METRIC_ID = "NOISE";
const NET_ROUND_KINDS = new Set(["baseline", "weekly"]);
const SOURCE_ROUND_KINDS = new Set(["baseline", "weekly", "single_step"]);

/**
 * @typedef {object} GeoMetricsDeps
 * @property {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @property {() => Date} [now]
 * @property {number} [maxRounds]   rounds per tick (default 3)
 * @property {any} [evolution]
 * @property {(round: { id: string, geoProjectId: string, kind: string }) => unknown} [onRoundMeasured]
 */

/**
 * Compute every round that is ready and has not been computed (or has new
 * facts since).
 * @param {GeoMetricsDeps} deps
 */
export async function tickMetrics(deps) {
  const { store } = deps;
  await store.ready();
  const counts = { rounds: 0, cells: 0, noise: 0, net: 0, sources: 0 };
  for (const roundId of await store.roundsToMeasure([...GEO_METRIC_ROUND_KINDS], Math.max(1, deps.maxRounds ?? 3))) {
    const measured = await measureRound(deps, roundId);
    if (!measured) continue;
    counts.rounds += 1;
    counts.cells += measured.cells;
    counts.noise += measured.noise;
    counts.net += measured.net;
    counts.sources += measured.sources;
    try {
      await deps.onRoundMeasured?.({ id: roundId, geoProjectId: measured.geoProjectId, kind: measured.kind });
    } catch { /* the numbers are written either way */ }
  }
  return counts;
}

/**
 * @typedef {{ questionId?: string | null, engine: string, repeatIndex?: number | null, status: string, askedAt?: string | null, facts?: object | null }} BalanceRow
 */

/**
 * One answer per job, and the questions answered on every engine that
 * answered anything in the round.
 *
 * - `deduped`: every row, with at most one in-denominator answer (a judged
 *   valid answer, or a refusal) per question × engine × repeat — the latest.
 *   Suspect and failed asks are kept: they are the valid-rate's denominator.
 * - `rows`: `deduped` restricted to the questions that have such an answer on
 *   every engine for every repeat — the balanced set the cross-engine scopes
 *   are computed on.
 * @template {BalanceRow} T
 * @param {T[]} rows
 */
export function balanceRows(rows) {
  const answered = (/** @type {T} */ row) => (row.status === "valid" && Boolean(row.facts)) || row.status === "refusal";
  const key = (/** @type {T} */ row) => `${row.questionId}\u0000${row.engine}\u0000${row.repeatIndex ?? 0}`;
  /** @type {Map<string, T>} */
  const latest = new Map();
  for (const row of rows) {
    if (!answered(row) || !row.questionId) continue;
    const previous = latest.get(key(row));
    if (!previous || String(row.askedAt ?? "") >= String(previous.askedAt ?? "")) latest.set(key(row), row);
  }
  const deduped = rows.filter((row) => !answered(row) || !row.questionId || latest.get(key(row)) === row);
  const engines = [...new Set([...latest.values()].map((row) => row.engine))].sort();
  const repeats = [...new Set(rows.map((row) => row.repeatIndex ?? 0))];
  const questions = [...new Set(rows.map((row) => row.questionId).filter((id) => typeof id === "string"))];
  const complete = new Set(questions.filter((questionId) => engines.every((engine) => repeats.every((repeat) =>
    latest.has(`${questionId}\u0000${engine}\u0000${repeat}`)))));
  return {
    deduped,
    rows: deduped.filter((row) => row.questionId && complete.has(row.questionId)),
    engines,
    questions: questions.length,
    kept: complete.size,
    dropped: questions.filter((questionId) => !complete.has(/** @type {string} */ (questionId))),
  };
}

/** @param {string} metricId @param {{ value: number | null, measured: boolean, reason: string | null }} band @param {number} snapshots */
function noiseRow(metricId, band, snapshots) {
  return {
    scope: "project", metricId: GEO_NOISE_METRIC_ID, variant: metricId, value: band.value, numerator: null, denominator: null,
    ciLow: null, ciHigh: null, status: band.measured ? "ok" : "not_measurable", reason: band.reason, dataType: "derived", snapshotCount: snapshots,
  };
}

/**
 * What `computeGeoMetrics` is told about a project beside the rows.
 * @param {{ engines: string[], competitors: Array<Record<string, any>> }} project @param {{ engines: string[] }} round @param {{ owned?: any } | null} context
 */
function metricOptions(project, round, context) {
  return {
    engines: round.engines.length ? round.engines : project.engines,
    competitors: project.competitors.map((competitor) => String(competitor?.brandName || competitor?.genericName || "")).filter(Boolean),
    owned: context?.owned ?? {},
  };
}

/** The groups a round's answers belong to, and whether each is a control group. @param {Array<{ groupId?: string | null, isControl?: boolean }>} rows */
function groupsOf(rows) {
  /** @type {Map<string, boolean>} */
  const groups = new Map();
  for (const row of rows) if (row.groupId) groups.set(row.groupId, Boolean(row.isControl));
  return groups;
}

/**
 * The two arms of a round: every pilot group in it, and every control group in it that no article had touched.
 * @param {Map<string, boolean>} groups @param {Set<string>} contaminated
 * @returns {{ pilot: string[], control: string[] }}
 */
export function armsOf(groups, contaminated) {
  const ids = (/** @type {(control: boolean, id: string) => boolean} */ keep) => [...groups].filter(([id, control]) => keep(control, id)).map(([id]) => id).sort();
  return { pilot: ids((control) => !control), control: ids((control, id) => control && !contaminated.has(id)) };
}

/**
 * The groups every one of these rounds had in each arm: what a net effect can compare.
 * @param {Array<{ pilot: readonly string[], control: readonly string[] }>} memberships
 * @returns {{ pilot: string[], control: string[] }}
 */
export function commonArms(memberships) {
  const common = (/** @type {"pilot" | "control"} */ arm) => {
    const [first, ...rest] = memberships.map((entry) => new Set(entry[arm]));
    return first ? [...first].filter((id) => rest.every((set) => set.has(id))).sort() : [];
  };
  return { pilot: common("pilot"), control: common("control") };
}

/**
 * Compute one round and write its rows.
 * @param {GeoMetricsDeps} deps @param {string} roundId
 * @returns {Promise<{ geoProjectId: string, kind: string, cells: number, noise: number, net: number, sources: number, balanceDropped: number } | null>}
 */
export async function measureRound(deps, roundId) {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const round = await store.round(roundId);
  if (!round) return null;
  const project = await store.project(round.geoProjectId);
  if (!project) return null;
  const rows = await store.roundFactRows(roundId);
  const out = { geoProjectId: project.id, kind: round.kind, cells: 0, noise: 0, net: 0, sources: 0, balanceDropped: 0 };

  if (round.kind === "noise") {
    const noise = GEO_METRICS.platform.noise_band_metric_ids.map((metricId) => noiseRow(metricId, noiseBand(rows, { metricId }), rows.length));
    await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: noise });
    out.noise = noise.length;
    return out;
  }

  const skipped = new Set(await store.roundSkippedEngines(roundId));
  const kept = rows.filter((row) => !skipped.has(row.engine));
  const context = await store.projectContext(project.id);
  const contaminated = new Set(await store.contaminatedControlGroups(project.id));
  const options = { ...metricOptions(project, round, context), arms: armsOf(groupsOf(kept), contaminated) };
  // Per engine, every answer counts. Across engines (project, pool, group,
  // arm) only questions answered on every engine: one failed ask would
  // otherwise give its question fewer valid answers than the rest, and the
  // domain withdraws the whole pool's rates as uneven_denominators.
  const balance = balanceRows(kept);
  const perEngine = computeGeoMetrics(/** @type {any[]} */ (balance.deduped), { ...options, scopes: ["engine", "pool_engine"] });
  const across = computeGeoMetrics(/** @type {any[]} */ (balance.rows), { ...options, scopes: ["project", "pool", "group", "arm"] });
  const cells = [...across.cells, ...perEngine.cells];
  const communication = deps.evolution?.communication;
  if (communication && kept.some((row) => row.statements?.some((statement) => statement.verdict === "wrong"))) {
    try { await communication.offer({ sourceEventId: `geo-round:${round.id}`, userId: project.userId, projectId: project.projectId, entityKeys: project.entityKeys ?? [] }); } catch { /* Module intake must not affect measurement. */ }
  }
  await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: cells });
  await store.noteRoundBalance(roundId, { questions: balance.questions, kept: balance.kept, dropped: balance.dropped.length,
    droppedQuestionIds: balance.dropped.slice(0, 50), engines: balance.engines, arms: options.arms });
  out.cells = cells.length;
  out.balanceDropped = balance.dropped.length;
  const arms = options.arms;

  if (NET_ROUND_KINDS.has(round.kind)) {
    const net = await netEffectRows(store, { project, round, controlGroups: arms.control.length, engines: balance.engines, arms });
    await store.writeMetrics({ roundId, geoProjectId: project.id, userId: project.userId, computedAt: now, rows: net, replace: { metricId: GEO_NET_METRIC_ID } });
    out.net = net.length;
  }
  if (SOURCE_ROUND_KINDS.has(round.kind)) {
    out.sources = await store.refreshSourceCitations({ roundId, geoProjectId: project.id, userId: project.userId, now });
  }
  return out;
}

/**
 * Whether a round's cells were computed over exactly these engines (the
 * comparability key `engines`). A round with no recorded engine set is not
 * known to match, so it is not compared.
 * @param {readonly string[] | null | undefined} measured @param {readonly string[]} engines
 */
export function sameEngines(measured, engines) {
  if (!Array.isArray(measured)) return false;
  const left = [...new Set(measured.map(String))].sort();
  const right = [...new Set(engines.map(String))].sort();
  return left.length === right.length && left.every((engine, index) => engine === right[index]);
}

/**
 * The net effect of every metric the owner's table names per pool, and of the
 * index, from the project's comparable rounds (same question set, baseline and
 * weekly, and measured on the same engines), as `NET` rows.
 *
 * The same engines, because a cross-engine rate over four engines and one
 * over two are different quantities: with the probe host down to 千问 and Kimi,
 * the first weekly re-measure against the 09-25 baseline (DeepSeek, Kimi,
 * 千问, 元宝) would have read as a drop in both arms and a net effect built on
 * it (metrics.json net_effect.comparability_keys names `engines`; nothing read
 * it). Only rounds measured on the engines this round was measured on are
 * compared; when the baseline window holds none, the row says `engines_differ`
 * — 引擎不同，不可比 — instead of a number.
 *
 * And over enough answers: a window under the 30-answer cell floor
 * (`STD_CELL_MIN_SAMPLES`) gives no number either — the row says
 * `insufficient_sample` (Q-2: pilot 2/8 → 5/8 against control 2/8 → 2/8 used to
 * be stored `ok`, "up", on windows of eight answers). A computed row keeps the
 * threshold its verdict was judged against and whether that threshold was
 * measured (`noise_band`, `noise_measured`); only M-01, M-03 and M-10 have a
 * noise round, so the other metrics' rows say it was the default.
 *
 * And over the same groups (Q-3): with `arms`, the groups this round's two arms were, the series is read over the groups every compared
 * round had, and the count of control groups is that of the groups they share. A caller that gives no arms gets the stored cells as
 * they are.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @param {{ project: { id: string, engines?: string[], competitors?: Array<Record<string, any>> }, round: { id?: string, setVersion: number | null, sampleDate: string | null, surface?: any },
 *   controlGroups: number, engines: readonly string[], arms?: { pilot: string[], control: string[] } | null }} input
 */
export async function netEffectRows(store, { project, round, controlGroups, engines, arms = null }) {
  const baselineDate = await store.baselineDate(project.id, round.setVersion);
  const noiseIds = new Set(GEO_METRICS.platform.noise_band_metric_ids);
  const compared = arms ? await comparedArms(store, { project, round, engines, arms }) : null;
  const controls = compared ? compared.common.control.length : controlGroups;
  const rows = [];
  for (const [pool, metricIds] of Object.entries(GEO_METRICS.net_effect.metrics_by_pool)) {
    const index = pool === "index";
    for (const metricId of metricIds) {
      const series = await store.armSeries({ geoProjectId: project.id, setVersion: round.setVersion, metricId, pool: index ? null : pool });
      if (compared) for (const arm of /** @type {const} */ (["pilot", "control"])) {
        series[arm] = series[arm].map((point) => {
          const cells = compared.recomputed.get(point.roundId);
          if (!cells) return point;
          return { ...point, ...observed(cells.get(`${arm}\u0000${index ? "" : pool}\u0000${metricId}`)) };
        });
      }
      const noise = noiseIds.has(metricId) ? await store.latestNoiseBand(project.id, metricId) : null;
      const where = { scope: index ? "project" : "pool", pool: index ? null : pool, metricId: GEO_NET_METRIC_ID, variant: metricId, dataType: "derived",
        ciLow: null, ciHigh: null, snapshotCount: null };
      // With nothing after the baseline window there is no change to compare.
      if (!baselineDate || !round.sampleDate || round.sampleDate <= baselineDate) {
        rows.push({ ...where, value: null, numerator: null, denominator: null, status: "not_measurable", reason: "no_follow_up" });
        continue;
      }
      const comparable = {
        pilot: series.pilot.filter((point) => sameEngines(point.engines, engines)),
        control: series.control.filter((point) => sameEngines(point.engines, engines)),
      };
      const hasBaseline = (/** @type {Array<{ date: string }>} */ points) => points.some((point) => point.date <= baselineDate);
      // Engines are the reason only when they are what removed the baseline:
      // an arm with no baseline point at all (no control groups yet, say)
      // is the net effect's own "cannot compute", said below with its reason.
      const enginesRemovedBaseline = (/** @type {"pilot" | "control"} */ arm) => hasBaseline(series[arm]) && !hasBaseline(comparable[arm]);
      if (enginesRemovedBaseline("pilot") || enginesRemovedBaseline("control")) {
        rows.push({ ...where, value: null, numerator: null, denominator: null, status: "not_measurable", reason: "engines_differ" });
        continue;
      }
      const effect = netEffect(comparable.pilot, comparable.control, { noise, baselineDate, controlGroupCount: controls });
      // Assistant names do not establish stable model versions.
      if (effect.status === "computed" && round.surface?.intervention?.engines?.some((engine) => engine.observedVersion === "unknown")) {
        rows.push({ ...where, value: null, numerator: null, denominator: null, status: "not_measurable", reason: "engine_version_unknown" });
        continue;
      }
      // The verdict is only as good as the band it was judged against: the row keeps that band and whether it was measured
      // (a noise round exists for M-01, M-03 and M-10) or the default, and the page says which.
      const why = (/** @type {string} */ reason) => (effect.missing ?? []).some((entry) => entry.reason === reason);
      rows.push(effect.status === "computed"
        ? { ...where, value: effect.value ?? null, numerator: effect.pilotChange ?? null, denominator: effect.controlChange ?? null, status: "ok",
          reason: effect.verdict ?? null, noiseBand: effect.noiseThreshold ?? null, noiseMeasured: effect.noiseMeasured ?? null }
        : { ...where, value: null, numerator: null, denominator: null, status: "not_measurable",
          reason: why("too_few_control_groups") ? "too_few_control_groups" : why("insufficient_sample") ? "insufficient_sample" : "not_computable" });
    }
  }
  return rows;
}

/**
 * What `armSeries` makes of a cell: a value and its counts when the cell is `ok`, or `insufficient` with counts (the net effect pools
 * such a cell with its window and holds the window to the floor); nothing otherwise.
 * @param {{ status: string, value: number | null, numerator: number | null, denominator: number | null } | undefined} cell
 */
function observed(cell) {
  const measurable = Boolean(cell) && (cell?.status === "ok" || (cell?.status === "insufficient" && typeof cell.denominator === "number"));
  return measurable
    ? { value: cell?.value ?? null, numerator: cell?.numerator ?? null, denominator: cell?.denominator ?? null }
    : { value: null, numerator: null, denominator: null };
}

/**
 * The groups every compared round had in each arm, and the arm cells of each compared round whose arms were wider, computed again
 * from that round's own answers over those groups (Q-3). A round's arms are the ones it recorded; a round measured before they were
 * recorded has the groups its answers belong to (the control groups an article had touched by then are not known, so that is an upper
 * bound, and the cells are recomputed whenever it is wider than the shared groups). A round with no answers on file has nothing to
 * compare by and is left as stored.
 * @param {import("./geoMeasureStore.mjs").GeoMeasureStore} store
 * @param {{ project: { id: string, engines?: string[], competitors?: Array<Record<string, any>> }, round: { id?: string, setVersion: number | null },
 *   engines: readonly string[], arms: { pilot: string[], control: string[] } }} input
 * @returns {Promise<{ common: { pilot: string[], control: string[] }, recomputed: Map<string, Map<string, any>> }>}
 */
async function comparedArms(store, { project, round, engines, arms }) {
  const entries = (await store.armRounds({ geoProjectId: project.id, setVersion: round.setVersion })).filter((entry) => sameEngines(entry.engines, engines));
  /** @type {Map<string, any[]>} */
  const answers = new Map();
  const keptOf = async (/** @type {string} */ roundId) => {
    if (!answers.has(roundId)) {
      const skipped = new Set(await store.roundSkippedEngines(roundId));
      answers.set(roundId, (await store.roundFactRows(roundId)).filter((row) => !skipped.has(row.engine)));
    }
    return /** @type {any[]} */ (answers.get(roundId));
  };
  /** @type {Array<{ roundId: string, arms: { pilot: string[], control: string[] } }>} */
  const memberships = [];
  for (const entry of entries) {
    if (entry.arms) { memberships.push({ roundId: entry.roundId, arms: entry.arms }); continue; }
    const kept = await keptOf(entry.roundId);
    if (kept.length) memberships.push({ roundId: entry.roundId, arms: armsOf(groupsOf(kept), new Set()) });
  }
  if (round.id && !memberships.some((entry) => entry.roundId === round.id)) memberships.push({ roundId: round.id, arms });
  const common = commonArms(memberships.map((entry) => entry.arms));
  const same = (/** @type {string[]} */ left, /** @type {string[]} */ right) => left.length === right.length && left.every((id, index) => id === right[index]);
  /** @type {Map<string, Map<string, any>>} */
  const recomputed = new Map();
  /** @type {Awaited<ReturnType<typeof store.projectContext>> | undefined} */
  let context;
  for (const entry of memberships) {
    if (same([...entry.arms.pilot].sort(), common.pilot) && same([...entry.arms.control].sort(), common.control)) continue;
    const stored = (await store.round(entry.roundId));
    const kept = await keptOf(entry.roundId);
    if (!stored || !kept.length) continue;
    context ??= await store.projectContext(project.id);
    const result = computeGeoMetrics(/** @type {any[]} */ (balanceRows(kept).rows), {
      ...metricOptions(/** @type {any} */ (project), stored, context), arms: common, scopes: ["arm"],
    });
    recomputed.set(entry.roundId, new Map(result.cells.filter((cell) => cell.arm && !cell.variant && !cell.rival)
      .map((cell) => [`${cell.arm}\u0000${cell.pool ?? ""}\u0000${cell.metricId}`, cell])));
  }
  return { common, recomputed };
}
