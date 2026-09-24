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


// toolNames — 21 exports
export {
  MCP_MANAGED_JOB_BASE_NAMES,
  MCP_SERVER_NAME,
  MCP_TOOL_BASE_NAMES,
  MCP_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_MCP_TOOL_PREFIX,
  KERNEL_MOUNTED_TOOL_NAMES,
  MOUNTED_TOOL_NAMES,
  RETIRED_MCP_TOOL_NAMES,
  ROOT_VISIBLE_MCP_BASE_NAMES,
  RUNTIME_LEAKAGE_TOOL_TOKENS,
  SOCKET_TOOL_NAMES,
  SOCKET_TOOL_NAME_LIST,
  isEviMedToolName,
  isMcpToolName,
  isSocketToolName,
  mcpToolBaseName,
  mcpToolName,
  referencedToolNames,
  unmountedToolReferences,
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

// workspaceLayout — 16 exports
export {
  BRIEF_DIR,
  KNOWLEDGE_DIR,
  CAPSULE_DIR,
  DATA_DIR,
  DELIVERABLES_DIR,
  PROTECTED_WRITE_PREFIXES,
  RUNTIME_WORKSPACE_ROOT,
  RUN_STATE_DIR,
  SOURCES_DIR,
  deliverableDir,
  deliverableIdOfPath,
  deliverablePath,
  isGateImplementationPath,
  isProtectedWritePath,
  normalizeWorkspacePath,
  runStateFileFor,
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

// errorCodes — 22 exports
export {
  ALL_ERROR_CODES,
  ANALYSIS_ERROR_CODES,
  CONTROL_PLANE_ERROR_CODES,
  CREDIT_ERROR_CODES,
  ERROR_CODE_FAMILIES,
  ERROR_CODE_MESSAGES,
  ERROR_DETAIL_FIELDS,
  RUNTIME_ERROR_CODES,
  RUN_OUTCOME_KINDS,
  RUN_VERDICT_ERROR_CODES,
  SOCKET_TOOL_ERROR_CODES,
  TURN_END_ERROR_CODES,
  TURN_END_SUB_CODES,
  classifyEvidenceSourceError,
  errorCodeMessage,
  errorCodeOutcome,
  knownErrorCodeMessage,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  runOutcomeKind,
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
  MAX_ACTIVE_LEARNED_METHODS,
  METHOD_CONTRIBUTION_MIN_TRIALS,
  METHOD_CONTRIBUTION_RETIRE_AT,
  METHOD_HARM_TEST,
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

// plan — 3 exports
export {
  PLAN_ACCEPTANCE_LIMIT,
  readyDeliverables,
  validateTaskPlan,
} from './src/plan.mjs'

// studyTypes — 8 exports: the design a planned deliverable reports or designs,
// and the reporting guideline each design is written to (2026-09-24)
export {
  REPORTING_CHECKLIST_FILE,
  REPORTING_GUIDELINES,
  REPORTING_GUIDELINE_TEMPLATE_DIR,
  STUDY_TYPES,
  STUDY_TYPE_LABELS_ZH,
  isStudyType,
  reportingGuidelineFor,
  studyTypeLabel,
} from './src/studyTypes.mjs'

// receipt — 3 exports
export {
  RECEIPT_FORMAT_VERSION,
  checkReceiptVersions,
  validateDeliveryReceipt,
} from './src/receipt.mjs'

// capabilityManifest — 10 exports
export {
  AUTOPILOT_TASK_TYPES,
  CLAIM_TOOLS,
  COST_CLASSES,
  DELEGATION_BASE_TOOLS,
  EVIDENCE_MATRIX_OUTPUT,
  KERNEL_GLOBAL_TOOL_NAMES,
  capabilityCatalogueLine,
  delegationToolFilter,
  resolveContractKind,
  validateCapabilityManifest,
} from './src/capabilityManifest.mjs'

// capabilityDisplay — 4 exports
export {
  CAPABILITY_DISPLAY,
  capabilityBrief,
  capabilityBriefTask,
  capabilityTitle,
} from './src/capabilityDisplay.mjs'

// contractRegistry — 6 exports
export {
  CONTRACT_VALIDATOR_KINDS,
  GATE_CHECK_IDS,
  METHOD_RELATIONS_ACTIONS,
  layeredIssues,
  unreadableSubmission,
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

// skillRoots — 3 exports
export {
  RUNTIME_SKILL_ROOTS,
  runtimeSkillRootPaths,
  skillRootGuidance,
} from './src/skillRoots.mjs'

// safetyRules — 11 exports
export {
  CLINICAL_CONTENT_TRIGGER_ENTITIES,
  CLINICAL_HIGH_RISK_ENTITIES,
  CLINICAL_SAFETY_CAUTION_CHECK,
  CLINICAL_SAFETY_CAUTION_RULES,
  clinicalContentTriggerPattern,
  clinicalSafetyCautionHits,
  clinicalSafetyRules,
  compileCautionRules,
  matchedClinicalTriggers,
  matchedHighRiskEntities,
  mentionedMedicines,
} from './src/safetyRules.mjs'

// reviewFindings — 21 exports
export {
  REVIEW_ANSWER_REQUIRED_KINDS,
  REVIEW_DECIDABLE_KINDS,
  REVIEW_EDITOR_FINDINGS_LIMIT,
  REVIEW_EDITOR_OUTPUT_SCHEMA,
  REVIEW_FINDINGS_MAX,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_KIND_LABELS_ZH,
  REVIEW_JUDGMENT_KINDS,
  REVIEW_NO_FINDING,
  REVIEW_RESPONSES,
  REVIEW_RESPONSE_REASON_MAX,
  acceptEditorChecks,
  acceptEditorFindings,
  acceptReviewResponses,
  editorSaidNothing,
  evidenceLocated,
  findingMessage,
  isReviewFindingKind,
  reviewEditorSchema,
  reviewSeverity,
  unansweredFindings,
} from './src/reviewFindings.mjs'

// reviewTier — 5 exports
export {
  COMPUTED_CONTRACT_KINDS,
  REVIEW_TIERS,
  UNREVIEWED_CONTRACT_KINDS,
  deliverableReviewTier,
  replyReviewTier,
} from './src/reviewTier.mjs'

// referenceResolution — 6 exports
export {
  REFERENCE_RESOLUTION_LIMIT,
  referenceEntries,
  referenceLookups,
  referenceResolutionFindings,
  titleCoverage,
  titleTokens,
} from './src/referenceResolution.mjs'

// numericTraceability — 3 exports
export {
  numericTraceFindings,
  outputNumbers,
  traceNumber,
} from './src/numericTraceability.mjs'

// statConsistency — 5 exports
export {
  incompleteBeta,
  logGamma,
  statConsistencyFindings,
  twoSidedP,
  upperGamma,
} from './src/statConsistency.mjs'

// replyCheck — 8 exports
export {
  REPLY_CHECK_OUTPUT_SCHEMA,
  REPLY_CHECK_SENTENCE_LIMIT,
  REPLY_CHECK_VERDICTS,
  REPLY_CHECK_VERDICT_LABELS_ZH,
  REPLY_CHECK_WARNING_VERDICTS,
  acceptReplyVerdicts,
  replyCheckCounts,
  replyCitedSentences,
} from './src/replyCheck.mjs'

// capsule — 19 exports
export {
  CAPSULE_ACTIVATION_MODES,
  CAPSULE_ENCRYPTION_SCHEME,
  CAPSULE_LEGACY_ACTIVATION_MODES,
  capsuleActivationMode,
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

// metering — 16 exports
export {
  CREDIT_REASONS,
  NOTICE_PRIORITY,
  NOTICE_TYPES,
  OFF_PEAK_MULTIPLIER,
  PEAK_WINDOWS_UTC,
  PRICE_LIST_VERSIONS,
  REFERENCE_PRICE_LIST,
  RESOURCE_TYPES,
  RETENTION_DAYS,
  SPEND_ALERTS,
  estimateCost,
  isPeak,
  priceListAt,
  priceListFor,
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

// agenda — 17 exports
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
  standingVerdict,
  tierRaiseAllowed,
  userSignalScore,
  validateAgendaClaim,
} from './src/agenda.mjs'

// runtimeUiSurface — 9 exports
export {
  RUNTIME_UI_DENIED_HOST_ROUTES,
  RUNTIME_UI_DENIED_METHODS,
  RUNTIME_UI_DENIED_NAMESPACES,
  isDeniedRuntimeUiHostRoute,
  isDeniedRuntimeUiMethod,
  runtimeUiMethodFromPath,
  RUNTIME_UI_WORKSPACE_PATH_METHODS,
  isRuntimeUiWorkspacePath,
  runtimeUiWorkspacePathRefusal,
} from './src/runtimeUiSurface.mjs'

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
/** @typedef {import('./src/runTranscript.mjs').TranscriptTurn} TranscriptTurn */
/** @typedef {import('./src/runTranscript.mjs').TranscriptPart} TranscriptPart */
/** @typedef {import('./src/runTranscript.mjs').TranscriptTextPart} TranscriptTextPart */
/** @typedef {import('./src/runTranscript.mjs').TranscriptToolCall} TranscriptToolCall */
/** @typedef {import('./src/studyTypes.mjs').ReportingGuideline} ReportingGuideline */

// sensitiveText — 3 exports
export {
  SENSITIVE_TEXT_PATTERN,
  hasSensitiveText,
  redactSensitiveText,
  sensitiveTextTokens,
} from './src/sensitiveText.mjs'

// methodSkill — the learned-method format, its digest, and every rule code can decide
export {
  METHOD_BODY_SECTIONS,
  METHOD_FILE_PREFIXES,
  METHOD_FILES_MAX_BYTES,
  METHOD_OPERATIONS,
  METHOD_PRESERVED_SECTIONS,
  METHOD_ROLES,
  METHOD_SCRIPT_DENIED_IMPORTS,
  METHOD_SKILL_ISSUE_CODES,
  METHOD_SKILL_SCHEMA,
  METHOD_STATUSES,
  METHOD_DISPLAY_LIMITS,
  cleanMethodDisplay,
  formatDependsOn,
  isMethodDigest,
  methodBodySections,
  methodContentDigest,
  mountedMethodDigest,
  methodDigestInput,
  normalizeSkillBody,
  parseDependsOn,
  parsePythonToolShape,
  parseReuseReferences,
  parseSkillFrontmatter,
  preservedSectionItems,
  preservedSectionsIntact,
  renderMethodSkill,
  renderSkillFrontmatter,
  scriptStaticIssues,
  skillBodyDigest,
  toolConfigIssues,
  validateMethodSkill,
} from './src/methodSkill.mjs'

// methodGraph — the lifecycle: counters, promotion, retirement, and the graph
export {
  METHOD_COUNT_KINDS,
  METHOD_EVALUATION_VERDICTS,
  METHOD_GRAPH_ISSUE_CODES,
  METHOD_OBSERVATION_OUTCOMES,
  METHOD_ORIGINS,
  METHOD_PASSING_VERDICTS,
  METHOD_RELATION_TYPES,
  METHOD_SUCCESS_OUTCOMES,
  computeMethodLevels,
  emptyLearning,
  evaluationEligible,
  foldEligible,
  foldEvaluation,
  foldObservation,
  foldRead,
  foldRelation,
  methodLevel,
  methodStrength,
  promotionVerdict,
  reflectionDue,
  relationIssues,
  resetLearningForDigest,
  retirementProposal,
  libraryEvictions,
  methodContribution,
  methodHarmTest,
  successfulFamilies,
  successfulRuns,
  unresolvedConflicts,
  validateMethodGraph,
} from './src/methodGraph.mjs'

// toolGraphSampling — ToolVerse's dependency graph and unlock sampling
export {
  TOOL_EDGE_SOURCES,
  TOOL_EDGE_STATE_EFFECTS,
  TOOL_EDGE_TYPES,
  TOOL_GRAPH_ISSUE_CODES,
  chainSpecs,
  graphCoverage,
  sampleableEdges,
  sanitizeToolGraph,
  seededRandom,
  seededSample,
  unlockSchedule,
  validateToolGraph,
} from './src/toolGraphSampling.mjs'

// experienceBullets — the capability handbook's self-maintained section
export {
  BULLET_TAGS,
  EXPERIENCE_SECTION_HEADING,
  EXPERIENCE_SECTION_NOTE,
  EXPERIENCE_SUBSECTIONS,
  curateBullets,
  harmfulBullets,
  nextBulletId,
  onlyExperienceSectionChanged,
  parseExperienceSection,
  renderBullet,
  renderExperienceSection,
  replaceExperienceSection,
} from './src/experienceBullets.mjs'

/** @typedef {import('./src/methodSkill.mjs').MethodSkillIssue} MethodSkillIssue */
/** @typedef {import('./src/methodSkill.mjs').MethodPayload} MethodPayload */
/** @typedef {import('./src/methodSkill.mjs').MethodDependency} MethodDependency */
/** @typedef {import('./src/methodGraph.mjs').MethodRecord} MethodRecord */
/** @typedef {import('./src/methodGraph.mjs').MethodLearning} MethodLearning */
/** @typedef {import('./src/methodGraph.mjs').MethodObservation} MethodObservation */
/** @typedef {import('./src/methodGraph.mjs').MethodRelation} MethodRelation */
/** @typedef {import('./src/methodGraph.mjs').MethodEvaluation} MethodEvaluation */
/** @typedef {import('./src/methodGraph.mjs').MethodProvenance} MethodProvenance */
/** @typedef {import('./src/toolGraphSampling.mjs').ToolGraph} ToolGraph */
/** @typedef {import('./src/toolGraphSampling.mjs').ToolGraphNode} ToolGraphNode */
/** @typedef {import('./src/toolGraphSampling.mjs').ToolGraphEdge} ToolGraphEdge */
/** @typedef {import('./src/toolGraphSampling.mjs').ChainSpec} ChainSpec */
/** @typedef {import('./src/experienceBullets.mjs').ExperienceBullet} ExperienceBullet */

export { citedIdentifiers, retractionNotices } from './src/retractionCheck.mjs'
// sourceUnderstanding — 15 exports
// Written one per line so `no two modules export the same name, and the root
// re-exports every one of them` covers this module: the omission audit's names
// were defined here, tested here, and left out of this list, which made them
// unimportable from the control plane while looking finished.
export {
  SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES,
  SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS,
  SOURCE_UNDERSTANDING_AUDIT_SAMPLE_FRACTION,
  SOURCE_UNDERSTANDING_AUDIT_STATUSES,
  SOURCE_UNDERSTANDING_FILE,
  SOURCE_UNDERSTANDING_INPUT_FILE,
  SOURCE_UNDERSTANDING_MAX_CHARS,
  SOURCE_UNDERSTANDING_SCHEMAS,
  SOURCE_UNDERSTANDING_VERSION,
  normalizeSourceText,
  projectSourceUnderstandingOutput,
  sourceUnderstandingAuditSample,
  sourceUnderstandingOmissionNotice,
  sourceUnderstandingSchema,
  validateSourceUnderstanding,
} from './src/sourceUnderstanding.mjs'

// connectorCredentials — 5 exports
export {
  CONNECTOR_CREDENTIALS,
  CONNECTOR_CREDENTIAL_IDS,
  connectorCredentialSpec,
  connectorDeploymentSource,
  validateConnectorCredentialValue,
} from './src/connectorCredentials.mjs'

// runPhases — 4 exports
export {
  RUN_ACTIVITY_PHASES,
  RUN_ACTIVITY_PHASE_LABELS_ZH,
  phaseOfToolCall,
  summarizeRunPhases,
} from './src/runPhases.mjs'

// sourceTypes — 6 exports
export {
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_SOURCE_TYPE_LABELS_ZH,
  evidenceSourceTypeOf,
  isEvidenceSourceType,
  sourceTypeOfSidecar,
  sourceTypeSidecarPath,
} from './src/sourceTypes.mjs'

// appraisalStructure — 9 exports: a claim's PICO, GRADE certainty in parts and
// risk of bias by a named tool, with the level each set of parts gives.
export {
  CERTAINTY_LEVELS,
  CERTAINTY_LEVEL_LABELS_ZH,
  RISK_OF_BIAS_LEVEL_LABELS_ZH,
  RISK_OF_BIAS_TOOL_IDS,
  claimAppraisal,
  claimAppraisalFindings,
  evidenceDesignOf,
  gradeCertaintyFromParts,
  riskOfBiasOverall,
} from './src/appraisalStructure.mjs'

// gateIssueText — 10 exports: a gate finding's Chinese title by its identity
export {
  GATE_CHECKS_TITLED_BY_RULE,
  GATE_CHECK_TITLES_ZH,
  GATE_CODE_TITLES_ZH,
  GATE_FALLBACK_TITLES_ZH,
  GATE_ISSUE_SEVERITIES,
  describeGateIssue,
  gateIssueDetail,
  gateIssueRefs,
  gateIssueSeverity,
  summarizeGateNotices,
} from './src/gateIssueText.mjs'

// usagePurpose — 7 exports: what a metered model request was for (X1)
export {
  USAGE_PURPOSES,
  USAGE_PURPOSE_LABELS_ZH,
  isUsagePurpose,
  usagePurpose,
  usagePurposeOfRun,
  LEARNING_AGENT_IDS,
  LEARNING_EVALUATION_DISPATCH_PREFIX,
} from './src/usagePurpose.mjs'
// sourceUpdates — 5 exports (retraction and correction notices on a cited work, 2026-09-20)
export {
  SOURCE_UPDATE_KINDS,
  SOURCE_UPDATE_LABELS_ZH,
  SOURCE_UPDATE_WEIGHT,
  doiOf,
  sourceUpdatesFromCrossref,
} from './src/sourceUpdates.mjs'
// sourceDocuments — 12 exports: what the knowledge base accepts, where each
// format is read, where its pages begin, how a quotation's offset becomes a
// page number, and what a personal-library document's state reads as.
export {
  KNOWLEDGE_BASE_FORMATS,
  LIBRARY_ITEM_STATUSES,
  SOURCE_API_FORMATS,
  SOURCE_LOCAL_TEXT_FORMATS,
  SOURCE_MEDIA_FORMATS,
  SOURCE_PAGE_MAP_MAX_PAGES,
  SOURCE_PAGE_STATUSES,
  normalizeSourcePageMap,
  renderSourcePageMarkers,
  sourceFileFormat,
  sourceFormatRoute,
  sourcePageForOffset,
} from './src/sourceDocuments.mjs'
// memoryVocabulary — 7 exports: the tags the platform writes into a
// conversation, the identifiers it calls its own machinery by, and the words
// and shapes a run uses to talk about its own bookkeeping — what a memory
// write is checked against in code.
export {
  PLATFORM_CONTEXT_TAGS,
  PLATFORM_JARGON_ZH,
  carriesPlatformContext,
  platformIdentifiersIn,
  runBookkeepingIn,
  stripPlatformTags,
  unwrapUserWrappers,
} from './src/memoryVocabulary.mjs'
// frontierVocabulary — 59 exports: the frontier feed's closed vocabularies
// (lane, source type, evidence type, specialty, flag, health, egress, access —
// the enums of the knowledge-source plugin's contract), their Chinese labels,
// the fallbacks for values a newer plugin sends, PubMed publication type →
// evidence type, the authority score, the heat arithmetic the hot list states
// (with its 「热度怎么算」 text) and the masthead title list.
export {
  FRONTIER_ACCESSES,
  FRONTIER_ACCESS_LABELS_ZH,
  FRONTIER_AUTHORITY_MAX,
  FRONTIER_DATE_PRECISIONS,
  FRONTIER_EGRESSES,
  FRONTIER_EGRESS_LABELS_ZH,
  FRONTIER_ENRICHMENT_KEYS,
  FRONTIER_ENTRY_DEFECTS,
  FRONTIER_ENTRY_STATES,
  FRONTIER_EVIDENCE_AUTHORITY_COEFFICIENTS,
  FRONTIER_EVIDENCE_BASES,
  FRONTIER_EVIDENCE_TYPES,
  FRONTIER_EVIDENCE_TYPE_LABELS_ZH,
  FRONTIER_FACT_KEYS,
  FRONTIER_HEALTH_LABELS_ZH,
  FRONTIER_HEALTH_STATES,
  FRONTIER_HEAT_BILINGUAL_FACTOR,
  FRONTIER_HEAT_DISPLAY_SCALE,
  FRONTIER_HEAT_HALF_LIFE_HOURS,
  FRONTIER_HEAT_METHOD_ZH,
  FRONTIER_HEAT_PRIMARY_FACTOR,
  FRONTIER_HOT_BADGE_HOURS,
  FRONTIER_HOT_MIN_INSTITUTIONS,
  FRONTIER_HOT_TREND,
  FRONTIER_HOT_WINDOW_HOURS,
  FRONTIER_ITEM_FLAGS,
  FRONTIER_MENTION_REGISTRY_IDS,
  FRONTIER_MENTION_SOURCE_TYPES,
  FRONTIER_ITEM_FLAG_LABELS_ZH,
  FRONTIER_ITEM_STATES,
  FRONTIER_LANES,
  FRONTIER_LANE_LABELS_ZH,
  FRONTIER_LAUNCH_TIERS,
  FRONTIER_LEVEL_LABELS_ZH,
  FRONTIER_MASTHEAD_TITLES,
  FRONTIER_MAX_SPECIALTIES,
  FRONTIER_MODEL_FLAGS,
  FRONTIER_OPEN_ACCESS_STATUSES,
  FRONTIER_PREPRINT_AUTHORITY_FACTOR,
  FRONTIER_SCORE_MAXIMA,
  FRONTIER_SELECTED_RULES,
  FRONTIER_SOURCE_LANES,
  FRONTIER_SOURCE_TYPES,
  FRONTIER_SOURCE_TYPE_LABELS_ZH,
  FRONTIER_SPECIALTIES,
  FRONTIER_SPECIALTY_LABELS_ZH,
  FRONTIER_TEXT_STATUSES,
  FRONTIER_VERIFICATIONS,
  FRONTIER_VOCABULARY_FALLBACKS,
  FRONTIER_VOCABULARY_NAMES,
  PUBMED_NON_RESEARCH_TYPES,
  PUBMED_RESEARCH_TYPE_EVIDENCE,
  frontierAuthorityScore,
  frontierEvidenceFromPublicationTypes,
  frontierHeatDisplay,
  frontierLabel,
  frontierScoreLevel,
  frontierValue,
  isFrontierMastheadTitle,
  isFrontierValue,
  mastheadTitleKey,
} from './src/frontierVocabulary.mjs'
// frontierSourceNames — 2 exports: what a reader calls a source — the
// institution, by the registry's owner entity, never the feed or interface the
// plugin reads it through (the table is `frontier-source-names.json`).
export {
  FRONTIER_SOURCE_DISPLAY_NAMES,
  frontierSourceDisplayName,
} from './src/frontierSourceNames.mjs'
