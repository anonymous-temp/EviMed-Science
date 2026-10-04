/**
 * Emit the parts of `@evimed/domain` the R engine must agree with, as JSON.
 *
 * Hidden knowledge: the engine container has no Node, so it cannot import the
 * domain at run time — it reads `R/domain-snapshot.json` instead. That file is
 * therefore a *generated* copy, and a copy is the thing that drifts. The test
 * `tests/numeric/N00_protocol.R` re-runs this generator against the
 * live domain module and refuses to pass unless the bytes on disk match, which
 * is the only reason keeping a copy is safe.
 *
 * Run: node tests/helpers/emit-domain-snapshot.mjs [outputPath]
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const domain = resolve(here, '../../../../OpenScience/packages/domain/src')

const job = await import(`${domain}/vcrEngineJob.mjs`)
const vocab = await import(`${domain}/vcrVocabulary.mjs`)
const rules = await import(`${domain}/vcrRules.mjs`)

const snapshot = {
  protocolVersion: job.VCR_ENGINE_PROTOCOL_VERSION,
  methods: Object.fromEntries(
    Object.entries(job.VCR_ENGINE_METHODS).map(([id, spec]) => [id, {
      version: spec.version, endpoints: [...spec.endpoints], crossChecks: [...spec.crossChecks], modelTier: spec.modelTier,
      ...('legacyVersion' in spec ? { legacyVersion: spec.legacyVersion, legacyDesigns: [...spec.legacyDesigns] } : {}),
    }]),
  ),
  jobMethods: { ...job.VCR_JOB_METHODS },
  patientLevelJobKinds: [...job.VCR_PATIENT_LEVEL_JOB_KINDS],
  observedOnlyMethods: [...job.VCR_OBSERVED_ONLY_METHODS],
  engineTableInputKeys: [...job.VCR_ENGINE_TABLE_INPUT_KEYS],
  engineLineageInputKeys: [...job.VCR_ENGINE_LINEAGE_INPUT_KEYS],
  individualInputSources: Object.fromEntries(Object.entries(job.VCR_INDIVIDUAL_INPUT_SOURCES).map(([method, sources]) => [method, [...sources]])),
  jobFields: [...job.VCR_JOB_FIELDS],
  maxReplicates: job.VCR_MAX_REPLICATES,
  patterns: { ...job.VCR_PATTERNS },
  locationLimits: { ...job.VCR_LOCATION_LIMITS },
  inputKinds: [...job.VCR_INPUT_KINDS],
  versionedInputKinds: [...job.VCR_VERSIONED_INPUT_KINDS],
  engineTableInputKinds: [...job.VCR_ENGINE_TABLE_INPUT_KINDS],
  callerSnapshotKind: job.VCR_CALLER_SNAPSHOT_KIND,
  // Read with simplifyVector = FALSE (see `vcr_scenario_schemas()`): these are
  // trees, and an array of arrays would otherwise become a matrix.
  scenarioSchemas: job.VCR_SCENARIO_SCHEMAS,
  designSupport: job.VCR_DESIGN_SUPPORT,
  rules: {
    rowRule: {
      ops: [...rules.VCR_ROW_RULE_OPS],
      comparators: [...rules.VCR_ROW_RULE_COMPARATORS],
      orderingComparators: [...rules.VCR_ROW_RULE_ORDERING_COMPARATORS],
      columnPattern: rules.VCR_ROW_RULE_COLUMN_PATTERN,
      limits: { ...rules.VCR_ROW_RULE_LIMITS },
    },
  },
  jobKinds: [...vocab.VCR_JOB_KINDS],
  endpointTypes: [...vocab.VCR_ENDPOINT_TYPES],
  trialDesigns: [...vocab.VCR_TRIAL_DESIGNS],
  performanceMeasures: [...vocab.VCR_PERFORMANCE_MEASURES],
  spendingFunctions: [...vocab.VCR_SPENDING_FUNCTIONS],
  notEstimableRules: [...vocab.VCR_NOT_ESTIMABLE_RULES],
  countKeys: [...vocab.VCR_COUNT_KEYS],
  optionalCountKeys: [...vocab.VCR_OPTIONAL_COUNT_KEYS],
  valueSources: [...vocab.VCR_VALUE_SOURCES],
  realPatientSources: [...vocab.VCR_REAL_PATIENT_SOURCES],
  // A column's source, most direct first; the engine labels a result with the
  // weakest of the columns it used (`vcr_weakest_source`, R/inputs.R).
  columnSources: [...vocab.VCR_COLUMN_SOURCES],
  columnSourceLimits: { ...job.VCR_COLUMN_SOURCE_LIMITS },
  nonIndividualSources: [...vocab.VCR_NON_INDIVIDUAL_SOURCES],
  populationKinds: [...vocab.VCR_POPULATION_KINDS],
  comparatorRoutes: [...vocab.VCR_COMPARATOR_ROUTES],
  estimands: [...vocab.VCR_ESTIMANDS],
  defaultEstimand: vocab.VCR_DEFAULT_ESTIMAND,
  poolingMethods: [...vocab.VCR_POOLING_METHODS],
  distributions: [...vocab.VCR_DISTRIBUTIONS],
  intervalKinds: [...vocab.VCR_INTERVAL_KINDS],
  qualityCategories: [...vocab.VCR_QUALITY_CATEGORIES],
  conclusions: [...vocab.VCR_CONCLUSIONS],
  missingReasons: [...vocab.VCR_MISSING_REASONS],
  modelRisks: [...vocab.VCR_MODEL_RISKS],
  analysisTables: [...vocab.VCR_ANALYSIS_TABLES],
  criterionStates: [...vocab.VCR_CRITERION_STATES],
  eligibilitySummaries: [...vocab.VCR_ELIGIBILITY_SUMMARIES],
  twinEvidence: [...vocab.VCR_TWIN_EVIDENCE],
  modelTiers: [...vocab.VCR_MODEL_TIERS],
  syntheticUses: [...vocab.VCR_SYNTHETIC_USES],
  limits: {
    minCellSize: vocab.VCR_MIN_CELL_SIZE,
    bootstrapMin: vocab.VCR_BOOTSTRAP_MIN,
    replicatesNullMin: vocab.VCR_REPLICATES_NULL_MIN,
    replicatesAltMin: vocab.VCR_REPLICATES_ALT_MIN,
    smdFloor: vocab.VCR_SMD_FLOOR,
    // Deployment presets for the deterministic 「不可估计」 rules. A scenario
    // cannot loosen them: the engine reads them here, never from a job.
    essFloor: vocab.VCR_ESS_FLOOR,
    supportCeiling: vocab.VCR_SUPPORT_CEILING,
    conflictBound: vocab.VCR_MAP_CONFLICT_BOUND,
    tolerance: { ...vocab.VCR_RECONSTRUCTION_TOLERANCE },
  },
}

const out = resolve(process.argv[2] ?? resolve(here, '../../R/domain-snapshot.json'))
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`)
process.stdout.write(`${out}\n`)
