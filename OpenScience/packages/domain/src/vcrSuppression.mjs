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
 * - **Counts that make each other.** `n = events + nonEvents`, and the rate of the events is `events / n`: one hidden alone, with the
 *   others printed, is a subtraction. When one of the pair is small the whole identity goes (the people, the events, the non-events)
 *   and so does what is computed from it (`VCR_PEOPLE_COUNT_LINKS`); the measures that restate such a rate go with it
 *   (`VCR_PEOPLE_DERIVED_MEASURES`).
 * - **A mean is not a count.** A key that holds a mean, a share or a median is never in these lists, whatever it is called: a restatement
 *   of the people a trimming removed names its means `keptMean` / `removedMean`, and when the group is under the floor the engine does
 *   not state the mean at all (a mean of three people is three people's values). The totals and the parts that make each other (the
 *   rows a table started from, used and left out; a trimming's arm cell `n = kept + removed`) go together (`VCR_PEOPLE_COUNT_LINKS`,
 *   and the cell rule for the arms). The size of the table itself (`counts.realPatients`) stands beside them in another object and is
 *   not closed over: that complement is the one thing this walk cannot see.
 * - **A count may be a count only where it sits.** `treated`, `control`, `people` and `records` are head counts inside the blocks that
 *   say so (`VCR_PEOPLE_COUNT_BLOCK_FIELDS`: the enrolment-year cells, a batch reading's estimate) and a design's planned sample or a
 *   covariate's mean anywhere else; the block names the keys, nothing is judged by a bare key. An arm's head count under the arm's name
 *   (`{ treated: 3, control: 40 }`, `VCR_PEOPLE_COUNT_MAP_KEYS`) is a row of sibling cells like `levels`, and a block that summarises
 *   one group of people is withheld whole when the group is too small to show (`VCR_PEOPLE_COUNT_WITHHELD_BLOCKS`).
 * - Pure: the input is never modified; the answer is a copy.
 *
 * @module @evimed/domain/vcrSuppression
 */

import {
  VCR_MIN_CELL_SIZE, VCR_PEOPLE_COUNT_BLOCK_FIELDS, VCR_PEOPLE_COUNT_FIELDS, VCR_PEOPLE_COUNT_LINKS, VCR_PEOPLE_COUNT_MAP_KEYS,
  VCR_PEOPLE_COUNT_MEASURES, VCR_PEOPLE_COUNT_SCALAR_FIELDS, VCR_PEOPLE_COUNT_WITHHELD_BLOCKS, VCR_PEOPLE_DERIVED_MEASURES,
} from './vcrVocabulary.mjs'

/** Complements an engine may have written; never passed on. */
const COMPLEMENT_KEYS = Object.freeze(['suppressedCount', 'suppressedLevels'])

/**
 * What a hidden cell keeps: the words that say which cell it was. A closed
 * list, because any other key may carry the very number that was hidden.
 */
export const VCR_CELL_IDENTITY_KEYS = Object.freeze([
  'key', 'label', 'name', 'group', 'stratum', 'arm', 'level', 'cell', 'step', 'rule', 'category', 'variable', 'criterion', 'year',
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
 * The count keys in force for one object: the contract's, and the ones the block it sits in adds.
 * @param {readonly string[] | null | undefined} block
 * @returns {readonly string[]}
 */
const fieldsOf = (block) => (block ? [...VCR_PEOPLE_COUNT_FIELDS, ...block] : VCR_PEOPLE_COUNT_FIELDS)

/**
 * The people-count keys a cell carries: those holding a finite number, and
 * those holding `null` that the cell's own `suppressed` list names (a cell this
 * boundary already hid, which is as disclosive as a small one). A `null` nobody
 * hid is an unknown, and an unknown is not a person.
 * @param {Record<string, any>} cell @param {readonly string[]} [fields]
 */
function countKeys(cell, fields = VCR_PEOPLE_COUNT_FIELDS) {
  const named = Array.isArray(cell.suppressed) ? cell.suppressed : []
  return fields.filter((key) => Object.hasOwn(cell, key) && (isCount(cell[key]) || (cell[key] === null && named.includes(key))))
}

/**
 * A cell's size: its smallest count. An unknown count reads as zero.
 * @param {Record<string, any>} cell @param {readonly string[]} [fields]
 */
function sizeOf(cell, fields = VCR_PEOPLE_COUNT_FIELDS) {
  return Math.min(...countKeys(cell, fields).map((key) => cell[key] ?? 0))
}

/** @param {unknown} value @param {readonly string[]} [fields] @returns {value is Record<string, any>} */
const isCell = (value, fields = VCR_PEOPLE_COUNT_FIELDS) => isPlainObject(value) && countKeys(value, fields).length > 0

/**
 * Which of a list of sizes to hide, as indexes: everything under the floor,
 * then the smallest of the rest until the hidden set holds `minCell` people in
 * at least two cells. When even all of them together do not, every index comes
 * back — the table as a whole is too small to show.
 * @param {readonly number[]} sizes @param {number} minCell
 * @returns {Set<number>}
 */
export function hiddenSet(sizes, minCell) {
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
 * @param {Record<string, any>} cell @param {readonly string[]} [fields]
 */
function hiddenCell(cell, fields = VCR_PEOPLE_COUNT_FIELDS) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const key of VCR_CELL_IDENTITY_KEYS) {
    if (Object.hasOwn(cell, key) && !fields.includes(key) && (typeof cell[key] === 'string' || isCount(cell[key]))) out[key] = cell[key]
  }
  const keys = countKeys(cell, fields)
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

/** @param {unknown} value @param {number} minCell */
const isSmall = (value, minCell) => isCount(value) && /** @type {number} */ (value) >= 1 && /** @type {number} */ (value) < minCell

/**
 * Keys of an object, hidden: each becomes null and the object lists it as hidden.
 * @param {Record<string, any>} object @param {readonly string[]} keys
 */
function hideKeys(object, keys) {
  if (!keys.length) return
  for (const key of keys) object[key] = null
  const already = Array.isArray(object.suppressed) ? object.suppressed.filter((/** @type {unknown} */ item) => typeof item === 'string') : []
  object.suppressed = [...new Set([...already, ...keys])]
}

/**
 * The counts that make each other (`VCR_PEOPLE_COUNT_LINKS`): when one of a link's triggers is a small count, the whole identity goes
 * with it when the object holds all of it, and so does everything computed from it. Runs before the standalone rule, which hides the
 * small count itself.
 * @param {Record<string, any>} object @param {number} minCell
 */
function hideLinkedCounts(object, minCell) {
  for (const link of VCR_PEOPLE_COUNT_LINKS) {
    if (!link.triggers.some((key) => isSmall(object[key], minCell))) continue
    const whole = link.whole.every((key) => isCount(object[key])) ? link.whole : []
    hideKeys(object, [...whole, ...link.derived].filter((key) => isCount(object[key])))
  }
}

/**
 * A block about one group of people, withheld when the group is too small to show (`VCR_PEOPLE_COUNT_WITHHELD_BLOCKS`): what it is
 * stays, what it summarised does not. Judged on the block after its own counts were hidden, so a map that lost an entry gates it.
 * @param {string | null} key @param {Record<string, any>} block
 */
function withheldBlock(key, block) {
  const rule = key !== null && Object.hasOwn(VCR_PEOPLE_COUNT_WITHHELD_BLOCKS, key) ? /** @type {Record<string, any>} */ (VCR_PEOPLE_COUNT_WITHHELD_BLOCKS)[key] : null
  if (!rule) return block
  // a gate is a map of arm to head count with an entry hidden, or a head count hidden alone (it says so in `suppressed`)
  const hiddenAlone = (/** @type {string} */ gate) => block[gate] === null && Array.isArray(block.suppressed) && block.suppressed.includes(gate)
  const gated = rule.gates.some((/** @type {string} */ gate) => (isPlainObject(block[gate]) ? Object.values(block[gate]).some((entry) => entry === null) : hiddenAlone(gate)))
  if (!gated) return block
  /** @type {Record<string, any>} */
  const kept = {}
  for (const own of rule.keep) if (Object.hasOwn(block, own)) kept[own] = block[own]
  kept.suppressed = Object.keys(block).filter((own) => !rule.keep.includes(own) && own !== 'suppressed')
  return kept
}

/**
 * The measures a local calibration restates (`VCR_PEOPLE_DERIVED_MEASURES`), hidden once the calibration block hid the field they
 * restate.
 * @param {Record<string, any>} object
 */
function hideDerivedMeasures(object) {
  if (!Array.isArray(object.measures) || !isPlainObject(object.diagnostics) || !isPlainObject(object.diagnostics.localCalibration)) return
  const hidden = Array.isArray(object.diagnostics.localCalibration.suppressed) ? object.diagnostics.localCalibration.suppressed : []
  const names = /** @type {string[]} */ (Object.entries(VCR_PEOPLE_DERIVED_MEASURES).filter(([field]) => hidden.includes(field)).map(([, name]) => name))
  if (!names.length) return
  object.measures = object.measures.map((/** @type {unknown} */ measure) => (isPlainObject(measure) && names.includes(String(measure.name)) ? hiddenMeasure(measure) : measure))
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
   * @param {readonly string[] | null} [inherited] the keys the block this object is a direct member of adds to the contract's
   * @returns {any}
   */
  const walk = (value, key, depth, asCell = false, inherited = null) => {
    if (value === null || typeof value !== 'object') return value
    if (depth > MAX_DEPTH) throw new TypeError(`suppressForModel: the payload nests deeper than ${MAX_DEPTH} levels`)
    if (ancestors.has(value)) throw new TypeError('suppressForModel: the payload refers to itself')
    if (!Array.isArray(value) && !isPlainObject(value)) return value
    ancestors.add(value)
    try {
      // The count keys this block adds: the ones of the name it was found under, for itself (an object) or for its members (a list).
      const block = key !== null && Object.hasOwn(VCR_PEOPLE_COUNT_BLOCK_FIELDS, key)
        ? /** @type {Record<string, readonly string[]>} */ (VCR_PEOPLE_COUNT_BLOCK_FIELDS)[key] : null
      if (Array.isArray(value)) {
        const fields = fieldsOf(block)
        const items = value.map((item) => walk(item, null, depth + 1, isCell(item, fields), block))
        const cellAt = items.map((item, at) => (isCell(item, fields) ? at : -1)).filter((at) => at >= 0)
        if (!cellAt.length) return items
        const hidden = hiddenSet(cellAt.map((at) => sizeOf(items[at], fields)), minCell)
        const hiddenAt = new Set([...hidden].map((at) => cellAt[at]))
        return items.map((item, at) => (hiddenAt.has(at) ? hiddenCell(item, fields) : item))
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
      // (the linked counts first: a total whose part is a scalar count is hidden with it before the part itself becomes null)
      if (!asCell) hideLinkedCounts(out, minCell)
      hideStandaloneCounts(out, minCell, VCR_PEOPLE_COUNT_SCALAR_FIELDS)
      if (!asCell) hideStandaloneCounts(out, minCell, fieldsOf(block ?? inherited))
      hideDerivedMeasures(out)
      return isSmallCountMeasure(out, minCell) ? hiddenMeasure(out) : withheldBlock(key, out)
    } finally {
      ancestors.delete(value)
    }
  }

  return walk(payload, null, 0)
}
