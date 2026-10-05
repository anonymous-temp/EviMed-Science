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

/** @typedef {import('./src/capabilityAvailability.mjs').AvailabilityEntry} AvailabilityEntry */
/** @typedef {import('./src/capabilityAvailability.mjs').AvailabilityReason} AvailabilityReason */
/** @typedef {import('./src/capabilityAvailability.mjs').AvailabilityState} AvailabilityState */
/** @typedef {import('./src/capabilityAvailability.mjs').OperationObservation} OperationObservation */
/** @typedef {import('./src/capabilityAvailability.mjs').OperationRecord} OperationRecord */
/** @typedef {import('./src/skillSupply.mjs').SkillPackageRecord} SkillPackageRecord */
/** @typedef {import('./src/skillSupply.mjs').SkillOperation} SkillOperation */
/** @typedef {import('./src/skillSupply.mjs').ImageRecipe} ImageRecipe */
/** @typedef {import('./src/extensions.mjs').ExtensionCoordinate} ExtensionCoordinate */
/** @typedef {import('./src/extensions.mjs').ExtensionInstallRequest} ExtensionInstallRequest */
/** @typedef {import('./src/extensions.mjs').SkillWriteRequest} SkillWriteRequest */
/** @typedef {import('./src/extensions.mjs').ExtensionProofIdentity} ExtensionProofIdentity */

export {
  EXTENSION_EXECUTION_CLASSES,
  EXTENSION_SUPPORTED_DSH_VERSION,
  EXTENSION_QUALIFICATION_STATES,
  EXTENSION_EVIDENCE_STATES,
  EXTENSION_APPLY_PHASES,
  EXTENSION_PRODUCT_KINDS,
  EXTENSION_JOB_KINDS,
  EXTENSION_SAAS_CASE_IDS,
  ExtensionContractError,
  canonicalExtensionCoordinate,
  validateExtensionInstallRequest,
  validateSkillWriteRequest,
  personalSkillName,
  canonicalPersonalSkillResourcePath,
  extensionGenerationIdentity,
  validateExtensionProofIdentity,
  extensionProofDigest,
  extensionProofAdapterRevision,
  qualifyExtensionProof,
  extensionQualificationStateOf,
  extensionEvidenceState,
} from './src/extensions.mjs'

export { MIN_PASSWORD_LENGTH, meetsPasswordMinimum } from './src/accountPolicy.mjs'


// toolNames — 22 exports
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
  RETIRED_SOCKET_TOOL_NAMES,
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

// errorCodes
export {
  ALL_ERROR_CODES,
  ANALYSIS_ERROR_CODES,
  AUTOPILOT_BUDGET_ERROR_CODES,
  BALANCE_REFUSAL_CODES,
  CONTROL_PLANE_ERROR_CODES,
  CREDIT_ERROR_CODES,
  ERROR_CODE_FAMILIES,
  ERROR_CODE_MESSAGES,
  ERROR_DETAIL_FIELDS,
  EXTENSION_ERROR_CODES,
  EVIMED_CREDITS_ROUTE_ERROR_CODES,
  GEO_ROUTE_ERROR_CODES,
  MANAGED_BROWSER_ERROR_CODES,
  VCR_GATEWAY_ERROR_CODES,
  VCR_MODULE_ERROR_CODES,
  VCR_PROTOCOL_ISSUE_CODES,
  VCR_ENGINE_ISSUE_CODES,
  VCR_ROUTE_ERROR_CODES,
  VCR_WRITE_ISSUE_CODES,
  RUNTIME_ERROR_CODES,
  RUN_OUTCOME_KINDS,
  RUN_VERDICT_ERROR_CODES,
  SOCKET_TOOL_ERROR_CODES,
  TURN_END_ERROR_CODES,
  TURN_END_SUB_CODES,
  TURN_END_WIRE_ERROR_CODES,
  TURN_END_WIRE_STATUS_ERROR_CODES,
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
  METHOD_SCIENTIFIC_HARM_TEST,
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

// capabilityManifest — 12 exports
export {
  AUTOPILOT_EPISODE_CAPABILITIES,
  AUTOPILOT_TASK_TYPES,
  CLAIM_TOOLS,
  COST_CLASSES,
  DELEGATION_BASE_TOOLS,
  EVIDENCE_MATRIX_OUTPUT,
  KERNEL_GLOBAL_TOOL_NAMES,
  autopilotEpisodeCapability,
  capabilityCatalogueLine,
  delegationToolFilter,
  resolveContractKind,
  validateCapabilityManifest,
} from './src/capabilityManifest.mjs'

// capabilityDisplay — 5 exports
export {
  CAPABILITY_DISPLAY,
  capabilityBrief,
  capabilityBriefTask,
  capabilityListed,
  capabilityTitle,
} from './src/capabilityDisplay.mjs'

// capabilityAvailability — 17 exports: whether a capability, tool, skill or extension has really run on this
// deployment, as a label (source-planned / installed / executable / limited / unavailable / unverified)
export {
  AVAILABILITY_RECORD_SOURCES,
  AVAILABILITY_RECORD_VERSION,
  AVAILABILITY_REASON_CODES,
  AVAILABILITY_SAMPLE_LIMIT,
  AVAILABILITY_STATE_LABELS_ZH,
  AVAILABILITY_SUBJECT_KINDS,
  CAPABILITY_AVAILABILITY_STATES,
  availabilityReasonState,
  countAvailabilityStates,
  describeAvailability,
  emptyOperationRecord,
  foldOperation,
  normalizeOperationRecord,
  operationOutcomeOfRun,
  projectAvailability,
  summarizeOperations,
  typicalOf,
} from './src/capabilityAvailability.mjs'

// contractRegistry — 7 exports
export {
  CONTRACT_VALIDATOR_KINDS,
  GATE_CHECK_IDS,
  METHOD_RELATIONS_ACTIONS,
  contractCompanionPaths,
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

// toolViewPhrases — 4 exports: the Chinese verb phrase a tool call wears in
// the conversation, as data (the kernel page's bodies may import nothing).
export {
  KERNEL_TOOL_VIEW_NAMES,
  TOOL_VIEW_PHRASE_NAMES,
  toolViewPhrase,
  toolViewPhraseTable,
} from './src/toolViewPhrases.mjs'

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

// skillSupply — a skill package's source, licence, version, scripts, references, dependencies and operations as one
// record, and whether the deployment can supply what it needs (read as a label by the availability projection)
export {
  PYTHON_DISTRIBUTION_MODULES,
  R_IMAGE_PACKAGES,
  SKILL_DEPENDENCY_BASES,
  SKILL_DEPENDENCY_KINDS,
  SKILL_DEPENDENCY_SUPPLIES,
  SKILL_OPERATION_KINDS,
  SKILL_PACKAGE_ORIGINS,
  SKILL_PACKAGE_RECORD_VERSION,
  SKILL_PARAM_TYPES,
  SKILL_SOURCE_KINDS,
  buildSkillPackageRecord,
  declaredDependencies,
  defaultDependencySupply,
  describeSkillLicence,
  describeSkillSource,
  fencedPython,
  imageProvides,
  normalizeSkillOperation,
  normalizeSkillPackageRecord,
  observedDependencies,
  packagePath,
  pinHolds,
  publicSkillPackage,
  pythonImports,
  rLibraries,
  skillDependencyReasons,
  skillPackageRecordDigest,
  unknownFields,
} from './src/skillSupply.mjs'

// operationHelp — bounded help derived from an operation's own schema
export {
  OPERATION_HELP_BUDGET,
  PACKAGE_HELP_BUDGET,
  describeOperationParam,
  operationExample,
  operationExampleText,
  renderOperationHelp,
  renderOperationSummary,
  renderPackageHelp,
} from './src/operationHelp.mjs'

// skillUpdatePlan — what updating an edited copy of a skill toward a newer upstream would change, and what it keeps
export {
  SKILL_UPDATE_PARTS,
  normalizeSkillBaseline,
  planSkillUpdate,
  skillContentDigests,
} from './src/skillUpdatePlan.mjs'

// skillRoots — 3 exports
export {
  RUNTIME_SKILL_ROOTS,
  runtimeSkillRootPaths,
  skillRootGuidance,
} from './src/skillRoots.mjs'

// safetyRules — 16 exports
export {
  CLINICAL_CONTENT_TRIGGER_ENTITIES,
  CLINICAL_HIGH_RISK_ENTITIES,
  CLINICAL_SAFETY_CAUTION_CHECK,
  CLINICAL_SAFETY_CAUTION_RULES,
  TCM_TOXIC_HERBS,
  clinicalContentTriggerPattern,
  clinicalSafetyCautionHits,
  clinicalSafetyRules,
  compileCautionRules,
  compileTcmToxicHerbs,
  matchedClinicalTriggers,
  matchedHighRiskEntities,
  matchedTcmToxicHerbs,
  medicationSafetyIn,
  mentionedMedicines,
  tcmDoseFindings,
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

// citedSources — 15 exports
export {
  EMPTY_SNAPSHOT_MESSAGE,
  EVIDENCE_SNAPSHOT_FILE,
  INVALID_SNAPSHOT_MESSAGE,
  NOT_OBJECT_SNAPSHOT_MESSAGE,
  SNAPSHOT_RETRIEVED_KEY,
  UNRECORDED_LIMIT,
  auditCitedSources,
  citationUrlDefects,
  citationUrlDefectsByLine,
  citedHttpUrls,
  normalizedUrl,
  unrecordedCitationMessage,
  unresolvableCitationHost,
  unretrievedCitationMessage,
  withRetrievedSources,
} from './src/citedSources.mjs'

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

// agenda — 24 exports
export {
  AGENDA_ITEM_TYPES,
  ALLOWED_EFFECT_MEASURES,
  AUTOPILOT_PROHIBITIONS,
  DATASET_CLASSIFICATIONS,
  DATASET_PARTITIONS,
  DEFAULT_ENABLED_TASK_TYPES,
  EPISODE_STATES,
  REFUTATION_VERDICTS,
  AGENDA_DEFAULT_BUDGETS,
  AGENDA_MIN_EPISODE_BUDGET_CNY,
  MIN_RUN_BUDGET_CNY,
  STOPPING_RULES,
  USER_SIGNALS,
  VERIFICATION_BUDGET_SHARE,
  VERIFICATION_CANCELED_BY_STOP,
  VERIFICATION_UNSCHEDULED_REASONS,
  datasetPartitionOf,
  digestPlacement,
  directionVerdict,
  splitEpisodeBudget,
  standingVerdict,
  tierRaiseAllowed,
  userSignalScore,
  validateAgendaClaim,
} from './src/agenda.mjs'

// runtimeUiSurface — 11 exports
export {
  RUNTIME_UI_MUX_RESPONSE_MAX_BYTES,
  RUNTIME_UI_ANSWERED_METHODS,
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
  LEARNED_METHOD_CARD_SUMMARY_MAX_CHARS,
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
  METHOD_STEPS_MAX_CHARS,
  cleanMethodDisplay,
  cleanMethodSteps,
  formatDependsOn,
  isMethodDigest,
  learnedMethodCardEntry,
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
  scientificRegression,
  successfulFamilies,
  successfulRuns,
  unresolvedConflicts,
  validateMethodGraph,
} from './src/methodGraph.mjs'

// methodFeedback — what later became of the results a learned method was used for: the scientific axis of a method's
// record, kept apart from the delivery axis, joined by identifiers and never a claim of cause (plan §11.3 N14)
export {
  METHOD_APPLICABILITY_STATES,
  METHOD_FEEDBACK_LIMIT,
  METHOD_FEEDBACK_POLARITY,
  METHOD_FEEDBACK_SIGNALS,
  METHOD_FEEDBACK_VERSION,
  METHOD_LINK_LIMIT,
  METHOD_LINK_TYPES,
  METHOD_RESULT_LINK_LIMIT,
  METHOD_SCOPE_LIMITS,
  appendMethodLink,
  cleanMethodScope,
  diagnosticApplicability,
  emptyScientific,
  feedbackSignalFromCorrection,
  feedbackSignalFromReplay,
  foldMethodFeedback,
  hasMethodFeedback,
  mergeMethodResultLinks,
  methodScientific,
  projectMethodFeedback,
  projectMethodLink,
  projectMethodResultLinks,
  scientificOutcomes,
} from './src/methodFeedback.mjs'

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

// connectorCredentials — 8 exports
export {
  CONNECTOR_CREDENTIALS,
  CONNECTOR_CREDENTIAL_IDS,
  CONNECTOR_MISSING_CODES,
  connectorCredentialSpec,
  connectorDeploymentSource,
  connectorForMissingCode,
  connectorMissingCode,
  validateConnectorCredentialValue,
} from './src/connectorCredentials.mjs'

// runPhases — 4 exports
export {
  RUN_ACTIVITY_PHASES,
  RUN_ACTIVITY_PHASE_LABELS_ZH,
  phaseOfToolCall,
  summarizeRunPhases,
} from './src/runPhases.mjs'

// sourceTypes — 8 exports
export {
  EVIDENCE_SOURCE_TYPES,
  EVIDENCE_SOURCE_TYPE_LABELS_ZH,
  STUDY_BADGE_KINDS,
  evidenceSourceTypeOf,
  isEvidenceSourceType,
  sourceTypeOfSidecar,
  sourceTypeSidecarPath,
  studyBadgeKind,
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

// usagePurpose — 8 exports: what a metered model request was for (X1)
export {
  USAGE_PURPOSES,
  USAGE_PURPOSE_LABELS_ZH,
  isUsagePurpose,
  usagePurpose,
  usagePurposeOfRun,
  isResearcherOwnedWork,
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
// knowledgeChange — what depends on a changed source: the closed record of the calculations, memories and learned methods
// found by their recorded links, the state a link takes from a check, and the label a method carries (plan 2026-10-02
// §11.3 N15). A notice is a label, never a verdict.
export {
  AFFECTED_CLASSES,
  AFFECTED_LIST_LIMIT,
  AFFECTED_LOOKUP_STATES,
  AFFECTED_VIA,
  METHOD_SOURCE_CHANGE_LIMIT,
  METHOD_SOURCE_RELATIONS,
  SOURCE_CHANGE_LINK_STATES,
  SOURCE_REPLACED_KIND,
  affectedClass,
  affectedCounts,
  foldSourceChange,
  linkReasonOf,
  linkStateOf,
  linkStatesLeftFor,
  methodSourceChanges,
  projectAffected,
} from './src/knowledgeChange.mjs'
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
// sourceMaterials — 26 exports: what a parsed document's tables, figures and spreadsheets say about themselves (cell addresses, closed-format values, captions, footnotes, continuations), derived from the parser's text and never guessed
export {
  SOURCE_CONTINUATION_BASES,
  SOURCE_CONTINUATION_CERTAINTIES,
  SOURCE_MATERIALS_EXTRACTOR,
  SOURCE_MATERIALS_VERSION,
  SOURCE_MATERIAL_LIMITS,
  SOURCE_MATERIAL_REGION_UNKNOWN,
  SOURCE_PAGINATIONS,
  SOURCE_TABLE_STATUSES,
  SOURCE_TABLE_UNEXTRACTED_REASONS,
  SOURCE_VALUE_KINDS,
  SOURCE_VALUE_ORIGINS,
  deriveDelimitedStructure,
  deriveMarkdownStructure,
  deriveSheetStructure,
  materialAddress,
  materialAddressParts,
  materialCaptureText,
  materialCellMarkers,
  materialColumnLetters,
  materialHeaderContext,
  materialLabelKey,
  materialSkeleton,
  materialTableValues,
  materialTimepoint,
  parseMaterialCell,
  sourceMaterialsPagination,
} from './src/sourceMaterials.mjs'
// sourceMaterialsLocate — 13 exports: the page a structured unit is on, found in the document's own text layer, the ledger of what was located, ambiguous, unlocated, unextracted or failed, and where a quotation sits
export {
  SOURCE_LOCATE_LIMITS,
  SOURCE_MATERIAL_COVERAGE_STATUSES,
  SOURCE_MATERIAL_LOCATION_STATUSES,
  SOURCE_MATERIAL_PAGES_STATUSES,
  SOURCE_MATERIAL_PAGE_UNKNOWN_REASONS,
  locateQuoteInText,
  locateUnitsOnPages,
  materialPageSegments,
  materialOrigin,
  materialRowPage,
  materialTableCounts,
  sourceMaterialsCoverage,
  sourceMaterialsCoverageIssues,
} from './src/sourceMaterialsLocate.mjs'
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
// frontierVocabulary — 61 exports: the frontier feed's closed vocabularies
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
  FRONTIER_NOTICE_KINDS,
  frontierUpdateKind,
} from './src/frontierVocabulary.mjs'
// frontierSourceNames — 2 exports: what a reader calls a source — the
// institution, by the registry's owner entity, never the feed or interface the
// plugin reads it through (the table is `frontier-source-names.json`).
export {
  FRONTIER_SOURCE_DISPLAY_NAMES,
  frontierSourceDisplayName,
} from './src/frontierSourceNames.mjs'
// geoVocabulary — 81 exports: 「循证 GEO」's closed vocabularies (pools, engines,
// steps, measurement and error states, source and article words, order and
// ledger states, the social channel, the runtime tools' words), their Chinese
// labels, the metric ids the platform's own views read, and the one
// publishability rule the content store, the orchestrator and the market share.
export {
  GEO_ARMS,
  GEO_ARM_METRIC_ID,
  GEO_ARTICLE_GATES,
  GEO_ARTICLE_LAYERS,
  GEO_ARTICLE_LAYER_LABELS_ZH,
  GEO_ARTICLE_SAFETY,
  GEO_ARTICLE_STATUSES,
  GEO_AUDIENCES,
  GEO_CELL_STATUSES,
  GEO_CLAIM_SOURCE_KINDS,
  GEO_CLAIM_STATUSES,
  GEO_COVERAGE_DAYS_MAX,
  GEO_COVERAGE_DAYS_MIN,
  GEO_COVERAGE_DAY_OPTIONS,
  GEO_DATA_TYPES,
  GEO_DEFAULT_ENGINES,
  GEO_ENGINES,
  GEO_ENGINE_LABELS_ZH,
  GEO_ERROR_ACTIONS,
  GEO_ERROR_STABILITIES,
  GEO_ERROR_STATUSES,
  GEO_ERROR_TYPES,
  GEO_ERROR_TYPE_LABELS_ZH,
  GEO_EXPORT_KINDS,
  GEO_FAILURE_MODES,
  GEO_FAILURE_MODE_LABELS_ZH,
  GEO_GAP_CLASSES,
  GEO_GAP_CLASS_LABELS_ZH,
  GEO_GROUP_SIGNALS,
  GEO_IDENTITY_STATUSES,
  GEO_LEDGER_KINDS,
  GEO_MEDIA_TYPES,
  GEO_METRIC_LABELS_ZH,
  GEO_METRIC_ROW_SCOPES,
  GEO_MIN_CELL_SAMPLES,
  GEO_ORDER_CANCELLABLE_STATES,
  GEO_ORDER_OPEN_STATES,
  GEO_ORDER_STATES,
  GEO_OVERVIEW_METRICS,
  GEO_OWNED_LINK_PLATFORMS,
  GEO_OWNED_LINK_PLATFORM_LABELS_ZH,
  GEO_OWNED_LINK_STATUSES,
  GEO_POOLS,
  GEO_POOL_LABELS_ZH,
  GEO_PROBE_JOB_STATUSES,
  GEO_PROJECT_STATUSES,
  GEO_QUESTION_KINDS,
  GEO_QUESTION_PLATFORMS,
  GEO_READ_WHATS,
  GEO_READ_WHAT_LABELS_ZH,
  GEO_RECONCILIATION_STATUSES,
  GEO_ROUND_KINDS,
  GEO_ROUND_KIND_LABELS_ZH,
  GEO_ROUND_STATUSES,
  GEO_RX_CLASSES,
  GEO_SEVERITIES,
  GEO_SNAPSHOT_STATUSES,
  GEO_SOCIAL_EXCERPT_MAX_CHARS,
  GEO_SOCIAL_PLATFORMS,
  GEO_SOCIAL_PLATFORM_LABELS_ZH,
  GEO_SOCIAL_SORTS,
  GEO_SOCIAL_STATUSES,
  GEO_SOURCE_ATTRIBUTES,
  GEO_SOURCE_KINDS,
  GEO_SOURCE_KIND_LABELS_ZH,
  GEO_SOURCE_LAYERS,
  GEO_SOURCE_LAYER_LABELS_ZH,
  GEO_STATEMENT_VERDICTS,
  GEO_STEPS,
  GEO_STEP_LABELS_ZH,
  GEO_STEP_STATUSES,
  GEO_TARGET_DATA_TYPES,
  GEO_TIERS,
  GEO_TOPUP_STATUSES,
  GEO_URGENT_SEVERITIES,
  GEO_VIEW_METRIC_IDS,
  GEO_VOCABULARIES,
  GEO_WRITE_WHATS,
  GEO_WRITE_WHAT_LABELS_ZH,
  geoArticlePublishable,
  isGeoValue,
} from './src/geoVocabulary.mjs'
// geoMetrics — 20 exports: 「循证 GEO」's metric table (the owner's
// geo-skills metrics.yaml as `geo/metrics.json`, with its constants and their
// provenance), the probe sanity markers (`geo/sanity.json`), and the pure
// computation — per-scope cells with Wilson intervals and the no-fake-number
// statuses, the composite index with its redistribution declared, the noise
// band, the rolling trend, the net effect, the two hard lines and the
// T/CAACCHINA names; CPython-exact rounding and summation, so a number here
// equals the owner's tooling to the last digit. The pool and engine
// vocabularies are geoVocabulary's.
export {
  GEO_METRICS,
  GEO_METRIC_IDS,
  GEO_METRIC_POOL_IDS,
  GEO_METRIC_SCOPES,
  GEO_PROBE_SANITY,
  canonicalGeoUrl,
  computeGeoMetrics,
  computeGvi,
  geoCellRows,
  geoConstant,
  geoMetricDefinition,
  hardLines,
  isOurCitation,
  netEffect,
  noiseBand,
  pythonRound,
  pythonSum,
  rollingTrend,
  standardName,
  wilsonInterval,
} from './src/geoMetrics.mjs'
export { frontierNoticeTarget, frontierNoticeHref } from './src/frontierPresentation.mjs';

export { validAgendaDate, validateAgendaSchedule, normalizeAgendaSchedule, agendaLocalDate, DISPLAY_TIME_ZONE, agendaDueOccurrence, agendaNextOccurrence } from "./src/agendaSchedule.mjs";

// vcrVocabulary — 127 exports: 「虚拟临研」's closed vocabularies (nine value sources, three scientific
// conclusions, review states, missing reasons, intended uses, model risk and
// the study's seven steps and tabs)
export {
  VCR_ACTIONS,
  VCR_ACTION_LABELS_ZH,
  VCR_ANALYSIS_TABLES,
  VCR_ANALYSIS_TABLE_LABELS_ZH,
  VCR_ASSUMPTION_KEY,
  VCR_ASSUMPTION_KEY_PATTERN,
  VCR_ASSUMPTION_SOURCE_KINDS,
  VCR_ASSUMPTION_SOURCE_KIND_LABELS_ZH,
  VCR_BOOTSTRAP_MIN,
  VCR_CAPABILITIES,
  VCR_COLUMN_SOURCES,
  VCR_COLUMN_SOURCE_EXPORT,
  VCR_COMPARABILITY_DIMENSIONS,
  VCR_COMPARABILITY_DIMENSION_LABELS_ZH,
  VCR_COMPARATOR_ROUTES,
  VCR_COMPARATOR_ROUTE_LABELS_ZH,
  VCR_CONCLUSIONS,
  VCR_CONCLUSION_LABELS_ZH,
  VCR_CONTACT_STATES,
  VCR_COUNT_KEYS,
  VCR_COUNT_LABELS_ZH,
  VCR_COX_FEW_EVENTS,
  VCR_CRITERION_STATES,
  VCR_CRITERION_STATE_LABELS_ZH,
  VCR_CRITERION_TYPES,
  VCR_CRITERION_TYPE_LABELS_ZH,
  VCR_DATA_TIERS,
  VCR_DATA_TIER_LABELS_ZH,
  VCR_DATA_TIER_UNLOCKS_ZH,
  VCR_DEFAULT_ESTIMAND,
  VCR_DISTRIBUTIONS,
  VCR_E10_CONDITIONS,
  VCR_E10_CONDITION_LABELS_ZH,
  VCR_ELIGIBILITY_SUMMARIES,
  VCR_ELIGIBILITY_SUMMARY_LABELS_ZH,
  VCR_ENDPOINT_TYPES,
  VCR_ENDPOINT_TYPE_LABELS_ZH,
  VCR_ENROLLMENT_KINDS,
  VCR_ESS_FLOOR,
  VCR_ESTIMANDS,
  VCR_ESTIMAND_LABELS_ZH,
  VCR_EXPORT_KINDS,
  VCR_FIELD_ROLES,
  VCR_EXPORT_KIND_LABELS_ZH,
  VCR_FOLLOWUP_KINDS,
  VCR_FOLLOWUP_KIND_LABELS_ZH,
  VCR_HUMAN_STOPS,
  VCR_HUMAN_STOP_LABELS_ZH,
  VCR_INTENDED_USES,
  VCR_INTENDED_USE_LABELS_ZH,
  VCR_INTERVAL_KINDS,
  VCR_INTERVAL_KIND_LABELS_ZH,
  VCR_JOB_KINDS,
  VCR_JOB_STATES,
  VCR_JOB_STATE_LABELS_ZH,
  VCR_LINEAGE_NODE_KINDS,
  VCR_MAP_CONFLICT_BOUND,
  VCR_MEMBER_ROLES,
  VCR_MEMBER_ROLE_LABELS_ZH,
  VCR_MIN_CELL_SIZE,
  VCR_MISSING_REASONS,
  VCR_MISSING_REASON_LABELS_ZH,
  VCR_MODEL_RISKS,
  VCR_MODEL_RISK_EVIDENCE,
  VCR_MODEL_RISK_LABELS_ZH,
  VCR_MODEL_TIERS,
  VCR_MODEL_TIER_LABELS_ZH,
  VCR_MODEL_TIER_USE_CEILING,
  VCR_NEGATIVE_CONTROL_CALIBRATION_MIN,
  VCR_NEGATIVE_CONTROL_VERDICTS,
  VCR_NEGATIVE_CONTROL_VERDICT_LABELS_ZH,
  VCR_NON_INDIVIDUAL_SOURCES,
  VCR_NOTIFICATION_KINDS,
  VCR_NOTIFICATION_LABELS_ZH,
  VCR_NOT_ESTIMABLE_RULES,
  VCR_NOT_ESTIMABLE_RULE_LABELS_ZH,
  VCR_OPTIONAL_COUNT_KEYS,
  VCR_PEOPLE_COUNT_FIELDS,
  VCR_PEOPLE_COUNT_MAP_KEYS,
  VCR_PEOPLE_COUNT_MEASURES,
  VCR_PEOPLE_COUNT_SCALAR_FIELDS,
  VCR_PERFORMANCE_MEASURES,
  VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  VCR_POOLING_METHODS,
  VCR_POOLING_METHOD_LABELS_ZH,
  VCR_POPULATION_KINDS,
  VCR_POPULATION_KIND_LABELS_ZH,
  VCR_PROGNOSTIC_QUALIFICATION,
  VCR_PROGNOSTIC_QUALIFICATION_LABEL_ZH,
  VCR_QUALITY_CATEGORIES,
  VCR_QUALITY_CATEGORY_LABELS_ZH,
  VCR_REAL_PATIENT_SOURCES,
  VCR_RECONSTRUCTION_TOLERANCE,
  VCR_REFERRAL_STATES,
  VCR_REFERRAL_STATE_LABELS_ZH,
  VCR_REPLICATES_ALT_MIN,
  VCR_REPLICATES_NULL_MIN,
  VCR_REVIEW_KINDS,
  VCR_REVIEWER_KINDS,
  VCR_REVIEW_LIFECYCLE,
  VCR_REVIEW_KIND_LABELS_ZH,
  VCR_REVIEW_STATES,
  VCR_REVIEW_STATE_LABELS_ZH,
  VCR_RISK_USE_CEILING,
  VCR_ROBUSTNESS_STAGES,
  VCR_ROBUSTNESS_STAGE_LABELS_ZH,
  VCR_ROLE_ABILITIES,
  VCR_ROUTE_MIN_TIER,
  VCR_SMD_FLOOR,
  VCR_SOURCE_FORMATS,
  VCR_SPENDING_FUNCTIONS,
  VCR_SPENDING_FUNCTION_LABELS_ZH,
  VCR_STALE_REASONS,
  VCR_STALE_REASON_LABELS_ZH,
  VCR_STEPS,
  VCR_STEP_CAPABILITIES,
  VCR_STEP_LABELS_ZH,
  VCR_STEP_NEEDS,
  VCR_STEP_PRODUCTS,
  VCR_STEP_STATUSES,
  VCR_STEP_STATUS_LABELS_ZH,
  VCR_STUDY_STATUSES,
  VCR_STUDY_STATUS_LABELS_ZH,
  VCR_SUPPORT_CEILING,
  VCR_SYNTHETIC_USES,
  VCR_SYNTHETIC_USE_LABELS_ZH,
  VCR_TABS,
  VCR_TAB_LABELS_ZH,
  VCR_TIME_KINDS,
  VCR_TIME_KIND_LABELS_ZH,
  VCR_TRIAL_DESIGNS,
  VCR_TRIAL_DESIGN_LABELS_ZH,
  VCR_TWIN_EVIDENCE,
  VCR_TWIN_LABELS_ZH,
  VCR_VALUE_SOURCES,
  VCR_VALUE_SOURCE_LABELS_ZH,
  intendedUseCeiling,
  intendedUseCeilingDetail,
  intendedUseCeilingFor,
  missingModelEvidence,
  roleAllows,
  twinLabel,
  vcrTierIsSupported,
  vcrTierNeedsSupport,
  vcrTierOffer,
  vcrTierSupportedBy,
  useWithin,
  vcrKnown,
  vcrWeakestSource,
} from './src/vcrVocabulary.mjs'

// vcrModelAssessment — 「虚拟临研」's model assessment record (ICH M15 Appendix 1: question of interest, context
// of use, model influence, consequence of a wrong decision, the model risk derived from the two, model impact,
// technical criteria, the evaluation and the outcome), and the section vocabulary of the 模型分析计划 and the
// 模型分析报告 built on it
export {
  VCR_ASSESSMENT_KEY,
  VCR_ASSESSMENT_KEY_PATTERN,
  VCR_ASSESSMENT_LIMITS,
  VCR_ASSESSMENT_RATING_FIELDS,
  VCR_ASSESSMENT_ROWS,
  VCR_ASSESSMENT_TEXT_FIELDS,
  VCR_MODEL_DOCUMENT_ATTRIBUTION_ZH,
  VCR_MODEL_DOCUMENT_KINDS,
  VCR_MODEL_DOCUMENT_SECTIONS,
  VCR_MODEL_DOCUMENT_SECTION_LABELS_ZH,
  VCR_MODEL_DOCUMENT_TITLES_ZH,
  VCR_MODEL_RISK_RULES,
  VCR_MODEL_RISK_RULE_LABELS_ZH,
  VCR_RATINGS,
  VCR_RATING_LABELS_ZH,
  normalizeVcrAssessment,
  vcrAssessmentGroups,
  vcrAssessmentIssues,
  vcrAssessmentRows,
  vcrAssessmentText,
  vcrModelDocumentTakesProse,
  vcrModelRisk,
} from './src/vcrModelAssessment.mjs'

// vcrModelInterfaces — the two model-package call shapes of plan §5.2 (baseline → outcome distribution, event
// history → N future trajectories), the second shape's card contract and the scope check over it
export {
  VCR_DEFAULT_MODEL_INTERFACE,
  VCR_EVENT_HISTORY_CARD_FIELDS,
  VCR_HORIZON_UNIT_DAYS,
  VCR_HOSTED_MODEL_INTERFACES,
  VCR_MODEL_INTERFACES,
  VCR_MODEL_INTERFACE_LABELS_ZH,
  vcrEventHistoryScopeIssues,
  vcrModelCardIssues,
  vcrModelInterfaceOf,
} from './src/vcrModelInterfaces.mjs'

// vcrSuppression — 2 exports: small-cell suppression for everything a model may read: every people-count
// below the floor, in any shape the stores produce
export {
  VCR_CELL_IDENTITY_KEYS,
  suppressForModel,
} from './src/vcrSuppression.mjs'

// vcrRules — 16 exports: the two closed rule grammars 「虚拟临研」 uses instead of code: row rules over table
// columns (three-valued, Kleene) and eligibility requirements over dated facts,
// with their limits, validators and the row-rule evaluator the parity fixture pins
export {
  VCR_REQUIREMENT_AGGREGATES,
  VCR_ELAPSED_COMPARATORS,
  VCR_REQUIREMENT_COMPARATORS,
  VCR_REQUIREMENT_LIMITS,
  VCR_REQUIREMENT_OPS,
  VCR_REQUIREMENT_VARIABLE_PATTERN,
  VCR_ROW_RULE_COLUMN_PATTERN,
  VCR_ROW_RULE_COMPARATORS,
  VCR_ROW_RULE_LIMITS,
  VCR_ROW_RULE_OPS,
  VCR_ROW_RULE_ORDERING_COMPARATORS,
  evaluateRowRule,
  evaluateRowRuleColumn,
  findExpressionFields,
  validateNamedRules,
  validateRequirement,
  validateRowRule,
} from './src/vcrRules.mjs'

// vcrKnowledgePack — 25 exports: 「虚拟临研」's disease knowledge pack: the contract a pack is written to
// (sections, closed licence and code-system tables, restricted sources), its validator at two levels, and
// the pure readers a page and a tool use (entry sources, summary, name search, concept-to-column mapping)
export {
  VCR_PACK_CODE_SYSTEMS,
  VCR_PACK_ID_PATTERN,
  VCR_PACK_LEVELS,
  VCR_PACK_LICENCES,
  VCR_PACK_LIMITS,
  VCR_PACK_MAPPING_TYPES,
  VCR_PACK_REFUSED_CODE_SYSTEMS,
  VCR_PACK_RESTRICTED_SOURCES,
  VCR_PACK_SCHEMA,
  VCR_PACK_SECTIONS,
  VCR_PACK_SECTION_LABELS_ZH,
  VCR_PACK_STATUSES,
  VCR_PACK_STATUS_LABELS_ZH,
  VCR_PACK_TERM_KINDS,
  VCR_PACK_USE_CLASSES,
  validateKnowledgePack,
  vcrPackConceptColumns,
  vcrPackEntrySources,
  vcrPackMatchesName,
  vcrPackRestrictedSource,
  vcrPackSummary,
  vcrRemapRowRuleColumns,
  vcrRequirementVariables,
  vcrRowRuleColumns,
  vcrSuggestColumnRemap,
} from './src/vcrKnowledgePack.mjs'

// vcrKnowledgePackData — 1 export: the curated packs that ship with the platform, validated on import
export {
  VCR_SHIPPED_PACKS,
} from './src/vcrKnowledgePackData.mjs'

// vcrEngineJob — 28 exports: the engine protocol: a frozen scenario, its canonical bytes, the replicate
// arithmetic behind every Monte-Carlo standard error, the input kinds a caller
// and the control plane may write, and the validators the control plane and
// `vcr-engine` both run
export {
  VCR_CALLER_SNAPSHOT_KIND,
  VCR_COLUMN_SOURCE_LIMITS,
  VCR_DESIGN_SUPPORT,
  VCR_ENGINE_METHODS,
  VCR_ENGINE_METHOD_IDS,
  VCR_ENGINE_PROTOCOL_VERSION,
  VCR_ENGINE_TABLE_INPUT_KINDS,
  VCR_INPUT_KINDS,
  VCR_JOB_FIELDS,
  VCR_JOB_METHODS,
  VCR_LOCATION_LIMITS,
  VCR_MAX_REPLICATES,
  VCR_CALLER_INPUT_KEYS,
  VCR_ENGINE_LINEAGE_INPUT_KEYS,
  VCR_ENGINE_TABLE_INPUT_KEYS,
  VCR_INDIVIDUAL_INPUT_SOURCES,
  VCR_OBSERVED_ONLY_METHODS,
  VCR_PATIENT_LEVEL_JOB_KINDS,
  VCR_PATTERNS,
  VCR_SCENARIO_SCHEMAS,
  VCR_VERSIONED_INPUT_KINDS,
  canonicalScenarioJson,
  mcseOf,
  replicateFloor,
  replicatesForMcse,
  validateCallerInputs,
  validateCounts,
  validateEngineJob,
  validateEngineResult,
  vcrIsNullScenario,
  vcrLocationIsValid,
  vcrReplicateFloorFor,
  vcrResultOutputPayload,
} from './src/vcrEngineJob.mjs'

// vcrScenarioSchemas — 4 exports: the walker that checks a scenario against its method's schema, and the two tables of
// which analysis a design may run
export {
  VCR_SINGLE_ARM_ANALYSIS_METHODS,
  VCR_TWO_ARM_ANALYSIS_METHODS,
  validateScenario,
  whenHolds,
} from './src/vcrScenarioSchemas.mjs'

// vcrScenarioHelp — 7 exports: what a model is given to write a scenario from, rendered from the schemas above
// (`runtime/mcp/evimed-research/vcr_scenario_help.json` is generated from it), and the keys read inside a node
export {
  VCR_RUN_SCENARIO_FIELDS,
  VCR_SCENARIO_EXAMPLES,
  VCR_SCENARIO_HELP_VERSION,
  vcrScenarioChildKeys,
  vcrScenarioHelp,
  vcrScenarioParentOf,
  vcrScenarioRows,
} from './src/vcrScenarioHelp.mjs'

// vcrLineage — 8 exports: lineage: which results a changed input makes stale, and whether a
// countersignature still holds
export {
  VCR_HEAVY_NODE_KINDS,
  VCR_LIGHT_NODE_KINDS,
  affectedNodes,
  lineageImpact,
  lineageNode,
  parseLineageNode,
  recomputePlan,
  reviewStateFor,
} from './src/vcrLineage.mjs'

// vcrContracts — 14 exports: the five 「虚拟临研」 contracts' own findings — all advisory
export {
  VCR_BACKSTAGE_FILES,
  VCR_CHECK_IDS,
  VCR_CRITERIA_FILE,
  VCR_MATCHING_FILE,
  VCR_PACKAGE_FILE,
  VCR_RESULTS_FILE,
  VCR_SIMULATION_FILE,
  proseNumbers,
  resultNumbers,
  vcrCohortFindings,
  vcrComparatorFindings,
  vcrMatchingFindings,
  vcrSimulationReportFindings,
  vcrStudyPackageFindings,
} from './src/vcrContracts.mjs'

export { DOCUMENT_EXPORT_VERSION, DOCUMENT_RENDERER_VERSION, DOCUMENT_EXPORT_FORMATS, DOCUMENT_EXPORT_MIME, DOCUMENT_EXPORT_ERROR_MESSAGES, documentExportFormats, documentExportDigest } from "./src/documentExport.mjs";

// numberBinding — the one mechanism by which a number in a report is resolved from a result, not typed (plan 2026-10-02 §11.3 N06;
// lifted out of the 「虚拟临研」 renderer, which keeps its own issue codes and sentences).
export {
  NUMBER_FORMATS,
  NUMBER_REFERENCE_PATTERN,
  NUMBER_UNCOMPUTED,
  NUMBER_UNIT_FORMATS,
  NUMBER_UNPARSED_PATTERN,
  formatNumberValue,
  readNumberPath,
  renderNumberTemplate,
  resolveNumberPath,
  typedNumberSpans,
  typedNumbersOf,
} from './src/numberBinding.mjs'

// producerSnapshot — what produced a result version's bytes: script/method identity, input versions, environment facts,
// and, as a closed list, what the platform did not observe (plan 2026-10-02 §11.3 N06).
export {
  PRODUCER_SNAPSHOT_KINDS,
  REPRODUCTION_STATES,
  SNAPSHOT_ORIGINS,
  SNAPSHOT_UNKNOWNS,
  authoredSnapshot,
  engineJobSnapshot,
  isCodePath,
  methodIdentityFromResult,
  projectProducerSnapshot,
  renderSnapshot,
  skillScriptSnapshot,
  snapshotGaps,
  unobservedSnapshot,
} from './src/producerSnapshot.mjs'

// valueBindings — each number a report, table or figure prints, bound to the calculation version, key, unit and format
// it came from; what binds no value is labelled unbound, never withheld (plan 2026-10-02 §11.3 N06).
export {
  MATCHED_BINDING_FORMAT,
  NUMBER_BINDING_VERSION,
  RESULT_LINEAGE_LIMITS,
  UNBOUND_REASONS,
  VALUE_BINDING_BASES,
  VALUE_BINDING_STATUSES,
  applyBindingFormat,
  bindPrintedNumbers,
  bindableKind,
  bindingGaps,
  bindingSources,
  changeImpact,
  emptyValueBindings,
  flattenMachineValues,
  locatorIndex,
  printedNumberWords,
  projectValueBindings,
  renderWithBindings,
  valueBindingRecord,
  valueBindingStatus,
} from './src/valueBindings.mjs'

// resultCorrection — a correction made through the anchored revision, as a fact about two immutable result versions:
// the pair, what differs between them, the researcher's words and who generated the successor (plan §11.3 N12).
export {
  RENDERING_FORMATS,
  RESULT_CORRECTION_ANCHOR_KINDS,
  RESULT_CORRECTION_DETAIL_BYTES,
  RESULT_CORRECTION_KINDS,
  RESULT_CORRECTION_STATES,
  RESULT_CORRECTION_VERSION,
  correctionCalculations,
  correctionEffects,
  fitResultCorrection,
  projectCorrectionOutcome,
  projectResultCorrection,
  renderingFormat,
} from './src/resultCorrection.mjs'

// resultPackage — the selected research package: its omission and exclusion vocabulary, the credential check that keeps
// a secret out of its bytes, and the execution, verification and reproduction records beside its files (plan §11.3 N16).
export {
  RESULT_PACKAGE_EXCLUSIONS,
  RESULT_PACKAGE_FILE_ROLES,
  RESULT_PACKAGE_FORMAT,
  RESULT_PACKAGE_OMISSION_REASONS,
  RESULT_PACKAGE_RECORD_FILES,
  RESULT_PACKAGE_SCAN_LIMIT_BYTES,
  RESULT_PACKAGE_VERSION,
  credentialShapedText,
  executionRecord,
  omissionReason,
  packageCompleteness,
  packageCorrection,
  packageCredentialScan,
  packageReplay,
  pinnedRequirements,
  reproductionRecord,
  verificationRecord,
} from './src/resultPackage.mjs'

export { RESULT_PRODUCER_KINDS, RESULT_INPUT_KINDS, RESULT_AVAILABILITY, isResultDigest, normalizeResultPath, projectResultInput, projectResultVersion, projectResultMethod, resultMethodDifference, validateResultAnchor, resultVersionDifference } from "./src/resultProvenance.mjs";
export { RESULT_REPLAY_METHODS, compareResultNumbers } from "./src/resultReplay.mjs";
export { RESEARCH_BILLING_VERSION, RESEARCH_MONEY_SCALE, RESEARCH_BILLABLE_PURPOSES, STEP_WAITING_ALLOWANCE, allowanceRefusalSentence, allowanceWaitingNote, allowanceWaitingSentence, stepWaitingFor, researchMoneyUnits, researchMoneyDecimal, researchTaskCharge, SIMULATED_WALLET_LABEL, SIMULATED_START_CREDITS, SIMULATED_LOW_CREDITS, SIMULATED_WALLET_PAGES, SIMULATED_TOPUP_PACKAGES } from './src/researchBilling.mjs';

// dataSemantics — the reusable meaning of a researcher's tables (plan 2026-10-02 §11.3 N03): facts with a basis,
// exact source versions, versioned transformations and the named outcomes of the deterministic data checks.
export {
  DATA_CHECK_FAMILIES,
  DATA_CHECK_FAMILY_LABELS_ZH,
  DATA_CHECK_NOT_CHECKED_REASONS,
  DATA_CHECK_NOT_CHECKED_REASON_IDS,
  DATA_CHECK_OUTCOMES,
  DATA_CHECK_OUTCOME_IDS,
  DATA_CHECK_SEVERITIES,
  DATA_DATASET_FACETS,
  DATA_DRIFT_BOUNDS,
  DATA_FACET_LABELS_ZH,
  DATA_JOIN_CARDINALITIES,
  DATA_JOIN_CARDINALITY_LABELS_ZH,
  DATA_SEMANTICS_ERROR_CODES,
  DATA_SEMANTICS_ERROR_MESSAGE_ZH,
  DATA_SEMANTICS_KIND,
  DATA_SEMANTICS_LIMITS,
  DATA_SEMANTICS_SCHEMA_VERSION,
  DATA_TABLE_FACETS,
  DATA_TRANSFORM_KINDS,
  DATA_TRANSFORM_KIND_LABELS_ZH,
  DATA_VALUE_SOURCES,
  DATA_VARIABLE_FACETS,
  DATA_VARIABLE_ROLES,
  DATA_VARIABLE_ROLE_LABELS_ZH,
  DATA_VARIABLE_TYPES,
  SEMANTIC_BASES,
  SEMANTIC_BASIS_LABELS_ZH,
  SEMANTIC_VIAS,
  applyCheckReport,
  applySemanticsPatch,
  applyTransformation,
  asWorkspacePath,
  confirmationPatch,
  emptySemanticsAsset,
  fitAsset,
  interpretationOf,
  isDatasetId,
  joinId,
  mergeFact,
  normalizeBinding,
  normalizeCheckReport,
  normalizeDenominators,
  normalizeTransformation,
  semanticBasisRank,
  semanticFacts,
  semanticsListing,
  summarizeSemantics,
} from './src/dataSemantics.mjs'

// geneExpression — NCBI Gene Expression Omnibus series to differential expression (plan 2026-10-02 §11.3 N17): the
// accessions, the six limits, the tool's refusals and the advisory findings over its package. Not 「循证 GEO」.
export {
  GENE_EXPRESSION_ACCESSIONS,
  GENE_EXPRESSION_CAPABILITY_ID,
  GENE_EXPRESSION_CHECK_IDS,
  GENE_EXPRESSION_CONTRACT_KIND,
  GENE_EXPRESSION_ERROR_CODES,
  GENE_EXPRESSION_ERROR_MESSAGE_ZH,
  GENE_EXPRESSION_LIMITATION_ERROR_CODES,
  GENE_EXPRESSION_LIMITS,
  GENE_EXPRESSION_LIMIT_ACTIONS,
  GENE_EXPRESSION_LIMIT_MESSAGE_ZH,
  GENE_EXPRESSION_LIMIT_NAMES,
  GENE_EXPRESSION_METHOD_ID,
  GENE_EXPRESSION_NOT_LIMMA,
  GENE_EXPRESSION_REPORT_FILE,
  GENE_EXPRESSION_RESULTS_KIND,
  GENE_EXPRESSION_RESULT_FILES,
  GENE_EXPRESSION_RUN_FIX_ERROR_CODES,
  GENE_EXPRESSION_SCHEMA_VERSION,
  GENE_EXPRESSION_SOURCES_ROOT,
  geneExpressionFindings,
} from './src/geneExpression.mjs'

export { EVOLUTION_ERROR_MESSAGES, EVOLUTION_TRACKS, EVOLUTION_DATA_LEVELS, EVOLUTION_VALIDATION_LEVELS, EVOLUTION_DECISION_CLASSES, EVOLUTION_GAP_CODES, EVOLUTION_LEAD_SOURCES, EVOLUTION_ORIGINS, EVOLUTION_BUILD_FORMS, EVOLUTION_CASE_GROUPS, EVOLUTION_TOOL_STATES, EVOLUTION_JOB_KINDS, evolutionDecisionClass, evolutionAdaptiveClass, evolutionValidationLevel, evolutionToolVisible, evolutionMethodFields, evolutionDataMatch, validateEvolutionDataRequirements } from './src/evolution.mjs'
