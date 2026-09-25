import { GEO_ENGINE_LABELS_ZH, GEO_POOL_LABELS_ZH, GEO_STEP_LABELS_ZH, GEO_STEPS, canonicalGeoUrl } from "@evimed/domain";
import { geoProjectFromRow } from "./geoStore.mjs";
import { HttpError } from "./security.mjs";

/**
 * 「循证 GEO」's program state machine (build spec 2026-09-25 §5; plan §6):
 * which step runs next, decided by platform rules and never by the model.
 *
 * The eight steps (`projects.steps`) are the program as the page reads it.
 * AI runs *think* (steps 1–3 in one `geo-insight` run, step 5 `geo-strategy`,
 * step 6 `geo-content` in batches, exports `geo-proposal`); the platform
 * *measures* (diagnosis and monitoring are measurement rounds) and
 * *transacts* (distribution is the market's loop). This module dispatches
 * the runs, enqueues the rounds, keeps the steps current, schedules the
 * re-measurements and sends the five notices.
 *
 * Hidden knowledge:
 *
 * - **What is wanted is derived, not stored.** A step the user asked for is
 *   `requested` (「让 AI 做」 sets it; a full program has all eight). What a
 *   requested step needs upstream is wanted too, as a *minimal* version when
 *   it was not itself requested (plan §5.5: 「只做信源分析与预期」 = identity +
 *   label claims + 30 questions → one round → the strategy run). A
 *   conversation that locks a question set with nothing requested starts the
 *   program itself: a full set is the full program, a minimal set is a
 *   diagnosis.
 * - **One run per project at a time**, and "run" means any run in the
 *   project — the researcher's own conversation included (the dispatcher
 *   refuses while one is running). A refused or capacity-limited dispatch
 *   (`runtime_busy`, the per-user runtime cap) is retried on the next tick;
 *   the step waits `queued`.
 * - **Every side effect is claimed first** in `evimed_geo.schedule_marks` by a
 *   key that names it (`run:insight`, `round:diagnosis:v2`, `weekly:2026-09-28`,
 *   `postpub:<article>:w4`, `notice:error:<id>`). The key is what makes a tick,
 *   a restart and a second process idempotent: a round is enqueued once per
 *   key (its `ref.scheduleKey` names it, so a claim that died between the
 *   enqueue and the mark finds the round it made), and a run's dispatch id is
 *   derived from its key and attempt, so the run ledger returns the existing
 *   run for a dispatch that was accepted but not recorded.
 * - **A run's end is read from the data, not only its status.** An insight
 *   run is done for evidence when claims exist, for the journey when a journey
 *   version exists, for the questions when the set is locked; the strategy
 *   run when strategy and targets exist; a content batch when it registered
 *   articles. A failed run that wrote them still counts (principle 19); a
 *   finished run that wrote nothing fails its steps, and a failed run is
 *   retried once before its step waits for a person to ask again.
 * - **Schedules are calendar arithmetic in the module's zone**
 *   (`OPEN_SCIENCE_GEO_TIMEZONE`, Asia/Shanghai): the weekly re-measure is
 *   due from Monday 03:00 of the current week, the sentinels from 08:00 each
 *   day, post-publication checks at weeks 1, 2, 4, 8 and 12 after an
 *   article's first publication. A check missed by more than a week is
 *   recorded as skipped with its reason, never back-filled with an old
 *   answer (IRON-06).
 * - **Paused is paused**: nothing new is dispatched or enqueued for a paused
 *   project; a run already out is still folded when it ends.
 *
 * @module geoOrchestrator
 */

/** Which capability thinks each run. */
export const GEO_RUN_CAPABILITIES = Object.freeze({
  insight: "geo-insight",
  strategy: "geo-strategy",
  content: "geo-content",
  export: "geo-proposal",
});

/** What a step needs done (or minimal) before it can be worked. */
const NEEDS = Object.freeze({
  evidence: [], journey: ["evidence"], questions: ["evidence"], diagnosis: ["questions"], sources: ["diagnosis"],
  content: ["evidence"], distribution: ["content"], monitoring: ["diagnosis"],
});
const INSIGHT_STEPS = Object.freeze(["evidence", "journey", "questions"]);
const FINISHED = new Set(["done", "minimal"]);
const TERMINAL_RUN = new Set(["succeeded", "failed", "canceled", "cancelled"]);
/** Dispatch refusals that will not clear by waiting a minute. */
const TERMINAL_DISPATCH = new Set(["geo_unavailable", "geo_project_not_found", "project_not_found", "autopilot_capability_unavailable"]);

/** The platform's numbers for the schedules (plan §3.8, §6; geo-skills' monitor constants). */
export const GEO_SCHEDULE = Object.freeze({
  weeklyWeekday: 1,
  weeklyHour: 3,
  sentinelHour: 8,
  sentinelQuestions: 10,
  sentinelEngines: 2,
  sentinelDefaultEngines: Object.freeze(["deepseek", "yuanbao"]),
  postPublicationWeeks: Object.freeze([1, 2, 4, 8, 12]),
  postPublicationMissedDays: 7,
  baselineRestDays: 3,
  noiseQuestions: 10,
  noiseRepeat: 5,
  metricsGraceMinutes: 30,
  stalePlacementWeeks: 8,
});
/** Runs: at most five articles a batch, two tries a run, a claim that stalls for ten minutes is retried. */
export const GEO_RUN_RULES = Object.freeze({ batchMax: 5, firstBatchesMax: 6, attempts: 2, staleClaimMinutes: 10, projectsPerTick: 200,
  noticeScanDays: 14, noticesPerTick: 20 });

const DAY_MS = 86_400_000;

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "geo_orchestrator_failed");
/** @param {string} engine */
const engineLabel = (engine) => /** @type {Record<string, string>} */ (GEO_ENGINE_LABELS_ZH)[engine] ?? engine;
/** @param {string} step */
const stepLabel = (step) => /** @type {Record<string, string>} */ (GEO_STEP_LABELS_ZH)[step] ?? step;

// ------------------------------------------------------------------ the program, derived

/**
 * What the program wants from its steps: every requested step and, as a
 * minimal version, whatever it needs upstream. A full program (all eight
 * requested) also writes content only after the strategy (battlefield first).
 * @param {Record<string, { status: string, requested: boolean }>} steps
 */
export function wantedSteps(steps) {
  const requested = new Set(GEO_STEPS.filter((step) => steps?.[step]?.requested === true));
  const full = GEO_STEPS.every((step) => requested.has(step));
  const want = new Set();
  /** @param {string} step */
  const add = (step) => {
    if (want.has(step)) return;
    want.add(step);
    for (const need of [...(/** @type {Record<string, string[]>} */ (NEEDS)[step] ?? []), ...(full && step === "content" ? ["sources"] : [])]) add(need);
  };
  for (const step of requested) add(step);
  return {
    want, requested, full,
    /** @param {string} step @returns {"full" | "minimal"} */
    fidelity: (step) => (requested.has(step) ? "full" : "minimal"),
  };
}

// ------------------------------------------------------------------ calendar arithmetic

/** The parts of an instant in a zone; `weekday` 1 = Monday … 7 = Sunday. @param {Date} date @param {string} timeZone */
export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(parts.weekday)) + 1;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute),
    weekday, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** The instant a zoned calendar day reaches `hour`:00. @param {string} day YYYY-MM-DD @param {number} hour @param {string} timeZone */
export function zonedInstant(day, hour, timeZone) {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date, hour);
  // Read back what the guess shows in the zone and move by the difference;
  // twice, so an offset change between the two readings settles.
  let at = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = zonedParts(new Date(at), timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
    at += guess - shownUtc;
  }
  return new Date(at);
}

/** A zoned day moved by whole days. @param {string} day @param {number} days */
function addDays(day, days) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/**
 * This week's weekly re-measure: the Monday it belongs to (`weekly:<monday>`),
 * the instant it is due (Monday 03:00 in the zone) and whether it is due now.
 * @param {Date} now @param {string} timeZone
 */
export function weeklySlot(now, timeZone) {
  const parts = zonedParts(now, timeZone);
  const monday = addDays(parts.date, -(parts.weekday - GEO_SCHEDULE.weeklyWeekday));
  const dueAt = zonedInstant(monday, GEO_SCHEDULE.weeklyHour, timeZone);
  return { monday, dueAt, due: now.getTime() >= dueAt.getTime() };
}

/** Today's sentinel: its day, and whether 08:00 has come. @param {Date} now @param {string} timeZone */
export function sentinelSlot(now, timeZone) {
  const parts = zonedParts(now, timeZone);
  return { day: parts.date, due: parts.hour >= GEO_SCHEDULE.sentinelHour };
}

/**
 * The post-publication checkpoints of one article: weeks 1, 2, 4, 8, 12
 * after its first publication, each with whether it is due, and whether it
 * was missed (due more than a week ago — recorded, never back-filled).
 * @param {Date} publishedAt @param {Date} now
 */
export function postPublicationCheckpoints(publishedAt, now) {
  return GEO_SCHEDULE.postPublicationWeeks.map((week) => {
    const dueAt = new Date(publishedAt.getTime() + week * 7 * DAY_MS);
    const late = now.getTime() - dueAt.getTime();
    return { week, dueAt, due: late >= 0, missed: late > GEO_SCHEDULE.postPublicationMissedDays * DAY_MS };
  });
}

/**
 * The sentinel engines: the two with the highest retrieval rate (M-10,
 * engine scope, measured) among the project's own; ties by sample size, then
 * name. Before there is a measured rate, geo-skills' defaults (DeepSeek and
 * 元宝) where the project has them, then the project's engines in order.
 * @param {Array<{ engine: string, value: number | null, denominator?: number | null, status?: string }>} rows
 * @param {readonly string[]} projectEngines
 */
export function sentinelEngines(rows, projectEngines) {
  const own = new Set(projectEngines);
  const ranked = rows
    .filter((row) => own.has(row.engine) && row.status === "ok" && typeof row.value === "number" && Number.isFinite(row.value))
    .sort((left, right) => /** @type {number} */ (right.value) - /** @type {number} */ (left.value)
      || Number(right.denominator ?? 0) - Number(left.denominator ?? 0) || left.engine.localeCompare(right.engine))
    .map((row) => row.engine);
  const chosen = [...new Set(ranked)].slice(0, GEO_SCHEDULE.sentinelEngines);
  for (const engine of [...GEO_SCHEDULE.sentinelDefaultEngines, ...projectEngines]) {
    if (chosen.length >= GEO_SCHEDULE.sentinelEngines) break;
    if (own.has(engine) && !chosen.includes(engine)) chosen.push(engine);
  }
  return chosen;
}

/**
 * The most important measured questions: by their group's weight, highest
 * first, then in the order the map was written.
 * @param {Array<{ weight: number | null, questions: Array<{ id: string, isMeasured: boolean, retiredAt?: string | null }> }>} groups
 * @param {number} count
 */
export function topQuestions(groups, count) {
  const rows = [];
  let order = 0;
  for (const group of groups) {
    for (const question of group.questions) {
      order += 1;
      if (question.isMeasured && !question.retiredAt) rows.push({ id: question.id, weight: Number(group.weight ?? 0), order });
    }
  }
  return rows.sort((left, right) => right.weight - left.weight || left.order - right.order).slice(0, count).map((row) => row.id);
}

// ------------------------------------------------------------------ what a run is told

/** @param {any} project */
function productLine(project) {
  const product = project.product && typeof project.product === "object" ? project.product : {};
  const brand = typeof product.brandName === "string" ? product.brandName.trim() : "";
  const generic = typeof product.genericName === "string" ? product.genericName.trim() : "";
  if (brand && generic && brand !== generic) return `产品：${brand}（通用名：${generic}）。`;
  if (brand || generic) return `产品：${brand || generic}。`;
  return "产品：项目里还没有写产品身份，先用 geo_read 读项目名称；确认不了是哪一个产品时，只问一句是哪个厂家、哪个规格。";
}

/** @param {any} project */
function scopeLine(project) {
  return `覆盖周期 ${project.coverageDays} 天；AI 引擎：${(project.engines ?? []).map(engineLabel).join("、")}。`;
}

const DATA_LINE = "项目里已有的数据用 geo_read 读（做过且没有过期的不要重做），产出用 geo_write 写回项目。测量由平台自己跑，不要在运行里批量探测。";

/**
 * The brief of an insight run (steps 1–3).
 * @param {any} project @param {{ scope: Array<{ step: string, fidelity: "full" | "minimal" }>, target: string | null, full: boolean }} plan
 */
export function insightBrief(project, { scope, target, full }) {
  const lines = [`「循证 GEO」自动运行 · ${full ? "完整方案" : "单步"} · 第 1–3 步（证据、旅程、问题）`, productLine(project), scopeLine(project)];
  if (!full && target) {
    lines.push(`单步模式：用户要的是「${stepLabel(target)}」。只补它需要的最小上游，报告里写明哪些部分是最小版、完整版还会补什么。`);
  }
  lines.push("这次要做：");
  for (const { step, fidelity } of scope) {
    if (step === "evidence") {
      lines.push(fidelity === "full"
        ? "· 证据：核实产品身份和说明书，竞品，完整主张库（通常 30–50 条，每条带说明书或文献原文引用）。"
        : "· 证据（最小版）：核实产品身份，只从说明书取主张——适应证、用法用量、禁忌、特殊人群、主要不良反应、相互作用。");
    } else if (step === "journey") {
      lines.push("· 旅程：人群分型与规模、人物画像、患者旅程、就医节点与就医红旗。");
    } else if (step === "questions") {
      lines.push(fidelity === "full"
        ? "· 问题：采集真实问法，四池问题地图，3–5 个对照组，锁定 40–120 个测量问句（lock_questions）。"
        : "· 问题（最小版）：四池都有、共 30 个测量问句，没采到真实问法的写成 typical；用 lock_questions 并设 minimal:true 锁定。");
    }
  }
  lines.push(DATA_LINE);
  lines.push("写回顺序：geo_write product、claims、journey、questions，锁定问句后用 step 标记做完的步骤。锁定之后平台会自己测基线。");
  return lines.join("\n");
}

/** The brief of the strategy run (step 5). @param {any} project @param {{ minimal: boolean }} plan */
export function strategyBrief(project, { minimal }) {
  return [
    `「循证 GEO」自动运行 · 第 5 步（信源）`,
    productLine(project), scopeLine(project),
    `诊断已经测完${minimal ? "（最小版：30 个问句测一轮，数字只代表这 30 个问句，报告里写明）" : "（基线）"}。先用 geo_read 读 diagnosis、metrics、snapshots、sources、errors。`,
    "这次要做：信源表、七类缺口、每个引擎本周期能做到什么、主战场与布局、三档目标（每档写目标、稿件数和预算）。",
    "写回：geo_write strategy（信源放在 sources 里）和 targets（档一、档二、档三，dataType 为 forecast）。",
    DATA_LINE,
  ].join("\n");
}

/**
 * The brief of one content batch (step 6).
 * @param {any} project
 * @param {{ number: number | string, groups: Array<{ name: string | null, pool: string | null, typicalQuestion: string | null }>,
 *   errors: Array<{ engine: string, statement: string | null }>, reason: "first" | "next" | "single", size: number }} batch
 */
export function contentBrief(project, { number, groups, errors, reason, size }) {
  const lines = [`「循证 GEO」自动运行 · 第 6 步（内容）· ${typeof number === "number" ? `第 ${number} 批` : number}`, productLine(project)];
  if (reason === "next") lines.push("这是每周复测之后的下一轮：补离目标还差的语义群、投了没被引用的主题、复测里还在的讲错我方。");
  lines.push(`这一批最多 ${size} 篇，先写主战场语义群，再写纠错材料：`);
  for (const group of groups) {
    const pool = group.pool ? /** @type {Record<string, string>} */ (GEO_POOL_LABELS_ZH)[group.pool] ?? group.pool : "";
    lines.push(`· 语义群「${group.name ?? "未命名"}」${pool ? `（${pool}）` : ""}${group.typicalQuestion ? `：典型问句「${group.typicalQuestion}」` : ""}`);
  }
  for (const error of errors) lines.push(`· 纠错材料：${engineLabel(error.engine)}讲错「${error.statement ?? ""}」`);
  if (!groups.length && !errors.length) lines.push("· 由你按主张库和问题地图挑最需要的主题。");
  lines.push("语义群的 groupId 用 geo_read questions 查，讲错我方的依据用 geo_read errors 查。每篇过交付闸门后用 geo_write articles 登记（path、layer、groupId、claimIds、gate、safety、contentSha256）。有临床安全问题就如实标 safety: open，不要自己放行。");
  lines.push(DATA_LINE);
  return lines.join("\n");
}

/** The brief of an export run. @param {any} project @param {{ kind: string, week?: string | null }} request */
export function exportBrief(project, { kind, week = null }) {
  if (kind === "weekly") {
    return [
      `「循证 GEO」自动运行 · 周报${week ? `（${week} 这一周）` : ""}`,
      productLine(project),
      "用周报模式出一份 PDF 和一份 Word：本周复测、投放组和对照组的净效应、被 AI 引用的稿件、新出现的讲错我方、下一轮做什么。",
      "所有数字都来自 geo_read，不补测、不编数；样本不足 30 写「样本不足」，没测的引擎写「未测」。",
      DATA_LINE,
    ].join("\n");
  }
  return [
    "「循证 GEO」 · 导出提案资料包",
    productLine(project),
    "出一套提案资料包：一个 Excel、两份 Word、一份 PPT、一份 HTML。只用项目已有的数据（geo_read），没做的步骤写「未做」。",
    DATA_LINE,
  ].join("\n");
}

// ------------------------------------------------------------------ the orchestrator

/**
 * @typedef {{ userId: string, projectId: string, geoProjectId: string, capabilityId: string, dispatchId: string, reason: string,
 *   brief: string }} GeoDispatch
 */

export class GeoOrchestrator {
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore, config?: Record<string, any>,
   *   notifier?: ReturnType<typeof import("./geoNotify.mjs").createGeoNotifier> | null,
   *   dispatchRun?: ((input: GeoDispatch) => Promise<{ runId: string, sessionId: string | null, status?: string | null }>) | null,
   *   runStatus?: ((input: { userId: string, projectId: string, runId: string, dispatchId: string | null }) => Promise<{ status: string } | null>) | null,
   *   latestSessionId?: ((input: { userId: string, projectId: string }) => Promise<string | null>) | null,
   *   enqueueRound?: ((spec: { geoProjectId: string, kind: string, questionIds?: string[], engines?: string[], repeat?: number,
   *     ref?: Record<string, any> }) => Promise<any>) | null,
   *   noteCitation?: ((input: { orderId: string, engine: string }) => Promise<any>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   *   `enqueueRound` is the measurement package's, bound to its deps; absent,
   *   diagnosis and the schedules wait and `status()` says measurement is not wired.
   */
  constructor({ store, config = {}, notifier = null, dispatchRun = null, runStatus = null, latestSessionId = null, enqueueRound = null,
    noteCitation = null, now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("The GEO orchestrator needs the GEO store.");
    this.store = store;
    this.config = config;
    this.notifier = notifier;
    this.dispatchRun = dispatchRun;
    this.runStatus = runStatus;
    this.latestSessionId = latestSessionId;
    this.enqueueRound = enqueueRound;
    this.noteCitation = noteCitation;
    this.now = now;
    this.report = report;
    this.timeZone = String(config.geoTimeZone || "Asia/Shanghai");
    /** @type {Map<string, Promise<unknown>>} one advance per project at a time, in this process */
    this.locks = new Map();
    this.counters = { ticks: 0, scheduleTicks: 0, dispatched: 0, deferred: 0, dispatchFailed: 0, runsFinished: 0, roundsEnqueued: 0,
      roundsSkipped: 0, notices: 0, projectErrors: 0 };
    /** @type {string | null} */
    this.lastDeferral = null;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {string | null} */
    this.lastTickAt = null;
  }

  status() {
    return {
      measurement: this.enqueueRound ? "wired" : "missing",
      dispatch: this.dispatchRun ? "wired" : "missing",
      lastTickAt: this.lastTickAt, lastDeferral: this.lastDeferral, lastError: this.lastError,
      counters: { ...this.counters },
    };
  }

  // --- marks ----------------------------------------------------------------------------

  /** @param {string} geoId @param {string} key */
  async #mark(geoId, key) {
    return (await this.store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = $2`, [geoId, key])).rows[0] ?? null;
  }

  /** @param {string} geoId @param {string} prefix */
  async #marksWith(geoId, prefix) {
    return (await this.store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND starts_with(key, $2)
      ORDER BY created_at, key LIMIT 2000`, [geoId, prefix])).rows;
  }

  /**
   * Insert a mark unless its key exists; a `claimed` mark left stale (a
   * process that died mid-claim) is taken over. Returns the row when this
   * caller holds it.
   * @param {any} project @param {string} key @param {string} kind @param {string} state @param {Record<string, any>} [fields]
   */
  async #claim(project, key, kind, state, fields = {}) {
    const result = await this.store.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, round_id, detail, done_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CASE WHEN $5 IN ('done', 'failed', 'skipped') THEN now() END)
      ON CONFLICT (geo_project_id, key) DO UPDATE SET state = EXCLUDED.state, detail = schedule_marks.detail || EXCLUDED.detail, updated_at = now()
        WHERE schedule_marks.state = 'claimed' AND schedule_marks.updated_at < now() - make_interval(mins => $8)
      RETURNING *`,
    [project.id, key, project.userId, kind, state, fields.roundId ?? null, JSON.stringify(fields.detail ?? {}), GEO_RUN_RULES.staleClaimMinutes]);
    return result.rows[0] ?? null;
  }

  /**
   * Move a mark; only from the states given when any are.
   * @param {string} geoId @param {string} key
   * @param {{ state?: string, runId?: string | null, sessionId?: string | null, dispatchId?: string | null, roundId?: string | null,
   *   attempts?: number, detail?: Record<string, any> }} patch @param {readonly string[]} [from]
   */
  async #update(geoId, key, patch, from) {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [geoId, key];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => { values.push(value); sets.push(`${column} = $${values.length}${cast}`); };
    if (patch.state !== undefined) {
      put("state", patch.state);
      sets.push(`done_at = CASE WHEN $${values.length} IN ('done', 'failed', 'skipped') THEN now() ELSE NULL END`);
    }
    if (patch.runId !== undefined) put("run_id", patch.runId);
    if (patch.sessionId !== undefined) put("session_id", patch.sessionId);
    if (patch.dispatchId !== undefined) put("dispatch_id", patch.dispatchId);
    if (patch.roundId !== undefined) put("round_id", patch.roundId);
    if (patch.attempts !== undefined) put("attempts", patch.attempts);
    if (patch.detail !== undefined) { values.push(JSON.stringify(patch.detail)); sets.push(`detail = detail || $${values.length}::jsonb`); }
    let guard = "";
    if (from?.length) { values.push([...from]); guard = ` AND state = ANY($${values.length}::text[])`; }
    const result = await this.store.query(`UPDATE evimed_geo.schedule_marks SET ${[...sets, "updated_at = now()"].join(", ")}
      WHERE geo_project_id = $1 AND key = $2${guard} RETURNING *`, values);
    return result.rows[0] ?? null;
  }

  // --- projects ---------------------------------------------------------------------------

  /** @param {string} id */
  async #project(id) {
    const row = (await this.store.query(`SELECT * FROM evimed_geo.projects WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    return row ? geoProjectFromRow(row) : null;
  }

  /** @param {string} id @param {() => Promise<any>} work */
  async #exclusive(id, work) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    this.locks.set(id, settled);
    try { return await next; } finally { if (this.locks.get(id) === settled) this.locks.delete(id); }
  }

  /** @param {any} project @param {string} step @param {Record<string, any>} fields */
  async #step(project, step, fields) {
    const current = project.steps?.[step] ?? {};
    const changed = Object.entries(fields).some(([key, value]) => (current[key] ?? null) !== (value ?? null));
    if (!changed) return project;
    return (await this.store.setStep(project.id, step, fields)) ?? project;
  }

  // --- the route hooks ----------------------------------------------------------------------

  /**
   * 「让 AI 做」: the step is requested, what serves it gets a fresh try, and
   * the project is advanced now — a run dispatched at once when one can be.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} step
   */
  async runStep(user, input, step) {
    if (!GEO_STEPS.includes(step)) throw new HttpError(400, "geo_step_invalid", `step must be one of: ${GEO_STEPS.join(", ")}.`);
    const project = await this.#project(input.id);
    if (!project || project.userId !== String(user.id)) throw new HttpError(404, "geo_project_not_found", "GEO project not found.");
    if (project.status !== "active") throw new HttpError(409, "geo_project_paused", "This GEO project is paused.");
    const status = project.steps[step]?.status ?? "none";
    await this.store.setStep(project.id, step, { requested: true, ...(["none", "failed"].includes(status) ? { status: "queued" } : {}) });
    await this.#allowRetries(project, step);
    const result = await this.advance(project.id);
    return this.#answer(project, result);
  }

  /**
   * 导出: an export run asked for now (`proposal` or an out-of-cycle
   * `weekly`), dispatched when the project's run slot is free.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} kind
   */
  async requestExport(user, input, kind) {
    const project = await this.#project(input.id);
    if (!project || project.userId !== String(user.id)) throw new HttpError(404, "geo_project_not_found", "GEO project not found.");
    if (project.status !== "active") throw new HttpError(409, "geo_project_paused", "This GEO project is paused.");
    const at = zonedParts(this.now(), this.timeZone);
    const stamp = `${at.date.replaceAll("-", "")}t${String(at.hour).padStart(2, "0")}${String(at.minute).padStart(2, "0")}`;
    await this.#claim(project, `run:export:${kind}:${stamp}`, "run", "pending", { detail: { purpose: "export", kind, requestedBy: String(user.id) } });
    const result = await this.advance(project.id);
    return this.#answer(project, result);
  }

  /** @param {any} project @param {any} result */
  async #answer(project, result) {
    const dispatched = result?.dispatched ?? null;
    if (dispatched?.runId) return { sessionId: dispatched.sessionId ?? null, runId: dispatched.runId };
    const sessionId = this.latestSessionId ? await this.latestSessionId({ userId: project.userId, projectId: project.projectId }).catch(() => null) : null;
    return { sessionId: sessionId ?? null, runId: null };
  }

  /** A person asking again gives the runs that serve the step two more tries. @param {any} project @param {string} step */
  async #allowRetries(project, step) {
    const keys = step === "sources" ? ["run:insight", "run:strategy"] : ["distribution", "content"].includes(step) ? ["run:insight", "run:strategy"] : ["run:insight"];
    for (const key of keys) {
      await this.store.query(`UPDATE evimed_geo.schedule_marks SET detail = detail || jsonb_build_object('allowed', attempts + $3::integer),
          state = CASE WHEN state = 'failed' THEN 'pending' ELSE state END, updated_at = now()
        WHERE geo_project_id = $1 AND key = $2 AND state IN ('failed', 'done')`, [project.id, key, GEO_RUN_RULES.attempts]);
    }
    if (step === "content") {
      await this.store.query(`UPDATE evimed_geo.schedule_marks SET detail = detail || jsonb_build_object('allowed', attempts + $2::integer),
          state = 'pending', updated_at = now()
        WHERE geo_project_id = $1 AND kind = 'run' AND starts_with(key, 'run:content:') AND state = 'failed'`, [project.id, GEO_RUN_RULES.attempts]);
    }
  }

  // --- runs ending ------------------------------------------------------------------------------

  /**
   * The run ledger's completion, for every run of the platform: a run this
   * module dispatched (`geo-…` dispatch id) is folded into its steps.
   * @param {{ userId: string, id: string }} controlProject @param {{ id: string, dispatchId?: string | null, status: string }} run
   */
  async onRunFinished(controlProject, run) {
    if (!String(run?.dispatchId ?? "").startsWith("geo-") || !TERMINAL_RUN.has(String(run.status))) return false;
    const row = (await this.store.query(`SELECT m.*, p.id AS geo_id FROM evimed_geo.schedule_marks m
      JOIN evimed_geo.projects p ON p.id = m.geo_project_id
      WHERE p.user_id = $1 AND p.project_id = $2 AND p.deleted_at IS NULL AND m.kind = 'run' AND m.dispatch_id = $3`,
    [String(controlProject.userId), String(controlProject.id), String(run.dispatchId)])).rows[0];
    if (!row || ["done", "failed"].includes(row.state)) return false;
    await this.#exclusive(row.geo_project_id, async () => {
      const project = await this.#project(row.geo_project_id);
      if (project) await this.#finishRun(project, { ...row, run_id: row.run_id ?? run.id }, String(run.status));
    });
    return true;
  }

  /** @param {any} project @param {any} mark @param {string} status */
  async #finishRun(project, mark, status) {
    const moved = await this.#update(project.id, mark.key, { state: status === "succeeded" ? "done" : "failed", detail: { runStatus: status } },
      ["claimed", "running", "pending"]);
    if (!moved) return;
    this.counters.runsFinished += 1;
    const detail = mark.detail ?? {};
    let current = (await this.#project(project.id)) ?? project;
    if (detail.purpose === "insight") {
      const [claims, journey, sets] = await Promise.all([
        this.store.query(`SELECT count(*)::integer AS n FROM evimed_geo.claims WHERE geo_project_id = $1`, [project.id]),
        this.store.latestJourney(project.id),
        this.store.questionSets(project.id),
      ]);
      for (const { step, fidelity } of /** @type {Array<{ step: string, fidelity: string }>} */ (detail.scope ?? [])) {
        if (FINISHED.has(current.steps[step]?.status)) continue;
        const reached = step === "evidence" ? Number(claims.rows[0]?.n ?? 0) > 0
          : step === "journey" ? Boolean(journey)
            : step === "questions" ? sets.some((/** @type {any} */ set) => set.lockedAt) : false;
        current = await this.#step(current, step, reached
          ? { status: fidelity === "full" ? "done" : "minimal", runId: mark.run_id ?? null }
          : { status: "failed", runId: mark.run_id ?? null });
      }
    } else if (detail.purpose === "strategy") {
      const [strategy, targets] = await Promise.all([this.store.latestStrategy(project.id), this.store.latestTargets(project.id)]);
      if (strategy && targets) {
        current = await this.#step(current, "sources", { status: current.steps.diagnosis?.status === "minimal" ? "minimal" : "done", runId: mark.run_id ?? null });
        const suggested = targets.rows.filter((row) => row.tier === current.tier && row.budgetCny != null)
          .reduce((/** @type {number | null} */ max, row) => Math.max(max ?? 0, Number(row.budgetCny)), null);
        await this.#notice(current, `notice:targets:${targets.version}`, () => this.notifier?.targetsReady(current, { version: targets.version, suggestedBudgetCny: suggested }));
      } else if (!FINISHED.has(current.steps.sources?.status)) {
        current = await this.#step(current, "sources", { status: "failed", runId: mark.run_id ?? null });
      }
    } else if (detail.purpose === "content") {
      const written = Number((await this.store.query(`SELECT count(*)::integer AS n FROM evimed_geo.articles WHERE geo_project_id = $1 AND created_at >= $2`,
        [project.id, mark.updated_at ?? mark.created_at])).rows[0]?.n ?? 0);
      await this.#update(project.id, mark.key, { detail: { articles: written } });
      if (written > 0) current = await this.#step(current, "content", { status: "done", runId: mark.run_id ?? null });
      else if (!FINISHED.has(current.steps.content?.status)) current = await this.#step(current, "content", { status: "failed", runId: mark.run_id ?? null });
      else current = await this.#step(current, "content", { status: "done" });
    }
  }

  /** Runs whose end the ledger knows but no callback told us, and claims a dead process left. @param {any} project */
  async #foldRuns(project) {
    const open = (await this.store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run'
      AND state IN ('claimed', 'running')`, [project.id])).rows;
    for (const mark of open) {
      if (mark.state === "claimed") {
        // A claim nobody finished: back to pending, with the same dispatch id.
        await this.store.query(`UPDATE evimed_geo.schedule_marks SET state = 'pending', updated_at = now()
          WHERE geo_project_id = $1 AND key = $2 AND state = 'claimed' AND updated_at < now() - make_interval(mins => $3)`,
        [project.id, mark.key, GEO_RUN_RULES.staleClaimMinutes]);
        continue;
      }
      if (!mark.run_id || !this.runStatus) continue;
      const run = await this.runStatus({ userId: project.userId, projectId: project.projectId, runId: String(mark.run_id), dispatchId: mark.dispatch_id })
        .catch(() => null);
      if (run && TERMINAL_RUN.has(String(run.status))) await this.#finishRun(project, mark, String(run.status));
    }
  }

  // --- one project, one step further -------------------------------------------------------------

  /**
   * Advance one project as far as the rules allow right now: fold ended runs,
   * send what is due, enqueue the diagnosis round, keep the platform steps
   * current, and dispatch at most one run.
   * @param {string} geoId
   * @returns {Promise<{ dispatched: { runId: string, sessionId: string | null } | null, deferred: string | null, enqueued: string[], paused?: boolean }>}
   */
  advance(geoId) {
    return this.#exclusive(geoId, async () => {
      /** @type {{ dispatched: { runId: string, sessionId: string | null } | null, deferred: string | null, enqueued: string[], paused?: boolean }} */
      const result = { dispatched: null, deferred: null, enqueued: [] };
      let project = await this.#project(geoId);
      if (!project) return result;
      await this.#foldRuns(project);
      project = (await this.#project(geoId)) ?? project;
      if (project.status !== "active") return { ...result, paused: true };
      await this.#notices(project);
      project = await this.#implicitProgram(project);
      let plan = wantedSteps(project.steps);
      project = await this.#diagnosis(project, plan, result);
      await this.#noise(project, plan, result);
      project = await this.#distribution(project, plan);
      project = await this.#monitoring(project, plan);
      plan = wantedSteps(project.steps);
      await this.#nextRun(project, plan, result);
      return result;
    });
  }

  /**
   * A conversation that locked a question set with nothing requested starts
   * the program: a full set is the full program, a minimal set a diagnosis.
   * A step a run marked `queued` is a request.
   * @param {any} project
   */
  async #implicitProgram(project) {
    let current = project;
    for (const step of GEO_STEPS) {
      if (current.steps[step].status === "queued" && !current.steps[step].requested) current = await this.#step(current, step, { requested: true });
    }
    if (GEO_STEPS.some((step) => current.steps[step].requested)) return current;
    const questions = current.steps.questions.status;
    if (questions === "done") for (const step of GEO_STEPS) current = await this.#step(current, step, { requested: true });
    else if (questions === "minimal") current = await this.#step(current, "diagnosis", { requested: true });
    return current;
  }

  /** The latest locked question set and its map, or null. @param {string} geoId */
  async #lockedSet(geoId) {
    const set = (await this.store.questionSets(geoId)).find((entry) => entry.lockedAt);
    return set ? { version: set.version, groups: await this.store.questionMap(geoId, set.version) } : null;
  }

  /**
   * Enqueue a round once per key. A stale claim first looks for the round it
   * may already have made (`ref.scheduleKey`).
   * @param {any} project @param {string} key
   * @param {{ kind: string, questionIds?: string[], engines?: string[], repeat?: number, ref?: Record<string, any> }} spec
   * @returns {Promise<string | null>} the round id, or null when not enqueued now
   */
  async #enqueueOnce(project, key, spec) {
    const existing = await this.#mark(project.id, key);
    if (existing && existing.state !== "claimed") return existing.round_id ?? null;
    if (!this.enqueueRound) return null;
    const claimed = await this.#claim(project, key, "round", "claimed", { detail: { kind: spec.kind } });
    if (!claimed) return null;
    const made = (await this.store.query(`SELECT id FROM evimed_geo.rounds WHERE geo_project_id = $1 AND ref ->> 'scheduleKey' = $2
      ORDER BY created_at LIMIT 1`, [project.id, key])).rows[0];
    if (made) {
      await this.#update(project.id, key, { state: "done", roundId: String(made.id) });
      return String(made.id);
    }
    try {
      const out = await this.enqueueRound({ geoProjectId: project.id, kind: spec.kind,
        ...(spec.questionIds ? { questionIds: spec.questionIds } : {}), ...(spec.engines ? { engines: spec.engines } : {}),
        ...(spec.repeat ? { repeat: spec.repeat } : {}), ref: { ...(spec.ref ?? {}), scheduleKey: key } });
      const roundId = typeof out === "string" ? out : String(out?.roundId ?? out?.id ?? out?.round?.id ?? "") || null;
      await this.#update(project.id, key, { state: "done", roundId });
      this.counters.roundsEnqueued += 1;
      return roundId;
    } catch (error) {
      await this.store.query(`DELETE FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = $2 AND state = 'claimed'`, [project.id, key]);
      this.lastError = codeOf(error);
      this.report(`enqueue:${this.lastError}`);
      return null;
    }
  }

  /** A mark recording a round the schedule did not ask for, and why. @param {any} project @param {string} key @param {string} reason */
  async #skip(project, key, reason) {
    const row = await this.#claim(project, key, "round", "skipped", { detail: { reason } });
    if (row) this.counters.roundsSkipped += 1;
  }

  /**
   * Step 4: once the questions are locked, the measurement round (baseline
   * for a full set, single-step for a minimal one); the step is done when
   * the round finished and its metrics are in (or half an hour after).
   * @param {any} project @param {ReturnType<typeof wantedSteps>} plan @param {{ enqueued: string[] }} result
   */
  async #diagnosis(project, plan, result) {
    if (!plan.want.has("diagnosis")) return project;
    const questions = project.steps.questions.status;
    if (!FINISHED.has(questions)) return project;
    const step = project.steps.diagnosis;
    if (step.status === "running" && step.roundId) {
      const round = (await this.store.query(`SELECT r.*, (r.finished_at < now() - make_interval(mins => $2)) AS settled,
          EXISTS (SELECT 1 FROM evimed_geo.metrics m WHERE m.round_id = r.id) AS measured
        FROM evimed_geo.rounds r WHERE r.id = $1`, [step.roundId, GEO_SCHEDULE.metricsGraceMinutes])).rows[0];
      if (!round) return this.#step(project, "diagnosis", { status: "queued", roundId: null });
      if (round.status === "cancelled") return this.#step(project, "diagnosis", { status: "failed" });
      if (!["done", "partial"].includes(round.status) || !(round.measured || round.settled)) return project;
      const current = await this.#step(project, "diagnosis", { status: questions === "minimal" ? "minimal" : "done", roundId: String(round.id) });
      const wrong = Number((await this.store.query(`SELECT count(*)::integer AS n FROM evimed_geo.errors WHERE geo_project_id = $1 AND status <> 'closed'`,
        [project.id])).rows[0]?.n ?? 0);
      const engines = Array.isArray(round.engines) && round.engines.length ? round.engines.length : project.engines.length;
      await this.#notice(current, `notice:diagnosis:${round.id}`,
        () => this.notifier?.diagnosisDone(current, { roundId: String(round.id), engines, answers: Number(round.done ?? 0), wrongOurs: wrong }));
      return current;
    }
    const upgrade = step.status === "minimal" && questions === "done" && plan.requested.has("diagnosis");
    if ((FINISHED.has(step.status) && !upgrade) || step.status === "failed") return project;
    const set = await this.#lockedSet(project.id);
    if (!set) return project;
    // A round that was cancelled does not answer a new request: the next key.
    const prior = await this.#marksWith(project.id, `round:diagnosis:v${set.version}`);
    const last = prior.at(-1) ?? null;
    const lastRound = last?.round_id ? (await this.store.query(`SELECT status FROM evimed_geo.rounds WHERE id = $1`, [last.round_id])).rows[0] : null;
    const key = !last || (lastRound?.status !== "cancelled" && last.state !== "skipped") ? (last?.key ?? `round:diagnosis:v${set.version}`)
      : `round:diagnosis:v${set.version}:r${prior.length + 1}`;
    if (!this.enqueueRound) return this.#step(project, "diagnosis", { status: "queued" });
    const roundId = await this.#enqueueOnce(project, key, { kind: questions === "minimal" ? "single_step" : "baseline", engines: project.engines,
      ref: { step: "diagnosis", setVersion: set.version } });
    if (!roundId) return this.#step(project, "diagnosis", { status: "queued" });
    result.enqueued.push(key);
    return this.#step(project, "diagnosis", { status: "running", roundId });
  }

  /** The noise round, once per full-program project after its baseline. @param {any} project @param {ReturnType<typeof wantedSteps>} plan @param {{ enqueued: string[] }} result */
  async #noise(project, plan, result) {
    if (!plan.full || project.steps.questions.status !== "done" || project.steps.diagnosis.status !== "done" || !this.enqueueRound) return;
    if (await this.#mark(project.id, "round:noise")) return;
    const set = await this.#lockedSet(project.id);
    if (!set) return;
    const questionIds = topQuestions(set.groups, GEO_SCHEDULE.noiseQuestions);
    if (!questionIds.length) return;
    const roundId = await this.#enqueueOnce(project, "round:noise", { kind: "noise", questionIds, engines: project.engines,
      repeat: GEO_SCHEDULE.noiseRepeat, ref: { reason: "noise" } });
    if (roundId) result.enqueued.push("round:noise");
  }

  /** Step 7 is the market's: running while orders are out, done once one is published. @param {any} project @param {ReturnType<typeof wantedSteps>} plan */
  async #distribution(project, plan) {
    if (!plan.want.has("distribution")) return project;
    const row = (await this.store.query(`SELECT count(*) FILTER (WHERE state IN ('published', 'verified', 'settled'))::integer AS published,
        count(*) FILTER (WHERE state IN ('planned', 'reserved', 'submitted', 'accepted', 'unknown'))::integer AS open
      FROM evimed_geo.orders WHERE geo_project_id = $1`, [project.id])).rows[0] ?? {};
    if (Number(row.published) > 0) return this.#step(project, "distribution", { status: "done" });
    if (Number(row.open) > 0) return this.#step(project, "distribution", { status: "running" });
    return project;
  }

  /** Step 8 is the schedule's: armed once the diagnosis is in, done with its first weekly round. @param {any} project @param {ReturnType<typeof wantedSteps>} plan */
  async #monitoring(project, plan) {
    if (!plan.want.has("monitoring") || !FINISHED.has(project.steps.diagnosis.status)) return project;
    const weeks = Number((await this.store.query(`SELECT count(*)::integer AS n FROM evimed_geo.rounds WHERE geo_project_id = $1 AND kind = 'weekly'
      AND status IN ('done', 'partial')`, [project.id])).rows[0]?.n ?? 0);
    return this.#step(project, "monitoring", weeks > 0 ? { status: "done", note: `第 ${weeks} 周` } : { status: "running" });
  }

  // --- the one run -----------------------------------------------------------------------------------

  /** @param {any} project @param {ReturnType<typeof wantedSteps>} plan @param {{ dispatched: any, deferred: string | null }} result */
  async #nextRun(project, plan, result) {
    if (!this.dispatchRun) return;
    const active = (await this.store.query(`SELECT 1 FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run'
      AND state IN ('claimed', 'running') LIMIT 1`, [project.id])).rows.length > 0;
    if (active) return;
    const candidates = [
      () => this.#pendingExport(project),
      () => this.#insightRun(project, plan),
      () => this.#strategyRun(project, plan),
      () => this.#weeklyExport(project, plan),
      () => this.#contentRun(project, plan),
    ];
    for (const candidate of candidates) {
      const spec = await candidate();
      if (!spec) continue;
      const outcome = await this.#dispatch(project, spec);
      if (outcome.dispatched) result.dispatched = outcome.dispatched;
      if (outcome.deferred) result.deferred = outcome.deferred;
      // A run was attempted (or the slot is taken): one per tick.
      if (outcome.dispatched || outcome.deferred || outcome.busy) return;
    }
  }

  /**
   * @typedef {{ key: string, purpose: "insight" | "strategy" | "content" | "export", capabilityId: string, reason: string,
   *   brief: string, steps: string[], detail?: Record<string, any> }} RunSpec
   */

  /** Whether a run key may be tried again. @param {any} mark */
  #allowed(mark) {
    if (!mark) return true;
    if (["claimed", "running"].includes(mark.state)) return false;
    return Number(mark.attempts ?? 0) < Number(mark.detail?.allowed ?? GEO_RUN_RULES.attempts);
  }

  /** @param {any} project @returns {Promise<RunSpec | null>} */
  async #pendingExport(project) {
    const mark = (await this.store.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run'
      AND starts_with(key, 'run:export:') AND state = 'pending' ORDER BY created_at LIMIT 1`, [project.id])).rows[0];
    if (!mark || !this.#allowed(mark)) return null;
    const kind = String(mark.detail?.kind ?? "proposal");
    return { key: mark.key, purpose: "export", capabilityId: GEO_RUN_CAPABILITIES.export, reason: `geo:export-${kind}`,
      brief: exportBrief(project, { kind, week: mark.detail?.week ?? null }), steps: [], detail: { kind } };
  }

  /** Steps 1–3 in one `geo-insight` run. @param {any} project @param {ReturnType<typeof wantedSteps>} plan @returns {Promise<RunSpec | null>} */
  async #insightRun(project, plan) {
    const scope = INSIGHT_STEPS.filter((step) => {
      if (!plan.want.has(step)) return false;
      const status = project.steps[step].status;
      if (["none", "queued", "failed"].includes(status)) return true;
      // A minimal version the user now asks for in full is redone.
      return status === "minimal" && plan.requested.has(step);
    }).map((step) => ({ step, fidelity: plan.fidelity(step) }));
    if (!scope.length) return null;
    const mark = await this.#mark(project.id, "run:insight");
    if (!this.#allowed(mark)) return null;
    const target = [...plan.requested].find((step) => !INSIGHT_STEPS.includes(step)) ?? [...plan.requested][0] ?? null;
    return { key: "run:insight", purpose: "insight", capabilityId: GEO_RUN_CAPABILITIES.insight, reason: `geo:${scope[0].step}`,
      brief: insightBrief(project, { scope, target, full: plan.full }), steps: scope.map((entry) => entry.step), detail: { scope, target, full: plan.full } };
  }

  /** Step 5 in one `geo-strategy` run, once the diagnosis is in. @param {any} project @param {ReturnType<typeof wantedSteps>} plan @returns {Promise<RunSpec | null>} */
  async #strategyRun(project, plan) {
    if (!plan.want.has("sources") || !FINISHED.has(project.steps.diagnosis.status)) return null;
    const status = project.steps.sources.status;
    const upgrade = status === "minimal" && project.steps.diagnosis.status === "done" && plan.requested.has("sources");
    if (!["none", "queued", "failed"].includes(status) && !upgrade) return null;
    const mark = await this.#mark(project.id, "run:strategy");
    if (!this.#allowed(mark)) return null;
    const minimal = project.steps.diagnosis.status === "minimal";
    return { key: "run:strategy", purpose: "strategy", capabilityId: GEO_RUN_CAPABILITIES.strategy, reason: "geo:sources",
      brief: strategyBrief(project, { minimal }), steps: ["sources"], detail: { minimal } };
  }

  /**
   * The latest weekly round whose numbers are in, when it has no export yet:
   * the weekly report run.
   * @param {any} project @param {ReturnType<typeof wantedSteps>} plan @returns {Promise<RunSpec | null>}
   */
  async #weeklyExport(project, plan) {
    const week = await this.#latestMeasuredWeek(project, plan);
    if (!week) return null;
    const key = `run:export:weekly:${week.monday}`;
    const mark = await this.#mark(project.id, key);
    if (mark && (FINISHED.has(mark.state) || mark.state === "failed" || !this.#allowed(mark))) return null;
    return { key, purpose: "export", capabilityId: GEO_RUN_CAPABILITIES.export, reason: "geo:export-weekly",
      brief: exportBrief(project, { kind: "weekly", week: week.monday }), steps: [], detail: { kind: "weekly", week: week.monday } };
  }

  /** @param {any} project @param {ReturnType<typeof wantedSteps>} plan */
  async #latestMeasuredWeek(project, plan) {
    if (!plan.want.has("monitoring")) return null;
    const row = (await this.store.query(`SELECT m.key, m.round_id FROM evimed_geo.schedule_marks m JOIN evimed_geo.rounds r ON r.id = m.round_id
      WHERE m.geo_project_id = $1 AND starts_with(m.key, 'weekly:') AND m.state = 'done' AND r.status IN ('done', 'partial')
        AND (EXISTS (SELECT 1 FROM evimed_geo.metrics x WHERE x.round_id = r.id) OR r.finished_at < now() - make_interval(mins => $2))
      ORDER BY m.key DESC LIMIT 1`, [project.id, GEO_SCHEDULE.metricsGraceMinutes])).rows[0];
    return row ? { monday: String(row.key).slice("weekly:".length), roundId: String(row.round_id) } : null;
  }

  /**
   * Step 6 in batches of at most five: the first batches cover the
   * battlefield (then corrections for open 讲错我方); after each weekly report
   * the next round covers what the re-measure says is still short.
   * @param {any} project @param {ReturnType<typeof wantedSteps>} plan @returns {Promise<RunSpec | null>}
   */
  async #contentRun(project, plan) {
    if (!plan.want.has("content") || !FINISHED.has(project.steps.evidence.status)) return null;
    if (plan.full && !FINISHED.has(project.steps.sources.status)) return null;
    const marks = await this.#marksWith(project.id, "run:content:");
    const numbered = marks.filter((mark) => /^run:content:\d+$/.test(mark.key)).sort((a, b) => Number(a.key.split(":")[2]) - Number(b.key.split(":")[2]));
    const last = numbered.at(-1) ?? null;
    if (last && !FINISHED.has(last.state) && last.state !== "skipped") {
      // The latest first-round batch has not come through: try it again while it may.
      if (last.state === "failed" || last.state === "pending") {
        if (!this.#allowed(last)) return null;
        return this.#contentSpec(project, last.key, Number(last.key.split(":")[2]), last.detail ?? {}, "first");
      }
      return null;
    }
    const assigned = new Set(marks.flatMap((mark) => (Array.isArray(mark.detail?.errorIds) ? mark.detail.errorIds : [])));
    // The first round: until the battlefield is covered (full program), or one batch (a single step).
    const firstRoundOpen = plan.full ? numbered.length < GEO_RUN_RULES.firstBatchesMax : numbered.length === 0;
    if (firstRoundOpen) {
      const batch = await this.#firstBatch(project, assigned, numbered.length === 0);
      if (batch) return this.#contentSpec(project, `run:content:${numbered.length + 1}`, numbered.length + 1, batch, plan.full ? "first" : "single");
    }
    // The next round, after this week's report.
    const week = await this.#latestMeasuredWeek(project, plan);
    if (!week) return null;
    const exported = await this.#mark(project.id, `run:export:weekly:${week.monday}`);
    if (!exported || !["done", "failed"].includes(exported.state)) return null;
    const key = `run:content:w${week.monday}`;
    const mark = await this.#mark(project.id, key);
    if (mark && (mark.state === "skipped" || FINISHED.has(mark.state) || !this.#allowed(mark))) return null;
    const batch = mark?.detail?.groups ? mark.detail : await this.#nextRoundBatch(project, week, assigned);
    if (!batch.groups.length && !batch.errors.length) {
      await this.#claim(project, key, "run", "skipped", { detail: { purpose: "content", reason: batch.reason ?? "nothing_short" } });
      return null;
    }
    return this.#contentSpec(project, key, `第 ${week.monday} 周之后的一批`, batch, "next");
  }

  /**
   * @param {any} project @param {string} key @param {number | string} number
   * @param {{ groups: any[], errors: any[], errorIds?: string[] }} batch @param {"first" | "next" | "single"} reason
   * @returns {RunSpec}
   */
  #contentSpec(project, key, number, batch, reason) {
    const size = Math.max(1, Math.min(GEO_RUN_RULES.batchMax, batch.groups.length + batch.errors.length || GEO_RUN_RULES.batchMax));
    return { key, purpose: "content", capabilityId: GEO_RUN_CAPABILITIES.content, reason: "geo:content",
      brief: contentBrief(project, { number, groups: batch.groups, errors: batch.errors, reason, size }), steps: ["content"],
      detail: { groups: batch.groups, errors: batch.errors, errorIds: batch.errors.map((error) => error.id), reason } };
  }

  /** The groups of the project by id (every set version) and the covered names. @param {any} project */
  async #coverage(project) {
    const groups = (await this.store.query(`SELECT id, name, pool, typical_question, is_control, weight FROM evimed_geo.question_groups
      WHERE geo_project_id = $1`, [project.id])).rows;
    const byId = new Map(groups.map((/** @type {any} */ row) => [String(row.id), row]));
    const covered = new Set();
    for (const article of await this.store.listArticles(project.id)) {
      if (article.status === "withdrawn" || !article.groupId) continue;
      const group = byId.get(article.groupId);
      if (group?.name) covered.add(String(group.name));
      covered.add(article.groupId);
    }
    return { byId, covered };
  }

  /**
   * The next first-round batch: uncovered battlefield groups (no control
   * group), then corrections for open 讲错我方 not yet given to a batch.
   * Without a battlefield (a single step), the heaviest uncovered measured groups.
   * @param {any} project @param {Set<string>} assigned @param {boolean} first
   */
  async #firstBatch(project, assigned, first) {
    const [set, strategy, coverage] = await Promise.all([this.#lockedSet(project.id), this.store.latestStrategy(project.id), this.#coverage(project)]);
    const groups = (set?.groups ?? []).filter((group) => !group.isControl);
    const battlefield = Array.isArray(strategy?.battlefield?.groups) ? strategy.battlefield.groups.map(String) : [];
    const resolved = battlefield.length
      ? battlefield.map((entry) => groups.find((group) => group.id === entry || group.name === entry)).filter(Boolean)
      : [...groups].sort((left, right) => Number(right.weight ?? 0) - Number(left.weight ?? 0));
    const chosen = [];
    for (const group of resolved) {
      if (!group || coverage.covered.has(group.id) || (group.name && coverage.covered.has(group.name))) continue;
      if (chosen.some((entry) => entry.id === group.id)) continue;
      chosen.push({ id: group.id, name: group.name, pool: group.pool, typicalQuestion: group.typicalQuestion });
      if (chosen.length >= GEO_RUN_RULES.batchMax) break;
    }
    const errors = chosen.length < GEO_RUN_RULES.batchMax ? await this.#openErrors(project, assigned, GEO_RUN_RULES.batchMax - chosen.length) : [];
    if (!chosen.length && !errors.length) return first ? { groups: [], errors: [] } : null;
    return { groups: chosen, errors };
  }

  /** Open 讲错我方 not yet in any batch, most severe first. @param {any} project @param {Set<string>} assigned @param {number} limit @param {string | null} [roundId] */
  async #openErrors(project, assigned, limit, roundId = null) {
    const rows = (await this.store.query(`SELECT e.id, e.engine, e.statement FROM evimed_geo.errors e
      WHERE e.geo_project_id = $1 AND e.status IN ('open', 'acting')
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM evimed_geo.snapshots s WHERE s.id = e.last_snapshot_id AND s.round_id = $2))
      ORDER BY e.severity DESC NULLS LAST, e.created_at LIMIT 100`, [project.id, roundId])).rows;
    return rows.filter((/** @type {any} */ row) => roundId || !assigned.has(String(row.id))).slice(0, limit)
      .map((/** @type {any} */ row) => ({ id: String(row.id), engine: String(row.engine), statement: row.statement ?? null }));
  }

  /**
   * The next round after a weekly re-measure (plan §3.8): groups still short
   * of the chosen tier's target, groups whose placed article was never cited
   * after eight weeks, and 讲错我方 the re-measure saw again — within budget.
   * @param {any} project @param {{ monday: string, roundId: string }} week @param {Set<string>} assigned
   */
  async #nextRoundBatch(project, week, assigned) {
    const [set, targets, money] = await Promise.all([this.#lockedSet(project.id), this.store.latestTargets(project.id), this.#available(project)]);
    const groups = (set?.groups ?? []).filter((group) => !group.isControl);
    /** @type {any[]} */
    const chosen = [];
    const add = (/** @type {any} */ group) => {
      if (!group || chosen.length >= GEO_RUN_RULES.batchMax || chosen.some((entry) => entry.id === group.id)) return;
      chosen.push({ id: group.id, name: group.name, pool: group.pool, typicalQuestion: group.typicalQuestion });
    };
    const room = money.available == null ? 0 : money.perArticle ? Math.floor(money.available / money.perArticle) : money.available > 0 ? GEO_RUN_RULES.batchMax : 0;
    if (room > 0) {
      const tier = project.tier;
      const target = (/** @type {string | null} */ pool) => {
        const rows = targets?.rows.filter((row) => row.tier === tier && ["M-01", "M-01S"].includes(row.metricId)) ?? [];
        return (rows.find((row) => row.pool === pool) ?? rows.find((row) => row.pool === "all"))?.target ?? null;
      };
      const measured = (await this.store.query(`SELECT DISTINCT ON (coalesce(group_id, ''), coalesce(pool, '')) group_id, pool, value, status
        FROM evimed_geo.metrics WHERE geo_project_id = $1 AND round_id = $2 AND metric_id = 'M-01' AND scope IN ('group', 'pool')
          AND variant IS NULL AND rival IS NULL AND arm IS NULL AND engine IS NULL
        ORDER BY coalesce(group_id, ''), coalesce(pool, ''), computed_at DESC`, [project.id, week.roundId])).rows;
      for (const group of groups) {
        const goal = target(group.pool);
        if (goal == null) continue;
        const own = measured.find((/** @type {any} */ row) => row.group_id === group.id && row.status === "ok")
          ?? measured.find((/** @type {any} */ row) => row.group_id == null && row.pool === group.pool && row.status === "ok");
        if (own && Number(own.value) < Number(goal)) add(group);
      }
      const stale = (await this.store.query(`SELECT DISTINCT a.group_id FROM evimed_geo.orders o JOIN evimed_geo.articles a ON a.id = o.article_id
        WHERE o.geo_project_id = $1 AND o.state IN ('published', 'verified', 'settled') AND a.group_id IS NOT NULL
          AND o.updated_at < now() - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.detail ->> 'phase' = 'cited')`,
      [project.id, GEO_SCHEDULE.stalePlacementWeeks * 7])).rows;
      const byId = new Map((await this.#coverage(project)).byId);
      for (const row of stale) {
        const old = byId.get(String(row.group_id));
        add(groups.find((group) => group.id === row.group_id || (old?.name && group.name === old.name)));
      }
      chosen.splice(Math.min(room, GEO_RUN_RULES.batchMax));
    }
    const errors = await this.#openErrors(project, assigned, GEO_RUN_RULES.batchMax - chosen.length, week.roundId);
    const reason = !chosen.length && !errors.length ? (money.available == null ? "no_budget" : room <= 0 ? "budget_spent" : "nothing_short") : null;
    return { groups: chosen, errors, reason };
  }

  /**
   * What the project may still spend on placements: budget − reserved −
   * settled + refunded (the market's identity), and one article's price by
   * the chosen tier's budget over its placements. `available` null = no budget.
   * @param {any} project
   */
  async #available(project) {
    const budget = Number(project.budget?.totalCny);
    if (!project.budget || !Number.isFinite(budget)) return { available: null, perArticle: null };
    const sums = new Map((await this.store.query(`SELECT kind, coalesce(sum(amount_cny), 0)::float8 AS total FROM evimed_geo.ledger
      WHERE geo_project_id = $1 GROUP BY kind`, [project.id])).rows.map((/** @type {any} */ row) => [String(row.kind), Number(row.total)]));
    const reserved = (sums.get("reserve") ?? 0) - (sums.get("release") ?? 0) - (sums.get("settle") ?? 0);
    const available = budget - reserved - (sums.get("settle") ?? 0) + (sums.get("refund") ?? 0);
    const tier = (await this.store.latestTargets(project.id))?.rows.filter((row) => row.tier === project.tier) ?? [];
    const spend = tier.reduce((max, row) => Math.max(max, Number(row.budgetCny ?? 0)), 0);
    const placements = tier.reduce((max, row) => Math.max(max, Number(row.placements ?? 0)), 0);
    return { available, perArticle: spend > 0 && placements > 0 ? spend / placements : null };
  }

  /**
   * Claim the run slot and the key, dispatch, record. A refusal that waiting
   * can clear leaves the key pending (the next tick tries again, with the same
   * dispatch id); one that cannot fails the steps it would have served.
   * @param {any} project @param {RunSpec} spec
   */
  async #dispatch(project, spec) {
    const claim = await this.store.transaction(async (/** @type {any} */ client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('evimed-geo-run:' || $1))`, [project.id]);
      const active = await client.query(`SELECT key FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2))) LIMIT 1`, [project.id, GEO_RUN_RULES.staleClaimMinutes]);
      if (active.rows.length) return { busy: true };
      const existing = (await client.query(`SELECT * FROM evimed_geo.schedule_marks WHERE geo_project_id = $1 AND key = $2 FOR UPDATE`,
        [project.id, spec.key])).rows[0];
      if (existing && !this.#allowed(existing)) return { busy: true };
      const attempts = Number(existing?.attempts ?? 0);
      const reuse = existing && ["pending", "claimed"].includes(existing.state) && existing.dispatch_id;
      const dispatchId = reuse ? String(existing.dispatch_id) : dispatchIdFor(spec.key, attempts + 1);
      const detail = { ...(spec.detail ?? {}), purpose: spec.purpose, capabilityId: spec.capabilityId };
      const row = (await client.query(`INSERT INTO evimed_geo.schedule_marks (geo_project_id, key, user_id, kind, state, dispatch_id, detail)
        VALUES ($1, $2, $3, 'run', 'claimed', $4, $5::jsonb)
        ON CONFLICT (geo_project_id, key) DO UPDATE SET state = 'claimed', dispatch_id = EXCLUDED.dispatch_id,
          detail = schedule_marks.detail || EXCLUDED.detail, run_id = NULL, session_id = NULL, done_at = NULL, updated_at = now()
        RETURNING *`, [project.id, spec.key, project.userId, dispatchId, JSON.stringify(detail)])).rows[0];
      return { mark: row };
    });
    if (claim.busy) return { busy: true };
    const mark = claim.mark;
    let current = project;
    for (const step of spec.steps) {
      if (!["running"].includes(current.steps[step]?.status)) current = await this.#step(current, step, { status: "queued" });
    }
    try {
      const out = await /** @type {NonNullable<GeoOrchestrator["dispatchRun"]>} */ (this.dispatchRun)({
        userId: project.userId, projectId: project.projectId, geoProjectId: project.id, capabilityId: spec.capabilityId,
        dispatchId: String(mark.dispatch_id), reason: spec.reason, brief: spec.brief,
      });
      const running = await this.#update(project.id, spec.key, { state: "running", runId: String(out.runId), sessionId: out.sessionId ?? null,
        attempts: Number(mark.attempts ?? 0) + 1 }, ["claimed"]);
      for (const step of spec.steps) current = await this.#step(current, step, { status: "running", runId: String(out.runId) });
      this.counters.dispatched += 1;
      // The ledger answered with a run that had already ended (a replayed dispatch id).
      if (running && out.status && TERMINAL_RUN.has(String(out.status))) await this.#finishRun(current, running, String(out.status));
      return { dispatched: { runId: String(out.runId), sessionId: out.sessionId ?? null } };
    } catch (error) {
      const code = codeOf(error);
      if (TERMINAL_DISPATCH.has(code)) {
        await this.#update(project.id, spec.key, { state: "failed", detail: { lastError: code } }, ["claimed"]);
        for (const step of spec.steps) current = await this.#step(current, step, { status: "failed" });
        this.counters.dispatchFailed += 1;
        this.lastError = code;
        return { failed: code };
      }
      await this.#update(project.id, spec.key, { state: "pending", detail: { lastError: code } }, ["claimed"]);
      this.counters.deferred += 1;
      this.lastDeferral = code;
      return { deferred: code };
    }
  }

  // --- the notices -------------------------------------------------------------------------------------

  /**
   * Send a notice once per key: the mark is written only when the inbox took
   * it (or had it already), so an inbox that was down is tried again.
   * @param {any} project @param {string} key @param {() => Promise<any> | undefined} send
   */
  async #notice(project, key, send) {
    if (!this.notifier || (await this.#mark(project.id, key))) return false;
    const sent = await send();
    if (!sent) return false;
    await this.#claim(project, key, "notice", "done");
    this.counters.notices += 1;
    return true;
  }

  /** 讲错我方, articles held for safety, the first publishable article, the first citation. @param {any} project */
  async #notices(project) {
    if (!this.notifier) return;
    const errors = (await this.store.query(`SELECT e.* FROM evimed_geo.errors e WHERE e.geo_project_id = $1 AND e.status <> 'closed'
        AND e.created_at >= now() - make_interval(days => $2)
        AND NOT EXISTS (SELECT 1 FROM evimed_geo.schedule_marks m WHERE m.geo_project_id = e.geo_project_id AND m.key = 'notice:error:' || e.id)
      ORDER BY e.severity DESC NULLS LAST, e.created_at LIMIT $3`, [project.id, GEO_RUN_RULES.noticeScanDays, GEO_RUN_RULES.noticesPerTick])).rows;
    for (const error of errors) await this.#notice(project, `notice:error:${error.id}`, () => this.notifier?.wrongOurs(project, error));
    const held = (await this.store.query(`SELECT a.id, a.title FROM evimed_geo.articles a WHERE a.geo_project_id = $1 AND a.safety = 'open'
        AND a.status <> 'withdrawn'
        AND NOT EXISTS (SELECT 1 FROM evimed_geo.schedule_marks m WHERE m.geo_project_id = a.geo_project_id AND m.key = 'notice:article-safety:' || a.id)
      ORDER BY a.created_at LIMIT $2`, [project.id, GEO_RUN_RULES.noticesPerTick])).rows;
    for (const article of held) {
      await this.#notice(project, `notice:article-safety:${article.id}`, () => this.notifier?.articleSafety(project, { id: String(article.id), title: article.title }));
    }
    if (!(await this.#mark(project.id, "notice:first-publishable"))) {
      const ready = Number((await this.store.query(`SELECT count(*)::integer AS n FROM evimed_geo.articles WHERE geo_project_id = $1
        AND status IN ('publishable', 'placed', 'published')`, [project.id])).rows[0]?.n ?? 0);
      if (ready > 0) {
        await this.#notice(project, "notice:first-publishable", () => this.notifier?.firstPublishable(project, { count: ready, budgetSet: Boolean(project.budget) }));
      }
    }
    await this.#citations(project);
  }

  /**
   * Published articles cited by an engine: each (order, engine) is told to
   * the market once (its outlet-by-engine learning), and the project's first
   * is 「第一次被 AI 引用」. Only snapshots newer than the last scan are read.
   * @param {any} project
   */
  async #citations(project) {
    const orders = (await this.store.query(`SELECT o.id, o.article_id, o.published_url, a.title,
        (SELECT min(e.at) FROM evimed_geo.order_events e WHERE e.order_id = o.id AND e.to_state = 'published') AS published_at
      FROM evimed_geo.orders o LEFT JOIN evimed_geo.articles a ON a.id = o.article_id
      WHERE o.geo_project_id = $1 AND o.published_url IS NOT NULL AND o.state IN ('published', 'verified', 'settled', 'problem')`, [project.id])).rows;
    if (!orders.length) return;
    const scan = await this.#mark(project.id, "scan:citations");
    const since = scan?.detail?.until ?? null;
    const snapshots = (await this.store.query(`SELECT id, engine, asked_at, created_at, citations FROM evimed_geo.snapshots
      WHERE geo_project_id = $1 AND jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0
        AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
      ORDER BY created_at LIMIT 2000`, [project.id, since])).rows;
    if (!snapshots.length) return;
    const byUrl = new Map(orders.map((/** @type {any} */ order) => [canonicalGeoUrl(order.published_url), order]));
    /** @type {Array<{ order: any, engine: string, at: string }>} */
    const hits = [];
    for (const snapshot of snapshots) {
      for (const citation of Array.isArray(snapshot.citations) ? snapshot.citations : []) {
        const order = byUrl.get(canonicalGeoUrl(citation?.url ?? ""));
        if (order && !hits.some((hit) => hit.order.id === order.id && hit.engine === snapshot.engine)) {
          hits.push({ order, engine: String(snapshot.engine), at: String(snapshot.asked_at ?? snapshot.created_at) });
        }
      }
    }
    for (const hit of hits) {
      const key = `cite:${hit.order.id}:${hit.engine}`;
      if (await this.#mark(project.id, key)) continue;
      if (this.noteCitation) await this.noteCitation({ orderId: String(hit.order.id), engine: hit.engine }).catch(() => null);
      await this.#claim(project, key, "notice", "done", { detail: { at: hit.at } });
    }
    if (hits.length) {
      const first = [...hits].sort((left, right) => left.at.localeCompare(right.at))[0];
      await this.#notice(project, "notice:first-cited", () => this.notifier?.firstCited(project, { engine: first.engine, title: first.order.title ?? null }));
    }
    const until = snapshots.at(-1).created_at;
    const row = await this.#claim(project, "scan:citations", "notice", "done", { detail: { until } });
    if (!row) await this.#update(project.id, "scan:citations", { detail: { until } });
  }

  // --- the loops --------------------------------------------------------------------------------------

  /** Every project with something that may move: active ones advance; paused ones only fold their runs. */
  async tick() {
    this.counters.ticks += 1;
    this.lastTickAt = this.now().toISOString();
    const rows = (await this.store.query(`SELECT id, status FROM evimed_geo.projects WHERE deleted_at IS NULL AND status IN ('active', 'paused')
      ORDER BY updated_at LIMIT $1`, [GEO_RUN_RULES.projectsPerTick])).rows;
    let advanced = 0;
    for (const row of rows) {
      try {
        await this.advance(String(row.id));
        advanced += 1;
      } catch (error) {
        this.counters.projectErrors += 1;
        this.lastError = codeOf(error);
        this.report(`project:${this.lastError}`);
      }
    }
    return { projects: rows.length, advanced, dispatched: this.counters.dispatched, deferred: this.counters.deferred };
  }

  /** The re-measurement schedules of every active project. */
  async tickSchedules() {
    this.counters.scheduleTicks += 1;
    const rows = (await this.store.query(`SELECT * FROM evimed_geo.projects WHERE deleted_at IS NULL AND status = 'active'
      ORDER BY created_at LIMIT $1`, [GEO_RUN_RULES.projectsPerTick])).rows;
    const counts = { projects: rows.length, weekly: 0, sentinel: 0, postPublication: 0, skipped: 0 };
    for (const row of rows) {
      try {
        const done = await this.#exclusive(String(row.id), () => this.#schedule(geoProjectFromRow(row)));
        counts.weekly += done.weekly;
        counts.sentinel += done.sentinel;
        counts.postPublication += done.postPublication;
        counts.skipped += done.skipped;
      } catch (error) {
        this.counters.projectErrors += 1;
        this.lastError = codeOf(error);
        this.report(`schedule:${this.lastError}`);
      }
    }
    return counts;
  }

  /** @param {any} project */
  async #schedule(project) {
    const counts = { weekly: 0, sentinel: 0, postPublication: 0, skipped: 0 };
    if (!this.enqueueRound) return counts;
    const now = this.now();
    const plan = wantedSteps(project.steps);
    const baseline = (await this.store.query(`SELECT id, finished_at FROM evimed_geo.rounds WHERE geo_project_id = $1
      AND kind IN ('baseline', 'single_step') AND status IN ('done', 'partial') ORDER BY finished_at LIMIT 1`, [project.id])).rows[0];
    if (plan.want.has("monitoring") && baseline && FINISHED.has(project.steps.diagnosis.status)) {
      const slot = weeklySlot(now, this.timeZone);
      const weeklyKey = `weekly:${slot.monday}`;
      if (slot.due && !(await this.#mark(project.id, weeklyKey))) {
        const finished = baseline.finished_at ? new Date(baseline.finished_at).getTime() : 0;
        if (finished > slot.dueAt.getTime() - GEO_SCHEDULE.baselineRestDays * DAY_MS) {
          await this.#skip(project, weeklyKey, "baseline_recent");
          counts.skipped += 1;
        } else if (await this.#enqueueOnce(project, weeklyKey, { kind: "weekly", engines: project.engines, ref: { week: slot.monday } })) {
          counts.weekly += 1;
        }
      }
      const sentinel = sentinelSlot(now, this.timeZone);
      const sentinelKey = `sentinel:${sentinel.day}`;
      if (sentinel.due && !(await this.#mark(project.id, sentinelKey))) {
        const set = await this.#lockedSet(project.id);
        const questionIds = topQuestions(set?.groups ?? [], GEO_SCHEDULE.sentinelQuestions);
        const retrieval = (await this.store.query(`SELECT DISTINCT ON (engine) engine, value, denominator, status FROM evimed_geo.metrics
          WHERE geo_project_id = $1 AND scope = 'engine' AND metric_id = 'M-10' AND pool IS NULL AND variant IS NULL AND rival IS NULL
            AND group_id IS NULL AND arm IS NULL ORDER BY engine, computed_at DESC`, [project.id])).rows
          .map((/** @type {any} */ row) => ({ engine: String(row.engine), value: row.value == null ? null : Number(row.value),
            denominator: row.denominator == null ? null : Number(row.denominator), status: String(row.status) }));
        const engines = sentinelEngines(retrieval, project.engines.filter((/** @type {string} */ engine) => !(this.config.geoInclusionEngines ?? []).includes(engine)));
        if (!questionIds.length || !engines.length) {
          await this.#skip(project, sentinelKey, "no_questions");
          counts.skipped += 1;
        } else if (await this.#enqueueOnce(project, sentinelKey, { kind: "sentinel", questionIds, engines, ref: { day: sentinel.day } })) {
          counts.sentinel += 1;
        }
      }
    }
    // Every published article, whatever else the project asked for.
    const published = (await this.store.query(`SELECT a.id AS article_id, a.group_id, min(e.at) AS published_at, min(o.id) AS order_id
      FROM evimed_geo.orders o JOIN evimed_geo.articles a ON a.id = o.article_id
        JOIN evimed_geo.order_events e ON e.order_id = o.id AND e.to_state = 'published'
      WHERE o.geo_project_id = $1 AND o.state IN ('published', 'verified', 'settled', 'problem')
      GROUP BY a.id, a.group_id`, [project.id])).rows;
    if (published.length) {
      const done = new Set((await this.#marksWith(project.id, "postpub:")).map((mark) => String(mark.key)));
      for (const article of published) {
        for (const checkpoint of postPublicationCheckpoints(new Date(article.published_at), now)) {
          const key = `postpub:${article.article_id}:w${checkpoint.week}`;
          if (!checkpoint.due || done.has(key)) continue;
          if (checkpoint.missed) { await this.#skip(project, key, "missed"); counts.skipped += 1; continue; }
          const questionIds = article.group_id ? (await this.store.query(`SELECT id FROM evimed_geo.questions WHERE geo_project_id = $1
            AND group_id = $2 AND retired_at IS NULL ORDER BY is_measured DESC, position, id LIMIT 10`, [project.id, article.group_id])).rows
            .map((/** @type {any} */ row) => String(row.id)) : [];
          if (!questionIds.length) { await this.#skip(project, key, "no_questions"); counts.skipped += 1; continue; }
          if (await this.#enqueueOnce(project, key, { kind: "post_publication", questionIds, engines: project.engines,
            ref: { articleId: String(article.article_id), orderId: String(article.order_id), week: checkpoint.week } })) {
            counts.postPublication += 1;
          }
        }
      }
    }
    return counts;
  }
}

/** A run key's dispatch id for one attempt: `geo-<key>-a<n>`, within the ledger's 64 characters. @param {string} key @param {number} attempt */
export function dispatchIdFor(key, attempt) {
  const slug = key.replace(/^run:/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const suffix = `-a${attempt}`;
  return `geo-${slug}`.slice(0, 64 - suffix.length) + suffix;
}
