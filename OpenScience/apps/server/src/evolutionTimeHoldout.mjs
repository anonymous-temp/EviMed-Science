import { canonicalJson } from '@evimed/domain';
import { saveEvolutionEvaluation } from './evolutionEvaluationGaps.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { recordResearchPromotion } from './evolutionResearchPromotion.mjs';
import { resolvePublicationIdentity } from './evolutionPublicationIdentity.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Evaluate only actually new, provenance-complete temporal candidates against independent control gold.
 * Gold contract: {observationId,paperId,toolId,artifactDigest,sourceHash,firstPublicAt,
 * firstPublicEvidenceId,independent:true,retracted:false,definition:{cases:[paper-gold case...]}}.
 * Gold and expected values stay in paperGold's control-plane evaluator, never in dispatched input.
 * @param {any} dependencies */
export async function prepareWeekly({ service, config, paperGold, day, signal, jobId, prepareGold, canonicalize = resolvePublicationIdentity }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('A weekly observation day is required.');
  const candidates = (await service.list('observation')).filter(row => row.payload.kind === 'temporal-evaluation-candidate' && row.payload.status === 'awaiting-gold');
  const results = [], waiting = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const record = candidate.payload;
    const tool = await service.get(record.toolId);
    const publicAt = Date.parse(record.firstPublicAt ?? ''), releasedAt = Date.parse(tool?.payload.modelReleasedAt ?? ''), frozenAt = Date.parse(tool?.payload.frozenAt ?? '');
    const provenance = tool && tool.payload.status === 'active' && tool.payload.artifactDigest === record.artifactDigest && tool.payload.modelReleaseEvidenceId && record.firstPublicEvidenceId
      && Number.isFinite(publicAt) && Number.isFinite(releasedAt) && Number.isFinite(frozenAt) && publicAt > releasedAt && publicAt > frozenAt;
    let gold = null;
    if (provenance) {
      if (!/^evolution-temporal-[a-f0-9]{64}$/.test(candidate.id)) throw new Error('Invalid temporal observation identity.');
      try {
        const bytes = await readFile(path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold', 'time-holdout', `${candidate.id}.json`));
        if (bytes.length > 4 * 1024 * 1024) throw new Error('Temporal gold exceeds its control-plane bound.');
        gold = JSON.parse(bytes.toString('utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!gold && prepareGold) {
        await prepareGold({ observation: candidate, tool, signal });
        try { const bytes = await readFile(path.join(config.evaluationDataDir || path.join(config.dataDir, 'evaluation-control'), 'paper-gold', 'time-holdout', `${candidate.id}.json`)); if(bytes.length>4*1024*1024) throw new Error('Temporal gold exceeds its control-plane bound.'); gold=JSON.parse(bytes.toString('utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
      }
    }
    if (gold?.hash !== undefined) { const {hash:sealedHash,...sealedGold}=gold; if(sealedHash!==createHash('sha256').update(canonicalJson(sealedGold)).digest('hex')) throw new Error('Frozen temporal gold bytes changed.'); }
    const cases = gold?.definition?.cases;
    const goldValid = provenance && gold?.observationId === candidate.id && gold.paperId === record.paperId && gold.toolId === record.toolId && gold.artifactDigest === record.artifactDigest
      && gold.independent === true && gold.retracted === false && /^[a-f0-9]{64}$/.test(gold.sourceHash ?? '')
      && gold.firstPublicAt === record.firstPublicAt && gold.firstPublicEvidenceId === record.firstPublicEvidenceId
      && Array.isArray(cases) && cases.length > 0 && cases.every(testCase => testCase.id && testCase.gold && (testCase.type === 'question' || testCase.input) && testCase.capabilityId
        && Array.isArray(testCase.policy?.aliases) && testCase.policy.aliases.length > 0 && Array.isArray(testCase.policy?.titles)
        && testCase.rewrite?.question && Array.isArray(testCase.rewrite.variants) && testCase.rewrite.variants.length > 0);
    if (!goldValid) { waiting.push({ observationId: candidate.id, reason: provenance ? 'Independent preserved time-holdout QA gold is missing or incomplete.' : 'Pinned tool, earliest-public, model release, or tool freeze provenance is incomplete.' }); continue; }
    const publicationIdentity = await canonicalize(gold.paperId, { signal });
    const caseIdentities = await Promise.all(cases.map(testCase => canonicalize(testCase.publicationId ?? testCase.paperId ?? testCase.gold.sourcePaperId ?? gold.paperId, { signal })));
    if (publicationIdentity?.verified !== true || caseIdentities.some(identity => identity?.verified !== true || identity.canonicalId !== publicationIdentity.canonicalId)) {
      waiting.push({ observationId: candidate.id, reason: 'Official publication identity or its case aliases cannot be verified as the same paper.' }); continue;
    }
    const executionHint = `Use the published platform tool with exact toolId ${JSON.stringify(record.toolId)} and artifact digest ${JSON.stringify(record.artifactDigest)}. Record its actual successful invocation; if unavailable, explicitly report that limitation. This instruction supplies no reference answers.`;
    const definition = { ...gold.definition, group: 'time-holdout', track: tool.payload.track, cases: cases.map(testCase => ({ ...testCase, publicationId: publicationIdentity.canonicalId, sourceHash: gold.sourceHash, group: 'time-holdout', track: tool.payload.track, rewrite: {...testCase.rewrite, variants:testCase.rewrite.variants.map(question=>`${question}\n\n${executionHint}`)} })) };
    const goldHash = hash(gold), cycleId = `time-${hash([candidate.id, record.artifactDigest, goldHash]).slice(0,40)}`;
    const rawReport = await paperGold.run({ userId: await service.owner(), cycleId, definition, signal, jobId });
    const stillPinned = await service.get(record.toolId);
    if (stillPinned?.payload.artifactDigest !== record.artifactDigest) throw new Error('Temporal evaluation tool pin changed.');
    const uses = await service.list('use', await service.owner());
    const attributed = unit => Boolean(unit.producerRunId && unit.producerProjectId && uses.some(use=>use.payload.projectId===unit.producerProjectId && use.payload.runId===unit.producerRunId && use.payload.toolId===record.toolId && use.payload.digest===record.artifactDigest && use.payload.result?.ok===true));
    const report = {...rawReport, units:(rawReport.units??[]).map(unit=>attributed(unit)?{...unit,actualPinnedToolAttribution:true}:{...unit,actualPinnedToolAttribution:false,eligibleForMainMetric:false,allStagesValid:false,fullResearchReproductionValid:false,exposureTier:'unknown',attributionStatus:'waiting-exact-tool-use'})};
    const attributionComplete = report.units.length>0 && report.units.every(unit=>unit.actualPinnedToolAttribution===true);
    const evaluationId = `time-holdout-evaluation-${hash([candidate.id, goldHash])}`;
    const evaluation = await saveEvolutionEvaluation(service, evaluationId, { ...report, group: 'time-holdout', track: tool.payload.track, observationId: candidate.id, sourceHash: gold.sourceHash, artifactDigest: record.artifactDigest, goldHash, cycleId });
    if (!attributionComplete) { waiting.push({observationId:candidate.id,evaluationId:evaluation.id,reason:'Every evaluated producer run requires actual successful execution of the exact tool artifact; preserved checkpoint will be reused.'}); continue; }
    if (report.units?.some(unit => unit.type === 'research')) await recordResearchPromotion({ service, report, userId: await service.owner(), toolId: record.toolId, artifactDigest: record.artifactDigest, signal, canonicalize });
    await service.save('observation', candidate.id, { ...record, status: 'scored', evaluationId: evaluation.id, cycleId, goldHash, scoredAt: service.now().toISOString() }, candidate);
    results.push({ observationId: candidate.id, evaluationId: evaluation.id, cycleId, observed: report.units?.length ?? 0 });
  }
  const summary = { status: results.length ? 'observed' : 'waiting', at: service.now().toISOString(), day, observed: results.reduce((total,row)=>total+row.observed,0), results, waiting,
    reason: candidates.length ? null : 'No new eligible temporal observations are available; old calibration papers are not reused as time holdout.' };
  const priorSummary = await service.get(`weekly-time-holdout-${day}`);
  await saveEvolutionEvaluation(service, `weekly-time-holdout-${day}`, summary, priorSummary);
  return summary;
}
