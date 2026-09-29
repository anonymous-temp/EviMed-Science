/**
 * 「虚拟临研」 — the browser's side of `/api/vcr/*` (build contract 2026-09-28 §3.1).
 *
 * Hidden knowledge:
 *
 *  - Every route answers in the platform's `{ data }` envelope, so every call
 *    goes through `productRequest`, which unwraps it and turns a refusal into
 *    a `WebApiError` carrying the named code.
 *  - The module can be off, or offered only to some accounts; either way every
 *    route answers 404 `vcr_not_enabled` (`isVcrOff`), and somebody else's
 *    study answers 404 `vcr_study_not_found`. A page that gets the first
 *    renders the off page rather than an error; the second is 「不存在或已删除」.
 *  - A study is an ordinary control-plane project plus one study row. The
 *    study id (`id`) addresses these routes; the control-plane id
 *    (`projectId`) is the project the shell switches to before it opens a
 *    conversation.
 *  - **A number is never a bare number.** Every displayed quantity arrives as
 *    a `VcrValue` carrying the one of nine value sources it came from
 *    (plan §3.5), its named interval (置信 / 可信 / 预测 / 蒙特卡洛 — never a
 *    bare 「区间」), its Monte-Carlo standard error when it was simulated, its
 *    review state, and what a click on it should open. `readVcrValue`
 *    normalises whatever the server sent into that shape, so a missing or
 *    malformed value reads as 「—」 and never as zero. A computation that
 *    failed is `text`, never `0` (plan §9.6).
 *  - The vocabularies are not restated here: the label tables come from
 *    `@evimed/domain`'s `vcrVocabulary.mjs`, which the schema CHECKs, the
 *    routes, the runtime gateway and the engine all read. A second copy is
 *    the one that drifts.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, WebApiError, type WebMe } from "./apiClient";
import { productRequest } from "./productClient";

/* ---------------------------------------------------------------- vocabulary */

/** The nine value-level source labels (`VCR_VALUE_SOURCES`). */
export type VcrValueSource =
  | "observed" | "extracted" | "calculated" | "imputed" | "aggregate"
  | "reconstructed" | "predicted" | "assumed" | "synthetic";
/** What the method itself says about the estimate (`VCR_CONCLUSIONS`). */
export type VcrConclusion = "estimable" | "limited" | "not_estimable";
/** A countersignature on one version, never a gate (`VCR_REVIEW_STATES`). */
export type VcrReviewState = "ai_set" | "reviewed" | "changed_after_review";
export type VcrReviewKind = "clinical" | "statistical" | "data";
export type VcrDataTier = "T0" | "T1" | "T2" | "T3";
export type VcrIntendedUse = "exploratory" | "design_support" | "specified_analysis" | "submission_preparation";
export type VcrModelTier = "scenario" | "literature" | "data" | "validated";
export type VcrModelRisk = "none" | "low" | "medium" | "high";
export type VcrIntervalKind = "confidence" | "credible" | "prediction" | "monte_carlo";
export type VcrStudyStatus = "active" | "paused" | "archived";
/** The seven steps, in order (`VCR_STEPS`). */
export type VcrStepKey = "definition" | "evidence" | "population" | "patients" | "comparator" | "trial" | "matching";
export const VCR_STEP_KEYS: readonly VcrStepKey[] = Object.freeze([
  "definition", "evidence", "population", "patients", "comparator", "trial", "matching",
]);
export type VcrStepStatus = "none" | "queued" | "running" | "done" | "minimal" | "stale" | "failed";
/** The seven tabs of a study page (`VCR_TABS`); the design spec caps this at seven. */
export type VcrTabKey = "overview" | "population" | "patients" | "comparator" | "trial" | "matching" | "data";
/** The four action cards on the home page (`VCR_ACTIONS`). */
export type VcrAction = "cohort" | "patients" | "comparator" | "trial";
export const VCR_ACTIONS: readonly VcrAction[] = Object.freeze(["cohort", "patients", "comparator", "trial"]);
export type VcrJobState = "queued" | "running" | "succeeded" | "failed" | "canceled" | "awaiting_budget";
export type VcrCriterionState = "satisfied" | "not_satisfied" | "unknown" | "pending_recheck";
export type VcrEligibility = "eligible" | "ineligible" | "insufficient_evidence" | "pending";
export type VcrReferralState =
  | "candidate" | "needs_evidence" | "contactable" | "contacted" | "interested" | "referred"
  | "site_responded" | "screening" | "enrolled" | "screen_failed" | "withdrawn";
export type VcrComparatorRoute =
  | "prognostic_adjustment" | "external_control" | "literature_control" | "model_comparator" | "hybrid_control";
export type VcrExportKind = "study_package" | "cde_communication_pack" | "simulation_report" | "validation_pack";
export type VcrMemberRole =
  | "lead" | "clinical_reviewer" | "statistical_reviewer" | "data_manager" | "recruiter" | "site" | "viewer";
/** The four counts that appear wherever a sample size does (`VCR_COUNT_KEYS`). */
export type VcrCountKey =
  | "realPatients" | "events" | "effectiveSampleSize" | "generatedRecords"
  | "priorEffectiveSampleSize" | "reconstructedPseudoPatients";

/* --------------------------------------------------------------------- shapes */

/** A named interval. A page never writes a bare 「区间」 (plan §9.6). */
export interface VcrInterval {
  kind: VcrIntervalKind;
  low: number | null;
  high: number | null;
  /** 95 for a 95% interval, 80 for an 80% prediction interval. */
  level?: number | null;
}

/** Where a click on a number lands. */
export interface VcrRef {
  kind: "assumption" | "run" | "job" | "result" | "snapshot" | "precedent" | "criterion" | "referral" | "model";
  id: string;
  /** The tab that holds it, when the click should also change tabs. */
  tab?: VcrTabKey | null;
}

/**
 * What a drill-down shows. A simulated number opens its run's configuration,
 * seed and Monte-Carlo error; an aggregate opens the assumption card and the
 * sentence it was read out of (plan §9.5: every number can be drilled into).
 */
export interface VcrValueDetail {
  /** 「那次运行」 or 「那张假设卡」. */
  kind: "run" | "assumption" | "count" | "other";
  title?: string | null;
  /** Name / value pairs, printed in the order the server sent them. */
  fields?: Array<{ label: string; value: string }>;
  /** The sentence an extracted or aggregate value was read out of. */
  quote?: string | null;
  /** What the quote is from: 「某试验 2024，第 6 页，表 2」. */
  quoteSource?: string | null;
  /** Where the whole thing is read. */
  ref?: VcrRef | null;
}

/**
 * One number and everything that makes it readable.
 *
 * `value` absent with `text` present is the word that stands in for it
 * (「不可估计」「—」「未测量」); a failed computation is never a zero.
 */
export interface VcrValue {
  value: number | null;
  /** The word shown in place of a number. */
  text?: string | null;
  /** 「个月」「%」「例」 — set small beside the number. */
  unit?: string | null;
  source: VcrValueSource;
  interval?: VcrInterval | null;
  /** Monte-Carlo standard error. Every simulated measure carries one (§4). */
  mcse?: number | null;
  review?: VcrReviewState | null;
  /** How many decimals to print; the value's own precision when absent. */
  precision?: number | null;
  /** Why there is no number: a missing reason or a not-estimable rule. */
  reason?: string | null;
  /** The inputs changed after this was computed (plan §6.3). */
  stale?: boolean;
  /** What a click opens. */
  detail?: VcrValueDetail | null;
}

/** A labelled number in a band. */
export interface VcrMetric {
  key: string;
  label: string;
  value: VcrValue;
  /** The line under the number: 「预测区间 3.0–5.6 · 7 项随机效应汇总」. */
  note?: string | null;
  /** The band's leading metric. */
  lead?: boolean;
}

/**
 * The four counts, said apart (plan §3.5). Generating ten thousand virtual
 * patients narrows no interval, which is why they may never be added up.
 */
export interface VcrCounts {
  realPatients: number | null;
  events: number | null;
  effectiveSampleSize: number | null;
  generatedRecords: number | null;
  /** Only when prior borrowing is used. */
  priorEffectiveSampleSize?: number | null;
  /** Only when a published curve was digitised. */
  reconstructedPseudoPatients?: number | null;
  /** The band's own line: 「设计阶段：尚无真实患者」. */
  note?: string | null;
  /** A short line under one count: 「T1 无结局记录」. */
  notes?: Partial<Record<VcrCountKey, string>>;
  /** What the counts are of: 「方案 B」. */
  scope?: string | null;
}

/** One step of the seven (`studies.steps[key]`). */
export interface VcrStep {
  status: VcrStepStatus;
  requested?: boolean;
  /** What it produced, in the reader's words: 「12 张假设卡」「人群 v3」. */
  note?: string | null;
  runId?: string | null;
  updatedAt?: string | null;
}
export type VcrSteps = Partial<Record<VcrStepKey, VcrStep>>;

/** One line of 「需要关注」. */
export interface VcrAttention {
  kind: string;
  text: string;
  /** `attention` is the amber 「AI 设定 / 缺口」 line; `stale` is the grey one. */
  tone?: "attention" | "stale" | "neutral";
  /** The names under the line: the three assumptions, the three gaps. */
  items?: string[];
  tab?: VcrTabKey | null;
  ref?: VcrRef | null;
  /** The link at the line's end: 「去复核」「查看缺口」. */
  action?: { label: string; tab?: VcrTabKey | null; ref?: VcrRef | null } | null;
}

/** One row of the home list (`GET /api/vcr/studies`). */
export interface VcrStudySummary {
  id: string;
  projectId: string;
  name: string;
  /** The research question in one line. */
  question: string | null;
  tier: VcrDataTier;
  intendedUse: VcrIntendedUse;
  status: VcrStudyStatus;
  steps: VcrSteps;
  /** The latest conclusion, as the sentence the study itself wrote. */
  conclusion: { text: string | null; state: VcrConclusion | null } | null;
  attention: VcrAttention[];
  updatedAt: string;
  createdAt?: string | null;
}

/** 「招募待办」, for an account with a recruiting role only. */
export interface VcrRecruitTodo {
  id: string;
  kind: "contact" | "evidence" | "site";
  title: string;
  detail?: string | null;
  studyId?: string | null;
  action?: { label: string; tab?: VcrTabKey | null } | null;
}

/** 「最近复核」. */
export interface VcrReviewNote {
  id: string;
  subject: string;
  by?: string | null;
  at?: string | null;
  studyName?: string | null;
  state: VcrReviewState;
}

/** The home page's payload. */
export interface VcrHome {
  studies: VcrStudySummary[];
  /** Present only for an account with `contact_patients`; absent otherwise. */
  todos?: VcrRecruitTodo[];
  reviews?: VcrReviewNote[];
}

/** One deliverable of a study. */
export interface VcrDeliverable {
  id: string;
  kind: VcrExportKind;
  title: string;
  /** 「今天 14:32 · PDF · 42 页」. */
  meta?: string | null;
  /** 「草稿」 when it is not final. */
  draft?: boolean;
  /** The run's file, when there is one to open. */
  runId?: string | null;
  path?: string | null;
  /**
   * The package as a document, when the control plane renders one for reading
   * in place (plan §8.3). Without it the reader shows the cover alone and
   * offers the file.
   */
  document?: {
    /** The cover block: intended use, each review, outcome sealing. */
    status?: Array<{ label: string; value: string; state?: "ok" | "attention" | "neutral"; note?: string | null }>;
    sections?: Array<{
      id: string;
      /** 「1」「3」 — the section's own number in the document. */
      number?: string | null;
      title: string;
      body?: string | null;
      facts?: Array<{ label: string; value: string }>;
      table?: { columns: string[]; rows: string[][] } | null;
      note?: string | null;
    }>;
  } | null;
}

/** One line of 「最近的变化」. */
export interface VcrChange {
  id: string;
  at: string;
  text: string;
  by?: string | null;
  state?: VcrReviewState | "stale" | null;
}

/** A design on the trade-off scatter and in the grid. */
export interface VcrDesign {
  id: string;
  /** 「B」. */
  code: string;
  name: string;
  /** Dominated by another design: drawn hatched and grey, with no numbers. */
  dominated?: boolean;
  dominatedBy?: string | null;
  /** Ours / the chosen one: the brand blue. The rest are greys. */
  chosen?: boolean;
  note?: string | null;
  measures: Record<string, VcrValue>;
}

export interface VcrOverview {
  /** The one sentence at the top of the page. */
  headline: string | null;
  metrics: VcrMetric[];
  counts: VcrCounts | null;
  designs: VcrDesign[];
  attention: VcrAttention[];
  changes: VcrChange[];
  deliverables: VcrDeliverable[];
}

/** One study (`GET /api/vcr/studies/:id`). */
export interface VcrStudy {
  id: string;
  projectId: string;
  name: string;
  question: string | null;
  tier: VcrDataTier;
  intendedUse: VcrIntendedUse;
  status: VcrStudyStatus;
  steps: VcrSteps;
  /** The latest conversation in the project; null before there is one. */
  sessionId: string | null;
  /** What this reader may do here (`VCR_ROLE_ABILITIES`); the routes check for themselves. */
  abilities: string[];
  /** The compute budget, when one is set. */
  budget: { limitCny: number; spentCny: number; pendingCny?: number | null } | null;
  /** The run the page's numbers came from. */
  run: { id: string; label: string; at?: string | null } | null;
  overview: VcrOverview;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/* ---------------------------------------------------------------- tab shapes */

/** One inclusion / exclusion rule, with its three counts. */
export interface VcrCriterion {
  id: string;
  /** 「I6」. */
  code: string;
  name: string;
  /** The protocol's own sentence. */
  quote?: string | null;
  quoteSource?: string | null;
  kind: "inclusion" | "exclusion";
  kept: number | null;
  excluded: number | null;
  unknown: number | null;
  review?: VcrReviewState | null;
  source?: VcrValueSource | null;
  /** 「v2 修改」. */
  changed?: string | null;
}

/** One bar of the attrition waterfall. */
export interface VcrAttritionStep {
  key: string;
  label: string;
  code?: string | null;
  remaining: number | null;
  /** How many of the remaining still lack evidence for this rule. */
  unknown?: number | null;
  removed?: number | null;
}

/** One row of the population profile, ours against the comparator's. */
export interface VcrProfileRow {
  key: string;
  label: string;
  ours: VcrValue;
  theirs: VcrValue;
  /** Standardized difference; above `VCR_SMD_FLOOR` the row is flagged. */
  smd: number | null;
  flagged?: boolean;
  note?: string | null;
}

export interface VcrPopulationTab {
  /** 「人群 v3（方案 v2）」 and the versions it can be compared against. */
  version: string | null;
  versions?: Array<{ id: string; label: string; stale?: boolean }>;
  definition: {
    timeZero?: string | null;
    evidenceWindow?: string | null;
    exit?: string | null;
    protocol?: string | null;
  } | null;
  criteria: VcrCriterion[];
  attrition: VcrAttritionStep[];
  /** The three totals under the waterfall. */
  outcome: { eligible: number | null; insufficient: number | null; ineligible: number | null } | null;
  profile: VcrProfileRow[];
  profileNote?: string | null;
  /** Why the undecidable ones are undecidable. */
  unknownReasons: Array<{ key: string; label: string; detail?: string | null; count: number | null }>;
  /** 「最卡人的三条」. */
  blockers: Array<{ code: string; label: string; text: string; tone?: "attention" | "neutral" }>;
  counts: VcrCounts | null;
  conclusion?: VcrConclusion | null;
  headline?: string | null;
}

/** A model's card (plan §8.2). */
export interface VcrModelCard {
  id: string;
  name: string;
  family?: string | null;
  version?: string | null;
  tier: VcrModelTier;
  risk: VcrModelRisk;
  /** The highest intended use this model's tier can carry. */
  useCeiling: VcrIntendedUse;
  scope?: string | null;
  endpoint?: string | null;
  timeRange?: string | null;
  inputRange?: string | null;
  sources?: string | null;
  /** `digital_twin` only with all four pieces of evidence (`twinLabel`). */
  twin?: "digital_twin" | "baseline_conditioned_prediction" | null;
  twinReason?: string | null;
  validation?: Array<{ label: string; state: "passed" | "none" | "partial"; detail?: string | null }>;
  limits?: string[];
  usedBy?: Array<{ id: string; label: string }>;
  /** Numerical test cases, as 「12 / 12 通过」. */
  numeric?: { passed: number; total: number } | null;
  uncertainty?: string | null;
}

/** One series of a trajectory chart. */
export interface VcrSeries {
  key: string;
  label: string;
  /** `observed` draws a solid line, `reconstructed` a dashed one, `predicted` a band. */
  source: VcrValueSource;
  /** Our arm / chosen scenario is the brand blue; the rest are greys. */
  ours?: boolean;
  points: Array<{ x: number; y: number | null; low?: number | null; high?: number | null }>;
  /** The band's own name, when it has one: 「80% 预测区间」. */
  bandKind?: VcrIntervalKind | null;
  /** The line's end label: 「试验 −1.4%」. */
  endLabel?: string | null;
  endNote?: string | null;
  /** Thin individual trajectories drawn behind the mean. */
  individuals?: Array<Array<{ x: number; y: number | null }>>;
  dashed?: boolean;
}

export interface VcrPatientsTab {
  model: VcrModelCard | null;
  headline?: string | null;
  /** The main chart: one series per scenario. */
  trajectories: { xLabel?: string | null; yLabel?: string | null; ticks?: string[]; series: VcrSeries[] } | null;
  /** One virtual patient, and the same random numbers under two assumptions. */
  example: {
    id: string;
    source: VcrValueSource;
    origin?: string | null;
    baseline: Array<{ label: string; value: string; source: VcrValueSource }>;
    inScope?: { ok: boolean; text: string } | null;
    scenarios?: { note?: string | null; series: VcrSeries[]; difference?: string | null } | null;
    note?: string | null;
  } | null;
  /** The binary and time-to-event panels under the main chart. */
  panels: Array<{
    key: string;
    title: string;
    kind: "binary" | "time_to_event";
    note?: string | null;
    rows?: Array<{ label: string; value: VcrValue }>;
    series?: VcrSeries[];
    footnote?: string | null;
  }>;
  /** 「哪些假设影响最大」. */
  sensitivity: { measure?: string | null; rows: Array<{ label: string; range?: string | null; low: number; high: number }> } | null;
  counts: VcrCounts | null;
}

/** One comparator route and its state. */
export interface VcrRoute {
  route: VcrComparatorRoute;
  state: VcrConclusion | "not_applicable" | "scenario" | "design_only";
  reason?: string | null;
  note?: string | null;
  selected?: boolean;
}

/** A survival curve. A reconstructed one is always dashed (plan §9.6). */
export interface VcrCurve {
  key: string;
  label: string;
  source: VcrValueSource;
  ours?: boolean;
  /** Step points of the Kaplan-Meier estimate. */
  points: Array<{ x: number; y: number | null; low?: number | null; high?: number | null }>;
  /** Numbers at risk under the plot. */
  atRisk?: Array<{ x: number; n: number }>;
  pooled?: boolean;
}

export interface VcrComparatorTab {
  headline?: string | null;
  routes: VcrRoute[];
  curves: VcrCurve[];
  /** τ and the area it shades. */
  rmst: { value: VcrValue; tau?: number | null; label?: string | null } | null;
  median?: VcrValue | null;
  /** The reconstruction's own quality control. */
  qc: Array<{ key: string; label: string; value: string; threshold?: string | null; passed: boolean }>;
  methods?: Array<{ label: string; version?: string | null; note?: string | null; passed?: boolean }>;
  /** ICH E10's four conditions. */
  e10?: Array<{ key: string; label: string; state: "met" | "partial" | "doubtful"; note?: string | null }>;
  estimand?: { rows: Array<{ label: string; value: string }>; note?: string | null; source?: VcrValueSource | null; review?: VcrReviewState | null } | null;
  comparability: VcrProfileRow[];
  comparabilityNote?: string | null;
  /** 「不可估计」 — the gaps, and what each one would answer. */
  gaps: { title?: string | null; needs?: string | null; items: Array<{ title: string; detail?: string | null; answers?: string | null }>; conclusion?: string | null } | null;
  counts: VcrCounts | null;
  /** 「本页结论：有限制地估计 · AI 设定 · 未复核」. */
  verdict?: { conclusion: VcrConclusion; review: VcrReviewState; reviewed?: boolean } | null;
}

export interface VcrTrialTab {
  headline?: string | null;
  /** ADEMP, one line each. */
  ademp: Array<{ key: string; label: string; text: string }>;
  ademReview?: VcrReviewState | null;
  designs: VcrDesign[];
  /** The columns of the design grid, in order. */
  columns: Array<{ key: string; label: string; unit?: string | null }>;
  /**
   * A scan over two design parameters — sample size against target effect,
   * say — as a heat grid. One measure at a time: a cell with two numbers in
   * it is a table, not a picture.
   */
  grid?: {
    measure?: string | null;
    xLabel?: string | null;
    yLabel?: string | null;
    columns: Array<{ key: string; header: string }>;
    rows: Array<{ key: string; header: string; cells: Array<{ value: number | null; text: string; hint?: string }> }>;
  } | null;
  footnotes?: string[];
  /** Power against the true effect. */
  powerCurve: { xLabel?: string | null; yLabel?: string | null; series: VcrSeries[]; markers?: Array<{ x: number; label: string; kind?: "assumed" | "null" }>; prior?: Array<{ x: number; y: number }> } | null;
  /** The reader's own comparison goal; the platform never picks a design. */
  decision: { goal?: string | null; chosen?: string | null; options: Array<{ id: string; label: string; disabled?: boolean }>; note?: string | null } | null;
  /** 「运行记录」. */
  runRecord: Array<{ key: string; title: string; detail?: string | null; ok?: boolean }>;
  counts: VcrCounts | null;
}

/** One candidate in the matching list. */
export interface VcrCandidate {
  id: string;
  summary: string;
  site?: string | null;
  eligibility: VcrEligibility;
  /** The rules still open on this person: 「E3 未知」「E5 待复评 10月6日」. */
  open: Array<{ code: string; state: VcrCriterionState; note?: string | null }>;
}

/** One rule judged against one candidate. */
export interface VcrCriterionJudgement {
  code: string;
  kind: "inclusion" | "exclusion";
  text: string;
  state: VcrCriterionState;
  /** The patient's own sentence, and where it is from. */
  evidence?: { quote: string; source?: string | null; at?: string | null } | null;
  /** What to ask for: 「申请近 4 周头颅 MRI」. */
  request?: string | null;
  requestNote?: string | null;
}

export interface VcrMatchingTab {
  /** The sub-tab the payload is for. */
  view: "matching" | "referral" | "sites" | "followup";
  headline?: string | null;
  partner?: { name?: string | null; candidates?: number | null; tier?: VcrDataTier | null; snapshotAt?: string | null } | null;
  /** 「给试验找患者 | 给患者找试验」. */
  direction?: "trial_to_patient" | "patient_to_trial";
  funnel: Array<{ key: string; label: string; count: number | null; note?: string | null; tone?: "attention" | "accent" | "neutral" }>;
  candidates: VcrCandidate[];
  /** The candidate the detail panel is about. */
  selected: {
    candidate: VcrCandidate;
    facts?: Array<{ label: string; value: string; tone?: "attention" | "neutral" }>;
    criteria: VcrCriterionJudgement[];
    /** 「不能判为符合：排除标准 E3 未知」 — always the reason, never a bare no. */
    verdict?: { text: string; note?: string | null } | null;
    /** The only human stop in the module (plan §10.1). */
    canContact?: boolean;
  } | null;
  /** The main gaps across the undecidable ones. */
  gaps: Array<{ code: string; label: string; detail?: string | null; count: number | null }>;
  /** The referral ledger, one entry per state. */
  ledger?: Array<{ state: VcrReferralState; count: number | null; note?: string | null; waiting?: boolean }>;
  /** Predicted against actual enrolment. */
  forecast?: {
    target?: number | null;
    xLabels?: string[];
    actual?: Array<{ x: number; y: number | null }>;
    median?: Array<{ x: number; y: number | null }>;
    band?: Array<{ x: number; low: number | null; high: number | null }>;
    markers?: Array<{ x: number; label: string }>;
    rows?: VcrMetric[];
    basis?: string[];
  } | null;
  sites?: Array<{
    id: string; name: string; place?: string | null; state: string; stateNote?: string | null;
    capacity?: string | null; competing?: string | null; referred?: number | null;
    waiting?: number | null; enrolled?: number | null; checkedAt?: string | null; alert?: string | null;
  }>;
  followup?: Array<{ id: string; label: string; kind: string; detail?: string | null; at?: string | null }>;
  counts: VcrCounts | null;
}

/** One assumption card (plan §6.1). */
export interface VcrAssumption {
  id: string;
  name: string;
  value: VcrValue;
  /** 「7 项 · 预测区间 3.0–5.6」. */
  summary?: string | null;
  key?: boolean;
  version?: number | null;
  /** The card's full detail, on the card the reader opened. */
  detail?: {
    subtitle?: string | null;
    stats?: Array<{ label: string; value: string }>;
    /** One row per study in the forest plot. */
    forest?: Array<{
      id: string; label: string; note?: string | null; n?: number | null;
      value: number | null; low: number | null; high: number | null;
      weight?: number | null; highlighted?: boolean; pooled?: boolean;
      /** The prediction interval's whisker under the diamond. */
      prediction?: boolean;
    }>;
    forestNote?: string | null;
    /** The distribution the simulation draws from. */
    distribution?: { family: string; note?: string | null; points?: Array<{ x: number; y: number }> } | null;
    quote?: string | null;
    quoteSource?: string | null;
    quoteLink?: string | null;
    /** 「被这些结果使用」. */
    usedBy?: Array<{ id: string; label: string; note?: string | null; tab?: VcrTabKey | null }>;
    versions?: Array<{ version: number; at?: string | null; text: string; note?: string | null }>;
  } | null;
}

/** One precedent trial (plan §6.4). */
export interface VcrPrecedent {
  id: string;
  registryId: string;
  registry?: string | null;
  population?: string | null;
  design?: string | null;
  planned?: number | null;
  actual?: number | null;
  sites?: number | null;
  plannedMonths?: number | null;
  actualMonths?: number | null;
  perSitePerMonth?: number | null;
  usedFor?: string | null;
}

export interface VcrDataTab {
  headline?: string | null;
  /** 「证据截至 9月27日 · 试验先例 23 项 · 假设卡 12 张 · 患者级数据 未接入」. */
  status?: Array<{ label: string; value: string }>;
  assumptions: VcrAssumption[];
  /** The card whose detail is shown. */
  selectedId?: string | null;
  precedents: VcrPrecedent[];
  precedentSources?: string | null;
  precedentNote?: string | null;
  /** Data snapshots and their quality, at T1 and above. */
  snapshots?: Array<{ id: string; label: string; at?: string | null; rows?: number | null; quality?: Array<{ label: string; value: string; passed?: boolean }> }>;
  counts?: VcrCounts | null;
}

/** Everything a job says about itself. */
export interface VcrJob {
  id: string;
  kind: string;
  state: VcrJobState;
  progress?: { done: number; total: number } | null;
  cpuSeconds?: number | null;
  seed?: number | null;
  replicates?: number | null;
  error?: string | null;
  /** A job waiting on a budget confirmation says what it would cost. */
  estimateCny?: number | null;
}

/** The cross-study model library (`GET /api/vcr/models`). */
export interface VcrModels {
  models: VcrModelCard[];
  /** The method packages, which are not models. */
  methods: Array<{ id: string; name: string; version?: string | null; endpoints?: string | null; numeric?: string | null; usedIn?: string | null }>;
  /** The credibility ladder: what each model risk needs, and what it may claim. */
  ladder?: Array<{ risk: VcrModelRisk; needs: string; ceiling: VcrIntendedUse; count?: number | null }>;
}

/* ------------------------------------------------------------------- readers */

const VALUE_SOURCES: ReadonlySet<string> = new Set([
  "observed", "extracted", "calculated", "imputed", "aggregate", "reconstructed", "predicted", "assumed", "synthetic",
]);
const INTERVAL_KINDS: ReadonlySet<string> = new Set(["confidence", "credible", "prediction", "monte_carlo"]);
const REVIEW_STATES: ReadonlySet<string> = new Set(["ai_set", "reviewed", "changed_after_review"]);

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** An interval, or nothing. An interval without a name is not an interval. */
export function readVcrInterval(raw: unknown): VcrInterval | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.kind !== "string" || !INTERVAL_KINDS.has(value.kind)) return null;
  const low = finite(value.low);
  const high = finite(value.high);
  if (low === null && high === null) return null;
  return { kind: value.kind as VcrIntervalKind, low, high, level: finite(value.level) };
}

/**
 * Any value as a `VcrValue`. Nothing the server did not send becomes a number:
 * a missing or malformed value reads as 「—」, never as zero, and its source
 * defaults to `assumed` — the weakest thing it could be — so an unlabelled
 * number can never pass for an observation.
 */
export function readVcrValue(raw: unknown): VcrValue {
  if (typeof raw === "number") return { value: finite(raw), source: "assumed" };
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const detail = value.detail && typeof value.detail === "object" ? value.detail as VcrValueDetail : null;
  return {
    value: finite(value.value),
    text: text(value.text),
    unit: text(value.unit),
    source: typeof value.source === "string" && VALUE_SOURCES.has(value.source) ? value.source as VcrValueSource : "assumed",
    interval: readVcrInterval(value.interval),
    mcse: finite(value.mcse),
    review: typeof value.review === "string" && REVIEW_STATES.has(value.review) ? value.review as VcrReviewState : null,
    precision: finite(value.precision),
    reason: text(value.reason),
    stale: value.stale === true,
    detail,
  };
}

/** Counts, with every key present so the band always draws its four columns. */
export function readVcrCounts(raw: unknown): VcrCounts | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return {
    realPatients: finite(value.realPatients),
    events: finite(value.events),
    effectiveSampleSize: finite(value.effectiveSampleSize),
    generatedRecords: finite(value.generatedRecords),
    priorEffectiveSampleSize: finite(value.priorEffectiveSampleSize),
    reconstructedPseudoPatients: finite(value.reconstructedPseudoPatients),
    note: text(value.note),
    notes: value.notes && typeof value.notes === "object" ? value.notes as VcrCounts["notes"] : undefined,
    scope: text(value.scope),
  };
}

function readMetric(raw: unknown): VcrMetric {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    key: text(value.key) ?? "",
    label: text(value.label) ?? "",
    value: readVcrValue(value.value),
    note: text(value.note),
    lead: value.lead === true,
  };
}

function readDesign(raw: unknown): VcrDesign {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const measures = value.measures && typeof value.measures === "object" ? value.measures as Record<string, unknown> : {};
  return {
    id: text(value.id) ?? "",
    code: text(value.code) ?? "",
    name: text(value.name) ?? "",
    dominated: value.dominated === true,
    dominatedBy: text(value.dominatedBy),
    chosen: value.chosen === true,
    note: text(value.note),
    measures: Object.fromEntries(Object.entries(measures).map(([key, cell]) => [key, readVcrValue(cell)])),
  };
}

function readOverview(raw: unknown): VcrOverview {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    headline: text(value.headline),
    metrics: (Array.isArray(value.metrics) ? value.metrics : []).map(readMetric),
    counts: readVcrCounts(value.counts),
    designs: (Array.isArray(value.designs) ? value.designs : []).map(readDesign),
    attention: (Array.isArray(value.attention) ? value.attention : []).filter((item) => item && typeof item.text === "string"),
    changes: (Array.isArray(value.changes) ? value.changes : []).filter((item) => item && typeof item.text === "string"),
    deliverables: (Array.isArray(value.deliverables) ? value.deliverables : []).filter((item) => item && typeof item.title === "string"),
  };
}

function readStudy(raw: VcrStudy): VcrStudy {
  return {
    ...raw,
    steps: raw?.steps && typeof raw.steps === "object" ? raw.steps : {},
    abilities: Array.isArray(raw?.abilities) ? raw.abilities : [],
    budget: raw?.budget ?? null,
    run: raw?.run ?? null,
    sessionId: text(raw?.sessionId),
    overview: readOverview(raw?.overview),
  };
}

function readSummary(raw: VcrStudySummary): VcrStudySummary {
  return {
    ...raw,
    steps: raw?.steps && typeof raw.steps === "object" ? raw.steps : {},
    conclusion: raw?.conclusion ?? null,
    attention: Array.isArray(raw?.attention) ? raw.attention : [],
  };
}

/** Whether a refusal says the module is off for this account. */
export function isVcrOff(error: unknown): boolean {
  return error instanceof WebApiError && error.status === 404 && error.code === "vcr_not_enabled";
}

/** Whether a refusal says there is no such study (someone else's, or deleted). */
export function isVcrMissing(error: unknown): boolean {
  return error instanceof WebApiError && error.status === 404 && !isVcrOff(error);
}

const id = (value: string) => encodeURIComponent(value);
const study = (studyId: string) => `/vcr/studies/${id(studyId)}`;

/* -------------------------------------------------------------------- routes */

export async function getVcrHome(): Promise<VcrHome> {
  const data = await productRequest<VcrHome>("/vcr/studies");
  return {
    studies: (Array.isArray(data?.studies) ? data.studies : []).map(readSummary),
    ...(Array.isArray(data?.todos) ? { todos: data.todos } : {}),
    ...(Array.isArray(data?.reviews) ? { reviews: data.reviews } : {}),
  };
}

/** 「新建研究」 and the four action cards: the study, its project and its conversation. */
export function createVcrStudy(input: { name?: string; action?: VcrAction; intendedUse?: VcrIntendedUse; tier?: VcrDataTier } = {}) {
  return productRequest<{ id: string; projectId: string; sessionId: string }>("/vcr/studies", "POST", input);
}

export async function getVcrStudy(studyId: string): Promise<VcrStudy> {
  return readStudy(await productRequest<VcrStudy>(study(studyId)));
}

export function patchVcrStudy(studyId: string, input: { name?: string; intendedUse?: VcrIntendedUse; status?: VcrStudyStatus; budgetCny?: number }) {
  return productRequest<unknown>(study(studyId), "PATCH", input);
}

export function deleteVcrStudy(studyId: string) {
  return productRequest<unknown>(study(studyId), "DELETE");
}

/** One tab's payload. The tab key is the route's own word (contract §3.1). */
export function getVcrTab<T>(studyId: string, tab: Exclude<VcrTabKey, "overview">, query: Record<string, string> = {}): Promise<T> {
  const search = new URLSearchParams(query).toString();
  return productRequest<T>(`${study(studyId)}/${tab}${search ? `?${search}` : ""}`);
}

export const getVcrPopulation = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrPopulationTab>(studyId, "population", query);
export const getVcrPatients = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrPatientsTab>(studyId, "patients", query);
export const getVcrComparator = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrComparatorTab>(studyId, "comparator", query);
export const getVcrTrial = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrTrialTab>(studyId, "trial", query);
export const getVcrMatching = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrMatchingTab>(studyId, "matching", query);
export const getVcrData = (studyId: string, query?: Record<string, string>) =>
  getVcrTab<VcrDataTab>(studyId, "data", query);

/** 「让 AI 做」: dispatches one step now, in the study's own conversation. */
export function runVcrStep(studyId: string, step: VcrStepKey) {
  return productRequest<{ sessionId: string; runId?: string | null }>(`${study(studyId)}/run`, "POST", { step });
}

/** A deterministic computation, queued directly (contract §3.1, §4). */
export function queueVcrJob(studyId: string, input: { kind: string; scenario?: unknown; seed?: number; replicates?: number }) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs`, "POST", input);
}

export function getVcrJob(studyId: string, jobId: string) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs/${id(jobId)}`);
}

export function cancelVcrJob(studyId: string, jobId: string) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs/${id(jobId)}/cancel`, "POST", {});
}

/** The second of the three human stops: more compute than the study's budget. */
export function confirmVcrBudget(studyId: string, input: { limitCny: number }) {
  return productRequest<unknown>(`${study(studyId)}/budget`, "POST", input);
}

/** A new version of one assumption card; downstream results go stale by lineage. */
export function saveVcrAssumption(studyId: string, input: { id?: string; name?: string; value?: unknown; note?: string }) {
  return productRequest<VcrAssumption>(`${study(studyId)}/assumptions`, "POST", input);
}

/** 「签注复核」: a countersignature on one version, never a gate (plan §10.2). */
export function signVcrReview(studyId: string, input: { kind: VcrReviewKind; subject: string; version?: string; note?: string }) {
  return productRequest<unknown>(`${study(studyId)}/reviews`, "POST", input);
}

/** 「写入决策记录」: the reader's comparison goal and the design they chose. */
export function recordVcrDecision(studyId: string, input: { goal?: string; chosen?: string; note?: string }) {
  return productRequest<unknown>(`${study(studyId)}/decisions`, "POST", input);
}

export function exportVcrStudy(studyId: string, kind: VcrExportKind) {
  return productRequest<{ id?: string; sessionId?: string | null; runId?: string | null }>(`${study(studyId)}/export`, "POST", { kind });
}

export function getVcrExport(studyId: string, exportId: string) {
  return productRequest<VcrDeliverable>(`${study(studyId)}/export/${id(exportId)}`);
}

export function getVcrModels() {
  return productRequest<VcrModels>("/vcr/models");
}

export function getVcrPrecedents(query: { q?: string; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (query.q) search.set("q", query.q);
  if (query.limit) search.set("limit", String(query.limit));
  const suffix = search.toString();
  return productRequest<{ precedents: VcrPrecedent[]; sources?: string | null }>(`/vcr/precedents${suffix ? `?${suffix}` : ""}`);
}

export function setVcrMembers(studyId: string, input: { userId: string; role: VcrMemberRole | null }) {
  return productRequest<unknown>(`${study(studyId)}/members`, "POST", input);
}

/**
 * The first of the three human stops: a coordinator confirms, person by
 * person, before anyone outside the platform is contacted (plan §10.1).
 */
export function contactVcrReferral(studyId: string, referralId: string, input: { reason?: string } = {}) {
  return productRequest<unknown>(`${study(studyId)}/referrals/${id(referralId)}/contact`, "POST", input);
}

/* -------------------------------------------------------------------- feature */

/** Whether `/api/me` offers this account the module. A missing `features` is off. */
export function vcrOffered(me: WebMe | null): boolean {
  const features = (me as (WebMe & { features?: unknown }) | null)?.features;
  return Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).vcr === true);
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type VcrFeature = "loading" | "on" | "off" | "error";

/**
 * The account's answer, read once per mount from the shared `/api/me`.
 *
 * Presentation only, like `useGeoFeature`: the routes authorize themselves, so
 * a browser that flips this gains a navigation row, never the data behind it.
 */
export function useVcrFeature(): VcrFeature {
  const [feature, setFeature] = useState<VcrFeature>("loading");
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(vcrOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
