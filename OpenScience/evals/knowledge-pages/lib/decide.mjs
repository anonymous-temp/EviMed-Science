// The decision rule. The thresholds are fixed here, and written in README.md, before any result of this evaluation existed.
// Changing one after seeing results invalidates the run it was applied to.
//
// The rule was written for arm B (the pages of the platform's self-built compiler) and the constants keep the names they
// were given then. It is applied unchanged, arm for arm, to any arm that searches compiled pages: B in the runs of
// 2026-10-12, C (the pages of OpenViking's official skill) since.
import { ARMS } from './prompts.mjs'

export const THRESHOLDS = Object.freeze({
  /** Every (question, arm) cell needs this many judged repetitions, and every cell of the corpus must be there. */
  minRepsPerCell: 3,
  /** Synthesis questions: B must beat A′, not merely match it. */
  synthesis: Object.freeze({
    /** The 95% interval of B − A′ must lie wholly above this. */
    bVsAprimeCiLowerAbove: 0,
    /** And its mean must be at least this large, so a significant but trivial gain does not open the feature. */
    bVsAprimeMeanAtLeast: 0.05,
    /** B must also be better than the status quo A on average (no significance asked: the guidance could be what hurts A′). */
    bVsAMeanAbove: 0,
  }),
  /** Single-fact questions: B must not regress. Applied to B − A′ and to B − A. */
  single: Object.freeze({ meanAtLeast: -0.05, ciLowerAtLeast: -0.10 }),
  /** Citation integrity: B's verified-marker rate may be at most this far below A′'s and below A's. */
  citation: Object.freeze({ verifiedRateDropAtMost: 0.03 }),
  /** The judge is only believed if it gives a key-point reference answer a near-full score and an empty answer none. */
  judgeSanity: Object.freeze({ referenceMeanAtLeast: 0.9, emptyMeanAtMost: 0.1 }),
})

/** The arms the rule can be asked about: those whose knowledge base holds compiled pages. */
export const PAGE_ARM_IDS = Object.freeze(Object.keys(ARMS).filter((id) => ARMS[id].pages))

const fixed = (value, digits = 3) => (value == null ? 'n/a' : value.toFixed(digits))
const interval = (diff) => `${fixed(diff.mean)} [${fixed(diff.ciLow)}, ${fixed(diff.ciHigh)}] over ${diff.n} questions`

/**
 * The cells the verdict of one page arm rests on: its own and those of the two arms it is compared with. A summary written
 * before arms were counted apart (2026-10-12) has only the total, which for its three arms is the same number.
 * @param {any} summary @param {string} arm
 */
function coverageOf(summary, arm) {
  const byArm = summary?.coverageByArm
  if (!byArm) return summary?.coverage ?? null
  // Each arm owes one cell per question; an arm the run does not hold has none of them.
  const questions = byArm[arm]?.expectedCells ?? 0
  const completeCells = [arm, 'Aprime', 'A'].reduce((total, id) => total + (byArm[id]?.completeCells ?? 0), 0)
  return { minRepsPerCell: summary.coverage?.minRepsPerCell, expectedCells: questions * 3, completeCells }
}

/**
 * @param {any} summary  the object `summarize` returns (only the fields below are read)
 * @param {string} [arm]  the page arm the verdict is about
 * @returns {{ open: boolean, inconclusive: boolean, reasons: string[] }}
 */
export function decide(summary, arm = 'B') {
  if (!PAGE_ARM_IDS.includes(arm)) throw new Error(`the decision rule is about an arm that searches pages (${PAGE_ARM_IDS.join(', ')}), not ${arm}`)
  const reasons = []
  let failed = false
  let inconclusive = false
  const check = (ok, passText, failText) => {
    if (ok) reasons.push(`pass: ${passText}`)
    else { failed = true; reasons.push(`FAIL: ${failText}`) }
  }

  const coverage = coverageOf(summary, arm)
  if (!coverage || !coverage.expectedCells || coverage.minRepsPerCell < THRESHOLDS.minRepsPerCell || coverage.completeCells < coverage.expectedCells) {
    inconclusive = true
    failed = true
    reasons.push(`FAIL: insufficient data - ${coverage?.completeCells ?? 0} of ${coverage?.expectedCells ?? '?'} (question, arm) cells are complete at ${coverage?.minRepsPerCell ?? '?'} judged repetitions (${THRESHOLDS.minRepsPerCell} required for every cell); the decision is withheld, not made on part of the data`)
    const without = arm === 'C' ? summary?.upstreamPages?.topicsWithoutTree ?? [] : []
    if (without.length) reasons.push(`FAIL: arm C has no upstream pages for ${without.join(', ')}; its questions there were not asked`)
    return { open: false, inconclusive, reasons }
  }

  const sanity = summary.judgeSanity
  if (!sanity) {
    inconclusive = true
    failed = true
    reasons.push('FAIL: the judge sanity check has not been run')
  } else {
    check(sanity.referenceMean >= THRESHOLDS.judgeSanity.referenceMeanAtLeast && sanity.emptyMean <= THRESHOLDS.judgeSanity.emptyMeanAtMost,
      `judge sanity - reference answers score ${fixed(sanity.referenceMean)}, empty answers ${fixed(sanity.emptyMean)}`,
      `judge sanity - reference answers score ${fixed(sanity.referenceMean)} (need >= ${THRESHOLDS.judgeSanity.referenceMeanAtLeast}), empty answers ${fixed(sanity.emptyMean)} (need <= ${THRESHOLDS.judgeSanity.emptyMeanAtMost}); the scores cannot be trusted`)
  }

  const synthesis = summary.categories?.synthesis?.diffs
  const vsAprime = synthesis?.[`${arm}-Aprime`]
  const vsA = synthesis?.[`${arm}-A`]
  if (!vsAprime || vsAprime.mean == null) {
    inconclusive = true
    failed = true
    reasons.push('FAIL: no synthesis comparison could be computed')
  } else {
    check(vsAprime.ciLow > THRESHOLDS.synthesis.bVsAprimeCiLowerAbove,
      `synthesis ${arm} - A' lower bound is above ${THRESHOLDS.synthesis.bVsAprimeCiLowerAbove}: ${interval(vsAprime)}`,
      `synthesis ${arm} - A' lower bound must be above ${THRESHOLDS.synthesis.bVsAprimeCiLowerAbove}: ${interval(vsAprime)}`)
    check(vsAprime.mean >= THRESHOLDS.synthesis.bVsAprimeMeanAtLeast,
      `synthesis ${arm} - A' mean is at least ${THRESHOLDS.synthesis.bVsAprimeMeanAtLeast}`,
      `synthesis ${arm} - A' mean ${fixed(vsAprime.mean)} is below ${THRESHOLDS.synthesis.bVsAprimeMeanAtLeast}`)
    check(vsA?.mean != null && vsA.mean > THRESHOLDS.synthesis.bVsAMeanAbove,
      `synthesis ${arm} - A mean is above ${THRESHOLDS.synthesis.bVsAMeanAbove}: ${vsA ? interval(vsA) : ''}`,
      `synthesis ${arm} - A mean must be above ${THRESHOLDS.synthesis.bVsAMeanAbove}: ${vsA ? interval(vsA) : 'not computed'}`)
  }

  for (const [name, label] of [[`${arm}-Aprime`, `${arm} - A'`], [`${arm}-A`, `${arm} - A`]]) {
    const diff = summary.categories?.single?.diffs?.[name]
    if (!diff || diff.mean == null) {
      inconclusive = true
      failed = true
      reasons.push(`FAIL: no single-fact comparison ${label} could be computed`)
      continue
    }
    check(diff.mean >= THRESHOLDS.single.meanAtLeast && diff.ciLow >= THRESHOLDS.single.ciLowerAtLeast,
      `single-fact ${label} does not regress (mean >= ${THRESHOLDS.single.meanAtLeast}, lower bound >= ${THRESHOLDS.single.ciLowerAtLeast}): ${interval(diff)}`,
      `single-fact ${label} regresses (need mean >= ${THRESHOLDS.single.meanAtLeast} and lower bound >= ${THRESHOLDS.single.ciLowerAtLeast}): ${interval(diff)}`)
  }

  const rates = summary.citations?.overall
  for (const [other, label] of [['Aprime', "A'"], ['A', 'A']]) {
    const own = rates?.[arm]?.verifiedRate
    const o = rates?.[other]?.verifiedRate
    if (own == null || o == null) {
      inconclusive = true
      failed = true
      reasons.push(`FAIL: citation verified rate of ${arm} or ${label} could not be computed (no markers)`)
      continue
    }
    check(own >= o - THRESHOLDS.citation.verifiedRateDropAtMost,
      `citation verified rate ${arm} ${fixed(own)} >= ${label} ${fixed(o)} - ${THRESHOLDS.citation.verifiedRateDropAtMost}`,
      `citation verified rate ${arm} ${fixed(own)} is more than ${THRESHOLDS.citation.verifiedRateDropAtMost} below ${label} ${fixed(o)}`)
  }

  return { open: !failed, inconclusive, reasons }
}
