import { createHash } from 'node:crypto';
import path from 'node:path';
import { readCopyOf } from './sourceService.mjs';
import { readRunTranscript } from './runTranscripts.mjs';
import { openScopedFileNoFollow, readStableFileHandle, HttpError } from './security.mjs';
import { verifyOfficialProspectiveTarget } from './evolutionProspectiveScore.mjs';
import { isInternalProject } from './internalProjects.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const provenModelFamily = rows => {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !row.id || !row.runId || typeof row.model !== 'string')) return null;
  const families = new Set(rows.map(row => /^deepseek/i.test(row.model) ? 'deepseek' : /^qwen/i.test(row.model) ? 'qwen' : 'unknown'));
  return families.size === 1 && !families.has('unknown') ? [...families][0] : null;
};
/** One durable transcript interpretation shared by registration and later evidence replay. @param {any} transcript */
export function prospectiveAnswerText(transcript) {
  if (transcript?.header?.completeness !== 'complete' || !Array.isArray(transcript.messages)) throw new HttpError(409, 'evolution_evaluation_invalid', 'The durable prediction transcript must be complete.');
  return transcript.messages.filter(message => message.role === 'assistant').map(message => (message.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')).join('\n');
}

/** Operator intake of independently checkable evidence, bound to actual source and run bytes.
 * A preserved quote establishes what a source says, not its independent scientific validity.
 * @param {any} dependencies */
export function createEvolutionEvidenceRegistration({ service, integration, store, agentRuns, sourceService, executionEvidence, readPreservedSource, readTranscript = readRunTranscript, verifyTargetUnpublished = verifyOfficialProspectiveTarget }) {
  const settledModels = async (userId, projectId, run) => service.documents?.database
    ? (await service.documents.database.query("SELECT id,model,run_id AS \"runId\" FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 AND run_id=ANY($3::text[]) AND purpose='evolution' AND status='settled'", [userId, projectId, [...new Set([run.id,run.dispatchId].filter(Boolean))]])).rows : [];
  const proof = async (user, projectId, evidence) => {
    if (!evidence?.sourceId || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') || !evidence.quote) return null;
    const source = await sourceService.get(user.id, evidence.sourceId);
    if (source.projectId !== projectId || source.payload.fingerprint?.sha256?.replace(/^sha256:/, '') !== evidence.sha256) throw new HttpError(409, 'evolution_evaluation_invalid', 'The preserved source version differs.');
    const reader = readPreservedSource ?? (async () => {
      const relative = readCopyOf(source); if (!relative) return null;
      const project = await store.requireProject(user, projectId);
      const opened = await openScopedFileNoFollow(project.workspaceDir, path.resolve(project.workspaceDir, relative));
      try { if (opened.stat.size > 4 * 1024 * 1024) return null; return { sha256: evidence.sha256, text: (await readStableFileHandle(opened.handle, opened.stat)).toString('utf8') }; }
      finally { await opened.handle.close(); }
    });
    const preserved = await reader(user, source);
    if (preserved?.sha256 !== evidence.sha256 || typeof preserved.text !== 'string' || !preserved.text.includes(evidence.quote)) return null;
    return { sourceId: source.id, sha256: evidence.sha256, quoteHash: hash(evidence.quote), evidenceId: hash([source.id, evidence.sha256, evidence.quote]) };
  };
  return {
    /** Register release evidence for the actual model recorded on the pinned development run. */
    async registerToolProvenance(user, input) {
      const project = await store.requireProject(user, input.projectId);
      const tool = await service.get(input.toolId);
      if (!tool || tool.payload.artifactDigest !== input.artifactDigest || tool.payload.lineage?.developmentProjectId !== project.id) throw new HttpError(409, 'evolution_evaluation_invalid', 'The pinned development project differs.');
      const runId = tool.payload.lineage?.developmentRuns?.at(-1);
      const run = (await agentRuns.list(project)).find(item => item.id === runId);
      if (!run || !['succeeded', 'delivered'].includes(run.status)) throw new HttpError(409, 'evolution_evaluation_invalid', 'Completed pinned development evidence is required.');
      const evidence = input.modelReleaseEvidence;
      const release = await proof(user, project.id, evidence);
      const models = service.documents?.database ? await service.documents.database.query("SELECT DISTINCT model FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 AND run_id=$3 AND status='settled'", [user.id, project.id, runId]) : { rows: [] };
      const eligible = Boolean(release && evidence.model && models.rows.length === 1 && models.rows[0].model === evidence.model
        && evidence.quote.includes(evidence.model) && evidence.quote.includes(evidence.releasedAt)
        && Number.isFinite(Date.parse(evidence.releasedAt ?? '')) && Date.parse(evidence.releasedAt) <= Date.parse(tool.payload.frozenAt ?? ''));
      if (!eligible) return service.save('observation', `tool-provenance-${hash([tool.id, input.artifactDigest, release?.evidenceId ?? null])}`, {
        kind: 'tool-model-release', status: 'waiting', toolId: tool.id, artifactDigest: input.artifactDigest,
        reason: 'An exact preserved release quote matching the actual settled development model and frozen tool date is required.' });
      return service.withLock(`provenance:${tool.id}`, async () => {
        const current = await service.get(tool.id);
        if (current.payload.modelReleaseEvidenceId && current.payload.modelReleaseEvidenceId !== release.evidenceId) throw new HttpError(409, 'evolution_evaluation_invalid', 'Previously registered release evidence is immutable.');
        const saved = await service.save('tool', current.id, { ...current.payload, modelReleasedAt: evidence.releasedAt, modelReleaseEvidenceId: release.evidenceId,
          modelReleaseProof: { ...release, model: evidence.model, producerRunId: runId } }, current);
        for (const observation of await service.list('observation')) {
          const row = observation.payload;
          if (row.kind !== 'temporal-evaluation-candidate' || row.toolId !== tool.id || row.artifactDigest !== input.artifactDigest || row.status !== 'waiting') continue;
          const eligibleTemporal = row.firstPublicEvidenceId && Date.parse(row.firstPublicAt ?? '') > Date.parse(evidence.releasedAt) && Date.parse(row.firstPublicAt ?? '') > Date.parse(saved.payload.frozenAt ?? '');
          if (eligibleTemporal) await service.save('observation', observation.id, { ...row, status: 'awaiting-gold', caseGroup: 'time-holdout',
            reason: 'Release provenance is registered; independent preserved gold and exposure audit remain required.' }, observation);
        }
        return saved;
      });
    },
    async verifyPinnedRun(record) {
      const user = await store.userById(record.userId); if (!user) return { ok: false };
      const project = await store.requireProject(user, record.projectId);
      const rawSnapshot = record.executionEvidence && executionEvidence ? await executionEvidence.read(record) : null;
      const preserved = rawSnapshot?.evidence ?? rawSnapshot;
      if (preserved) {
        const metadata = preserved.executionMetadata;
        const requests = metadata?.modelRequests ?? [];
        const family = provenModelFamily(requests);
        const used = (metadata?.uses ?? []).some(row => {
          const receipt = row.payload ?? row;
          return (row.id ?? receipt.id) && receipt.userId === user.id && receipt.projectId === project.id
            && receipt.runId === record.producerRunId && receipt.toolId === record.toolId && receipt.digest === record.artifactDigest && receipt.result?.ok === true;
        });
        if (preserved.userId !== user.id || preserved.projectId !== project.id || preserved.runId !== record.producerRunId
          || !['succeeded','delivered'].includes(preserved.runStatus) || !used || !family || metadata.modelFamily !== family) return { ok: false, status: 'waiting-provenance', modelFamily: null };
        const answer = prospectiveAnswerText(preserved.transcript);
        return { ok: answer.includes(record.prediction), predictionHash: hash(record.prediction), transcriptHash: hash(answer),
          toolId: record.toolId, digest: record.artifactDigest, modelFamily: family };
      }
      const run = (await agentRuns.list(project)).find(item => item.id === record.producerRunId);
      if (!run || !['succeeded', 'delivered'].includes(run.status)) return { ok: false };
      const answer = prospectiveAnswerText(await readTranscript(project, run.id));
      const uses = await service.list('use', user.id);
      const used = uses.some(row => row.payload.projectId === project.id && row.payload.runId === run.id && row.payload.toolId === record.toolId && row.payload.digest === record.artifactDigest && row.payload.result?.ok === true);
      const family = provenModelFamily(await settledModels(user.id, project.id, run));
      return { ok: used && answer.includes(record.prediction) && Boolean(family), predictionHash: hash(record.prediction), transcriptHash: hash(answer), toolId: record.toolId, digest: record.artifactDigest, modelFamily: family,
        ...(!family ? { status: 'waiting-provenance' } : {}) };
    },
    verifyTarget: async (_user, input) => verifyTargetUnpublished(input),
    async pollProspectiveTargets() {
      const records = await service.list('prospective');
      for (const row of records) {
        if (row.payload.registrationEligible !== true) continue;
        if (row.payload.status === 'awaiting-gold') { await service.enqueue('evaluate', { action: 'prospective-score', registrationId: row.id }, `prospective-gold-retry:${row.id}:${service.now().toISOString().slice(0,10)}`); continue; }
        if (row.payload.status !== 'waiting-publication') continue;
        const evidence = await verifyTargetUnpublished({ targetIdentity: row.payload.targetIdentity });
        if (evidence.unpublished === false && evidence.firstPublicAt && evidence.evidenceId) await service.ingestEvent({ id: `prospective-target:${row.id}:${evidence.evidenceId}`, type: 'prospective-target-result', paper: { id: row.payload.targetIdentity, identity: row.payload.targetIdentity, firstPublicAt: evidence.firstPublicAt, firstPublicEvidenceId: evidence.evidenceId, sourceUrl: evidence.sourceUrl, observationScope: evidence.scope } });
      }
      return { observed: records.length };
    },
    /** Actual completed platform run is the prediction producer. @param {any} user @param {any} input */
    async registerProspective(user, input, locked = false) {
      if (!locked && service.withLock) return service.withLock(`prospective-registration:${hash([input.toolId,input.artifactDigest,input.question,input.targetIdentity,input.prediction,input.preRegisteredProtocol])}`, () => this.registerProspective(user,input,true));
      const project = await store.requireProject(user, input.projectId);
      if (!isInternalProject(project.id)) throw new HttpError(400, 'evolution_evaluation_invalid', 'Prospective platform registration requires an internal evaluation project.');
      const tool = await service.get(input.toolId);
      if (!tool || tool.payload.artifactDigest !== input.artifactDigest) throw new HttpError(409, 'evolution_evaluation_invalid', 'The tool pin differs.');
      const run = (await agentRuns.list(project)).find(item => item.id === input.runId);
      if (!run || !['succeeded', 'delivered'].includes(run.status) || !run.sessionId) throw new HttpError(409, 'evolution_evaluation_invalid', 'An actual completed prediction run is required.');
      const stored = await readTranscript(project, run.id);
      const answers = prospectiveAnswerText(stored);
      if (!input.prediction || !answers.includes(input.prediction)) throw new HttpError(400, 'evolution_evaluation_invalid', 'The prediction must occur in the actual completed run transcript.');
      const actualUses = await service.list('use', user.id);
      const actualUse = actualUses.some(record => record.payload.projectId === project.id && record.payload.runId === run.id && record.payload.toolId === input.toolId && record.payload.digest === input.artifactDigest && record.payload.result?.ok === true);
      const modelRequests = await settledModels(user.id, project.id, run);
      const modelFamily = provenModelFamily(modelRequests);
      const release = await proof(user, project.id, input.modelReleaseEvidence);
      const availability = await proof(user, project.id, input.targetAvailabilityEvidence);
      const target = verifyTargetUnpublished ? await verifyTargetUnpublished({ targetIdentity: input.targetIdentity, evidence: availability, frozenAt: service.now().toISOString() }) : null;
      const releaseMatches = release && modelFamily && modelRequests.every(row => row.model === input.modelReleaseEvidence.model)
        && input.modelReleaseEvidence.quote.includes(input.modelReleaseEvidence.model) && input.modelReleaseEvidence.quote.includes(input.modelReleaseEvidence.releasedAt);
      const eligible = Boolean(actualUse && releaseMatches && Number.isFinite(Date.parse(input.modelReleaseEvidence.releasedAt ?? '')) && Date.parse(input.modelReleaseEvidence.releasedAt) <= service.now().getTime() && target?.unpublished === true && target.targetIdentity === input.targetIdentity && target.evidenceId && Number.isFinite(Date.parse(target.checkedAt ?? '')) && Date.parse(target.checkedAt) <= service.now().getTime() && service.now().getTime() - Date.parse(target.checkedAt) <= 300000);
      const execution = executionEvidence ? await executionEvidence.preserve({ userId: user.id, project, run, transcript: stored,
        predictionHash: hash(input.prediction), sealedAt: service.now().toISOString() }) : null;
      const saved = await integration.freezeProspective({ ...input, modelReleaseEvidenceId: release?.evidenceId ?? 'unverified', modelReleasedAt: release ? input.modelReleaseEvidence.releasedAt : null });
      if (saved.payload.producerRunId && (saved.payload.producerRunId !== run.id || saved.payload.userId !== user.id || saved.payload.projectId !== project.id || saved.payload.predictionHash !== hash(input.prediction) || saved.payload.transcriptHash !== hash(answers))) throw new HttpError(409, 'evolution_evaluation_invalid', 'Frozen producer and prediction evidence are immutable.');
      if (saved.payload.producerRunId && saved.payload.registrationEligible === true) {
        if (!saved.payload.executionEvidence && execution && Date.parse(execution.sealedAt) <= Date.parse(saved.payload.frozenAt)) return service.save('prospective', saved.id, { ...saved.payload, executionEvidence: execution }, saved);
        return saved;
      }
      const admitted = eligible && Date.parse(input.modelReleaseEvidence.releasedAt) <= Date.parse(saved.payload.frozenAt);
      const preservedExecution = saved.payload.executionEvidence ?? (execution && Date.parse(execution.sealedAt) <= Date.parse(saved.payload.frozenAt) ? execution : null);
      const record = await service.save('prospective', saved.id, { ...saved.payload, status: admitted ? 'waiting-publication' : 'waiting-provenance', registrationEligible: admitted, userId: user.id, projectId: project.id, track: tool.payload.track, producerRunId: run.id, actualPinnedToolUse: actualUse, producerRunCompletedAt: run.completedAt ?? run.finishedAt ?? null, transcriptHash: hash(answers), predictionHash: hash(input.prediction), executionEvidence: preservedExecution, modelReleaseEvidence: release, targetAvailabilityEvidence: availability, targetCheckedAt: target?.checkedAt ?? null, targetEvidenceId: target?.evidenceId ?? null, reason: admitted ? null : 'Preserved release or independent unpublished-target provenance is incomplete; no prospective score is admitted.' }, saved);
      await service.ingestEvent({ id: `prospective-registration:${record.id}`, type: 'prospective-registration', registrationId: record.id });
      return record;
    },
    /** Source hashes and exact quoted facts remain tenant owned. @param {any} user @param {any} input */
    async registerMetaUpdate(user, input) {
      await store.requireProject(user, input.projectId);
      const originalProof = await proof(user, input.projectId, input.originalMeta?.evidence);
      const incomingProof = await proof(user, input.projectId, input.newEvidence?.evidence);
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      const original = question && input.originalMeta?.evidence?.quote?.includes(question) && input.originalMeta?.evidence?.quote?.includes(input.originalMeta?.searchCutoff) ? originalProof : null;
      const incoming = question && input.newEvidence?.evidence?.quote?.includes(question) && input.newEvidence?.evidence?.quote?.includes(input.newEvidence?.firstPublicAt) ? incomingProof : null;
      const event = { id: `meta-evidence:${hash([user.id, input.projectId, original, incoming, input.originalMeta?.searchCutoff, input.newEvidence?.firstPublicAt])}`, type: 'meta-evidence-update', userId: user.id, projectId: input.projectId,
        originalMeta: original ? { ...input.originalMeta, questionId: hash(question), sourceId: original.sourceId, sha256: original.sha256 } : null,
        newEvidence: incoming ? { ...input.newEvidence, questionId: hash(question), sourceId: incoming.sourceId, sha256: incoming.sha256, firstPublicEvidenceId: incoming.evidenceId } : null };
      return service.ingestEvent(event);
    },
  };
}
