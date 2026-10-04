/**
 * The bodies the browser posts to `/api/vcr/*` — one plain function per write,
 * each returning exactly the keys the route's allow-list accepts and nothing
 * else (contract 2026-09-29 §5).
 *
 * Hidden knowledge:
 *
 *  - **A route refuses a key it does not list** (`vcr_payload_invalid`), so a
 *    body that carries one more field than the route knows is a write that
 *    never lands — and, until the review of 2026-09-29, the budget dialog, the
 *    decision card and the review and assumption calls all did exactly that
 *    and said 「暂时无法…」 to the reader. The types here are the allow-lists;
 *    there is no field a caller can type that a route would refuse.
 *  - **Plain functions, no imports.** `apps/server/test/vcrClientBodies.test.mjs`
 *    loads this file under Node and posts each builder's output to the real
 *    `createVcrRoutes`, so a route that changes its allow-list turns that test
 *    red instead of a button quietly failing in a browser. Erasable TypeScript
 *    only (no enums, no parameter properties) is what lets Node read it.
 */

/** A member's role (`VCR_MEMBER_ROLES`). */
export type VcrBodyRole =
  | "lead" | "clinical_reviewer" | "statistical_reviewer" | "data_manager" | "recruiter" | "site" | "viewer";

export interface VcrCreateBody {
  name?: string;
  question?: string;
  dataTier?: "T0" | "T1" | "T2" | "T3";
  intendedUse?: "exploratory" | "design_support" | "specified_analysis" | "submission_preparation";
  /** One of the home page's four action cards. */
  action?: "cohort" | "patients" | "comparator" | "trial";
}

/**
 * What a study's settings may change. The compute budget is not among them: it
 * moves only through the audited confirmation.
 *
 * `dataTier`, `intendedUse` and `status` are the lead's (`manage_study`);
 * `name`, `question` and `action` are anybody's who may write.
 */
export interface VcrPatchBody {
  name?: string;
  question?: string;
  dataTier?: "T0" | "T1" | "T2" | "T3";
  intendedUse?: "exploratory" | "design_support" | "specified_analysis" | "submission_preparation";
  status?: "active" | "paused" | "archived";
  /**
   * The composer's 起点: where the study starts. `auto` asks for all seven
   * steps, one of the four action ids for that one step (the study's
   * `requested` flags, which is where `POST /studies` writes the same word).
   */
  action?: "auto" | "cohort" | "patients" | "comparator" | "trial";
}

export interface VcrJobBody {
  kind: string;
  scenario?: Record<string, unknown>;
  inputs?: unknown[];
  seed?: number;
  replicates?: number;
  cpuSecondsLimit?: number;
}

/** `{ jobId }` releases one waiting job; `{ cpuSeconds }` adds CPU time and releases what waited on it. */
export type VcrBudgetBody = { jobId: string } | { cpuSeconds: number };

export interface VcrAssumptionBody {
  /** The card's key: a new version is written under it. */
  key: string;
  name?: string;
  endpoint?: string;
  unit?: string;
  pointValue?: number;
  distribution?: Record<string, unknown>;
  sensitivity?: Record<string, unknown>;
  sourceKind?: "local_observation" | "external_evidence" | "expert_set" | "model_prediction" | "scenario";
  valueSource?: string;
  poolingMethod?: string;
  pooling?: Record<string, unknown>;
  evidenceIds?: string[];
  applicability?: Record<string, unknown>;
  note?: string;
}

export interface VcrReviewBody {
  kind: "clinical" | "statistical" | "data";
  /** The version ids the countersignature is on: `assumption:os_hr@3`. */
  nodes: string[];
  note?: string;
  changes?: unknown[];
}

export interface VcrDecisionBody {
  /** What was decided: the comparison goal. Required — a decision with no goal is not written. */
  question: string;
  chosen?: Record<string, unknown>;
  alternatives?: unknown[];
  rationale?: string;
}

export interface VcrMemberBody {
  userId: string;
  role: VcrBodyRole;
  /** A `site` member names the site it belongs to; the route refuses the role without it. */
  detail?: { siteId?: string; note?: string };
}

export interface VcrContactBody {
  note?: string;
  reason?: string;
}

/**
 * One move on the referral ledger. A move into a contact state is refused
 * unless a person confirmed the referral first (`contactBody`'s route), so the
 * only moves the page makes with this are the ones that are not contact:
 * 「请求补证」 is `to: "needs_evidence"`.
 */
export interface VcrTransitionBody {
  to: "candidate" | "needs_evidence" | "contactable" | "contacted" | "interested" | "referred" | "site_responded"
    | "screening" | "enrolled" | "screen_failed" | "withdrawn";
  note?: string;
  siteId?: string;
  screenFailCriterionId?: string;
  screenFailReason?: string;
  enrolledOn?: string;
}

/**
 * A model taken into the account's library (`POST /api/vcr/models`): a
 * prediction model a published trial fitted, always a literature-tier model.
 * Its applicability is written by the server from the trials it names — the
 * page never states a population nobody fitted the model on.
 */
export interface VcrModelBody {
  /** A model taken from a study is written into that study's library by someone who may write there. */
  studyId?: string;
  name: string;
  version?: string;
  risk?: "none" | "low" | "medium" | "high";
  endpointType?: "continuous" | "binary" | "time_to_event";
  /** The trials the model was fitted on, one label each. */
  sources?: string[];
}

/** A person's re-judgment of one criterion; the platform's own answer is kept beside it. */
export interface VcrJudgmentBody {
  state: "satisfied" | "not_satisfied" | "unknown" | "pending_recheck";
  note?: string;
}

/** Drop the keys nobody set, so the body is exactly what was said. */
function said<T extends Record<string, unknown>>(entries: T): Partial<T> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) body[key] = value;
  return body as Partial<T>;
}

export function studyCreateBody(input: VcrCreateBody = {}) {
  return said({ name: input.name, question: input.question, dataTier: input.dataTier, intendedUse: input.intendedUse, action: input.action });
}

export function studyPatchBody(input: VcrPatchBody = {}) {
  return said({
    name: input.name, question: input.question, dataTier: input.dataTier, intendedUse: input.intendedUse, status: input.status,
    action: input.action,
  });
}

export function runBody(step: string) {
  return { step };
}

export function jobBody(input: VcrJobBody) {
  return said({
    kind: input.kind, scenario: input.scenario, inputs: input.inputs, seed: input.seed, replicates: input.replicates,
    cpuSecondsLimit: input.cpuSecondsLimit,
  });
}

export function cancelBody() {
  return {};
}

export function budgetBody(input: VcrBudgetBody) {
  return "jobId" in input ? { jobId: input.jobId } : { cpuSeconds: Math.max(1, Math.ceil(input.cpuSeconds)) };
}

export function assumptionBody(input: VcrAssumptionBody) {
  return said({
    key: input.key, name: input.name, endpoint: input.endpoint, unit: input.unit, pointValue: input.pointValue,
    distribution: input.distribution, sensitivity: input.sensitivity, sourceKind: input.sourceKind, valueSource: input.valueSource,
    poolingMethod: input.poolingMethod, pooling: input.pooling, evidenceIds: input.evidenceIds, applicability: input.applicability,
    note: input.note,
  });
}

/**
 * A model assessment record, as a person's edit of it: the guideline's fields and nothing the platform derives. The model risk is
 * worked out from the two ratings on the server and has no field here.
 */
export interface VcrAssessmentBody {
  key: string;
  questionOfInterest?: string;
  contextOfUse?: string;
  influence?: "low" | "medium" | "high" | "";
  influenceJustification?: string;
  consequence?: "low" | "medium" | "high" | "";
  consequenceJustification?: string;
  riskJustification?: string;
  impact?: "low" | "medium" | "high" | "";
  impactJustification?: string;
  technicalCriteria?: Array<{ criterion: string; rationale: string }>;
  appropriateness?: string;
  evaluation?: string;
  outcome?: string;
}

export function assessmentBody(input: VcrAssessmentBody) {
  return said({
    key: input.key, questionOfInterest: input.questionOfInterest, contextOfUse: input.contextOfUse,
    influence: input.influence, influenceJustification: input.influenceJustification,
    consequence: input.consequence, consequenceJustification: input.consequenceJustification,
    riskJustification: input.riskJustification,
    impact: input.impact, impactJustification: input.impactJustification,
    technicalCriteria: input.technicalCriteria, appropriateness: input.appropriateness,
    evaluation: input.evaluation, outcome: input.outcome,
  });
}

export function reviewBody(input: VcrReviewBody) {
  return said({ kind: input.kind, nodes: input.nodes, note: input.note, changes: input.changes });
}

export function decisionBody(input: VcrDecisionBody) {
  return said({ question: input.question.trim(), chosen: input.chosen, alternatives: input.alternatives, rationale: input.rationale });
}

export function exportBody(kind: string) {
  return { kind };
}

export function memberBody(input: VcrMemberBody) {
  const detail = input.detail ? said({ siteId: input.detail.siteId, note: input.detail.note }) : undefined;
  return said({ userId: input.userId, role: input.role, detail: detail && Object.keys(detail).length > 0 ? detail : undefined });
}

export function contactBody(input: VcrContactBody = {}) {
  return said({ note: input.note, reason: input.reason });
}

export function transitionBody(input: VcrTransitionBody) {
  return said({
    to: input.to, note: input.note, siteId: input.siteId, screenFailCriterionId: input.screenFailCriterionId,
    screenFailReason: input.screenFailReason, enrolledOn: input.enrolledOn,
  });
}

export function modelBody(input: VcrModelBody) {
  const sources = (input.sources ?? []).map((source) => source.trim()).filter(Boolean);
  return said({
    studyId: input.studyId, name: input.name.trim(), version: input.version?.trim() || undefined, risk: input.risk, endpointType: input.endpointType,
    sources: sources.length > 0 ? sources : undefined,
  });
}

export function judgmentBody(input: VcrJudgmentBody) {
  return said({ state: input.state, note: input.note?.trim() || undefined });
}

/** A countersignature on an assessment carries nothing but the assessment named in the path. */
export function assessmentReviewBody() {
  return {};
}

/** Save one of the study's population definitions into the account's library: a new entry, or the next version of `definitionId`. */
export interface VcrDefinitionSaveBody {
  populationId: string;
  /** A new entry's name; a new version keeps the entry's own unless one is given. */
  name?: string;
  /** Who is in, in plain language. */
  text: string;
  definitionId?: string;
}

/** Use a library definition in the study. `columnMap` renames the dataset's columns the rules read, `{ library column: this dataset's column }`. */
export interface VcrDefinitionUseBody {
  version?: number;
  name?: string;
  columnMap?: Record<string, string>;
  snapshotId?: string;
}

/** Two versions of one library definition applied to the same registered dataset; the engine compares them. */
export interface VcrDefinitionCompareBody {
  versionA: number;
  versionB: number;
  snapshotId?: string;
  covariates?: string[];
}

export function definitionSaveBody(input: VcrDefinitionSaveBody) {
  return said({ populationId: input.populationId, name: input.name?.trim() || undefined, text: input.text.trim(), definitionId: input.definitionId });
}

export function definitionUseBody(input: VcrDefinitionUseBody = {}) {
  const map = input.columnMap && Object.keys(input.columnMap).length > 0 ? input.columnMap : undefined;
  return said({ version: input.version, name: input.name?.trim() || undefined, columnMap: map, snapshotId: input.snapshotId });
}

export function definitionCompareBody(input: VcrDefinitionCompareBody) {
  return said({ versionA: input.versionA, versionB: input.versionB, snapshotId: input.snapshotId, covariates: input.covariates });
}

/** Bind the study to a pack of the catalogue. */
export function packBindBody(use: string) {
  return { use };
}
