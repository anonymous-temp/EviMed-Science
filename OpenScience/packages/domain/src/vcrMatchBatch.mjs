/**
 * The jobs the control plane runs itself on the slow local lane, each calling a model per unit of work: judging patients against trials
 * (`match_judge`) and reading originals into a person's record (`records_import`), with their limits and the shape of their frozen
 * scenarios. The kind `match_extract` (the retired reading of records for the facts a protocol's criteria ask about) stays in the
 * vocabulary so that the rows already stored under it keep reading; nothing starts one.
 *
 * @module @evimed/domain/vcrMatchBatch
 */

/** The methods the control plane runs itself on the slow local lane (each calls a model per unit of work); `matching.extract` is retired and stays so that stored rows keep their method version. */
export const VCR_MATCH_BATCH_METHODS = Object.freeze({
  'matching.extract': Object.freeze({ version: '1.1.0', modelTier: null }),
  'matching.judge': Object.freeze({ version: '1.0.0', modelTier: null }),
  'matching.import_records': Object.freeze({ version: '1.0.0', modelTier: null }),
})
/** The job kind of each method; `match_extract` is retired and kept so the rows stored under it keep reading. */
export const VCR_MATCH_BATCH_JOBS = Object.freeze({ match_extract: 'matching.extract', match_judge: 'matching.judge', records_import: 'matching.import_records' })
/** The local methods that call a model per record: they run on a worker loop of their own so that a long job does not hold the short ones. */
export const VCR_SLOW_LOCAL_METHODS = Object.freeze(['matching.judge', 'matching.import_records'])

/** What one judging job takes (`matching.judge`), whatever a deployment configures. */
export const VCR_MATCH_JUDGE_LIMITS = Object.freeze({
  /** The people of one job, a sanity bound on what its scenario holds: a mark per person lives in its checkpoint, and a study larger than this runs as several selections. */
  subjects: 50_000,
  /** The trials one person is judged against in one job. */
  trials: 500,
  /** The characters of a person's record one call reads; a longer record is split and judged per part. */
  noteChars: 60000,
  /** What the estimate assumes of a trial it has not fetched yet. A longer one costs what it costs; the ledger holds the actual spend. */
  trialChars: 12000,
  /** The instructions that ride with each call, in the estimate. */
  overheadTokens: 1500,
})

/** The originals one import names: a folder's files arrive as handles one by one, and each is only a few words in the scenario. */
export const VCR_RECORDS_IMPORT_INPUTS = 5000

/** The model the estimate is priced on when a deployment names none. */
export const VCR_MATCH_BATCH_DEFAULT_MODEL = 'deepseek-flash'

const ID = /^[A-Za-z0-9_-]{1,160}$/
const SUBJECT = /^[A-Za-z0-9_.:@-]{1,160}$/
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/

/**
 * The scenario of a batch job, held to its shape.
 * @param {string} method @param {Record<string, any>} scenario
 * @returns {Array<{ code: string, field: string, detail: string }>}
 */
export function validateMatchBatchScenario(method, scenario) {
  if (method === 'matching.judge') return validateMatchJudgeScenario(scenario)
  if (method === 'matching.import_records') return validateRecordsImportScenario(scenario)
  return [{ code: 'method_unknown', field: 'method', detail: 'Unknown batch matching method.' }]
}

/**
 * The scenario of a `records_import` job: handles of originals and what the caller said of them. No path and no file name: those stay with the receipt.
 * @param {Record<string, any>} scenario @returns {Array<{ code: string, field: string, detail: string }>}
 */
function validateRecordsImportScenario(scenario) {
  const problems = []
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => problems.push({ code: 'scenario_field_invalid', field: `scenario.${field}`, detail })
  for (const key of Object.keys(scenario)) if (!['mode', 'inputs', 'columns', 'format', 'name', 'chain', 'subjectKey'].includes(key)) problems.push({ code: 'scenario_field_unknown', field: `scenario.${key}`, detail: 'Unused scenario field.' })
  if (!['notes', 'standard', 'document'].includes(scenario.mode)) bad('mode', 'notes, standard or document.')
  // One conversation's attachment read into one person's record: nothing is proposed, and the person is known or new.
  if (scenario.mode === 'document' && scenario.inputs?.length !== 1) bad('inputs', 'One original.')
  if (scenario.subjectKey != null && (scenario.mode !== 'document' || typeof scenario.subjectKey !== 'string' || !SUBJECT.test(scenario.subjectKey))) bad('subjectKey', 'The pseudonym of the person a document joins.')
  if (!Array.isArray(scenario.inputs) || !scenario.inputs.length || scenario.inputs.length > VCR_RECORDS_IMPORT_INPUTS
    || scenario.inputs.some((entry) => typeof entry?.sourceId !== 'string' || !SUBJECT.test(entry.sourceId) || !Number.isSafeInteger(entry?.generation) || !/^[a-f0-9]{64}$/.test(String(entry?.sha256)))) bad('inputs', `One to ${VCR_RECORDS_IMPORT_INPUTS} original handles.`)
  if (scenario.mode === 'standard' && (scenario.inputs?.length !== 1 || !['fhir', 'omop', 'adam'].includes(scenario.format))) bad('format', 'One original and fhir, omop or adam.')
  if (scenario.columns != null && (typeof scenario.columns !== 'object' || Array.isArray(scenario.columns))) bad('columns', 'The columns the caller named.')
  return problems
}

/**
 * The scenario of a `match_judge` job, held to its shape. The platform freezes it from the selection and the study.
 * @param {Record<string, any>} scenario @returns {Array<{ code: string, field: string, detail: string }>}
 */
function validateMatchJudgeScenario(scenario) {
  const problems = []
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => problems.push({ code: 'scenario_field_invalid', field: `scenario.${field}`, detail })
  const allowed = ['direction', 'subjects', 'trials', 'protocolVersionId', 'collection', 'collectionRevision', 'fit', 'topK', 'thinking', 'thinkingCriteria', 'definitions', 'model', 'promptVersions', 'estimate', 'chain', 'followUp']
  for (const key of Object.keys(scenario)) if (!allowed.includes(key)) problems.push({ code: 'scenario_field_unknown', field: `scenario.${key}`, detail: 'Unused scenario field.' })
  for (const key of ['direction', 'subjects', 'fit', 'topK', 'thinking', 'model', 'promptVersions', 'estimate']) {
    if (scenario[key] == null) problems.push({ code: 'scenario_field_required', field: `scenario.${key}`, detail: 'Frozen by the platform from the selection.' })
  }
  if (scenario.direction != null && !['patient_to_trial', 'trial_to_patient'].includes(scenario.direction)) bad('direction', 'patient_to_trial or trial_to_patient.')
  if (scenario.subjects != null && (!Array.isArray(scenario.subjects) || !scenario.subjects.length || scenario.subjects.length > VCR_MATCH_JUDGE_LIMITS.subjects
    || scenario.subjects.some((entry) => typeof entry !== 'string' || !SUBJECT.test(entry)))) bad('subjects', `One to ${VCR_MATCH_JUDGE_LIMITS.subjects} pseudonymous subject keys.`)
  if (scenario.direction === 'patient_to_trial') {
    if (!Array.isArray(scenario.trials) || !scenario.trials.length || scenario.trials.length > VCR_MATCH_JUDGE_LIMITS.trials
      || scenario.trials.some((entry) => typeof entry?.registry !== 'string' || typeof entry?.registryId !== 'string' || !REGISTRY_ID.test(entry.registryId))) bad('trials', `One to ${VCR_MATCH_JUDGE_LIMITS.trials} registry records.`)
    if (Array.isArray(scenario.subjects) && scenario.subjects.length !== 1) bad('subjects', 'One person is judged against a list of trials.')
  }
  if (scenario.direction === 'trial_to_patient' && (typeof scenario.protocolVersionId !== 'string' || !ID.test(scenario.protocolVersionId))) bad('protocolVersionId', 'A protocol version of this study.')
  if (scenario.fit != null && typeof scenario.fit !== 'boolean') bad('fit', 'true or false.')
  if (scenario.topK != null && scenario.topK !== 'all' && !(Number.isInteger(scenario.topK) && scenario.topK >= 0)) bad('topK', 'A whole number, or all.')
  if (scenario.fit === false && scenario.topK === 0) bad('topK', 'A job with no trial-level stage judges criteria, so topK is above zero.')
  if (scenario.thinking != null && !['high', 'off'].includes(scenario.thinking)) bad('thinking', 'high or off.')
  if (scenario.thinkingCriteria != null && !['high', 'off'].includes(scenario.thinkingCriteria)) bad('thinkingCriteria', 'high or off.')
  if (scenario.definitions != null && scenario.definitions !== true) bad('definitions', 'true, or absent.')
  if (scenario.model != null && (typeof scenario.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scenario.model))) bad('model', 'A model name.')
  if (scenario.estimate != null && (typeof scenario.estimate !== 'object' || Array.isArray(scenario.estimate))) bad('estimate', 'The estimate stated before the job began.')
  if (scenario.chain != null && (typeof scenario.chain !== 'string' || !ID.test(scenario.chain))) bad('chain', 'An id.')
  if (scenario.followUp != null && (typeof scenario.followUp !== 'object' || Array.isArray(scenario.followUp))) bad('followUp', 'What a re-judgment follows.')
  return problems
}
