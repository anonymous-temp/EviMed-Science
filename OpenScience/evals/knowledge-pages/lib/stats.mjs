// Statistics for the comparison: means, a seeded generator and the paired bootstrap over questions.

export const BOOTSTRAP_ITERATIONS = 10000
export const BOOTSTRAP_SEED = 20261012

export const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)

/** A small seeded generator (mulberry32): the same seed gives the same resamples on every machine. @param {number} seed */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The p-th percentile (0..1) of a sorted list, by linear interpolation. */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * p
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/**
 * Paired bootstrap of the mean difference. `differences` holds one number per question (arm X's mean score minus arm Y's, each
 * averaged over the repetitions), so the resampling unit is the question: repetitions of one question are never treated as
 * independent evidence.
 * @param {number[]} differences
 * @param {{ iterations?: number, seed?: number }} [options]
 * @returns {{ n: number, mean: number | null, ciLow: number | null, ciHigh: number | null, iterations: number, seed: number }}
 */
export function pairedBootstrap(differences, { iterations = BOOTSTRAP_ITERATIONS, seed = BOOTSTRAP_SEED } = {}) {
  const n = differences.length
  if (!n) return { n, mean: null, ciLow: null, ciHigh: null, iterations, seed }
  const random = seededRandom(seed)
  const means = new Float64Array(iterations)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0
    for (let draw = 0; draw < n; draw += 1) sum += differences[Math.floor(random() * n)]
    means[iteration] = sum / n
  }
  const sorted = Array.from(means).sort((left, right) => left - right)
  return { n, mean: mean(differences), ciLow: percentile(sorted, 0.025), ciHigh: percentile(sorted, 0.975), iterations, seed }
}
