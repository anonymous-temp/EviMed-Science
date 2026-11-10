/**
 * The promotion rule for a tool judged on published papers (moved here 2026-11-04 from the online engine's evolutionResearchPromotion.mjs, which left
 * with the engine). It is pure: it reads outcomes somebody recorded and decides nothing else. Whether a paper was measured at all (the run was
 * independent, the paper unexposed and unretracted, the tool really called, two actual runs per variant) is the recorder's question and is settled
 * before an outcome exists; an outcome here is only "reproduced" or "not reproduced".
 *
 * Only successes used to be kept, so five successes ever gave promotion and a tool that reproduced 5 of 100 papers carried the label of one that
 * reproduced 5 of 5. Now every measured paper has an outcome and all of them are counted:
 *  - the first measured outcome of a paper stands, whichever it is: a later measurement cannot turn a failure into a pass by trying again;
 *  - one outcome per publication: records that name one publication under different paper identities are one outcome, and a failure is not hidden by
 *    a pass;
 *  - the tool qualifies with at least five reproduced publications and a one-sided 95% lower confidence bound (Clopper-Pearson) of the reproduction
 *    rate of at least one half. Five of five is the least that meets it (lower bound 0.55); five of six does not (0.42); seven of eight does (0.53).
 */
/** The fewest held-out publications a tool must reproduce. */
export const RESEARCH_PROMOTION_MINIMUM_PAPERS = 5;
/** The reproduction rate its one-sided 95% lower bound must reach. */
export const RESEARCH_PROMOTION_MINIMUM_LOWER_BOUND = 0.5;

/**
 * One-sided 95% lower confidence bound (Clopper-Pearson) of a proportion: the p at which seeing this many successes or more out of n has
 * probability 5%, found by bisection. No trials, or no success, is 0.
 * @param {number} successes @param {number} n
 */
export function reproductionRateLowerBound(successes, n) {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 0 || successes < 0 || successes > n) throw new RangeError('promotion_counts_invalid');
  if (!n || successes <= 0) return 0;
  const tail = (/** @type {number} */ p) => { let term = (1 - p) ** n, total = 0; for (let k = 0; k <= n; k++) { if (k >= successes) total += term; term = term * (n - k) / (k + 1) * p / (1 - p); } return total; };
  let low = 0, high = 1;
  for (let step = 0; step < 60; step++) { const middle = (low + high) / 2; if (tail(middle) < 0.05) low = middle; else high = middle; }
  return low;
}

/**
 * The reading of a tool's recorded outcomes.
 * @param {{ paper: string, publication?: string, passed: boolean }[]} outcomes oldest first: `paper` is what was measured (the identity a repeat
 *   measurement would carry), `publication` the canonical identity of the publication it belongs to (the paper's own when absent), `passed` whether
 *   the tool reproduced it
 * @returns {{ reproduced: number, attempted: number, failedPublications: string[], lowerBound: number, qualifies: boolean }}
 */
export function researchPromotion(outcomes) {
  if (!Array.isArray(outcomes)) throw new TypeError('promotion_outcomes_invalid');
  /** @type {Map<string, { publication: string, passed: boolean }>} */
  const papers = new Map();
  for (const outcome of outcomes) {
    if (typeof outcome?.paper !== 'string' || !outcome.paper || typeof outcome.passed !== 'boolean' || (outcome.publication !== undefined && (typeof outcome.publication !== 'string' || !outcome.publication))) throw new TypeError('promotion_outcome_invalid');
    if (!papers.has(outcome.paper)) papers.set(outcome.paper, { publication: outcome.publication ?? outcome.paper, passed: outcome.passed });
  }
  /** @type {Map<string, boolean>} */
  const publications = new Map();
  for (const { publication, passed } of papers.values()) publications.set(publication, publications.get(publication) !== false && passed);
  const reproduced = [...publications.values()].filter(Boolean).length;
  const lowerBound = reproductionRateLowerBound(reproduced, publications.size);
  return { reproduced, attempted: publications.size, failedPublications: [...publications].filter(([, passed]) => !passed).map(([publication]) => publication), lowerBound,
    qualifies: reproduced >= RESEARCH_PROMOTION_MINIMUM_PAPERS && lowerBound >= RESEARCH_PROMOTION_MINIMUM_LOWER_BOUND };
}
