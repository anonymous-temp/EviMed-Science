import { isInternalProjectOf } from './internalProjects.mjs';
import { isPlatformStartedRun } from './memoryDispatch.mjs';
import { inputDigest } from './memoryHumanSegments.mjs';
import { memoryPausedFor } from './memorySettings.mjs';
import { presentationRule } from './memoryPresentation.mjs';
import { lineFingerprint, memoryLines } from './nativeMemoryOverlay.mjs';
import { methodSourceAllowsLearning } from './runLearningScope.mjs';
import { platformSessionOf } from './openVikingSessions.mjs';

/** Read-only account projections. Every read reopens the current record and its
 * authority. Disabling the experiment or withdrawing the source removes the
 * projection without changing the method's capability, native file or digest. */
export function createAccountProjections({ config, native, overlay, methods, provenance, settings, contexts,
  projectFor, projectRuns, deleted, clinical }) {
  async function visible(userId, projectId, sessionId = null, epoch = null) {
    if (!projectId || isInternalProjectOf(config, userId, projectId)) return null;
    const project = await projectFor(userId, projectId);
    if (!project || project.userId !== userId) return null;
    const context = await contexts.forProject(project);
    if (context.kind !== 'owned' || epoch && context.projectCreatedAt !== epoch) return null;
    await contexts.assertLive(context);
    if ((await memoryPausedFor(settings, userId, projectId, sessionId)).recall || sessionId && await deleted(project, sessionId)) return null;
    return project;
  }

  /** Check the full human assertion, including any restriction around it.
   * A substring that drops "for this project" is not a scope grant. */
  async function checkedRun(userId, projectId, quote, { runId = null, sessionId = null, epoch = null } = {}) {
    const project = await visible(userId, projectId, sessionId, epoch);
    if (!project) return null;
    const digest = inputDigest(quote);
    const matches = (await projectRuns(project)).filter(run => (!runId || runId === run.id) && (!sessionId || sessionId === run.sessionId)
      && !run.deleted && !run.forkedFrom && !isPlatformStartedRun(run) && run.memoryInput?.digest === digest && run.kernelRequestIds?.length);
    if (matches.length !== 1) return null;
    const run = matches[0], reset = await settings.resetInstant(userId);
    if (!methodSourceAllowsLearning(run) || reset && !(Date.parse(run.memoryInput.at) >= Date.parse(reset))) return null;
    if (!await visible(userId, projectId, run.sessionId, epoch) || await clinical(userId, projectId, [{sessionId:run.sessionId,runId:run.id}])) return null;
    return run;
  }

  async function ownedLines(userId, files, classify) {
    const ordinary = files.filter(file => !file.namespaceId && !file.sensitive && memoryLines(file.body).some(line => classify(line)));
    if (!ordinary.length) return [];
    const records = await native.records(userId, { files: ordinary });
    const origins = await overlay.originsOf(userId, ordinary.map(file => file.uri));
    const results = [];
    for (const record of records) {
      const file = ordinary.find(item => item.uri === record.uri);
      if (!file || record.status !== 'active' || record.sensitive || record.relations?.validity?.sources?.length || record.sourcePrivacy?.classification !== 'ordinary') continue;
      if (file.projectId && !await visible(userId, file.projectId)) continue;
      const lines = memoryLines(record.value);
      for (const line of lines) {
        const quote = line.replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/iu, '').trim();
        if (!classify(quote)) continue;
        const ref = origins.get(file.uri)?.get(lineFingerprint(line));
        // A manual page edit of a standalone assertion is first-party evidence.
        const manual = record.origin === 'manual' && lines.length === 1 && !ref?.engineSession;
        const sessionId = platformSessionOf(ref?.engineSession);
        if (!manual && !(sessionId && ref?.archiveUri && ref.projectCreatedAt && !ref.sources?.length
          && await checkedRun(userId, ref.projectId, quote, { sessionId, epoch:ref.projectCreatedAt }))) continue;
        const source = {id:record.id,contentDigest:record.contentHash,sourcePrivacy:record.sourcePrivacy,attribution:record.attribution};
        results.push({ quote, source, projectId:ref?.projectId ?? file.projectId, updatedAt:record.updatedAt, origin:record.origin });
      }
    }
    return results;
  }

  return {
    ownedLines,
    async presentation(userId, projectId, sessionId) {
      if (!config.memoryAccountPresentationEnabled || !sessionId || !await visible(userId, projectId, sessionId)
        || await clinical(userId, projectId, [{sessionId}])) return [];
      const standing = text => presentationRule(text)?.standing === true;
      const inventory = [...(await overlay.files(userId)).values()].filter(file => !file.sensitive && /\/preferences\/(?:self|corrections)\//u.test(file.uri));
      const files = inventory.length ? await native.files(userId, { uris:inventory.slice(0,100).map(file=>file.uri) }) : [];
      const lines = await ownedLines(userId, files.filter(file=>['preferences','corrections'].includes(file.type)), standing);
      for (const method of await methods?.approvedMethods(userId) ?? []) {
        const p = method.payload, evidence = p.provenance?.evidence;
        if (p.status !== 'approved' || !Array.isArray(evidence) || !methodSourceAllowsLearning(p.provenance)
          || !evidence.some(item=>standing(item.quote)) || !await provenance?.ordinaryDocument(userId,method)) continue;
        for (const item of evidence) {
          if (!standing(item.quote) || !item.runId || !await checkedRun(userId,p.provenance.sourceProjectId,item.quote,{runId:item.runId})) continue;
          lines.push({quote:item.quote,origin:'engine',updatedAt:method.updatedAt,source:{id:method.id,contentDigest:p.contentDigest,
            sourcePrivacy:p.provenance.sourcePrivacy,attribution:{schemaVersion:1,origins:['engine'],confirmed:false}}});
        }
      }
      let chars = 0;
      const seen = new Set();
      return lines.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).flatMap(line=>{
        if (seen.has(line.quote) || chars + line.quote.length > 400) return [];
        seen.add(line.quote); chars += line.quote.length;
        return [{id:`presentation:${inputDigest(JSON.stringify([line.source.id,line.source.contentDigest,line.quote])).slice(0,32)}`,
          memoryType:'native_standing_preference',kind:'preference',scope:'user',applicationScope:'account-presentation',
          origin:line.origin,content:line.quote,updatedAt:line.updatedAt,originalSources:[line.source],sourcePrivacy:line.source.sourcePrivacy,attribution:line.source.attribution}];
      });
    },
  };
}
