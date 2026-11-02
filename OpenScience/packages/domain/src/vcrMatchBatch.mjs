/**
 * Batch matching (remediation plan D4, 2026-11-01): reading a table-sized roster of patient records for the facts a protocol's
 * criteria ask about, one person at a time, with the cost said before it starts and the work resumable.
 *
 * What is language and what is not:
 *
 * - **The model reads** a record and proposes facts with their quotations (the server's extractor; the same fact contract and the
 *   same verbatim check as a fact a conversation writes).
 * - **Code decides** everything around it: who is read at all (a person whose table-held facts already decide the protocol against
 *   them is not read), who has been read (the ledger, so nothing is paid for twice), how many (a configured bound), what it will
 *   cost (this module, from the gateway's own token rule and the reference price list), and what the answer says of all that.
 *
 * Hidden knowledge:
 *
 * - **The estimate is a ceiling, not a forecast.** The input side counts every character of every unread record as one token — the
 *   gateway's own rule for Chinese, and three times the truth for English — plus the instructions that ride with each record; the
 *   output side is the per-record budget the extractor is allowed. The result then states what was actually read.
 * - **A person is read once.** The unit of work is a record (a person's document); a record whose bytes have been read for the same
 *   questions is not read again by a later start, a resumed job or a restart after a cancel. Failed records are not "done".
 * - **A prefilter is a statement, not a hidden drop.** Persons whose table-held facts decide the protocol against them
 *   (`ineligible` from the evaluator, no model involved) have their records left unread for this batch, and the statement counts
 *   them; they are still evaluated, from the table. The caller may switch the prefilter off and read everyone.
 *
 * @module @evimed/domain/vcrMatchBatch
 */

import { clinicalNumericValue } from './clinicalUnits.mjs'
import { priceUsage } from './metering.mjs'
import { suppressForModel } from './vcrSuppression.mjs'
import { VCR_MIN_CELL_SIZE } from './vcrVocabulary.mjs'

export const VCR_MATCH_BATCH_SCHEMA = 1

/** The one method, run by the control plane itself on the slow local lane (it calls a model per record). */
export const VCR_MATCH_BATCH_METHODS = Object.freeze({
  'matching.extract': Object.freeze({ version: '1.0.0', modelTier: null }),
})
export const VCR_MATCH_BATCH_JOBS = Object.freeze({ match_extract: 'matching.extract' })
/** The local methods that call a model per record: they run on a worker loop of their own so that a long job does not hold the short ones. */
export const VCR_SLOW_LOCAL_METHODS = Object.freeze(['matching.extract'])

export const VCR_MATCH_BATCH_LIMITS = Object.freeze({
  /** Hard ceiling of a roster in one job, whatever a deployment configures. */
  subjects: 5000,
  /** The most distinct variables one batch asks a record about. */
  variables: 120,
  /** The most a single record is read for, in characters (a longer one is read through the passages that bear on the criteria). */
  documentChars: 60000,
  /** The instructions and the variable list that ride with every record, in tokens: counted into the ceiling once per record. */
  overheadTokens: 1500,
  /** What one record's answer may take, in tokens: the output ceiling of a call and of the estimate. */
  outputTokens: 2000,
})

/** The model the estimate is priced on when a deployment names none. */
export const VCR_MATCH_BATCH_DEFAULT_MODEL = 'deepseek-flash'

const ID = /^[A-Za-z0-9_-]{1,160}$/
const VARIABLE = /^[a-z][a-z0-9_]{0,63}$/

/** @param {unknown} value */
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})
/** @param {unknown} value */
const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0)

/**
 * The scenario of a `match_extract` job, held to its shape. The platform freezes it (the roster, the variables and the estimate are
 * read from the study, never typed), so this is the contract the executor relies on.
 * @param {string} method @param {Record<string, any>} scenario
 * @returns {Array<{ code: string, field: string, detail: string }>}
 */
export function validateMatchBatchScenario(method, scenario) {
  if (!Object.hasOwn(VCR_MATCH_BATCH_METHODS, method)) return [{ code: 'method_unknown', field: 'method', detail: 'Unknown batch matching method.' }]
  const problems = []
  const bad = (/** @type {string} */ field, /** @type {string} */ detail) => problems.push({ code: 'scenario_field_invalid', field: `scenario.${field}`, detail })
  const allowed = ['protocolVersionId', 'asOf', 'subjects', 'variables', 'estimate', 'chain', 'prefilter', 'prefiltered', 'model']
  for (const key of Object.keys(scenario)) if (!allowed.includes(key)) problems.push({ code: 'scenario_field_unknown', field: `scenario.${key}`, detail: 'Unused scenario field.' })
  for (const key of ['protocolVersionId', 'asOf', 'subjects', 'variables', 'estimate']) {
    if (scenario[key] == null) problems.push({ code: 'scenario_field_required', field: `scenario.${key}`, detail: 'Frozen by the platform from the study.' })
  }
  if (scenario.protocolVersionId != null && (typeof scenario.protocolVersionId !== 'string' || !ID.test(scenario.protocolVersionId))) bad('protocolVersionId', 'A protocol version of this study.')
  if (scenario.asOf != null && !(typeof scenario.asOf === 'string' && Number.isFinite(Date.parse(scenario.asOf)))) bad('asOf', 'An ISO instant.')
  for (const key of ['subjects', 'prefiltered']) {
    const list = scenario[key]
    if (list == null) continue
    if (!Array.isArray(list) || list.length > VCR_MATCH_BATCH_LIMITS.subjects || list.some((entry) => typeof entry !== 'string' || !ID.test(entry))) bad(key, `At most ${VCR_MATCH_BATCH_LIMITS.subjects} pseudonymous subject keys.`)
  }
  if (Array.isArray(scenario.subjects) && scenario.subjects.length === 0) bad('subjects', 'A batch reads at least one person.')
  if (scenario.variables != null && (!Array.isArray(scenario.variables) || !scenario.variables.length || scenario.variables.length > VCR_MATCH_BATCH_LIMITS.variables
    || scenario.variables.some((entry) => typeof entry !== 'string' || !VARIABLE.test(entry)))) bad('variables', `One to ${VCR_MATCH_BATCH_LIMITS.variables} variable names in the criteria's own spelling.`)
  if (scenario.estimate != null && (typeof scenario.estimate !== 'object' || Array.isArray(scenario.estimate))) bad('estimate', 'The estimate stated before the batch began.')
  if (scenario.chain != null && (typeof scenario.chain !== 'string' || !ID.test(scenario.chain))) bad('chain', 'An id.')
  if (scenario.prefilter != null && typeof scenario.prefilter !== 'boolean') bad('prefilter', 'true or false.')
  if (scenario.model != null && (typeof scenario.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(scenario.model))) bad('model', 'A model name.')
  return problems
}

/**
 * The unit of work and its ledger key: a record read for these variables. The key does not name the job, the model or the time — a
 * record read once for these questions stays read.
 * @param {string} subjectKey @param {string} documentId
 */
export const matchBatchUnitKey = (subjectKey, documentId) => `${subjectKey}\u0000${documentId}`

/**
 * What a batch will read and what it will cost, from the roster alone (nothing is read to make it).
 *
 * @param {{
 *   roster: ReadonlyArray<{ subjectKey: string, documents: ReadonlyArray<{ id: string, chars: number }>, decided?: boolean }>,
 *   done?: ReadonlySet<string> | null,
 *   limit: number,
 *   prefilter?: boolean,
 *   model?: string,
 *   at?: Date,
 *   peak?: boolean,
 *   answeredByTable?: readonly string[],
 * }} input `done` holds `matchBatchUnitKey`s already read for these variables; `decided` marks a person whose table-held facts already decide the protocol against them
 */
export function planMatchExtraction({ roster, done = null, limit, prefilter = true, model = VCR_MATCH_BATCH_DEFAULT_MODEL, peak = true, answeredByTable = [] }) {
  const bound = Math.max(1, Math.min(VCR_MATCH_BATCH_LIMITS.subjects, count(limit) || VCR_MATCH_BATCH_LIMITS.subjects))
  /** @type {Array<{ subjectKey: string, documents: Array<{ id: string, chars: number }> }>} */
  const toRead = []
  /** @type {string[]} */ const prefiltered = []
  /** @type {string[]} */ const noDocuments = []
  /** @type {string[]} */ const alreadyRead = []
  /** @type {string[]} */ const deferred = []
  const seen = new Set()
  for (const entry of roster) {
    const subjectKey = String(entry.subjectKey)
    if (seen.has(subjectKey)) continue
    seen.add(subjectKey)
    const documents = (entry.documents ?? []).filter((doc) => doc && typeof doc.id === 'string' && doc.id)
    if (!documents.length) { noDocuments.push(subjectKey); continue }
    if (prefilter && entry.decided === true) { prefiltered.push(subjectKey); continue }
    const unread = documents.filter((doc) => !done?.has(matchBatchUnitKey(subjectKey, doc.id)))
    if (!unread.length) { alreadyRead.push(subjectKey); continue }
    if (toRead.length >= bound) { deferred.push(subjectKey); continue }
    // A record whose length the plane did not note is counted at the per-record cap: the estimate is a ceiling.
    toRead.push({ subjectKey, documents: unread.map((doc) => ({ id: String(doc.id), chars: count(doc.chars) || VCR_MATCH_BATCH_LIMITS.documentChars })) })
  }
  const records = toRead.reduce((sum, entry) => sum + entry.documents.length, 0)
  const chars = toRead.reduce((sum, entry) => sum + entry.documents.reduce((inner, doc) => inner + Math.min(doc.chars, VCR_MATCH_BATCH_LIMITS.documentChars), 0), 0)
  const inputTokens = chars + records * VCR_MATCH_BATCH_LIMITS.overheadTokens
  const outputTokens = records * VCR_MATCH_BATCH_LIMITS.outputTokens
  const priced = priceUsage({ resourceType: 'model', model, cacheHit: 0, cacheMiss: inputTokens, output: outputTokens, peak })
  const estimate = {
    schema: VCR_MATCH_BATCH_SCHEMA, basis: 'ceiling', model,
    people: toRead.length, records, characters: chars, inputTokens, outputTokens,
    cost: priced.priced ? priced.cost : null, currency: priced.currency || 'CNY',
  }
  return {
    toRead, prefiltered, noDocuments, alreadyRead, deferred,
    answeredByTable: [...answeredByTable],
    estimate,
    bounded: deferred.length ? { limit: bound, deferred: deferred.length } : null,
  }
}

/** @param {number} value */
const wan = (value) => (value >= 10000 ? `${Math.round(value / 1000) / 10} 万` : String(value))

/**
 * The sentence the start answer opens with: what will be read, what it will cost at most, what will not be read and why, and that
 * the work can be stopped and started again without paying twice. No confirmation is asked for; it has already begun.
 *
 * The sentence is a model's to read, so its head counts are the model boundary's: the people to read, the ones read before, the ones
 * the table already decided against, the ones with no record and the ones that wait are each judged as the batch counters are
 * (`suppressForModel`, the `plan` block). A count it hides is not printed and one sentence says that some are not shown; a category
 * whose count is shown as zero is not mentioned.
 * @param {ReturnType<typeof planMatchExtraction>} plan @param {{ minCell?: number }} [options]
 */
export function matchBatchStatement(plan, { minCell = VCR_MIN_CELL_SIZE } = {}) {
  const { estimate: e } = plan
  const shown = suppressForModel({ plan: { toRead: e.people, alreadyRead: plan.alreadyRead.length, prefiltered: plan.prefiltered.length,
    noDocuments: plan.noDocuments.length, deferred: plan.deferred.length }, estimate: { people: e.people, records: e.records } }, { minCell })
  const cells = shown.plan
  const aside = Object.values(cells).some((value) => value === null) || shown.estimate.records === null ? '人数少的类别按小样本规则不显示具体人数。' : ''
  if (!e.people) {
    const parts = []
    if (cells.alreadyRead) parts.push(`${cells.alreadyRead} 位的病历已经读过，不会重读`)
    if (cells.prefiltered) parts.push(`${cells.prefiltered} 位按表格里已知的信息已确定不符合，病历不读`)
    if (cells.noDocuments) parts.push(`${cells.noDocuments} 位没有病历文档`)
    return `这一批没有要读的病历${parts.length ? `：${parts.join('；')}` : ''}。${aside}可以直接做逐条评估。`
  }
  const cost = e.cost == null ? '费用按当前价格表算不出' : `最多约 ${e.cost.toFixed(2)} 元`
  const lines = [
    `${cells.toRead === null ? '这一批要读的病历（人数不显示）' : `这一批要读 ${cells.toRead} 位病人${shown.estimate.records === null ? '的病历' : `的 ${e.records} 份病历`}`}，预计最多 ${wan(e.inputTokens)} 个输入词元、${wan(e.outputTokens)} 个输出词元，${cost}`
      + `（输入按每个字一个词元、外加每份病历的指令估，是上限，实际通常更低；做完会写出实际读了多少）。`,
  ]
  const skipped = []
  if (cells.alreadyRead) skipped.push(`${cells.alreadyRead} 位读过的不会重读`)
  if (cells.prefiltered) skipped.push(`${cells.prefiltered} 位按表格里已知的信息已确定不符合，病历不读（仍会评估）`)
  if (cells.noDocuments) skipped.push(`${cells.noDocuments} 位没有病历文档`)
  if (skipped.length) lines.push(`不读的：${skipped.join('；')}。`)
  if (plan.answeredByTable.length) lines.push(`表格里已有的变量不再问病历：${plan.answeredByTable.slice(0, 12).join('、')}${plan.answeredByTable.length > 12 ? '等' : ''}。`)
  if (plan.bounded) lines.push(`一批最多读 ${plan.bounded.limit} 位，${cells.deferred === null ? '还有一些' : `还有 ${cells.deferred} 位`}这次没排进来：这一批读完后再启动同样的选择，会接着读剩下的。`)
  if (aside) lines.push(aside)
  lines.push('已经开始，不用确认。中途取消，读完的保留；再启动同样的选择会接着读没读过的。读完会通知；之后再做逐条评估。')
  return lines.join('')
}

/**
 * The per-record answer of the extractor, held to the closed vocabulary before anything is written: a variable the criteria never
 * asked about, a polarity outside the list, or a quotation that is not a string is dropped here and counted by reason; what survives
 * is handed to the fact writer, which checks every quotation against the record's own bytes.
 * @param {unknown} answer the parsed JSON of the model's reply
 * @param {ReadonlySet<string>} variables the variables the criteria use
 * @returns {{ facts: Array<Record<string, any>>, dropped: Record<string, number> }}
 */
export function acceptExtractedFacts(answer, variables) {
  const list = Array.isArray(object(answer).facts) ? object(answer).facts : []
  /** @type {Record<string, number>} */
  const dropped = {}
  const drop = (/** @type {string} */ reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1 }
  /** @type {Array<Record<string, any>>} */
  const facts = []
  for (const raw of list.slice(0, 200)) {
    const row = object(raw)
    const variable = typeof row.variable === 'string' ? row.variable.trim() : ''
    if (!variables.has(variable)) { drop('variable_not_asked'); continue }
    const polarity = row.polarity == null ? 'affirmed' : row.polarity
    if (!['affirmed', 'negated', 'hypothetical', 'family'].includes(String(polarity))) { drop('polarity_invalid'); continue }
    const quote = typeof row.quote === 'string' ? row.quote : ''
    const surface = typeof row.surface === 'string' && row.surface ? row.surface : ''
    if (!quote.trim() || !surface || !quote.includes(surface)) { drop('quote_missing'); continue }
    const item = /** @type {Record<string, any>} */ ({ variable, polarity, surface: surface.slice(0, 400), quote: quote.slice(0, 3000) })
    // A value that is a plain number is the number whatever the model typed it as: the writer holds it to the quotation as one, and the
    // evaluator reads it as one (`clinicalNumericValue`); only a text value stays text.
    const numeric = clinicalNumericValue(row.value)
    if (numeric !== null) item.value = numeric
    else if (typeof row.value === 'string' && row.value.trim() && row.value.length <= 200) item.value = row.value.trim()
    if (typeof row.unit === 'string' && row.unit.trim() && row.unit.length <= 40) item.unit = row.unit.trim()
    if (typeof row.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.occurredAt)) item.occurredAt = row.occurredAt
    if (typeof row.dateSurface === 'string' && row.dateSurface.trim() && row.dateSurface.length <= 80) item.dateSurface = row.dateSurface.trim()
    // A second quotation of the same record that prints the date whole: kept as written, because the writer finds it word for word.
    if (typeof row.dateQuote === 'string' && row.dateQuote.trim() && row.dateQuote.length <= 200) item.dateQuote = row.dateQuote
    facts.push(item)
  }
  return { facts, dropped }
}
