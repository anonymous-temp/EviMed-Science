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
 *  - **The server presents the pages** (`apps/server/src/vcrViews*.mjs`); the
 *    types below are what it sends, the readers are total over what it might
 *    send (a missing list is an empty one, a missing value reads as 「—」), and
 *    every write body is built by `vcrBodies.ts`, which is exactly the routes'
 *    allow-lists. The shared fixtures under `apps/server/test/fixtures/
 *    vcr-views/` are the same bytes the server tests compare against.
 */
import { useEffect, useState } from "react";
import { fetchWebMe, WebApiError, type WebMe } from "./apiClient";
import { productRequest } from "./productClient";
import {
  assessmentReviewBody, assumptionBody, budgetBody, cancelBody, contactBody, decisionBody, exportBody, jobBody, judgmentBody, memberBody,
  modelBody, reviewBody, runBody, studyCreateBody, studyPatchBody, transitionBody,
  type VcrAssumptionBody, type VcrBudgetBody, type VcrContactBody, type VcrCreateBody, type VcrDecisionBody, type VcrJobBody,
  type VcrJudgmentBody, type VcrMemberBody, type VcrModelBody, type VcrPatchBody, type VcrReviewBody, type VcrTransitionBody,
} from "./vcrBodies";

export type {
  VcrAssumptionBody, VcrBudgetBody, VcrContactBody, VcrCreateBody, VcrDecisionBody, VcrJobBody, VcrJudgmentBody, VcrMemberBody, VcrModelBody,
  VcrPatchBody, VcrReviewBody, VcrTransitionBody,
} from "./vcrBodies";

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

/**
 * The page contract (contract 2026-09-29 §5). The server presents exactly
 * these shapes (`apps/server/src/vcrViews*.mjs`), the shared fixtures under
 * `apps/server/test/fixtures/vcr-views/` are what it sends, and the readers
 * below are what the pages read — a change here is a change to a fixture and to
 * the presenter, in one commit.
 */

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
  /** How many decimals to print; derived from the value's own error when absent. */
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
  /** What a queued step is waiting on when the allowance refused its start; it starts by itself once that is put right. */
  waiting?: "allowance" | "simulated_allowance" | null;
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
  /** On an `allowance_waiting` line: which wallet refused, so the link at its end is the right top-up. */
  waiting?: "allowance" | "simulated_allowance" | null;
  /** The link at the line's end: 「去复核」「查看缺口」. */
  action?: { label: string; tab?: VcrTabKey | null; ref?: VcrRef | null } | null;
}

/** Why a block of results is on screen greyed (plan §6.3). */
export interface VcrStaleNote {
  /** 「假设卡已变更」. */
  reason: string | null;
  /** Whether a recomputation is actually queued: the bar says 「排队重算中」 only then. */
  queued: boolean;
  since?: string | null;
}

/** 部分结果: what a run that did not finish did keep. */
export interface VcrPartial {
  done: string;
  missing: string;
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

export interface VcrReviewSummary {
  id: string; reviewerKind: "ai" | "human"; role: string; label: string; state: string;
  status: "queued" | "running" | "done" | "failed"; current: boolean;
  by?: string | null; at?: string | null; configurationRevision?: string | null;
  configuredModel?: string | null; inputDigest?: string | null; note: string;
  findings: Array<{ id?: string; kind?: string; location?: string; evidence?: string; message?: string; fix?: string; response?: string | null }>;
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

/** One section of a package as a document. */
export interface VcrPackageSection {
  id: string;
  /** 「1」「3」 — the section's own number in the document. */
  number?: string | null;
  title: string;
  body?: string | null;
  facts?: Array<{ label: string; value: string }>;
  table?: { columns: string[]; rows: string[][] } | null;
  note?: string | null;
}

/** One deliverable of a study, and — when it is opened — the package as a document. */
export interface VcrDeliverable {
  documentExportId?: string | null;
  snapshotChanged?: boolean;
  id: string;
  kind: VcrExportKind;
  title: string;
  /** 「今天 14:32 · 已生成」. */
  meta?: string | null;
  /** 「草稿」 when it is not final. */
  draft?: boolean;
  /** The run's file, when there is one to open. */
  runId?: string | null;
  path?: string | null;
  state?: "queued" | "running" | "ready" | "failed";
  /**
   * The package as a document, when the control plane renders one for reading
   * in place (plan §8.3). Without it the reader shows the cover alone and
   * offers the file.
   */
  document?: {
    reviews?: VcrReviewSummary[];
    /** The cover block: intended use, each review, outcome sealing. */
    status?: Array<{ label: string; value: string; state?: "ok" | "attention" | "neutral"; note?: string | null }>;
    sections?: VcrPackageSection[];
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
  /** Dominated by another design on the team's own goal: drawn hatched and grey, with no numbers. */
  dominated?: boolean;
  /** The letter of the design that beats it. */
  dominatedBy?: string | null;
  /** Chosen by a recorded decision — never by the platform. The brand blue. */
  chosen?: boolean;
  /** The reason a design is dominated, from the server's rule. */
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

/** The compute budget, in the unit the platform meters: CPU seconds. */
export interface VcrBudget {
  limitSeconds: number;
  usedSeconds: number;
  committedSeconds: number;
  remainingSeconds: number;
  /** Jobs waiting on a budget confirmation — the second human stop. */
  awaitingBudget: number;
}

/** Everything a job says about itself. */
export interface VcrJob {
  id: string;
  kind: string;
  /** 「方案的模拟运行」. */
  label: string;
  state: VcrJobState;
  progress?: { done: number; total: number } | null;
  /** What the job may spend; a job waiting on budget says what it would need. */
  cpuSecondsLimit?: number | null;
  cpuSecondsUsed?: number | null;
  seed?: number | null;
  replicates?: number | null;
  error?: { code: string | null; message: string | null; partial?: boolean } | null;
  updatedAt?: string | null;
  cancelable?: boolean;
}

/** The highest use this study's results may carry, and why (plan §8.2, §10.2). */
export interface VcrCeiling {
  ceiling: VcrIntendedUse;
  requested: VcrIntendedUse;
  withinCeiling: boolean;
  reasons: Array<{ code: string; detail: string }>;
}

/**
 * The move a study's frozen data supports above its own tier — said to the lead
 * who may make it (`manage_study`), once: the tier it would move to, what that
 * opens, and what the data are.
 */
export interface VcrTierOffer {
  tier: VcrDataTier;
  /** 「T1 基线与招募资料」. */
  label: string;
  /** What each tier on the way opens, in the words the plan uses. */
  unlocks: string[];
  basis: { subjects: number; treatment: boolean; outcomes: boolean };
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
  /** The tier the frozen data supports above the study's own, for the lead who may move it; null (or absent) when there is none. */
  tierOffer?: VcrTierOffer | null;
  /** The compute budget, when the module meters one. */
  budget: VcrBudget | null;
  jobs: VcrJob[];
  ceiling: VcrCeiling | null;
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
  /** Before weighting, when the row is a balance table. */
  smdBefore?: number | null;
  flagged?: boolean;
  note?: string | null;
}

/** The quality report that travels with a synthetic population: values, never a verdict (plan §5.1). */
export interface VcrQualityReport {
  /** 「合成 · 探索性」. */
  tag: string;
  groups: Array<{ key: string; label: string; rows: Array<{ key: string; label: string; value: VcrValue }> }>;
  trainingRecords: number | null;
  copies: number | null;
}

export interface VcrPopulationTab {
  /** 「人群 v3（方案 v2）」. */
  version: string | null;
  /** 「真实队列」. */
  kind?: string | null;
  versions: Array<{ id: string; label: string; stale?: boolean; counts?: VcrCounts | null }>;
  /** Two versions side by side: counts and composition, as each stored them. */
  versionCompare: {
    left: { label: string; at: string | null; counts: VcrCounts | null };
    right: { label: string; at: string | null; counts: VcrCounts | null };
    rows: Array<{ key: string; label: string; left: VcrValue | null; right: VcrValue | null }>;
  } | null;
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
  quality: VcrQualityReport | null;
  counts: VcrCounts | null;
  conclusion?: VcrConclusion | null;
  headline?: string | null;
  stale: VcrStaleNote | null;
  partial: VcrPartial | null;
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
  /** The regional population, said on its own line (plan §8.2). */
  region?: string | null;
  endpoint?: string | null;
  timeRange?: string | null;
  inputRange?: string | null;
  sources?: string | null;
  provider?: string | null;
  interface?: string | null;
  inputs?: string[];
  outputs?: string | null;
  missingData?: string | null;
  retirement?: string | null;
  /** `digital_twin` only with all four pieces of evidence (`twinLabel`). */
  twin?: "digital_twin" | "baseline_conditioned_prediction" | null;
  /** The label the model has earned, in words. */
  twinLabel?: string | null;
  twinReason?: string | null;
  validation?: Array<{ label: string; state: "passed" | "none" | "partial"; detail?: string | null }>;
  limits?: string[];
  /** The evidence its declared risk still lacks. */
  missingEvidence?: string[];
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
  /** The band's own name, when it has one: 「预测区间」. */
  bandKind?: VcrIntervalKind | null;
  /** The band's level, when the run says one: 80 for an 80% prediction interval. */
  bandLevel?: number | null;
  /** The line's end label: 「试验 −1.4%」. */
  endLabel?: string | null;
  endNote?: string | null;
  /** Thin individual trajectories drawn behind the mean. */
  individuals?: Array<Array<{ x: number; y: number | null }>>;
  dashed?: boolean;
  /** Periods nobody could observe, shaded apart from the rest. */
  unobserved?: Array<{ from: number; to: number }>;
}

export interface VcrPatientsTab {
  model: VcrModelCard | null;
  /** The label the model's output has earned: never 「数字孪生」 by default. */
  twin: { label: string; reason: string | null } | null;
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
  /** 「哪些假设影响最大」; `base` is the model's own value at default parameters. */
  sensitivity: {
    measure?: string | null;
    base?: VcrValue | null;
    rows: Array<{ label: string; range?: string | null; low: number; high: number }>;
  } | null;
  counts: VcrCounts | null;
  stale: VcrStaleNote | null;
  partial: VcrPartial | null;
  sets?: Array<{ id: string; label: string; stale?: boolean }>;
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
  dashed?: boolean;
  bandKind?: VcrIntervalKind | null;
  bandLevel?: number | null;
}

/** One of the ten FDA comparability dimensions (plan §5.3). */
export interface VcrDimension {
  key: string;
  label: string;
  state: "exact" | "approximate" | "not_simulable" | "unknown";
  reason?: string | null;
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
  /** The ten comparability dimensions, each with its state. */
  dimensions: VcrDimension[];
  /** Weight and overlap diagnostics of a weighted comparison. */
  diagnostics: Array<{ key: string; label: string; value: VcrValue }>;
  /** 「不可估计」 — the gaps, and what each one would answer. */
  gaps: { title?: string | null; needs?: string | null; items: Array<{ title: string; detail?: string | null; answers?: string | null }>; conclusion?: string | null; rule?: string | null } | null;
  counts: VcrCounts | null;
  /** 「本页结论：有限制地估计 · AI 设定 · 未复核」. */
  verdict?: { conclusion: VcrConclusion | null; review: VcrReviewState; reviewed?: boolean } | null;
  stale: VcrStaleNote | null;
  partial: VcrPartial | null;
}

/** A frozen forecast, registered before the outcome it predicts (plan §5.4, AC-23). */
export interface VcrForecast {
  id: string;
  label: string;
  version: number;
  hash: string;
  frozenAt: string | null;
  comparedAt: string | null;
  lines: Array<{ key: string; label: string; predicted: string; actual: string | null }>;
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
  powerCurve: { xLabel?: string | null; yLabel?: string | null; /** The axis is a probability shown as a percentage: `%`. */ unit?: string | null; series: VcrSeries[]; markers?: Array<{ x: number; label: string; kind?: "assumed" | "null" }>; prior?: Array<{ x: number; y: number }> } | null;
  /** The reader's own comparison goal; the platform never picks a design. */
  decision: {
    goal?: string | null;
    chosen?: string | null;
    chosenLabel?: string | null;
    rationale?: string | null;
    recordedAt?: string | null;
    options: Array<{ id: string; label: string; name?: string | null; disabled?: boolean }>;
    note?: string | null;
  } | null;
  /** 「运行记录」. */
  runRecord: Array<{ key: string; title: string; detail?: string | null; ok?: boolean }>;
  /** The forecast registry. */
  forecasts: VcrForecast[];
  /** The milestone timeline: when each design would reach its landmarks. */
  milestones: Array<{ design: string; name: string; items: Array<{ key: string; label: string; value: VcrValue }> }>;
  counts: VcrCounts | null;
  stale: VcrStaleNote | null;
  partial: VcrPartial | null;
}

/** One candidate in the matching list. */
export interface VcrCandidate {
  /** The subject's own key; also what `?candidate=` names. */
  id: string;
  /** The referral this person has, when there is one: what 「确认后联系」 confirms. */
  referralId?: string | null;
  summary: string;
  site?: string | null;
  eligibility: VcrEligibility;
  /** The rules still open on this person: 「E3 未知」「E5 待复评 10月6日」. */
  open: Array<{ code: string; state: VcrCriterionState; note?: string | null }>;
  /** The model's ranking hint, carried with its own label and never as a probability of benefit. */
  priority?: { label: string; score: number | null; rationale: string | null } | null;
}

/** One rule judged against one candidate. */
export interface VcrCriterionJudgement {
  /**
   * The criterion's own id: what a re-judgment is addressed to (the `code` is a
   * label the page derives from position). Absent, the row cannot be re-judged.
   */
  criterionId?: string | null;
  code: string;
  kind: "inclusion" | "exclusion";
  text: string;
  state: VcrCriterionState;
  /** 不适用 is its own field, never folded into 未知. */
  applicable?: boolean;
  /** The patient's own sentence, and where it is from. */
  evidence?: { quote: string; source?: string | null; at?: string | null } | null;
  /** What to ask for: 「申请近 4 周头颅 MRI」. */
  request?: string | null;
  requestNote?: string | null;
  decidedBy?: string | null;
  overridden?: boolean;
}

export interface VcrMatchingTab {
  /** The sub-tab the payload is for. */
  view: "matching" | "referral" | "sites" | "followup";
  /** False when the package is not composed here; the tab says so and nothing else waits. */
  available?: boolean;
  unavailable?: { code: string; message: string } | null;
  headline?: string | null;
  partner?: { name?: string | null; candidates?: number | null; tier?: VcrDataTier | null; snapshotAt?: string | null } | null;
  /** 「给试验找患者 | 给患者找试验」. */
  direction?: "trial_to_patient" | "patient_to_trial";
  funnel: Array<{ key: string; label: string; count: number | null; note?: string | null; tone?: "attention" | "accent" | "neutral" }>;
  candidates: VcrCandidate[];
  /** The candidate the detail panel is about. */
  selected: {
    candidate: VcrCandidate;
    /**
     * The assessment this panel is about — the newest of the person's. What a
     * re-judgment and a countersignature are addressed to; absent, neither is offered.
     */
    assessmentId?: string | null;
    facts?: Array<{ label: string; value: string; tone?: "attention" | "neutral" }>;
    criteria: VcrCriterionJudgement[];
    /** 「不能判为符合：排除标准 E3 未知」 — always the reason, never a bare no. */
    verdict?: { text: string; note?: string | null } | null;
    /** The only human stop in the module (plan §10.1). */
    canContact?: boolean;
    referralId?: string | null;
    referralState?: VcrReferralState | null;
    priority?: VcrCandidate["priority"];
    /** Whether somebody countersigned — the page offers the countersignature only where nobody has. Never shown: see `reviewedByName`. */
    reviewedBy?: string | null;
    /** Who countersigned, by name (a neutral label when the account is gone). */
    reviewedByName?: string | null;
    /** Every move on this person's referral, oldest first: to where, when, by whom — a name, never an account id (plan §7.2). */
    trace?: Array<{ state: VcrReferralState; at: string | null; by: string | null; note: string | null }>;
  } | null;
  /** The main gaps across the undecidable ones. */
  gaps: Array<{ code: string; label: string; detail?: string | null; count: number | null }>;
  /** Excluded on a model's word alone: they wait here for a person (plan §7.1). */
  pendingReview?: { count: number; subjects: string[] } | null;
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
    at?: string | null;
  } | null;
  protocol?: { version: number; title: string | null } | null;
  abilities?: { contact: boolean };
  sites?: Array<{
    id: string; name: string; place?: string | null; state: string; stateNote?: string | null;
    capacity?: string | null; competing?: string | null; referred?: number | null;
    waiting?: number | null; enrolled?: number | null; checkedAt?: string | null; alert?: string | null;
    /** What the site still lacks to take referrals, and how many contacts it has (plan §7.2). */
    needs?: string[]; contacts?: number;
  }>;
  followup?: Array<{ id: string; label: string; kind: string; detail?: string | null; at?: string | null }>;
  counts: VcrCounts | null;
}

/** One assumption card (plan §6.1). */
export interface VcrAssumption {
  id: string;
  /** The card's own key: what a new version is written under. */
  key: string;
  name: string;
  value: VcrValue;
  /** 「7 项 · 预测区间 3.0–5.6」. */
  summary?: string | null;
  /** One of the assumptions the study's designs rest on. */
  isKey?: boolean;
  version?: number | null;
  /** 「外部证据」 — the five kinds of source, apart from the nine value sources. */
  sourceType?: string | null;
  sourceKind?: string | null;
  /** Who the value was measured on, and how the study differs. */
  applicability?: string | null;
  sensitivity?: string | null;
  /** Who countersigned which version, and when. */
  review?: { by?: string | null; at?: string | null; version?: number | null; kind?: string | null } | null;
  /** What an edit starts from. */
  edit?: { pointValue: number | null; unit?: string | null; note?: string | null; endpoint?: string | null; applicability?: Record<string, unknown> } | null;
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

/** One precedent trial (plan §6.4): planned and actual apart, the raw text beside the normalised value. */
export interface VcrPrecedent {
  id: string;
  registryId: string;
  registry?: string | null;
  title?: string | null;
  population?: string | null;
  design?: string | null;
  planned?: number | null;
  actual?: number | null;
  sites?: number | null;
  plannedMonths?: number | null;
  actualMonths?: number | null;
  perSitePerMonth?: number | null;
  usedFor?: string | null;
  countries?: string[];
  eligibilityText?: string | null;
  interventions?: string[];
  endpoints?: string[];
  hasResults?: boolean;
  enrollmentKind?: string | null;
  source?: string | null;
}

export interface VcrDataTab {
  registryCoverage?: VcrRegistrySource[];
  reviews?: VcrReviewSummary[];
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
  snapshots: Array<{ id: string; label: string; at?: string | null; rows?: number | null; quality?: Array<{ label: string; value: string; passed?: boolean }> }>;
  decisions?: Array<{ id: string; at: string | null; text: string }>;
  /** Said only where the evidence side is not composed: an empty list must not read as 「没有证据」. */
  evidenceNote?: string | null;
}

/** The cross-study model library (`GET /api/vcr/models`). */
export interface VcrModels {
  models: VcrModelCard[];
  /** The method packages, which are not models. */
  methods: Array<{ id: string; name: string; /** The engine's own method id. */ method?: string; version?: string | null; endpoints?: string | null; numeric?: string | null; usedIn?: string | null;
    assumptions?: Array<{ text: string; source: string }>;
    validation?: { status: 'passed' | 'unmeasured'; reason?: string; ciUrl?: string; completedAt?: string; sourceRevision?: string } }>;
  /** The credibility ladder: what each model risk needs, and what it may claim. */
  ladder?: Array<{ risk: VcrModelRisk; needs: string; ceiling: VcrIntendedUse; count?: number | null }>;
  engineAvailable?: boolean;
  engineMismatch?: string[] | null;
}

/** The precedent search's answer (`GET /api/vcr/precedents`). */
export interface VcrRegistrySource {
  key: string; label: string; configured: boolean;
  coverage: 'structured' | 'list_only' | 'unsupported';
  availability: 'not_queried' | 'available' | 'unavailable'; reason: string | null; lastCheckedAt: string | null;
}

export interface VcrPrecedents {
  registryCoverage?: VcrRegistrySource[];
  /** False when the library is not composed here: `message` says so, and the table must not read as 「没有先例」. */
  available: boolean;
  message: string | null;
  precedents: VcrPrecedent[];
  sources?: string | null;
}

/* ------------------------------------------------------------------- readers */

const VALUE_SOURCES: ReadonlySet<string> = new Set([
  "observed", "extracted", "calculated", "imputed", "aggregate", "reconstructed", "predicted", "assumed", "synthetic",
]);
const INTERVAL_KINDS: ReadonlySet<string> = new Set(["confidence", "credible", "prediction", "monte_carlo"]);
const REVIEW_STATES: ReadonlySet<string> = new Set(["ai_set", "reviewed", "changed_after_review"]);

type Loose = Record<string, unknown>;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function obj(value: unknown): Loose {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Loose : {};
}

function arr(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Loose[] : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
    detail: detail ? { ...detail, fields: arr(detail.fields) as unknown as Array<{ label: string; value: string }> } : null,
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

function readStale(raw: unknown): VcrStaleNote | null {
  const value = obj(raw);
  if (!Object.keys(value).length) return null;
  return { reason: text(value.reason), queued: value.queued === true, since: text(value.since) };
}

function readPartial(raw: unknown): VcrPartial | null {
  const value = obj(raw);
  return text(value.done) || text(value.missing) ? { done: text(value.done) ?? "", missing: text(value.missing) ?? "" } : null;
}

function readMetric(raw: unknown): VcrMetric {
  const value = obj(raw);
  return {
    key: text(value.key) ?? "",
    label: text(value.label) ?? "",
    value: readVcrValue(value.value),
    note: text(value.note),
    lead: value.lead === true,
  };
}

function readDesign(raw: unknown): VcrDesign {
  const value = obj(raw);
  const measures = obj(value.measures);
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

function readAttention(raw: unknown): VcrAttention[] {
  return arr(raw).filter((item) => typeof item.text === "string") as unknown as VcrAttention[];
}

function readOverview(raw: unknown): VcrOverview {
  const value = obj(raw);
  return {
    headline: text(value.headline),
    metrics: arr(value.metrics).map(readMetric),
    counts: readVcrCounts(value.counts),
    designs: arr(value.designs).map(readDesign),
    attention: readAttention(value.attention),
    changes: arr(value.changes).filter((item) => typeof item.text === "string") as unknown as VcrChange[],
    deliverables: arr(value.deliverables).filter((item) => typeof item.title === "string") as unknown as VcrDeliverable[],
  };
}

function readSteps(raw: unknown): VcrSteps {
  return raw && typeof raw === "object" ? raw as VcrSteps : {};
}

function readTierOffer(raw: unknown): VcrTierOffer | null {
  const value = obj(raw);
  const tier = text(value.tier);
  if (tier !== "T1" && tier !== "T2" && tier !== "T3") return null;
  const basis = obj(value.basis);
  return {
    tier, label: text(value.label) ?? tier, unlocks: strings(value.unlocks),
    basis: { subjects: finite(basis.subjects) ?? 0, treatment: basis.treatment === true, outcomes: basis.outcomes === true },
  };
}

export function readVcrStudy(raw: unknown): VcrStudy {
  const value = obj(raw);
  return {
    ...(value as unknown as VcrStudy),
    steps: readSteps(value.steps),
    abilities: strings(value.abilities),
    tierOffer: readTierOffer(value.tierOffer),
    budget: value.budget && typeof value.budget === "object" ? value.budget as VcrBudget : null,
    jobs: arr(value.jobs) as unknown as VcrJob[],
    ceiling: value.ceiling && typeof value.ceiling === "object"
      ? { ...(value.ceiling as VcrCeiling), reasons: arr(obj(value.ceiling).reasons) as unknown as VcrCeiling["reasons"] } : null,
    sessionId: text(value.sessionId),
    overview: readOverview(value.overview),
  };
}

export function readVcrSummary(raw: unknown): VcrStudySummary {
  const value = obj(raw);
  return {
    ...(value as unknown as VcrStudySummary),
    steps: readSteps(value.steps),
    conclusion: value.conclusion && typeof value.conclusion === "object" ? value.conclusion as VcrStudySummary["conclusion"] : null,
    attention: readAttention(value.attention),
  };
}

export function readVcrHome(raw: unknown): VcrHome {
  const value = obj(raw);
  return {
    studies: arr(value.studies).map(readVcrSummary),
    ...(Array.isArray(value.todos) ? { todos: arr(value.todos) as unknown as VcrRecruitTodo[] } : {}),
    ...(Array.isArray(value.reviews) ? { reviews: arr(value.reviews) as unknown as VcrReviewNote[] } : {}),
  };
}

function readProfileRow(raw: unknown): VcrProfileRow {
  const value = obj(raw);
  return {
    key: text(value.key) ?? "",
    label: text(value.label) ?? "",
    ours: readVcrValue(value.ours),
    theirs: readVcrValue(value.theirs),
    smd: finite(value.smd),
    smdBefore: finite(value.smdBefore),
    flagged: value.flagged === true,
    note: text(value.note),
  };
}

function readSeries(raw: unknown): VcrSeries[] {
  return arr(raw).map((item) => ({ ...(item as unknown as VcrSeries), points: arr(item.points) as unknown as VcrSeries["points"] }));
}

function readCurves(raw: unknown): VcrCurve[] {
  return arr(raw).map((item) => ({ ...(item as unknown as VcrCurve), points: arr(item.points) as unknown as VcrCurve["points"] }));
}

export function readVcrModelCard(raw: unknown): VcrModelCard {
  const value = obj(raw);
  return {
    ...(value as unknown as VcrModelCard),
    inputs: strings(value.inputs),
    validation: arr(value.validation) as unknown as VcrModelCard["validation"],
    limits: strings(value.limits),
    missingEvidence: strings(value.missingEvidence),
    usedBy: arr(value.usedBy) as unknown as VcrModelCard["usedBy"],
  };
}

export function readVcrPopulation(raw: unknown): VcrPopulationTab {
  const value = obj(raw);
  const compare = obj(value.versionCompare);
  const quality = obj(value.quality);
  return {
    ...(value as unknown as VcrPopulationTab),
    versions: arr(value.versions).map((item) => ({ ...(item as unknown as VcrPopulationTab["versions"][number]), counts: readVcrCounts(item.counts) })),
    versionCompare: Object.keys(compare).length ? {
      left: { label: text(obj(compare.left).label) ?? "", at: text(obj(compare.left).at), counts: readVcrCounts(obj(compare.left).counts) },
      right: { label: text(obj(compare.right).label) ?? "", at: text(obj(compare.right).at), counts: readVcrCounts(obj(compare.right).counts) },
      rows: arr(compare.rows).map((row) => ({
        key: text(row.key) ?? "", label: text(row.label) ?? "",
        left: row.left ? readVcrValue(row.left) : null, right: row.right ? readVcrValue(row.right) : null,
      })),
    } : null,
    criteria: arr(value.criteria) as unknown as VcrCriterion[],
    attrition: arr(value.attrition) as unknown as VcrAttritionStep[],
    outcome: value.outcome && typeof value.outcome === "object" ? value.outcome as VcrPopulationTab["outcome"] : null,
    profile: arr(value.profile).map(readProfileRow),
    unknownReasons: arr(value.unknownReasons) as unknown as VcrPopulationTab["unknownReasons"],
    blockers: arr(value.blockers) as unknown as VcrPopulationTab["blockers"],
    quality: Object.keys(quality).length ? {
      tag: text(quality.tag) ?? "",
      groups: arr(quality.groups).map((group) => ({
        key: text(group.key) ?? "", label: text(group.label) ?? "",
        rows: arr(group.rows).map((row) => ({ key: text(row.key) ?? "", label: text(row.label) ?? "", value: readVcrValue(row.value) })),
      })),
      trainingRecords: finite(quality.trainingRecords),
      copies: finite(quality.copies),
    } : null,
    counts: readVcrCounts(value.counts),
    stale: readStale(value.stale),
    partial: readPartial(value.partial),
  };
}

export function readVcrPatients(raw: unknown): VcrPatientsTab {
  const value = obj(raw);
  const trajectories = obj(value.trajectories);
  const example = obj(value.example);
  const sensitivity = obj(value.sensitivity);
  return {
    ...(value as unknown as VcrPatientsTab),
    model: value.model ? readVcrModelCard(value.model) : null,
    twin: value.twin && typeof value.twin === "object" ? value.twin as VcrPatientsTab["twin"] : null,
    trajectories: Object.keys(trajectories).length ? {
      xLabel: text(trajectories.xLabel), yLabel: text(trajectories.yLabel), ticks: strings(trajectories.ticks), series: readSeries(trajectories.series),
    } : null,
    example: Object.keys(example).length ? {
      ...(example as unknown as NonNullable<VcrPatientsTab["example"]>),
      baseline: arr(example.baseline) as unknown as NonNullable<VcrPatientsTab["example"]>["baseline"],
      scenarios: example.scenarios && typeof example.scenarios === "object"
        ? { ...(example.scenarios as Loose), series: readSeries(obj(example.scenarios).series) } as NonNullable<VcrPatientsTab["example"]>["scenarios"] : null,
    } : null,
    panels: arr(value.panels).map((panel) => ({
      ...(panel as unknown as VcrPatientsTab["panels"][number]),
      rows: arr(panel.rows).map((row) => ({ label: text(row.label) ?? "", value: readVcrValue(row.value) })),
      series: readSeries(panel.series),
    })),
    sensitivity: Object.keys(sensitivity).length ? {
      measure: text(sensitivity.measure),
      base: sensitivity.base ? readVcrValue(sensitivity.base) : null,
      rows: arr(sensitivity.rows) as unknown as NonNullable<VcrPatientsTab["sensitivity"]>["rows"],
    } : null,
    counts: readVcrCounts(value.counts),
    stale: readStale(value.stale),
    partial: readPartial(value.partial),
    sets: arr(value.sets) as unknown as VcrPatientsTab["sets"],
  };
}

export function readVcrComparator(raw: unknown): VcrComparatorTab {
  const value = obj(raw);
  const rmst = obj(value.rmst);
  const gaps = obj(value.gaps);
  const verdict = obj(value.verdict);
  return {
    ...(value as unknown as VcrComparatorTab),
    routes: arr(value.routes) as unknown as VcrRoute[],
    curves: readCurves(value.curves),
    rmst: Object.keys(rmst).length ? { value: readVcrValue(rmst.value), tau: finite(rmst.tau), label: text(rmst.label) } : null,
    median: value.median ? readVcrValue(value.median) : null,
    qc: arr(value.qc) as unknown as VcrComparatorTab["qc"],
    methods: arr(value.methods) as unknown as VcrComparatorTab["methods"],
    e10: arr(value.e10) as unknown as VcrComparatorTab["e10"],
    estimand: value.estimand && typeof value.estimand === "object"
      ? { ...(value.estimand as Loose), rows: arr(obj(value.estimand).rows) } as VcrComparatorTab["estimand"] : null,
    comparability: arr(value.comparability).map(readProfileRow),
    dimensions: arr(value.dimensions) as unknown as VcrDimension[],
    diagnostics: arr(value.diagnostics).map((row) => ({ key: text(row.key) ?? "", label: text(row.label) ?? "", value: readVcrValue(row.value) })),
    gaps: Object.keys(gaps).length ? { ...(gaps as Loose), items: arr(gaps.items) } as VcrComparatorTab["gaps"] : null,
    counts: readVcrCounts(value.counts),
    verdict: Object.keys(verdict).length ? verdict as unknown as VcrComparatorTab["verdict"] : null,
    stale: readStale(value.stale),
    partial: readPartial(value.partial),
  };
}

export function readVcrTrial(raw: unknown): VcrTrialTab {
  const value = obj(raw);
  const power = obj(value.powerCurve);
  const grid = obj(value.grid);
  const decision = obj(value.decision);
  return {
    ...(value as unknown as VcrTrialTab),
    ademp: arr(value.ademp) as unknown as VcrTrialTab["ademp"],
    designs: arr(value.designs).map(readDesign),
    columns: arr(value.columns) as unknown as VcrTrialTab["columns"],
    grid: Object.keys(grid).length ? {
      ...(grid as Loose), columns: arr(grid.columns),
      rows: arr(grid.rows).map((row) => ({ ...(row as Loose), cells: arr(row.cells) })),
    } as VcrTrialTab["grid"] : null,
    footnotes: strings(value.footnotes),
    powerCurve: Object.keys(power).length ? { ...(power as Loose), series: readSeries(power.series), markers: arr(power.markers), prior: arr(power.prior) } as VcrTrialTab["powerCurve"] : null,
    decision: Object.keys(decision).length ? { ...(decision as Loose), options: arr(decision.options) } as VcrTrialTab["decision"] : null,
    runRecord: arr(value.runRecord) as unknown as VcrTrialTab["runRecord"],
    forecasts: arr(value.forecasts).map((row) => ({ ...(row as unknown as VcrForecast), lines: arr(row.lines) as unknown as VcrForecast["lines"] })),
    milestones: arr(value.milestones).map((row) => ({
      design: text(row.design) ?? "", name: text(row.name) ?? "",
      items: arr(row.items).map((item) => ({ key: text(item.key) ?? "", label: text(item.label) ?? "", value: readVcrValue(item.value) })),
    })),
    counts: readVcrCounts(value.counts),
    stale: readStale(value.stale),
    partial: readPartial(value.partial),
  };
}

export function readVcrMatching(raw: unknown): VcrMatchingTab {
  const value = obj(raw);
  const selected = obj(value.selected);
  const forecast = obj(value.forecast);
  return {
    ...(value as unknown as VcrMatchingTab),
    view: (["matching", "referral", "sites", "followup"].includes(String(value.view)) ? value.view : "matching") as VcrMatchingTab["view"],
    unavailable: value.unavailable && typeof value.unavailable === "object" ? value.unavailable as VcrMatchingTab["unavailable"] : null,
    funnel: arr(value.funnel) as unknown as VcrMatchingTab["funnel"],
    candidates: arr(value.candidates).map((item) => ({ ...(item as unknown as VcrCandidate), open: arr(item.open) as unknown as VcrCandidate["open"] })),
    selected: Object.keys(selected).length && selected.candidate ? {
      ...(selected as unknown as NonNullable<VcrMatchingTab["selected"]>),
      candidate: { ...(selected.candidate as unknown as VcrCandidate), open: arr(obj(selected.candidate).open) as unknown as VcrCandidate["open"] },
      facts: arr(selected.facts) as unknown as NonNullable<VcrMatchingTab["selected"]>["facts"],
      criteria: arr(selected.criteria) as unknown as VcrCriterionJudgement[],
      trace: arr(selected.trace) as unknown as NonNullable<NonNullable<VcrMatchingTab["selected"]>["trace"]>,
    } : null,
    gaps: arr(value.gaps) as unknown as VcrMatchingTab["gaps"],
    pendingReview: value.pendingReview && typeof value.pendingReview === "object" ? value.pendingReview as VcrMatchingTab["pendingReview"] : null,
    ledger: arr(value.ledger) as unknown as VcrMatchingTab["ledger"],
    forecast: Object.keys(forecast).length ? {
      ...(forecast as Loose),
      rows: arr(forecast.rows).map(readMetric), basis: strings(forecast.basis),
      xLabels: strings(forecast.xLabels), actual: arr(forecast.actual), median: arr(forecast.median), band: arr(forecast.band), markers: arr(forecast.markers),
    } as VcrMatchingTab["forecast"] : null,
    sites: arr(value.sites) as unknown as VcrMatchingTab["sites"],
    followup: arr(value.followup) as unknown as VcrMatchingTab["followup"],
    counts: readVcrCounts(value.counts),
  };
}

export function readVcrData(raw: unknown): VcrDataTab {
  const value = obj(raw);
  return {
    ...(value as unknown as VcrDataTab),
    status: arr(value.status) as unknown as VcrDataTab["status"],
    assumptions: arr(value.assumptions).map((card) => ({
      ...(card as unknown as VcrAssumption),
      value: readVcrValue(card.value),
      detail: card.detail && typeof card.detail === "object" ? {
        ...(card.detail as Loose), stats: arr(obj(card.detail).stats), forest: arr(obj(card.detail).forest),
        usedBy: arr(obj(card.detail).usedBy), versions: arr(obj(card.detail).versions),
      } as VcrAssumption["detail"] : null,
    })),
    precedents: arr(value.precedents) as unknown as VcrPrecedent[],
    snapshots: arr(value.snapshots).map((snapshot) => ({ ...(snapshot as unknown as VcrDataTab["snapshots"][number]), quality: arr(snapshot.quality) as unknown as NonNullable<VcrDataTab["snapshots"][number]["quality"]> })),
    decisions: arr(value.decisions) as unknown as VcrDataTab["decisions"],
    evidenceNote: text(value.evidenceNote),
  };
}

export function readVcrModels(raw: unknown): VcrModels {
  const value = obj(raw);
  return {
    ...(value as unknown as VcrModels),
    models: arr(value.models).map(readVcrModelCard),
    methods: arr(value.methods) as unknown as VcrModels["methods"],
    ladder: arr(value.ladder) as unknown as VcrModels["ladder"],
    engineMismatch: Array.isArray(value.engineMismatch) ? strings(value.engineMismatch) : null,
  };
}

export function readVcrPrecedents(raw: unknown): VcrPrecedents {
  const value = obj(raw);
  return {
    available: value.available !== false,
    message: text(value.message),
    precedents: arr(value.precedents) as unknown as VcrPrecedent[],
    registryCoverage: arr(value.registryCoverage) as unknown as VcrRegistrySource[],
    sources: text(value.sources),
  };
}

export function readVcrDeliverable(raw: unknown): VcrDeliverable {
  const value = obj(raw);
  const document = obj(value.document);
  return {
    ...(value as unknown as VcrDeliverable),
    document: Object.keys(document).length ? {
      status: arr(document.status) as unknown as NonNullable<VcrDeliverable["document"]>["status"],
      sections: arr(document.sections).map((section) => ({
        ...(section as unknown as VcrPackageSection), facts: arr(section.facts) as unknown as VcrPackageSection["facts"],
        table: section.table && typeof section.table === "object"
          ? { columns: strings(obj(section.table).columns), rows: (Array.isArray(obj(section.table).rows) ? obj(section.table).rows as unknown[] : []).map((row) => strings(row)) } : null,
      })),
    } : null,
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
  return readVcrHome(await productRequest<unknown>("/vcr/studies"));
}

/** 「新建研究」 and the four action cards: the study, its project and its conversation. */
export function createVcrStudy(input: VcrCreateBody = {}) {
  return productRequest<{ id: string; projectId: string; sessionId: string | null }>("/vcr/studies", "POST", studyCreateBody(input));
}

export async function getVcrStudy(studyId: string): Promise<VcrStudy> {
  return readVcrStudy(await productRequest<unknown>(study(studyId)));
}

export function patchVcrStudy(studyId: string, input: VcrPatchBody) {
  return productRequest<unknown>(study(studyId), "PATCH", studyPatchBody(input));
}

export function deleteVcrStudy(studyId: string) {
  return productRequest<unknown>(study(studyId), "DELETE");
}

/** One tab's payload. The tab key is the route's own word (contract §3.1). */
export function getVcrTab<T>(studyId: string, tab: Exclude<VcrTabKey, "overview">, query: Record<string, string> = {}): Promise<T> {
  const search = new URLSearchParams(query).toString();
  return productRequest<T>(`${study(studyId)}/${tab}${search ? `?${search}` : ""}`);
}

const tabReader = <T>(tab: Exclude<VcrTabKey, "overview">, read: (raw: unknown) => T) =>
  async (studyId: string, query?: Record<string, string>): Promise<T> => read(await getVcrTab<unknown>(studyId, tab, query));

export const getVcrPopulation = tabReader("population", readVcrPopulation);
export const getVcrPatients = tabReader("patients", readVcrPatients);
export const getVcrComparator = tabReader("comparator", readVcrComparator);
export const getVcrTrial = tabReader("trial", readVcrTrial);
export const getVcrMatching = tabReader("matching", readVcrMatching);
export const getVcrData = tabReader("data", readVcrData);

/** 「让 AI 做」: dispatches one step now, in the study's own conversation. */
export function runVcrStep(studyId: string, step: VcrStepKey) {
  return productRequest<VcrRunAnswer>(`${study(studyId)}/run`, "POST", runBody(step));
}

/** A deterministic computation, queued directly (contract §3.1, §4). */
export function queueVcrJob(studyId: string, input: VcrJobBody) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs`, "POST", jobBody(input));
}

export function getVcrJob(studyId: string, jobId: string) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs/${id(jobId)}`);
}

export function cancelVcrJob(studyId: string, jobId: string) {
  return productRequest<VcrJob>(`${study(studyId)}/jobs/${id(jobId)}/cancel`, "POST", cancelBody());
}

/**
 * The second of the three human stops: more compute than the study's budget.
 * `{ jobId }` releases one waiting job; `{ cpuSeconds }` adds that much CPU
 * time and releases everything that was waiting on it.
 */
export function confirmVcrBudget(studyId: string, input: VcrBudgetBody) {
  return productRequest<{ released: unknown[]; budget: VcrBudget | null }>(`${study(studyId)}/budget`, "POST", budgetBody(input));
}

/** A new version of one assumption card; downstream results go stale by lineage. */
export function saveVcrAssumption(studyId: string, input: VcrAssumptionBody) {
  return productRequest<{ id: string; key: string; version: number }>(`${study(studyId)}/assumptions`, "POST", assumptionBody(input));
}

/** 「签注复核」: a countersignature on named versions, never a gate (plan §10.2). */
export function signVcrReview(studyId: string, input: VcrReviewBody) {
  return productRequest<unknown>(`${study(studyId)}/reviews`, "POST", reviewBody(input));
}

/** 「写入决策记录」: the reader's comparison goal and the design they chose. */
export function recordVcrDecision(studyId: string, input: VcrDecisionBody) {
  return productRequest<unknown>(`${study(studyId)}/decisions`, "POST", decisionBody(input));
}

/** 「导出」: the package is a run in the study's conversation; a deferred run answers `runId: null`. */
export function exportVcrStudy(studyId: string, kind: VcrExportKind) {
  return productRequest<VcrRunAnswer>(`${study(studyId)}/export`, "POST", exportBody(kind));
}

export async function getVcrExport(studyId: string, exportId: string): Promise<VcrDeliverable> {
  return readVcrDeliverable(await productRequest<unknown>(`${study(studyId)}/export/${id(exportId)}`));
}

export async function getVcrModels(): Promise<VcrModels> {
  return readVcrModels(await productRequest<unknown>("/vcr/models"));
}

/** Take a literature model into the account's library; its tier is set by the server, never by the page. */
export function adoptVcrModel(input: VcrModelBody) {
  return productRequest<{ id: string; name?: string }>("/vcr/models", "POST", modelBody(input));
}

/** The precedent library: `q` is the server's own query word. */
export async function getVcrPrecedents(query: { q?: string; limit?: number } = {}): Promise<VcrPrecedents> {
  const search = new URLSearchParams();
  if (query.q) search.set("q", query.q);
  if (query.limit) search.set("limit", String(query.limit));
  const suffix = search.toString();
  return readVcrPrecedents(await productRequest<unknown>(`/vcr/precedents${suffix ? `?${suffix}` : ""}`));
}

/** One account on a study: the owner (always the lead) and everyone the lead added, with the roles each holds. */
export interface VcrMember {
  userId: string;
  /** The study's owner, who is the lead by being the owner and is not a row that can be removed. */
  owner: boolean;
  roles: VcrMemberRole[];
  roleLabels: string[];
  /** The member's name — what the page shows. The account id is for the remove call, never for a reader. */
  name?: string | null;
  invitedBy?: string | null;
  createdAt?: string | null;
}

export function readVcrMembers(raw: unknown): VcrMember[] {
  return arr(obj(raw).members).map((item) => ({
    userId: text(item.userId) ?? "",
    name: text(item.name),
    owner: item.owner === true,
    roles: strings(item.roles) as VcrMemberRole[],
    roleLabels: strings(item.roleLabels),
    invitedBy: text(item.invitedBy),
    createdAt: text(item.createdAt),
  })).filter((member) => member.userId);
}

export async function getVcrMembers(studyId: string): Promise<VcrMember[]> {
  return readVcrMembers(await productRequest<unknown>(`${study(studyId)}/members`));
}

/** Give an account a role. Idempotent: a role it already holds changes nothing. */
export function setVcrMembers(studyId: string, input: VcrMemberBody) {
  return productRequest<unknown>(`${study(studyId)}/members`, "POST", memberBody(input));
}

/**
 * Take one role away from an account. The role is named in the query, so a
 * person who is both the site and the clinical reviewer keeps the other one;
 * without `role` the route removes every role the account holds.
 */
export function removeVcrMember(studyId: string, userId: string, role?: VcrMemberRole) {
  return productRequest<unknown>(`${study(studyId)}/members/${id(userId)}${role ? `?role=${encodeURIComponent(role)}` : ""}`, "DELETE");
}

/**
 * The first of the three human stops: a coordinator confirms, person by
 * person, before anyone outside the platform is contacted (plan §10.1). The id
 * is the person's referral, not the candidate's key.
 */
export function contactVcrReferral(studyId: string, referralId: string, input: VcrContactBody = {}) {
  return productRequest<unknown>(`${study(studyId)}/referrals/${id(referralId)}/contact`, "POST", contactBody(input));
}

/**
 * One move on the referral ledger — 「请求补证」 is `to: "needs_evidence"`. The
 * route refuses a move into a contact state that no person has confirmed, and
 * a site moves only its own referrals; this is not a way round either.
 */
export function transitionVcrReferral(studyId: string, referralId: string, input: VcrTransitionBody) {
  return productRequest<{ referral: { id: string; state: VcrReferralState } | null; notices?: string[] }>(
    `${study(studyId)}/referrals/${id(referralId)}/transition`, "POST", transitionBody(input));
}

/** One row of the referral ledger, as the ledger route answers it. */
export interface VcrReferral {
  id: string;
  subjectKey: string;
  state: VcrReferralState;
  siteId: string | null;
  assessmentId: string | null;
  /** The account that confirmed the contact, once one did (the first human stop): whether one did. Shown as `contactApprovedByName`. */
  contactApprovedBy: string | null;
  /** The coordinator who confirmed, by name (a neutral label when the account is gone). */
  contactApprovedByName: string | null;
  contactApprovedAt: string | null;
  screenFailReason: string | null;
  enrolledOn: string | null;
  updatedAt: string | null;
}

export function readVcrReferrals(raw: unknown): VcrReferral[] {
  return arr(obj(raw).referrals).map((entry) => {
    const row = obj(entry);
    return {
      id: String(row.id ?? ""), subjectKey: String(row.subjectKey ?? ""), state: String(row.state ?? "candidate") as VcrReferralState,
      siteId: text(row.siteId), assessmentId: text(row.assessmentId), contactApprovedBy: text(row.contactApprovedBy),
      contactApprovedByName: text(row.contactApprovedByName), contactApprovedAt: text(row.contactApprovedAt), screenFailReason: text(row.screenFailReason), enrolledOn: text(row.enrolledOn),
      updatedAt: text(row.updatedAt),
    };
  }).filter((row) => row.id !== "");
}

/**
 * The referral ledger: every referral the caller may read — a site sees only its
 * own — one row per person, at the state the ledger holds them in.
 */
export async function getVcrReferrals(studyId: string, query: { state?: VcrReferralState } = {}): Promise<VcrReferral[]> {
  const search = query.state ? `?state=${encodeURIComponent(query.state)}` : "";
  return readVcrReferrals(await productRequest<unknown>(`${study(studyId)}/referrals${search}`));
}

/**
 * A coordinator's or clinician's re-judgment of one criterion. The platform's
 * own answer stays beside the person's — the pair is the evaluation case — and
 * a run never does this; only a person, as themselves.
 */
export function overrideVcrJudgment(studyId: string, assessmentId: string, criterionId: string, input: VcrJudgmentBody) {
  return productRequest<unknown>(
    `${study(studyId)}/assessments/${id(assessmentId)}/judgments/${id(criterionId)}/override`, "POST", judgmentBody(input));
}

/** A reviewer's countersignature on one assessment: a signature, never a gate. */
export function reviewVcrAssessment(studyId: string, assessmentId: string) {
  return productRequest<unknown>(`${study(studyId)}/assessments/${id(assessmentId)}/review`, "POST", assessmentReviewBody());
}

/** What 「让 AI 做」 and an export answer: the conversation, and the run — or the sentence that it is queued behind another. */
export interface VcrRunAnswer {
  sessionId?: string | null;
  runId?: string | null;
  /** Set when the run could not start now and waits for the one before it. */
  deferred?: string | null;
  /** The package row of an export. */
  export?: { id?: string } | null;
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

// ---- data intake ----------------------------------------------------------------
// The browser's side of `/api/vcr/studies/:id/data/*` (contract 2026-09-29 §6):
// source → files → field map → snapshot → tables → grants, and the seal's two
// timestamps. The server presents the whole block (`presentIntake`); the reader
// is total over what it might send. Bodies are built by `vcrIntakeBodies.ts`,
// which is exactly the routes' allow-lists.

import { fetchWithWebAuth, webApiBase } from "./apiClient";
import {
  confirmFieldMapBody, fieldMapBody, freezeBody, grantBody, sourceBody, uploadQuery,
  type VcrFieldMapEntry, type VcrGrantBody, type VcrSourceBody,
} from "./vcrIntakeBodies";

export type { VcrFieldMapEntry, VcrFieldRole, VcrGrantBody, VcrSourceBody } from "./vcrIntakeBodies";

export interface VcrIntakeOption { value: string; label: string }

export interface VcrIntakeFile {
  id: string;
  name: string;
  role: "data" | "dictionary" | "document";
  roleLabel: string;
  format: string;
  size: string | null;
  rows: number | null;
  columnCount: number | null;
  at: string | null;
  /** For a data file: whether it is the newest upload of its name, the one a snapshot takes. */
  latest: boolean | null;
  columns: Array<{ name: string; type: string | null; filled: number | null; distinct: number | null; identifying: boolean }>;
  entries: number | null;
  sheets: string[];
  sheetUsed: string | null;
  subjectKey: string | null;
  visibleAt: string | null;
  /** A record converted from a PDF or Word file: what it was, its pages, and how many of them had no text layer. */
  sourceFormat: string | null;
  pages: number | null;
  blankPages: number | null;
}

export interface VcrIntakeIssue { code: string; message: string; table: string | null; column: string | null }

export interface VcrIntakeGrant {
  id: string;
  grantee: string;
  granteeLabel: string;
  role: string | null;
  fields: string[];
  fieldMode: "allow" | "deny";
  window: string | null;
  purposes: string[];
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string | null;
}

export interface VcrIntakeSource {
  id: string;
  name: string;
  ownerParty: string | null;
  mine: boolean;
  /** False when the viewer holds no grant on this source: its name and state are shown, its columns are not. */
  readable: boolean;
  canGrant: boolean;
  status: string;
  statusLabel: string;
  valueSource: string;
  valueSourceLabel: string;
  allowedUses: string[];
  window: string | null;
  retention: string | null;
  upload: {
    formats: string[]; maxBytes: number | null; maxText: string | null;
    /** A patient record: text, and PDF or Word where the deployment converts them (the page offers only what would be taken). */
    documents: { formats: string[]; maxBytes: number | null; maxText: string | null; converter: boolean };
  };
  files: VcrIntakeFile[];
  fieldMap: {
    state: "none" | "proposed" | "confirmed";
    stateLabel: string;
    hash: string | null;
    by: string | null;
    confirmedBy: string | null;
    /** Who confirmed the map, by name (a neutral label when the account is gone). */
    confirmedByName: string | null;
    confirmedAt: string | null;
    columns: VcrFieldMapEntry[];
    issues: VcrIntakeIssue[];
  };
  grants: VcrIntakeGrant[];
}

export interface VcrIntakeTable {
  shape: string;
  label: string;
  rows: number | null;
  columns: string[];
  issues: number;
  outcomeBearing: boolean;
}

export interface VcrIntakeSnapshot {
  id: string;
  sourceId: string;
  version: number | null;
  label: string;
  at: string | null;
  rows: number | null;
  columnCount: number | null;
  valueSource: string | null;
  files: string[];
  sealed: boolean;
  sealedFields: string[];
  sealedUntil: string | null;
  findings: number | null;
  /** The five quality categories with how many findings each holds. */
  quality: Array<{ label: string; value: string; passed: boolean }>;
  tables: VcrIntakeTable[];
}

export interface VcrIntakeSeal {
  required: boolean;
  /** When the analysis plan was frozen — the instant the outcome seal lifts. */
  planFrozenAt: string | null;
  /** When an outcome field was first read: the second timestamp the package cover prints. */
  outcomeFirstReadAt: string | null;
  ordered: boolean;
  fields: string[];
  fieldsRead: string[];
  note: string | null;
}

export interface VcrIntake {
  available: boolean;
  /** Said when the plane is not there: why, and what to do. */
  message: string | null;
  formats: string[];
  maxBytes: number | null;
  canManage: boolean;
  seal: VcrIntakeSeal | null;
  options: { roles: VcrIntakeOption[]; timeKinds: VcrIntakeOption[]; missingReasons: VcrIntakeOption[]; valueSources: VcrIntakeOption[]; memberRoles: VcrIntakeOption[] };
  sources: VcrIntakeSource[];
  snapshots: VcrIntakeSnapshot[];
}

// `VcrDataTab` gains the intake block; declaration merging keeps the earlier interface as it is.
export interface VcrDataTab {
  intake?: VcrIntake | null;
}

function intakeOptions(raw: unknown): VcrIntakeOption[] {
  return arr(raw).map((option) => ({ value: text(option.value) ?? "", label: text(option.label) ?? "" })).filter((option) => option.value);
}

function readIntakeFile(raw: Loose): VcrIntakeFile {
  const role = text(raw.role);
  return {
    id: text(raw.id) ?? "", name: text(raw.name) ?? "", role: role === "dictionary" || role === "document" ? role : "data",
    roleLabel: text(raw.roleLabel) ?? "", format: text(raw.format) ?? "", size: text(raw.size), rows: finite(raw.rows),
    columnCount: finite(raw.columnCount), at: text(raw.at), latest: typeof raw.latest === "boolean" ? raw.latest : null,
    columns: arr(raw.columns).map((column) => ({
      name: text(column.name) ?? "", type: text(column.type), filled: finite(column.filled), distinct: finite(column.distinct), identifying: column.identifying === true,
    })),
    entries: finite(raw.entries), sheets: strings(raw.sheets), sheetUsed: text(raw.sheetUsed), subjectKey: text(raw.subjectKey), visibleAt: text(raw.visibleAt),
    sourceFormat: text(raw.sourceFormat), pages: finite(raw.pages), blankPages: finite(raw.blankPages),
  };
}

function readIntakeSource(raw: Loose): VcrIntakeSource {
  const map = obj(raw.fieldMap);
  const upload = obj(raw.upload);
  const state = text(map.state);
  return {
    id: text(raw.id) ?? "", name: text(raw.name) ?? "", ownerParty: text(raw.ownerParty), mine: raw.mine === true, readable: raw.readable === true,
    canGrant: raw.canGrant === true, status: text(raw.status) ?? "registered", statusLabel: text(raw.statusLabel) ?? "",
    valueSource: text(raw.valueSource) ?? "observed", valueSourceLabel: text(raw.valueSourceLabel) ?? "",
    allowedUses: strings(raw.allowedUses), window: text(raw.window), retention: text(raw.retention),
    upload: {
      formats: strings(upload.formats), maxBytes: finite(upload.maxBytes), maxText: text(upload.maxText),
      documents: {
        formats: strings(obj(upload.documents).formats), maxBytes: finite(obj(upload.documents).maxBytes),
        maxText: text(obj(upload.documents).maxText), converter: obj(upload.documents).converter === true,
      },
    },
    files: arr(raw.files).map(readIntakeFile),
    fieldMap: {
      state: state === "proposed" || state === "confirmed" ? state : "none", stateLabel: text(map.stateLabel) ?? "", hash: text(map.hash),
      by: text(map.by), confirmedBy: text(map.confirmedBy), confirmedByName: text(map.confirmedByName), confirmedAt: text(map.confirmedAt),
      columns: arr(map.columns) as unknown as VcrFieldMapEntry[],
      issues: arr(map.issues).map((issue) => ({ code: text(issue.code) ?? "", message: text(issue.message) ?? "", table: text(issue.table), column: text(issue.column) })),
    },
    grants: arr(raw.grants).map((grant) => ({
      id: text(grant.id) ?? "", grantee: text(grant.grantee) ?? "", granteeLabel: text(grant.granteeLabel) ?? "", role: text(grant.role),
      fields: strings(grant.fields), fieldMode: grant.fieldMode === "deny" ? "deny" : "allow", window: text(grant.window), purposes: strings(grant.purposes),
      revoked: grant.revoked === true, revokedAt: text(grant.revokedAt), createdAt: text(grant.createdAt),
    })),
  };
}

/** Total over whatever the server sent: a missing block is an unavailable one, never a crash. */
export function readVcrIntake(raw: unknown): VcrIntake {
  const value = obj(raw);
  const seal = obj(value.seal);
  const options = obj(value.options);
  return {
    available: value.available === true,
    message: text(value.message),
    formats: strings(value.formats),
    maxBytes: finite(value.maxBytes),
    canManage: value.canManage === true,
    seal: value.seal && typeof value.seal === "object" ? {
      required: seal.required === true, planFrozenAt: text(seal.planFrozenAt), outcomeFirstReadAt: text(seal.outcomeFirstReadAt),
      ordered: seal.ordered === true, fields: strings(seal.fields), fieldsRead: strings(seal.fieldsRead), note: text(seal.note),
    } : null,
    options: {
      roles: intakeOptions(options.roles), timeKinds: intakeOptions(options.timeKinds), missingReasons: intakeOptions(options.missingReasons),
      valueSources: intakeOptions(options.valueSources), memberRoles: intakeOptions(options.memberRoles),
    },
    sources: arr(value.sources).map(readIntakeSource),
    snapshots: arr(value.snapshots).map((snapshot) => ({
      id: text(snapshot.id) ?? "", sourceId: text(snapshot.sourceId) ?? "", version: finite(snapshot.version), label: text(snapshot.label) ?? "",
      at: text(snapshot.at), rows: finite(snapshot.rows), columnCount: finite(snapshot.columnCount), valueSource: text(snapshot.valueSource),
      files: strings(snapshot.files), sealed: snapshot.sealed === true, sealedFields: strings(snapshot.sealedFields), sealedUntil: text(snapshot.sealedUntil),
      findings: finite(snapshot.findings),
      quality: arr(snapshot.quality).map((entry) => ({ label: text(entry.label) ?? "", value: text(entry.value) ?? "", passed: entry.passed === true })),
      tables: arr(snapshot.tables).map((table) => ({
        shape: text(table.shape) ?? "", label: text(table.label) ?? "", rows: finite(table.rows), columns: strings(table.columns),
        issues: finite(table.issues) ?? 0, outcomeBearing: table.outcomeBearing === true,
      })),
    })),
  };
}

const dataRoute = (studyId: string) => `${study(studyId)}/data`;

/** 登记数据源: whose data it is, what it may be used for, for how long. */
export async function registerVcrSource(studyId: string, input: VcrSourceBody) {
  return productRequest<{ source: { id: string; name: string } }>(`${dataRoute(studyId)}/sources`, "POST", sourceBody(input));
}

/**
 * Upload one file into a source: the raw file as the request body, its name and
 * role in the query — streamed by the browser, never read into a string here.
 * A refusal is a `WebApiError` with the plane's own code (`vcr_data_file_too_large`,
 * `vcr_data_format_unsupported`, …).
 */
export async function uploadVcrFile(
  studyId: string, sourceId: string, file: Blob,
  input: { name: string; role?: "data" | "dictionary" | "document"; subject?: string; visibleAt?: string; sheet?: string },
) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${dataRoute(studyId)}/sources/${id(sourceId)}/files?${uploadQuery(input)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
  });
  const value = await response.json().catch(() => null) as { data?: { file: VcrIntakeFile; created: boolean }; error?: string; code?: string } | null;
  if (!response.ok || !value || !("data" in value)) {
    throw new WebApiError(value?.error ?? "The upload was refused.", { status: response.status, code: value?.code });
  }
  return value.data as { file: VcrIntakeFile; created: boolean };
}

export function removeVcrFile(studyId: string, fileId: string) {
  return productRequest<{ removed: boolean }>(`${dataRoute(studyId)}/files/${id(fileId)}`, "DELETE");
}

/** Propose (or edit) the source's field map. The answer names the entries and the whole-map problems, if any. */
export function proposeVcrFieldMap(studyId: string, sourceId: string, columns: readonly VcrFieldMapEntry[]) {
  return productRequest<{ hash: string; entryIssues: Array<{ index?: number; field?: string; code: string; message: string }>; mapIssues: VcrIntakeIssue[] }>(
    `${dataRoute(studyId)}/sources/${id(sourceId)}/fieldmap`, "POST", fieldMapBody(columns));
}

/** Confirm the map by the hash that was shown: a map that changed since is refused. */
export function confirmVcrFieldMap(studyId: string, sourceId: string, hash: string) {
  return productRequest<{ checks: Record<string, number> }>(`${dataRoute(studyId)}/sources/${id(sourceId)}/fieldmap/confirm`, "POST", confirmFieldMapBody(hash));
}

/** 冻结快照: the files' bytes, the profile, the seal (when the study asks for one) and the three analysis tables. */
export function freezeVcrSnapshot(studyId: string, sourceId: string, input: { fileIds?: readonly string[]; asOf?: string } = {}) {
  return productRequest<{
    snapshot: { id: string; version: number };
    tables: { registered: Array<{ shape: string }>; refused: Array<{ shape: string; issues: Array<{ issue: string; message: string; blocking: boolean }> }>; skipped: string[] } | null;
  }>(`${dataRoute(studyId)}/sources/${id(sourceId)}/snapshots`, "POST", freezeBody(input));
}

/** Derive the three analysis tables again from a snapshot's confirmed map. */
export function deriveVcrTables(studyId: string, snapshotId: string) {
  return productRequest<{ registered: Array<{ shape: string }>; refused: Array<{ shape: string; issues: Array<{ issue: string; message: string; blocking: boolean }> }> }>(
    `${dataRoute(studyId)}/snapshots/${id(snapshotId)}/tables`, "POST", {});
}

export function createVcrGrant(studyId: string, sourceId: string, input: VcrGrantBody) {
  return productRequest<{ grant: { id: string } }>(`${dataRoute(studyId)}/sources/${id(sourceId)}/grants`, "POST", grantBody(input));
}

export function revokeVcrGrant(studyId: string, grantId: string) {
  return productRequest<{ grant: { id: string; revokedAt: string | null } }>(`${dataRoute(studyId)}/grants/${id(grantId)}/revoke`, "POST", {});
}

export interface VcrCorrectionDataset {
  datasetId: string; schemaVersion: string; cases: Array<{ caseId: string; partition: 'development' | 'held_out' }>;
  selection: { more: boolean; nextCursor: string | null; legacyUnfrozen: number };
}
export interface VcrCorrectionReplay { evaluated: number; matched: number; partition: 'held_out'; extractionRerun: false }
export const exportVcrCorrectionCases = (studyId: string, after = '0') => productRequest<VcrCorrectionDataset>(`${study(studyId)}/correction-cases`, 'POST', { after, limit: 100 });
export const replayVcrCorrectionCases = (studyId: string, datasetId: string) => productRequest<VcrCorrectionReplay>(`${study(studyId)}/correction-cases/${id(datasetId)}/replay`, 'POST', {});
