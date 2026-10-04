import { presentVcrReview } from "./vcrViewsKit.mjs";
import { documentExportDigest } from "@evimed/domain";
/**
 * What 「虚拟临研」's pages are shown: the presenter (contract 2026-09-29 §5).
 *
 * The browser used to read shapes the server never sent — `tier` where the
 * server said `dataTier`, an `overview` nobody built, `criteria` and
 * `attrition` where the tab returned `current` and `versions` — and six of the
 * seven study tabs threw on the first real payload. This module is the one
 * place that turns stored rows into exactly the page types the web reads
 * (`apps/web/src/lib/vcrClient.ts`), so a change to a page is a change to this
 * file, one fixture and one component, in one commit.
 *
 * Hidden knowledge:
 *
 * - **Pure functions over rows.** Nothing here reads a store, a clock or a
 *   network: `VcrService` gathers the rows, this module presents them. That is
 *   what lets the fixture test seed a study through the real store, read it
 *   through the real service and compare the result to the JSON the web tests
 *   render from — the same bytes on both sides of the seam.
 * - **Every displayed number is a `VcrValue`** built by `measureValue`: value,
 *   source, named interval, Monte-Carlo error, review state, stale flag, and
 *   what a click on it opens. Where the data does not exist the page gets an
 *   empty array or `null` and shows its empty state; a number the server does
 *   not have is never made up (「不可估计」 is a word, never a zero).
 * - **The presenter never ranks.** It reports which designs another design
 *   dominates on the team's own written goal, and which design a person
 *   recorded as chosen; a `chosen` flag exists only when a decision row says
 *   so, so the brand blue is never on a design nobody chose (§14).
 * - **The tab presenters live in `vcrViewsTabs.mjs`**; this file holds the
 *   study-level pages (list, overview, model library, precedents, package).
 *
 * @module vcrViews
 */

import {
  VCR_COMPARATOR_ROUTE_LABELS_ZH, VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_ESTIMAND_LABELS_ZH, VCR_EXPORT_KIND_LABELS_ZH, VCR_INTENDED_USE_LABELS_ZH, VCR_MODEL_RISKS,
  VCR_MODEL_RISK_EVIDENCE, VCR_MODEL_RISK_LABELS_ZH, VCR_MODEL_TIER_LABELS_ZH, VCR_POOLING_METHOD_LABELS_ZH, VCR_MODEL_TIER_USE_CEILING, VCR_MODEL_TIERS,
  VCR_REVIEW_KIND_LABELS_ZH, VCR_ROLE_ABILITIES, VCR_STALE_REASON_LABELS_ZH,
  VCR_STEP_LABELS_ZH, VCR_STEPS, VCR_TWIN_LABELS_ZH, VCR_TWIN_EVIDENCE, VCR_VALUE_SOURCE_LABELS_ZH,
  VCR_TRIAL_DESIGN_LABELS_ZH,
  allowanceWaitingSentence, intendedUseCeiling, lineageNode, parseLineageNode, twinLabel, useWithin,
} from "@evimed/domain";

import { vcrExportHoldsDocument, vcrReportModel, vcrReportReviewRevision } from "./vcrRender.mjs";
import { vcrObjectNode } from "./vcrStore.mjs";
import {
  allResultsOf, countsView, finite, intervalView, list, markFor, measureLabel, measureValue, METHOD_LABELS, numeric, object, rangeString, roundTo,
  text, cpuText, zhTime,
} from "./vcrViewsKit.mjs";

/** The lineage node a result carries. @param {Record<string, any>} result */
export const resultNode = (result) => `result:${result.id}@${result.version}`;

// --- abilities, budget, jobs -----------------------------------------------------------------------

/** What a set of roles may do, as the browser hides and shows actions. @param {readonly string[]} roles */
export function abilitiesOf(roles) {
  const held = new Set();
  for (const role of roles) for (const ability of /** @type {readonly string[]} */ ((/** @type {any} */ (VCR_ROLE_ABILITIES))[role] ?? [])) held.add(ability);
  return [...held];
}

/**
 * The compute budget in the unit the platform actually meters: CPU seconds.
 * There is no money here — `budgetOf` measures what the engine spent — and a
 * page that said 「元」 would be quoting a price nobody set.
 * @param {Record<string, any> | null | undefined} budget
 */
export function budgetView(budget) {
  if (!budget) return null;
  return {
    limitSeconds: numeric(budget.limitSeconds) ?? 0,
    usedSeconds: numeric(budget.usedSeconds) ?? 0,
    committedSeconds: numeric(budget.committedSeconds) ?? 0,
    remainingSeconds: numeric(budget.remainingSeconds) ?? 0,
    awaitingBudget: Number(budget.awaitingBudget ?? 0),
  };
}

/** The words a job kind is shown as. */
export const JOB_KIND_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  profile_snapshot: "数据快照画像", build_cohort: "构建队列", generate_population: "生成情景人群",
  literature_population: "文献人群", synthesize_population: "合成人群", population_quality: "人群质量报告",
  generate_patients: "生成虚拟患者", generate_patients_continuous: "生成虚拟患者（连续终点）",
  generate_patients_binary: "生成虚拟患者（二分类终点）", reconstruct_km: "重建生存曲线", pool_evidence: "合并证据",
  weight_comparator: "熵平衡加权", propensity_weight_comparator: "倾向评分加权", maic_comparator: "匹配调整间接比较",
  weighted_cox_comparator: "加权 Cox 风险比", maic_time_to_event_comparator: "事件时间终点的匹配调整间接比较",
  aipw_comparator: "双重稳健估计（AIPW）", covariate_set_comparator: "协变量集敏感性分析",
  evalue: "E 值", rmst: "RMST 比较", design_analytic: "方案的解析计算", design_simulation: "方案的模拟运行",
  design_grid: "设计网格", assurance: "成功把握", procova: "预后协变量调整", accrual_forecast: "入组预测",
  map_prior: "MAP 先验", match_criteria: "逐条匹配",
  negative_control_comparator: "阴性对照结局", tipping_point: "缺失数据的临界点分析", prognostic_adjustment_comparator: "预后评分校正（二分类/事件时间）",
}));

/**
 * One job as a page shows it. A failed job carries its plain reason; the code
 * and the row id stay on the server.
 * @param {Record<string, any>} job @param {Date} now
 */
export function jobView(job, now) {
  const progress = object(job.progress);
  const done = numeric(progress.done);
  const total = numeric(progress.total);
  const error = job.error == null ? null : object(job.error);
  return {
    id: String(job.id),
    kind: String(job.kind),
    label: JOB_KIND_LABELS[String(job.kind)] ?? String(job.kind),
    state: String(job.state),
    progress: done !== null && total !== null && total > 0 ? { done, total } : null,
    cpuSecondsLimit: numeric(job.cpuSecondsLimit),
    cpuSecondsUsed: numeric(job.cpuSecondsUsed),
    seed: job.seed == null ? null : Number(job.seed),
    replicates: job.replicates == null ? null : Number(job.replicates),
    error: error && (error.code || error.message) ? { code: text(error.code), message: text(error.message), partial: error.partial === true } : null,
    updatedAt: zhTime(job.updatedAt ?? job.createdAt, now),
    cancelable: ["queued", "running", "awaiting_budget"].includes(String(job.state)),
  };
}

// --- the use ceiling ----------------------------------------------------------------------------------

/**
 * The version nodes the study holds now, by kind: the current version of each
 * assumption key, of the population, the patient set, each comparator route,
 * each labelled design, the grid, the definition and the protocol, and every
 * current result. What a review has to name to still be current.
 * @param {{ study?: Record<string, any> | null, assumptions?: readonly Record<string, any>[], populations?: readonly Record<string, any>[],
 *   patientSets?: readonly Record<string, any>[], comparators?: readonly Record<string, any>[], scenarios?: readonly Record<string, any>[],
 *   grid?: Record<string, any> | null, results?: readonly Record<string, any>[], definition?: Record<string, any> | null,
 *   protocol?: Record<string, any> | null }} rows the rows, newest first where a line has versions
 * @returns {{ nodes: Set<string>, kinds: Set<string> }}
 */
export function vcrCurrentNodes({ study = null, assumptions = [], populations = [], patientSets = [], comparators = [], scenarios = [],
  grid = null, results = [], definition = null, protocol = null }) {
  /** @type {Set<string>} */
  const nodes = new Set();
  const add = (/** @type {string} */ kind, /** @type {unknown} */ id, /** @type {unknown} */ version) => {
    try { nodes.add(lineageNode(kind, String(id), Number(version))); } catch { /* an id no node can carry names no object */ }
  };
  for (const card of assumptions) add("assumption", card.key, card.version);
  if (populations[0]) add("population", populations[0].id, populations[0].version);
  if (patientSets[0]) add("patient_set", patientSets[0].id, patientSets[0].version);
  const routes = new Set();
  for (const design of comparators) if (!routes.has(design.route)) { routes.add(design.route); add("comparator_design", design.id, design.version); }
  const labels = new Set();
  for (const scenario of scenarios) {
    const key = scenario.label || scenario.id;
    if (!labels.has(key)) { labels.add(key); add("trial_scenario", scenario.id, scenario.version); }
  }
  if (grid) add("design_grid", grid.id, grid.version);
  for (const result of results) add("result", result.id, result.version);
  if (definition) add("study_definition", definition.id, definition.version);
  if (protocol && study) add("protocol_version", study.id, protocol.version);
  return { nodes, kinds: new Set(["assumption", "population", "patient_set", "comparator_design", "trial_scenario", "design_grid", "result",
    "study_definition", "protocol_version"]) };
}

/**
 * Whether a review still countersigns what the study holds now: nothing it
 * names is marked stale, and every node it names is at its current version — a
 * result that has since been superseded, but also an assumption card edited
 * again, a population regenerated, a design replaced (`current`, from
 * {@link vcrCurrentNodes}). A review of an older version reads
 * `changed_after_review` whether or not a stale mark is still open for it
 * (AC-21). A node of a kind the study does not version (a snapshot, an
 * execution) is judged by its stale mark alone.
 * @param {Record<string, any>} review
 * @param {{ results: readonly Record<string, any>[], stale?: readonly Record<string, any>[], current?: { nodes: Set<string>, kinds: Set<string> } | null, exports?:readonly Record<string,any>[] }} context
 */
export function vcrReviewIsCurrent(review, { results, stale = [], current = null, exports = [] }) {
  if (!list(review.nodes).length || list(review.nodes).some(node => !parseLineageNode(String(node))) || (review.status ? review.status !== 'done' : ['queued', 'running', 'failed', 'ai_set'].includes(review.state))) return false;
  if (review.reviewerKind === 'ai' && (!review.platformReviewId || !review.provenance?.model || !review.provenance?.inputDigest)) return false;
  const subject = review.provenance?.subjectRef;
  if (review.reviewerKind === 'ai' && subject?.exportId) {
    const exported = exports.find(row => row.id === subject.exportId);
    if (!exported || !subject.reportRevision || subject.reportRevision !== vcrReportReviewRevision(exported.cover)) return false;
  }
  const currentResults = new Set(list(results).map((result) => `result:${object(result).id}@${object(result).version}`));
  const staleNodes = new Set(list(stale).map((mark) => String(object(mark).node)));
  return list(object(review).nodes).map(String).every((node) => {
    if (staleNodes.has(node)) return false;
    if (node.startsWith("result:") && !currentResults.has(node)) return false;
    const kind = parseLineageNode(node)?.kind;
    return !(current && kind && current.kinds.has(kind) && !current.nodes.has(node));
  });
}

/**
 * Every node a result depends on, found from the lineage edges backwards: what
 * the version dependencies an advisory review must identify.
 * @param {readonly { from: string, to: string }[]} edges @param {string} node
 * @returns {Set<string>}
 */
export function vcrDependencies(edges, node) {
  /** @type {Map<string, string[]>} */
  const into = new Map();
  for (const edge of edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
  /** @type {Set<string>} */
  const seen = new Set([node]);
  const queue = [node];
  for (let head = 0; head < queue.length; head += 1) {
    for (const from of into.get(queue[head]) ?? []) if (!seen.has(from)) { seen.add(from); queue.push(from); }
  }
  return seen;
}

/**
 * Evidence and method applicability determine the use ceiling. AI and optional
 * human review remain version-bound advice and never promote a model's tier.
 * @param {{ study: Record<string, any>, results: readonly Record<string, any>[], reviews: readonly Record<string, any>[], stale?: readonly Record<string, any>[],
 *   current?: { nodes: Set<string>, kinds: Set<string> } | null, dependsOn?: ReadonlySet<string> | null }} input
 */
export function useCeilingOf({ study, results }) {
  /** @type {string[]} */
  const tiers = [];
  for (const result of results) {
    for (const model of [...list(object(result.diagnostics).modelsUsed), ...list(object(result.useDowngrade).models)]) {
      const tier = String(object(model).tier ?? "");
      if (tier) tiers.push(tier);
    }
  }
  const modelCeiling = intendedUseCeiling(tiers);
  const ceiling = modelCeiling;
  const word = (/** @type {string} */ use) => (/** @type {Record<string, string>} */ (VCR_INTENDED_USE_LABELS_ZH))[use] ?? use;
  /** @type {Array<{ code: string, detail: string }>} */
  const reasons = [];
  if (modelCeiling !== "submission_preparation") {
    reasons.push({ code: "model_tier", detail: `所用模型的可信度层级最多支持「${word(modelCeiling)}」` });
  }
  return {
    ceiling,
    requested: String(study.intendedUse),
    withinCeiling: useWithin(String(study.intendedUse), ceiling),
    reasons,
  };
}

// --- attention ---------------------------------------------------------------------------------------

/** What each result kind is called on a page. */
const RESULT_KIND_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  population: "人群", patient_set: "虚拟患者", comparator: "对照", trial_scenario: "试验方案", design_grid: "设计网格",
  matching: "匹配评估", accrual_forecast: "入组预测", evidence_pool: "证据合并", snapshot_profile: "数据快照画像",
}));

/**
 * The newest comparator design whose own result — or its stored conclusion —
 * says it cannot be estimated: the route the study wanted and could not have.
 * @param {readonly Record<string, any>[]} comparators @param {readonly Record<string, any>[]} results
 */
export function notEstimableDesign(comparators, results) {
  return comparators.find((design) => design.conclusion === "not_estimable"
    || results.some((result) => result.id === design.resultId && result.conclusion === "not_estimable")) ?? null;
}

/**
 * The documents someone asked for that the study still does not have: of each
 * kind, the newest export, when it ended with nothing to read and no other
 * export of its kind holds a document. A revision that failed is therefore not
 * one of them — the document it was revising is still there — and the line goes
 * when the same document is exported again and arrives.
 * @param {readonly Record<string, any>[]} exports newest first, as the store returns them
 */
export function failedExportsOf(exports) {
  /** @type {Set<string>} */
  const seen = new Set();
  return exports.filter((row) => {
    const kind = String(row.kind);
    if (seen.has(kind)) return false;
    seen.add(kind);
    return row.state === "failed" && !exports.some((other) => String(other.kind) === kind && vcrExportHoldsDocument(other.cover));
  });
}

/**
 * The lines under 「需要关注」: what the reader has to look at. Deterministic
 * over the rows, so the home list and the overview say the same thing.
 * @param {{ assumptions: readonly Record<string, any>[], scenarios: readonly Record<string, any>[],
 *   comparators: readonly Record<string, any>[], results: readonly Record<string, any>[], allResults?: readonly Record<string, any>[],
 *   stale: readonly Record<string, any>[], jobs: readonly Record<string, any>[], steps: Record<string, any>,
 *   exports?: readonly Record<string, any>[] }} input
 */
export function attentionOf({ assumptions, scenarios, comparators, results, allResults, stale, jobs, steps, exports = [] }) {
  /** @type {Array<Record<string, any>>} */
  const lines = [];
  const used = new Set(scenarios.flatMap((scenario) => list(scenario.assumptionIds).map(String)));
  const keyed = used.size ? assumptions.filter((card) => used.has(card.key) || used.has(card.id)) : assumptions;
  const aiSet = keyed.filter((card) => card.reviewState === "ai_set");
  if (aiSet.length) {
    lines.push({
      kind: "ai_set", tone: "attention", tab: "data",
      text: used.size ? `${aiSet.length} 条关键假设由 AI 设定` : `${aiSet.length} 张假设卡由 AI 设定，还没有复核`,
      items: aiSet.slice(0, 3).map((card) => String(card.name || card.key)),
      action: { label: "去复核", tab: "data" },
    });
  }
  const unestimable = notEstimableDesign(comparators, allResults ?? results);
  if (unestimable) {
    const gaps = list(unestimable.gapList);
    const route = (/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[String(unestimable.route)] ?? "对照";
    lines.push({
      kind: "not_estimable", tone: "attention", tab: "comparator",
      text: gaps.length ? `${route}不可估计，缺 ${gaps.length} 项数据` : `${route}不可估计`,
      items: gaps.slice(0, 3).map((gap) => String(object(gap).title ?? object(gap).name ?? gap)),
      action: { label: "查看缺口", tab: "comparator" },
    });
  }
  if (stale.length) {
    const reason = (/** @type {Record<string, string>} */ (VCR_STALE_REASON_LABELS_ZH))[String(stale[0].reason)];
    lines.push({
      kind: "stale", tone: "stale",
      text: `${stale.length} 个结果已过期${reason ? `：${reason}` : ""}`,
    });
  }
  const waiting = jobs.filter((job) => job.state === "awaiting_budget");
  if (waiting.length) {
    lines.push({ kind: "budget_confirm", tone: "attention", text: `${waiting.length} 项计算在等你确认计算预算` });
  }
  for (const step of VCR_STEPS) {
    if (steps?.[step]?.status === "failed") {
      lines.push({ kind: "step_failed", tone: "attention", tab: null,
        text: `「${(/** @type {Record<string, string>} */ (VCR_STEP_LABELS_ZH))[step]}」这一步没有做完，已算出的部分保留` });
    }
  }
  // A step the allowance would not start is waiting for the reader's top-up, and a queued step that says nothing reads as work
  // under way. One line for all of them: the page's link to the top-up sits at its end (`allowance_waiting`).
  const allowanceWaiting = VCR_STEPS.filter((step) => steps?.[step]?.status === "queued" && steps[step].waiting);
  if (allowanceWaiting.length) {
    const label = (/** @type {string} */ step) => (/** @type {Record<string, string>} */ (VCR_STEP_LABELS_ZH))[step];
    const wallet = steps[allowanceWaiting[0]].waiting;
    lines.push({ kind: "allowance_waiting", tone: "attention", tab: null, waiting: wallet,
      text: allowanceWaiting.length === 1
        ? allowanceWaitingSentence(label(allowanceWaiting[0]), wallet)
        : `${allowanceWaiting.length} 个步骤在等${wallet === "simulated_allowance" ? "模拟" : "科研"}额度，${wallet === "simulated_allowance" ? "模拟充值" : "充值"}后会自动开始。`,
      items: allowanceWaiting.map(label) });
  }
  // An export that ended with no document is said the way a step that did not finish is: its row alone read
  // 「未完成」 in a list nothing pointed at, after a run the study had paid for.
  for (const row of failedExportsOf(exports)) {
    lines.push({ kind: "export_failed", tone: "attention", tab: null,
      text: `「${(/** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH))[String(row.kind)] ?? "研究包"}」没有生成，已算出的结果保留` });
  }
  return lines;
}

// --- the conclusion sentence ---------------------------------------------------------------------------

/**
 * The study's latest conclusion as a sentence, from its own results — what was
 * simulated and what could not be estimated, rendered by code, never a
 * sentence a model typed a number into. It states a range across designs and
 * never names a winner (§14).
 * @param {{ designs: readonly Record<string, any>[], results: readonly Record<string, any>[], allResults?: readonly Record<string, any>[],
 *   comparators: readonly Record<string, any>[] }} input
 */
export function conclusionOf({ designs, results, allResults, comparators }) {
  const sentence = overviewHeadline({ results: allResults ?? results, designs, comparators });
  if (sentence) {
    const trial = results.find((result) => result.kind === "trial_scenario");
    return { text: sentence.replace(/。$/, ""), state: trial?.conclusion ?? results[0]?.conclusion ?? null };
  }
  const latest = results[0];
  if (latest) return { text: `${RESULT_KIND_LABELS[latest.kind] ?? "结果"}已算出`, state: latest.conclusion ?? null };
  return null;
}

/**
 * A design's name without the letter its chip already shows: 「方案 B 2:1 随机」
 * beside the chip 「B」 is 「2:1 随机」.
 * @param {Record<string, any>} scenario @param {string} code
 */
export function designName(scenario, code) {
  const full = scenarioName(scenario);
  const stripped = full.replace(new RegExp(`^\\s*(方案\\s*)?${code}(?![A-Za-z0-9])[\\s:：、.\\-]*`), "").trim();
  return stripped || full;
}

/** What a trial scenario is called on a page. @param {Record<string, any>} scenario */
export function scenarioName(scenario) {
  const label = text(scenario.label);
  return label ?? (/** @type {Record<string, string>} */ (VCR_TRIAL_DESIGN_LABELS_ZH))[String(scenario.design)] ?? "试验方案";
}

/**
 * A value as one string, the way the browser prints it (`valueText` + unit):
 * the number to its own precision, then the unit.
 * @param {Record<string, any>} value
 */
export function valueString(value) {
  if (typeof value.value !== "number") return String(value.text ?? "—");
  return `${numberString(value.value, value.precision, value.mcse)}${value.unit === "%" ? "%" : value.unit ? ` ${value.unit}` : ""}`;
}

/**
 * A number to the precision it deserves: the caller's `precision`, else the
 * decimal place of its error's first significant digit, else a magnitude rule
 * (ratios 2 decimals, two significant digits below 1).
 * @param {number} value @param {number | null | undefined} precision @param {number | null | undefined} [mcse]
 */
export function numberString(value, precision, mcse = null) {
  /** @type {number} */
  let decimals;
  let trim = false;
  if (typeof precision === "number" && Number.isFinite(precision)) decimals = precision;
  else if (typeof mcse === "number" && mcse > 0) decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(mcse))));
  else {
    // Nothing says how many digits mean something: the magnitude decides, and
    // a trailing zero that only the rule wrote (5.90) is not printed.
    trim = true;
    if (Number.isInteger(value)) decimals = 0;
    else if (Math.abs(value) >= 100) decimals = 0;
    else if (Math.abs(value) >= 10) decimals = 1;
    else if (Math.abs(value) >= 1) decimals = 2;
    else decimals = Math.max(2, Math.min(6, 1 - Math.floor(Math.log10(Math.abs(value) || 1))));
  }
  const grouped = value.toLocaleString("en-US", { minimumFractionDigits: trim ? 0 : decimals, maximumFractionDigits: decimals });
  return grouped;
}

// --- the home list --------------------------------------------------------------------------------------------

/**
 * One row of the home list.
 * @param {{ study: Record<string, any>, results: readonly Record<string, any>[], stale: readonly Record<string, any>[],
 *   jobs: readonly Record<string, any>[], assumptions: readonly Record<string, any>[], scenarios: readonly Record<string, any>[],
 *   comparators: readonly Record<string, any>[], grid: Record<string, any> | null, decisions?: readonly Record<string, any>[], now: Date,
 *   allResults?: readonly Record<string, any>[], exports?: readonly Record<string, any>[] }} input
 */
export function presentSummary({ study, results, allResults, stale, jobs, assumptions, scenarios, comparators, grid, decisions = [], exports = [], now }) {
  const { designs } = presentDesigns({ study, scenarios, results, allResults, stale, executions: new Map(), grid, decisions, forecastResults: [], now });
  return {
    id: study.id,
    projectId: study.projectId,
    name: study.name,
    question: text(study.question),
    tier: study.dataTier,
    intendedUse: study.intendedUse,
    status: study.status,
    steps: study.steps,
    conclusion: conclusionOf({ designs, results, allResults, comparators }),
    attention: attentionOf({ assumptions, scenarios, comparators, results, allResults, stale, jobs, steps: study.steps, exports }),
    updatedAt: zhTime(study.updatedAt, now) ?? "",
    createdAt: study.createdAt,
  };
}

/**
 * 「招募待办」: what a coordinator has to confirm or chase, from the referral
 * ledger. Only the studies where this account may contact patients.
 * @param {ReadonlyArray<{ study: Record<string, any>, referrals: readonly Record<string, any>[], sites: readonly Record<string, any>[] }>} groups
 * @param {Date} now
 */
export function presentTodos(groups, now) {
  /** @type {Array<Record<string, any>>} */
  const todos = [];
  for (const { study, referrals, sites } of groups) {
    const ready = referrals.filter((referral) => referral.state === "contactable");
    if (ready.length) {
      todos.push({
        id: `${study.id}:contact`, kind: "contact", studyId: study.id,
        title: ready.length === 1 ? `${ready[0].subjectKey} 待确认联系` : `${ready[0].subjectKey} 等 ${ready.length} 人待确认联系`,
        detail: study.name, action: { label: "去确认", tab: "matching" },
      });
    }
    const needs = referrals.filter((referral) => referral.state === "needs_evidence");
    if (needs.length) {
      todos.push({
        id: `${study.id}:evidence`, kind: "evidence", studyId: study.id,
        title: `${needs.length} 人待补证`, detail: study.name, action: { label: "去看缺口", tab: "matching" },
      });
    }
    for (const site of sites) {
      const verified = site.verifiedAt ? new Date(site.verifiedAt).getTime() : null;
      const days = verified === null ? null : Math.floor((now.getTime() - verified) / 86_400_000);
      if (days === null || days > 90) {
        todos.push({
          id: `${study.id}:site:${site.id}`, kind: "site", studyId: study.id,
          title: `${site.name} 的资料${days === null ? "还没有核实过" : `已 ${days} 天没有核实`}`, detail: study.name,
          action: { label: "去看中心", tab: "matching" },
        });
      }
    }
  }
  return todos.slice(0, 12);
}

/**
 * 「最近复核」 across the account's studies.
 * @param {ReadonlyArray<{ study: Record<string, any>, reviews: readonly Record<string, any>[] }>} groups @param {Date} now
 */
export function presentReviewNotes(groups, now) {
  /** @type {Array<Record<string, any>>} */
  const notes = [];
  for (const { study, reviews } of groups) {
    for (const review of reviews.slice(0, 3)) {
      notes.push({
        id: review.id, subject: `${review.reviewerKind === "ai" ? "AI " : ""}${reviewSubject(review)} · ${presentVcrReview(review).state}`, by: presentVcrReview(review).by, at: zhTime(review.createdAt, now),
        studyName: study.name, state: !review.status || review.status === "done" ? "reviewed" : "ai_set", sortAt: review.createdAt,
      });
    }
  }
  return notes.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt))).slice(0, 5)
    .map(({ sortAt: _sortAt, ...note }) => note);
}

/** 「统计复核：假设卡 os_hr 等 3 项」. @param {Record<string, any>} review */
function reviewSubject(review) {
  const kind = (/** @type {Record<string, string>} */ (VCR_REVIEW_KIND_LABELS_ZH))[String(review.kind)] ?? "复核";
  const nodes = list(review.nodes).map(String);
  const first = nodeLabel(nodes[0] ?? "");
  return nodes.length > 1 ? `${kind}：${first} 等 ${nodes.length} 项` : `${kind}：${first || "这个研究"}`;
}

/** A lineage node in the reader's words. @param {string} node */
export function nodeLabel(node) {
  const parsed = parseLineageNode(node);
  if (!parsed) return "";
  const version = `v${parsed.version}`;
  switch (parsed.kind) {
    case "assumption": return `假设卡「${parsed.id}」${version}`;
    case "population": return `人群 ${version}`;
    case "patient_set": return `虚拟患者集 ${version}`;
    case "comparator_design": return `对照设计 ${version}`;
    case "trial_scenario": return `试验方案 ${version}`;
    case "design_grid": return `设计网格 ${version}`;
    case "study_definition": return `研究定义 ${version}`;
    case "protocol_version": return `方案 ${version}`;
    case "result": return `结果 ${version}`;
    default: return `${parsed.kind} ${version}`;
  }
}

// --- the study page --------------------------------------------------------------------------------------------------

/**
 * `GET /api/vcr/studies/:id`: the header, the seven-step rail and the overview.
 *
 * @param {Record<string, any>} bundle what `VcrService` gathered
 */
export function presentStudy(bundle) {
  const { study, results, stale, reviews, jobs, budget, assumptions, exports, scenarios, comparators, now, roles } = bundle;
  const { rows, designs } = presentDesigns(bundle);
  // The counts belong to the design a person chose; with no decision, to the
  // last design that is still in the running — never to one another design beats.
  const headline = (rows.find((row) => row.chosen) ?? [...rows].reverse().find((row) => !row.dominated && row._result) ?? null)?._result
    ?? results.find((result) => result.kind === "trial_scenario") ?? results[0] ?? null;
  // The headline number's dependencies preserve review currency independently of its use ceiling.
  const dependsOn = headline && bundle.edges ? vcrDependencies(bundle.edges, resultNode(headline)) : null;
  const overview = {
    headline: overviewHeadline({ results: allResultsOf(bundle), designs, comparators }),
    metrics: overviewMetrics(bundle, designs),
    counts: headline ? countsView(headline.counts, { tier: study.dataTier, scope: headlineScope(headline, rows) }) : null,
    designs,
    attention: attentionOf({ assumptions, scenarios, comparators, results, allResults: allResultsOf(bundle), stale, jobs, steps: study.steps, exports }),
    changes: presentChanges(bundle),
    deliverables: exports.map((/** @type {any} */ row, /** @type {number} */ index) => presentDeliverable(row, index, exports, now)),
  };
  return {
    id: study.id,
    projectId: study.projectId,
    name: study.name,
    question: text(study.question),
    tier: study.dataTier,
    intendedUse: study.intendedUse,
    status: study.status,
    steps: study.steps,
    sessionId: null,
    abilities: abilitiesOf(roles ?? []),
    // What the study's frozen data would let it claim above its own tier, for a lead who may move it (`#tierOffer`); one confirmation.
    tierOffer: bundle.tierOffer ?? null,
    budget: budgetView(budget),
    jobs: jobs.slice(0, 12).map((/** @type {any} */ job) => jobView(job, now)),
    ceiling: useCeilingOf({ study, results, reviews, stale, current: bundle.currentNodes ?? null, dependsOn }),
    overview,
    updatedAt: zhTime(study.updatedAt, now),
    createdAt: study.createdAt,
  };
}

/** The design a result belongs to, as the counts band names it. @param {Record<string, any>} headline @param {readonly Record<string, any>[]} rows */
function headlineScope(headline, rows) {
  const row = rows.find((entry) => entry._result?.id === headline.id);
  return row ? `方案 ${row.code}` : null;
}

/**
 * One sentence about the designs, rendered from their own measures: how many
 * were simulated and the range of the measure the team compares them on. It
 * names no winner and recommends nothing.
 * @param {readonly Record<string, any>[]} designs
 */
export function designsSentence(designs) {
  // A design counts as simulated when it has a number from a result — one with only its
  // configured sample size (or cost) has been written, not run.
  const live = designs.filter((design) => !design.dominated && Object.keys(object(design.measures)).some((key) => !["sample_size", "cost"].includes(key)));
  if (!live.length) return null;
  const pick = (/** @type {string} */ key) => live.map((design) => numeric(design.measures[key]?.value)).filter((value) => value !== null);
  const assurance = pick("assurance");
  const power = pick("power");
  const shown = assurance.length ? assurance : power;
  const label = assurance.length ? "成功把握" : "功效";
  if (!shown.length) return `已模拟 ${live.length} 个方案`;
  const low = Math.min(...shown);
  const high = Math.max(...shown);
  return `已模拟 ${live.length} 个方案，${label} ${low === high ? `${roundTo(low, 0)}%` : `${roundTo(low, 0)}%～${roundTo(high, 0)}%`}`;
}

/**
 * The overview's one sentence: what the designs look like, and what could not
 * be estimated — a statement of what was found, never a recommendation.
 * @param {{ results: readonly Record<string, any>[], designs: readonly Record<string, any>[], comparators: readonly Record<string, any>[] }} input
 */
export function overviewHeadline({ results, designs, comparators }) {
  /** @type {string[]} */
  const parts = [];
  const sentence = designsSentence(designs);
  if (sentence) parts.push(sentence);
  const unestimable = notEstimableDesign(comparators, results);
  if (unestimable) {
    const route = (/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[String(unestimable.route)] ?? "对照";
    const gaps = list(unestimable.gapList).length;
    parts.push(gaps ? `${route}不可估计，缺 ${gaps} 项数据` : `${route}不可估计`);
  }
  return parts.length ? `${parts.join("；")}。` : null;
}

/**
 * The number band: the assumptions the designs rest on, the designs' primary
 * measure, and a route that cannot be estimated as a word tile. At most six.
 * @param {Record<string, any>} bundle
 */
function overviewMetrics(bundle, allDesigns) {
  const { assumptions, scenarios, comparators, now, evidence } = bundle;
  /** @type {Array<Record<string, any>>} */
  const metrics = [];
  const used = new Set(scenarios.flatMap((/** @type {any} */ scenario) => list(scenario.assumptionIds).map(String)));
  const keyed = (used.size ? assumptions.filter((/** @type {any} */ card) => used.has(card.key) || used.has(card.id)) : assumptions).slice(0, 2);
  for (const card of keyed) {
    const items = list(card.evidenceIds).map((/** @type {any} */ id) => (evidence?.items ?? []).find((/** @type {any} */ item) => String(item.id) === String(id))).filter(Boolean);
    metrics.push({
      key: `assumption:${card.key}`, label: String(card.name || card.key), lead: false,
      // The tile prints the named interval itself; the line under it says what the number rests on.
      note: assumptionSummary(card, { interval: false }),
      value: assumptionValue(card, { now, evidence: items }),
    });
  }
  const designs = allDesigns.filter((/** @type {any} */ design) => !design.dominated).slice(0, 3);
  for (const design of designs) {
    const measure = design.measures.assurance ?? design.measures.power;
    if (!measure) continue;
    metrics.push({
      key: `design:${design.code}`, label: `方案 ${design.code} ${design.measures.assurance ? "成功把握" : "功效"}`,
      lead: metrics.every((/** @type {any} */ entry) => !entry.lead), note: design.name, value: measure,
    });
  }
  const unestimable = notEstimableDesign(comparators, allResultsOf(bundle));
  if (unestimable) {
    const gaps = list(unestimable.gapList).length;
    const own = allResultsOf(bundle).find((/** @type {any} */ result) => result.id === unestimable.resultId);
    metrics.push({
      key: "comparator_not_estimable",
      label: (/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[String(unestimable.route)] ?? "对照",
      lead: false, note: gaps ? `缺 ${gaps} 项数据` : null,
      value: { value: null, text: "不可估计", unit: null, source: "calculated", interval: null, mcse: null,
        review: own?.reviewState ?? unestimable.reviewState ?? null, precision: null, reason: gaps ? `缺 ${gaps} 项数据` : null, stale: false, detail: null },
    });
  }
  return metrics.slice(0, 6);
}

/**
 * 「最近的变化」: what changed, newest first, from the rows themselves — a
 * result, a card version, a countersignature, a decision, a package.
 * @param {Record<string, any>} bundle
 */
function presentChanges(bundle) {
  const { results, assumptions, reviews, decisions, exports, stale, now } = bundle;
  const staleNodes = new Set(stale.map((/** @type {any} */ mark) => mark.node));
  /** @type {Array<{ id: string, at: string, text: string, by: string | null, state: string | null }>} */
  const rows = [];
  // A few of each kind, so a study with many results still shows its reviews,
  // decisions and packages: they are the changes a person made.
  for (const result of results.slice(0, 3)) {
    rows.push({ id: `result:${result.id}`, at: result.createdAt, text: `${RESULT_KIND_LABELS[result.kind] ?? "结果"}的结果已更新（v${result.version}）`,
      by: null, state: staleNodes.has(resultNode(result)) ? "stale" : null });
  }
  for (const card of [...assumptions].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 2)) {
    rows.push({ id: `assumption:${card.id}`, at: card.createdAt, text: `假设卡「${card.name || card.key}」v${card.version}`, by: null,
      state: card.reviewState === "reviewed" ? "reviewed" : null });
  }
  for (const review of reviews.slice(0, 2)) rows.push({ id: `review:${review.id}`, at: review.createdAt, text: `${review.reviewerKind === "ai" ? "AI " : ""}${reviewSubject(review)} · ${presentVcrReview(review).state}`, by: presentVcrReview(review).by, state: !review.status || review.status === "done" ? "reviewed" : "ai_set" });
  for (const decision of decisions.slice(0, 1)) rows.push({ id: `decision:${decision.id}`, at: decision.createdAt, text: `写入决策记录：${decision.question}`, by: null, state: null });
  for (const row of exports.slice(0, 2)) {
    rows.push({ id: `export:${row.id}`, at: row.createdAt,
      text: `${(/** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH))[row.kind] ?? "研究包"}${row.state === "ready" ? "已生成" : "已请求"}`, by: null, state: null });
  }
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8)
    .map((row) => ({ id: row.id, at: zhTime(row.at, now) ?? "", text: row.text, by: row.by, state: row.state }));
}

/**
 * One deliverable of the list. The version number is the package's own
 * ordinal among packages of its kind — 「研究包 v2」 is the second one asked
 * for — and 「草稿」 is a package that is not finished or that says it is still
 * while conversion is unfinished; review remains separate advice.
 * @param {Record<string, any>} row @param {number} index @param {readonly Record<string, any>[]} all @param {Date} now
 */
export function presentDeliverable(row, index, all, now) {
  const kindWord = (/** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH))[String(row.kind)] ?? "研究包";
  // `exports` is newest first, so the ordinal counts the older ones of its kind.
  const older = all.slice(index + 1).filter((other) => other.kind === row.kind).length;
  const stateWord = /** @type {Record<string, string>} */ ({ queued: "排队中", running: "生成中", ready: "已生成", failed: "未完成" })[String(row.state)] ?? "";
  return {
    id: row.id,
    kind: row.kind,
    title: `${kindWord} v${older + 1}`,
    meta: [zhTime(row.createdAt, now), stateWord].filter(Boolean).join(" · "),
    draft: row.state !== "ready",
    runId: row.runId ?? null,
    path: row.location ?? null,
  };
}

// --- designs (shared by the overview and the trial tab) ------------------------------------------------------------------

/**
 * The trial scenarios as designs: the latest row of each label, with the
 * measures its own result carries. Dominance is the deterministic judgement on
 * the team's written goal; `chosen` is a recorded decision or nothing.
 * @param {Record<string, any>} bundle
 * @returns {{ designs: Array<Record<string, any>>, rows: Array<Record<string, any>> }}
 */
export function presentDesigns(bundle) {
  const { scenarios, stale, executions, grid, decisions, forecastResults = [] } = bundle;
  // The newest row of each label is the design; older rows are its history.
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map();
  for (const scenario of [...scenarios].sort((a, b) => Number(b.version) - Number(a.version))) {
    const key = scenario.label || scenario.id;
    if (!latest.has(key)) latest.set(key, scenario);
  }
  const ordered = [...latest.values()].sort((a, b) => Number(a.version) - Number(b.version));
  const known = new Map(allResultsOf(bundle).map((/** @type {any} */ result) => [result.id, result]));
  const resultOf = (/** @type {any} */ scenario) => known.get(scenario.resultId) ?? null;
  const dominated = grid?.comparisonGoal ? dominatedOf(ordered, resultOf, grid.comparisonGoal) : new Map();
  const decision = decisions[0] ?? null;
  const chosenId = text(object(decision?.chosen).id) ?? text(object(decision?.chosen).scenarioId);
  const chosenCode = text(object(decision?.chosen).code);
  const rows = ordered.map((scenario, index) => {
    const result = resultOf(scenario);
    const code = String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26)) : "");
    // A number is stale when its own result version is marked, and also while the design it
    // belongs to is: a recomputation lands one stage at a time, each stage a new result
    // version nobody has marked, carrying the numbers of the stages not yet redone. The
    // design's own mark — cleared only when everything of it has landed — is what says
    // the page is still showing yesterday's world. A result written after that mark is the
    // recomputation's own: its numbers are fresh, and the ones it carried over say so
    // themselves (`stale` on the measure); the page as a whole stays stale until the mark clears.
    const resultMark = result ? markFor(stale, resultNode(result)) : null;
    const designMark = result ? markFor(stale, vcrObjectNode("trial_scenario", /** @type {{ id: string, version: number }} */ (scenario))) : null;
    const olderThanChange = designMark && Date.parse(String(result.createdAt)) < Date.parse(String(designMark.markedAt));
    const staleMark = resultMark ?? (olderThanChange ? designMark : null);
    const execution = result?.executionId ? executions.get(result.executionId) ?? null : null;
    /** @type {Record<string, any>} */
    const measures = {};
    const design = object(object(scenario.configuration).design);
    const sample = (numeric(design.nTreat) ?? 0) + (numeric(design.nControl) ?? 0);
    if (numeric(design.nTreat) !== null || numeric(design.nControl) !== null) {
      measures.sample_size = { value: sample, text: null, unit: "例", source: "assumed", interval: null, mcse: null,
        review: null, precision: 0, reason: null, stale: false, detail: null };
    }
    if (result) {
      for (const measure of list(result.measures)) {
        const name = String(object(measure).name ?? "");
        if (["power", "type_one_error", "assurance", "expected_sample_size", "expected_events", "required_total", "required_events"].includes(name)) {
          measures[name === "required_total" ? "sample_size" : name] = measureValue(measure, { kind: "trial_scenario", result, execution, staleMark, tab: "trial" });
        }
      }
    }
    // Duration comes from the accrual forecast filed for this design, never
    // from the design's own simulation.
    const forecast = forecastResults.find((/** @type {any} */ entry) => entry.subjectId === scenario.id || entry.subjectId === scenario.resultId);
    const lastPatient = forecast ? list(forecast.measures).find((/** @type {any} */ entry) => ["last_patient_in_months", "expected_completion_time"].includes(String(object(entry).name))) : null;
    if (forecast && lastPatient) {
      measures.duration_months = measureValue(lastPatient, { kind: "accrual_forecast", result: forecast, tab: "trial" });
    }
    const cost = numeric(object(scenario.configuration).cost ?? object(object(scenario.configuration).cost).value);
    if (cost !== null) {
      measures.cost = { value: cost, text: null, unit: "万元", source: "assumed", interval: null, mcse: null, review: null, precision: 0,
        reason: null, stale: false, detail: null };
    }
    const beaten = dominated.get(scenario.id) ?? null;
    return {
      id: scenario.id,
      code,
      name: designName(scenario, code),
      dominated: Boolean(beaten),
      dominatedBy: beaten ? beaten.code : null,
      chosen: chosenId ? chosenId === scenario.id : chosenCode ? chosenCode === code : false,
      note: beaten ? `在比较目标的全部指标上都不优于 ${beaten.code}` : null,
      measures: beaten ? {} : measures,
      _scenario: scenario,
      _result: result,
      _stale: resultMark ?? designMark,
    };
  });
  // The dominating scenario's letter is only known once every row has one.
  const codeOf = new Map(rows.map((row) => [row.id, row.code]));
  for (const row of rows) {
    if (row.dominated) row.dominatedBy = codeOf.get(dominated.get(row.id)?.id) ?? null;
    if (row.dominated) row.note = row.dominatedBy ? `在比较目标的全部指标上都不优于 ${row.dominatedBy}` : "在比较目标的全部指标上不占优";
  }
  return { rows, designs: rows.map(({ _scenario, _result, _stale, ...design }) => design) };
}

/**
 * Scenarios beaten on every measure of the team's comparison goal. Ties do not
 * dominate. The same rule as `vcrDominatedScenarios`, keyed by id here.
 * @param {readonly Record<string, any>[]} scenarios @param {(scenario: any) => any} resultOf @param {Record<string, any>} goal
 */
function dominatedOf(scenarios, resultOf, goal) {
  const measures = list(goal.measures).map((measure) => ({
    name: String(object(measure).name ?? ""), higherIsBetter: String(object(measure).direction ?? "higher") !== "lower",
  })).filter((measure) => measure.name);
  /** @type {Map<string, Record<string, any>>} */
  const beaten = new Map();
  if (!measures.length) return beaten;
  const valueOf = (/** @type {any} */ scenario, /** @type {string} */ name) => {
    const found = list(object(resultOf(scenario)).measures).find((entry) => String(object(entry).name) === name);
    return finite(object(found).value);
  };
  for (const candidate of scenarios) {
    for (const other of scenarios) {
      if (other.id === candidate.id) continue;
      let better = false;
      let neverWorse = true;
      for (const measure of measures) {
        const mine = valueOf(candidate, measure.name);
        const theirs = valueOf(other, measure.name);
        if (mine === null || theirs === null) { neverWorse = false; break; }
        const worse = measure.higherIsBetter ? theirs < mine : theirs > mine;
        if (worse) { neverWorse = false; break; }
        if (measure.higherIsBetter ? theirs > mine : theirs < mine) better = true;
      }
      if (neverWorse && better) { beaten.set(candidate.id, other); break; }
    }
  }
  return beaten;
}

// --- assumptions (shared by the overview and the data tab) -----------------------------------------------------------------

/** 「7 项 · 预测区间 3.0–5.6」. @param {Record<string, any>} card */
export function assumptionSummary(card, { interval = true } = {}) {
  const pooling = object(card.pooling);
  const k = numeric(pooling.k);
  const range = object(pooling.predictionInterval ?? object(card.distribution).range);
  const low = finite(range.low);
  const high = finite(range.high);
  const parts = [];
  if (k !== null) parts.push(`${k} 项`);
  if (interval && low !== null && high !== null) parts.push(`预测区间 ${rangeString(low, high)}`);
  else if (card.sourceKind === "scenario") parts.push("情景假设");
  return parts.length ? parts.join(" · ") : null;
}

/**
 * An assumption card's value: its point value, the interval it was pooled
 * with (the prediction interval first — the design is the next study, not the
 * average of the past ones), and the review it carries.
 * @param {Record<string, any>} card @param {{ now: Date, evidence: readonly Record<string, any>[] }} context
 */
export function assumptionValue(card, context) {
  const pooling = object(card.pooling);
  const prediction = object(pooling.predictionInterval ?? object(card.distribution).range);
  const source = /** @type {readonly string[]} */ (Object.keys(VCR_VALUE_SOURCE_LABELS_ZH)).includes(String(card.valueSource)) ? String(card.valueSource) : "assumed";
  const interval = finite(prediction.low) !== null && finite(prediction.high) !== null
    ? intervalView({ kind: "prediction", low: prediction.low, high: prediction.high, level: 80 }) : null;
  const quote = context.evidence.find((item) => text(item.quote));
  return {
    value: numeric(card.pointValue),
    text: numeric(card.pointValue) === null ? "—" : null,
    unit: text(card.unit),
    source,
    interval,
    mcse: null,
    review: card.reviewState ?? "ai_set",
    precision: null,
    reason: null,
    stale: false,
    detail: {
      kind: "assumption",
      title: String(card.name || card.key),
      fields: [
        ...(text(card.poolingMethod) ? [{ label: "合并方法", value: (/** @type {Record<string, string>} */ (VCR_POOLING_METHOD_LABELS_ZH))[String(card.poolingMethod)] ?? String(card.poolingMethod) }] : []),
        ...(numeric(pooling.i2) !== null ? [{ label: "I²", value: `${roundTo(/** @type {number} */ (numeric(pooling.i2)) * (/** @type {number} */ (numeric(pooling.i2)) <= 1 ? 100 : 1), 0)}%` }] : []),
        ...(numeric(pooling.k) !== null ? [{ label: "纳入的研究数", value: String(numeric(pooling.k)) }] : []),
      ],
      quote: quote ? String(quote.quote) : null,
      quoteSource: quote ? [text(quote.source_ref ?? quote.sourceRef), quoteLocator(quote)].filter(Boolean).join("，") || null : null,
      ref: { kind: "assumption", id: String(card.id), tab: "data" },
    },
  };
}

/** 「第 6 页，表 2」. @param {Record<string, any>} item */
function quoteLocator(item) {
  const locator = object(item.locator);
  const parts = [];
  if (locator.page != null) parts.push(`第 ${locator.page} 页`);
  if (text(locator.table)) parts.push(String(locator.table));
  if (text(locator.section)) parts.push(String(locator.section));
  return parts.join("，");
}

// --- models and methods ------------------------------------------------------------------------------------------------------

/**
 * `GET /api/vcr/models`: the shared library, in the browser's card shape.
 * @param {{ models: readonly Record<string, any>[], methods: readonly Record<string, any>[], usedBy: Map<string, Array<{ id: string, label: string }>>,
 *   engineAvailable: boolean, engineMismatch: readonly string[] | null }} input
 */
export function presentModels({ models, methods, usedBy, engineAvailable, engineMismatch }) {
  const cards = models.map((model) => presentModelCard(model, usedBy.get(model.id) ?? usedBy.get(model.name) ?? []));
  return {
    models: cards,
    methods: methods.map((method) => {
      const validation = object(method.validationEvidence);
      const references = validation.status === 'passed' ? list(validation.referenceCases) : [];
      return {
        id: String(method.id),
        name: METHOD_LABELS[String(method.method)] ?? String(method.method),
        method: String(method.method),
        version: text(method.version),
        endpoints: list(method.endpoints).length ? list(method.endpoints).map(String).join(" · ") : null,
        numeric: references.length ? `${references.length} 个参考用例通过` : null,
        validation: references.length ? validation : { status: 'unmeasured', reason: validation.reason ?? 'no_reference_evidence' },
        assumptions: references.length ? list(method.assumptions) : [],
        usedIn: null,
      };
    }),
    ladder: VCR_MODEL_RISKS.map((risk) => ({
      risk,
      needs: (/** @type {Record<string, readonly string[]>} */ (VCR_MODEL_RISK_EVIDENCE))[risk].map(evidenceLabel).join("、"),
      ceiling: risk === "none" ? "exploratory" : risk === "low" ? "design_support" : risk === "medium" ? "specified_analysis" : "submission_preparation",
      count: models.filter((model) => model.risk === risk).length,
    })),
    engineAvailable,
    engineMismatch: engineMismatch ? [...engineMismatch] : null,
  };
}

/** The evidence items a model card lists, in Chinese. */
const EVIDENCE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  code_verification: "代码核对", seed_reproducible: "种子可复现", input_traceable: "输入可追溯", sensitivity_analysis: "敏感性分析",
  external_validation: "外部验证", model_locked: "模型已锁定", model_analysis_plan: "模型分析计划", prospective_validation: "前瞻验证",
  independent_review: "独立评审", regulatory_contact: "监管沟通", individual_conditioned: "以个体为条件",
  updates_with_new_data: "随新数据更新", calibrated_uncertainty: "不确定性已校准", validation_record: "验证记录",
}));
/** @param {string} key */
const evidenceLabel = (key) => EVIDENCE_LABELS[key] ?? key;

/**
 * One model as the §8.2 card: what it is for, where it may be used, how it
 * was validated, and the label it has earned — derived from evidence, never
 * granted by hand.
 * @param {Record<string, any>} model @param {Array<{ id: string, label: string }>} usedBy
 */
export function presentModelCard(model, usedBy) {
  const card = object(model.card);
  const applicability = object(model.applicability);
  const validation = object(model.validation);
  const held = list(model.evidence).map(String);
  const twin = twinLabel(held);
  const missingTwin = VCR_TWIN_EVIDENCE.filter((item) => !held.includes(item));
  const tier = (/** @type {readonly string[]} */ (VCR_MODEL_TIERS)).includes(String(model.tier)) ? String(model.tier) : "scenario";
  const validationRows = Object.entries(validation).filter(([key]) => key in VALIDATION_LABELS).map(([key, value]) => ({
    label: VALIDATION_LABELS[key] ?? key,
    state: value === true || (typeof value === "string" && value) ? "passed" : value === false ? "none" : "partial",
    detail: typeof value === "string" ? value : null,
  }));
  return {
    id: String(model.id),
    name: text(card.title) ?? String(model.name),
    family: text(card.type) ? (MODEL_TYPE_LABELS[String(card.type)] ?? String(card.type)) : null,
    version: text(model.version),
    tier,
    risk: model.risk,
    useCeiling: model.useCeiling ?? (/** @type {Record<string, string>} */ (VCR_MODEL_TIER_USE_CEILING))[tier],
    scope: text(applicability.population),
    region: text(applicability.region),
    endpoint: text(model.endpointType) ?? (list(applicability.endpoints).length ? list(applicability.endpoints).join("、") : null),
    timeRange: text(applicability.timeRange),
    inputRange: text(applicability.inputRange),
    sources: list(applicability.sources).length ? `来源 ${list(applicability.sources).length} 项：${list(applicability.sources).join("、")}` : null,
    provider: text(card.provider),
    interface: text(card.interface),
    inputs: list(card.inputs).map(String),
    outputs: text(card.outputs),
    missingData: text(card.missingData),
    retirement: text(card.retirement),
    twin,
    twinLabel: (/** @type {Record<string, string>} */ (VCR_TWIN_LABELS_ZH))[twin],
    twinReason: twin === "digital_twin" ? null : `缺少：${missingTwin.map(evidenceLabel).join("、")}`,
    validation: validationRows,
    limits: list(card.knownLimits).map(String),
    missingEvidence: list(model.missingEvidence).map((/** @type {string} */ item) => evidenceLabel(item)),
    usedBy,
    numeric: null,
    uncertainty: text(card.uncertainty),
  };
}

const VALIDATION_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  codeVerification: "代码核对", seedReproducible: "种子可复现", calibrationSlope: "校准斜率", ici: "综合校准指数",
  predictionIntervalCoverage: "预测区间覆盖率", crps: "CRPS", subgroups: "亚组表现", temporal: "时间外验证", drift: "漂移监测",
  external: "外部验证", internal: "内部验证",
}));
const MODEL_TYPE_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  mathematical_simulation: "数学仿真", fitted_prediction_model: "拟合预测", generative: "生成模型", mechanistic: "机制模型",
}));

// --- precedents -------------------------------------------------------------------------------------------------------------------------

/**
 * One registry precedent, planned and actual apart, the raw text beside the
 * normalised value (plan §6.4).
 * @param {Record<string, any>} row a `precedents` table row
 */
export function presentPrecedent(row) {
  const pico = object(row.pico);
  const design = object(row.design);
  const enrollment = object(row.enrollment);
  const sites = object(row.sites);
  const results = object(row.results);
  const planned = numeric(enrollment.planned);
  const actual = numeric(enrollment.actual);
  const months = numeric(enrollment.accrualToPrimaryCompletionMonths);
  const siteCount = numeric(sites.count);
  return {
    id: String(row.id),
    registryId: String(row.registry_id ?? row.registryId ?? ""),
    registry: text(row.registry) ? (/** @type {Record<string, string>} */ ({ "clinicaltrials.gov": "ClinicalTrials.gov", chictr: "ChiCTR", ctis: "EU CTIS", cde: "CDE 登记" }))[String(row.registry)] ?? String(row.registry) : null,
    title: text(row.title),
    population: list(pico.conditions).length ? list(pico.conditions).join("、") : null,
    design: [list(design.phases).join("/"), text(design.allocation), text(design.masking)].filter(Boolean).join(" · ") || null,
    planned,
    actual,
    sites: siteCount,
    plannedMonths: null,
    actualMonths: months,
    perSitePerMonth: actual !== null && months !== null && months > 0 && siteCount !== null && siteCount > 0
      ? roundTo(actual / months / siteCount, 3) : null,
    usedFor: null,
    countries: list(sites.countries).map(String),
    eligibilityText: text(row.eligibility_text ?? row.eligibilityText),
    interventions: list(pico.interventions).map((/** @type {any} */ item) => String(object(item).name ?? item)),
    endpoints: list(row.endpoints).map((/** @type {any} */ item) => String(object(item).title ?? object(item).measure ?? item)).filter(Boolean),
    hasResults: results.hasResults === true,
    enrollmentKind: text(row.enrollment_kind ?? row.enrollmentKind),
    source: list(row.sources).map((/** @type {any} */ item) => text(object(item).url) ?? text(item)).find(Boolean) ?? null,
  };
}

/**
 * `GET /api/vcr/precedents`: the library, or the sentence saying it is not
 * there — never an empty table that reads as 「没有先例」.
 * @param {{ available: boolean, message?: string | null, rows?: readonly Record<string, any>[], sources?: string | null, registryCoverage?:any[] }} input
 */
export function presentPrecedents({ available, message = null, rows = [], sources = null, registryCoverage = [] }) {
  return {
    available,
    message: available ? null : message,
    precedents: rows.map(presentPrecedent),
    ...(registryCoverage.length ? { registryCoverage } : {}),
    sources,
  };
}

// --- the package (export) ---------------------------------------------------------------------------------------------------------------------

/**
 * One package for the reader: the cover states the intended use, each
 * countersignature and the outcome seal truthfully — 未复核 is printed, never
 * hidden — and the sections are rendered from the study's own results
 * (plan §8.3, AC-20). Numbers come from `measureValue`, so the package and the
 * pages cannot disagree about one.
 *
 * @param {Record<string, any>} row the export row
 * @param {Record<string, any>} bundle the study's rows
 */
export function presentExport(row, bundle) {
  const { now, exports } = bundle;
  const index = exports.findIndex((/** @type {any} */ other) => other.id === row.id);
  const deliverable = presentDeliverable(row, index < 0 ? 0 : index, exports, now);
  const cover = object(row.cover);
  const currentModel = vcrReportModel({
    study: bundle.study, definition: bundle.definition, assumptions: bundle.assumptions, results: bundle.results,
    seal: bundle.seal ?? null, reviews: list(bundle.reviews).map(review => ({ ...review,
      current: vcrReviewIsCurrent(review, { results: bundle.results, stale: bundle.stale, current: bundle.currentNodes ?? null, exports: bundle.exports ?? [] }) })),
    staleMarks: bundle.stale, models: bundle.models, population: bundle.populations[0] ?? null,
    comparator: bundle.comparator, scenarios: bundle.scenarios,
  });
  const model = object(cover.results).study ? cover.results : currentModel;
  // Old documents remain readable. Compare the inputs available to their
  // templates, including assumptions, model versions, reviews and seal state.
  const comparable = (value) => {
    const result = { ...value };
    if (!Object.hasOwn(model, 'inputVersions')) delete result.inputVersions;
    result.review = { ...result.review, records: list(result.review?.records).map((review, position) => {
      const entry = { ...review };
      if (!Object.hasOwn(model.review?.records?.[position] ?? {}, 'current')) delete entry.current;
      return entry;
    }) };
    return result;
  };
  const snapshotChanged = Boolean(cover.results) && documentExportDigest(comparable(model)) !== documentExportDigest(comparable(currentModel));
  return {
    ...deliverable,
    ...(snapshotChanged ? { snapshotChanged: true } : {}),
    state: row.state,
    ...(cover.documentExportId ? { documentExportId: cover.documentExportId } : {}),
    document: {
      reviews: [...list(bundle.reviews).filter(review => review.provenance?.subjectRef?.exportId === row.id),
        ...list(model.review?.records).filter(review => !list(bundle.reviews).some(live => live.platformReviewId && live.platformReviewId === review.platformReviewId))].map(review => presentVcrReview({ ...review, current: vcrReviewIsCurrent(review,
          { results: bundle.results, stale: bundle.stale, current: bundle.currentNodes ?? null, exports: [row] }) })),
      status: coverStatus({ cover, row, bundle, model }),
      sections: packageSections({ cover, row, bundle, model }),
    },
  };
}

/** The cover block: intended use, each review, the seal. @param {{ cover: Record<string, any>, row: Record<string, any>, bundle: Record<string, any>, model: Record<string, any> }} input */
function coverStatus({ cover, row, bundle, model }) {
  const { now } = bundle;
  const word = (/** @type {string} */ use) => (/** @type {Record<string, string>} */ (VCR_INTENDED_USE_LABELS_ZH))[use] ?? use;
  const use = String(cover.intendedUse ?? model.intendedUse ?? bundle.study.intendedUse);
  /** @type {Array<{ label: string, value: string, state: string, note: string | null }>} */
  const status = [{ label: "预期用途", value: word(use), state: "neutral", note: null }];
  const reviews = (list(cover.reviews).length ? list(cover.reviews) : list(model.review?.records)).map(review => ({ ...review,
    current: review.current !== false && vcrReviewIsCurrent(review, { results: bundle.results, stale: bundle.stale, current: bundle.currentNodes ?? null, exports: [row] }) }));
  for (const kind of ["statistical", "clinical"]) {
    // A review the cover says has stopped holding (`current: false`) is not 已复核 — the page says what became of it.
    const ofKind = reviews.filter((review) => String(object(review).kind) === kind);
    const done = ofKind.find((review) => object(review).current !== false && (!review.status || review.status === "done"));
    const changed = !done ? ofKind[0] : null;
    const label = `${(/** @type {Record<string, string>} */ (VCR_REVIEW_KIND_LABELS_ZH))[kind]}`;
    if (changed?.reviewerKind === 'ai' && changed.status !== 'done') {
      const shown = presentVcrReview(changed);
      status.push({ label, value: shown.state, state: 'attention', note: shown.note });
    } else if (changed) {
      status.push({ label, value: "复核后有变更", state: "attention",
        note: "被审查的内容有了新版本，旧意见保留供参考" });
    } else if (done) {
      const at = zhTime(object(done).at ?? object(done).createdAt, now);
      status.push({ label, value: `已复核${at ? `（${at.replace(/ \d\d:\d\d$/, "")}）` : ""}`, state: "ok",
        note: list(object(done).nodes).length ? `针对 ${list(object(done).nodes).map((/** @type {string} */ node) => nodeLabel(String(node))).filter(Boolean).slice(0, 2).join("、")}` : null });
    } else {
      status.push({ label, value: "未复核", state: "attention", note: null });
    }
  }
  const seal = object(cover.seal ?? model.seal);
  status.push(seal.required === true
    ? { label: "结局封存", value: seal.planFrozenAt ? "已按计划解封" : "封存中", state: "neutral",
      note: [seal.planFrozenAt ? `计划冻结 ${zhTime(seal.planFrozenAt, now)}` : null, seal.outcomeFirstReadAt ? `首次读取结局 ${zhTime(seal.outcomeFirstReadAt, now)}` : null].filter(Boolean).join(" · ") || null }
    : { label: "结局封存", value: "不适用", state: "neutral", note: row.kind === "study_package" && bundle.study.dataTier === "T0" ? "设计阶段" : null });
  if (numeric(cover.staleResults)) status.push({ label: "过期结果", value: `${numeric(cover.staleResults)} 项`, state: "attention", note: null });
  return status;
}

/** The nine parts of §8.3 that this deployment can fill from data. @param {{ cover: Record<string, any>, row: Record<string, any>, bundle: Record<string, any>, model: Record<string, any> }} input */
function packageSections({ cover, bundle, model }) {
  const { now } = bundle;
  /** @type {Array<Record<string, any>>} */
  const sections = [];
  let number = 0;
  const add = (/** @type {Record<string, any>} */ section) => { number += 1; sections.push({ ...section, id: section.id, number: String(number) }); };
  const rendered = list(cover.reports).length ? list(cover.reports).map(report => `${report.section}\n\n${report.rendered}`).join("\n\n") : text(object(cover.report).rendered);
  const pico = object(object(model.definition).pico);
  add({
    id: "summary", title: "研究与分析概要", body: rendered,
    facts: [
      ...(text(model.study?.question) ? [{ label: "研究问题", value: String(model.study.question) }] : []),
      ...(text(pico.population) ? [{ label: "人群", value: String(pico.population) }] : []),
      ...(text(model.definition?.endpointType) ? [{ label: "终点类型", value: (/** @type {Record<string, string>} */ (VCR_ENDPOINT_TYPE_LABELS_ZH))[String(model.definition.endpointType)] ?? String(model.definition.endpointType) }] : []),
      ...(text(model.estimand) ? [{ label: "估计目标", value: (/** @type {Record<string, string>} */ (VCR_ESTIMAND_LABELS_ZH))[String(model.estimand)] ?? String(model.estimand) }] : []),
    ],
  });
  const assumptions = list(model.assumptions);
  if (assumptions.length) {
    add({
      id: "assumptions", title: "假设登记表",
      table: {
        columns: ["假设", "取值", "来源", "复核"],
        rows: assumptions.map((card) => {
          const entry = object(card);
          return [String(entry.name || entry.key), entry.value == null ? "—" : `${numberString(Number(entry.value), null)}${entry.unit ? ` ${entry.unit}` : ""}`,
            String(entry.valueSourceLabel ?? "—"), (/** @type {Record<string, string>} */ ({ ai_set: "AI 设定", reviewed: "已复核", changed_after_review: "复核后有变更" }))[String(entry.reviewState)] ?? "—"];
        }),
      },
    });
  }
  // The results of the study's own objects — each design, the population, the
  // patient set, each comparator route, each forecast — under the object's
  // name. A report model keyed only by kind would print one arbitrary design's
  // power as 「试验方案：功效」.
  const subjectOf = new Map();
  for (const scenario of bundle.scenarios) if (scenario.resultId) subjectOf.set(scenario.resultId, scenarioName(scenario));
  for (const design of bundle.comparators) {
    if (design.resultId) subjectOf.set(design.resultId, (/** @type {Record<string, string>} */ (VCR_COMPARATOR_ROUTE_LABELS_ZH))[design.route] ?? "对照");
  }
  for (const population of bundle.populations) if (population.resultId) subjectOf.set(population.resultId, `人群 v${population.version}`);
  for (const set of bundle.patientSets) if (set.resultId) subjectOf.set(set.resultId, `虚拟患者集 v${set.version}`);
  const scenarioIds = new Map(bundle.scenarios.map((/** @type {any} */ scenario) => [scenario.id, scenarioName(scenario)]));
  const resultRows = [];
  for (const result of allResultsOf(bundle)) {
    if (!["population", "patient_set", "comparator", "trial_scenario", "accrual_forecast"].includes(result.kind)) continue;
    // A superseded result of a design the study no longer has is history, not a finding.
    const subject = subjectOf.get(result.id) ?? (result.kind === "accrual_forecast" ? `${scenarioIds.get(result.subjectId) ?? "招募"}的入组预测` : null);
    if (!subject) continue;
    for (const entry of list(result.measures)) {
      const value = measureValue(entry, { kind: result.kind, result });
      const spread = value.interval && value.interval.low !== value.interval.high
        ? `${(/** @type {Record<string, string>} */ ({ confidence: "置信区间", credible: "可信区间", prediction: "预测区间", monte_carlo: "蒙特卡洛区间" }))[value.interval.kind]} ${rangeString(Number(value.interval.low), Number(value.interval.high))}` : "—";
      resultRows.push([`${subject}：${measureLabel(String(entry.name))}`, valueString(value), spread, value.mcse ? `±${numberString(value.mcse, null)}` : "—"]);
    }
  }
  add({
    id: "results", title: "结果",
    table: resultRows.length ? { columns: ["指标", "取值", "范围", "蒙特卡洛标准误"], rows: resultRows } : null,
    note: resultRows.length ? "表中每个数都是这个研究的结果，不是手写的。" : "还没有可写入研究包的结果。",
  });
  const runs = [...bundle.executions.values()];
  if (runs.length) {
    add({
      id: "runs", title: "执行记录",
      table: {
        columns: ["方法", "版本", "种子", "重复次数", "计算用时"],
        rows: runs.slice(0, 20).map((run) => [String(run.method), String(run.methodVersion || "—"), String(run.seed ?? "—"),
          run.replicates == null ? "—" : Number(run.replicates).toLocaleString("en-US"), cpuText(numeric(run.cpuSeconds))]),
      },
    });
  }
  const models = list(model.models);
  if (models.length) {
    add({
      id: "validation", title: "验证与局限",
      table: {
        columns: ["模型", "可信度层级", "模型风险", "还缺的证据"],
        rows: models.map((entry) => {
          const row = object(entry);
          return [String(row.name), (/** @type {Record<string, string>} */ (VCR_MODEL_TIER_LABELS_ZH))[String(row.tier)] ?? "—",
            (/** @type {Record<string, string>} */ (VCR_MODEL_RISK_LABELS_ZH))[String(row.risk)] ?? "—",
            list(row.missingEvidence).map((/** @type {string} */ item) => evidenceLabel(item)).join("、") || "无"];
        }),
      },
    });
  }
  if (bundle.decisions.length) {
    add({
      id: "decisions", title: "决策记录",
      table: {
        columns: ["时间", "决定的事", "选择", "理由"],
        rows: bundle.decisions.map((/** @type {any} */ decision) => [zhTime(decision.createdAt, now) ?? "—", String(decision.question),
          String(object(decision.chosen).label ?? object(decision.chosen).code ?? "—"), String(decision.rationale || "—")]),
      },
    });
  }
  return sections;
}
