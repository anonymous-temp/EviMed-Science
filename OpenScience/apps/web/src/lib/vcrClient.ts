/**
 * 「虚拟临床研究」 — the browser's side of `/api/vcr/*` (build contract 2026-09-28 §3.1).
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
import { fetchWebMe, fetchWithWebAuth, WebApiError, webApiBase, type WebMe } from "./apiClient";
import { productRequest } from "./productClient";
import {
  assessmentBody, assessmentReviewBody, assumptionBody, budgetBody, cancelBody, contactBody, decisionBody, definitionCompareBody, definitionSaveBody,
  definitionUseBody, exportBody, jobBody, judgmentBody, memberBody, modelBody, packBindBody, regulatoryContactBody, reviewBody, runBody, studyCreateBody,
  studyPatchBody, transitionBody, trialSearchBody,
  type VcrAssessmentBody, type VcrAssumptionBody, type VcrBudgetBody, type VcrContactBody, type VcrCreateBody, type VcrDecisionBody, type VcrDefinitionCompareBody,
  type VcrDefinitionSaveBody, type VcrDefinitionUseBody, type VcrJobBody,
  type VcrJudgmentBody, type VcrMemberBody, type VcrModelBody, type VcrPatchBody, type VcrRegulatoryContactBody, type VcrReviewBody, type VcrTransitionBody,
} from "./vcrBodies";

export type {
  VcrAssessmentBody, VcrAssumptionBody, VcrBudgetBody, VcrContactBody, VcrCreateBody, VcrDecisionBody, VcrDefinitionCompareBody, VcrDefinitionSaveBody,
  VcrDefinitionUseBody, VcrJobBody, VcrJudgmentBody, VcrMemberBody, VcrModelBody,
  VcrPatchBody, VcrRegulatoryContactBody, VcrReviewBody, VcrTransitionBody,
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
export type VcrStudyStatus = "draft" | "active" | "paused" | "archived";
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
export type VcrExportKind =
  | "study_package" | "cde_communication_pack" | "simulation_report" | "validation_pack"
  | "model_analysis_plan" | "model_analysis_report";
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
  /**
   * A person's cancel holds the programme: a step held is not taken up again until a person asks for it (`POST …/run`), whatever
   * `requested` says — it is not in line, and an empty step that is held offers its start like one never asked for.
   */
  held?: boolean;
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
  /** `attention` is the amber line (a gap, a failed step, a wait for the allowance); `stale` is the grey one. */
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

/** 部分结果: what a run that did not finish did keep, said once (「这次模拟算完了 18,000 / 20,000 次重复就到了计算时间上限，下面是已完成部分的结果。」). */
export interface VcrPartial {
  sentence: string;
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
  by?: string | null; at?: string | null; note?: string | null;
  /**
   * One sentence each (`fix`, or `message` where the reviewer wrote no fix) and, when the finding is about an object this study holds, the
   * way to it. The reviewer's path into the frozen snapshot and the JSON it quoted are the review's own provenance and are not sent.
   */
  findings: Array<{
    id?: string; kind?: string; message?: string; fix?: string; response?: string | null;
    target?: { label: string; tab: string; key?: string | null } | null;
  }>;
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
  /** The projects of the account's drafts (studies nobody has described yet): not in the list, and the sidebar leaves them out. */
  draftProjectIds: string[];
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
  /** 发布到模拟研究: present only where the column is on and this report is one it takes; the lead alone may publish. */
  publication?: { canPublish: boolean; live: { id: string; publishedAt: string } | null } | null;
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
  state?: "stale" | null;
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
  /** What its numbers come from, in words: 「解析」「模拟」「解析 + 模拟」. */
  method?: string | null;
  /** How many replicates the simulation ran. */
  replicates?: number | null;
  measures: Record<string, VcrValue>;
  /** The run behind the row, as numbers: what the row's record drawer reads (`vcrViews.mjs`); null before the design ran. */
  record?: {
    method: string | null;
    replicates: number | null;
    seed: number | null;
    check: { analytic: number | null; simulated: number | null; differencePoints: number | null; allowedPoints: number | null; approximate: boolean; agrees: boolean | null } | null;
  } | null;
}

export interface VcrOverview {
  /** The one sentence at the top of the page. */
  headline: string | null;
  metrics: VcrMetric[];
  counts: VcrCounts | null;
  designs: VcrDesign[];
  attention: VcrAttention[];
  changes: VcrChange[];
  /** The AI reviews and the people's, for 「变更记录」. */
  reviews: VcrReviewSummary[];
  deliverables: VcrDeliverable[];
}

/** The compute budget, in the unit the platform meters: CPU seconds. */
export interface VcrBudget {
  limitSeconds: number;
  /** What finished jobs spent. */
  usedSeconds: number;
  /** What work running now (or not yet known to have stopped) can still spend at most — never a queued job's ceiling, which is not spent. */
  committedSeconds: number;
  /** The limit less what is used and what is reserved. */
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
  /** Why a live job is not moving when it is not the researcher's to act on: the engine did not answer, and the job continues by itself when it does. */
  waitingOn?: VcrJobWait | null;
}

/** What a live job waits on that asks nothing of the reader (`VCR_JOB_WAIT_LABELS_ZH`). */
export type VcrJobWait = "engine";

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

/** The study's definition in the reader's words: each line is absent when the definition does not state it. */
export interface VcrDefinitionCard {
  population: string | null;
  intervention: string | null;
  comparator: string | null;
  outcome: string | null;
  estimand: string | null;
  endpoint: string | null;
  intendedUse: string | null;
}

/** What the server knows of the engine (`VcrService.engineState`). */
export type VcrEngineState = "missing" | "wired" | "answering" | "not_answering";

/** Why a queued step waits: another step's run (its key), the research allowance, or a run that covers no step (an export, a patient's trials). */
export type VcrWaitingFor = VcrStepKey | "allowance" | "simulated_allowance" | "run";

/** The run a study's one slot holds right now (`activity.run`). */
export interface VcrActivityRun {
  id: string | null;
  /** The first step it covers, or null for a run that covers none (an export). */
  step: VcrStepKey | null;
  steps: VcrStepKey[];
  /** The person's sentence for it (「构建人群、生成虚拟患者」), never the instruction the model was briefed with. */
  label: string;
  /** What it is doing now, as the ledger observed it (`search` `screen` `fulltext` `claims` `write` `deliver`). */
  phase: string | null;
  /** Counts of what happened: `search`, `included`, `fullText`, `claims`, `claimsVerified`, `deliverables`, `deliverablesDone`. Odometers, never a share. */
  counts: Partial<Record<"search" | "included" | "fullText" | "claims" | "claimsVerified" | "deliverables" | "deliverablesDone", number>>;
  startedAt: string | null;
  /** `open-runtime`: in the project's own runtime, the conversation is free; `bounded`: it holds the project's runtime; null: not known yet (a run being sent). */
  placement: "open-runtime" | "bounded" | null;
  /** The study's conversation cannot take a prompt until this ends. */
  locked: boolean;
}

/** One engine job that is open (`activity.jobs`). */
export interface VcrActivityJob {
  id: string;
  kind: string;
  state: "queued" | "running" | "awaiting_budget";
  step: VcrStepKey | null;
  done: number | null;
  total: number | null;
}

/** What a study is doing: `null` when nothing is. It stays for a few seconds after the last thing ends, with `last`, so a poller sees the end once. */
export interface VcrActivity {
  run: VcrActivityRun | null;
  queue: Array<{ step: VcrStepKey; waitingFor: VcrWaitingFor | null }>;
  jobs: VcrActivityJob[];
  last: { step: VcrStepKey | null; endedAt: string; outcome: "succeeded" | "failed" | "canceled" } | null;
}

/** The step the study offers next. `reason`: `start` (never done), `retry` (the last attempt was not finished), `refresh` (its inputs changed). */
export interface VcrNext {
  step: VcrStepKey;
  /** The step's verb and object: 「生成虚拟患者」. */
  label: string;
  reason: "start" | "retry" | "refresh";
  /** 「上次没有做完」, 「输入已变更，结果已过期」, or empty for `start`. */
  reasonText: string;
}

export interface VcrStepSummary {
  note: string | null;
  stale: boolean;
}

/** The study's conversation: `exists` once the kernel minted it; `sessionId` null for a read that could not (the next read tries again). */
export interface VcrConversationRef {
  sessionId: string | null;
  exists: boolean;
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
  /** The conversation the study was opened with (its 「对话」); null before there is one. Kept for readers that predate `conversation`. */
  sessionId: string | null;
  /** The study's one conversation: the kernel's session the 「对话」 view shows, and whether the kernel knows it yet. */
  conversation: VcrConversationRef;
  /** What is going on right now, or null when nothing is: the page reads again while it is not null and stops when it is. */
  activity: VcrActivity | null;
  /** The step to offer as the primary action, computed once on the server (`vcrNext`); null when there is none to offer. */
  next: VcrNext | null;
  /** One finding with one number per step (≤ 12 characters); a step with nothing to say is absent. */
  stepSummaries: Partial<Record<VcrStepKey, VcrStepSummary>>;
  /** What the definition says, as words; null until one has been written. */
  definition: VcrDefinitionCard | null;
  /** Whether the computation engine is there: `missing` and `not_answering` are the page's one line at the top. */
  engine?: VcrEngineState;
  /** What this reader may do here (`VCR_ROLE_ABILITIES`); the routes check for themselves. */
  abilities: string[];
  /** The tier the frozen data supports above the study's own, for the lead who may move it; null (or absent) when there is none. */
  tierOffer?: VcrTierOffer | null;
  /** The compute budget, when the module meters one. */
  budget: VcrBudget | null;
  jobs: VcrJob[];
  ceiling: VcrCeiling | null;
  overview: VcrOverview;
  /** The disease pack the study works from and the library definitions it used; null where the module cannot say. */
  knowledge?: VcrKnowledge | null;
  /** What this deployment offers on the page besides the module's own: each hides one action when it is off. */
  features?: { simulations: boolean; predictions: boolean; platformPacks: boolean };
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

/** One level of a categorical or binary variable, as the engine counted it (a level a handful of people share is withheld). */
export interface VcrGeneratedLevel {
  level: string;
  label: string;
  n: number | null;
  percent: number | null;
  suppressed: boolean;
}

/** What the study declared for a variable, as the scenario schema states it. */
export interface VcrDeclaredSpec {
  family: string;
  params: Record<string, number | number[] | string[]>;
}

/** One variable of a generated table: what the study set for it, what came out, a small histogram of it, and what broke its limits. */
export interface VcrGeneratedRow {
  key: string;
  /** The column's name in the table, which the rows route is addressed by. */
  variable: string;
  label: string;
  kind: "continuous" | "binary" | "categorical" | null;
  /** 「正态分布，均数 58、标准差 10」; null for a table made from real data (nothing was declared). */
  declared: string | null;
  /** The declaration itself, for the mark the page draws on the histogram; null when nothing was declared. */
  declaredSpec: VcrDeclaredSpec | null;
  /** 「均数 58.2，标准差 9.8」 / 「是 44.6%」. */
  result: string | null;
  missing: string | null;
  histogram: { breaks: number[]; counts: number[] } | null;
  /** Of a categorical or binary variable. */
  levels: VcrGeneratedLevel[] | null;
  n: number | null;
  mean: number | null;
  sd: number | null;
  median: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
  /** How many generated records broke the limits the variable declared; null when it declared none or the count is the table's. */
  violations: number | null;
  /** The generated values passed a declared bound (`violations` stays null: the count is the table's, and this says it was). */
  outOfBounds: boolean;
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
  /** A real cohort against the published one, row by row; empty for a generated population (its rows are `generated`). */
  profile: VcrProfileRow[];
  /** `generated`: one row per variable, set beside what came out; `comparison`: ours against the comparator's. */
  profileKind?: "generated" | "comparison" | null;
  generated: VcrGeneratedRow[];
  /** The generated records as a list (`GET …/population/rows?result=`): which result they are, and how many; null for a real cohort. */
  records?: { result: string; rows: number | null } | null;
  /** The rules no variable carries itself, and how many generated records broke each (a variable's own are on its row). */
  constraints: Array<{ label: string; violations: number }>;
  /** Where the generated records can be downloaded from, when there are any to offer. */
  download?: { path: string; rows: number | null } | null;
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
  /** The library definitions the study used, and the populations that could be saved to it. */
  knowledge?: VcrKnowledge | null;
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
  /** How the model is called (plan §5.2): a baseline in and an outcome distribution out, or an event history in and future trajectories out. */
  shape?: "baseline_to_outcome" | "event_history_to_trajectories" | "unknown";
  shapeLabel?: string | null;
  /** What the card of a model of the second shape has not said yet, in words. */
  shapeMissing?: string[];
  /** The event types an event-history model reads, how far it projects and how many trajectories a history gets at most. */
  events?: string[];
  horizon?: string | null;
  trajectoriesMax?: number | null;
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

/** One row of a model assessment table (ICH M15 Appendix 1). `derived` is the model risk, which the platform works out. */
export interface VcrAssessmentRow {
  key: string;
  label: string;
  rated: boolean;
  derived: boolean;
  rating: "low" | "medium" | "high" | null;
  ratingLabel: string | null;
  entry: string;
  justification: string;
}

/** One assessment record as the page reads it, and the fields the lead's edit starts from. */
export interface VcrAssessmentRecord {
  key: string;
  version: number;
  modelName: string;
  modelVersion: string;
  /** The library's Chinese title of the model; the id again when the library no longer holds it. Absent before the server sent it. */
  modelTitle?: string;
  risk: "low" | "medium" | "high" | null;
  riskLabel: string | null;
  /** The one rule that settled the risk, in a sentence. */
  riskRuleText: string | null;
  rows: VcrAssessmentRow[];
  /** Who wrote this version: a run, or a person by name. */
  savedBy: { kind: "run" | "person"; name: string | null } | null;
  savedAt: string | null;
  /** What the record has not said yet, in words. */
  gaps: string[];
  fields: Required<Omit<VcrAssessmentBody, "key">> & { technicalCriteria: Array<{ criterion: string; rationale: string }> };
}

export interface VcrAssessments {
  records: VcrAssessmentRecord[];
  /** The frozen model analysis plan, when there is one: an edit does not move it. */
  plan: { version: number; frozenAt: string | null } | null;
}

/** One line of the 「设定 vs 生成 vs 证据区间」 strip: the server's own comparison of a number the study set with the number the table holds. */
export interface VcrCalibrationRow {
  key: string;
  label: string;
  unit: string | null;
  /** What the job was told (the frozen scenario) or the bound card's point value. */
  declared: number | null;
  /** What the table holds, computed from it by code. */
  generated: number | null;
  difference: number | null;
  /** The evidence's own interval — the pooled prediction interval first, the declared range after. */
  interval: { low: number | null; high: number | null; kind: "prediction" | "range" } | null;
  /** `outside` is a mark for the page, never a verdict; a row with no interval is `unknown`, never `within`. */
  status: "within" | "outside" | "unknown";
}

export interface VcrCalibration {
  endpoint: "time_to_event" | "binary" | "continuous" | null;
  rows: VcrCalibrationRow[];
}

export interface VcrPatientsTab {
  model: VcrModelCard | null;
  assessments: VcrAssessments;
  /** The label the model's output has earned: never 「数字孪生」 by default. */
  twin: { label: string; reason: string | null } | null;
  headline?: string | null;
  /** The people the set holds, as a list (`GET …/patients/rows?result=`): which result, how many, and the arms with their events. */
  records: { result: string; rows: number | null; arms: Array<{ value: string; label: string; n: number; events: number | null }> } | null;
  /** How each variable of the table is distributed (and what the study declared for it), read from the table itself. */
  profile: VcrGeneratedRow[];
  profileKind: "generated" | null;
  /** Declared against generated against the evidence's interval; computed on the server, never in the browser. */
  calibration: VcrCalibration | null;
  /** The main chart: one series per scenario. */
  trajectories: { xLabel?: string | null; yLabel?: string | null; ticks?: string[]; series: VcrSeries[] } | null;
  /** One virtual patient, and the same random numbers under two assumptions. */
  example: {
    /** 「示例患者 · 年龄 62 岁 · ECOG 1」: the person, not an identifier. */
    title: string;
    /** The engine's own id and how it was made: a line of the record, never of the page. */
    record: { id: string; source: VcrValueSource; origin: string | null };
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
  estimand?: { rows: Array<{ label: string; value: string }>; note?: string | null; source?: VcrValueSource | null } | null;
  comparability: VcrProfileRow[];
  comparabilityNote?: string | null;
  /** The ten comparability dimensions, each with its state. */
  dimensions: VcrDimension[];
  /** Weight and overlap diagnostics of a weighted comparison. */
  diagnostics: Array<{ key: string; label: string; value: VcrValue }>;
  /** What a borrowed prior is worth (prior effective sample sizes, the MAP prior's own numbers) — not a weighting diagnostic. Absent before the server sent it. */
  prior?: Array<{ key: string; label: string; value: VcrValue }>;
  /**
   * The numbers of the robustness methods (negative controls, tipping point, prognostic adjustment), a sentence for each analysis that
   * could not be computed, and the sentence that no regulator has qualified prognostic adjustment for the endpoint. Null when none.
   */
  robustness?: { rows: Array<{ key: string; label: string; value: VcrValue }>; notes: string[]; qualification: string | null } | null;
  /** 「不可估计」 — the gaps, and what each one would answer. */
  gaps: { title?: string | null; needs?: string | null; items: Array<{ title: string; detail?: string | null; answers?: string | null }>; conclusion?: string | null; rule?: string | null } | null;
  counts: VcrCounts | null;
  /** 「本页结论：有限制地估计」. */
  verdict?: { conclusion: VcrConclusion | null } | null;
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

/** One visit of a protocol's schedule of activities: the day it falls on, the window around it and what is done at it. */
export interface VcrScheduleVisit {
  visit: string;
  /** Null for a visit with no planned day (an end-of-treatment visit). */
  day: number | null;
  windowDays: number | null;
  note: string;
  procedures: Array<{ name: string; note: string }>;
}

/** The protocol's schedule of activities, by day; null while the study has none. */
export interface VcrSchedule {
  protocolVersion: number | null;
  visits: VcrScheduleVisit[];
  totals: { visits: number; activities: number; entries: number; firstDay: number | null; lastDay: number | null };
}

/** One entry of the study's log of regulatory contacts. */
export interface VcrRegulatoryContact {
  id: string;
  date: string | null;
  agency: string;
  type: string;
  summary: string;
  outcome: string;
  attachments: string[];
  /** A run's own entry carries the label AI-written objects carry. */
  source: "ai_set" | "researcher";
  recordedAt: string | null;
}

export interface VcrTrialTab {
  headline?: string | null;
  /** ADEMP, one line each. */
  ademp: Array<{ key: string; label: string; text: string }>;
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
  /** The forecast registry. */
  forecasts: VcrForecast[];
  /** The milestone timeline: when each design would reach its landmarks. */
  milestones: Array<{ design: string; name: string; items: Array<{ key: string; label: string; value: VcrValue }> }>;
  /** 「访视日程」: records of the protocol, not results of a computation. */
  schedule: VcrSchedule | null;
  /** 「监管沟通记录」, the latest first. */
  regulatory: VcrRegulatoryContact[];
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
  /** What the evaluation rested on has since been withdrawn (the person's consent, or a record), or changed. */
  basis?: "withdrawn" | "updated";
  /** The model's ranking hint, carried with its own label and never as a probability of benefit. */
  priority?: { label: string; score: number | null; rationale: string | null } | null;
}

/** A sentence a verdict rests on, where it is (the document by the name the data tab lists it under, or a cell of the data table) and the date of what it records. */
export interface VcrCriterionCitation {
  quote: string;
  source?: string | null;
  at?: string | null;
  locator?: { documentId?: string; start?: number | null; end?: number | null; snapshotId?: string; field?: string } | null;
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
  /**
   * The patient's own sentence, and where it is from. `locator` is where the sentence stands: a span of a document
   * (`documentId`, `start`, `end` — the same span a fact of the clinical timeline cites) or a cell of the data table (`snapshotId`, `field`).
   */
  evidence?: VcrCriterionCitation | null;
  /** Every citation the verdict rests on (at most three), the first of them being `evidence`: an unknown that waits on a prescription also shows the administration it was set against. */
  evidenceItems?: VcrCriterionCitation[];
  /** What to ask for: 「申请近 4 周头颅 MRI」. */
  request?: string | null;
  requestNote?: string | null;
  decidedBy?: string | null;
  overridden?: boolean;
}

export interface VcrProtocolChoice { id: string; title: string; version: number; sourceRef?: unknown }

/**
 * One trial in a patient's list (「给患者找试验」): a registry trial a run found for them, or a version of the study's own protocol that has
 * judged them. The order is the platform's (every criterion met first, then the fewest still to settle, the excluded last); `rank` says it.
 */
export interface VcrPatientTrial {
  id: string;
  kind: "registry" | "protocol";
  rank: number;
  /** The registry the trial is in and its number there; null for the study's own protocol. */
  registry: string | null;
  registryId: string | null;
  /** The trial's page on its registry — an https address, or null. */
  url: string | null;
  title: string;
  /** In the reader's words (「II 期」, 「招募中」); empty when the registry did not say. */
  phase: string;
  status: string;
  conditions: string[];
  sites: { total: number | null; countries: string[] } | null;
  eligibility: VcrEligibility | null;
  /** How many of the trial's criteria stand where, for this patient. */
  counts: { satisfied: number; unknown: number; notSatisfied: number; pending: number };
  summary: string;
  assessedAt: string | null;
}

/** 「给患者找试验」: the patient the page is about, the trials that have judged them, and the chosen trial's criteria. */
export interface VcrPatientTrials {
  /** False where this deployment has not composed the direction. */
  available: boolean;
  subject: string | null;
  trials: VcrPatientTrial[];
  selected: { id: string; criteria: VcrCriterionJudgement[]; verdict?: { text: string; note?: string | null } | null; assessedAt: string | null } | null;
}
export interface VcrClinicalTimelineEntry {
  id: string; variable: string; value: unknown; unit: string | null; at: string | null; assertion: string; experiencer: string | null;
  medicationState: string | null; correctionOf: string | null; quote: string | null;
  /** The document the fact is in, by the name the data tab lists it under. */
  document?: string | null;
  superseded?: boolean; conflictFactIds?: string[]; correctionReason?: string | null;
  /** The fact was read from a basis (a record, a reviewed text, a permission) that has since changed. */
  basis?: "updated";
  locator: { documentId: string; start: number; end: number } | null;
}
export interface VcrMatchingTab {
  protocols?: VcrProtocolChoice[];
  protocolVersionId?: string | null;
  candidateRoster?: string[];
  /** The people whose evaluation rested on a basis that has since changed: the evaluation that already exists is offered for them. */
  basisUpdated?: { count: number; subjects: string[] };
  candidateCoverage?: { inputSnapshotId: string; requested: number; evaluated: number; pending: number; unavailable: number };
  comparisons?: Array<{ protocol: VcrProtocolChoice; summary: string | null; asOf: string | null; evidenceGaps: Array<{ variable: string; reason: string }> }>;
  timeline?: VcrClinicalTimelineEntry[];
  /** The sub-tab the payload is for. */
  view: "matching" | "referral" | "sites" | "followup";
  /** False when the package is not composed here; the tab says so and nothing else waits. */
  available?: boolean;
  unavailable?: { code: string; message: string } | null;
  headline?: string | null;
  partner?: { name?: string | null; candidates?: number | null; tier?: VcrDataTier | null; snapshotAt?: string | null } | null;
  /** 「给试验找患者 | 给患者找试验」. */
  direction?: "trial_to_patient" | "patient_to_trial";
  /** The directions this server answers. */
  directions?: Array<"trial_to_patient" | "patient_to_trial">;
  /** Present when the direction asked for is 给患者找试验. */
  patientTrials?: VcrPatientTrials | null;
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
      /** The evidence card a run says led it to this value (flywheel F23): provenance, never the value's source. */
      candidateFrom?: { cardId: string; claimId?: string };
    }>;
    forestNote?: string | null;
    /** The distribution the simulation draws from. */
    distribution?: { family: string; note?: string | null; points?: Array<{ x: number; y: number }> } | null;
    quote?: string | null;
    quoteSource?: string | null;
    quoteLink?: string | null;
    /** 「被这些结果使用」. */
    usedBy?: Array<{ id: string; label: string; note?: string | null; tab?: VcrTabKey | null }>;
    /** `afterFreeze`: written after the study's analysis plan froze — beside the frozen version, never the one the study works from (F24). */
    versions?: Array<{ version: number; at?: string | null; text: string; note?: string | null; afterFreeze?: boolean }>;
  } | null;
  /** 「有新证据」: the frontier feed or a source change bears on the card's sources (flywheel F24). */
  newEvidence?: {
    label: string;
    open: Array<{ id: string; cause: "new_results" | "source_retracted" | "source_corrected" | "source_new_version"; identifier: string; itemId: string | null; title: string; at: string | null }>;
    /** The version written after the freeze that took the news in, when the plan has frozen. */
    afterFreezeVersion: number | null;
  } | null;
}

/** A trial event the feed reported for the study's subject: a pointer, never a precedent (flywheel F24). */
export interface VcrPrecedentCandidate {
  id: string;
  candidate: true;
  event: "registration" | "results" | "label_change";
  frontierItemId: string;
  registry: string | null;
  registryId: string | null;
  doi: string | null;
  pmid: string | null;
  title: string;
  noticedAt: string | null;
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
  /** Trial events the feed reported for this study's subject, marked as candidates (flywheel F24). */
  precedentCandidates?: VcrPrecedentCandidate[];
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

/* ------------------------------------------- knowledge: packs and the definition library */

/** What a pack entry rests on: the source's link and the licence under which it is used. */
export interface VcrPackSource {
  id: string;
  title: string;
  url: string;
  licence: string;
  licenceName?: string | null;
  /** 引用方式: attribution (reused with attribution), link-only (linked, restated in own words), own. */
  use?: "attribution" | "link-only" | "own" | null;
  accessed?: string | null;
}

/** A disease knowledge pack, without its sections (`VCR_PACK_STATUSES`: curated, ai-draft — the status decides whether a lead may promote it, and the page does not tag it). */
export interface VcrPackSummary {
  origin: "shipped" | "stored";
  id: string;
  diseaseKey: string;
  name: string | null;
  nameZh: string | null;
  version: number;
  status: "curated" | "ai-draft";
  counts: Record<string, number>;
  sources: VcrPackSource[];
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  boundAt?: string | null;
  /** Whether the pack read is the edition the study chose, or the newest one standing in for an edition the catalogue no longer holds. */
  binding?: { resolution: "recorded" | "newest_compatible" } | null;
  /** A draft the reader may promote (the lead, or an operator). */
  canPromote?: boolean;
  /** A platform pack (flywheel F26): who made it by the name they allow, from which of their versions, and whether a source has changed since. */
  platform?: {
    version: number;
    author: { name: string; at: string | null; sourceVersion: number };
    zoneId: string | null;
    state: "live" | "retired";
    sourceChanged: { at: string | null; sources: Array<{ sourceId: string; identifier: string; kind: string }> } | null;
  } | null;
  /** The lead's request to make the account's curated pack a platform pack, and what the re-check said. */
  platformRequest?: {
    canRequest: boolean;
    requested: boolean;
    recheck: { state: "passed" | "failed"; failing: Array<{ section: string | null; id: string; code: string; detail: string }>; checked: Record<string, number>; at: string | null } | null;
  } | null;
}

/** A library definition a study used, with the pack entries it rests on. */
export interface VcrUsedDefinition {
  definitionId: string;
  version: number;
  populationId: string | null;
  name: string;
  text: string;
  /** How many versions the library entry has, and how many studies used it. */
  versions: number;
  uses: number;
  usedAt: string | null;
  packRefs: Array<{ section: string; id: string; concept?: string }>;
}

/** The engine's comparison of two versions on one dataset: sizes, overlap and one standardized difference per covariate. */
export interface VcrComparison {
  id: string;
  definitionId: string;
  versionA: number;
  versionB: number;
  snapshotId: string | null;
  cohortSizeA: number | null;
  cohortSizeB: number | null;
  overlap: { both?: number | null; onlyA?: number | null; onlyB?: number | null };
  covariates: Array<{
    covariate: string;
    kind?: "binary" | "continuous";
    meanA?: number | null;
    meanB?: number | null;
    standardizedDifference?: number | null;
    skipped?: string | null;
  }>;
  /** The |difference| above which a covariate is flagged. */
  floor: number | null;
  createdAt: string | null;
}

export interface VcrKnowledge {
  pack: VcrPackSummary | null;
  definitions: VcrUsedDefinition[];
  comparisons: VcrComparison[];
  /** The study's populations a definition could be saved from. */
  savable: Array<{ populationId: string; label: string; name: string }>;
}

/** One version of a library definition. */
export interface VcrLibraryVersion {
  version: number;
  text: string;
  rules: Array<{ name?: string; rule?: unknown; unknownAs?: string }>;
  packRefs: Array<{ section: string; id: string; concept?: string }>;
  createdAt: string | null;
}

/** An account's library entry (`GET /api/vcr/definitions`). */
export interface VcrLibraryEntry {
  id: string;
  name: string;
  versions: number;
  uses: number;
  updatedAt: string | null;
  latest: VcrLibraryVersion | null;
}

export interface VcrLibraryDetail {
  id: string;
  name: string;
  uses: number;
  versions: VcrLibraryVersion[];
  studies: Array<{ version: number; studyId: string; studyName: string; at: string | null }>;
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
  const sentence = text(obj(raw).sentence);
  return sentence ? { sentence } : null;
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
    method: text(value.method),
    replicates: finite(value.replicates),
    measures: Object.fromEntries(Object.entries(measures).map(([key, cell]) => [key, readVcrValue(cell)])),
    record: readDesignRecord(value.record),
  };
}

function readDesignRecord(raw: unknown): NonNullable<VcrDesign["record"]> | null {
  const value = obj(raw);
  if (!Object.keys(value).length) return null;
  const check = obj(value.check);
  return {
    method: text(value.method),
    replicates: finite(value.replicates),
    seed: finite(value.seed),
    check: Object.keys(check).length
      ? {
        analytic: finite(check.analytic), simulated: finite(check.simulated), differencePoints: finite(check.differencePoints),
        allowedPoints: finite(check.allowedPoints), approximate: check.approximate === true, agrees: typeof check.agrees === "boolean" ? check.agrees : null,
      }
      : null,
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
    reviews: arr(value.reviews).filter((item) => typeof item.label === "string") as unknown as VcrReviewSummary[],
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

function readDefinitionCard(raw: unknown): VcrDefinitionCard | null {
  const value = obj(raw);
  if (!Object.keys(value).length) return null;
  return {
    population: text(value.population), intervention: text(value.intervention), comparator: text(value.comparator), outcome: text(value.outcome),
    estimand: text(value.estimand), endpoint: text(value.endpoint), intendedUse: text(value.intendedUse),
  };
}

const WAITING_FOR = new Set<string>(["allowance", "simulated_allowance", "run", ...VCR_STEP_KEYS]);
const ACTIVITY_COUNTS = ["search", "included", "fullText", "claims", "claimsVerified", "deliverables", "deliverablesDone"] as const;

function stepKey(value: unknown): VcrStepKey | null {
  return typeof value === "string" && (VCR_STEP_KEYS as readonly string[]).includes(value) ? value as VcrStepKey : null;
}

function readActivityRun(raw: unknown): VcrActivityRun | null {
  const value = obj(raw);
  if (!Object.keys(value).length) return null;
  const counts: VcrActivityRun["counts"] = {};
  for (const key of ACTIVITY_COUNTS) {
    const n = finite(obj(value.counts)[key]);
    if (n !== null && n >= 0) counts[key] = n;
  }
  return {
    id: text(value.id),
    step: stepKey(value.step),
    steps: (Array.isArray(value.steps) ? value.steps : []).map(stepKey).filter((step): step is VcrStepKey => step !== null),
    label: text(value.label) ?? "",
    phase: text(value.phase),
    counts,
    startedAt: text(value.startedAt),
    placement: value.placement === "open-runtime" ? "open-runtime" : value.placement === "bounded" ? "bounded" : null,
    locked: value.locked === true,
  };
}

/** The study's activity, or null when it says there is none. */
export function readVcrActivity(raw: unknown): VcrActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const value = obj(raw);
  const last = obj(value.last);
  const outcome = text(last.outcome);
  return {
    run: readActivityRun(value.run),
    queue: arr(value.queue).flatMap((entry) => {
      const step = stepKey(entry.step);
      const waiting = text(entry.waitingFor);
      return step ? [{ step, waitingFor: waiting && WAITING_FOR.has(waiting) ? waiting as VcrWaitingFor : null }] : [];
    }),
    jobs: arr(value.jobs).flatMap((job) => {
      const state = text(job.state);
      if (!text(job.id) || (state !== "queued" && state !== "running" && state !== "awaiting_budget")) return [];
      return [{ id: String(job.id), kind: text(job.kind) ?? "", state, step: stepKey(job.step), done: finite(job.done), total: finite(job.total) } satisfies VcrActivityJob];
    }),
    last: text(last.endedAt) && (outcome === "succeeded" || outcome === "failed" || outcome === "canceled")
      ? { step: stepKey(last.step), endedAt: String(last.endedAt), outcome } : null,
  };
}

function readNext(raw: unknown): VcrNext | null {
  const value = obj(raw);
  const step = stepKey(value.step);
  const reason = text(value.reason);
  if (!step || (reason !== "start" && reason !== "retry" && reason !== "refresh")) return null;
  return { step, label: text(value.label) ?? "", reason, reasonText: text(value.reasonText) ?? "" };
}

function readStepSummaries(raw: unknown): VcrStudy["stepSummaries"] {
  const out: VcrStudy["stepSummaries"] = {};
  for (const [key, entry] of Object.entries(obj(raw))) {
    const step = stepKey(key);
    if (!step || !entry || typeof entry !== "object") continue;
    out[step] = { note: text((entry as Loose).note), stale: (entry as Loose).stale === true };
  }
  return out;
}

export function readVcrStudy(raw: unknown): VcrStudy {
  const value = obj(raw);
  const conversation = obj(value.conversation);
  return {
    ...(value as unknown as VcrStudy),
    conversation: { sessionId: text(conversation.sessionId) ?? text(value.sessionId), exists: conversation.exists === true },
    activity: readVcrActivity(value.activity),
    next: readNext(value.next),
    stepSummaries: readStepSummaries(value.stepSummaries),
    steps: readSteps(value.steps),
    abilities: strings(value.abilities),
    tierOffer: readTierOffer(value.tierOffer),
    budget: value.budget && typeof value.budget === "object" ? value.budget as VcrBudget : null,
    jobs: arr(value.jobs) as unknown as VcrJob[],
    ceiling: value.ceiling && typeof value.ceiling === "object"
      ? { ...(value.ceiling as VcrCeiling), reasons: arr(obj(value.ceiling).reasons) as unknown as VcrCeiling["reasons"] } : null,
    sessionId: text(value.sessionId),
    definition: readDefinitionCard(value.definition),
    engine: ["missing", "wired", "answering", "not_answering"].includes(String(value.engine)) ? value.engine as VcrEngineState : undefined,
    overview: readOverview(value.overview),
    knowledge: readVcrKnowledge(value.knowledge),
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
    draftProjectIds: strings(value.draftProjectIds),
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
    shapeMissing: strings(value.shapeMissing),
    events: strings(value.events),
    usedBy: arr(value.usedBy) as unknown as VcrModelCard["usedBy"],
  };
}

function readDeclaredSpec(raw: unknown): VcrDeclaredSpec | null {
  const value = obj(raw);
  const family = text(value.family);
  if (!family) return null;
  const params: VcrDeclaredSpec["params"] = {};
  for (const [key, item] of Object.entries(obj(value.params))) {
    if (typeof item === "number" && Number.isFinite(item)) params[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "number")) params[key] = item as number[];
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) params[key] = item as string[];
  }
  return { family, params };
}

function readGeneratedRow(raw: unknown): VcrGeneratedRow {
  const value = obj(raw);
  const histogram = obj(value.histogram);
  const counts = Array.isArray(histogram.counts) ? histogram.counts : [];
  const numbers = (items: unknown[]) => items.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : 0));
  const variable = text(value.variable) ?? text(value.key) ?? "";
  return {
    key: text(value.key) ?? variable,
    variable,
    label: text(value.label) ?? variable,
    kind: value.kind === "continuous" || value.kind === "binary" || value.kind === "categorical" ? value.kind : null,
    declared: text(value.declaredText) ?? text(value.declared),
    declaredSpec: readDeclaredSpec(value.declared),
    result: text(value.generatedText) ?? text(value.result),
    missing: text(value.missingText),
    histogram: counts.length ? { breaks: numbers(Array.isArray(histogram.breaks) ? histogram.breaks : []), counts: numbers(counts) } : null,
    levels: Array.isArray(value.levels)
      ? arr(value.levels).map((level) => ({
        level: String(level.level ?? ""), label: text(level.label) ?? String(level.level ?? ""),
        n: finite(level.n), percent: finite(level.percent), suppressed: level.suppressed === true,
      }))
      : null,
    n: finite(value.n),
    mean: finite(value.mean),
    sd: finite(value.sd),
    median: finite(value.median),
    q1: finite(value.q1),
    q3: finite(value.q3),
    min: finite(value.min),
    max: finite(value.max),
    violations: finite(value.violations),
    outOfBounds: value.outOfBounds === true,
  };
}

export function readVcrPopulation(raw: unknown): VcrPopulationTab {
  const value = obj(raw);
  const quality = obj(value.quality);
  const generatedKind = value.profileKind === "generated";
  const download = obj(value.download);
  const records = obj(value.records);
  return {
    ...(value as unknown as VcrPopulationTab),
    versions: arr(value.versions).map((item) => ({ ...(item as unknown as VcrPopulationTab["versions"][number]), counts: readVcrCounts(item.counts) })),
    criteria: arr(value.criteria) as unknown as VcrCriterion[],
    attrition: arr(value.attrition) as unknown as VcrAttritionStep[],
    outcome: value.outcome && typeof value.outcome === "object" ? value.outcome as VcrPopulationTab["outcome"] : null,
    profile: generatedKind ? [] : arr(value.profile).map(readProfileRow),
    profileKind: value.profileKind === "generated" || value.profileKind === "comparison" ? value.profileKind : null,
    generated: generatedKind ? arr(value.profile).map(readGeneratedRow) : [],
    records: typeof records.result === "string" && records.result ? { result: records.result, rows: finite(records.rows) } : null,
    constraints: arr(value.constraints).filter((item) => typeof item.label === "string" && finite(item.violations) !== null)
      .map((item) => ({ label: String(item.label), violations: Number(item.violations) })),
    download: typeof download.path === "string" ? { path: download.path, rows: finite(download.rows) } : null,
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
    knowledge: readVcrKnowledge(value.knowledge),
  };
}

/** Total over what the server might send: no records is an empty list, and a record the page cannot read is dropped. */
export function readVcrAssessments(raw: unknown): VcrAssessments {
  const value = obj(raw);
  const plan = obj(value.plan);
  return {
    records: arr(value.records).filter((record) => typeof record.key === "string" && record.key).map((record) => ({
      ...(record as unknown as VcrAssessmentRecord),
      rows: arr(record.rows) as unknown as VcrAssessmentRow[],
      gaps: strings(record.gaps),
      fields: {
        ...(obj(record.fields) as unknown as VcrAssessmentRecord["fields"]),
        technicalCriteria: arr(obj(record.fields).technicalCriteria) as unknown as VcrAssessmentRecord["fields"]["technicalCriteria"],
      },
    })),
    plan: Object.keys(plan).length ? plan as unknown as VcrAssessments["plan"] : null,
  };
}

function readCalibration(raw: unknown): VcrCalibration | null {
  const value = obj(raw);
  const rows = arr(value.rows).filter((row) => typeof row.key === "string" && row.key).map((row): VcrCalibrationRow => {
    const interval = obj(row.interval);
    const low = finite(interval.low);
    const high = finite(interval.high);
    return {
      key: String(row.key),
      label: text(row.label) ?? String(row.key),
      unit: text(row.unit),
      declared: finite(row.declared),
      generated: finite(row.generated),
      difference: finite(row.difference),
      interval: low === null && high === null ? null : { low, high, kind: interval.kind === "range" ? "range" : "prediction" },
      status: row.status === "within" || row.status === "outside" ? row.status : "unknown",
    };
  });
  if (rows.length === 0) return null;
  return { endpoint: value.endpoint === "time_to_event" || value.endpoint === "binary" || value.endpoint === "continuous" ? value.endpoint : null, rows };
}

export function readVcrPatients(raw: unknown): VcrPatientsTab {
  const value = obj(raw);
  const trajectories = obj(value.trajectories);
  const example = obj(value.example);
  const record = obj(example.record);
  const records = obj(value.records);
  const sensitivity = obj(value.sensitivity);
  return {
    ...(value as unknown as VcrPatientsTab),
    model: value.model ? readVcrModelCard(value.model) : null,
    assessments: readVcrAssessments(value.assessments),
    twin: value.twin && typeof value.twin === "object" ? value.twin as VcrPatientsTab["twin"] : null,
    records: typeof records.result === "string" && records.result
      ? {
        result: records.result,
        rows: finite(records.rows),
        arms: arr(records.arms).filter((arm) => typeof arm.value === "string").map((arm) => ({
          value: String(arm.value), label: text(arm.label) ?? String(arm.value), n: finite(arm.n) ?? 0, events: finite(arm.events),
        })),
      }
      : null,
    profile: value.profileKind === "generated" ? arr(value.profile).map(readGeneratedRow) : [],
    profileKind: value.profileKind === "generated" ? "generated" : null,
    calibration: readCalibration(value.calibration),
    trajectories: Object.keys(trajectories).length ? {
      xLabel: text(trajectories.xLabel), yLabel: text(trajectories.yLabel), ticks: strings(trajectories.ticks), series: readSeries(trajectories.series),
    } : null,
    example: Object.keys(example).length ? {
      ...(example as unknown as NonNullable<VcrPatientsTab["example"]>),
      title: text(example.title) ?? text(record.id) ?? "示例患者",
      record: { id: text(record.id) ?? "", source: (text(record.source) as VcrValueSource | null) ?? "synthetic", origin: text(record.origin) },
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
    prior: arr(value.prior).map((row) => ({ key: text(row.key) ?? "", label: text(row.label) ?? "", value: readVcrValue(row.value) })),
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
    forecasts: arr(value.forecasts).map((row) => ({ ...(row as unknown as VcrForecast), lines: arr(row.lines) as unknown as VcrForecast["lines"] })),
    milestones: arr(value.milestones).map((row) => ({
      design: text(row.design) ?? "", name: text(row.name) ?? "",
      items: arr(row.items).map((item) => ({ key: text(item.key) ?? "", label: text(item.label) ?? "", value: readVcrValue(item.value) })),
    })),
    schedule: readVcrSchedule(value.schedule),
    regulatory: arr(value.regulatory).map(readVcrRegulatoryContact),
    counts: readVcrCounts(value.counts),
    stale: readStale(value.stale),
    partial: readPartial(value.partial),
  };
}

/** The protocol's schedule, or nothing: a schedule with no visit is not drawn. */
export function readVcrSchedule(raw: unknown): VcrSchedule | null {
  const value = obj(raw);
  const visits = arr(value.visits).map((visit): VcrScheduleVisit => ({
    visit: text(visit.visit) ?? "",
    day: finite(visit.day),
    windowDays: finite(visit.windowDays),
    note: text(visit.note) ?? "",
    procedures: arr(visit.procedures).map((entry) => ({ name: text(entry.name) ?? "", note: text(entry.note) ?? "" })).filter((entry) => entry.name),
  })).filter((visit) => visit.visit);
  if (visits.length === 0) return null;
  const totals = obj(value.totals);
  return {
    protocolVersion: finite(value.protocolVersion),
    visits,
    totals: {
      visits: finite(totals.visits) ?? visits.length,
      activities: finite(totals.activities) ?? 0,
      entries: finite(totals.entries) ?? visits.reduce((sum, visit) => sum + visit.procedures.length, 0),
      firstDay: finite(totals.firstDay),
      lastDay: finite(totals.lastDay),
    },
  };
}

export function readVcrRegulatoryContact(raw: Loose): VcrRegulatoryContact {
  return {
    id: text(raw.id) ?? "",
    date: text(raw.date),
    agency: text(raw.agency) ?? "",
    type: text(raw.type) ?? "",
    summary: text(raw.summary) ?? "",
    outcome: text(raw.outcome) ?? "",
    attachments: strings(raw.attachments),
    source: raw.source === "ai_set" ? "ai_set" : "researcher",
    recordedAt: text(raw.recordedAt),
  };
}

function readPatientTrials(raw: unknown): VcrPatientTrials {
  const value = obj(raw);
  const selected = obj(value.selected);
  return {
    available: value.available !== false,
    subject: typeof value.subject === "string" ? value.subject : null,
    trials: arr(value.trials).map((trial) => ({
      ...(trial as unknown as VcrPatientTrial),
      conditions: strings(trial.conditions),
      sites: trial.sites && typeof trial.sites === "object" ? { ...(trial.sites as Loose), countries: strings(obj(trial.sites).countries) } as VcrPatientTrial["sites"] : null,
      counts: { satisfied: 0, unknown: 0, notSatisfied: 0, pending: 0, ...obj(trial.counts) } as VcrPatientTrial["counts"],
    })),
    selected: Object.keys(selected).length && typeof selected.id === "string"
      ? { ...(selected as unknown as NonNullable<VcrPatientTrials["selected"]>), criteria: arr(selected.criteria) as unknown as VcrCriterionJudgement[] } : null,
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
    // What is not an object is no page of trials (the raw key is dropped, not passed through): the tab reads as the other direction's.
    patientTrials: value.patientTrials && typeof value.patientTrials === "object" ? readPatientTrials(value.patientTrials) : undefined,
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
    precedentCandidates: arr(value.precedentCandidates) as unknown as VcrPrecedentCandidate[],
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

function readPackSource(raw: Loose): VcrPackSource {
  return {
    id: text(raw.id) ?? "", title: text(raw.title) ?? "", url: text(raw.url) ?? "", licence: text(raw.licence) ?? "",
    licenceName: text(raw.licenceName), use: raw.use === "attribution" || raw.use === "link-only" || raw.use === "own" ? raw.use : null,
    accessed: text(raw.accessed),
  };
}

export function readVcrPackSummary(raw: unknown): VcrPackSummary {
  const value = obj(raw);
  return {
    origin: value.origin === "stored" ? "stored" : "shipped",
    id: text(value.id) ?? "", diseaseKey: text(value.diseaseKey) ?? "", name: text(value.name), nameZh: text(value.nameZh),
    version: finite(value.version) ?? 1,
    status: value.status === "curated" ? "curated" : "ai-draft",
    counts: Object.fromEntries(Object.entries(obj(value.counts)).filter((entry): entry is [string, number] => typeof entry[1] === "number")),
    sources: arr(value.sources).map(readPackSource),
    reviewedBy: text(value.reviewedBy), reviewedAt: text(value.reviewedAt), boundAt: text(value.boundAt), canPromote: value.canPromote === true,
    ...(obj(value.binding).resolution === "newest_compatible" ? { binding: { resolution: "newest_compatible" as const } } : {}),
    ...(value.platform && typeof value.platform === "object" ? { platform: value.platform as VcrPackSummary["platform"] } : {}),
    ...(value.platformRequest && typeof value.platformRequest === "object" ? { platformRequest: value.platformRequest as VcrPackSummary["platformRequest"] } : {}),
  };
}

function readPackRefs(raw: unknown): Array<{ section: string; id: string; concept?: string }> {
  return arr(raw).map((ref) => ({ section: text(ref.section) ?? "", id: text(ref.id) ?? "", ...(text(ref.concept) ? { concept: text(ref.concept) as string } : {}) }))
    .filter((ref) => ref.section && ref.id);
}

export function readVcrKnowledge(raw: unknown): VcrKnowledge | null {
  const value = obj(raw);
  if (!Object.keys(value).length) return null;
  return {
    pack: value.pack && typeof value.pack === "object" ? readVcrPackSummary(value.pack) : null,
    definitions: arr(value.definitions).map((item) => ({
      definitionId: text(item.definitionId) ?? "", version: finite(item.version) ?? 1, populationId: text(item.populationId), name: text(item.name) ?? "",
      text: text(item.text) ?? "", versions: finite(item.versions) ?? 1, uses: finite(item.uses) ?? 1, usedAt: text(item.usedAt), packRefs: readPackRefs(item.packRefs),
    })),
    comparisons: arr(value.comparisons).map((item) => ({
      id: text(item.id) ?? "", definitionId: text(item.definitionId) ?? "", versionA: finite(item.versionA) ?? 0, versionB: finite(item.versionB) ?? 0,
      snapshotId: text(item.snapshotId), cohortSizeA: finite(item.cohortSizeA), cohortSizeB: finite(item.cohortSizeB),
      overlap: { both: finite(obj(item.overlap).both), onlyA: finite(obj(item.overlap).onlyA), onlyB: finite(obj(item.overlap).onlyB) },
      covariates: arr(item.covariates).map((entry) => {
        const kind: "binary" | "continuous" | null = entry.kind === "binary" ? "binary" : entry.kind === "continuous" ? "continuous" : null;
        return {
          covariate: text(entry.covariate) ?? "", ...(kind ? { kind } : {}),
          meanA: finite(entry.meanA), meanB: finite(entry.meanB), standardizedDifference: finite(entry.standardizedDifference), skipped: text(entry.skipped),
        };
      }).filter((entry) => entry.covariate),
      floor: finite(item.floor), createdAt: text(item.createdAt),
    })).filter((item) => item.id && item.definitionId),
    savable: arr(value.savable).map((item) => ({ populationId: text(item.populationId) ?? "", label: text(item.label) ?? "", name: text(item.name) ?? "" }))
      .filter((item) => item.populationId),
  };
}

function readLibraryVersion(raw: Loose): VcrLibraryVersion {
  return {
    version: finite(raw.version) ?? 1, text: text(raw.text) ?? "", rules: arr(raw.rules) as VcrLibraryVersion["rules"],
    packRefs: readPackRefs(raw.packRefs), createdAt: text(raw.createdAt),
  };
}

export function readVcrLibrary(raw: unknown): VcrLibraryEntry[] {
  return arr(obj(raw).definitions).map((item) => ({
    id: text(item.id) ?? "", name: text(item.name) ?? "", versions: finite(item.versions) ?? 1, uses: finite(item.uses) ?? 0, updatedAt: text(item.updatedAt),
    latest: item.latest && typeof item.latest === "object" ? readLibraryVersion(item.latest as Loose) : null,
  })).filter((item) => item.id);
}

export function readVcrLibraryDetail(raw: unknown): VcrLibraryDetail {
  const value = obj(raw);
  return {
    id: text(value.id) ?? "", name: text(value.name) ?? "", uses: finite(value.uses) ?? 0, versions: arr(value.versions).map(readLibraryVersion),
    studies: arr(value.studies).map((item) => ({ version: finite(item.version) ?? 1, studyId: text(item.studyId) ?? "", studyName: text(item.studyName) ?? "", at: text(item.at) })),
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

/**
 * 「新建研究」: a draft study, its project and its conversation — nothing on the list until the first definition names it. A study
 * made with a name or a question is an active one.
 */
export function createVcrStudy(input: VcrCreateBody = {}) {
  return productRequest<{ id: string; projectId: string; sessionId: string | null; status?: VcrStudyStatus }>("/vcr/studies", "POST", studyCreateBody(input));
}

export async function getVcrStudy(studyId: string): Promise<VcrStudy> {
  return readVcrStudy(await productRequest<unknown>(study(studyId)));
}

/**
 * What the conversation frame's chip needs of a study: where it starts, what it is for, and what this reader may change — nothing of
 * the page. The same fields `frameVcrOptions` reads from a whole `VcrStudy`.
 */
export type VcrFrameStudy = Pick<VcrStudy, "id" | "intendedUse" | "steps" | "abilities">;

/**
 * The study a project belongs to — a draft included, which the home list leaves out. A conversation knows its project and not its
 * study, so the frame's options for a study nobody has spoken in yet are found here, without the page's heavy reading. A project that
 * is no study answers 404.
 */
export async function getVcrStudyOfProject(projectId: string): Promise<VcrFrameStudy> {
  const value = obj(await productRequest<unknown>(`/vcr/studies/of-project/${id(projectId)}`));
  return {
    id: text(value.id) ?? "",
    intendedUse: (text(value.intendedUse) ?? "exploratory") as VcrStudy["intendedUse"],
    steps: readSteps(value.steps),
    abilities: strings(value.abilities),
  };
}

export function patchVcrStudy(studyId: string, input: VcrPatchBody) {
  return productRequest<unknown>(study(studyId), "PATCH", studyPatchBody(input));
}

export function deleteVcrStudy(studyId: string) {
  return productRequest<unknown>(study(studyId), "DELETE");
}

/**
 * 「下载记录（CSV）」: the generated records of the study's population, as a file. The route is the records route's own and answers a
 * refusal by name (a real cohort's rows never leave the data plane), so the file is fetched and handed over only when it came: a
 * plain link would save an error page under the file's name.
 */
export async function downloadVcrRecords(studyId: string, path: string): Promise<void> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${study(studyId)}/${path.split("/").map(id).join("/")}`);
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: string; code?: string; requestId?: string } | null;
    throw new WebApiError(value?.error ?? "The records were unavailable.", { status: response.status, code: value?.code, requestId: value?.requestId });
  }
  const blob = await response.blob();
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = named ? decodeURIComponent(named) : "synthetic-records.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 「重命名」: the study's name, and the project's with it. */
export function renameVcrStudy(studyId: string, name: string) {
  return patchVcrStudy(studyId, { name });
}

/** One conversation the programme opened in the study's project, as 「AI 运行」 lists it. */
export interface VcrBackgroundRun {
  sessionId: string;
  /** The capability's product name: 「虚拟临床研究 · 证据」. */
  label: string;
  state: "running" | "finished" | "stopped";
  /** 「今天 14:32」. */
  at: string | null;
}

export async function getVcrBackgroundRuns(studyId: string): Promise<VcrBackgroundRun[]> {
  const value = obj(await productRequest<unknown>(`${study(studyId)}/runs`));
  return arr(value.runs).filter((item) => typeof item.sessionId === "string").map((item) => ({
    sessionId: String(item.sessionId), label: text(item.label) ?? "后台分析",
    state: item.state === "running" || item.state === "finished" ? item.state : "stopped", at: text(item.at),
  }));
}

/** What a page form may change in one of the study's objects: the numbers it offers, named, with the range each takes. */
export type VcrCardKind = "population" | "trial_scenario" | "criteria";

export interface VcrCardSetting {
  /** The setting's address inside the object; sent back as it came. */
  path: string;
  label: string;
  value: number;
  unit: string | null;
  integer: boolean;
  min: number | null;
  max: number | null;
}

export interface VcrCardSettings {
  kind: VcrCardKind;
  objectId: string;
  title: string;
  settings: VcrCardSetting[];
}

export async function getVcrCardSettings(studyId: string, kind: VcrCardKind, objectId?: string | null): Promise<VcrCardSettings> {
  const query = new URLSearchParams({ kind, ...(objectId ? { object: objectId } : {}) });
  const value = obj(await productRequest<unknown>(`${study(studyId)}/cards?${query}`));
  return {
    kind, objectId: text(value.objectId) ?? "", title: text(value.title) ?? "",
    settings: arr(value.settings).filter((item) => typeof item.path === "string" && finite(item.value) !== null).map((item) => ({
      path: String(item.path), label: text(item.label) ?? String(item.path), value: Number(item.value), unit: text(item.unit),
      integer: item.integer === true, min: finite(item.min), max: finite(item.max),
    })),
  };
}

/** Write the object's next version with the typed numbers; what stood on the old version is recomputed. */
export function editVcrCard(studyId: string, input: { kind: VcrCardKind; objectId?: string | null; set?: Record<string, number>; regenerate?: boolean }) {
  return productRequest<{ kind: VcrCardKind; id: string; version: number; changed: number }>(`${study(studyId)}/cards`, "POST", {
    kind: input.kind, ...(input.objectId ? { objectId: input.objectId } : {}),
    // `regenerate` is the population again with the settings it has; otherwise the typed numbers.
    ...(input.regenerate ? { regenerate: true } : { set: input.set ?? {} }),
  });
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

/**
 * 「为该患者找试验」: asks for a run of the matching capability that searches the registries for this patient. The answer is a run's, like a
 * step's (a deferred one has no run); `evaluated` is how many verdicts the trials the study already holds now have about the patient.
 */
export function runVcrTrialSearch(studyId: string, subjectKey: string) {
  return productRequest<VcrRunAnswer>(`${study(studyId)}/trial-search`, "POST", trialSearchBody(subjectKey));
}

/**
 * Start one step, now or when its turn comes. The answer says what was taken and what waits (`VcrRunAnswer`); the page does not move,
 * and the result appears in the tab that holds it.
 */
export function runVcrStep(studyId: string, step: VcrStepKey) {
  return productRequest<VcrRunAnswer>(`${study(studyId)}/run`, "POST", runBody(step));
}

/**
 * 「取消」: stop what the study is doing — the run its one slot holds and every engine job that is open, and **hold the programme**: a
 * cancel is not followed by the next step, and nothing starts by itself until a person asks for a step. The steps not done come back
 * as `held`. Idempotent; nothing out answers `{ runId: null, jobs: 0, held }`.
 */
export function cancelVcrStudy(studyId: string) {
  return productRequest<{ canceled: { runId: string | null; jobs: number; held?: string[] } }>(`${study(studyId)}/cancel`, "POST", {});
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

/** 「保存」 on a model assessment record: the next version of it, by the person who edits. The model risk is the server's to work out. */
export function saveVcrModelAssessment(studyId: string, input: VcrAssessmentBody) {
  return productRequest<{ id: string; key: string; version: number; risk: string | null }>(`${study(studyId)}/model-assessments`, "POST", assessmentBody(input));
}

/** 「签注复核」: a countersignature on named versions, never a gate (plan §10.2). */
export function signVcrReview(studyId: string, input: VcrReviewBody) {
  return productRequest<unknown>(`${study(studyId)}/reviews`, "POST", reviewBody(input));
}

/** 「写入决策记录」: the reader's comparison goal and the design they chose. */
export function recordVcrDecision(studyId: string, input: VcrDecisionBody) {
  return productRequest<unknown>(`${study(studyId)}/decisions`, "POST", decisionBody(input));
}

/** 「添加」 on the regulatory log: the contact is added to the study's record, never edited; the identical one already there answers 200. */
export function addVcrRegulatoryContact(studyId: string, input: VcrRegulatoryContactBody) {
  return productRequest<VcrRegulatoryContact>(`${study(studyId)}/regulatory-contacts`, "POST", regulatoryContactBody(input));
}

/** 「导出」: the package is written by a run the page watches in its activity strip; a run that waits answers `runId: null`. */
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

/** The packs the account can use (shipped ones, and its own curated or bound drafts); `q` is the server's own search word. */
export async function getVcrPacks(query: { q?: string } = {}): Promise<VcrPackSummary[]> {
  const suffix = query.q ? `?${new URLSearchParams({ q: query.q }).toString()}` : "";
  return arr(obj(await productRequest<unknown>(`/vcr/packs${suffix}`)).packs).map(readVcrPackSummary);
}

/** Work from this pack of the catalogue. */
export function bindVcrPack(studyId: string, packId: string) {
  return productRequest<unknown>(`${study(studyId)}/pack`, "POST", packBindBody(packId));
}

/** A reviewed draft becomes curated (the lead, or an operator). */
export function promoteVcrPack(studyId: string) {
  return productRequest<unknown>(`${study(studyId)}/pack/promote`, "POST", {});
}

/** The result of asking for a curated pack to become a platform pack: the re-check's verdict and, when it failed, the entries that did. */
export interface VcrPlatformPackAnswer {
  state: "passed" | "failed";
  existing: boolean;
  failing: Array<{ section: string | null; id: string; code: string; detail: string }>;
}

/** 申请成为平台知识包 (the study's lead): the code re-checks the pack; a pack that passes is copied as the platform's, one that fails stays the account's. */
export async function requestVcrPlatformPack(studyId: string): Promise<VcrPlatformPackAnswer> {
  const value = obj(await productRequest<unknown>(`${study(studyId)}/pack/platform`, "POST", {}));
  return {
    state: value.state === "passed" ? "passed" : "failed", existing: value.existing === true,
    failing: arr(value.failing).map((entry) => ({ section: text(entry.section), id: text(entry.id) ?? "", code: text(entry.code) ?? "", detail: text(entry.detail) ?? "" })),
  };
}

/** 发布到模拟研究 (the study's lead): the public form of one report. The server reads every number from the report; the page sends words only. */
export function publishVcrSimulation(studyId: string, body: { exportId: string; title: string; summary: string }) {
  return productRequest<unknown>(`${study(studyId)}/publications`, "POST", { exportId: body.exportId, title: body.title, summary: body.summary });
}

/** Take a report out of 模拟研究. */
export function withdrawVcrSimulation(studyId: string, publicationId: string) {
  return productRequest<unknown>(`${study(studyId)}/publications/${id(publicationId)}`, "DELETE");
}

/** 登记预测: file one trial scenario's prediction of a registered trial's primary endpoint. The number is read from the engine result at `resultPath`; the page types none. */
export function fileVcrPrediction(studyId: string, body: { scenarioId: string; registryId: string; endpoint: string; resultPath: string }) {
  return productRequest<unknown>(`${study(studyId)}/predictions`, "POST", {
    scenarioId: body.scenarioId, registryId: body.registryId, endpoint: body.endpoint, resultPath: body.resultPath,
  });
}

/** The account's library of population definitions. */
export async function getVcrLibrary(): Promise<VcrLibraryEntry[]> {
  return readVcrLibrary(await productRequest<unknown>("/vcr/definitions"));
}

export async function getVcrLibraryDetail(definitionId: string): Promise<VcrLibraryDetail> {
  return readVcrLibraryDetail(await productRequest<unknown>(`/vcr/definitions/${id(definitionId)}`));
}

/** Save one of the study's populations into the library (a new entry, or the next version of `definitionId`). */
export function saveVcrDefinition(studyId: string, input: VcrDefinitionSaveBody) {
  return productRequest<{ definitionId: string; name: string; version: number }>(`${study(studyId)}/definitions`, "POST", definitionSaveBody(input));
}

/** Use a library definition in the study; the answer lists the columns renamed and the ones left unmatched. */
export function reuseVcrDefinition(studyId: string, definitionId: string, input: VcrDefinitionUseBody = {}) {
  return productRequest<{ populationId: string; version: number; renamed: Array<{ from: string; to: string }>; unmatched: string[] }>(
    `${study(studyId)}/definitions/${id(definitionId)}/use`, "POST", definitionUseBody(input));
}

/** Queue the engine's comparison of two versions of a definition on the study's registered dataset. */
export function compareVcrDefinition(studyId: string, definitionId: string, input: VcrDefinitionCompareBody) {
  return productRequest<{ job: { id: string }; created: boolean }>(
    `${study(studyId)}/definitions/${id(definitionId)}/compare`, "POST", definitionCompareBody(input));
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

/**
 * What a press of a step, an export or a patient's trial search answers: that the request was taken, the run it started now, and what
 * waits for what. **There is no conversation in it and nothing to navigate to** — the page stays and reads `activity`.
 */
export interface VcrRunAnswer {
  accepted?: boolean;
  /** The run this press started now; null when the step was taken and waits (the study's one slot is held, or the allowance does not cover it yet). */
  runId?: string | null;
  step?: VcrStepKey | null;
  /** Every step that is queued and not in the run that is out. */
  queuedBehind?: Array<{ step: VcrStepKey; waitingFor: VcrWaitingFor | null }>;
  /** The package row of an export. */
  export?: { id?: string } | null;
  /** 「为该患者找试验」: how many verdicts the trials the study already held now have about the patient. */
  evaluated?: number | null;
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

import {
  confirmFieldMapBody, fieldMapBody, freezeBody, grantBody, importQuery, sourceBody, uploadQuery,
  type VcrFieldMapEntry, type VcrGrantBody, type VcrImportFormat, type VcrSourceBody,
} from "./vcrIntakeBodies";

export type { VcrFieldMapEntry, VcrFieldRole, VcrGrantBody, VcrImportFormat, VcrSourceBody } from "./vcrIntakeBodies";

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
  /** A table a FHIR, OMOP or ADaM import produced: which standard it came from. */
  importFormat: string | null;
  /** The text of this record was erased (a withdrawal): the row and its hashes stay. */
  erased?: boolean;
  /** The reviewed texts saved of this record that are still live. */
  projections?: Array<{ id: string; at: string | null }>;
  /** A reviewed record: how many characters a run was shown of its text and how many it never was (`null` when it is not reviewed). */
  reading: { chars: number | null; read: number; skipped: number | null; complete: boolean } | null;
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

export interface VcrCloudPermission {
  /** `default` clears the record: the source then follows the deployment's agreements with its model providers. */
  status: 'approved' | 'revoked' | 'default'; dataClass?: 'public' | 'synthetic' | 'deidentified' | 'clinical'; destinations?: string[];
  purpose?: 'vcr'; reference?: string; retention?: 'none' | 'limited' | 'unknown'; training?: 'disabled' | 'unknown';
  humanReview?: 'disabled' | 'unknown'; expiresAt?: string | null;
}
/** Where a source stands for the cloud models: open on a basis, restricted by an operator, or closed (nothing recorded, no agreements). */
export interface VcrCloudState { state: 'allowed' | 'restricted' | 'closed'; basis: 'deployment_agreements' | 'source_permission' | null }
export interface VcrIntakeSource {
  cloudPermission?: VcrCloudPermission | null;
  /** Absent from an older server; the page then reads the recorded permission. */
  cloud?: VcrCloudState | null;
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
    cloudDestinations?: string[];
    formats: string[]; maxBytes: number | null; maxText: string | null;
    /** A patient record: text, and PDF or Word where the deployment converts them (the page offers only what would be taken). */
    documents: { formats: string[]; maxBytes: number | null; maxText: string | null; converter: boolean };
    /** A source held in FHIR, OMOP or ADaM: what this deployment converts, and what each standard is uploaded as. */
    imports: { available: boolean; formats: Array<{ value: VcrImportFormat; extensions: string[] }>; maxBytes: number | null; maxText: string | null };
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
    sourceFormat: text(raw.sourceFormat), pages: finite(raw.pages), blankPages: finite(raw.blankPages), importFormat: text(raw.importFormat),
    ...(raw.erased === true ? { erased: true } : {}),
    ...(arr(raw.projections).length ? { projections: arr(raw.projections).map((projection) => ({ id: text(projection.id) ?? "", at: text(projection.at) })) } : {}),
    reading: finite(obj(raw.reading).read) !== null
      ? { chars: finite(obj(raw.reading).chars), read: finite(obj(raw.reading).read) ?? 0, skipped: finite(obj(raw.reading).skipped), complete: obj(raw.reading).complete === true } : null,
  };
}

function readCloudState(raw: unknown): VcrCloudState | null {
  const cloud = obj(raw);
  const state = text(cloud.state);
  if (state !== 'allowed' && state !== 'restricted' && state !== 'closed') return null;
  const basis = text(cloud.basis);
  return { state, basis: basis === 'deployment_agreements' || basis === 'source_permission' ? basis : null };
}

function readIntakeSource(raw: Loose): VcrIntakeSource {
  const map = obj(raw.fieldMap);
  const upload = obj(raw.upload);
  const state = text(map.state);
  return {
    id: text(raw.id) ?? "", name: text(raw.name) ?? "", ownerParty: text(raw.ownerParty), mine: raw.mine === true, readable: raw.readable === true,
    canGrant: raw.canGrant === true, status: text(raw.status) ?? "registered", statusLabel: text(raw.statusLabel) ?? "",
    valueSource: text(raw.valueSource) ?? "observed", valueSourceLabel: text(raw.valueSourceLabel) ?? "",
    cloudPermission: raw.cloudPermission as VcrCloudPermission | null ?? null,
    cloud: readCloudState(raw.cloud),
    allowedUses: strings(raw.allowedUses), window: text(raw.window), retention: text(raw.retention),
    upload: {
      cloudDestinations: strings(upload.cloudDestinations),
      formats: strings(upload.formats), maxBytes: finite(upload.maxBytes), maxText: text(upload.maxText),
      documents: {
        formats: strings(obj(upload.documents).formats), maxBytes: finite(obj(upload.documents).maxBytes),
        maxText: text(obj(upload.documents).maxText), converter: obj(upload.documents).converter === true,
      },
      imports: {
        available: obj(upload.imports).available === true,
        formats: arr(obj(upload.imports).formats).flatMap((format) => {
          const value = text(format.value);
          return value === "fhir" || value === "omop" || value === "adam" ? [{ value: value as VcrImportFormat, extensions: strings(format.extensions) }] : [];
        }),
        maxBytes: finite(obj(upload.imports).maxBytes), maxText: text(obj(upload.imports).maxText),
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

export const setVcrCloudPermission = (studyId: string, sourceId: string, permission: VcrCloudPermission) =>
  productRequest(`${dataRoute(studyId)}/sources/${encodeURIComponent(sourceId)}/cloud-permission`, 'POST', { permission });
/** An identifier of a closed format found in a record (a resident identity number, a mobile number, a record number, a date), as a span to accept. */
export interface VcrIdentifierSuggestion {
  start: number; end: number; format: 'resident_id' | 'record_number' | 'mobile' | 'date'; kind: string;
  /** A date written after a word for birth. */
  birth?: true;
}
export const getVcrProtectedDocument = (studyId: string, documentId: string) =>
  productRequest<{ document: { id: string; text: string; sourceHash: string; suggestions?: VcrIdentifierSuggestion[] } }>(`${dataRoute(studyId)}/documents/${encodeURIComponent(documentId)}`, 'GET');
export const createVcrProjection = (studyId: string, documentId: string, input: { sourceHash: string; spans: Array<{ start: number; end: number; kind: string }>; attestation: string }) =>
  productRequest(`${dataRoute(studyId)}/documents/${encodeURIComponent(documentId)}/projection`, 'POST', input);
export const resolveVcrQuote = (studyId: string, documentId: string, span: { start: number; end: number; quote: string }) =>
  productRequest<{ evidence: { quote: string } }>(`${dataRoute(studyId)}/documents/${encodeURIComponent(documentId)}/quote`, 'POST', span);
export const enqueueVcrMatching = (studyId: string, selection: { protocolVersionIds: string[]; subjectKeys?: string[]; direction: string }) =>
  productRequest<{ jobs: Array<{ jobId: string; state: string }>; unavailable: Array<{ code: string }> }>(`${study(studyId)}/jobs`, 'POST', { kind: 'match_criteria', selection });

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

/** What a standard-format import answers: the tables it produced, the field map it proposed and what it read, imported and skipped. */
export interface VcrImportResult {
  format: VcrImportFormat;
  standard: Record<string, string>;
  tables: Array<{ name: string; file: string; rows: number; columns: number; stored: boolean; reason?: string }>;
  fieldMap: { hash: string; entries: number; trimmed: number; columnSourcesDeclared: boolean };
  coverage: {
    inputs: Array<{ kind: string; records: number | null; imported: number; status: "imported" | "skipped"; reason: string | null; skipped: Record<string, number> }>;
    skippedTables: Array<{ table: string; reason: string }>;
    notices: Array<{ code: string; count: number; examples?: string[] }>;
  };
}

/**
 * Import a source held in FHIR, OMOP or ADaM: the raw file as the request body,
 * its name and the standard in the query — streamed by the browser, converted
 * inside the deployment into the module's own tables, a dictionary and a proposed
 * field map. A refusal is a `WebApiError` with the plane's own code
 * (`vcr_import_not_this_format`, `vcr_import_nothing_to_import`, …).
 */
export async function importVcrSource(studyId: string, sourceId: string, file: Blob, input: { name: string; format: VcrImportFormat }) {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}${dataRoute(studyId)}/sources/${id(sourceId)}/imports?${importQuery(input)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
  });
  const value = await response.json().catch(() => null) as { data?: VcrImportResult; error?: string; code?: string } | null;
  if (!response.ok || !value || !("data" in value)) {
    throw new WebApiError(value?.error ?? "The import was refused.", { status: response.status, code: value?.code });
  }
  return value.data as VcrImportResult;
}

/** `erased`: an evaluation was frozen on the record, so its text was erased and its row and hashes stay. */
export function removeVcrFile(studyId: string, fileId: string) {
  return productRequest<{ removed: boolean; erased?: boolean }>(`${dataRoute(studyId)}/files/${id(fileId)}`, "DELETE");
}

/** What a withdrawal or a retirement did, in counts: records and reviewed texts erased, what was read from them deleted or redacted. */
export interface VcrErasure { files?: number; projections?: number; factsRemoved?: number; factsRedacted?: number; referralsClosed?: number; filesFailed?: number }

/** A subject's consent withdrawn: the text of their records and of the reviewed texts of them is erased; hashes and the audit trail stay. */
export function withdrawVcrSubject(studyId: string, subjectKey: string) {
  return productRequest<{ withdrawn: VcrErasure }>(`${dataRoute(studyId)}/subjects/${id(subjectKey)}/withdraw`, "POST", {});
}

/** A reviewed text that missed an identifier, retired: it is not read again, its text is erased, and the newest live one (or the record) is read instead. */
export function retireVcrProjection(studyId: string, projectionId: string) {
  return productRequest<{ retired: VcrErasure }>(`${dataRoute(studyId)}/projections/${id(projectionId)}/retire`, "POST", {});
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
