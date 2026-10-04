/**
 * Dataset semantics: what a researcher's tables MEAN, kept apart from what is
 * in them (plan 2026-10-02 §11.3 N03).
 *
 * A dataset a project holds is read once, understood once, and then analysed
 * many times — by `dataset-research-scoping`, by `statistical-analysis`, by a
 * follow-up that arrives a week later with a second delivery of the same
 * extract. Until now each of those started from the bytes and inferred the
 * meaning again, so the same column was a creatinine in µmol/L on Monday and an
 * unknown number on Thursday, and nothing could say that the second delivery had
 * changed under the analysis. This module is the contract of the thing that
 * remembers: a small, version-bound record of the meaning of the data, in the
 * shape the 虚拟临研 field map already proved (a column, its role, unit, coding,
 * missing reason, time kind and value source), generalised to ordinary projects.
 *
 * What the asset holds, and what it never holds:
 *
 * - **Meaning, as facts with a basis.** Every semantic field is a `Fact`:
 *   `{ value, basis, via, at, … }`. The basis is one of three, ranked —
 *   `researcher_confirmed` (the researcher said so; the words are kept),
 *   `dictionary_stated` (a data dictionary the researcher supplied says so; the
 *   file is named), `model_inferred` (the model read it off names and values;
 *   what it read is named). A weaker basis never overwrites a stronger one: it is
 *   kept beside it as a contested statement, because "the data looks like mg/dL"
 *   is information about a column the researcher called mmol/L, not a correction
 *   of it.
 * - **The exact source versions the meaning was read from** — a content hash per
 *   table, with an aggregate profile of each column. Aggregates only, and no
 *   aggregate small enough to be a person: a numeric summary exists only for a
 *   column of at least `VCR_MIN_CELL_SIZE` values, and no profile holds a value
 *   (a code list is an `allowedValues` fact instead). There is no patient row in the asset
 *   and no patient-data store behind it; the rows stay in the runtime's
 *   workspace, where the deterministic checks read them.
 * - **Transformations**, versioned: a derived variable or a filter is recorded
 *   with its inputs and the hash of the code that made it, so a repeat analysis
 *   applies the same thing or is told exactly what changed.
 * - **The last check's findings**, as named outcomes with counts and row numbers
 *   — never values and never keys.
 *
 * Provenance vocabulary: a variable's *value source* is the 虚拟临研 one
 * (`VCR_COLUMN_SOURCES`: observed / extracted / calculated / imputed, the four
 * a column of a real person's table may carry), reused rather than restated, and
 * the missing reasons and time kinds are the same lists. The three bases above
 * answer a different question — who vouches for the *meaning* — and the two never
 * stand in for each other: an imputed column can be confirmed by the researcher.
 *
 * Nothing here gates anything. A finding is information with a name; no outcome
 * withholds a result or refuses an operation, and an outcome that could not be
 * computed says `not_checked` with the reason instead of reading as clean.
 *
 * Pure: no clock (the caller passes `now`), no hashing (the control plane hashes
 * with `node:crypto`; this package is browser-safe), no I/O.
 *
 * @module @evimed/domain/dataSemantics
 */

import { canonicalJson } from './capsule.mjs'
import { VCR_COLUMN_SOURCES, VCR_MIN_CELL_SIZE, VCR_MISSING_REASONS, VCR_TIME_KINDS } from './vcrVocabulary.mjs'

/** @param {readonly string[]} list */
const frozen = (list) => Object.freeze([...list])

export const DATA_SEMANTICS_SCHEMA_VERSION = 1
/** The product-ledger kind one asset is stored under (`evimed_product.documents`). */
export const DATA_SEMANTICS_KIND = 'dataset-semantics'

// ---------------------------------------------------------------------------
// Basis: who vouches for a meaning
// ---------------------------------------------------------------------------

/** Who vouches for a fact, strongest first. */
export const SEMANTIC_BASES = frozen(['researcher_confirmed', 'dictionary_stated', 'model_inferred'])
export const SEMANTIC_BASIS_LABELS_ZH = Object.freeze({
  researcher_confirmed: '你已确认', dictionary_stated: '数据字典所述', model_inferred: '模型推断',
})
/** @type {Readonly<Record<string, number>>} */
const BASIS_RANK = Object.freeze({ model_inferred: 1, dictionary_stated: 2, researcher_confirmed: 3 })
/**
 * Where the basis was asserted: in the conversation (the run wrote down what the
 * researcher said, quoting it) or on the files page (the researcher pressed the
 * button themselves). Recorded so a reader can tell the two apart.
 */
export const SEMANTIC_VIAS = frozen(['conversation', 'page'])

/**
 * A variable's value source is the 虚拟临研 column-source vocabulary, not a new
 * one: how the values of the column came to be (`observed`, `extracted`,
 * `calculated`, `imputed`).
 */
export const DATA_VALUE_SOURCES = VCR_COLUMN_SOURCES
/** What a column's values may be declared to be: the profiler's `infer_type` vocabulary less `empty`. */
export const DATA_VARIABLE_TYPES = frozen(['integer', 'number', 'date', 'text'])
/** What a variable is for in an analysis. Closed; `identifier` columns never have values recorded. */
export const DATA_VARIABLE_ROLES = frozen(['identifier', 'time', 'exposure', 'outcome', 'covariate', 'other'])
export const DATA_VARIABLE_ROLE_LABELS_ZH = Object.freeze({
  identifier: '标识', time: '时间', exposure: '暴露或分组', outcome: '结局', covariate: '协变量', other: '其他',
})
/** A join's declared multiplicity, left to right: rows of the left table per key, then rows of the right. */
export const DATA_JOIN_CARDINALITIES = frozen(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'])
export const DATA_JOIN_CARDINALITY_LABELS_ZH = Object.freeze({
  one_to_one: '一对一', one_to_many: '一对多', many_to_one: '多对一', many_to_many: '多对多',
})
/** What a recorded transformation is. */
export const DATA_TRANSFORM_KINDS = frozen(['derive', 'filter', 'join', 'recode', 'dedupe', 'aggregate', 'other'])
export const DATA_TRANSFORM_KIND_LABELS_ZH = Object.freeze({
  derive: '派生变量', filter: '筛选', join: '关联', recode: '重编码', dedupe: '去重', aggregate: '汇总', other: '其他',
})

/** The facets of one variable, and of one table, a fact can be about. */
export const DATA_VARIABLE_FACETS = frozen([
  'definition', 'type', 'unit', 'codeSystem', 'allowedValues', 'range', 'missingness', 'role', 'measuredAt', 'valueSource', 'aliases',
])
export const DATA_TABLE_FACETS = frozen(['observationUnit', 'subjectKey', 'observationKey'])
/** The facets of the dataset as a whole: who is in it and over what period. */
export const DATA_DATASET_FACETS = frozen(['population', 'timeWindow'])
export const DATA_FACET_LABELS_ZH = Object.freeze({
  definition: '定义', type: '类型', unit: '单位', codeSystem: '编码体系', allowedValues: '取值范围或编码', range: '合理范围',
  missingness: '缺失编码', role: '作用', measuredAt: '测量时间', valueSource: '数值来源', aliases: '曾用列名',
  observationUnit: '观察单位', subjectKey: '受试者标识列', observationKey: '一条观察的标识列',
  population: '研究人群', timeWindow: '时间窗', cardinality: '关联基数',
})

/**
 * What a record may hold. The asset is one product-ledger document and the
 * ledger bounds a document at 256 KiB; these bounds keep a realistic extract
 * (a few hundred columns over a few tables) inside it, and `fitAsset` refuses
 * the rest by name instead of letting the ledger refuse it by size.
 */
export const DATA_SEMANTICS_LIMITS = Object.freeze({
  tables: 20, variables: 300, joins: 40, transformations: 60, history: 20, denominators: 50, columnsProfiled: 300,
  datasetsPerProject: 50, assetBytes: 240_000,
})

/**
 * What the checks consider "beyond bounds" for information-level drift, stated
 * once so a finding can say which bound it crossed. A shift is information, not
 * a verdict: these decide what is worth mentioning, never what is wrong.
 */
export const DATA_DRIFT_BOUNDS = Object.freeze({
  /** The median moved by more than this many interquartile ranges of the previous delivery. */
  medianShiftIqr: 1,
  /** The median changed by more than this factor (either direction): a different scale, often a different unit. */
  scaleRatio: 2,
  /** The share of missing values moved by more than this (absolute). */
  missingRateDelta: 0.1,
  /** A numeric summary or a vocabulary is recorded only from at least this many values (the 虚拟临研 small-cell floor). */
  minCell: VCR_MIN_CELL_SIZE,
  /** A column's observed values are offered as a code list only up to this many distinct values. */
  vocabularyMax: 30,
  /** At most this many example rows or keys per finding. */
  sampleRows: 20,
})

// ---------------------------------------------------------------------------
// The checks' vocabulary: what a deterministic check can answer
// ---------------------------------------------------------------------------

export const DATA_CHECK_FAMILIES = frozen(['drift', 'duplicates', 'joins', 'denominators', 'leakage', 'transformations'])
export const DATA_CHECK_FAMILY_LABELS_ZH = Object.freeze({
  drift: '数据变化', duplicates: '重复观察', joins: '表间关联', denominators: '分母变化', leakage: '时间泄漏', transformations: '变换版本',
})
/** `attention`: worth a decision before leaning on a result. `information`: worth knowing. Neither stops anything. */
export const DATA_CHECK_SEVERITIES = frozen(['attention', 'information'])

/**
 * Every named outcome a check can report, with its family, its default
 * severity and the sentence a reader sees. Closed: the tool holds a copy that a
 * test reads against this one.
 */
export const DATA_CHECK_OUTCOMES = Object.freeze({
  source_unchanged: { family: 'drift', severity: 'information', zh: '数据文件与已记录的版本一致' },
  source_changed: { family: 'drift', severity: 'information', zh: '数据文件已不是已记录的版本' },
  table_added: { family: 'drift', severity: 'attention', zh: '出现了没有记录过的表' },
  table_removed: { family: 'drift', severity: 'attention', zh: '已记录的表没有对应的文件' },
  column_added: { family: 'drift', severity: 'information', zh: '新增了列' },
  column_removed: { family: 'drift', severity: 'attention', zh: '少了已记录的列' },
  column_renamed_known: { family: 'drift', severity: 'information', zh: '列名已更换，与记录的曾用名一致' },
  column_renamed_candidate: { family: 'drift', severity: 'attention', zh: '少了一列又多了一列，很可能是改了名' },
  type_changed: { family: 'drift', severity: 'attention', zh: '列的类型变了' },
  unit_changed: { family: 'drift', severity: 'attention', zh: '列标注的单位变了' },
  possible_unit_change: { family: 'drift', severity: 'attention', zh: '数值整体放大或缩小，像是换了单位' },
  new_codes: { family: 'drift', severity: 'attention', zh: '出现了没有记录过的编码' },
  codes_not_seen: { family: 'drift', severity: 'information', zh: '已记录的编码这次没有出现' },
  distribution_shift: { family: 'drift', severity: 'information', zh: '取值分布超出了设定的变化范围' },
  missingness_shift: { family: 'drift', severity: 'information', zh: '缺失比例变化超出了设定的范围' },
  undeclared_missing_tokens: { family: 'drift', severity: 'attention', zh: '数值列里有没有声明的缺失标记' },
  duplicate_exact: { family: 'duplicates', severity: 'attention', zh: '同一观察出现了完全相同的重复行' },
  duplicate_conflicting: { family: 'duplicates', severity: 'attention', zh: '同一观察出现了内容不同的多行' },
  join_cardinality_violation: { family: 'joins', severity: 'attention', zh: '关联的实际基数与声明不符' },
  join_orphans: { family: 'joins', severity: 'attention', zh: '关联中有找不到对应行的键' },
  join_key_invalid: { family: 'joins', severity: 'attention', zh: '关联键本身有问题' },
  denominator_increase: { family: 'denominators', severity: 'attention', zh: '后一步的分母比前一步还大' },
  denominator_decrease: { family: 'denominators', severity: 'information', zh: '两步之间分母减少了' },
  denominator_changed: { family: 'denominators', severity: 'attention', zh: '同一步的分母与上次记录的不同' },
  temporal_leakage: { family: 'leakage', severity: 'attention', zh: '有预测因子是在截止时间之后测的' },
  transformation_code_changed: { family: 'transformations', severity: 'attention', zh: '变换的代码与记录的版本不同' },
  transformation_code_missing: { family: 'transformations', severity: 'attention', zh: '变换记录的代码文件找不到了' },
})
export const DATA_CHECK_OUTCOME_IDS = frozen(Object.keys(DATA_CHECK_OUTCOMES))

/**
 * Why a check did not run — a check that did not run never reads as clean, so
 * this is a value of its own with a reason.
 */
export const DATA_CHECK_NOT_CHECKED_REASONS = Object.freeze({
  no_asset: '这个项目还没有记录这份数据的含义',
  file_unreadable: '文件打不开或不是支持的表格',
  file_too_large: '文件超过了可检查的大小',
  format_unsupported: '这种文件格式暂不能检查',
  table_unmatched: '没有对上已记录的表',
  no_baseline: '没有可以对照的上一版本',
  observation_key_undeclared: '没有声明一条观察由哪些列标识',
  key_column_missing: '标识列在文件里找不到',
  join_table_unavailable: '关联的另一张表没有提供',
  measurement_time_undeclared: '没有声明预测因子的测量时间列',
  cutoff_undeclared: '没有给出截止时间列',
  time_unparseable: '时间列的取值读不成日期',
  too_few_values: '取值太少，不记录汇总',
})
export const DATA_CHECK_NOT_CHECKED_REASON_IDS = frozen(Object.keys(DATA_CHECK_NOT_CHECKED_REASONS))

/** The gateway's and the tool's failure codes: all of them leave the conversation going. */
export const DATA_SEMANTICS_ERROR_CODES = frozen([
  'semantics_disabled', 'semantics_unconfigured', 'semantics_unavailable', 'semantics_gateway_unreachable',
  'semantics_gateway_token_missing', 'semantics_gateway_token_invalid', 'semantics_rate_limited',
  'semantics_response_invalid', 'semantics_response_too_large', 'semantics_upstream_error',
  'semantics_request_invalid', 'semantics_request_too_large', 'semantics_dataset_invalid', 'semantics_asset_not_found',
  'semantics_asset_too_large', 'semantics_too_many_datasets', 'semantics_revision_conflict',
])
export const DATA_SEMANTICS_ERROR_MESSAGE_ZH = '数据含义的记录这次没能完成；分析会照常继续，只是这次没有读取或写入已记录的含义。'

// ---------------------------------------------------------------------------
// Small shared validators
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** Whether a string holds a control character — spelled without a regex, which the linter reads as a mistake. @param {string} value */
const hasControl = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
/**
 * A trimmed one-line string within a length, or null.
 * @param {unknown} value @param {number} max @returns {string | null}
 */
function asText(value, max) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && [...text].length <= max && !hasControl(text) ? text : null
}
/** @param {unknown} value @param {number} max @returns {string[] | null} unique column names, at least one */
function asColumns(value, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null
  const names = value.map((item) => asText(item, 128))
  if (names.some((name) => name === null)) return null
  return [...new Set(/** @type {string[]} */ (names))]
}
const DATASET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** @param {unknown} value */
export const isDatasetId = (value) => typeof value === 'string' && DATASET_ID.test(value)
const SHA256 = /^[a-f0-9]{64}$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/** @param {unknown} value */
const isIsoDay = (value) => typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

/**
 * A workspace-relative path: no leading slash, no backslash, no empty or dot
 * segments. Names a file the tool read, never one the control plane opens.
 * @param {unknown} value @returns {string | null}
 */
export function asWorkspacePath(value) {
  const text = asText(value, 512)
  if (!text || text.startsWith('/') || text.includes('\\')) return null
  return text.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : text
}

// ---------------------------------------------------------------------------
// Facets: what each semantic field's value may be
// ---------------------------------------------------------------------------

/** @typedef {{ ok: true, value: any } | { ok: false, message: string }} FacetResult */
/** @param {any} value @returns {FacetResult} */
const ok = (value) => ({ ok: true, value })
/** @param {string} message @returns {FacetResult} */
const bad = (message) => ({ ok: false, message })
/** @param {readonly string[]} list @param {string} what @returns {(value: unknown) => FacetResult} */
const oneOf = (list, what) => (value) => (typeof value === 'string' && list.includes(value) ? ok(value) : bad(`${what} is one of: ${list.join(', ')}.`))
/** @param {number} max @param {string} what @returns {(value: unknown) => FacetResult} */
const textOf = (max, what) => (value) => {
  const text = asText(value, max)
  return text ? ok(text) : bad(`${what} is one line of text, at most ${max} characters.`)
}
/** @param {number} max @param {string} what @returns {(value: unknown) => FacetResult} */
const columnsOf = (max, what) => (value) => {
  const names = asColumns(value, max)
  return names ? ok(names) : bad(`${what} is a list of 1 to ${max} column names.`)
}

/** @type {Record<string, (value: unknown) => FacetResult>} */
const FACET_RULES = {
  // table
  observationUnit: textOf(200, 'An observation unit'),
  subjectKey: columnsOf(6, 'A subject key'),
  observationKey: columnsOf(6, 'An observation key'),
  // variable
  definition: textOf(400, 'A definition'),
  type: oneOf(DATA_VARIABLE_TYPES, 'A type'),
  // `null` is a statement: this variable has no unit (a count, a code), which is different from not knowing it.
  unit: (value) => {
    if (value === null) return ok(null)
    const text = asText(value, 32)
    return text ? ok(text) : bad('A unit is at most 32 characters, or null when the variable has none.')
  },
  codeSystem: textOf(40, 'A code system'),
  allowedValues: (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200) return bad('Allowed values are a list of 1 to 200 codes.')
    /** @type {{ code: string, label?: string }[]} */
    const entries = []
    const seen = new Set()
    for (const item of value) {
      const raw = isRecord(item) ? item.code : item
      const code = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : asText(raw, 40)
      if (!code) return bad('A code is text of at most 40 characters.')
      if (seen.has(code)) continue
      seen.add(code)
      if (isRecord(item) && item.label != null) {
        const label = asText(item.label, 80)
        if (!label) return bad('A code label is at most 80 characters.')
        entries.push({ code, label })
      } else entries.push({ code })
    }
    return ok(entries)
  },
  range: (value) => (Array.isArray(value) && value.length === 2 && value.every((bound) => typeof bound === 'number' && Number.isFinite(bound)) && value[0] <= value[1]
    ? ok([value[0], value[1]]) : bad('A range is [lower, upper], two finite numbers with lower not above upper.')),
  missingness: (value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['tokens', 'reason'].includes(key))) return bad('Missingness is { tokens, reason? }.')
    const tokens = Array.isArray(value.tokens) ? value.tokens : []
    if (tokens.length > 10 || tokens.some((token) => asText(typeof token === 'number' ? String(token) : token, 20) === null)) return bad('Missing tokens are at most 10 short strings.')
    const reason = value.reason == null || value.reason === '' ? null : value.reason
    if (reason !== null && !VCR_MISSING_REASONS.includes(reason)) return bad(`A missing reason is one of: ${VCR_MISSING_REASONS.join(', ')}.`)
    return ok({ tokens: [...new Set(tokens.map((token) => String(token).trim()))], reason })
  },
  role: oneOf(DATA_VARIABLE_ROLES, 'A role'),
  // Which column of the same table says when this variable was measured.
  measuredAt: (value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['column', 'timeKind'].includes(key))) return bad('A measurement time is { column, timeKind? }.')
    const column = asText(value.column, 128)
    if (!column) return bad('A measurement time names a column.')
    if (value.timeKind != null && !VCR_TIME_KINDS.includes(value.timeKind)) return bad(`A time kind is one of: ${VCR_TIME_KINDS.join(', ')}.`)
    return ok({ column, timeKind: value.timeKind ?? 'occurred_at' })
  },
  valueSource: oneOf(DATA_VALUE_SOURCES, 'A value source'),
  aliases: columnsOf(10, 'Former column names'),
  // dataset
  population: textOf(400, 'A population'),
  timeWindow: (value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !['start', 'end', 'note'].includes(key))) return bad('A time window is { start?, end?, note? }.')
    for (const key of ['start', 'end']) if (value[key] != null && !isIsoDay(value[key])) return bad('A window bound is a date, YYYY-MM-DD.')
    if (value.start == null && value.end == null) return bad('A time window has a start or an end.')
    if (value.start != null && value.end != null && value.start > value.end) return bad('A window starts no later than it ends.')
    if (value.note != null && !asText(value.note, 200)) return bad('A window note is at most 200 characters.')
    return ok({ ...(value.start != null ? { start: value.start } : {}), ...(value.end != null ? { end: value.end } : {}), ...(value.note != null ? { note: asText(value.note, 200) } : {}) })
  },
  cardinality: oneOf(DATA_JOIN_CARDINALITIES, 'A cardinality'),
}

// ---------------------------------------------------------------------------
// Facts and their merge
// ---------------------------------------------------------------------------

/**
 * @typedef {{ value: any, basis: string, via: string, at: string, statement?: string,
 *   statedIn?: { path: string, sha256?: string }, inferredFrom?: string[],
 *   supersedes?: { value: any, basis: string, at: string },
 *   contested?: { value: any, basis: string, at: string, inferredFrom?: string[] }[] }} SemanticFact
 */

/** @param {unknown} basis */
export const semanticBasisRank = (basis) => BASIS_RANK[String(basis)] ?? 0

/**
 * Fold one incoming fact into the current one.
 *
 * - nothing there: `applied`;
 * - the same value: kept, and `upgraded` when the incoming basis is stronger
 *   (a researcher confirming what the model inferred is the usual case — and
 *   what the model inferred is now confirmed, not replaced);
 * - a different value from an equal or stronger basis: `applied` (`corrected`
 *   when it is a researcher replacing their own earlier word); the old value is
 *   kept one level deep as `supersedes`;
 * - a different value from a weaker basis: **not applied** — `kept_stronger`.
 *   The statement is kept as `contested` (at most three) so the disagreement is
 *   visible, and a later inference never overwrites a confirmed fact.
 * @param {SemanticFact | null | undefined} current @param {SemanticFact} incoming
 * @returns {{ fact: SemanticFact, outcome: 'applied' | 'unchanged' | 'upgraded' | 'corrected' | 'kept_stronger', keptBasis?: string }}
 */
export function mergeFact(current, incoming) {
  if (!current) return { fact: incoming, outcome: 'applied' }
  const same = canonicalJson(current.value) === canonicalJson(incoming.value)
  const have = semanticBasisRank(current.basis)
  const come = semanticBasisRank(incoming.basis)
  if (same) {
    if (come > have) return { fact: incoming, outcome: 'upgraded' }
    return { fact: current, outcome: 'unchanged' }
  }
  if (come >= have) {
    /** @type {SemanticFact} */
    const fact = { ...incoming, supersedes: { value: current.value, basis: current.basis, at: current.at } }
    return { fact, outcome: have === 3 && come === 3 ? 'corrected' : 'applied' }
  }
  const contested = [
    ...(current.contested ?? []).filter((entry) => canonicalJson(entry.value) !== canonicalJson(incoming.value)),
    { value: incoming.value, basis: incoming.basis, at: incoming.at, ...(incoming.inferredFrom ? { inferredFrom: incoming.inferredFrom } : {}) },
  ].slice(-3)
  return { fact: { ...current, contested }, outcome: 'kept_stronger', keptBasis: current.basis }
}

/**
 * @typedef {{ basis: string, via: string, at: string, statement?: string,
 *   statedIn?: { path: string, sha256?: string }, inferredFrom?: string[] }} Provenance
 */

/**
 * The provenance one patch carries, checked against what its basis requires: a
 * researcher's own words (or the files page as the channel), the data dictionary
 * file, or what the inference was read from. Returns the problem as a sentence.
 * @param {Record<string, any>} input @param {string} via @param {string} now
 * @returns {{ provenance: Provenance } | { problem: string }}
 */
function readProvenance(input, via, now) {
  const basis = input.basis
  if (!SEMANTIC_BASES.includes(basis)) return { problem: `basis is one of: ${SEMANTIC_BASES.join(', ')}.` }
  /** @type {Provenance} */
  const provenance = { basis, via, at: now }
  if (basis === 'researcher_confirmed') {
    const statement = input.statement == null ? null : asText(input.statement, 400)
    if (input.statement != null && !statement) return { problem: 'statement is the researcher\'s own words, one line of at most 400 characters.' }
    // On the page the button is the researcher's act; in the conversation a run
    // writes it down, so the words they used have to be there.
    if (!statement && via !== 'page') return { problem: 'a researcher-confirmed fact needs statement: what the researcher said, in their words.' }
    if (statement) provenance.statement = statement
  } else if (basis === 'dictionary_stated') {
    const stated = typeof input.statedIn === 'string' ? { path: input.statedIn } : input.statedIn
    const path = isRecord(stated) ? asWorkspacePath(stated.path) : null
    if (!path) return { problem: 'a dictionary-stated fact needs statedIn: the data dictionary file, as a workspace-relative path.' }
    if (stated.sha256 != null && !SHA256.test(String(stated.sha256))) return { problem: 'statedIn.sha256 is a 64-character hex digest.' }
    provenance.statedIn = { path, ...(stated.sha256 ? { sha256: String(stated.sha256) } : {}) }
  } else {
    const from = typeof input.inferredFrom === 'string' ? [input.inferredFrom] : input.inferredFrom
    const items = Array.isArray(from) ? from.map((item) => asText(item, 200)) : []
    if (items.length < 1 || items.length > 5 || items.some((item) => item === null)) {
      return { problem: 'an inferred fact needs inferredFrom: one to five short notes on what it was read from.' }
    }
    provenance.inferredFrom = /** @type {string[]} */ (items)
  }
  return { provenance }
}

/** @param {unknown} value @param {Provenance} provenance @returns {SemanticFact} */
function makeFact(value, provenance) {
  return { value, ...provenance }
}

// ---------------------------------------------------------------------------
// The asset
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, type: string, missing: number, distinct: number | null,
 *   numeric?: { n: number, min: number, p25: number, median: number, p75: number, max: number, mean: number },
 *   headerUnit?: string }} ColumnProfile
 * @typedef {{ table: string, path: string, sha256: string, bytes: number, rows: number, boundAt: string, columns: ColumnProfile[], profileTrimmed?: boolean }} Binding
 * @typedef {Record<string, SemanticFact>} FactMap
 * @typedef {{ name: string, facts: FactMap }} VariableRecord
 * @typedef {{ name: string, facts: FactMap, variables: VariableRecord[] }} TableRecord
 * @typedef {{ id: string, left: { table: string, columns: string[] }, right: { table: string, columns: string[] }, facts: FactMap }} JoinRecord
 * @typedef {{ name: string, kind: string, description?: string, inputs: { table: string, columns: string[] }[], output?: { table?: string, column?: string },
 *   code?: { path: string, sha256: string }, parameters?: Record<string, any>, boundTo?: { table: string, sha256: string }[],
 *   version: number, recordedAt: string, history: { version: number, code?: string, at: string }[] }} TransformationRecord
 * @typedef {{ schemaVersion: number, datasetId: string, title: string | null, facts: FactMap,
 *   tables: TableRecord[], joins: JoinRecord[], bindings: Binding[], bindingHistory: { table: string, sha256: string, rows: number, boundAt: string, supersededAt: string }[],
 *   transformations: TransformationRecord[], denominators: Record<string, { rows: number, subjects: number | null, source: string, at: string }>,
 *   lastCheck: Record<string, any> | null, createdAt: string, updatedAt: string }} SemanticsAsset
 */

/** An asset is plain JSON, so a copy is a round trip (`structuredClone` is not in every environment this package loads in). @param {SemanticsAsset} asset @returns {SemanticsAsset} */
const cloneAsset = (asset) => JSON.parse(JSON.stringify(asset))

/** @param {string} datasetId @param {string} now @returns {SemanticsAsset} */
export function emptySemanticsAsset(datasetId, now) {
  return {
    schemaVersion: DATA_SEMANTICS_SCHEMA_VERSION, datasetId, title: null, facts: {}, tables: [], joins: [],
    bindings: [], bindingHistory: [], transformations: [], denominators: {}, lastCheck: null, createdAt: now, updatedAt: now,
  }
}

/**
 * The id of a join: its two sides, so the same declaration lands on the same
 * record however many times it is written.
 * @param {{ table: string, columns: string[] }} left @param {{ table: string, columns: string[] }} right
 */
export const joinId = (left, right) => `${left.table}.${left.columns.join('+')}->${right.table}.${right.columns.join('+')}`

/** @param {unknown} side @returns {{ table: string, columns: string[] } | null} */
function readJoinSide(side) {
  if (!isRecord(side) || Object.keys(side).some((key) => !['table', 'columns'].includes(key))) return null
  const table = asText(side.table, 120)
  const columns = asColumns(side.columns, 6)
  return table && columns ? { table, columns } : null
}

/**
 * @typedef {{ index?: number, path?: string, code: string, message: string }} SemanticsIssue
 * @typedef {{ target: string, outcome: string, basis?: string, keptBasis?: string }} SemanticsOutcome
 */

const PATCH_KEYS = ['datasetId', 'title', 'basis', 'statement', 'statedIn', 'inferredFrom', 'population', 'timeWindow', 'tables', 'variables', 'joins', 'bindings']
const TABLE_ITEM_KEYS = ['name', ...DATA_TABLE_FACETS]
const VARIABLE_ITEM_KEYS = ['table', 'name', ...DATA_VARIABLE_FACETS]
const JOIN_ITEM_KEYS = ['left', 'right', 'cardinality']

/**
 * Apply one write — a patch of facts and bindings — to an asset (or to nothing,
 * which creates it). Items are checked one at a time: an item with a problem is
 * left out and named in `issues`, and every other item is written, so one bad
 * unit never costs the rest of the interpretation.
 *
 * @param {SemanticsAsset | null} current
 * @param {unknown} input the patch (see `PATCH_KEYS`)
 * @param {{ now: string, via: string }} context `via`: 'conversation' from the runtime's tool, 'page' from the files page
 * @returns {{ asset: SemanticsAsset, outcomes: SemanticsOutcome[], issues: SemanticsIssue[], changed: boolean }}
 */
export function applySemanticsPatch(current, input, { now, via }) {
  /** @type {SemanticsIssue[]} */
  const issues = []
  /** @type {SemanticsOutcome[]} */
  const outcomes = []
  const patch = isRecord(input) ? input : {}
  if (!isRecord(input)) issues.push({ code: 'patch_invalid', message: 'A write is an object.' })
  for (const key of Object.keys(patch)) if (!PATCH_KEYS.includes(key)) issues.push({ path: key, code: 'field_unknown', message: `A write has no "${key}".` })
  const datasetId = current?.datasetId ?? patch.datasetId
  if (!isDatasetId(datasetId)) {
    return { asset: current ?? emptySemanticsAsset('dataset', now), outcomes, changed: false,
      issues: [...issues, { path: 'datasetId', code: 'dataset_invalid', message: 'datasetId is lowercase letters, digits, - and _, at most 64 characters.' }] }
  }
  const asset = cloneAsset(current ?? emptySemanticsAsset(datasetId, now))
  const before = canonicalJson(asset)

  if (patch.title != null) {
    const title = asText(patch.title, 120)
    if (title) asset.title = title
    else issues.push({ path: 'title', code: 'title_invalid', message: 'A title is one line of at most 120 characters.' })
  }

  const hasFacts = DATA_DATASET_FACETS.some((facet) => patch[facet] != null)
    || (Array.isArray(patch.tables) && patch.tables.length > 0) || (Array.isArray(patch.variables) && patch.variables.length > 0)
    || (Array.isArray(patch.joins) && patch.joins.length > 0)
  /** @type {Provenance | null} */
  let provenance = null
  if (hasFacts) {
    const read = readProvenance(patch, via, now)
    if ('problem' in read) issues.push({ path: 'basis', code: 'provenance_invalid', message: `Nothing about meaning was written: ${read.problem}` })
    else provenance = read.provenance
  }

  /**
   * Check one facet's value and, when it holds, merge it into a fact map and record what happened.
   * `facts` is a function so the entity that owns it (a table, a variable, a join) is only created once
   * something is actually written to it.
   * @param {() => FactMap | null} facts @param {string} facet @param {unknown} raw @param {string} target @param {SemanticsIssue['index']} index
   * @returns {boolean} whether the facet was valid (false when refused, or when there was nowhere to put it)
   */
  const setFact = (facts, facet, raw, target, index) => {
    if (!provenance) return false
    const checked = FACET_RULES[facet](raw)
    if (!checked.ok) { issues.push({ index, path: target, code: `${facet}_invalid`, message: checked.message }); return false }
    const into = facts()
    if (!into) return false
    const merged = mergeFact(into[facet], makeFact(checked.value, provenance))
    into[facet] = merged.fact
    outcomes.push({ target, outcome: merged.outcome, basis: provenance.basis, ...(merged.keptBasis ? { keptBasis: merged.keptBasis } : {}) })
    return true
  }

  for (const facet of DATA_DATASET_FACETS) if (patch[facet] != null) setFact(() => asset.facts, facet, patch[facet], facet, undefined)

  /** @param {string} name @returns {TableRecord | null} */
  const tableOf = (name) => {
    let table = asset.tables.find((candidate) => candidate.name === name)
    if (!table) {
      if (asset.tables.length >= DATA_SEMANTICS_LIMITS.tables) return null
      table = { name, facts: {}, variables: [] }
      asset.tables.push(table)
    }
    return table
  }

  if (patch.tables != null && !Array.isArray(patch.tables)) issues.push({ path: 'tables', code: 'tables_invalid', message: 'tables is a list.' })
  for (const [index, item] of (Array.isArray(patch.tables) ? patch.tables : []).entries()) {
    if (!isRecord(item)) { issues.push({ index, path: 'tables', code: 'item_invalid', message: 'A table entry is an object.' }); continue }
    const unknown = Object.keys(item).find((key) => !TABLE_ITEM_KEYS.includes(key))
    if (unknown) { issues.push({ index, path: `tables.${unknown}`, code: 'field_unknown', message: `A table entry has no "${unknown}".` }); continue }
    const name = asText(item.name, 120)
    if (!name) { issues.push({ index, path: 'tables.name', code: 'name_invalid', message: 'A table is named by its file (or file#sheet), at most 120 characters.' }); continue }
    if (!provenance) continue
    const tableHere = () => {
      const table = tableOf(name)
      if (!table) issues.push({ index, path: `table:${name}`, code: 'too_many_tables', message: `At most ${DATA_SEMANTICS_LIMITS.tables} tables.` })
      return table
    }
    const given = DATA_TABLE_FACETS.filter((facet) => item[facet] !== undefined)
    if (given.length === 0) tableHere()
    for (const facet of given) setFact(() => tableHere()?.facts ?? null, facet, item[facet], `table:${name}:${facet}`, index)
  }

  if (patch.variables != null && !Array.isArray(patch.variables)) issues.push({ path: 'variables', code: 'variables_invalid', message: 'variables is a list.' })
  for (const [index, item] of (Array.isArray(patch.variables) ? patch.variables : []).entries()) {
    if (!isRecord(item)) { issues.push({ index, path: 'variables', code: 'item_invalid', message: 'A variable entry is an object.' }); continue }
    const unknown = Object.keys(item).find((key) => !VARIABLE_ITEM_KEYS.includes(key))
    if (unknown) { issues.push({ index, path: `variables.${unknown}`, code: 'field_unknown', message: `A variable entry has no "${unknown}".` }); continue }
    const name = asText(item.name, 128)
    const tableName = asText(item.table, 120)
    if (!name || !tableName) { issues.push({ index, path: 'variables', code: 'name_invalid', message: 'A variable names its table and its column.' }); continue }
    if (!provenance) continue
    /** @returns {VariableRecord | null} */
    const variableOf = () => {
      const table = tableOf(tableName)
      if (!table) { issues.push({ index, path: `table:${tableName}`, code: 'too_many_tables', message: `At most ${DATA_SEMANTICS_LIMITS.tables} tables.` }); return null }
      let variable = table.variables.find((candidate) => candidate.name === name)
      if (!variable) {
        const total = asset.tables.reduce((sum, candidate) => sum + candidate.variables.length, 0)
        if (total >= DATA_SEMANTICS_LIMITS.variables) { issues.push({ index, path: `variable:${tableName}/${name}`, code: 'too_many_variables', message: `At most ${DATA_SEMANTICS_LIMITS.variables} variables.` }); return null }
        variable = { name, facts: {} }
        table.variables.push(variable)
      }
      return variable
    }
    const given = DATA_VARIABLE_FACETS.filter((facet) => item[facet] !== undefined)
    if (given.length === 0) variableOf()
    for (const facet of given) setFact(() => variableOf()?.facts ?? null, facet, item[facet], `variable:${tableName}/${name}:${facet}`, index)
  }

  if (patch.joins != null && !Array.isArray(patch.joins)) issues.push({ path: 'joins', code: 'joins_invalid', message: 'joins is a list.' })
  for (const [index, item] of (Array.isArray(patch.joins) ? patch.joins : []).entries()) {
    if (!isRecord(item)) { issues.push({ index, path: 'joins', code: 'item_invalid', message: 'A join entry is an object.' }); continue }
    const unknown = Object.keys(item).find((key) => !JOIN_ITEM_KEYS.includes(key))
    if (unknown) { issues.push({ index, path: `joins.${unknown}`, code: 'field_unknown', message: `A join entry has no "${unknown}".` }); continue }
    const left = readJoinSide(item.left)
    const right = readJoinSide(item.right)
    if (!left || !right || left.columns.length !== right.columns.length) {
      issues.push({ index, path: 'joins', code: 'join_invalid', message: 'A join names a table and the same number of key columns on each side.' }); continue
    }
    if (!provenance) continue
    const id = joinId(left, right)
    setFact(() => {
      let join = asset.joins.find((candidate) => candidate.id === id)
      if (!join) {
        if (asset.joins.length >= DATA_SEMANTICS_LIMITS.joins) { issues.push({ index, path: `join:${id}`, code: 'too_many_joins', message: `At most ${DATA_SEMANTICS_LIMITS.joins} joins.` }); return null }
        join = { id, left, right, facts: {} }
        asset.joins.push(join)
      }
      return join.facts
    }, 'cardinality', item.cardinality, `join:${id}:cardinality`, index)
  }

  if (patch.bindings != null && !Array.isArray(patch.bindings)) issues.push({ path: 'bindings', code: 'bindings_invalid', message: 'bindings is a list.' })
  for (const [index, item] of (Array.isArray(patch.bindings) ? patch.bindings : []).entries()) {
    // The browser may state meaning; it may not state which bytes a meaning was read from.
    if (via === 'page') { issues.push({ index, path: 'bindings', code: 'bindings_not_allowed', message: 'Source versions are recorded by the tool that read the files.' }); break }
    const binding = normalizeBinding(item, now)
    if ('problem' in binding) { issues.push({ index, path: 'bindings', code: 'binding_invalid', message: binding.problem }); continue }
    outcomes.push({ target: `binding:${binding.binding.table}`, outcome: applyBinding(asset, binding.binding, now) })
    tableOf(binding.binding.table)
  }

  asset.tables.sort((a, b) => a.name.localeCompare(b.name))
  for (const table of asset.tables) table.variables.sort((a, b) => a.name.localeCompare(b.name))
  asset.joins.sort((a, b) => a.id.localeCompare(b.id))
  const changed = canonicalJson(asset) !== before
  if (changed) asset.updatedAt = now
  return { asset, outcomes, issues, changed }
}

/**
 * One table's exact source version, as the tool that read the file states it.
 * Profiles are aggregates: names, observed types, counts, and a numeric summary
 * only from enough values — never a value, and never a vocabulary: a code list
 * enters the asset as an `allowedValues` fact, with a basis the researcher can
 * confirm or correct.
 * @param {unknown} raw @param {string} now
 * @returns {{ binding: Binding } | { problem: string }}
 */
export function normalizeBinding(raw, now) {
  if (!isRecord(raw)) return { problem: 'A binding is an object.' }
  const allowed = ['table', 'path', 'sha256', 'bytes', 'rows', 'columns']
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key))
  if (unknown) return { problem: `A binding has no "${unknown}".` }
  const table = asText(raw.table, 120)
  const path = asWorkspacePath(raw.path)
  if (!table || !path) return { problem: 'A binding names its table and its workspace-relative path.' }
  if (typeof raw.sha256 !== 'string' || !SHA256.test(raw.sha256)) return { problem: 'A binding carries the file\'s SHA-256 as 64 hex characters.' }
  const count = (/** @type {unknown} */ value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null)
  const bytes = count(raw.bytes)
  const rows = count(raw.rows)
  if (bytes === null || rows === null) return { problem: 'A binding\'s bytes and rows are counts.' }
  if (!Array.isArray(raw.columns) || raw.columns.length > DATA_SEMANTICS_LIMITS.columnsProfiled) {
    return { problem: `A binding profiles at most ${DATA_SEMANTICS_LIMITS.columnsProfiled} columns.` }
  }
  /** @type {ColumnProfile[]} */
  const columns = []
  for (const column of raw.columns) {
    const profile = normalizeColumnProfile(column)
    if (!profile) return { problem: 'A column profile is { name, type, missing, distinct?, numeric?, codes? } within its bounds.' }
    columns.push(profile)
  }
  return { binding: { table, path, sha256: raw.sha256, bytes, rows, boundAt: now, columns } }
}

/** @param {unknown} raw @returns {ColumnProfile | null} */
function normalizeColumnProfile(raw) {
  if (!isRecord(raw)) return null
  const allowed = ['name', 'type', 'missing', 'distinct', 'numeric', 'headerUnit']
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return null
  const name = asText(raw.name, 128)
  if (!name || !(DATA_VARIABLE_TYPES.includes(raw.type) || raw.type === 'empty')) return null
  if (!Number.isSafeInteger(raw.missing) || raw.missing < 0) return null
  /** @type {ColumnProfile} */
  const profile = { name, type: raw.type, missing: raw.missing, distinct: Number.isSafeInteger(raw.distinct) && raw.distinct >= 0 ? raw.distinct : null }
  if (raw.numeric != null) {
    const numeric = raw.numeric
    const keys = ['n', 'min', 'p25', 'median', 'p75', 'max', 'mean']
    if (!isRecord(numeric) || keys.some((key) => typeof numeric[key] !== 'number' || !Number.isFinite(numeric[key]))) return null
    // The small-cell floor: a summary of fewer values than this is a person's value, so it is not kept.
    if (numeric.n >= DATA_DRIFT_BOUNDS.minCell) {
      profile.numeric = { n: numeric.n, min: numeric.min, p25: numeric.p25, median: numeric.median, p75: numeric.p75, max: numeric.max, mean: numeric.mean }
    }
  }
  if (raw.headerUnit != null) {
    const unit = asText(raw.headerUnit, 32)
    if (!unit) return null
    profile.headerUnit = unit
  }
  return profile
}

/**
 * Record a table's exact version. The same hash is `unchanged`; a new hash
 * retires the current binding into the history (twenty entries) and becomes the
 * baseline every later delivery is compared against.
 * @param {SemanticsAsset} asset @param {Binding} binding @param {string} now
 * @returns {'bound' | 'rebound' | 'unchanged'}
 */
function applyBinding(asset, binding, now) {
  const index = asset.bindings.findIndex((candidate) => candidate.table === binding.table)
  if (index < 0) { asset.bindings.push(binding); return 'bound' }
  const previous = asset.bindings[index]
  if (previous.sha256 === binding.sha256) {
    // Same bytes: the path may have moved; keep the profile that was recorded.
    if (previous.path !== binding.path) asset.bindings[index] = { ...previous, path: binding.path }
    return 'unchanged'
  }
  asset.bindingHistory = [...asset.bindingHistory, { table: previous.table, sha256: previous.sha256, rows: previous.rows, boundAt: previous.boundAt, supersededAt: now }]
    .slice(-DATA_SEMANTICS_LIMITS.history)
  asset.bindings[index] = binding
  return 'rebound'
}

/**
 * The asset, held inside what a ledger document can carry. First the aggregate
 * profiles are thinned to names and types; if it still does not fit, the write is
 * refused by name rather than by the ledger's size error.
 * @param {SemanticsAsset} asset
 * @returns {{ asset: SemanticsAsset, trimmed: boolean } | null}
 */
export function fitAsset(asset) {
  const size = (/** @type {unknown} */ value) => JSON.stringify(value).length
  if (size(asset) <= DATA_SEMANTICS_LIMITS.assetBytes) return { asset, trimmed: false }
  const thin = cloneAsset(asset)
  for (const binding of thin.bindings) {
    binding.columns = binding.columns.map((column) => ({ name: column.name, type: column.type, missing: column.missing, distinct: column.distinct }))
    binding.profileTrimmed = true
  }
  return size(thin) <= DATA_SEMANTICS_LIMITS.assetBytes ? { asset: thin, trimmed: true } : null
}

// ---------------------------------------------------------------------------
// Transformations: versioned, so a repeat analysis applies the same thing
// ---------------------------------------------------------------------------

const TRANSFORM_KEYS = ['name', 'kind', 'description', 'inputs', 'output', 'code', 'parameters', 'boundTo']
const TRANSFORM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/**
 * @param {unknown} raw
 * @returns {{ transformation: Omit<TransformationRecord, 'version' | 'recordedAt' | 'history'> } | { problem: string }}
 */
export function normalizeTransformation(raw) {
  if (!isRecord(raw)) return { problem: 'A transformation is an object.' }
  const unknown = Object.keys(raw).find((key) => !TRANSFORM_KEYS.includes(key))
  if (unknown) return { problem: `A transformation has no "${unknown}".` }
  const name = typeof raw.name === 'string' && TRANSFORM_NAME.test(raw.name) ? raw.name : null
  if (!name) return { problem: 'A transformation is named with letters, digits, . _ -, at most 64 characters.' }
  if (!DATA_TRANSFORM_KINDS.includes(raw.kind)) return { problem: `kind is one of: ${DATA_TRANSFORM_KINDS.join(', ')}.` }
  /** @type {{ table: string, columns: string[] }[]} */
  const inputs = []
  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > 10) return { problem: 'inputs are one to ten { table, columns } entries.' }
  for (const input of raw.inputs) {
    const table = isRecord(input) ? asText(input.table, 120) : null
    const columns = isRecord(input) && input.columns != null ? asColumns(input.columns, 20) : []
    if (!table || columns === null) return { problem: 'An input names a table and at most twenty columns.' }
    inputs.push({ table, columns })
  }
  /** @type {Omit<TransformationRecord, 'version' | 'recordedAt' | 'history'>} */
  const transformation = { name, kind: raw.kind, inputs }
  if (raw.description != null) {
    const description = asText(raw.description, 300)
    if (!description) return { problem: 'A description is one line of at most 300 characters.' }
    transformation.description = description
  }
  if (raw.output != null) {
    if (!isRecord(raw.output) || Object.keys(raw.output).some((key) => !['table', 'column'].includes(key))) return { problem: 'output is { table?, column? }.' }
    const table = raw.output.table == null ? undefined : asText(raw.output.table, 120)
    const column = raw.output.column == null ? undefined : asText(raw.output.column, 128)
    if (table === null || column === null) return { problem: 'An output table or column is a short name.' }
    transformation.output = { ...(table ? { table } : {}), ...(column ? { column } : {}) }
  }
  if (raw.code != null) {
    const path = isRecord(raw.code) ? asWorkspacePath(raw.code.path) : null
    if (!path || typeof raw.code.sha256 !== 'string' || !SHA256.test(raw.code.sha256)) return { problem: 'code is { path, sha256 }: the file that does it, and its hash.' }
    transformation.code = { path, sha256: raw.code.sha256 }
  }
  if (raw.parameters != null) {
    if (!isRecord(raw.parameters) || canonicalJson(raw.parameters).length > 2048) return { problem: 'parameters are an object of at most 2 KiB.' }
    transformation.parameters = raw.parameters
  }
  if (raw.boundTo != null) {
    if (!Array.isArray(raw.boundTo) || raw.boundTo.length > 10) return { problem: 'boundTo lists at most ten { table, sha256 } source versions.' }
    const bound = []
    for (const item of raw.boundTo) {
      const table = isRecord(item) ? asText(item.table, 120) : null
      if (!table || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) return { problem: 'A source version is { table, sha256 }.' }
      bound.push({ table, sha256: item.sha256 })
    }
    transformation.boundTo = bound
  }
  return { transformation }
}

/**
 * Record a transformation by name. The same definition is `same`; a different
 * inputs / output / kind / parameters / code is `changed` and says which, and
 * takes the next version; a first record is `new`. A change of the source
 * versions alone is `same` with `rebound: true` — the transformation did not
 * change, the data under it did.
 * @param {SemanticsAsset} asset @param {Omit<TransformationRecord, 'version' | 'recordedAt' | 'history'>} incoming @param {string} now
 * @returns {{ status: 'new' | 'same' | 'changed', version: number, changed: string[], rebound: boolean } | { problem: string, code: string }}
 */
export function applyTransformation(asset, incoming, now) {
  const index = asset.transformations.findIndex((candidate) => candidate.name === incoming.name)
  const comparable = (/** @type {any} */ record) => ({
    kind: record.kind, inputs: record.inputs, output: record.output ?? null, code: record.code?.sha256 ?? null, parameters: record.parameters ?? null,
  })
  if (index < 0) {
    if (asset.transformations.length >= DATA_SEMANTICS_LIMITS.transformations) {
      return { code: 'too_many_transformations', problem: `At most ${DATA_SEMANTICS_LIMITS.transformations} transformations are recorded per dataset.` }
    }
    asset.transformations.push({ ...incoming, version: 1, recordedAt: now, history: [{ version: 1, ...(incoming.code ? { code: incoming.code.sha256 } : {}), at: now }] })
    asset.updatedAt = now
    return { status: 'new', version: 1, changed: [], rebound: false }
  }
  const previous = asset.transformations[index]
  const was = comparable(previous)
  const now_ = comparable(incoming)
  const changed = Object.keys(was).filter((key) => canonicalJson(/** @type {any} */ (was)[key]) !== canonicalJson(/** @type {any} */ (now_)[key]))
  const rebound = canonicalJson(previous.boundTo ?? null) !== canonicalJson(incoming.boundTo ?? null)
  if (changed.length === 0) {
    if (rebound || (incoming.description && incoming.description !== previous.description)) {
      asset.transformations[index] = { ...previous, ...(incoming.boundTo ? { boundTo: incoming.boundTo } : {}), ...(incoming.description ? { description: incoming.description } : {}) }
      asset.updatedAt = now
    }
    return { status: 'same', version: previous.version, changed: [], rebound }
  }
  const version = previous.version + 1
  asset.transformations[index] = {
    ...incoming, version, recordedAt: now,
    history: [...previous.history, { version, ...(incoming.code ? { code: incoming.code.sha256 } : {}), at: now }].slice(-DATA_SEMANTICS_LIMITS.history),
  }
  asset.updatedAt = now
  return { status: 'changed', version, changed, rebound }
}

// ---------------------------------------------------------------------------
// The last check: named findings, never values
// ---------------------------------------------------------------------------

const FINDING_LIMIT = 100
const LIST_LIMIT = 50

/**
 * A detail object reduced to short scalars: numbers, booleans and strings of at
 * most 80 characters, and flat lists of those. Anything else — a nested row, a
 * long string — is dropped, because a finding states a count and a column, not
 * what a person's record said.
 * @param {unknown} value @returns {Record<string, any>}
 */
function scrubDetail(value) {
  if (!isRecord(value)) return {}
  /** @type {Record<string, any>} */
  const out = {}
  const scalar = (/** @type {unknown} */ item) => (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean'
    || (typeof item === 'string' && item.length <= 80 && !hasControl(item)) || item === null
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue
    if (scalar(item)) out[key] = item
    else if (Array.isArray(item) && item.length <= 20 && item.every(scalar)) out[key] = item
  }
  return out
}

/** @param {unknown} subject @returns {Record<string, string>} */
function scrubSubject(subject) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!isRecord(subject)) return out
  for (const key of ['table', 'column', 'join', 'step', 'predictor']) {
    const text = asText(subject[key], 300)
    if (text) out[key] = text
  }
  return out
}

/**
 * A check report as the control plane stores it: bounded, with only the fields
 * the vocabulary names. Findings with an outcome this build does not know are
 * dropped rather than relabelled.
 * @param {unknown} raw
 * @returns {Record<string, any> | null} null when it is not a report at all
 */
export function normalizeCheckReport(raw) {
  if (!isRecord(raw)) return null
  const checkedAt = typeof raw.checkedAt === 'string' && !Number.isNaN(Date.parse(raw.checkedAt)) ? new Date(raw.checkedAt).toISOString() : null
  if (!checkedAt) return null
  const bindings = (Array.isArray(raw.bindings) ? raw.bindings : []).slice(0, DATA_SEMANTICS_LIMITS.tables)
    .map((item) => ({ table: isRecord(item) ? asText(item.table, 120) : null, sha256: isRecord(item) ? item.sha256 : null }))
    .filter((item) => item.table && typeof item.sha256 === 'string' && SHA256.test(item.sha256))
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, FINDING_LIMIT).flatMap((item) => {
    if (!isRecord(item) || typeof item.outcome !== 'string' || !Object.hasOwn(DATA_CHECK_OUTCOMES, item.outcome)) return []
    const meta = /** @type {{ family: string, severity: string }} */ (/** @type {any} */ (DATA_CHECK_OUTCOMES)[item.outcome])
    const rows = Array.isArray(item.rows) ? item.rows.filter((row) => Number.isSafeInteger(row) && row >= 1).slice(0, DATA_DRIFT_BOUNDS.sampleRows) : []
    const count = Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : null
    const message = asText(item.message, 300)
    return [{
      outcome: item.outcome, family: meta.family, severity: DATA_CHECK_SEVERITIES.includes(item.severity) ? item.severity : meta.severity,
      subject: scrubSubject(item.subject), detail: scrubDetail(item.detail), ...(rows.length ? { rows } : {}),
      ...(count !== null ? { count } : {}), ...(message ? { message } : {}),
    }]
  })
  const notChecked = (Array.isArray(raw.notChecked) ? raw.notChecked : []).slice(0, LIST_LIMIT).flatMap((item) => {
    if (!isRecord(item) || !DATA_CHECK_FAMILIES.includes(item.family) || !DATA_CHECK_NOT_CHECKED_REASON_IDS.includes(item.reason)) return []
    return [{ family: item.family, reason: item.reason, subject: scrubSubject(item.subject) }]
  })
  const clean = (Array.isArray(raw.clean) ? raw.clean : []).slice(0, LIST_LIMIT).flatMap((item) => {
    if (!isRecord(item) || !DATA_CHECK_FAMILIES.includes(item.family)) return []
    return [{ family: item.family, subject: scrubSubject(item.subject) }]
  })
  const digest = typeof raw.interpretation === 'string' && SHA256.test(raw.interpretation) ? raw.interpretation : null
  return {
    checkedAt, bindings, findings, notChecked, clean, ...(digest ? { interpretation: digest } : {}),
    summary: {
      attention: findings.filter((finding) => finding.severity === 'attention').length,
      information: findings.filter((finding) => finding.severity === 'information').length,
      notChecked: notChecked.length, clean: clean.length,
    },
  }
}

/**
 * The denominators one analysis observed, by step label. Counts only. The next
 * check compares its own against these and says `denominator_changed` where a
 * step's count is not the one recorded.
 * @param {unknown} raw @returns {Record<string, { rows: number, subjects: number | null, source: string }>}
 */
export function normalizeDenominators(raw) {
  /** @type {Record<string, { rows: number, subjects: number | null, source: string }>} */
  const out = {}
  if (!isRecord(raw)) return out
  for (const [label, item] of Object.entries(raw).slice(0, DATA_SEMANTICS_LIMITS.denominators)) {
    const name = asText(label, 80)
    if (!name || !isRecord(item) || !Number.isSafeInteger(item.rows) || item.rows < 0) continue
    out[name] = {
      rows: item.rows, subjects: Number.isSafeInteger(item.subjects) && item.subjects >= 0 ? item.subjects : null,
      source: item.source === 'reported' ? 'reported' : 'measured',
    }
  }
  return out
}

/**
 * Store a check's report and the denominators it observed on the asset.
 * @param {SemanticsAsset} asset @param {unknown} report @param {unknown} denominators @param {string} now
 * @returns {{ ok: true } | { ok: false, problem: string }}
 */
export function applyCheckReport(asset, report, denominators, now) {
  const normalized = normalizeCheckReport(report)
  if (!normalized) return { ok: false, problem: 'A check report carries checkedAt, bindings, findings, notChecked and clean.' }
  asset.lastCheck = normalized
  const seen = normalizeDenominators(denominators)
  const merged = { ...asset.denominators }
  for (const [label, item] of Object.entries(seen)) merged[label] = { ...item, at: now }
  // Oldest labels fall away first: the bound is on the record, not on the analysis.
  asset.denominators = Object.fromEntries(Object.entries(merged).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-DATA_SEMANTICS_LIMITS.denominators))
  asset.updatedAt = now
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Reading an asset
// ---------------------------------------------------------------------------

/**
 * Every fact of an asset in one list, for a page that shows them and a tool that
 * summarises them. `target` is the same string a write's outcome names.
 * @param {SemanticsAsset} asset
 * @returns {{ target: string, scope: 'dataset' | 'table' | 'variable' | 'join', table?: string, variable?: string, join?: string, facet: string, fact: SemanticFact }[]}
 */
export function semanticFacts(asset) {
  /** @type {ReturnType<typeof semanticFacts>} */
  const list = []
  for (const [facet, fact] of Object.entries(asset.facts)) list.push({ target: facet, scope: 'dataset', facet, fact })
  for (const table of asset.tables) {
    for (const [facet, fact] of Object.entries(table.facts)) list.push({ target: `table:${table.name}:${facet}`, scope: 'table', table: table.name, facet, fact })
    for (const variable of table.variables) {
      for (const [facet, fact] of Object.entries(variable.facts)) {
        list.push({ target: `variable:${table.name}/${variable.name}:${facet}`, scope: 'variable', table: table.name, variable: variable.name, facet, fact })
      }
    }
  }
  for (const join of asset.joins) for (const [facet, fact] of Object.entries(join.facts)) list.push({ target: `join:${join.id}:${facet}`, scope: 'join', join: join.id, facet, fact })
  return list
}

/**
 * How much of the interpretation each basis vouches for, and how much the
 * researcher has not yet seen. The three counts are the page's first line.
 * @param {SemanticsAsset} asset
 */
export function summarizeSemantics(asset) {
  const facts = semanticFacts(asset)
  const count = (/** @type {string} */ basis) => facts.filter((item) => item.fact.basis === basis).length
  return {
    facts: facts.length,
    researcherConfirmed: count('researcher_confirmed'),
    dictionaryStated: count('dictionary_stated'),
    modelInferred: count('model_inferred'),
    contested: facts.filter((item) => item.fact.contested?.length).length,
    tables: asset.tables.length,
    variables: asset.tables.reduce((sum, table) => sum + table.variables.length, 0),
    transformations: asset.transformations.length,
  }
}

/**
 * The interpretation alone, as one canonical string: what the tables and
 * variables are said to mean and by whom, and nothing about when or which bytes.
 * Hashed by the control plane into the digest a run cites to say "I used this
 * interpretation", and which a later run compares to learn that it changed.
 * @param {SemanticsAsset} asset @returns {string}
 */
export function interpretationOf(asset) {
  const strip = (/** @type {FactMap} */ facts) => Object.fromEntries(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b))
    .map(([facet, fact]) => [facet, { value: fact.value, basis: fact.basis }]))
  return canonicalJson({
    dataset: strip(asset.facts),
    tables: asset.tables.map((table) => ({ name: table.name, facts: strip(table.facts), variables: table.variables.map((variable) => ({ name: variable.name, facts: strip(variable.facts) })) })),
    joins: asset.joins.map((join) => ({ id: join.id, facts: strip(join.facts) })),
  })
}

/**
 * A short listing of an asset for a project's list of datasets.
 * @param {SemanticsAsset} asset
 */
export function semanticsListing(asset) {
  const check = asset.lastCheck
  return {
    datasetId: asset.datasetId, title: asset.title,
    tables: asset.bindings.map((binding) => ({ table: binding.table, path: binding.path, sha256: binding.sha256, rows: binding.rows })),
    summary: summarizeSemantics(asset),
    lastCheck: check ? { checkedAt: check.checkedAt, ...check.summary } : null,
    updatedAt: asset.updatedAt,
  }
}
