/**
 * Help for a package's operations, written by a function from the operation's
 * own schema.
 *
 * Hidden knowledge: an operation's help used to be typed beside the code that
 * enforces it, and the two drifted. The document tools' bridge told the model
 * `options` was "an object" while the policy that runs them refuses every key
 * but seven and bounds each one; a tool description spelled a scenario's shapes
 * by hand and had to be shortened when a test counted its characters. A reader
 * (or a model) cannot tell a documented limit from a stale one, and the
 * refusal that teaches them is a spent call.
 *
 * Here an operation is data (`SkillOperation`: name, parameters with type,
 * required, default, closed values, range and unit, what it accepts and
 * produces, its limits) and the help is derived from it, deterministically and
 * within a budget, so there is nothing to keep in step by hand. The enforcing
 * code is held to the same data by a conformance test next to it (see
 * `scripts/runtime/extensions/cowork/operations.test.mjs`): an operation whose
 * policy moves and whose schema does not is a red test, not a wrong help line.
 *
 * Bounded on purpose. Tool and skill help is paid for on every request that
 * carries it (CLAUDE.md principle 16: tool usage lives in descriptions and
 * results, kept short), so `renderOperationHelp` takes a character budget and
 * degrades in a fixed order — an example first, then parameter detail, then
 * the tail — and says how much it left out, instead of running long.
 *
 * Pure: no clock, no files.
 *
 * @module @evimed/domain/src/operationHelp
 */

/** @typedef {import('./skillSupply.mjs').SkillOperation} SkillOperation */
/** @typedef {import('./skillSupply.mjs').SkillOperationParam} SkillOperationParam */

/** The default budget of one operation's help, in characters. */
export const OPERATION_HELP_BUDGET = 700
/** The default budget of a package's help, in characters. */
export const PACKAGE_HELP_BUDGET = 1800

/** @type {Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>} */
const WORDS = Object.freeze({
  zh: Object.freeze({
    string: '文本', integer: '整数', number: '数值', boolean: '是/否', path: '路径', object: '对象', array: '列表',
    required: '必填', optional: '可选', default: '默认', values: '取值', range: '范围', accepts: '接受', produces: '产出', limits: '限制',
    entrypoint: '入口', example: '示例', params: '参数', none: '无参数', more: '另有', items: '项', colon: '：', comma: '，', semi: '；', open: '（', close: '）', sep: '、',
  }),
  en: Object.freeze({
    string: 'string', integer: 'integer', number: 'number', boolean: 'boolean', path: 'path', object: 'object', array: 'array',
    required: 'required', optional: 'optional', default: 'default', values: 'one of', range: 'range', accepts: 'Accepts', produces: 'Produces', limits: 'Limits',
    entrypoint: 'Entrypoint', example: 'Example', params: 'Parameters', none: 'no parameters', more: 'and', items: 'more', colon: ': ', comma: ', ', semi: '; ', open: ' (', close: ')', sep: ', ',
  }),
})

/** @param {string} value @returns {number} the length in characters a reader counts */
const length = (value) => [...value].length

/** @param {unknown} value @returns {string} */
const shown = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

/**
 * One parameter, as a phrase: its name, type, whether it is required, its
 * default, its closed values and its range.
 * @param {SkillOperationParam} param @param {'zh' | 'en'} locale @param {boolean} [full]
 * @returns {string}
 */
function paramPhrase(param, locale, full = true) {
  const w = WORDS[locale]
  if (!full) return `${param.name}${param.required ? '*' : ''}`
  const parts = [w[param.type] ?? param.type, param.required ? w.required : w.optional]
  if (param.default !== null && param.default !== undefined) parts.push(`${w.default} ${shown(param.default)}`)
  if (param.values) parts.push(`${w.values} ${param.values.join(' / ')}`)
  const unit = param.unit ? ` ${param.unit}` : ''
  if (param.min !== null && param.max !== null) parts.push(`${w.range} ${param.min}–${param.max}${unit}`)
  else if (param.min !== null) parts.push(`≥ ${param.min}${unit}`)
  else if (param.max !== null) parts.push(`≤ ${param.max}${unit}`)
  const phrase = `${param.name}${w.open}${parts.join(w.comma)}${w.close}`
  return param.description ? `${phrase} ${param.description}` : phrase
}

/**
 * A call that satisfies the operation's schema: the required parameters, each
 * with its default, its first closed value or the smallest value its range
 * allows. Derived from the schema and nothing else, so it cannot show a call
 * the schema would refuse. Dotted names (`options.page`) become nested keys.
 * @param {SkillOperation} operation @returns {Record<string, unknown>}
 */
export function operationExample(operation) {
  /** @type {Record<string, any>} */ const call = {}
  for (const param of operation.params) {
    if (!param.required) continue
    /** @type {unknown} */
    let value
    if (param.default !== null && param.default !== undefined) value = param.default
    else if (param.values) value = param.values[0]
    else if (param.type === 'integer') value = param.min !== null ? Math.ceil(param.min) : 1
    else if (param.type === 'number') value = param.min !== null ? param.min : 1
    else if (param.type === 'boolean') value = true
    else if (param.type === 'array') value = []
    else if (param.type === 'object') value = {}
    else value = `<${param.name.split('.').at(-1)}>`
    const keys = param.name.split('.')
    /** @type {Record<string, any>} */ let cursor = call
    for (const key of keys.slice(0, -1)) {
      if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
      cursor = cursor[key]
    }
    cursor[/** @type {string} */ (keys.at(-1))] = value
  }
  return call
}

/**
 * The help for one operation, within `maxChars`.
 *
 * Content, in the order it is dropped when the budget is short (last first):
 * the heading with its summary, the parameters with type / required / default /
 * values / range, what it accepts, what it produces, its limits, an example
 * call. Parameters degrade to bare names (`name*` marks a required one) before
 * anything is cut, and the cut says how much was left out.
 *
 * @param {SkillOperation} operation
 * @param {{ locale?: 'zh' | 'en', maxChars?: number }} [options]
 * @returns {string}
 */
export function renderOperationHelp(operation, { locale = 'zh', maxChars = OPERATION_HELP_BUDGET } = {}) {
  const w = WORDS[locale]
  const summary = (locale === 'zh' ? operation.summaryZh ?? operation.summary : operation.summary ?? operation.summaryZh)
  const head = `${operation.name}${summary ? `${w.colon}${summary}` : ''}`
  const entry = operation.entrypoint ? `${w.entrypoint}${w.colon}${operation.entrypoint}` : null
  const accepts = operation.accepts.length ? `${w.accepts}${w.colon}${operation.accepts.join(w.sep)}` : null
  const produces = operation.produces.length ? `${w.produces}${w.colon}${operation.produces.join(w.sep)}` : null
  const limits = operation.limits.length ? `${w.limits}${w.colon}${operation.limits.join(w.semi)}` : null
  const call = `${w.example}${w.colon}${JSON.stringify(operationExample(operation))}`
  /** @param {boolean} full @param {number} [take] @returns {string | null} */
  const params = (full, take = operation.params.length) => {
    if (!operation.params.length) return `${w.params}${w.colon}${w.none}`
    const shownParams = operation.params.slice(0, take).map((param) => paramPhrase(param, locale, full))
    const left = operation.params.length - shownParams.length
    return `${w.params}${w.colon}${shownParams.join(w.semi)}${left ? `${w.semi}${w.more} ${left} ${w.items}` : ''}`
  }
  /** @param {(string | null)[]} lines @returns {string} */
  const joined = (lines) => lines.filter((line) => line !== null).join('\n')

  const attempts = [
    () => joined([head, entry, params(true), accepts, produces, limits, call]),
    () => joined([head, entry, params(true), accepts, produces, limits]),
    () => joined([head, entry, params(false), accepts, produces, limits]),
    () => joined([head, entry, params(false), accepts, produces]),
    () => joined([head, entry, params(false)]),
  ]
  for (const attempt of attempts) {
    const rendered = attempt()
    if (length(rendered) <= maxChars) return rendered
  }
  // Even the bare names do not fit: keep as many as the budget allows, and say how many were left out.
  for (let take = operation.params.length - 1; take >= 0; take -= 1) {
    const rendered = joined([head, params(false, take)])
    if (length(rendered) <= maxChars) return rendered
  }
  return [...head].slice(0, Math.max(1, maxChars - 1)).join('') + '…'
}

/**
 * The help for a package's operations, within `maxChars` in total. Each
 * operation gets an equal share of what is left; operations beyond `maxOperations`
 * are counted, not described.
 * @param {readonly SkillOperation[]} operations
 * @param {{ locale?: 'zh' | 'en', maxChars?: number, maxOperations?: number }} [options]
 * @returns {string}
 */
export function renderPackageHelp(operations, { locale = 'zh', maxChars = PACKAGE_HELP_BUDGET, maxOperations = 8 } = {}) {
  const w = WORDS[locale]
  const listed = operations.slice(0, maxOperations)
  const left = operations.length - listed.length
  const tail = left ? `\n${w.more} ${left} ${w.items}` : ''
  const separator = '\n\n'
  const share = Math.max(80, Math.floor((maxChars - length(tail)) / Math.max(1, listed.length)) - length(separator))
  const body = listed.map((operation) => renderOperationHelp(operation, { locale, maxChars: share })).join(separator)
  return body + tail
}
