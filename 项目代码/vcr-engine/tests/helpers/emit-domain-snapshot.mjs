/**
 * Emit the parts of `@evimed/domain` the R engine must agree with, as JSON.
 *
 * Hidden knowledge: the engine container has no Node, so it cannot import the
 * domain at run time — it reads `R/domain-snapshot.json` instead. That file is
 * therefore a *generated* copy, and a copy is the thing that drifts. The test
 * `tests/numeric/N00_protocol_agreement.R` re-runs this generator against the
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

const snapshot = {
  protocolVersion: job.VCR_ENGINE_PROTOCOL_VERSION,
  methods: Object.fromEntries(
    Object.entries(job.VCR_ENGINE_METHODS).map(([id, spec]) => [id, {
      version: spec.version, endpoints: [...spec.endpoints], crossChecks: [...spec.crossChecks],
    }]),
  ),
  jobMethods: { ...job.VCR_JOB_METHODS },
  patientLevelJobKinds: [...job.VCR_PATIENT_LEVEL_JOB_KINDS],
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
  nonIndividualSources: [...vocab.VCR_NON_INDIVIDUAL_SOURCES],
  populationKinds: [...vocab.VCR_POPULATION_KINDS],
  comparatorRoutes: [...vocab.VCR_COMPARATOR_ROUTES],
  estimands: [...vocab.VCR_ESTIMANDS],
  defaultEstimand: vocab.VCR_DEFAULT_ESTIMAND,
  poolingMethods: [...vocab.VCR_POOLING_METHODS],
  distributions: [...vocab.VCR_DISTRIBUTIONS],
  intervalKinds: [...vocab.VCR_INTERVAL_KINDS],
  qualityCategories: [...vocab.VCR_QUALITY_CATEGORIES],
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
  },
}

const out = resolve(process.argv[2] ?? resolve(here, '../../R/domain-snapshot.json'))
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`)
process.stdout.write(`${out}\n`)
