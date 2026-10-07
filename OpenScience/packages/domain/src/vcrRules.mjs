/**
 * 「虚拟临床研究」's two closed rule grammars (integration contract 2026-09-29 §2).
 *
 * Hidden knowledge:
 *
 * - **No rule is ever code.** A cohort filter, a population constraint, a
 *   quality criterion or an eligibility requirement is DATA in a grammar this
 *   file owns, checked here before it is queued and re-checked by the engine
 *   before it is run. The first build let the model write R expressions into a
 *   scenario and the engine `eval`ed them; a scenario is frozen model output
 *   and can carry anything, so the only safe parser is one with no way to
 *   express a function call. `eval`, `parse`, `str2lang` and `Function` over
 *   job data are forbidden on both sides, and a field named `expression`
 *   anywhere in a scenario is refused by name (`rule_expression_forbidden`).
 * - **Row rules** run over table columns and are three-valued. A missing cell
 *   makes `compare`, `between`, `in` and `not_in` answer 「无法判断」 (`null`
 *   here, `NA` in R), never 「不满足」; `all`/`any`/`not` are Kleene logic, so
 *   an unknown never silently becomes an exclusion. Equality is strict: a
 *   string never equals a number, and ordering is defined for numbers only, so
 *   the answer never depends on locale collation or on R's coercions — the two
 *   sides can be held to one truth table (`test/fixtures/vcr-row-rules.json`,
 *   which the domain test and the engine's N00 case both run).
 * - **Requirements** run over dated facts (matching). The evaluator lives in
 *   `apps/server/src/vcrMatching.mjs` and is deliberately tolerant — it answers
 *   UNKNOWN for anything outside the grammar — so a malformed requirement would
 *   quietly become 「未知」 for every patient. This module is what refuses one
 *   at write time instead.
 * - **Limits are numbers, and they are exported.** Depth, node count, operand
 *   count and list sizes bound the work a hostile or confused rule can cost;
 *   the engine reads the same limits from `R/domain-snapshot.json`.
 * - **A path is where the defect is**, relative to the rule's root: `""` for
 *   the root, `operands[1].column` below it. Callers embed a rule in a larger
 *   document by passing the path it lives at.
 * - Validators return issues; they never throw. Only `evaluateRowRule` throws,
 *   and only on a node a validator would have refused.
 *
 * @module @evimed/domain/vcrRules
 */

/** @template T @param {readonly T[]} list @returns {readonly T[]} */
const frozen = (list) => Object.freeze([...list])

/** @typedef {{ code: string, field: string, detail: string }} VcrRuleIssue */

export const VCR_ROW_RULE_OPS = frozen(['all', 'any', 'not', 'compare', 'between', 'in', 'not_in', 'missing', 'present'])
export const VCR_ROW_RULE_COMPARATORS = frozen(['lt', 'lte', 'gt', 'gte', 'eq', 'ne'])
/** Comparators that order values, and so need a number on both sides. */
export const VCR_ROW_RULE_ORDERING_COMPARATORS = frozen(['lt', 'lte', 'gt', 'gte'])

/** Regex source, not a RegExp: it has to survive a JSON snapshot into R. */
export const VCR_ROW_RULE_COLUMN_PATTERN = '^[A-Za-z_][A-Za-z0-9_.]{0,63}$'
const COLUMN = new RegExp(VCR_ROW_RULE_COLUMN_PATTERN)

export const VCR_ROW_RULE_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 200,
  maxOperands: 32,
  maxValues: 200,
  /** Characters (code points), not UTF-16 units: R's `nchar` counts characters. */
  maxStringLength: 500,
  maxNameLength: 80,
  maxNamedRules: 100,
})

export const VCR_REQUIREMENT_OPS = frozen(['all', 'any', 'not', 'present', 'absent', 'compare', 'elapsed_since', 'language'])
export const VCR_REQUIREMENT_COMPARATORS = frozen(['lt', 'lte', 'gt', 'gte', 'eq', 'ne', 'between', 'in', 'not_in'])
export const VCR_REQUIREMENT_AGGREGATES = frozen(['latest', 'all', 'any'])
export const VCR_REQUIREMENT_VARIABLE_PATTERN = '^[a-z][a-z0-9_]{0,63}$'
const VARIABLE = new RegExp(VCR_REQUIREMENT_VARIABLE_PATTERN)

export const VCR_REQUIREMENT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 200,
  maxOperands: 32,
  maxValues: 200,
  maxStringLength: 200,
  maxUnitLength: 40,
  maxLanguageText: 500,
  windowDaysMax: 36_500,
  windowMonthsMax: 1_200,
  windowYearsMax: 100,
  elapsedDaysMax: 3_650,
  languageKeyMax: 80,
})

// The evaluator's own knobs, admitted because each carries a clinical meaning
// the protocol needs: a window measured back from a named date rather than
// from today (`anchorDate`), a washout that must be strictly longer than N days
// (`comparator: "gt"`), a washout that a documented 「从未接受过」 does NOT
// satisfy (`deniedSatisfies: false`), and a language criterion's own key, which
// is how the model's judgment for it is found.
export const VCR_ELAPSED_COMPARATORS = frozen(['gte', 'gt'])
const LANGUAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/

const RULE_KEYS = Object.freeze({
  all: { keys: ['op', 'operands'], required: ['operands'] },
  any: { keys: ['op', 'operands'], required: ['operands'] },
  not: { keys: ['op', 'operand'], required: ['operand'] },
  compare: { keys: ['op', 'column', 'comparator', 'value'], required: ['column', 'comparator', 'value'] },
  between: { keys: ['op', 'column', 'low', 'high'], required: ['column', 'low', 'high'] },
  in: { keys: ['op', 'column', 'values'], required: ['column', 'values'] },
  not_in: { keys: ['op', 'column', 'values'], required: ['column', 'values'] },
  missing: { keys: ['op', 'column'], required: ['column'] },
  present: { keys: ['op', 'column'], required: ['column'] },
})

const REQUIREMENT_KEYS = Object.freeze({
  all: { keys: ['op', 'operands'], required: ['operands'] },
  any: { keys: ['op', 'operands'], required: ['operands'] },
  not: { keys: ['op', 'operand'], required: ['operand'] },
  present: { keys: ['op', 'variable', 'window'], required: ['variable'] },
  absent: { keys: ['op', 'variable', 'window'], required: ['variable'] },
  compare: {
    keys: ['op', 'variable', 'comparator', 'value', 'highValue', 'unit', 'window', 'aggregate'],
    required: ['variable', 'comparator', 'value'],
  },
  elapsed_since: { keys: ['op', 'variable', 'days', 'comparator', 'deniedSatisfies'], required: ['variable', 'days'] },
  language: { keys: ['op', 'text', 'key'], required: ['text'] },
})

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** @param {string} path @param {string} key */
const at = (path, key) => (path ? `${path}.${key}` : key)
/** @param {string} path @param {number} position */
const atIndex = (path, position) => `${path}[${position}]`

/** @param {unknown} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} value */
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** Characters, as R's `nchar()` counts them. @param {string} text */
const characters = (text) => [...text].length

/**
 * A pre-order walk state shared by the two validators: it counts nodes and
 * stops at the first limit so a huge or cyclic input costs a bounded walk.
 * @typedef {{ nodes: number, stop: boolean, issues: VcrRuleIssue[], limits: { maxDepth: number, maxNodes: number } }} WalkState
 */

/**
 * @param {WalkState} state @param {string} code @param {string} field @param {string} detail
 */
function raise(state, code, field, detail) {
  state.issues.push({ code, field, detail })
}

/**
 * Enter a node: count it, apply the depth and size limits (depth first), and
 * report whether the walk may go on.
 * @param {WalkState} state @param {string} path @param {number} depth
 */
function enter(state, path, depth) {
  state.nodes += 1
  if (depth > state.limits.maxDepth) {
    raise(state, 'rule_too_deep', path, `A rule nests at most ${state.limits.maxDepth} levels.`)
    state.stop = true
  } else if (state.nodes > state.limits.maxNodes) {
    raise(state, 'rule_too_large', path, `A rule has at most ${state.limits.maxNodes} nodes.`)
    state.stop = true
  }
  return !state.stop
}

/**
 * The op and key checks every node shares. Returns the op's key table when the
 * node is worth descending into, or `null` when it was refused.
 * @param {WalkState} state @param {any} node @param {string} path
 * @param {readonly string[]} ops @param {Record<string, { keys: string[], required: string[] }>} table
 */
function checkShape(state, node, path, ops, table) {
  if (!isPlainObject(node)) {
    raise(state, 'rule_shape_invalid', path, 'A rule node is an object.')
    return null
  }
  if (Object.hasOwn(node, 'expression')) {
    raise(state, 'rule_expression_forbidden', path, 'Rules are data in a closed grammar; an expression is never parsed.')
    return null
  }
  if (typeof node.op !== 'string') {
    raise(state, 'rule_shape_invalid', at(path, 'op'), 'A rule node names its op.')
    return null
  }
  if (!ops.includes(node.op)) {
    raise(state, 'rule_op_unknown', at(path, 'op'), `Unknown op ${JSON.stringify(node.op)}; the grammar has ${ops.join(', ')}.`)
    return null
  }
  const spec = table[node.op]
  for (const key of Object.keys(node)) {
    if (!spec.keys.includes(key)) raise(state, 'rule_shape_invalid', at(path, key), `A ${node.op} node does not take ${JSON.stringify(key)}.`)
  }
  for (const key of spec.required) {
    if (node[key] === undefined) raise(state, 'rule_shape_invalid', at(path, key), `A ${node.op} node needs ${key}.`)
  }
  return spec
}

/**
 * Descend into the children of an `all`/`any`/`not` node.
 * @param {any} node @param {string} path
 * @param {(child: any, childPath: string) => void} walk
 * @param {WalkState} state @param {number} maxOperands
 */
function descend(node, path, walk, state, maxOperands) {
  if (node.op === 'not') {
    if (node.operand !== undefined) walk(node.operand, at(path, 'operand'))
    return
  }
  if (node.operands === undefined) return
  if (!Array.isArray(node.operands) || node.operands.length < 1 || node.operands.length > maxOperands) {
    raise(state, 'rule_shape_invalid', at(path, 'operands'), `operands is a list of 1–${maxOperands} rules.`)
    return
  }
  const listPath = at(path, 'operands')
  for (let i = 0; i < node.operands.length && !state.stop; i += 1) walk(node.operands[i], atIndex(listPath, i))
}

// ---------------------------------------------------------------------------
// Row rules
// ---------------------------------------------------------------------------

/**
 * Validate a row rule. `columns`, when given, is the table the rule will run
 * on: a column outside it is refused by name (`rule_column_unknown`).
 * @param {unknown} rule
 * @param {{ columns?: readonly string[] | null, path?: string }} [options]
 * @returns {readonly VcrRuleIssue[]}
 */
export function validateRowRule(rule, { columns = null, path = '' } = {}) {
  const limits = VCR_ROW_RULE_LIMITS
  /** @type {WalkState} */
  const state = { nodes: 0, stop: false, issues: [], limits }
  const known = Array.isArray(columns) ? new Set(columns) : null

  /** @param {any} node @param {string} where @param {number} depth */
  const walk = (node, where, depth) => {
    if (state.stop || !enter(state, where, depth)) return
    const spec = checkShape(state, node, where, VCR_ROW_RULE_OPS, RULE_KEYS)
    if (!spec) return

    if (node.column !== undefined) {
      const field = at(where, 'column')
      if (typeof node.column !== 'string' || !COLUMN.test(node.column)) {
        raise(state, 'rule_shape_invalid', field, 'A column is a name of 1–64 letters, digits, "_" or ".", not starting with a digit.')
      } else if (known && !known.has(node.column)) {
        raise(state, 'rule_column_unknown', field, `The table has no column ${JSON.stringify(node.column)}.`)
      }
    }
    if (node.op === 'compare') {
      const comparator = node.comparator
      const ordering = VCR_ROW_RULE_ORDERING_COMPARATORS.includes(comparator)
      if (comparator !== undefined && !VCR_ROW_RULE_COMPARATORS.includes(comparator)) {
        raise(state, 'rule_shape_invalid', at(where, 'comparator'), `comparator is one of ${VCR_ROW_RULE_COMPARATORS.join(', ')}.`)
      }
      if (node.value !== undefined) {
        const value = node.value
        const stringOk = typeof value === 'string' && characters(value) <= limits.maxStringLength
        const ok = ordering ? isFiniteNumber(value) : (isFiniteNumber(value) || stringOk || typeof value === 'boolean')
        if (!ok) {
          raise(state, 'rule_shape_invalid', at(where, 'value'),
            ordering ? 'An ordering comparison needs a finite number.' : `value is a finite number, a string of at most ${limits.maxStringLength} characters, or a boolean.`)
        }
      }
    } else if (node.op === 'between') {
      for (const key of ['low', 'high']) {
        if (node[key] !== undefined && !isFiniteNumber(node[key])) raise(state, 'rule_shape_invalid', at(where, key), `${key} is a finite number.`)
      }
      if (isFiniteNumber(node.low) && isFiniteNumber(node.high) && node.low > node.high) {
        raise(state, 'rule_shape_invalid', at(where, 'high'), 'high is not below low.')
      }
    } else if (node.op === 'in' || node.op === 'not_in') {
      if (node.values !== undefined) {
        const field = at(where, 'values')
        if (!Array.isArray(node.values) || node.values.length < 1 || node.values.length > limits.maxValues) {
          raise(state, 'rule_shape_invalid', field, `values is a list of 1–${limits.maxValues} scalars.`)
        } else {
          node.values.forEach((/** @type {unknown} */ item, /** @type {number} */ i) => {
            const ok = isFiniteNumber(item) || typeof item === 'boolean' || (typeof item === 'string' && characters(item) <= limits.maxStringLength)
            if (!ok) raise(state, 'rule_shape_invalid', atIndex(field, i), 'A listed value is a finite number, a string or a boolean.')
          })
        }
      }
    }
    descend(node, where, (child, childPath) => walk(child, childPath, depth + 1), state, limits.maxOperands)
  }

  walk(rule, path, 1)
  return frozen(state.issues)
}

/**
 * Validate a list of `{ name, rule }` items — how a scenario names its cohort
 * steps, population constraints and quality criteria.
 * @param {unknown} items
 * @param {{ columns?: readonly string[] | null, path?: string, allowEmpty?: boolean }} [options]
 * @returns {readonly VcrRuleIssue[]}
 */
export function validateNamedRules(items, { columns = null, path = '', allowEmpty = false } = {}) {
  /** @type {VcrRuleIssue[]} */
  const issues = []
  const { maxNamedRules, maxNameLength } = VCR_ROW_RULE_LIMITS
  if (!Array.isArray(items) || (!allowEmpty && items.length < 1) || items.length > maxNamedRules) {
    return frozen([{ code: 'rule_shape_invalid', field: path, detail: `A list of named rules has ${allowEmpty ? 0 : 1}–${maxNamedRules} items.` }])
  }
  items.forEach((item, i) => {
    const where = atIndex(path, i)
    if (!isPlainObject(item)) {
      issues.push({ code: 'rule_shape_invalid', field: where, detail: 'A named rule is { name, rule }.' })
      return
    }
    if (Object.hasOwn(item, 'expression')) {
      issues.push({ code: 'rule_expression_forbidden', field: where, detail: 'Rules are data in a closed grammar; an expression is never parsed.' })
      return
    }
    for (const key of Object.keys(item)) {
      if (key !== 'name' && key !== 'rule') issues.push({ code: 'rule_shape_invalid', field: at(where, key), detail: 'A named rule is { name, rule }.' })
    }
    if (typeof item.name !== 'string' || characters(item.name) < 1 || characters(item.name) > maxNameLength) {
      issues.push({ code: 'rule_shape_invalid', field: at(where, 'name'), detail: `A rule name is 1–${maxNameLength} characters.` })
    }
    if (item.rule === undefined) issues.push({ code: 'rule_shape_invalid', field: at(where, 'rule'), detail: 'A named rule carries its rule.' })
    else issues.push(...validateRowRule(item.rule, { columns, path: at(where, 'rule') }))
  })
  return frozen(issues)
}

/**
 * The paths of every object that carries a key called `expression`. A scenario
 * with one is refused: it is the shape the first engine `eval`ed. The holder's
 * path, not the key's, because that is what the rule validators report.
 * Bounded (depth and count) and cycle-safe, because it runs on model output.
 * @param {unknown} value
 * @param {{ path?: string, limit?: number }} [options]
 * @returns {string[]}
 */
export function findExpressionFields(value, { path = '', limit = 8 } = {}) {
  /** @type {string[]} */
  const found = []
  const seen = new Set()
  /** @param {any} node @param {string} where @param {number} depth */
  const walk = (node, where, depth) => {
    if (found.length >= limit || depth > 64 || node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, atIndex(where, i), depth + 1))
      return
    }
    if (Object.hasOwn(node, 'expression')) found.push(where)
    for (const key of Object.keys(node)) walk(node[key], at(where, key), depth + 1)
  }
  walk(value, path, 0)
  return found
}

/**
 * A cell is missing when it is null, undefined or NaN (R's `NA`).
 * @param {unknown} cell
 */
const isMissing = (cell) => cell === null || cell === undefined || (typeof cell === 'number' && Number.isNaN(cell))

/**
 * @param {boolean | null} a @param {boolean | null} b
 */
const kleeneAnd = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true)
/** @param {boolean | null} a @param {boolean | null} b */
const kleeneOr = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false)

/**
 * Evaluate a row rule against one row: `true`, `false`, or `null` for 「无法判断」.
 * The rule must have passed `validateRowRule`; anything else throws.
 * @param {any} rule @param {Record<string, unknown>} row
 * @returns {boolean | null}
 */
export function evaluateRowRule(rule, row) {
  if (!isPlainObject(rule)) throw new TypeError('evaluateRowRule: a rule node is an object')
  // Own properties only: a column called `constructor` must read as missing on
  // a row that does not carry it, not as the inherited function.
  /** @param {string} column */
  const cellOf = (column) => (row && Object.hasOwn(row, column) ? row[column] : undefined)
  switch (rule.op) {
    case 'all': return rule.operands.reduce((/** @type {boolean | null} */ acc, /** @type {any} */ child) => kleeneAnd(acc, evaluateRowRule(child, row)), true)
    case 'any': return rule.operands.reduce((/** @type {boolean | null} */ acc, /** @type {any} */ child) => kleeneOr(acc, evaluateRowRule(child, row)), false)
    case 'not': {
      const inner = evaluateRowRule(rule.operand, row)
      return inner === null ? null : !inner
    }
    case 'missing': return isMissing(cellOf(rule.column))
    case 'present': return !isMissing(cellOf(rule.column))
    case 'compare': {
      const cell = cellOf(rule.column)
      if (isMissing(cell)) return null
      const { comparator, value } = rule
      if (comparator === 'eq') return typeof cell === typeof value && cell === value
      if (comparator === 'ne') return !(typeof cell === typeof value && cell === value)
      if (typeof cell !== 'number') return null
      if (comparator === 'lt') return cell < value
      if (comparator === 'lte') return cell <= value
      if (comparator === 'gt') return cell > value
      if (comparator === 'gte') return cell >= value
      throw new TypeError(`evaluateRowRule: unknown comparator ${String(comparator)}`)
    }
    case 'between': {
      const cell = cellOf(rule.column)
      if (isMissing(cell) || typeof cell !== 'number') return null
      return cell >= rule.low && cell <= rule.high
    }
    case 'in':
    case 'not_in': {
      const cell = cellOf(rule.column)
      if (isMissing(cell)) return null
      const hit = rule.values.some((/** @type {unknown} */ candidate) => typeof candidate === typeof cell && candidate === cell)
      return rule.op === 'in' ? hit : !hit
    }
    default: throw new TypeError(`evaluateRowRule: unknown op ${String(rule.op)}`)
  }
}

/**
 * The verdict column of a rule over many rows, as the parity fixture writes it.
 * @param {any} rule @param {readonly Record<string, unknown>[]} rows
 * @returns {('TRUE' | 'FALSE' | 'NA')[]}
 */
export function evaluateRowRuleColumn(rule, rows) {
  return rows.map((row) => {
    const verdict = evaluateRowRule(rule, row)
    return verdict === null ? 'NA' : verdict ? 'TRUE' : 'FALSE'
  })
}

// ---------------------------------------------------------------------------
// Eligibility requirements
// ---------------------------------------------------------------------------

/**
 * @param {WalkState} state @param {any} node @param {string} where @param {string} key
 * @param {{ days: number, months: number, years: number }} bounds
 */
function checkWindow(state, node, where, key, bounds) {
  const field = at(where, key)
  const window = node[key]
  if (!isPlainObject(window)) {
    raise(state, 'rule_shape_invalid', field, 'A window is { days }, { months } or { years }, optionally with an anchorDate.')
    return
  }
  for (const extra of Object.keys(window)) {
    if (!['days', 'months', 'years', 'anchorDate'].includes(extra)) {
      raise(state, 'rule_shape_invalid', at(field, extra), 'A window holds days, months or years, and optionally anchorDate.')
      return
    }
  }
  const units = Object.keys(window).filter((name) => name !== 'anchorDate')
  if (units.length !== 1) {
    raise(state, 'rule_shape_invalid', field, 'A window is exactly one of { days }, { months } or { years }.')
    return
  }
  const unit = /** @type {'days' | 'months' | 'years'} */ (units[0])
  const max = bounds[unit]
  const value = window[unit]
  if (!(Number.isInteger(value) && value >= 1 && value <= max)) {
    raise(state, 'rule_shape_invalid', at(field, unit), `${unit} is an integer from 1 to ${max}.`)
  }
  if (window.anchorDate !== undefined && !(typeof window.anchorDate === 'string' && ISO_DATE.test(window.anchorDate)
    && Number.isFinite(Date.parse(window.anchorDate)))) {
    raise(state, 'rule_shape_invalid', at(field, 'anchorDate'), 'anchorDate is an ISO date (YYYY-MM-DD, optionally with a time).')
  }
}

/**
 * Validate an eligibility requirement (contract §2.2). The evaluator answers
 * UNKNOWN for anything outside this grammar; this is what refuses it at write
 * time instead (`vcr_criterion_malformed`, per criterion).
 * @param {unknown} requirement
 * @param {{ path?: string }} [options]
 * @returns {readonly VcrRuleIssue[]}
 */
export function validateRequirement(requirement, { path = '' } = {}) {
  const limits = VCR_REQUIREMENT_LIMITS
  /** @type {WalkState} */
  const state = { nodes: 0, stop: false, issues: [], limits }
  const windowBounds = { days: limits.windowDaysMax, months: limits.windowMonthsMax, years: limits.windowYearsMax }

  /** @param {any} node @param {string} where @param {number} depth */
  const walk = (node, where, depth) => {
    if (state.stop || !enter(state, where, depth)) return
    const spec = checkShape(state, node, where, VCR_REQUIREMENT_OPS, REQUIREMENT_KEYS)
    if (!spec) return

    if (node.variable !== undefined && (typeof node.variable !== 'string' || !VARIABLE.test(node.variable))) {
      raise(state, 'rule_shape_invalid', at(where, 'variable'), 'A variable is a lowercase name of 1–64 letters, digits or "_".')
    }
    if (node.window !== undefined) checkWindow(state, node, where, 'window', windowBounds)

    if (node.op === 'compare') {
      const comparator = node.comparator
      const known = VCR_REQUIREMENT_COMPARATORS.includes(comparator)
      if (comparator !== undefined && !known) {
        raise(state, 'rule_shape_invalid', at(where, 'comparator'), `comparator is one of ${VCR_REQUIREMENT_COMPARATORS.join(', ')}.`)
      }
      const value = node.value
      const stringOk = typeof value === 'string' && value.length > 0 && characters(value) <= limits.maxStringLength
      if (value !== undefined && known) {
        const field = at(where, 'value')
        if (comparator === 'in' || comparator === 'not_in') {
          if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxValues) {
            raise(state, 'rule_shape_invalid', field, `${comparator} needs a list of 1–${limits.maxValues} values.`)
          } else {
            value.forEach((item, i) => {
              const ok = isFiniteNumber(item) || (typeof item === 'string' && item.length > 0 && characters(item) <= limits.maxStringLength)
              if (!ok) raise(state, 'rule_shape_invalid', atIndex(field, i), 'A listed value is a finite number or a non-empty string.')
            })
          }
        } else if (comparator === 'eq' || comparator === 'ne') {
          if (!(isFiniteNumber(value) || stringOk)) raise(state, 'rule_shape_invalid', field, `${comparator} needs one number or one non-empty string.`)
        } else if (!isFiniteNumber(value)) {
          raise(state, 'rule_shape_invalid', field, `${comparator} needs a finite number.`)
        }
      }
      if (node.highValue !== undefined) {
        const field = at(where, 'highValue')
        if (comparator !== 'between') raise(state, 'rule_shape_invalid', field, 'Only between takes a highValue.')
        else if (!isFiniteNumber(node.highValue) || (isFiniteNumber(value) && node.highValue < value)) {
          raise(state, 'rule_shape_invalid', field, 'highValue is a finite number not below value.')
        }
      } else if (comparator === 'between') {
        raise(state, 'rule_shape_invalid', at(where, 'highValue'), 'between needs a highValue.')
      }
      if (node.unit !== undefined && !(typeof node.unit === 'string' && node.unit.length > 0 && characters(node.unit) <= limits.maxUnitLength)) {
        raise(state, 'rule_shape_invalid', at(where, 'unit'), `unit is 1–${limits.maxUnitLength} characters.`)
      }
      if (node.aggregate !== undefined && !VCR_REQUIREMENT_AGGREGATES.includes(node.aggregate)) {
        raise(state, 'rule_shape_invalid', at(where, 'aggregate'), `aggregate is one of ${VCR_REQUIREMENT_AGGREGATES.join(', ')}.`)
      }
    } else if (node.op === 'elapsed_since') {
      if (node.days !== undefined && !(Number.isInteger(node.days) && node.days >= 1 && node.days <= limits.elapsedDaysMax)) {
        raise(state, 'rule_shape_invalid', at(where, 'days'), `days is an integer from 1 to ${limits.elapsedDaysMax}.`)
      }
      if (node.comparator !== undefined && !VCR_ELAPSED_COMPARATORS.includes(node.comparator)) {
        raise(state, 'rule_shape_invalid', at(where, 'comparator'), 'An elapsed_since comparator is gte (at least N days) or gt (more than N days).')
      }
      if (node.deniedSatisfies !== undefined && typeof node.deniedSatisfies !== 'boolean') {
        raise(state, 'rule_shape_invalid', at(where, 'deniedSatisfies'), 'deniedSatisfies is true or false.')
      }
    } else if (node.op === 'language') {
      if (node.text !== undefined && !(typeof node.text === 'string' && characters(node.text) >= 1 && characters(node.text) <= limits.maxLanguageText)) {
        raise(state, 'rule_shape_invalid', at(where, 'text'), `text is 1–${limits.maxLanguageText} characters.`)
      }
      if (node.key !== undefined && !(typeof node.key === 'string' && LANGUAGE_KEY.test(node.key))) {
        raise(state, 'rule_shape_invalid', at(where, 'key'), `A language key is 1–${limits.languageKeyMax} characters of [A-Za-z0-9_.:-].`)
      }
    }
    descend(node, where, (child, childPath) => walk(child, childPath, depth + 1), state, limits.maxOperands)
  }

  walk(requirement, path, 1)
  return frozen(state.issues)
}
