/**
 * Do the numbers an extraction carries agree with each other? A pure function over values somebody (a run, a registry) read out of a source
 * (algorithm round E2, 2026-11-03).
 *
 * The platform already holds one check on every extracted value: the quotation is in the preserved text and every number is in the quotation.
 * That says the value was copied from where it claims. It does not say the source, or the copy, is internally consistent: a hazard ratio of 0.62
 * with an interval of 0.48 to 0.95 can be quoted word for word and still have one number transcribed wrong. No study has measured how many
 * extraction errors this catches (the survey's own words); it is the cheapest check there is, needs no model and no network, and an error it
 * finds is a number the reader should look at first. It is run where an extracted value is saved and where a card is made of it, and its
 * findings are a sentence in the tool's answer and a ⚠ on the card. Never a refusal: the value stands as it was read.
 *
 * Hidden knowledge:
 *
 * - **The tolerance is the printed precision, and nothing else.** A number written to `d` decimals stands for any true value within
 *   half of the last printed place, so every check asks whether *some* true values inside those rounding boxes would satisfy the identity, and
 *   speaks only when none can (interval arithmetic, not a percentage slack). A number that lost its trailing zeros on the way (0.50 stored as
 *   0.5) has a wider box than the paper's, never a narrower one, so the check errs towards silence.
 * - **Symmetry is a Wald interval's property.** A hazard, odds or risk ratio with a Wald interval is symmetric about its estimate on the log
 *   scale, and a difference or a mean on the plain scale; the check is run only for a quantity whose published interval is usually of that kind
 *   (the caller says which: `scale`). A proportion's (Wilson, Clopper-Pearson) and a median's (Brookmeyer-Crowley) are not, and are only held to
 *   "the estimate is inside its interval". A paper that used a profile-likelihood or exact interval can fail the symmetry check honestly; the
 *   sentence says so, and says the reading to check first is the transcription.
 * - **A p-value is held to the interval only where the two must agree.** The p of a log-rank test and the interval of a Cox model differ
 *   slightly, so the p is not recomputed from the interval; what must agree is the verdict: an interval that contains the null cannot go with a
 *   p-value below the interval's own level, nor one that excludes it with a p-value above. When the interval's level is not stated the
 *   contradiction has to hold at every level in `P_LEVELS` (90%, 95%, 99%), so a 90% interval beside p = 0.07 is not a finding.
 * - **A rate is held to its own counts, in either spelling.** `events / sampleSize` against the value, read as a fraction and as a percentage:
 *   a stored 12.4 and a stored 0.124 are one rate, the way the quotation check reads them (`numberIsInQuote`).
 * - **Arms are held to the total in one direction.** The arms of one comparison can add up to less than everyone enrolled (some left, some
 *   were not analysed); they cannot add up to more. Planned enrolment is not a total and is left out.
 * - **A finding is a sentence about numbers, not a verdict about the paper.** Each names the numbers it compared; the caller shows it
 *   as advice and the value stays as it was read (owner rulings 2026-09-17 and 2026-10-10: a gate verdict never withholds a delivery).
 *
 * @module @evimed/domain/vcrValueConsistency
 */

/** The interval levels a p-value is compared against when the source does not say which one its interval is. */
export const P_LEVELS = Object.freeze([0.9, 0.95, 0.99])

/**
 * One value somebody read out of a source.
 * @typedef {object} ExtractedValue
 * @property {string} [id] what a finding names this value by (the evidence item's id)
 * @property {string} [label] how a reader calls the quantity (「风险比」); absent, 「这条抽取值」
 * @property {string | null} [arm] the arm or contrast the value belongs to, as the source names it
 * @property {string | null} [armRole] control, treatment, contrast, single_arm, overall or unknown
 * @property {'log' | 'identity' | null} [scale] the scale on which the quantity's published interval is symmetric about its estimate
 * @property {number | null} [nullValue] the value meaning no effect (1 for a ratio, 0 for a difference), when the quantity has one
 * @property {boolean} [rate] the value is a share of people, and `events` over `sampleSize` is what it must come to
 * @property {number | null} [value]
 * @property {string | null} [unit]
 * @property {number | null} [ciLow]
 * @property {number | null} [ciHigh]
 * @property {number | null} [ciLevel] the interval's level as a fraction (0.95), when the source states it
 * @property {number | null} [pValue] the printed p-value
 * @property {'=' | '<' | '>' | null} [pRelation] how it was printed: p = 0.03, p < 0.001, p > 0.05
 * @property {number | null} [sampleSize] the people the value was measured on (or, for a count of participants, the count)
 * @property {number | null} [events]
 * @property {string | null} [trial] the trial the value belongs to; totals and arms are only compared within one
 * @property {string | null} [set] the group of arm values that are the arms of one comparison (one outcome at one time)
 * @property {boolean} [planned] the count is a plan (estimated enrolment), not what happened
 */

/**
 * One thing that does not agree.
 * @typedef {object} ValueFinding
 * @property {'ratio_not_positive' | 'interval_reversed' | 'value_outside_interval' | 'interval_not_symmetric' | 'p_contradicts_interval'
 *   | 'events_exceed_n' | 'events_rate_mismatch' | 'arms_exceed_total'} code
 * @property {string[]} ids the values it is about
 * @property {string} message one sentence naming the numbers
 * @property {Record<string, number | string>} numbers the numbers it compared, for a log line
 */

/** @param {unknown} value @returns {number | null} */
function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** How many decimals a number is written with, after the noise of a unit conversion is taken off (12.4 / 100 is 0.12400000000000001). @param {number} value */
function decimalsOf(value) {
  const written = String(Number(Math.abs(value).toPrecision(12)))
  const at = written.search(/e/i)
  if (at < 0) return (written.split('.')[1] ?? '').length
  const mantissa = written.slice(0, at)
  const exponent = Number(written.slice(at + 1))
  return Math.max(0, (mantissa.split('.')[1] ?? '').length - exponent)
}

/** Half of the last printed place: how far the true value of a printed number can be from it. @param {number} value */
export function printedHalfUnit(value) {
  return 0.5 * 10 ** -decimalsOf(value)
}

/** @param {number} value */
function show(value) {
  return String(Number(value.toPrecision(6)))
}

/** @param {ExtractedValue} value */
function nameOf(value) {
  const arm = value.arm ? `（${value.arm}）` : ''
  return `${value.label || '这条抽取值'}${arm}`
}

/**
 * The checks over one value alone: an interval the right way round holding its estimate, symmetric about it on the scale it is published on, a
 * p-value that agrees with it, and counts that make the rate.
 * @param {ExtractedValue} value @returns {ValueFinding[]}
 */
function checkOne(value) {
  /** @type {ValueFinding[]} */
  const found = []
  const id = String(value.id ?? '')
  const ids = id ? [id] : []
  const v = finite(value.value)
  const low = finite(value.ciLow)
  const high = finite(value.ciHigh)
  const who = nameOf(value)
  const scale = value.scale ?? null

  if (scale === 'log') {
    const bad = [['估计值', v], ['区间下限', low], ['区间上限', high]].filter(([, n]) => n !== null && /** @type {number} */ (n) <= 0)
    if (bad.length) {
      found.push({ code: 'ratio_not_positive', ids, numbers: Object.fromEntries(bad.map(([name, n]) => [String(name), /** @type {number} */ (n)])),
        message: `${who}：${bad.map(([name, n]) => `${name} ${show(/** @type {number} */ (n))}`).join('、')} 不大于 0，一个比值不会是这样。` })
      return found.concat(checkCounts(value, ids, who))
    }
  }

  if (low !== null && high !== null) {
    if (low > high) {
      found.push({ code: 'interval_reversed', ids, numbers: { low, high },
        message: `${who}：区间下限 ${show(low)} 大于上限 ${show(high)}，两个数写反了或抄错了一个。` })
    } else if (v !== null && (v + printedHalfUnit(v) < low - printedHalfUnit(low) || v - printedHalfUnit(v) > high + printedHalfUnit(high))) {
      found.push({ code: 'value_outside_interval', ids, numbers: { value: v, low, high },
        message: `${who}：估计值 ${show(v)} 不在它自己的区间 ${show(low)}–${show(high)} 之内。` })
    } else if (v !== null && scale) {
      const broken = symmetryBreak(scale, v, low, high)
      if (broken) {
        found.push({ code: 'interval_not_symmetric', ids, numbers: { value: v, low, high, midpoint: broken.midpoint, allowedLow: broken.allowedLow, allowedHigh: broken.allowedHigh },
          message: `${who}：估计值 ${show(v)}、区间 ${show(low)}–${show(high)}。这类区间在${scale === 'log' ? '对数' : ''}尺度上应对称于估计值，`
            + `${scale === 'log' ? '几何' : '算术'}中点是 ${show(broken.midpoint)}（按写出的位数，允许在 ${show(broken.allowedLow)} 到 ${show(broken.allowedHigh)} 之间），对不上；`
            + '先核对三个数有没有抄错，论文用了非对称的区间算法也会这样。' })
      }
    }
  }

  const pValue = finite(value.pValue)
  const nullValue = finite(value.nullValue)
  if (pValue !== null && nullValue !== null && low !== null && high !== null && low <= high && pValue >= 0 && pValue <= 1) {
    const verdict = pAgainstInterval({ low, high, nullValue, pValue, relation: value.pRelation ?? '=', level: finite(value.ciLevel) })
    if (verdict) {
      const printed = `${value.pRelation && value.pRelation !== '=' ? value.pRelation : '='} ${show(pValue)}`
      found.push({ code: 'p_contradicts_interval', ids, numbers: { low, high, nullValue, pValue, ...(verdict.level ? { level: verdict.level } : {}) },
        message: `${who}：区间 ${show(low)}–${show(high)}${verdict.includesNull ? '包含' : '不包含'} ${show(nullValue)}（${verdict.includesNull ? '不显著' : '显著'}），`
          + `而写出的 p ${printed} 却${verdict.includesNull ? '' : '没有'}达到${verdict.level ? `${Math.round(verdict.level * 100)}% 的` : '常用的'}显著性水平，两者对不上；核对 p 值和区间是不是同一个比较。` })
    }
  }
  return found.concat(checkCounts(value, ids, who))
}

/**
 * Do the interval's two ends and the estimate fit a symmetric interval under the rounding of all three? `null` when some true values do.
 * @param {'log' | 'identity'} scale @param {number} v @param {number} low @param {number} high
 * @returns {{ midpoint: number, allowedLow: number, allowedHigh: number } | null}
 */
function symmetryBreak(scale, v, low, high) {
  const [uv, ul, uh] = [printedHalfUnit(v), printedHalfUnit(low), printedHalfUnit(high)]
  if (scale === 'log') {
    // A box that reaches 0 puts no bound on the log: the number is too coarse to be checked.
    if (!(v - uv > 0 && low - ul > 0 && high - uh > 0)) return null
    const [valueLow, valueHigh] = [Math.log(v - uv), Math.log(v + uv)]
    const [midLow, midHigh] = [(Math.log(low - ul) + Math.log(high - uh)) / 2, (Math.log(low + ul) + Math.log(high + uh)) / 2]
    if (valueHigh >= midLow && midHigh >= valueLow) return null
    return { midpoint: Math.exp((Math.log(low) + Math.log(high)) / 2), allowedLow: Math.exp(midLow), allowedHigh: Math.exp(midHigh) }
  }
  const [midLow, midHigh] = [(low - ul + high - uh) / 2, (low + ul + high + uh) / 2]
  if (v + uv >= midLow && midHigh >= v - uv) return null
  return { midpoint: (low + high) / 2, allowedLow: midLow, allowedHigh: midHigh }
}

/**
 * Does the printed p-value disagree with the interval about whether the null is excluded? `null` when they can agree.
 * @param {{ low: number, high: number, nullValue: number, pValue: number, relation: string, level: number | null }} input
 * @returns {{ includesNull: boolean, level: number | null } | null}
 */
function pAgainstInterval({ low, high, nullValue, pValue, relation, level }) {
  const [ul, uh, up] = [printedHalfUnit(low), printedHalfUnit(high), printedHalfUnit(pValue)]
  const includes = low + ul <= nullValue && high - uh >= nullValue
  const excludes = low - ul > nullValue || high + uh < nullValue
  if (!includes && !excludes) return null
  // The range of true p-values the printing stands for.
  const range = relation === '<' ? [0, pValue] : relation === '>' ? [pValue, 1] : [Math.max(0, pValue - up), Math.min(1, pValue + up)]
  const levels = level !== null && level > 0 && level < 1 ? [level] : P_LEVELS
  // Below the level (significant) with an interval holding the null, or at/above it (not significant) with an interval that excludes it,
  // at every level that could be the interval's. A printed bound (p < 0.05) may touch the level; a printed value may not.
  const alpha = (/** @type {number} */ each) => Math.round((1 - each) * 1e6) / 1e6
  const significant = levels.every((each) => (relation === '<' ? range[1] <= alpha(each) : range[1] < alpha(each)))
  const insignificant = levels.every((each) => (relation === '>' ? range[0] >= alpha(each) : range[0] > alpha(each)))
  if (includes && significant) return { includesNull: true, level: levels.length === 1 ? levels[0] : null }
  if (excludes && insignificant) return { includesNull: false, level: levels.length === 1 ? levels[0] : null }
  return null
}

/**
 * Counts against the rate they must make: more events than people, and `events / sampleSize` against the stated share.
 * @param {ExtractedValue} value @param {string[]} ids @param {string} who @returns {ValueFinding[]}
 */
function checkCounts(value, ids, who) {
  const events = finite(value.events)
  const n = finite(value.sampleSize)
  if (events === null || n === null || n <= 0 || events < 0) return []
  if (events > n) {
    return [{ code: 'events_exceed_n', ids, numbers: { events, sampleSize: n },
      message: `${who}：事件数 ${show(events)} 多于样本量 ${show(n)}。` }]
  }
  const v = finite(value.value)
  if (!value.rate || v === null) return []
  const exact = events / n
  // A stored share can be a fraction or a percentage whatever its unit says (the quotation check reads both); it is wrong when neither fits.
  const readings = [{ fraction: v, box: printedHalfUnit(v) }, { fraction: v / 100, box: printedHalfUnit(v) / 100 }]
  if (readings.some((reading) => Math.abs(reading.fraction - exact) <= reading.box + 1e-9)) return []
  return [{ code: 'events_rate_mismatch', ids, numbers: { events, sampleSize: n, rate: exact, value: v },
    message: `${who}：${show(events)} 例 / ${show(n)} 人是 ${show(Math.round(exact * 1e5) / 1e3)}%，与写出的 ${show(v)}${value.unit ? (value.unit === '%' ? '%' : ` ${value.unit}`) : ''} 对不上。` }]
}

/**
 * The arms of one comparison against everyone enrolled in the trial.
 * @param {readonly ExtractedValue[]} values @returns {ValueFinding[]}
 */
function checkArmsAgainstTotal(values) {
  /** @type {Map<string, number>} */
  const totals = new Map()
  /** @type {Map<string, Map<string, Map<string, { n: number, id: string }>>>} */
  const sets = new Map()
  for (const value of values) {
    const trial = String(value.trial ?? '')
    const n = finite(value.sampleSize)
    if (!trial || n === null || n < 0) continue
    if (value.armRole === 'overall') {
      if (value.planned !== true) totals.set(trial, Math.max(totals.get(trial) ?? 0, n))
    } else if (value.armRole === 'control' || value.armRole === 'treatment') {
      const set = String(value.set ?? '')
      const arm = String(value.arm ?? '')
      if (!set || !arm) continue
      const bySet = sets.get(trial) ?? new Map()
      const arms = bySet.get(set) ?? new Map()
      if (!arms.has(arm)) arms.set(arm, { n, id: String(value.id ?? '') })
      bySet.set(set, arms)
      sets.set(trial, bySet)
    }
  }
  /** @type {ValueFinding[]} */
  const found = []
  for (const [trial, bySet] of sets) {
    const total = totals.get(trial)
    if (total === undefined) continue
    for (const arms of bySet.values()) {
      if (arms.size < 2) continue
      const sum = [...arms.values()].reduce((all, arm) => all + arm.n, 0)
      if (sum <= total) continue
      const parts = [...arms.values()].map((arm) => show(arm.n))
      found.push({ code: 'arms_exceed_total', ids: [...arms.values()].map((arm) => arm.id).filter(Boolean), numbers: { sum, total },
        message: `各组人数 ${parts.join(' + ')} = ${show(sum)}，比同一试验写出的总人数 ${show(total)} 还多。` })
    }
  }
  return found
}

/**
 * Every disagreement among the numbers of these extracted values. Pure and deterministic; the same values give the same findings in the
 * same order. A value that carries none of the numbers a check needs is passed over by that check, not reported.
 * @param {readonly ExtractedValue[]} values @returns {ValueFinding[]}
 */
export function extractedValueConsistency(values) {
  const list = Array.isArray(values) ? values.filter((value) => value && typeof value === 'object') : []
  return [...list.flatMap(checkOne), ...checkArmsAgainstTotal(list)]
}
