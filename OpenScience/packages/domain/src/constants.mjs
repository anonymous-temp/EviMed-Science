/**
 * Algorithm constants.
 *
 * Hidden knowledge: the line between a constant and a configuration field
 * (§14 rule 11, §29.4). A number is configuration only when two deployments
 * would genuinely set it differently and the deployer knows better than the
 * designer. Retrieval-ranking weights, decay rates and dedup thresholds fail
 * that test — they are properties of the algorithm, and a deployment that
 * changes them is running a different algorithm. Budgets, periods, ceilings
 * and sampling rates pass it, and live in the control plane's `config.mjs`.
 *
 * A test asserts each of these is exported and numeric, so a later "just make
 * it configurable" has to argue with the three questions first.
 */

/** Delegation depth. A design invariant, not a knob (§10.4). */
export const MAX_DELEGATION_DEPTH = 1

/** Memory reranking weights (§19.22 A2): relevance, importance, recency, utility. */
export const MEMORY_RERANK_WEIGHTS = Object.freeze({ relevance: 3, importance: 2, recency: 1, utility: 1 })

/** Hourly recency decay for memory reranking (Generative Agents). */
export const MEMORY_RECENCY_GAMMA_PER_HOUR = 0.995

/** Session-memory strength half-life input: S(t) = S0 * e^(-dt/tau), tau in days (§19.22 A4). */
export const MEMORY_STRENGTH_TAU_DAYS = 30

/** Reflection fires when accumulated importance passes this (event-driven, not timed). */
export const MEMORY_REFLECTION_IMPORTANCE_THRESHOLD = 150

/** A fact is promoted from session memory to capsule after this many occurrences across runs. */
export const MEMORY_PROMOTION_MIN_OCCURRENCES = 3

/** Distinct runs a fact must appear in before promotion. */
export const MEMORY_PROMOTION_MIN_RUNS = 2

/** Successful trajectories sharing a routine before it is induced into a method (AWM). */
export const METHOD_INDUCTION_MIN_TRAJECTORIES = 3

/** Resident capsule profile budget, in tokens (§19.7). */
export const CAPSULE_PROFILE_TOKEN_BUDGET = 1500

/** Agenda projection budget, in tokens (§24.4.1). */
export const AGENDA_PROJECTION_TOKEN_BUDGET = 3000

/** Default top-k for capsule recall assembly (§19.22 A2). */
export const CAPSULE_RECALL_TOP_K = 8

/** Near-duplicate thresholds for the analysis layer (§26.4). */
export const DEDUP_MINHASH_JACCARD = 0.8
export const DEDUP_SEMANTIC_COSINE = 0.95

/** Distillation completeness targets by depth (§26.7). */
export const OMISSION_RATE_TARGETS = Object.freeze({ deep: 0.05, structured: 0.15 })

/** QA omission-audit sampling rate by depth (§26.7). */
export const OMISSION_AUDIT_SAMPLE_RATES = Object.freeze({ deep: 1, structured: 0.2, index_only: 0, skip: 0 })

/** Autopilot daily-plan scoring weights (§24.4.2). */
export const AUTOPILOT_PRIORITY_WEIGHTS = Object.freeze({
  userSignal: 4,
  novelty: 2,
  evidenceGap: 2,
  freshness: 1,
  cost: 1,
})

/** User signals feeding the autopilot priority score. */
export const AUTOPILOT_USER_SIGNALS = Object.freeze({
  followUp: 1,
  adopt: 0.6,
  upvote: 0.3,
  reject: -1,
})

/** Episodes without a `gated`-or-better claim before a direction is halved, then parked. */
export const AUTOPILOT_DIMINISHING_RETURN_EPISODES = 3

/** Reproduction tolerance for a verification episode's numeric comparison (§24.4.4). */
export const REPRODUCTION_RELATIVE_TOLERANCE = 1e-6

/** Deterministic exploratory / confirmatory split of a registered dataset (§24.4.5). */
export const DATASET_EXPLORATORY_FRACTION = 0.3

/** Source weights used when computing a capsule fact's strength (§27.3). */
export const CAPSULE_SOURCE_WEIGHTS = Object.freeze({
  explicitNote: 1,
  ownReviewComments: 0.9,
  ownProtocolOrSop: 0.9,
  ownPublication: 0.8,
  grantOrCv: 0.8,
  ownSlides: 0.7,
  editDiff: 0.7,
  rejectionReason: 0.6,
  runTrajectory: 0.6,
  runPrompt: 0.4,
  externalParaphrase: 0.3,
})

/** Nuwa scorecard floors for a persona SKILL.md (§27.3.1); a report, never a gate. */
export const PERSONA_SCORECARD_FLOORS = Object.freeze({
  mentalModelsMin: 3,
  mentalModelsMax: 7,
  honestBoundariesMin: 3,
  tensionsMin: 2,
  firstHandSourceShareMin: 0.5,
})

/** Agent Skills authoring limits a generated SKILL.md is checked against (§27.3.1). */
export const SKILL_AUTHORING_LIMITS = Object.freeze({
  maxBodyLines: 500,
  maxDescriptionChars: 1024,
  minTestScenarios: 3,
  maxReferenceDepth: 1,
  referenceTocLineThreshold: 100,
})

/** Tool-result pruning thresholds mirrored from the preset row, in Unicode code points. */
export const TOOL_RESULT_PRUNER = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
