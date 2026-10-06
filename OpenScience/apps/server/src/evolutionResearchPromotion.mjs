import { createHash } from 'node:crypto';
import { resolvePublicationIdentity } from './evolutionPublicationIdentity.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The fewest held-out papers a tool must reproduce, from the plan (section 6.2). */
export const RESEARCH_PROMOTION_MINIMUM_PAPERS = 5;
/** One-sided 95% lower confidence bound (Clopper-Pearson) of a proportion: the p at which seeing this many
 * successes or more out of n would have probability 5%. @param {number} successes @param {number} n */
export function reproductionRateLowerBound(successes, n) {
  if (!n || successes <= 0) return 0;
  const tail = p => { let term = (1 - p) ** n, total = 0; for (let k = 0; k <= n; k++) { if (k >= successes) total += term; term = term * (n - k) / (k + 1) * p / (1 - p); } return total; };
  let low = 0, high = 1;
  for (let step = 0; step < 60; step++) { const middle = (low + high) / 2; if (tail(middle) < 0.05) low = middle; else high = middle; }
  return low;
}
/**
 * Trusted evaluator consumer for V3. No operator route accepts these assessments.
 *
 * A complete study requires every observed variant and two actual runs, and attribution requires
 * successful calls of this exact published artifact in each isolated run. Those conditions say whether
 * a paper was measured at all. A measured paper then has an outcome, and both outcomes are kept:
 * the tool reproduced it, or it did not.
 *
 * Only successes used to be kept. A paper the tool failed left no trace, five successes ever gave V3,
 * and a tool that reproduced 5 of 100 papers carried the label of one that reproduced 5 of 5. Now the
 * first measured outcome of each paper stands (a later cycle cannot turn a failure into a pass by trying
 * again), failures are recorded beside successes, and V3 needs at least five reproduced papers and a
 * reproduction rate whose one-sided 95% lower bound is at least one half. Five of five is the least that
 * meets it (lower bound 0.55); five of six does not (0.42); seven of eight does (0.53).
 * @param {any} input */
export async function recordResearchPromotion({ service, report, userId, toolId, artifactDigest, signal, canonicalize = resolvePublicationIdentity }) {
  if (!userId || !toolId || !artifactDigest) return { status: 'waiting', reason: 'Exact evaluator owner and tool attribution are required.' };
  const identities = new Map();
  const existingProofs = (await service.list('research-proof')).filter(row => row.payload.toolId === toolId && row.payload.artifactDigest === artifactDigest);
  for (const id of new Set([...report.units ?? [], ...report.excluded ?? []].filter(row => row.type === 'research').map(row => row.publishedPaperId).concat(existingProofs.map(row => row.payload.paperId)))) {
    identities.set(id, await canonicalize(id, { signal }));
  }
  return service.withLock(`research-promotion:${toolId}`, async () => {
    const tool = await service.get(toolId);
    if (!tool || tool.payload.artifactDigest !== artifactDigest) return { status: 'waiting', reason: 'The evaluated artifact differs.' };
    const uses = await service.list('use', userId);
    const groups = new Map();
    for (const row of [...report.units ?? [], ...report.excluded ?? []]) {
      if (row.type !== 'research' || !['holdout', 'time-holdout'].includes(row.group)) continue;
      const identity = identities.get(row.publishedPaperId);
      if (identity?.verified !== true) continue;
      const id = identity.canonicalId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    }
    const observed = [];
    for (const [paperId, rows] of groups) {
      // Whether the paper was measured: an independent, unexposed, unretracted unit that this very artifact was called in.
      const measured = rows.every(row => row.independent === true && row.retracted === false
        && row.exposureTier === 'unexposed' && /^[a-f0-9]{64}$/.test(row.goldSourceHash ?? '')
        && row.producerRunId && row.producerProjectId && uses.some(use => use.payload.projectId === row.producerProjectId
          && use.payload.runId === row.producerRunId && use.payload.toolId === toolId && use.payload.digest === artifactDigest && use.payload.result?.ok === true));
      // And its outcome: reproduced with proof, or scored as not reproduced. A unit with neither is not yet an outcome.
      const reproduced = rows.every(row => row.fullResearchReproductionValid === true && row.codeVerified === true && row.verificationProof?.kind === 'isolated-independent-replay' && row.verificationProof?.replicates >= 2 && /^[a-f0-9]{64}$/.test(row.verificationProof?.proofHash ?? '') && row.verificationProof?.sourceHash === row.goldSourceHash);
      const failed = rows.some(row => row.fullResearchReproductionValid === false);
      const variants = new Map();
      for (const row of rows) {
        const variant = `${row.caseId}:${row.variant ?? 0}`;
        if (!variants.has(variant)) variants.set(variant, new Set());
        variants.get(variant).add(row.producerRunId);
      }
      if (!measured || !(reproduced || failed) || ![...variants.values()].every(runs => runs.size >= 2)) continue;
      const id = `evolution-research-proof-${hash([toolId, artifactDigest, paperId])}`;
      const prior = await service.get(id);
      // The first measured outcome of a paper stands, whichever it is.
      if (!prior) {
        await service.save('research-proof', id, { toolId, artifactDigest, paperId, identityProof: identities.get(rows[0].publishedPaperId), goldSourceHashes: [...new Set(rows.map(row => row.goldSourceHash))],
          producerRunIds: [...new Set(rows.map(row => row.producerRunId))], independent: true, passed: reproduced, exposed: false, retracted: false, at: service.now().toISOString() });
        // A recorded proof is told to the recalculation-card publisher (flywheel F03): told and never asked, so a card that cannot be made leaves the proof as it is.
        try { await service.callbacks?.recalculationProof?.({ proofId: id, toolId, artifactDigest, paperId, passed: reproduced, rows }); } catch { /* the card is advice to the loop, never part of it */ }
      }
      if (prior ? prior.payload.passed === true : reproduced) observed.push(paperId);
    }
    const proofs = (await service.list('research-proof')).filter(row => row.payload.toolId === toolId && row.payload.artifactDigest === artifactDigest);
    const canonical = row => { const identity = identities.has(row.payload.paperId) ? identities.get(row.payload.paperId) : row.payload.identityProof; return identity?.verified === true ? identity.canonicalId : null; };
    const outcomes = new Map();
    // One outcome per publication; if two records name one publication under different identities, a failure is not hidden by a pass.
    for (const row of proofs) { const paper = canonical(row); if (paper) outcomes.set(paper, outcomes.get(paper) === false ? false : row.payload.passed === true); }
    const papers = [...outcomes.values()].filter(Boolean).length, failedPapers = [...outcomes].filter(([, passed]) => !passed).map(([paper]) => paper);
    const lowerBound = reproductionRateLowerBound(papers, outcomes.size);
    const qualifies = papers >= RESEARCH_PROMOTION_MINIMUM_PAPERS && lowerBound >= 0.5;
    await service.recordAssessment(toolId, { id: `research:${hash([toolId, artifactDigest])}`, kind: 'research', papers,
      independent: true, passed: qualifies, failureIds: failedPapers.map(paper => hash([toolId, paper]).slice(0, 24)), exposed: false, retracted: false, at: service.now().toISOString() });
    return { status: qualifies ? 'observed' : 'waiting', papers, attempted: outcomes.size, failed: failedPapers.length, reproductionRateLowerBound: lowerBound, observed, validationLevel: (await service.get(toolId)).payload.validationLevel };
  });
}
