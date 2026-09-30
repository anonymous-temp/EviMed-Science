/**
 * Small-cell suppression for what a model may read (integration contract §4).
 *
 * Hidden knowledge:
 *
 * - **A count of one person is not a number, it is a person.** Below
 *   `VCR_MIN_CELL_SIZE` a head count is withheld from the model, because a
 *   model that reads 「3 名患者有该基因突变」 has read something the study's own
 *   data plane refused to let out (plan §8.1). The first build suppressed one
 *   shape — a `cells` array — that nothing in the system produces; the stores
 *   produce `counts: { realPatients, … }`, `waterfall[]`, `diagnostics.arms[]`
 *   and `levels: { A: 12 }`. So this walks every object and array it is given,
 *   and reads the names in `VCR_PEOPLE_COUNT_FIELDS`.
 * - **Two shapes, two rules.** A count that stands alone (`counts.events: 3`)
 *   becomes `null` and its object says which keys it hid (`suppressed`). A count
 *   in a list of sibling cells (an array of `{ arm, n }`, or a `levels` map) is
 *   different: hiding one cell and printing the others lets anyone subtract it
 *   from the total, and a cell of zero says nobody is there. So the small cells
 *   — zero included — are hidden together, and the hidden set is topped up with
 *   the next-smallest cells until it holds at least `minCell` people in at least
 *   two cells (build ruling, plan §8.1, `vcrDataPlane.suppressSmallCells`); if
 *   even every cell together is too few, the whole table is withheld. A hidden
 *   cell keeps what it *is* and loses every number it carried: a count hidden
 *   while its mean stays visible reproduces the people.
 * - **A cell with several count keys is judged by its smallest.** `{ n: 40,
 *   events: 2 }` discloses two people however large `n` is; its size, for the
 *   arithmetic above, is 2.
 * - **A null is not a person.** Only a finite number is a head count; a `null`
 *   count key is a value that was never known (an evidence row's missing
 *   `events`), and reading it as one hollowed every published figure a model
 *   was handed. A `null` counts only where the object's own `suppressed` list
 *   names it — a cell this boundary already hid.
 * - **A measure is a count by its name.** The engine reports a cohort's size as
 *   `{ name: 'cohort_size', value: 3 }`; a boundary that reads keys alone lets it
 *   out. A measure whose name is in `VCR_PEOPLE_COUNT_MEASURES` answers to the
 *   standalone rule, and a hidden one keeps its name and loses its value, its
 *   interval and its note. The scalar keys of `VCR_PEOPLE_COUNT_SCALAR_FIELDS`
 *   (`startingRows`, `rows`, …) answer to the same rule and are never cells.
 * - **Never a complement.** The suppression does not emit what it hid, in any
 *   form (`suppressedCount`, a remainder, a share, a merged bucket's total); a
 *   complement the engine wrote is dropped.
 * - **Every walker refuses what it cannot finish.** A cyclic payload, or one
 *   nested past a depth no store produces, throws: a boundary that stops
 *   walking and lets the rest through is a boundary with a hole.
 * - Pure: the input is never modified; the answer is a copy.
 *
 * @module @evimed/domain/vcrSuppression
 */

import {
  VCR_MIN_CELL_SIZE, VCR_PEOPLE_COUNT_FIELDS, VCR_PEOPLE_COUNT_MAP_KEYS, VCR_PEOPLE_COUNT_MEASURES, VCR_PEOPLE_COUNT_SCALAR_FIELDS,
} from './vcrVocabulary.mjs'

/** Complements an engine may have written; never passed on. */
const COMPLEMENT_KEYS = Object.freeze(['suppressedCount', 'suppressedLevels'])

/**
 * What a hidden cell keeps: the words that say which cell it was. A closed
 * list, because any other key may carry the very number that was hidden.
 */
export const VCR_CELL_IDENTITY_KEYS = Object.freeze([
  'key', 'label', 'name', 'group', 'stratum', 'arm', 'level', 'cell', 'step', 'rule', 'category', 'variable', 'criterion',
])

/** How deep a payload may nest before it is refused. Real payloads nest a dozen levels. */
const MAX_DEPTH = 200

/** @param {unknown} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** @param {unknown} value */
const isCount = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * The people-count keys a cell carries: those holding a finite number, and
 * those holding `null` that the cell's own `suppressed` list names (a cell this
 * boundary already hid, which is as disclosive as a small one). A `null` nobody
 * hid is an unknown, and an unknown is not a person.
 * @param {Record<string, any>} cell
 */
function countKeys(cell) {
  const named = Array.isArray(cell.suppressed) ? cell.suppressed : []
  return VCR_PEOPLE_COUNT_FIELDS.filter((key) => Object.hasOwn(cell, key) && (isCount(cell[key]) || (cell[key] === null && named.includes(key))))
}

/**
 * A cell's size: its smallest count. An unknown count reads as zero.
 * @param {Record<string, any>} cell
 */
function sizeOf(cell) {
  return Math.min(...countKeys(cell).map((key) => cell[key] ?? 0))
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isCell = (value) => isPlainObject(value) && countKeys(value).length > 0

/**
 * Which of a list of sizes to hide, as indexes: everything under the floor,
 * then the smallest of the rest until the hidden set holds `minCell` people in
 * at least two cells. When even all of them together do not, every index comes
 * back — the table as a whole is too small to show.
 * @param {readonly number[]} sizes @param {number} minCell
 * @returns {Set<number>}
 */
function hiddenSet(sizes, minCell) {
  const hidden = new Set(sizes.map((size, at) => (size < minCell ? at : -1)).filter((at) => at >= 0))
  if (!hidden.size) return hidden
  const rest = sizes.map((size, at) => ({ size, at })).filter((entry) => !hidden.has(entry.at)).sort((a, b) => a.size - b.size || a.at - b.at)
  const held = () => [...hidden].reduce((total, at) => total + sizes[at], 0)
  while ((hidden.size < 2 || held() < minCell) && rest.length) hidden.add(/** @type {{ at: number }} */ (rest.shift()).at)
  // Everything absorbed and still short: the table as a whole is too small to show.
  if (hidden.size < 2 || held() < minCell) return new Set(sizes.map((_size, at) => at))
  return hidden
}

/**
 * A cell with its numbers taken away.
 * @param {Record<string, any>} cell
 */
function hiddenCell(cell) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of VCR_CELL_IDENTITY_KEYS) {
    if (Object.hasOwn(cell, key) && !VCR_PEOPLE_COUNT_FIELDS.includes(key) && (typeof cell[key] === 'string' || isCount(cell[key]))) out[key] = cell[key]
  }
  const keys = countKeys(cell)
  for (const key of keys) out[key] = null
  out.suppressed = keys
  return out
}

/**
 * The standalone rule: a count of 1 to `minCell - 1` becomes null and the
 * object lists the keys it hid.
 * @param {Record<string, any>} object @param {number} minCell
 * @param {readonly string[]} keys the keys this object answers for
 */
function hideStandaloneCounts(object, minCell, keys) {
  /** @type {string[]} */
  const hidden = []
  for (const key of keys) {
    const value = object[key]
    if (isCount(value) && value >= 1 && value < minCell) {
      object[key] = null
      hidden.push(key)
    }
  }
  if (hidden.length) {
    const already = Array.isArray(object.suppressed) ? object.suppressed.filter((/** @type {unknown} */ item) => typeof item === 'string') : []
    object.suppressed = [...new Set([...already, ...hidden])]
  }
}

/**
 * A measure whose name counts people and whose value is small, with its numbers
 * taken away: what it is stays, what it said does not (a note or an interval
 * could carry the very count that was hidden).
 * @param {Record<string, any>} measure
 */
function hiddenMeasure(measure) {
  /** @type {Record<string, any>} */
  const out = { name: measure.name }
  for (const key of ['unit', 'source', 'simulated']) if (Object.hasOwn(measure, key)) out[key] = measure[key]
  out.value = null
  out.suppressed = ['value']
  return out
}

/**
 * @param {Record<string, any>} object @param {number} minCell
 */
const isSmallCountMeasure = (object, minCell) => typeof object.name === 'string' && VCR_PEOPLE_COUNT_MEASURES.includes(object.name)
  && isCount(object.value) && object.value >= 1 && object.value < minCell

/**
 * Suppress what a model must not read: every people-count below `minCell`.
 * Objects and arrays are walked to any depth (up to a refusal, never a cut-off
 * that passes data through); the input is not modified.
 *
 * The answer has the input's shape with counts replaced by `null` and a
 * `suppressed` list added where one was hidden, so it is not typed as the input.
 *
 * @param {unknown} payload
 * @param {{ minCell?: number }} [options]
 * @returns {any}
 */
export function suppressForModel(payload, { minCell = VCR_MIN_CELL_SIZE } = {}) {
  if (!Number.isInteger(minCell) || minCell < 2) throw new RangeError('suppressForModel: minCell is an integer of at least 2')
  /** @type {Set<unknown>} */
  const ancestors = new Set()

  /**
   * @param {any} value @param {string | null} key @param {number} depth
   * @param {boolean} [asCell] a list member the enclosing list judges as a cell, so its own counts are left for that judgement
   * @returns {any}
   */
  const walk = (value, key, depth, asCell = false) => {
    if (value === null || typeof value !== 'object') return value
    if (depth > MAX_DEPTH) throw new TypeError(`suppressForModel: the payload nests deeper than ${MAX_DEPTH} levels`)
    if (ancestors.has(value)) throw new TypeError('suppressForModel: the payload refers to itself')
    if (!Array.isArray(value) && !isPlainObject(value)) return value
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        const items = value.map((item) => walk(item, null, depth + 1, isCell(item)))
        const cellAt = items.map((item, at) => (isCell(item) ? at : -1)).filter((at) => at >= 0)
        if (!cellAt.length) return items
        const hidden = hiddenSet(cellAt.map((at) => sizeOf(items[at])), minCell)
        const hiddenAt = new Set([...hidden].map((at) => cellAt[at]))
        return items.map((item, at) => (hiddenAt.has(at) ? hiddenCell(item) : item))
      }
      if (key !== null && VCR_PEOPLE_COUNT_MAP_KEYS.includes(key)) {
        const names = Object.keys(value)
        if (names.length && names.every((name) => isCount(value[name]))) {
          const hidden = hiddenSet(names.map((name) => value[name]), minCell)
          /** @type {Record<string, any>} */
          const shown = {}
          names.forEach((name, at) => {
            Object.defineProperty(shown, name, { value: hidden.has(at) ? null : value[name], enumerable: true, writable: true, configurable: true })
          })
          return shown
        }
      }
      /** @type {Record<string, any>} */
      const out = {}
      for (const own of Object.keys(value)) {
        if (COMPLEMENT_KEYS.includes(own)) continue
        // A property named `__proto__` is data here, and must stay data.
        Object.defineProperty(out, own, { value: walk(value[own], own, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      // A list member's counts wait for the list's own judgement (`hiddenSet`);
      // every other object answers to the standalone rule. The scalar keys are
      // never a list's cells, so they answer to it wherever they are.
      hideStandaloneCounts(out, minCell, VCR_PEOPLE_COUNT_SCALAR_FIELDS)
      if (!asCell) hideStandaloneCounts(out, minCell, VCR_PEOPLE_COUNT_FIELDS)
      return isSmallCountMeasure(out, minCell) ? hiddenMeasure(out) : out
    } finally {
      ancestors.delete(value)
    }
  }

  return walk(payload, null, 0)
}
