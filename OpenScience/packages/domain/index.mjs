/**
 * `@evimed/domain` — the vocabulary every other package derives from.
 *
 * Hidden knowledge: which facts are shared. Tool names, contract kinds, the
 * workspace layout, the four state vocabularies, the error-code registry and
 * the gate rules were each written down two or three times before this package
 * existed, and each duplicate drifted. Everything here is defined once; the
 * control plane, the socket, the browser and the SKILL.md rewrite script all
 * import it and none of them may restate it (§14 rule 4).
 *
 * Zero dependencies and no `node:` imports, on purpose: it has to load inside a
 * browser bundle and inside a plugin sandbox, and its inputs are content, never
 * paths.
 *
 * Every re-export below is named, and `export *` is banned here by lint. That
 * costs a line per symbol and buys the failure mode back: with a star export,
 * two modules defining the same name resolve to `undefined` at the root rather
 * than to either of them, and every consumer sees a defined-looking import that
 * is nothing. It happened twice during the migration — `CLAIM_TIERS` and
 * `AUTOPILOT_TASK_TYPES` — and the tests that caught it were not the ones that
 * should have. Named re-exports make the same mistake a `SyntaxError: Duplicate
 * export` at load time, which nobody can ship past.
 *
 * @module @evimed/domain
 */

export const DOMAIN_VERSION = '0.1.0'


// toolNames — 16 exports
export {
  MCP_MANAGED_JOB_BASE_NAMES,
  MCP_SERVER_NAME,
  MCP_TOOL_BASE_NAMES,
  MCP_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_MCP_TOOL_PREFIX,
  ROOT_VISIBLE_MCP_BASE_NAMES,
  RUNTIME_LEAKAGE_TOOL_TOKENS,
  SOCKET_TOOL_NAMES,
  SOCKET_TOOL_NAME_LIST,
  isEviMedToolName,
  isMcpToolName,
  isSocketToolName,
  mcpToolBaseName,
  mcpToolName,
} from './src/toolNames.mjs'

// contractKinds — 9 exports
export {
  CLINICAL_CONTRACT_KINDS,
  CONTRACT_KINDS,
  CONTRACT_KIND_LABELS,
  REGULATED_CONTRACT_KINDS,
  SAFETY_CLASSES,
  contractKindLabel,
  isClinicalContractKind,
  isContractKind,
  isRegulatedContractKind,
} from './src/contractKinds.mjs'

// workspaceLayout — 13 exports
export {
  BRIEF_DIR,
  CAPSULE_DIR,
  DATA_DIR,
  DELIVERABLES_DIR,
  PROTECTED_WRITE_PREFIXES,
  RUN_STATE_DIR,
  SOURCES_DIR,
  deliverableDir,
  deliverableIdOfPath,
  deliverablePath,
  isProtectedWritePath,
  normalizeWorkspacePath,
  workspaceLayout,
} from './src/workspaceLayout.mjs'

// states — 14 exports
export {
  CLAIM_TIERS,
  EVIDENCE_STATES,
  IllegalTransitionError,
  PLAN_ITEM_STATES,
  RUN_PHASES,
  TERMINAL_RUN_PHASES,
  TURN_END_KINDS,
  VERIFICATION_STATES,
  canTransition,
  isTerminalRunPhase,
  runPhase,
  states,
  transition,
  transitionEvents,
} from './src/states.mjs'

// errorCodes — 14 exports
export {
  ALL_ERROR_CODES,
  ANALYSIS_ERROR_CODES,
  CREDIT_ERROR_CODES,
  ERROR_CODE_MESSAGES,
  RUNTIME_ERROR_CODES,
  SOCKET_TOOL_ERROR_CODES,
  TURN_END_ERROR_CODES,
  TURN_END_SUB_CODES,
  classifyEvidenceSourceError,
  errorCodeMessage,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  terminalEvidenceSourceErrorCodes,
  turnEndErrorCode,
} from './src/errorCodes.mjs'

// constants — 24 exports
export {
  AGENDA_PROJECTION_TOKEN_BUDGET,
  AUTOPILOT_DIMINISHING_RETURN_EPISODES,
  AUTOPILOT_PRIORITY_WEIGHTS,
  AUTOPILOT_USER_SIGNALS,
  CAPSULE_PROFILE_TOKEN_BUDGET,
  CAPSULE_RECALL_TOP_K,
  CAPSULE_SOURCE_WEIGHTS,
  DATASET_EXPLORATORY_FRACTION,
  DEDUP_MINHASH_JACCARD,
  DEDUP_SEMANTIC_COSINE,
  MAX_DELEGATION_DEPTH,
  MEMORY_PROMOTION_MIN_OCCURRENCES,
  MEMORY_PROMOTION_MIN_RUNS,
  MEMORY_RECENCY_GAMMA_PER_HOUR,
  MEMORY_REFLECTION_IMPORTANCE_THRESHOLD,
  MEMORY_RERANK_WEIGHTS,
  MEMORY_STRENGTH_TAU_DAYS,
  METHOD_INDUCTION_MIN_TRAJECTORIES,
  OMISSION_AUDIT_SAMPLE_RATES,
  OMISSION_RATE_TARGETS,
  PERSONA_SCORECARD_FLOORS,
  REPRODUCTION_RELATIVE_TOLERANCE,
  SKILL_AUTHORING_LIMITS,
  TOOL_RESULT_PRUNER,
} from './src/constants.mjs'

// plan — 2 exports
export {
  readyDeliverables,
  validateTaskPlan,
} from './src/plan.mjs'

// receipt — 3 exports
export {
  RECEIPT_FORMAT_VERSION,
  checkReceiptVersions,
  validateDeliveryReceipt,
} from './src/receipt.mjs'

// capabilityManifest — 7 exports
export {
  AUTOPILOT_TASK_TYPES,
  COST_CLASSES,
  DELEGATION_BASE_TOOLS,
  capabilityCatalogueLine,
  delegationToolFilter,
  resolveContractKind,
  validateCapabilityManifest,
} from './src/capabilityManifest.mjs'

// contractRegistry — 3 exports
export {
  CONTRACT_VALIDATOR_KINDS,
  layeredIssues,
  runGate,
} from './src/contractRegistry.mjs'

// narration — 3 exports
export {
  NARRATED_TOOL_NAMES,
  narrateRunEvent,
  narrateToolCall,
} from './src/narration.mjs'

// runTranscript — 9 exports
export {
  EMPTY_TRANSCRIPT,
  RUN_EVENT_TYPES,
  eviMedToolCalls,
  finalAssistantText,
  isRunTranscript,
  normalizeTurnEndKind,
  progressSignal,
  toolCalls,
  totalOutputTokens,
} from './src/runTranscript.mjs'

// safetyRules — 4 exports
export {
  CLINICAL_CONTENT_TRIGGER_ENTITIES,
  clinicalContentTriggerPattern,
  clinicalSafetyRules,
  matchedClinicalTriggers,
} from './src/safetyRules.mjs'

// capsule — 17 exports
export {
  CAPSULE_ACTIVATION_MODES,
  CAPSULE_ENCRYPTION_SCHEME,
  CAPSULE_FACT_KINDS,
  CAPSULE_FACT_ORIGINS,
  CAPSULE_FACT_STATES,
  CAPSULE_FORMAT_VERSION,
  CAPSULE_LAYERS,
  CAPSULE_SHARE_SCOPES,
  CAPSULE_SIGNATURE_ALG,
  CAPSULE_TIMELINE_EVENT_TYPES,
  NEVER_SHARED_LAYERS,
  SHARE_SCOPE_ENTRIES,
  canonicalJson,
  containerReadme,
  merkleRoot,
  signablePayload,
  validateCapsuleManifest,
} from './src/capsule.mjs'

// metering — 13 exports
export {
  CREDIT_REASONS,
  NOTICE_PRIORITY,
  NOTICE_TYPES,
  OFF_PEAK_MULTIPLIER,
  PEAK_WINDOWS_UTC,
  REFERENCE_PRICE_LIST,
  RESOURCE_TYPES,
  RETENTION_DAYS,
  SPEND_ALERTS,
  estimateCost,
  isPeak,
  priceUsage,
  spendingPermission,
} from './src/metering.mjs'

// analysis — 16 exports
export {
  ANALYSIS_DEPTHS,
  AUTHORSHIP,
  CONNECTOR_CAPABILITY_FIELDS,
  CONNECTOR_METHODS,
  COVERAGE_STATES,
  COVERAGE_UNIT_TYPES,
  DEFAULT_DEPTH_BY_TYPE,
  EXPECTED_OUTPUT_FLOORS,
  SOURCE_STATES,
  SOURCE_TYPES,
  VALUE_DIMENSIONS,
  VALUE_DIMENSION_LAYERS,
  chooseDepth,
  distillationCompleteness,
  indexCompleteness,
  outputBelowFloor,
} from './src/analysis.mjs'

// agenda — 15 exports
export {
  AGENDA_ITEM_TYPES,
  ALLOWED_EFFECT_MEASURES,
  AUTOPILOT_PROHIBITIONS,
  DATASET_CLASSIFICATIONS,
  DATASET_PARTITIONS,
  DEFAULT_ENABLED_TASK_TYPES,
  EPISODE_STATES,
  REFUTATION_VERDICTS,
  STOPPING_RULES,
  USER_SIGNALS,
  datasetPartitionOf,
  digestPlacement,
  directionVerdict,
  tierRaiseAllowed,
  validateAgendaClaim,
} from './src/agenda.mjs'

// Types are re-exported separately because they are not runtime bindings: a
// JSDoc typedef named in an `export {}` clause would make the module throw on
// load. Consumers write `import('@evimed/domain').RunTranscript`, so the root
// has to carry them, and carrying them explicitly means the package's type
// surface is as reviewable as its value surface.
/** @typedef {import('./src/capabilityManifest.mjs').ManifestIssue} ManifestIssue */
/** @typedef {import('./src/capsule.mjs').CapsuleEntry} CapsuleEntry */
/** @typedef {import('./src/capsule.mjs').CapsuleManifest} CapsuleManifest */
/** @typedef {import('./src/contractKinds.mjs').ContractKind} ContractKind */
/** @typedef {import('./src/contractRegistry.mjs').GateInput} GateInput */
/** @typedef {import('./src/contractRegistry.mjs').GateIssue} GateIssue */
/** @typedef {import('./src/contractRegistry.mjs').GateVerdict} GateVerdict */
/** @typedef {import('./src/metering.mjs').PriceList} PriceList */
/** @typedef {import('./src/metering.mjs').UsageEvent} UsageEvent */
/** @typedef {import('./src/plan.mjs').PlanDeliverable} PlanDeliverable */
/** @typedef {import('./src/plan.mjs').PlanIssue} PlanIssue */
/** @typedef {import('./src/plan.mjs').TaskPlan} TaskPlan */
/** @typedef {import('./src/receipt.mjs').DeliveryReceipt} DeliveryReceipt */
/** @typedef {import('./src/receipt.mjs').DeliveryReceiptEntry} DeliveryReceiptEntry */
/** @typedef {import('./src/receipt.mjs').ReceiptFile} ReceiptFile */
/** @typedef {import('./src/runTranscript.mjs').RunEvent} RunEvent */
/** @typedef {import('./src/runTranscript.mjs').RunTranscript} RunTranscript */
/** @typedef {import('./src/runTranscript.mjs').TranscriptMessage} TranscriptMessage */
/** @typedef {import('./src/runTranscript.mjs').TranscriptPart} TranscriptPart */
/** @typedef {import('./src/runTranscript.mjs').TranscriptTextPart} TranscriptTextPart */
/** @typedef {import('./src/runTranscript.mjs').TranscriptToolCall} TranscriptToolCall */
