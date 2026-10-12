// The decision rule. The thresholds are fixed here, and written in README.md, before any result of this evaluation existed.
// Changing one after seeing results invalidates the run it was applied to.

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

const fixed = (value, digits = 3) => (value == null ? 'n/a' : value.toFixed(digits))
const interval = (diff) => `${fixed(diff.mean)} [${fixed(diff.ciLow)}, ${fixed(diff.ciHigh)}] over ${diff.n} questions`

/**
 * @param {any} summary  the object `summarize` returns (only the fields below are read)
 * @returns {{ open: boolean, inconclusive: boolean, reasons: string[] }}
 */
export function decide(summary) {
  const reasons = []
  let failed = false
  let inconclusive = false
  const check = (ok, passText, failText) => {
    if (ok) reasons.push(`pass: ${passText}`)
    else { failed = true; reasons.push(`FAIL: ${failText}`) }
  }

  const coverage = summary?.coverage
  if (!coverage || coverage.minRepsPerCell < THRESHOLDS.minRepsPerCell || coverage.completeCells < coverage.expectedCells) {
    inconclusive = true
    failed = true
    reasons.push(`FAIL: insufficient data - ${coverage?.completeCells ?? 0} of ${coverage?.expectedCells ?? '?'} (question, arm) cells are complete at ${coverage?.minRepsPerCell ?? '?'} judged repetitions (${THRESHOLDS.minRepsPerCell} required for every cell); the decision is withheld, not made on part of the data`)
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
  const bVsAprime = synthesis?.['B-Aprime']
  const bVsA = synthesis?.['B-A']
  if (!bVsAprime || bVsAprime.mean == null) {
    inconclusive = true
    failed = true
    reasons.push('FAIL: no synthesis comparison could be computed')
  } else {
    check(bVsAprime.ciLow > THRESHOLDS.synthesis.bVsAprimeCiLowerAbove,
      `synthesis B - A' lower bound is above ${THRESHOLDS.synthesis.bVsAprimeCiLowerAbove}: ${interval(bVsAprime)}`,
      `synthesis B - A' lower bound must be above ${THRESHOLDS.synthesis.bVsAprimeCiLowerAbove}: ${interval(bVsAprime)}`)
    check(bVsAprime.mean >= THRESHOLDS.synthesis.bVsAprimeMeanAtLeast,
      `synthesis B - A' mean is at least ${THRESHOLDS.synthesis.bVsAprimeMeanAtLeast}`,
      `synthesis B - A' mean ${fixed(bVsAprime.mean)} is below ${THRESHOLDS.synthesis.bVsAprimeMeanAtLeast}`)
    check(bVsA?.mean != null && bVsA.mean > THRESHOLDS.synthesis.bVsAMeanAbove,
      `synthesis B - A mean is above ${THRESHOLDS.synthesis.bVsAMeanAbove}: ${bVsA ? interval(bVsA) : ''}`,
      `synthesis B - A mean must be above ${THRESHOLDS.synthesis.bVsAMeanAbove}: ${bVsA ? interval(bVsA) : 'not computed'}`)
  }

  for (const [name, label] of [['B-Aprime', "B - A'"], ['B-A', 'B - A']]) {
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
    const b = rates?.B?.verifiedRate
    const o = rates?.[other]?.verifiedRate
    if (b == null || o == null) {
      inconclusive = true
      failed = true
      reasons.push(`FAIL: citation verified rate of B or ${label} could not be computed (no markers)`)
      continue
    }
    check(b >= o - THRESHOLDS.citation.verifiedRateDropAtMost,
      `citation verified rate B ${fixed(b)} >= ${label} ${fixed(o)} - ${THRESHOLDS.citation.verifiedRateDropAtMost}`,
      `citation verified rate B ${fixed(b)} is more than ${THRESHOLDS.citation.verifiedRateDropAtMost} below ${label} ${fixed(o)}`)
  }

  return { open: !failed, inconclusive, reasons }
}
