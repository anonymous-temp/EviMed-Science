/**
 * The profile of a generated population: the one block of an engine result the
 * 人群 tab draws a scenario, literature or synthetic population from.
 *
 * Hidden knowledge:
 *
 * - **The population page could show nothing of a generated population.** A
 *   `population.scenario` result carried two counts and a constraint table, the
 *   engine had just generated a thousand records, and the tab was empty. The
 *   engine now describes its own table, from the table alone, in
 *   `diagnostics.profile` (`R/population.R`, `vcr_population_profile`), for the
 *   three methods that generate one: `population.scenario`,
 *   `population.literature` and `population.synthpop`. This file is the
 *   contract of that block, so the control plane and the page read one shape and
 *   not the shape each remembers.
 * - **One entry per variable**, in column order:
 *   `{ variable, label, kind, declared, n, missing, … }` with, for a continuous
 *   variable, `mean sd median q1 q3 min max` and a `histogram` of seven equal
 *   bins (`breaks` of eight edges, `counts` of seven), and for a binary or
 *   categorical one, `levels: [{ level, n, p }]`. `declared` repeats what the
 *   scenario (or the baseline table) stated — `{ family, params, constraints }` —
 *   so a page can set "stated" beside "generated"; empirical synthesis states
 *   nothing and its `declared` is `null`. Numbers are rounded to four
 *   significant digits by the engine, once; counts are integers.
 * - **Suppression is a visible state, never a silent gap.** An empirical
 *   synthetic table is made from real people, so a level below the small-cell
 *   floor is `{ level, n: null, p: null, suppressed: true }`, a histogram bin it
 *   hides is `null`, the variable's `suppressed` list names the fields it
 *   withheld (`levels`, `histogram`, `min`, `max`, `missing`), and a table that
 *   cannot be shown without disclosing a cell says `withheld` and lists no
 *   levels. A `null` is only valid where the entry says it withheld that field:
 *   a missing number that nothing explains is a defect, not a suppression.
 * - Pure and browser-safe, like the rest of the domain: it validates, it never
 *   repairs, and it is not a gate — a profile that fails is a notice for the
 *   caller to drop, not a reason to withhold the population.
 *
 * @module @evimed/domain/vcrPopulationProfile
 */

/** @template T @param {readonly T[]} list @returns {readonly T[]} */
const frozen = (list) => Object.freeze([...list])

/** What a variable is, as the profile names it. */
export const VCR_PROFILE_KINDS = frozen(['continuous', 'binary', 'categorical'])

/** The histogram of a continuous variable has this many equal bins (one more edge). */
export const VCR_PROFILE_HISTOGRAM_BINS = 7

/** The fields of a continuous entry that can be withheld, by the name its `suppressed` list gives. */
export const VCR_PROFILE_CONTINUOUS_FIELDS = frozen(['mean', 'sd', 'median', 'q1', 'q3', 'min', 'max'])

/** @typedef {{ code: string, field: string, detail: string }} VcrProfileIssue */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
/** @param {unknown} value @returns {value is number} */
const isCount = (value) => isNumber(value) && Number.isInteger(value) && value >= 0

/**
 * Validate the `diagnostics.profile` of a population result. An empty list of
 * issues is a valid profile.
 *
 * @param {unknown} profile
 * @returns {readonly VcrProfileIssue[]}
 */
export function validatePopulationProfile(profile) {
  /** @type {VcrProfileIssue[]} */
  const issues = []
  const bad = (/** @type {string} */ code, /** @type {string} */ field, /** @type {string} */ detail) => issues.push({ code, field, detail })
  if (!Array.isArray(profile)) return frozen([{ code: 'profile_not_list', field: '', detail: 'A profile is a list with one entry per variable.' }])
  if (profile.length > 500) bad('profile_too_long', '', 'A profile describes at most 500 variables.')
  const seen = new Set()

  profile.forEach((entry, index) => {
    const at = `[${index}]`
    if (!isObject(entry)) { bad('entry_not_object', at, 'A profile entry is an object.'); return }
    if (typeof entry.variable !== 'string' || !entry.variable) bad('variable_missing', `${at}.variable`, 'An entry names its variable.')
    else if (seen.has(entry.variable)) bad('variable_duplicate', `${at}.variable`, 'A variable appears once.')
    else seen.add(entry.variable)
    if (entry.label !== null && typeof entry.label !== 'string') bad('label_invalid', `${at}.label`, 'A label is text, or null when the scenario gave none.')
    if (!VCR_PROFILE_KINDS.includes(entry.kind)) bad('kind_invalid', `${at}.kind`, `kind is one of ${VCR_PROFILE_KINDS.join(', ')}.`)
    const declared = entry.declared
    if (declared !== null) {
      if (!isObject(declared) || typeof declared.family !== 'string' || !isObject(declared.params) || !Array.isArray(declared.constraints)) {
        bad('declared_invalid', `${at}.declared`, 'declared is null (nothing was stated) or { family, params, constraints }.')
      }
    }
    if (!isCount(entry.n)) bad('n_invalid', `${at}.n`, 'n is the number of rows, a whole number.')
    const suppressed = new Set(Array.isArray(entry.suppressed) ? entry.suppressed : [])
    if (entry.suppressed !== undefined && !Array.isArray(entry.suppressed)) bad('suppressed_invalid', `${at}.suppressed`, 'suppressed lists the fields that were withheld.')
    if (entry.missing === null) {
      if (!suppressed.has('missing')) bad('missing_unexplained', `${at}.missing`, 'A missing count is null only when the entry says it withheld it.')
    } else if (!isCount(entry.missing) || (isCount(entry.n) && entry.missing > entry.n)) {
      bad('missing_invalid', `${at}.missing`, 'missing is a whole number of rows, at most n.')
    }
    const observed = isCount(entry.n) && isCount(entry.missing) ? entry.n - entry.missing : null

    if (entry.kind === 'continuous') {
      /** @type {Record<string, number | null>} */
      const values = {}
      for (const field of VCR_PROFILE_CONTINUOUS_FIELDS) {
        const value = entry[field]
        if (value === null || value === undefined) {
          // an entry with no observed value has no summary at all; otherwise only a withheld field may be null
          if (!suppressed.has(field) && !(observed === 0 && entry.histogram === null)) bad('summary_unexplained', `${at}.${field}`, `${field} is a number, or null when the entry says it withheld it.`)
          values[field] = null
        } else if (!isNumber(value)) bad('summary_invalid', `${at}.${field}`, `${field} is a finite number.`)
        else values[field] = value
      }
      const { q1, median, q3, min, max, sd } = values
      if (sd !== null && sd < 0) bad('sd_negative', `${at}.sd`, 'A standard deviation is not negative.')
      const order = [min, q1, median, q3, max].filter((value) => value !== null && value !== undefined)
      if (order.some((value, i) => i > 0 && value < /** @type {number} */ (order[i - 1]))) bad('summary_order', at, 'min <= q1 <= median <= q3 <= max.')
      const histogram = entry.histogram
      if (histogram === null) {
        if (observed !== 0 && observed !== null) bad('histogram_missing', `${at}.histogram`, 'A continuous variable with values has a histogram.')
      } else if (!isObject(histogram) || !Array.isArray(histogram.breaks) || !Array.isArray(histogram.counts)) {
        bad('histogram_invalid', `${at}.histogram`, 'A histogram is { breaks, counts }.')
      } else {
        const { breaks, counts } = histogram
        if (counts.length !== VCR_PROFILE_HISTOGRAM_BINS) bad('histogram_bins', `${at}.histogram.counts`, `A histogram has ${VCR_PROFILE_HISTOGRAM_BINS} bins.`)
        if (![VCR_PROFILE_HISTOGRAM_BINS, VCR_PROFILE_HISTOGRAM_BINS + 1].includes(breaks.length) || !breaks.every(isNumber) || breaks.some((edge, i) => i > 0 && !(edge > breaks[i - 1]))) {
          bad('histogram_breaks', `${at}.histogram.breaks`, 'The breaks are the bins\' edges, strictly increasing.')
        }
        const hidden = counts.filter((/** @type {unknown} */ count) => count === null).length
        if (counts.some((/** @type {unknown} */ count) => count !== null && !isCount(count))) bad('histogram_count_invalid', `${at}.histogram.counts`, 'A bin count is a whole number, or null for a bin that was withheld.')
        if (hidden && !suppressed.has('histogram')) bad('histogram_unexplained', `${at}.histogram.counts`, 'A null bin is only valid when the entry says it withheld the histogram.')
        if (hidden === 1) bad('histogram_complement', `${at}.histogram.counts`, 'One hidden bin can be recovered from the total and the rest; the small cells are hidden together.')
        const total = counts.reduce((/** @type {number} */ sum, /** @type {unknown} */ count) => sum + (isCount(count) ? count : 0), 0)
        if (observed !== null && total > observed) bad('histogram_total', `${at}.histogram.counts`, 'The bins hold more rows than there are observed values.')
        else if (!hidden && observed !== null && total !== observed) bad('histogram_total', `${at}.histogram.counts`, 'The bins hold every observed value.')
      }
      if (entry.levels !== undefined) bad('levels_on_continuous', `${at}.levels`, 'A continuous variable has no levels.')
    } else if (entry.kind === 'binary' || entry.kind === 'categorical') {
      if (entry.histogram !== undefined) bad('histogram_on_levels', `${at}.histogram`, 'A binary or categorical variable has no histogram.')
      const levels = entry.levels
      if (!Array.isArray(levels)) bad('levels_missing', `${at}.levels`, 'A binary or categorical variable lists its levels.')
      else {
        if (typeof entry.withheld === 'string' && levels.length) bad('withheld_with_levels', `${at}.levels`, 'A table that was withheld lists no levels.')
        if (entry.kind === 'binary' && levels.length > 2) bad('binary_levels', `${at}.levels`, 'A binary variable has at most two levels.')
        let total = 0
        let hiddenLevels = 0
        levels.forEach((/** @type {any} */ level, /** @type {number} */ i) => {
          const where = `${at}.levels[${i}]`
          if (!isObject(level) || typeof level.level !== 'string') { bad('level_invalid', where, 'A level is { level, n, p }.'); return }
          if (level.n === null || level.suppressed === true) {
            hiddenLevels += 1
            if (level.n !== null || level.p !== null || level.suppressed !== true) bad('level_suppression', where, 'A withheld level is { level, n: null, p: null, suppressed: true }.')
            if (!suppressed.has('levels')) bad('level_unexplained', where, 'A level is withheld only when the entry says it withheld its levels.')
          } else {
            if (!isCount(level.n)) bad('level_count', `${where}.n`, 'n is a whole number of rows.')
            else total += level.n
            if (!isNumber(level.p) || level.p < 0 || level.p > 1) {
              if (level.p !== null || observed !== 0) bad('level_share', `${where}.p`, 'p is a share between 0 and 1.')
            } else if (observed && isCount(level.n) && Math.abs(level.p - level.n / observed) > 1e-3 * Math.max(level.p, 1e-3) + 1e-9) {
              bad('level_share', `${where}.p`, 'p is n over the observed rows.')
            }
          }
        })
        if (observed !== null && total > observed) bad('levels_total', `${at}.levels`, 'The levels hold more rows than there are observed values.')
        else if (observed !== null && !hiddenLevels && !entry.withheld && total !== observed) bad('levels_total', `${at}.levels`, 'The levels hold every observed value.')
        if (hiddenLevels === 1 && levels.length > 1) bad('level_complement', `${at}.levels`, 'One hidden level can be recovered from the total and the rest; the small cells are hidden together.')
      }
    }
  })
  return frozen(issues)
}
