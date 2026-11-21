import { isInternalProjectOf } from './internalProjects.mjs';
import { isPlatformStartedRun } from './memoryDispatch.mjs';
import { clinicalSegmentDigest } from './memoryClinicalSegments.mjs';
import { inputDigest } from './memoryHumanSegments.mjs';
import { memoryPausedFor } from './memorySettings.mjs';
import { statementSource } from './memoryStatementSources.mjs';
import { presentationBinding, presentationRule } from './memoryPresentation.mjs';
import { lineFingerprint, memoryLines } from './nativeMemoryOverlay.mjs';
import { methodSourceAllowsLearning } from './runLearningScope.mjs';
import { parseArchiveUri, platformSessionOf } from './openVikingSessions.mjs';

/** Read-only account projections. Every read reopens the current record and its
 * authority. Disabling the experiment or withdrawing the source removes the
 * projection without changing the method's capability, native file or digest. */
export function createAccountProjections({ config, native, overlay, methods, provenance, settings, contexts,
  projectFor, projectRuns, deleted, clinical, verification = null }) {
  async function visible(userId, projectId, sessionId = null, epoch = null) {
    if (!contexts || !projectId || isInternalProjectOf(config, userId, projectId)) return null;
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
  async function checkedRun(userId, projectId, quote, { runId = null, sessionId = null, epoch = null, segment = null } = {}) {
    const project = await visible(userId, projectId, sessionId, epoch);
    if (!project) return null;
    const digest = segment?.inputDigest ?? inputDigest(quote);
    const matches = (await projectRuns(project)).filter(run => (!runId || runId === run.id) && (!sessionId || sessionId === run.sessionId)
      && !run.deleted && !run.forkedFrom && !isPlatformStartedRun(run) && run.memoryInput?.digest === digest && run.kernelRequestIds?.length);
    if (matches.length !== 1) return null;
    const run = matches[0], reset = await settings.resetInstant(userId);
    // A receipt for a whole pasted assertion proves who sent it, not who said it.
    // A separately admitted clinical excerpt has already been checked against its exact range.
    if ((!segment || run.memoryInput.digest === inputDigest(quote)) && run.memoryInput.suppliedRanges?.length) return null;
    if (!methodSourceAllowsLearning(run) || reset && !(Date.parse(run.memoryInput.at) >= Date.parse(reset))) return null;
    if (!await visible(userId, projectId, run.sessionId, epoch) || !segment && await clinical(userId, projectId, [{sessionId:run.sessionId,runId:run.id}])) return null;
    return run;
  }

  /** Reopen the archive only after the source project and conversation are still eligible.
   * The two reviewers keep message positions and hashes. Neither the stored paraphrase nor
   * a substring of a qualified request can become the account instruction. */
  async function reviewedQuote(userId, file, line, ref, statement, attestation, cache) {
    if (!ref?.projectCreatedAt || !ref.archiveUri) return undefined;
    const segment = attestation?.operation === 'clinical-segment' && config.memoryClinicalSegmentsEnabled
      && ref.engineSession === 'evimed-segment-' + attestation.digest && ref.projectCreatedAt === attestation.projectCreatedAt;
    const sessionId = segment ? attestation.sessionId : platformSessionOf(ref.engineSession);
    const binding = statement?.locator?.presentation;
    if (binding === false) return null;
    let verified, legacyLocator;
    if (config.memoryCommitVerificationEnabled) {
      if (!cache.commits.has(ref.archiveUri)) cache.commits.set(ref.archiveUri, await overlay.commit(userId, ref.archiveUri));
      const findings = cache.commits.get(ref.archiveUri)?.extraction?.sourceVerification?.findings ?? [];
      const digest = inputDigest(line);
      const matching = findings.filter(finding => finding.uri === file.uri && finding.fingerprint === lineFingerprint(line));
      if (matching.some(finding => ['unsupported', 'corrected', 'attribution_wrong'].includes(finding.status)
        && finding.presentation?.lineDigest !== digest)) return null;
      const supported = findings.filter(finding => finding.uri === file.uri && finding.presentation?.lineDigest === digest
        && ['supported', 'corrected', 'attribution_wrong'].includes(finding.status));
      if (supported.length > 1) return null;
      verified = supported[0]?.presentation;
      // Older clause reviews kept only the verdict. A complete SRC quotation from
      // the same line's immutable archive can supply its missing message position.
      if (!verified && matching.length === 1 && matching[0].status === 'supported' && !binding
        && statement?.locator?.quoteStart === 0) legacyLocator = statement.locator;
    }
    if (!verified && !binding && !legacyLocator) return undefined;
    if (!verification || !sessionId || parseArchiveUri(ref.archiveUri)?.session !== ref.engineSession
      || ref.sources?.length && !(verified && ref.sources.length === 1 && ref.sources[0].archiveUri === ref.archiveUri)
      || !await visible(userId, ref.projectId, sessionId, ref.projectCreatedAt)
      || !segment && await clinical(userId, ref.projectId, [{ sessionId }])) return null;
    if (statement && (statement.kind !== 'user_statement' || statement.speaker !== 'user' || statement.subject !== 'self'
      || statement.conditions !== 'preserved')) return null;
    if (binding && verified && (binding.message !== verified.message || binding.digest !== verified.digest)) return null;
    const proof = verified ?? binding ?? legacyLocator;
    const messages = await verification.readSources(userId, [ref], null, cache.messages, { structured: true });
    const current = presentationBinding(messages, proof.message);
    if (!current) return null;
    const message = messages[proof.message];
    if (legacyLocator ? legacyLocator.quoteLength !== message.text.length : current.digest !== proof.digest) return null;
    if (segment && clinicalSegmentDigest(userId, ref.projectId, attestation, message.text) !== attestation.digest) return null;
    return { quote: message.text, statement: { kind: 'user_statement', speaker: 'user', subject: 'self',
      conditions: 'preserved', personalFact: true, date: message.created_at ?? null,
      locator: { message: proof.message, quoteStart: 0, quoteLength: message.text.length } } };
  }

  async function ownedLines(userId, files, classify, { presentation = false } = {}) {
    const words = line => line.replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/iu, '').trim();
    const ordinary = files.filter(file => !file.namespaceId && !file.sensitive && (presentation || memoryLines(file.body).some(line => classify(words(line)))));
    if (!ordinary.length) return [];
    const records = await native.records(userId, { files: ordinary });
    const earlier = config.memoryPreferenceReconcileEnabled && ordinary.some(file => file.type === 'preferences')
      ? await native.earlierPreferenceValues(userId) : new Map();
    const origins = await overlay.originsOf(userId, ordinary.map(file => file.uri));
    const archives = [...new Set([...origins.values()].flatMap(lines => [...lines.values()].map(ref => ref.archiveUri)).filter(Boolean))];
    const external = archives.length && overlay.externalSources ? await overlay.externalSources(userId, archives) : new Map();
    const reset = await settings.resetInstant(userId);
    const results = [];
    const cache = { messages: new Map(), commits: new Map() };
    for (const record of records) {
      const file = ordinary.find(item => item.uri === record.uri);
      if (reset && !(Date.parse(record.updatedAt) >= Date.parse(reset))) continue;
      if (!file || record.status !== 'active' || record.sensitive || record.relations?.validity?.sources?.length || record.sourcePrivacy?.classification !== 'ordinary') continue;
      if (file.projectId && !await visible(userId, file.projectId)) continue;
      const superseded = new Set((earlier.get(record.uri) ?? []).map(lineFingerprint));
      const lines = memoryLines(record.value);
      for (const line of lines) {
        let quote = words(line);
        if (superseded.has(lineFingerprint(line))) continue;
        const ref = origins.get(file.uri)?.get(lineFingerprint(line));
        let statement = record.statementSources?.find(row => row.text === line)?.source;
        if (presentation) statement ??= statementSource(line, ref);
        if (statement && (!['user_statement', 'user_opinion', 'user_edit'].includes(statement.kind)
          || statement.speaker !== 'user' || statement.subject === 'other' || statement.conditions === 'missing')) continue;
        const manual = record.origin === 'manual' && lines.length === 1 && !ref?.engineSession;
        const attestation = external.get(ref?.archiveUri);
        let reviewed = false;
        if (presentation && !manual) {
          const original = await reviewedQuote(userId, file, line, ref, statementSource(line, ref), attestation, cache);
          if (original === null) continue;
          if (original) {
            ({ quote, statement } = original);
            reviewed = true;
          }
        }
        if (!classify(quote)) continue;
        const segment = attestation?.operation === 'clinical-segment' && config.memoryClinicalSegmentsEnabled
          && presentationRule(quote)?.standing && ref.projectCreatedAt === attestation.projectCreatedAt
          && ref.engineSession === 'evimed-segment-' + attestation.digest
          && clinicalSegmentDigest(userId,ref.projectId,attestation,quote) === attestation.digest
          ? attestation : null;
        const sessionId = segment?.sessionId ?? platformSessionOf(ref?.engineSession);
        if (!manual && !(sessionId && ref?.archiveUri && ref.projectCreatedAt && (!ref.sources?.length || segment || reviewed)
          && await checkedRun(userId, ref.projectId, quote, { sessionId, runId:segment?.runId, epoch:ref.projectCreatedAt, segment }))) continue;
        const source = {id:record.id,contentDigest:record.contentHash,sourcePrivacy:record.sourcePrivacy,attribution:record.attribution};
        results.push({ quote, source, statement, projectId:ref?.projectId ?? file.projectId, updatedAt:record.updatedAt, origin:record.origin });
      }
    }
    return results;
  }

  async function read(userId, projectId, sessionId, manage = false) {
    if (!config.memoryAccountPresentationEnabled || (!sessionId && !manage) || !await visible(userId, projectId, sessionId)
      || sessionId && await clinical(userId, projectId, [{sessionId}])) return [];
    const standing = text => presentationRule(text)?.standing === true;
    const inventory = [...(await overlay.files(userId)).values()].filter(file => !file.sensitive && /\/preferences\/(?:self|corrections)\//u.test(file.uri));
    const files = inventory.length ? await native.files(userId, { uris:inventory.slice(0,100).map(file=>file.uri) }) : [];
    const lines = await ownedLines(userId, files.filter(file=>['preferences','corrections'].includes(file.type)), standing, { presentation: true });
    for (const method of await methods?.approvedMethods(userId) ?? []) {
      const p = method.payload, evidence = p.provenance?.evidence;
      if (p.status !== 'approved' || p.personCorrection?.revokedAt || !Array.isArray(evidence) || !methodSourceAllowsLearning(p.provenance)
        || !evidence.some(item=>standing(item.quote)) || !await provenance?.ordinaryDocument(userId,method)) continue;
      for (const item of evidence) {
        if (p.bodyVersion > 1 && !String(p.body).split('\n').some(line => line.trim() === item.quote)) continue;
        if (!standing(item.quote) || !item.runId || !await checkedRun(userId,p.provenance.sourceProjectId,item.quote,{runId:item.runId})) continue;
        lines.push({quote:item.quote,statement:undefined,projectId:p.provenance.sourceProjectId,origin:'engine',updatedAt:method.updatedAt,source:{id:method.id,contentDigest:p.contentDigest,
          sourcePrivacy:p.provenance.sourcePrivacy,attribution:{schemaVersion:1,origins:['engine'],confirmed:false}}});
      }
    }
    const memos = [], seen = new Set();
    let chars = 0;
    for (const line of lines.sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
      const id = 'presentation:' + inputDigest(line.quote);
      if (seen.has(id)) continue;
      seen.add(id);
      const disabled = (await overlay.instructionCheck(userId,id))?.disabled === true;
      if (!manage && (disabled || chars + line.quote.length > 400)) continue;
      chars += line.quote.length;
      memos.push({id, memoryType:'native_standing_preference',kind:'preference',scope:'user',applicationScope:'account-presentation',
        origin:line.origin,content:line.quote,updatedAt:line.updatedAt,
        ...(line.statement ? { statementSources:[{ text:line.quote, source:line.statement }] } : {}),originalSources:[line.source],sourcePrivacy:line.source.sourcePrivacy,
        attribution:line.source.attribution,...(manage ? {disabled} : {})});
    }
    return memos;
  }
  return {
    ownedLines,
    presentation: (userId, projectId, sessionId) => read(userId,projectId,sessionId),
    list: userId => read(userId,'default',null,true),
    async setEnabled(userId,id,enabled) {
      if (!(await read(userId,'default',null,true)).some(memo => memo.id === id)) return false;
      await overlay.recordInstructionCheck(userId,id,{disabled:!enabled},{replace:true});
      return true;
    },
  };
}
