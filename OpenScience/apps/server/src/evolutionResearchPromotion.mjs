import { createHash } from 'node:crypto';
import { resolvePublicationIdentity } from './evolutionPublicationIdentity.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Trusted evaluator consumer. A complete study requires every observed variant and two actual runs.
 * Attribution requires successful calls of this exact published artifact in each isolated run.
 * No operator route accepts these assessments. @param {any} input */
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
      const clean = rows.every(row => row.fullResearchReproductionValid === true && row.codeVerified === true && row.verificationProof?.kind === 'isolated-independent-replay' && row.verificationProof?.replicates >= 2 && /^[a-f0-9]{64}$/.test(row.verificationProof?.proofHash ?? '') && row.verificationProof?.sourceHash === row.goldSourceHash && row.independent === true && row.retracted === false
        && row.exposureTier === 'unexposed' && /^[a-f0-9]{64}$/.test(row.goldSourceHash ?? '')
        && row.producerRunId && row.producerProjectId && uses.some(use => use.payload.projectId === row.producerProjectId
          && use.payload.runId === row.producerRunId && use.payload.toolId === toolId && use.payload.digest === artifactDigest && use.payload.result?.ok === true));
      const variants = new Map();
      for (const row of rows) {
        const variant = `${row.caseId}:${row.variant ?? 0}`;
        if (!variants.has(variant)) variants.set(variant, new Set());
        variants.get(variant).add(row.producerRunId);
      }
      if (!clean || ![...variants.values()].every(runs => runs.size >= 2)) continue;
      const id = `evolution-research-proof-${hash([toolId, artifactDigest, paperId])}`;
      const prior = await service.get(id);
      if (!prior) await service.save('research-proof', id, { toolId, artifactDigest, paperId, identityProof: identities.get(rows[0].publishedPaperId), goldSourceHashes: [...new Set(rows.map(row => row.goldSourceHash))],
        producerRunIds: [...new Set(rows.map(row => row.producerRunId))], independent: true, passed: true, exposed: false, retracted: false, at: service.now().toISOString() });
      observed.push(paperId);
    }
    const proofs = (await service.list('research-proof')).filter(row => row.payload.toolId === toolId && row.payload.artifactDigest === artifactDigest);
    const verifiedPapers = proofs.map(row => identities.has(row.payload.paperId) ? identities.get(row.payload.paperId) : row.payload.identityProof).filter(row => row?.verified === true);
    const papers = new Set(verifiedPapers.map(row => row.canonicalId)).size;
    await service.recordAssessment(toolId, { id: `research:${hash([toolId, artifactDigest])}`, kind: 'research', papers,
      independent: true, passed: papers > 0, exposed: false, retracted: false, at: service.now().toISOString() });
    return { status: papers >= 5 ? 'observed' : 'waiting', papers, observed, validationLevel: (await service.get(toolId)).payload.validationLevel };
  });
}
