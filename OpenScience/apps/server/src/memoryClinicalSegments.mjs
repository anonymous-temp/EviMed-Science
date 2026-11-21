import { isPlatformStartedRun } from './memoryDispatch.mjs';
import { filterCapturedMessage } from './memoryGateway.mjs';
import { inputDigest, provenTranscriptInput } from './memoryHumanSegments.mjs';
import { presentationRule, presentationStatements } from './memoryPresentation.mjs';
import { withNativeMemoryWrite } from './nativeMemoryWriteFence.mjs';

export function clinicalSegmentDigest(userId, projectId, ref, quote) {
  return inputDigest(JSON.stringify([userId, projectId, ref.projectCreatedAt, ref.sessionId, ref.runId,
    ref.inputSeq, ref.inputDigest, ref.saidAt, quote]));
}

export function clinicalStatements(input, firstRead) {
  if (!input || !Number.isFinite(firstRead)) return [];
  if (input.time >= firstRead || Date.parse(input.run.memoryInput.at) >= firstRead) return presentationStatements(input.text, input.run.memoryInput.suppliedRanges);
  const captured = filterCapturedMessage({ role: 'user', content: input.text });
  return 'forward' in captured && !captured.masked ? [captured.forward.parts[0].text] : [];
}

/** Use the regular leased native admission queue. Only approved text is ever
 * queued. Revalidate the exact original at each retry and before engine writes. */
export function createClinicalSegments({ config, contexts, admission, overlay, native, store, runsOf, transcript, firstRead }) {
  async function scope(project, sessionId) {
    if (!config.memoryClinicalSegmentsEnabled || !config.memoryEngineEnabled || !contexts || !firstRead) return null;
    const context = await contexts.forProject(project);
    if (context.kind !== 'owned') return null;
    await contexts.assertLive(context);
    const runs = await runsOf(project, sessionId);
    if (!runs.length || runs.some(run => run.deleted || run.forkedFrom)) return null;
    const boundary = await firstRead(project.userId, project.id, runs.map(run => ({ sessionId, runId: run.id })));
    if (!Number.isFinite(boundary)) return null;
    return { context, runs, boundary };
  }
  async function candidates(project, sessionId, source) {
    const eligible = source.runs.filter(run => run.memoryInput && !isPlatformStartedRun(run));
    if (!eligible.length) return [];
    const page = await transcript(project, sessionId);
    if (!page?.exhausted) return [];
    const entries = [];
    for (const run of eligible) {
      const input = provenTranscriptInput(run, page.messages);
      if (!input) continue;
      const policy = await admission.admitSegment({ user: { id: project.userId }, project, engineSessionId: `dsh-${sessionId}`, at: input.time, runId: run.id });
      if (!policy.learn) continue;
      for (const quote of clinicalStatements(input, source.boundary)) {
        if (!quote || quote.length > 2000) continue;
        const afterRead = input.time >= source.boundary || Date.parse(run.memoryInput.at) >= source.boundary;
        const ref = {operation:'clinical-segment', ...(afterRead ? { presentationOnly:true } : {}), projectCreatedAt:source.context.projectCreatedAt, sessionId, runId:run.id,
          inputSeq:input.seq, inputDigest:run.memoryInput.digest, saidAt:new Date(input.time).toISOString()};
        const digest = clinicalSegmentDigest(project.userId,project.id,ref,quote);
        entries.push({text:quote,candidateId:'segment:' + digest, revision:1,projectId:project.id,engineSession:'evimed-segment-' + digest,
          externalSource:{...ref,digest}});
      }
    }
    return entries;
  }
  return {
    async capture(project, run) {
      const source = await scope(project, run.sessionId);
      if (!source) return;
      // The first controlled read may have discarded an earlier uncommitted
      // batch. Reconcile its human inputs too, with the same idempotent keys.
      for (const entry of await candidates(project, run.sessionId, source)) {
        await withNativeMemoryWrite(overlay.database, project.userId, async () => {
          const row = await overlay.queueAdmission(project.userId, entry);
          await native.processAdmission(project.userId, row);
        });
      }
    },
    async authorize(userId, row) {
      const project = await store.requireProject(await store.userById(userId), row.projectId);
      const ref = row.externalSource;
      const source = await scope(project, ref.sessionId);
      if (!source || source.context.projectCreatedAt !== ref.projectCreatedAt) return false;
      // The queue's immutable first-party receipt was minted from a complete
      // kernel transcript. Retries can verify it even after the runtime stops.
      const run = source.runs.find(item => item.id === ref.runId);
      const time = Date.parse(ref.saidAt);
      const digest = clinicalSegmentDigest(userId,project.id,ref,row.text);
      if (!run?.memoryInput || isPlatformStartedRun(run) || !run.kernelRequestIds?.length || run.memoryInput.digest !== ref.inputDigest
        || !Number.isSafeInteger(ref.inputSeq) || run.nativeTurn && run.nativeTurn.userSeq !== ref.inputSeq
        || !(Date.parse(run.memoryInput.at) <= time) || digest !== ref.digest || row.candidateId !== 'segment:' + digest
        || row.engineSession !== 'evimed-segment-' + digest || !row.text) return false;
      if (ref.presentationOnly && time < source.boundary || time >= source.boundary && !presentationRule(row.text)) return false;
      return (await admission.admitSegment({user:{id:userId},project,engineSessionId:'dsh-' + ref.sessionId,at:time,runId:run.id})).learn;
    },
  };
}
