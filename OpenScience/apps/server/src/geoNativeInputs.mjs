import { createHash, randomUUID } from 'node:crypto';
import { renderNativeQuestionReply } from '@evimed/harness-port/runtime-ui-scope';
import { nativeInputText } from '@evimed/harness-port';
import { normalizeTranscript } from './dshRuntimeAdapter.mjs';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';

const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const conflict = () => new HttpError(409, 'geo_native_input_conflict', 'This input identity already names another submission.');
const unavailable = () => new HttpError(503, 'geo_native_context_unavailable', 'The shared input context is unavailable.');
const requestIdValid = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** The plugin admission's own rule for an outcome it is not told (`PluginService.withAdmission`): a send that returned or a definitive
 * refusal settles the prompt; any other failure keeps the apply fence. */
const settled = error => !error ? 'accepted' : error.definitivelyRejected === true || error.status >= 400 && error.status < 500 ? 'refused' : 'unknown';
const immutableReceipt = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['observedAt', 'state', 'forwarding', 'outcome', 'consumption', 'incidents'].includes(key)));
const nativeRequest = request => Object.fromEntries(Object.entries(request).filter(([key]) => !['geoPlanContext', 'evimedResultRevision'].includes(key)));
const normalized = content => normalizeTranscript('candidate', [{ type: 'user/message', seq: 0, data: { content } }]).messages[0]?.parts ?? [];

/** Uses the actual transcript decoder; unsupported/lossy parts cannot be proved by text equality. */
export function nativeInputCandidate(request) {
  const forwarded = nativeRequest(request), parts = normalized(forwarded.content);
  const reconcilable = Array.isArray(forwarded.content) && forwarded.content.every(part => part?.type === 'text'
    && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key)));
  return { forwardedRequestDigest: digest(forwarded), forwardedContentDigest: digest(forwarded.content ?? []),
    transcriptContentDigest: digest(parts), rendererDigest: digest([nativeInputCandidate.toString(), normalizeTranscript.toString()]), reconcilable };
}

/** Bounded observation data only. No response/error prose is retained. */
export function observeNativeHttpInput(rpcId, response, operation = 'prompt') {
  const unknown = { state: 'unknown', authority: 'native-http', reasonCode: 'unproven_response' };
  if (response?.status < 200 || response?.status >= 300 || !String(response?.contentType).toLowerCase().includes('application/json')
    || !Buffer.isBuffer(response?.body) || response.body.length > 1024 * 1024) return unknown;
  let body;
  try { body = JSON.parse(response.body.toString('utf8')); } catch { return unknown; }
  return body?.type === 'server-response' && body.rpcId === rpcId && body.result?.ok === true && (operation === 'prompt' ? body.result.value?.accepted === true : operation === 'question-answer' ? body.result.value === true : operation === 'stop')
    ? { state: 'accepted', authority: 'native-http', responseDigest: digest(body) } : unknown;
}

/** The workspace ledger carries references, never content or an arbitrary actor payload. */
export function normalizeInputAttribution(value) {
  if (!value || value.version !== 1 || typeof value.namespaceId !== 'string' || typeof value.policyRef !== 'string'
    || !Number.isSafeInteger(value.count) || value.count < 0 || !Number.isSafeInteger(value.throughSeq) || value.throughSeq < 0
    || !hashValid(value.digest) || !Array.isArray(value.inputs)) return null;
  const valid = value.inputs.every(item => /^gni_[a-f0-9]{64}$/u.test(item?.referenceId ?? '') && requestIdValid(item.sourceRequestId)
    && Number.isSafeInteger(item.originalParts) && item.originalParts >= 0 && hashValid(item.originalTextDigest)
    && Number.isSafeInteger(item.inputSeq) && ['human', 'automated', 'unknown'].includes(item.actor?.kind)
    && (item.actor.kind !== 'human' || typeof item.actor.id === 'string' && typeof item.actor.createdAt === 'string'));
  if (!valid) return null;
  const inputs = value.inputs.slice(0, 64).map(item => ({ referenceId: item.referenceId, sourceRequestId: item.sourceRequestId,
    originalParts: item.originalParts, originalTextDigest: item.originalTextDigest,
    inputSeq: item.inputSeq, actor: item.actor.kind === 'human' ? { kind: 'human', id: item.actor.id, createdAt: item.actor.createdAt } : { kind: item.actor.kind } }));
  const unresolvedCount = Number.isSafeInteger(value.unresolvedCount) && value.unresolvedCount > 0 ? value.unresolvedCount : 0;
  const unresolvedInputs = Array.isArray(value.unresolvedInputs) ? value.unresolvedInputs.filter(item => /^gni_[a-f0-9]{64}$/u.test(item?.referenceId ?? '')).slice(0,64).map(item => ({ referenceId:item.referenceId, operation:'question-answer' })) : [];
  const observedThroughSeq = Number.isSafeInteger(value.observedThroughSeq) && value.observedThroughSeq >= 0 && value.observedThroughSeq <= value.throughSeq
    ? value.observedThroughSeq : value.throughSeq;
  return { version: 1, observedThroughSeq, ...(unresolvedCount ? { unresolvedCount, unresolvedInputs } : {}), namespaceId: value.namespaceId, policyRef: value.policyRef, count: value.count, digest: value.digest,
    throughSeq: value.throughSeq, complete: value.complete === true && unresolvedCount === 0 && value.inputs.length === value.count && inputs.length === value.count,
    inputs, ...(value.inheritedFrom ? { inheritedFrom: { sessionId: String(value.inheritedFrom.sessionId).slice(0,128) } } : {}) };
}

/** Applied under the ledger's storage mutation, and again during replay. An
 * older observation cannot erase stronger already-persisted input coverage. */
export function mergeInputAttribution(previous, value) {
  const current = normalizeInputAttribution(previous), next = normalizeInputAttribution(value);
  if (!current) return next;
  if (!next) return current;
  if (current.namespaceId !== next.namespaceId || current.policyRef !== next.policyRef) return { ...current, complete:false };
  if (next.throughSeq < current.throughSeq || next.observedThroughSeq < current.throughSeq) {
    if (!next.unresolvedCount) return current;
    const unresolved = new Map([...(current.unresolvedInputs ?? []),...(next.unresolvedInputs ?? [])].map(input=>[input.referenceId,input]));
    return normalizeInputAttribution({...current,complete:false,unresolvedCount:Math.max(current.unresolvedCount ?? 0,next.unresolvedCount),unresolvedInputs:[...unresolved.values()]});
  }
  if (next.count >= current.count && current.inputs.every(input => next.inputs.some(item => digest(item) === digest(input)))) return next;
  // Preserve every known contributor when a newer but incomplete view arrives.
  // Bounded projections cannot recreate a missing canonical full-set digest.
  const entries = new Map(current.inputs.map(input => [input.referenceId,input]));
  for (const input of next.inputs) if (!entries.has(input.referenceId)) entries.set(input.referenceId,input);
  const inputs = [...entries.values()].sort((a,b)=>a.inputSeq-b.inputSeq || a.referenceId.localeCompare(b.referenceId));
  return normalizeInputAttribution({ ...next, inputs, count:Math.max(current.count,next.count,inputs.length),
    throughSeq:Math.max(current.throughSeq,next.throughSeq), digest:digest(inputs), complete:false });
}

/** Internal accepted-input producer over the existing product ledger. Phase A is always committed before admission. */
export class GeoNativeInputs {
  // Only prepareOperation can establish an internal RPC. Browser object fields
  // cannot grant this provenance or replace the request being hashed.
  #nativeOperations = new WeakMap();
  // Inputs of a project its owner works in alone, passed through without a receipt (`prepare`), with the outcome of their admission.
  #owned = new WeakMap();
  constructor({ database, documents, authority, policies, resolveLaunchedContext, proveSession, contexts = null, revisions = null, previewContext = null, previewSelections = null, now = () => new Date() }) {
    this.database = database; this.documents = documents; this.authority = authority; this.policies = policies;
    this.resolveLaunchedContext = resolveLaunchedContext; this.proveSession = proveSession;
    this.contexts = contexts; this.revisions = revisions; this.previewContext = previewContext; this.previewSelections = previewSelections; this.now = now;
    this.operations = new WeakMap();
  }
  atomic(operation) {
    return this.database.transaction(client => this.database.withTransactionClient(client, () => operation(client)));
  }
  async scope(user, project, claims, expectedPolicy = null) {
    const identity = await this.authority.resolve(user, { kind: 'geo', geoProjectId: claims.delegation.geoProjectId,
      sessionId: claims.delegation.rootSessionId }, { claims: claims.delegation });
    const principal = identity.principal;
    // Phase A materializes the floor. Phase B only reads/revalidates it; taking
    // its creation advisory lock here would serialize every held admission.
    const policy = expectedPolicy
      ? this.policies.read(await this.documents.get(project.userId, 'geo-plan-context', expectedPolicy.referenceId), project.userId)
      : await this.policies.forProject(project);
    if (expectedPolicy && (policy.referenceId !== expectedPolicy.referenceId || policy.revision !== expectedPolicy.revision
      || policy.namespace.id !== expectedPolicy.namespaceId || policy.namespace.ownerCreatedAt !== principal.ownerCreatedAt
      || policy.namespace.projectCreatedAt !== principal.projectCreatedAt)) throw conflict();
    if (principal.ownerId !== project.userId || principal.controlProjectId !== project.id || principal.actorId !== user.id
      || policy?.ownerId !== project.userId || policy.controlProjectId !== project.id || !policy.namespace?.id) throw conflict();
    const launched = await this.resolveLaunchedContext?.({ project, principal, policy, claims });
    if (!launched || typeof launched.generation !== 'string' || !launched.generation || typeof launched.referenceId !== 'string'
      || !hashValid(launched.digest)) throw unavailable();
    return { principal, policy, runtime: { generation: launched.generation, launchedContextRef: launched.referenceId, launchedContextDigest: launched.digest } };
  }
  async candidate(user, project, request) {
    const forwarded = copy(request), bindings = [];
    const internal = this.#nativeOperations.get(request);
    if (internal) {
      const proof = internal.questionProof;
      const content = proof && renderNativeQuestionReply(proof);
      return { ...nativeInputCandidate(internal.nativeOperation), ...(content ? { transcriptContentDigest: digest(normalized(content)), reconcilable: true,
        question: { callId: proof.callId, answerDigest: digest(proof.answers), questionsDigest: digest(proof.questions), rendererDigest: digest(renderNativeQuestionReply.toString()) } } : { reconcilable: false }), bindings };
    }
    if (this.previewSelections) {
      const preview = await this.previewSelections(user, project, request);
      forwarded.content.push(...preview.parts); bindings.push(...preview.bindings);
      delete forwarded.geoPlanContext; delete forwarded.evimedResultRevision;
    } else if (request.geoPlanContext !== undefined) {
      if (!this.contexts) throw unavailable();
      const preview = await this.contexts.preview(user, project, request);
      forwarded.content.push(preview.part); delete forwarded.geoPlanContext; bindings.push(preview.binding);
    }
    if (!this.previewSelections && request.evimedResultRevision !== undefined) {
      if (!this.revisions) throw unavailable();
      const preview = await this.revisions.preview(user.id, project, forwarded);
      forwarded.content.push(preview.part); delete forwarded.evimedResultRevision; bindings.push(preview.binding);
    }
    // Optional handbook augmentation must have its own pure deterministic preview.
    if (this.previewContext) await this.previewContext(project, forwarded);
    return { ...nativeInputCandidate(forwarded), bindings };
  }
  async prepare({ user, project, claims, request, operation = 'prompt' }) {
    if (this.database.transactionScope?.()) throw new HttpError(409, 'geo_native_prepare_in_transaction', 'Prepare the shared input before admission.');
    // A GEO project with no member is its owner's (owner ruling 2026-10-25: `GeoSharedContext.forProject` answers `owned`). It has no
    // shared namespace or context launch to journal an input under, and its frame is issued to its owner alone, whose input is their
    // own as in their own frame of the project: it passes through under the frame's authority. Decided per input, so the first member
    // added or the last one removed takes effect at the next one. Journaled regardless, every prompt of such a project's
    // conversation was refused as a conflict and none reached the kernel.
    const policy = await this.policies.forProject(project);
    if (policy.kind !== 'geo-project') {
      if (!request || user.id !== project.userId || request.sessionId !== claims.delegation.rootSessionId) throw conflict();
      this.#owned.set(request, { state: 'pending' });
      return { referenceId: null, state: 'owned', replay: false };
    }
    if (!request || !requestIdValid(request.requestId) || request.sessionId !== claims.delegation.rootSessionId
      || !['prompt', 'question-answer', 'stop'].includes(operation)) throw conflict();
    if ('nativeOperation' in request || 'questionProof' in request) throw conflict();
    const internal = this.#nativeOperations.get(request);
    if (operation === 'prompt' ? internal : !internal || internal.operation !== operation) throw conflict();
    for (const [key,pattern] of Object.entries({geoPlanContext:/^gpc_[a-f0-9]{64}$/u,evimedResultRevision:/^rr_[a-f0-9]{64}$/u})) {
      const selection = request[key];
      if (selection !== undefined && (!selection || typeof selection !== 'object' || Object.keys(selection).length !== 1
        || !pattern.test(selection.referenceId ?? ''))) throw conflict();
    }
    const scope = await this.scope(user, project, claims), original = copy(internal?.nativeOperation ?? nativeRequest(request));
    if (!scope.principal.actorCreatedAt) throw unavailable();
    const payload = { recordType: 'geo-native-input', version: 1, operation, principal: copy(scope.principal),
      actor: { kind: 'human', id: user.id, createdAt: scope.principal.actorCreatedAt },
      ownerId: project.userId, controlProjectId: project.id, geoProjectId: scope.principal.geoProjectId, rootSessionId: request.sessionId,
      contextPolicy: { referenceId: scope.policy.referenceId, revision: scope.policy.revision, policyVersion: scope.policy.policyVersion, namespaceId: scope.policy.namespace.id },
      runtime: scope.runtime, frame: { id: claims.frameId, bindingDigest: digest({ userId: claims.userId, projectId: claims.projectId, delegation: claims.delegation }) },
      native: { requestId: request.requestId, requestedMode: request.mode ?? null, originalRequestDigest: digest(original), originalContentDigest: digest(original.content ?? []),
        originalTextDigest: digest(nativeInputText(original.content)), originalTextChars: nativeInputText(original.content).length,
        originalParts: original.content?.length ?? 0, originalPartsDigest: digest(normalized(original.content)) },
      selection: { ...(request.geoPlanContext ? { geoContextRef: request.geoPlanContext.referenceId } : {}),
        ...(request.evimedResultRevision ? { resultRevisionRef: request.evimedResultRevision.referenceId } : {}) },
      observedAt: this.now().toISOString(), state: 'pending', forwarding: null, outcome: null, consumption: null };
    const id = `gni_${digest([payload.contextPolicy.namespaceId, request.sessionId, request.requestId])}`;
    const matchesOriginal = row => row?.projectId === project.id && row.payload?.recordType === 'geo-native-input'
      && digest(immutableReceipt({ ...row.payload, candidate:null })) === digest(immutableReceipt({ ...payload, candidate:null }));
    // Resolve a replay before inspecting mutable bound revisions or rendering.
    // Fresh scope checks above are permission; the existing receipt is history.
    const existing = await this.documents.get(project.userId, 'geo-plan-context', id);
    if (existing) {
      if (!matchesOriginal(existing)) throw conflict();
      this.operations.set(request, { row:existing,user,project,claims,phase:'prepared',observation:null,replay:true });
      return { referenceId:id,state:existing.payload.state,replay:true };
    }
    const candidate = await this.candidate(user, project, request);
    let created = false;
    const row = await this.atomic(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
      const found = await this.documents.get(project.userId, 'geo-plan-context', id);
      if (found) {
        if (!matchesOriginal(found)) throw conflict();
        return found;
      }
      created = true;
      return this.documents.put(project.userId, 'geo-plan-context', id, { ...payload,candidate }, { projectId: project.id, expectedRevision: 0, transactionClient: client });
    });
    this.operations.set(request, { row, user, project, claims, phase: 'prepared', observation: null, replay: !created });
    return { referenceId: id, state: row.payload.state, replay: !created };
  }
  /** Native question responses are authenticated inputs too. Their RPC payload
   * is preserved only as a digest; a tool-generated reply wrapper is never
   * guessed to be a new human statement. Stop receipts are never statements. */
  async prepareOperation({ user, project, claims, method, payload, interaction = null }) {
    const answer = ['$events/result', 'userQuestions/answer'].includes(method);
    if (!answer && method !== 'session/cancel' || answer && !interaction) throw conflict();
    const nativeId = answer ? interaction.callId ? `reply:${interaction.callId}` : `event:${digest([claims.frameId, payload?.args?.clientId, payload?.args?.eventId])}` : `native-operation:${randomUUID()}`;
    const request = { requestId: nativeId, sessionId: claims.delegation.rootSessionId, content: [] };
    this.#nativeOperations.set(request, { operation: answer ? 'question-answer' : 'stop', nativeOperation: { method, payload },
      ...(method === 'userQuestions/answer' && interaction?.questions && payload.args?.answer?.answers ? { questionProof: {
        callId: interaction.callId, questions: interaction.questions, answers: payload.args.answer.answers } } : {}) });
    await this.prepare({ user, project, claims, request, operation: answer ? 'question-answer' : 'stop' });
    return request;
  }
  disposition(request) { return this.#owned.get(request)?.state ?? this.operations.get(request)?.row.payload.state ?? 'unknown'; }
  /** Whether this input is journaled here; an owned project's is not, and the frame records it as the owner's own frame would. */
  journals(request) { return !this.#owned.has(request); }
  observe(request, observation) {
    const operation = this.operations.get(request);
    if (!operation) return;
    if (observation?.state === 'accepted' || operation.observation?.state !== 'accepted') operation.observation = observation;
  }
  observeHttp(request, rpcId, response) {
    this.observe(request, observeNativeHttpInput(rpcId, response, this.operations.get(request)?.row.payload.operation));
  }
  async update(operation, patch) {
    return this.atomic(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operation.row.id]);
      const row = await this.documents.get(operation.project.userId, 'geo-plan-context', operation.row.id);
      if (!row || row.projectId !== operation.project.id || digest(immutableReceipt(row.payload)) !== digest(immutableReceipt(operation.row.payload))) throw conflict();
      if (patch.consumption && row.payload.consumption && digest(patch.consumption) !== digest(row.payload.consumption)) throw conflict();
      if (patch.consumption && row.payload.state === 'accepted' && row.payload.outcome?.authority === 'native-consumption'
        && digest(row.payload.consumption) === digest(patch.consumption)) { operation.row = row; return row; }
      const next = { ...row.payload, ...patch };
      if (row.payload.state === 'accepted' && patch.state !== undefined && patch.state !== 'accepted') { next.state = 'accepted'; next.outcome = row.payload.outcome; }
      if (digest(next) === digest(row.payload)) { operation.row = row; return row; }
      operation.row = await this.documents.put(operation.project.userId, 'geo-plan-context', row.id, next,
        { expectedRevision: row.revision, projectId: operation.project.id, transactionClient: client });
      return operation.row;
    });
  }
  async beforeForward(request) {
    if (this.#owned.has(request)) return;
    const operation = this.operations.get(request);
    if (!operation || operation.phase !== 'admitted') throw conflict();
    const scope = await this.scope(operation.user, operation.project, operation.claims, operation.row.payload.contextPolicy);
    if (digest(scope.runtime) !== digest(operation.row.payload.runtime)
      || digest(scope.principal) !== digest(operation.row.payload.principal)) throw conflict();
    const actual = this.#nativeOperations.has(request) ? await this.candidate(operation.user, operation.project, request) : nativeInputCandidate(request), expected = operation.row.payload.candidate;
    if (actual.forwardedRequestDigest !== expected.forwardedRequestDigest || actual.transcriptContentDigest !== expected.transcriptContentDigest) throw conflict();
    await this.update(operation, { forwarding: { at: this.now().toISOString(), requestDigest: actual.forwardedRequestDigest, contentDigest: actual.forwardedContentDigest } });
    operation.phase = 'sending';
  }
  async settleOperation(operation, error = null) {
    const observation = operation.observation;
    const state = observation?.state === 'accepted' ? 'accepted' : operation.phase === 'sending' ? 'unknown' : 'refused';
    await this.update(operation, { state, outcome: { at: this.now().toISOString(), authority: observation?.authority ?? 'hosted',
      ...(observation?.responseDigest ? { responseDigest: observation.responseDigest } : {}), reasonCode: state === 'refused' ? 'pre_send_refusal' : state === 'unknown' ? 'acceptance_unknown' : 'native_accepted' } });
    return { value: null, error, disposition: operation.row.payload.state };
  }
  /** Returns through membership before surfacing errors, so its same-client evidence commits. */
  async execute(request, withAuthority, business) {
    const owned = this.#owned.get(request);
    if (owned) {
      try {
        const value = await withAuthority(business);
        owned.state = settled(null);
        return { value, error: null, disposition: owned.state };
      } catch (error) {
        owned.state = settled(error);
        return { value: null, error, disposition: owned.state };
      }
    }
    const operation = this.operations.get(request);
    if (!operation) throw unavailable();
    if (operation.replay) throw new HttpError(409, 'geo_native_input_already_submitted', 'This input was already submitted; its recorded outcome is retained.');
    try { return await withAuthority(async () => {
        let result;
        try {
          result = await this.atomic(async () => {
            const scope = await this.scope(operation.user, operation.project, operation.claims, operation.row.payload.contextPolicy);
            if (digest(scope.runtime) !== digest(operation.row.payload.runtime) || digest(scope.principal) !== digest(operation.row.payload.principal)) throw conflict();
            const current = await this.candidate(operation.user, operation.project, request);
            if (digest(current) !== digest(operation.row.payload.candidate)) throw conflict();
            operation.phase = 'admitted';
            try {
              const value = await business();
              return { ...(await this.settleOperation(operation)), value };
            } catch (error) {
              if (operation.phase !== 'sending') throw error;
              return this.settleOperation(operation, error);
            }
          });
        } catch (error) {
          if (!(error instanceof HttpError) && operation.phase !== 'prepared' && operation.phase !== 'admitted') throw error;
          result = await this.settleOperation(operation, error);
        }
        return result;
      }); } catch (error) {
      // Membership may refuse before entering its callback. Its savepoint has
      // released; settle on the plugin's still-held client, or a short scope
      // if there was no plugin admission. SQL/commit failures remain unknown.
      if (operation.phase !== 'sending' && error instanceof HttpError) return this.settleOperation(operation, error);
      throw error;
    }
  }
  async afterAdmission(request, error) {
    const owned = this.#owned.get(request);
    if (owned) { if (owned.state === 'pending') owned.state = settled(error); return; }
    const operation = this.operations.get(request);
    if (!operation || operation.replay) return;
    if (this.database.transactionScope?.()) throw unavailable();
    await this.settleOperation(operation, error);
  }
  async receipt(project, namespaceId, sessionId, requestId) {
    const id = `gni_${digest([namespaceId, sessionId, requestId])}`;
    const row = await this.documents.get(project.userId, 'geo-plan-context', id);
    return row?.projectId === project.id && row.payload.recordType === 'geo-native-input' ? row : null;
  }
  async unresolvedQuestions(project, policy, sessionId) {
    const references = [];
    let cursor = null;
    do {
      const page = await this.documents.list(project.userId, 'geo-plan-context', { projectId: project.id, limit: 100, cursor,
        filter: { recordType:'geo-native-input', operation:'question-answer', rootSessionId:sessionId,
          contextPolicy:{namespaceId:policy.namespace.id} } });
      for (const row of page.items) if (row.payload.state !== 'refused' && !row.payload.consumption) references.push({referenceId:row.id,operation:'question-answer'});
      cursor = page.nextCursor;
    } while (cursor);
    return references;
  }
  async consumedForRun(project, policy, run) {
    const found = [];
    let cursor = null;
    do {
      const page = await this.documents.list(project.userId, 'geo-plan-context', {projectId:project.id,limit:100,cursor,
        filter:{recordType:'geo-native-input',state:'accepted',ownerId:project.userId,controlProjectId:project.id,
          rootSessionId:run.sessionId,contextPolicy:{namespaceId:policy.namespace.id},consumption:{runId:run.id}}});
      found.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return found;
  }
  async reconcileTurn(project, transcript, turn, run) {
    const policy = await this.policies.forProject(project), inputs = [], failures = [];
    // Attribution is the shared namespace's: an owned project -- every ordinary project, and a GEO project its owner works in
    // alone -- has no namespace to attribute inputs to. Reading `policy.namespace` there threw on every reconcile cycle and
    // wrote 「Some native inputs could not be attributed」 every 15 s for the whole of an ordinary run (2026-10-27).
    if (!policy?.namespace?.id) return null;
    const seenSequences = new Set(), seenRequests = new Set();
    const sessionMatches = transcript.sessionId === run.sessionId && Number.isSafeInteger(turn.startSeq);
    for (const message of turn.inputs) {
      if (!sessionMatches || message.turnStartSeq !== turn.startSeq || !Number.isSafeInteger(message.seq)
        || seenSequences.has(message.seq) || seenRequests.has(message.sourceRequestId)) { failures.push(message.seq); continue; }
      seenSequences.add(message.seq); seenRequests.add(message.sourceRequestId);
      const row = requestIdValid(message.sourceRequestId) ? await this.receipt(project, policy.namespace.id, run.sessionId, message.sourceRequestId) : null;
      if (!row || !row.payload.candidate.reconcilable || !((row.payload.operation === 'prompt' && message.source === 'user')
        || (row.payload.operation === 'question-answer' && message.source === 'user-question-reply' && message.answeredCallId === row.payload.candidate.question?.callId))) { failures.push(message.seq); continue; }
      const payload = row.payload;
      const proof = await this.proveSession?.({ project, receipt: payload, transcript, turn });
      if (!proof || proof.namespaceId !== payload.contextPolicy.namespaceId || proof.rootSessionId !== payload.rootSessionId
        || proof.launchedContextRef !== payload.runtime.launchedContextRef || proof.launchedContextDigest !== payload.runtime.launchedContextDigest
        || proof.generation !== payload.runtime.generation || digest(message.parts) !== payload.candidate.transcriptContentDigest
        || digest(message.parts.slice(0,payload.native.originalParts)) !== payload.native.originalPartsDigest
        || digest(nativeInputText(message.parts.slice(0,payload.native.originalParts))) !== payload.native.originalTextDigest) { failures.push(message.seq); continue; }
      let bindings = true;
      for (const binding of payload.candidate.bindings) {
        const resolver = binding.kind === 'geo-plan-context' ? this.contexts : this.revisions;
        if (!await resolver?.verifyConsumedBinding?.(project, payload, binding)) { bindings = false; break; }
      }
      if (!bindings || payload.consumption && (payload.consumption.runId !== run.id || payload.consumption.inputSeq !== message.seq)) { failures.push(message.seq); continue; }
      const operation = { row, project };
      await this.update(operation, { state: 'accepted', outcome: { at: this.now().toISOString(), authority: 'native-consumption' },
        consumption: { runId: run.id, turnStartSeq: turn.startSeq, userSeq: turn.inputs[0].seq, inputSeq: message.seq, sourceRequestId: message.sourceRequestId, source: message.source } });
      inputs.push({ referenceId: row.id, sourceRequestId: message.sourceRequestId, inputSeq: message.seq, actor: payload.actor, originalParts: payload.native.originalParts, originalTextDigest: payload.native.originalTextDigest });
    }
    // Legacy attended waterfalls do not expose their tool-call identity on the
    // wire. Never call a turn complete while a potentially consumed answer in
    // this exact namespace/root remains unassociated. No timestamp/text joins.
    const unresolved = await this.unresolvedQuestions(project, policy, run.sessionId);
    const rows = await this.consumedForRun(project,policy,run), canonicalInputs = [];
    for (const row of rows) {
      const payload = row.payload, consumed = payload.consumption;
      const entry = {referenceId:row.id,sourceRequestId:consumed.sourceRequestId,inputSeq:consumed.inputSeq,actor:payload.actor,
        originalParts:payload.native.originalParts,originalTextDigest:payload.native.originalTextDigest};
      const checked = normalizeInputAttribution({version:1,namespaceId:policy.namespace.id,policyRef:policy.referenceId,
        count:1,throughSeq:consumed.inputSeq,digest:digest([entry]),inputs:[entry],complete:true});
      if (!checked || consumed.turnStartSeq !== turn.startSeq || consumed.sourceRequestId !== payload.native.requestId) { failures.push(consumed.inputSeq); continue; }
      canonicalInputs.push(entry);
    }
    canonicalInputs.sort((a,b)=>a.inputSeq-b.inputSeq || a.referenceId.localeCompare(b.referenceId));
    const unmatched = turn.inputs.filter(message=>!canonicalInputs.some(input=>input.sourceRequestId===message.sourceRequestId && input.inputSeq===message.seq)).length;
    const observedThroughSeq = Math.max(turn.startSeq,...turn.inputs.map(item=>item.seq));
    const throughSeq = Math.max(observedThroughSeq,...canonicalInputs.map(item=>item.inputSeq));
    const snapshotCoversCanonical = canonicalInputs.every(input=>inputs.some(item=>item.referenceId===input.referenceId && item.inputSeq===input.inputSeq));
    const projection = normalizeInputAttribution({ version:1,unresolvedCount:unresolved.length,unresolvedInputs:unresolved,namespaceId:policy.namespace.id,policyRef:policy.referenceId,
      count:Math.max(turn.inputs.length,rows.length+unmatched),observedThroughSeq,throughSeq,digest:digest(canonicalInputs),inputs:canonicalInputs,
      complete:failures.length===0 && snapshotCoversCanonical && transcript.exhausted!==false,
      ...(run.forkedFrom ? {inheritedFrom:{sessionId:run.forkedFrom}} : {}) });
    return projection;
  }
  async consumedContexts(project, run, hint = null) {
    let cursor = null;
    const found = [];
    do {
      const page = await this.documents.list(project.userId, 'geo-plan-context', { projectId: project.id, limit: 100, cursor,
        filter: { recordType: 'geo-native-input', state: 'accepted', rootSessionId: run.sessionId, consumption: { runId: run.id } } });
      for (const row of page.items) {
        if (!run.kernelRequestIds?.includes(row.payload.native.requestId)) continue;
        for (const binding of row.payload.candidate.bindings.filter(item => item.kind === 'geo-plan-context' && (!hint || item.id === hint))) {
          const context = await this.contexts?.consumedBinding(project, row.payload, binding);
          if (context) found.push(context);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  }
  async forRun(project, run, transcript) {
    const inputs = transcript.messages.filter(message=>message.turnStartSeq===run.nativeTurn?.startSeq && message.role==='user');
    return this.reconcileTurn(project,transcript,{startSeq:run.nativeTurn?.startSeq,inputs},run);
  }
}
