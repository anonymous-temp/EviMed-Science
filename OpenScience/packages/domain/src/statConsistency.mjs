/**
 * Whether a report's statistics agree with themselves.
 *
 * Hidden knowledge: which statistical errors are decidable without judging a
 * word. statcheck recomputes a p value from the test statistic and degrees of
 * freedom a paper reports and compares it with the p value the paper states;
 * its published sensitivity is 85–100% at a specificity of 96–100%, where a
 * general model asked the same question reached about half (J Korean Med Sci
 * 2025). The same arithmetic covers the other thing a clinical report states
 * over and over — an effect estimate with its 95% confidence interval and a
 * p value — because a Wald interval fixes the p value up to rounding (Altman &
 * Bland, BMJ 2011;343:d2090) and an estimate outside its own interval is
 * wrong whatever the study.
 *
 * On 2026-09-22 the platform's reviewer told a run that a pooled log odds
 * ratio of 0.73 (95% CI 0.46–1.00) 「跨越无效线」: on the log scale the null is
 * 0, not 1, and the interval excludes it. A model judged a scale; this module
 * does not have to, because the measure's name says which null applies.
 *
 * What it reads is statistical notation — a closed grammar of test names,
 * measure abbreviations, operators and numbers — never prose (principle 5).
 * Everything it reports is advice until its false-positive rate has been
 * read off real submissions (principle 4).
 *
 * @module @evimed/domain/statConsistency
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

/** ln Γ(x) for x > 0 (Lanczos, g = 7). @param {number} x @returns {number} */
export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x)
  const shifted = x - 1
  let sum = 0.99999999999980993
  for (let index = 0; index < LANCZOS.length; index += 1) sum += LANCZOS[index] / (shifted + index + 1)
  const t = shifted + LANCZOS.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum)
}

/** Continued fraction for the incomplete beta (modified Lentz).
 * @param {number} x @param {number} a @param {number} b */
function betaFraction(x, a, b) {
  const tiny = 1e-300
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 400; m += 1) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-14) break
  }
  return h
}

/** The regularized incomplete beta I_x(a, b). @param {number} x @param {number} a @param {number} b @returns {number} */
export function incompleteBeta(x, a, b) {
  if (!(x > 0)) return 0
  if (x >= 1) return 1
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(x, a, b)) / a
    : 1 - (front * betaFraction(1 - x, b, a)) / b
}

/** The regularized upper incomplete gamma Q(a, x). @param {number} a @param {number} x @returns {number} */
export function upperGamma(a, x) {
  if (!(x > 0)) return 1
  if (x < a + 1) {
    let term = 1 / a
    let sum = term
    for (let n = 1; n <= 1000; n += 1) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
  }
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let n = 1; n <= 1000; n += 1) {
    const an = -n * (n - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

/**
 * The two-sided p value of a test statistic.
 * @param {'t'|'F'|'chi2'|'z'|'r'} test @param {number} value @param {number[]} df
 * @returns {number | null} null when the statistic cannot have that value
 */
export function twoSidedP(test, value, df = []) {
  if (!Number.isFinite(value)) return null
  if (test === 'z') return upperGamma(0.5, (value * value) / 2)
  if (test === 't') {
    const [nu] = df
    if (!(nu > 0)) return null
    return incompleteBeta(nu / (nu + value * value), nu / 2, 0.5)
  }
  if (test === 'r') {
    const [nu] = df
    if (!(nu > 0) || Math.abs(value) >= 1) return null
    const t = value * Math.sqrt(nu / (1 - value * value))
    return incompleteBeta(nu / (nu + t * t), nu / 2, 0.5)
  }
  if (test === 'F') {
    const [d1, d2] = df
    if (!(d1 > 0 && d2 > 0) || value < 0) return null
    return incompleteBeta(d2 / (d2 + d1 * value), d2 / 2, d1 / 2)
  }
  if (test === 'chi2') {
    const [nu] = df
    if (!(nu > 0) || value < 0) return null
    return upperGamma(nu / 2, value / 2)
  }
  return null
}

/** Half a unit in the last place a number was written with.
 * @param {string} written @returns {number} */
function roundingHalfWidth(written) {
  const decimals = /\.(\d+)/.exec(written)?.[1]?.length ?? 0
  return 0.5 * 10 ** -decimals
}

/** @param {string} written @returns {number} */
function parseNumber(written) {
  return Number(String(written).replace(/^[−–—]/, '-').replace(/^\./, '0.').replace(/^-\./, '-0.'))
}

const NUMBER = String.raw`[-−]?(?:\d+(?:\.\d+)?|\.\d+)`
const OPERATOR = String.raw`(?:<=|>=|≤|≥|=|<|>|＜|＞|＝)`
const P_VALUE = String.raw`(?<![A-Za-z])[pP]\s*(?:值)?\s*(${OPERATOR})\s*(${NUMBER})`

/** The test statistics statcheck reads, with their degrees of freedom.
 * @type {readonly { test: 't'|'F'|'chi2'|'z'|'r', pattern: RegExp }[]} */
const TEST_PATTERNS = [
  { test: 't', pattern: new RegExp(String.raw`(?<![A-Za-z])t\s*[(（]\s*(\d+(?:\.\d+)?)\s*[)）]\s*[=＝]\s*(${NUMBER})`, 'g') },
  { test: 'F', pattern: new RegExp(String.raw`(?<![A-Za-z])F\s*[(（]\s*(\d+(?:\.\d+)?)\s*[,，]\s*(\d+(?:\.\d+)?)\s*[)）]\s*[=＝]\s*(${NUMBER})`, 'g') },
  { test: 'chi2', pattern: new RegExp(String.raw`(?:χ\s*[2²]|X\s*[2²]|chi-?squared?)\s*[(（]\s*(\d+(?:\.\d+)?)\s*(?:[,，]\s*[nN]\s*[=＝]\s*\d+\s*)?[)）]\s*[=＝]\s*(${NUMBER})`, 'gi') },
  { test: 'r', pattern: new RegExp(String.raw`(?<![A-Za-z])r\s*[(（]\s*(\d+(?:\.\d+)?)\s*[)）]\s*[=＝]\s*(${NUMBER})`, 'g') },
  { test: 'z', pattern: new RegExp(String.raw`(?<![A-Za-z])[zZ]\s*(?:值)?\s*[=＝]\s*(${NUMBER})`, 'g') },
]

/** How far after a statistic its p value may sit and still be its own. */
const P_WINDOW = 48

/**
 * Effect measures by the scale their null lives on. Ratios are compared on
 * the log scale with a null of 1; differences on the linear scale with a null
 * of 0. A log ratio is a difference, which is the case a reader gets wrong.
 */
const RATIO_MEASURES = [
  'aHR', 'HR', 'aOR', 'OR', 'aRR', 'RR', 'IRR', 'sHR', 'SHR', 'DOR',
  'hazard ratio', 'odds ratio', 'risk ratio', 'relative risk', 'rate ratio', 'incidence rate ratio',
  '风险比', '危险比', '比值比', '优势比', '相对危险度', '相对风险', '发病率比',
]
const DIFFERENCE_MEASURES = [
  'log OR', 'log HR', 'log RR', 'log odds ratio', 'log hazard ratio', 'log risk ratio',
  'WMD', 'SMD', 'MD', 'ARD', 'RD', 'β',
  'mean difference', 'standardized mean difference', 'standardised mean difference', 'risk difference',
  '均数差', '均值差', '标准化均数差', '风险差', '率差',
]

/** @param {string} measure @returns {boolean} */
function isRatioMeasure(measure) {
  const spelled = measure.replace(/\s+/g, ' ').trim().toLowerCase()
  return RATIO_MEASURES.some((name) => name.toLowerCase() === spelled)
}

const MEASURE = [...DIFFERENCE_MEASURES, ...RATIO_MEASURES]
  .sort((left, right) => right.length - left.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*'))
  .join('|')

const RANGE_SEPARATOR = String.raw`(?:\s*(?:-|–|—|~|～|〜|至|到|to|,|，)\s*)`
const CI_LABEL = String.raw`(?:95\s*%\s*(?:CI|CrI|置信区间|可信区间)|95\s*%\s*的?置信区间)`
const ESTIMATE_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z])(${MEASURE})(?![A-Za-z])\s*(?:值)?\s*(?:[=＝:：,，]|为|是|of|was|is)?\s*(${NUMBER})\s*[（(,，;；]?\s*${CI_LABEL}\s*[:：=＝,，]?\s*[（(\[]?\s*(${NUMBER})${RANGE_SEPARATOR}(${NUMBER})\s*[)）\]]?`,
  'gi',
)

/**
 * @typedef {object} StatFinding
 * @property {'stat-p-inconsistent'|'estimate-outside-ci'|'ci-p-inconsistent'} check
 * @property {number} line          1-based line in the text
 * @property {string} excerpt       the notation as written
 * @property {boolean} gross        whether the significance decision at 0.05 flips
 * @property {string} message       a sentence a researcher can act on
 * @property {Record<string, number | string | null>} computed
 */

/**
 * @param {string} operator @returns {'='|'<'|'>'}
 */
function normalizedOperator(operator) {
  if (['<', '<=', '≤', '＜'].includes(operator)) return '<'
  if (['>', '>=', '≥', '＞'].includes(operator)) return '>'
  return '='
}

/**
 * Whether a stated p value could be the computed one, allowing for rounding
 * of both the statistic (already folded into [low, high]) and the p value.
 * @param {{ operator: '='|'<'|'>', value: number, written: string }} stated
 * @param {number} low @param {number} high
 */
function pAgrees(stated, low, high) {
  if (stated.operator === '<') return low < stated.value
  if (stated.operator === '>') return high > stated.value
  const half = roundingHalfWidth(stated.written)
  return high >= stated.value - half && low <= stated.value + half
}

/** @param {{ operator: '='|'<'|'>', value: number }} stated */
function statedSignificant(stated) {
  if (stated.operator === '<') return stated.value <= 0.05
  if (stated.operator === '>') return false
  return stated.value < 0.05
}

/** The p value written after a statistic, when there is one close enough.
 * @param {string} text @param {number} from */
function pAfter(text, from) {
  const window = text.slice(from, from + P_WINDOW)
  const match = new RegExp(P_VALUE).exec(window)
  if (!match) return null
  // Only punctuation may stand between a notation and its p. Anything else —
  // a word, a second statistic, another outcome after a closing bracket — and
  // the p is somebody else's: 「OR 1.916，95% CI 0.999–3.674），LVEF 改善（p <
  // 0.01」 reports the LVEF finding's p, not the odds ratio's.
  const between = window.slice(0, match.index)
  if (!/^[\s)）\][,，;；:：]*$/.test(between)) return null
  const written = match[2]
  return { operator: normalizedOperator(match[1]), value: parseNumber(written), written, end: from + match.index + match[0].length }
}

/**
 * Every decidable inconsistency in a text's statistics.
 * @param {string} text
 * @returns {StatFinding[]}
 */
export function statConsistencyFindings(text) {
  const source = String(text ?? '')
  /** @type {StatFinding[]} */
  const findings = []
  const lineOf = (/** @type {number} */ index) => source.slice(0, index).split('\n').length

  for (const { test, pattern } of TEST_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const groups = match.slice(1)
      const written = /** @type {string} */ (groups.at(-1))
      const df = groups.slice(0, -1).map(Number)
      const stated = pAfter(source, (match.index ?? 0) + match[0].length)
      if (!stated || !(stated.value >= 0 && stated.value <= 1)) continue
      const value = Math.abs(parseNumber(written))
      const half = roundingHalfWidth(written)
      // A larger statistic is a smaller p: the interval's ends swap.
      const pHigh = twoSidedP(test, Math.max(0, value - half), df)
      const pLow = twoSidedP(test, value + half, df)
      const pPoint = twoSidedP(test, value, df)
      if (pHigh == null || pLow == null || pPoint == null) continue
      if (pAgrees(stated, pLow, pHigh)) continue
      const gross = statedSignificant(stated) !== (pPoint < 0.05)
      const excerpt = source.slice(match.index ?? 0, stated.end)
      findings.push({
        check: 'stat-p-inconsistent',
        line: lineOf(match.index ?? 0),
        excerpt,
        gross,
        message: `「${excerpt}」：按检验统计量与自由度重算的双侧 p 约为 ${formatP(pPoint)}，与写出的 p ${stated.operator === '=' ? '=' : stated.operator} ${stated.written} 不符${gross ? '，且是否显著的结论相反' : ''}。请核对统计量、自由度与 p 值的来源。`,
        computed: { test, p: round(pPoint, 6), statedP: stated.written, operator: stated.operator },
      })
    }
  }

  ESTIMATE_PATTERN.lastIndex = 0
  for (const match of source.matchAll(ESTIMATE_PATTERN)) {
    const [, measureRaw, estimateWritten, lowerWritten, upperWritten] = match
    const measure = measureRaw.replace(/\s+/g, ' ')
    const ratio = isRatioMeasure(measure)
    const estimate = parseNumber(estimateWritten)
    let lower = parseNumber(lowerWritten)
    let upper = parseNumber(upperWritten)
    if (![estimate, lower, upper].every(Number.isFinite)) continue
    if (lower > upper) [lower, upper] = [upper, lower]
    const start = match.index ?? 0
    const excerptEnd = start + match[0].length
    const line = lineOf(start)
    // Ratios live on (0, ∞); an interval that crosses zero is not a ratio's,
    // whatever it is labelled — say nothing rather than guess.
    if (ratio && (estimate <= 0 || lower <= 0)) continue
    const tolerance = Math.max(roundingHalfWidth(estimateWritten), roundingHalfWidth(lowerWritten), roundingHalfWidth(upperWritten))
    if (estimate < lower - tolerance || estimate > upper + tolerance) {
      const excerpt = source.slice(start, excerptEnd)
      findings.push({
        check: 'estimate-outside-ci',
        line,
        excerpt,
        gross: true,
        message: `「${excerpt}」：点估计 ${estimateWritten} 落在它自己的 95% 置信区间 ${lowerWritten}–${upperWritten} 之外——要么有一个数抄错了，要么把不同尺度的估计与区间写在了一起（如 β 与 exp(β) 的区间）。请回到来源核对。`,
        computed: { measure, estimate, lower, upper },
      })
      continue
    }
    const stated = pAfter(source, excerptEnd)
    if (!stated || !(stated.value >= 0 && stated.value <= 1)) continue
    const nullValue = ratio ? 1 : 0
    const lowerHalf = roundingHalfWidth(lowerWritten)
    const upperHalf = roundingHalfWidth(upperWritten)
    // A bound that equals the null to its written precision is the boundary
    // case: significance there depends on digits the report did not keep.
    if (Math.abs(lower - nullValue) <= lowerHalf || Math.abs(upper - nullValue) <= upperHalf) continue
    const excludesNull = lower > nullValue || upper < nullValue
    const significant = statedSignificant(stated)
    if (excludesNull === significant) continue
    // Near the threshold an interval and a p from two different methods (an
    // exact test beside a Wald interval) disagree legitimately; what is left
    // outside the band is an error in one of the two numbers.
    if (stated.operator === '=' && stated.value >= 0.04 && stated.value <= 0.06) continue
    const excerpt = source.slice(start, stated.end)
    findings.push({
      check: 'ci-p-inconsistent',
      line,
      excerpt,
      gross: true,
      message: excludesNull
        ? `「${excerpt}」：95% 置信区间 ${lowerWritten}–${upperWritten} 不含无效值 ${nullValue}（${ratio ? '比值类指标' : '差值类指标'}），却写 p ${stated.operator === '=' ? '=' : stated.operator} ${stated.written}（不显著）。两者至少有一个与来源不符。`
        : `「${excerpt}」：95% 置信区间 ${lowerWritten}–${upperWritten} 包含无效值 ${nullValue}（${ratio ? '比值类指标' : '差值类指标'}），却写 p ${stated.operator === '=' ? '=' : stated.operator} ${stated.written}（显著）。两者至少有一个与来源不符。`,
      computed: { measure, nullValue, lower, upper, statedP: stated.written, operator: stated.operator },
    })
  }
  return findings.sort((left, right) => left.line - right.line)
}

/** @param {number} value @param {number} digits */
function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** @param {number} p @returns {string} */
function formatP(p) {
  if (p < 0.001) return '<0.001'
  return String(round(p, p < 0.01 ? 4 : 3))
}
