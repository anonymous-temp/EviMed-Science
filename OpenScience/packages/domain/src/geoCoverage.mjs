/**
 * What a 「循证 GEO」 reading was measured OVER — the coverage key (R14 N-4) — and whether two readings may be compared.
 *
 * A trend is a series of readings, and a reading is only a point on it when the rounds behind it measured the same thing. A round
 * that heard from four engines and one that heard from five do not share a denominator: the mention rate over five engines
 * dropping three points is a statement about 豆包 joining the sample as much as about the product. The page used to state that as
 * 「比上次低 3 个百分点」. The key makes the question decidable: two readings are compared when their keys are equal and in no
 * other case, and a pair that is not comparable is said so, in words, never as an arrow.
 *
 * Hidden knowledge:
 *
 * - **What the key is made of** is what the round actually measured, not what it planned: the engines that have an answer in it
 *   (the same set the diagnosis prints as 「按 N 个引擎」), the question set's version and the pools of the questions that were
 *   answered, and the probe surface (web or app, deep thinking, a fresh chat for each question, the city). It is the registry's own
 *   list — `net_effect.comparability_keys`: question set version, surface, engines — with the pool added, because a pool that
 *   produced no answer in a round changes what the project-wide rate is over.
 * - **The key is derived, never stored**: the server reads it from a round's snapshots on the way out (`geoCoverageKey`), so a
 *   round measured before anything recorded its balance has one, and a change to this definition is a change to the code only.
 * - **The key is a string** that survives JSON, equal exactly when the coverage is, and readable: `v2|P1,P2,P3,P4|deepseek,doubao,kimi|web`.
 *   `geoCoverageDifference` takes two of them apart, so the sentence can say which part moved.
 * - **Unknown is not equal**: a reading with no key (null) is of a round that has no answer to name a coverage from; it is not
 *   compared with anything, and says so differently from a change.
 *
 * @module geoCoverage
 */

/** Where the parts of a key are told apart, and the values within a part. The values never contain either. */
const PART = '|'
const VALUE = ','

/** @param {unknown} value */
function clean(value) {
  return String(value ?? '').replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** @param {readonly unknown[] | null | undefined} values */
function sortedSet(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))].sort()
}

/**
 * The part of a key that names the probe surface: the fields of a round's `surface` that change what an engine is asked and how it
 * answers — the mode (web by default), deep thinking, a new chat for each question, the city. Fields a round records for other
 * reasons (the transport, a response digest, an intervention snapshot) are not coverage.
 * @param {Record<string, unknown> | null | undefined} surface
 */
export function geoSurfaceKey(surface) {
  const source = surface && typeof surface === 'object' ? surface : {}
  const parts = [clean(source.mode) || 'web']
  if (typeof source.deep === 'boolean') parts.push(source.deep ? 'deep' : 'fast')
  if (source.newChat === true) parts.push('newchat')
  const city = clean(source.city)
  if (city) parts.push(`city=${city}`)
  return parts.join(';')
}

/**
 * The coverage key of a reading.
 * @param {{ setVersion?: number | null, pools?: readonly unknown[] | null, engines?: readonly unknown[] | null, surface?: Record<string, unknown> | null }} measured
 *   what was measured: the question set's version, the pools of the answered questions, the engines that answered, the probe surface
 * @returns {string | null} null when no engine answered: there is nothing for a coverage to be of
 */
export function geoCoverageKey({ setVersion = null, pools = [], engines = [], surface = null } = {}) {
  const heard = sortedSet(engines)
  if (heard.length === 0) return null
  const version = Number.isSafeInteger(setVersion) && /** @type {number} */ (setVersion) >= 0 ? `v${setVersion}` : 'v-'
  return [version, sortedSet(pools).join(VALUE), heard.join(VALUE), geoSurfaceKey(surface)].join(PART)
}

/**
 * A key taken apart.
 * @param {string | null | undefined} key
 * @returns {{ setVersion: string, pools: string[], engines: string[], surface: string } | null}
 */
export function parseGeoCoverageKey(key) {
  if (typeof key !== 'string' || key === '') return null
  const parts = key.split(PART)
  if (parts.length !== 4) return null
  return {
    setVersion: parts[0],
    pools: parts[1] ? parts[1].split(VALUE) : [],
    engines: parts[2] ? parts[2].split(VALUE) : [],
    surface: parts[3],
  }
}

/**
 * @typedef {object} GeoCoverageDifference
 * @property {boolean} comparable the two readings were measured over the same thing: they may be compared
 * @property {boolean} unknown one of them has no coverage to speak of, so there is nothing to say about a change
 * @property {boolean} engines the engines that answered differ
 * @property {boolean} questions the question set's version or the answered pools differ
 * @property {boolean} surface the probe surface differs
 */

/**
 * Whether two readings may be compared, and if not, what moved.
 *
 * Both keys absent (`undefined`: a series from a server that does not send them) are compared as they always were — there is
 * no coverage to hold against. `null` is a server saying it does not know, which is not equal to anything, itself included.
 * @param {string | null | undefined} before @param {string | null | undefined} after
 * @returns {GeoCoverageDifference}
 */
export function geoCoverageDifference(before, after) {
  if (before === undefined && after === undefined) return { comparable: true, unknown: false, engines: false, questions: false, surface: false }
  if (before === after && typeof before === 'string') return { comparable: true, unknown: false, engines: false, questions: false, surface: false }
  const left = parseGeoCoverageKey(before)
  const right = parseGeoCoverageKey(after)
  if (!left || !right) return { comparable: false, unknown: true, engines: false, questions: false, surface: false }
  return {
    comparable: false,
    unknown: false,
    engines: left.engines.join(VALUE) !== right.engines.join(VALUE),
    questions: left.setVersion !== right.setVersion || left.pools.join(VALUE) !== right.pools.join(VALUE),
    surface: left.surface !== right.surface,
  }
}

/**
 * The plain statement that two readings are not compared, in the reader's words — what moved, and that nothing is read from it.
 * Null where they may be compared.
 * @param {GeoCoverageDifference | null | undefined} difference
 * @returns {string | null}
 */
export function geoCoverageStatement(difference) {
  if (!difference || difference.comparable) return null
  if (difference.unknown) return '测量范围没有记录，不与上一轮比较'
  const moved = [difference.engines, difference.questions, difference.surface].filter(Boolean).length
  if (moved > 1) return '测量范围有变化，不与上一轮比较'
  if (difference.engines) return '引擎范围有变化，不与上一轮比较'
  if (difference.questions) return '问句范围有变化，不与上一轮比较'
  return '测量方式有变化，不与上一轮比较'
}
