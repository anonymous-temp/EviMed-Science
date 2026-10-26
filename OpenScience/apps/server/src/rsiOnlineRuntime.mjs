import { createHash } from 'node:crypto';
import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { ensureEvidenceProject, isInternalProject, EVIDENCE_PROJECT_ID } from './internalProjects.mjs';
import { readVerifiedRunTranscript } from './runTranscripts.mjs';
import { preservedConversationHistory } from './conversationHistory.mjs';
import { createRsiIncidentExports } from './rsiIncidentExports.mjs';
import { loadRsiOnlineConfiguration } from './rsiOnlineConfiguration.mjs';
import { createRsiOssTransport } from './rsiOssTransport.mjs';
import { createRsiOnlineWorker } from './rsiOnlineWorker.mjs';
import { callModelForControlPlane } from './modelGateway.mjs';
import { createRsiDeploymentAuthority, createRsiTrustRegistry } from './rsiDeploymentAuthority.mjs';
import { RsiCampaignImporter } from './rsiCampaignImporter.mjs';

/** Only a recorded incident is an extraction candidate; a normal completed conversation is not.
 * @param {any} run */
export function rsiIncidentRunEligible(run) {
  if (!run || run.automated === true) return false;
  return run.status === 'failed' || (run.qualityNotices ?? []).some(notice =>
    ['run_tool_failed', 'run_tool_unavailable'].includes(notice?.code)) ||
    String(run.effectiveRouteReason ?? '').includes(':classifier:');
}

/** Canonical source reader: project authorization, exact retained bytes, root prose, one run.
 * The authority port resolves a deployment-owned agreement; it never accepts a request's boolean.
 * @param {any} dependencies */
export function createRsiAuthorizedTranscriptReader({ store, agentRuns, agreementId, authority, assertModelAccess, readTranscript = readVerifiedRunTranscript }) {
  return async binding => {
    if (!authority || !binding.authorizationId) return null;
    let activeAgreement;
    try { activeAgreement = authority.currentAgreementId ? await authority.currentAgreementId() : agreementId; } catch { return null; }
    if (!activeAgreement || binding.authorizationId !== activeAgreement) return null;
    const user = await store.userById(binding.userId);
    if (!user) return null;
    let project;
    try { project = await store.requireProject(user, binding.projectId); } catch { return null; }
    if (isInternalProject(project.id)) return null;
    const runs = await agentRuns.list(project);
    const run = runs.find(row => row.id === binding.sourceRunId);
    if (!run || run.transcript?.sha256 !== binding.sourceRevision) return null;
    try { if (!await authority.authorizeIncident({ agreementId: activeAgreement, user, project, run })) return null; } catch { return null; }
    let verified;
    try { verified = await readTranscript(project, run, binding.sourceRevision); } catch { return null; }
    // Every run of the session, so the history guard can tell when this run cannot prove its own turn: then nothing
    // is offered, never the session's earlier turns.
    let history;
    try { history = await preservedConversationHistory(project, run.sessionId, runs.filter(row => row.sessionId === run.sessionId), async () => verified, { runId: run.id }); } catch { return null; }
    const messages = history.messages.slice(-12).map(message => ({ id: `${run.id}:${message.seq}`, role: message.role, text: message.text }));
    if (!messages.length || JSON.stringify(messages).length > 32000) return null;
    // This separate privacy assertion uses the SOURCE identity even though the publisher pays.
    try { if (assertModelAccess) await assertModelAccess({ userId: user.id, projectId: project.id, runId: run.id, sessionId: run.sessionId }, { messages }); } catch { return null; }
    return { ...binding, authorized: true, valid: true, messages };
  };
}

const BUNDLE_KEY = /^rsi\/v1\/bundles\/([a-f0-9]{64})\.json$/;
const CLOSED_CODE = /^(?:campaign|rsi)_[a-z0-9_]{1,80}$/;
/** Refusals that belong to the bundle's bytes or to a decided campaign: the same object key can never import. */
const TERMINAL_BUNDLE_CODES = new Set(['campaign_bundle_identity_conflict', 'campaign_replay_or_surface_busy', 'campaign_target_changed',
  'campaign_candidate_digest_changed', 'campaign_installed_identity_conflict', 'campaign_envelope_invalid',
  'rsi_oss_object_unbounded', 'rsi_oss_object_changed', 'rsi_oss_digest_invalid']);
/** A refusal that may clear without new bytes (the deployment's trust files being replaced). */
const RETRYABLE_REJECTIONS = new Set(['campaign_trust_unavailable']);
/** @param {any} error */
const closedCode = error => [error?.code, error?.message].find(value => typeof value === 'string' && CLOSED_CODE.test(value)) ?? 'campaign_import_failed';

/** One bundle never holds the queue: each object key is decided once (imported or rejected, with a closed reason, its key
 * and digest) in a durable intake record, a key already decided is skipped without reading its bytes, an undecided failure
 * is retried a bounded number of times, and the next page is queued whatever happened to this one. The successor's key is
 * derived from the running job, so a re-run of the job names the same successor and the chain cannot fork.
 * @param {any} dependencies */
export function createRsiBundlePoller({ transport, importer, documents, owner, jobs, jobOwner, projectId, configured, report = () => {}, maxAttempts = 3, delayMs = 60000, now = () => new Date() }) {
  const intakeId = (/** @type {string} */ digest) => `rsi-bundle-intake-${digest}`;
  /** @param {string} objectKey */
  async function intake(objectKey) {
    const digest = BUNDLE_KEY.exec(objectKey)?.[1];
    if (!digest) { report('rsi_online_bundle_key_invalid'); return { objectKey, state: 'ignored', reason: 'rsi_online_bundle_key_invalid' }; }
    const previous = await documents.get(owner, 'knowledge', intakeId(digest));
    if (['imported', 'rejected'].includes(previous?.payload.state)) return { objectKey, state: previous.payload.state, seen: true };
    let outcome = null, code = null;
    try {
      const stored = await transport.readBundle(digest);
      if (!stored) return { objectKey, state: 'missing' };
      let envelope = null;
      try { envelope = JSON.parse(stored.bytes.toString('utf8')); } catch { code = 'campaign_envelope_invalid'; }
      if (!code) outcome = await importer.importBundle(envelope);
    } catch (error) { code = closedCode(error); }
    if (!code && outcome?.state === 'waiting') return { objectKey, state: 'waiting' };
    if (!code && outcome?.state === 'rejected') code = CLOSED_CODE.test(outcome.issues?.[0] ?? '') ? outcome.issues[0] : 'campaign_bundle_rejected';
    // A journal left staged resumes only through another verified import of the same bytes.
    if (!code && outcome?.state === 'staged') code = CLOSED_CODE.test(outcome.reason ?? '') ? outcome.reason : 'campaign_import_incomplete';
    const attempts = (previous?.payload.attempts ?? 0) + 1;
    const terminal = Boolean(code) && (TERMINAL_BUNDLE_CODES.has(code) || outcome?.state === 'rejected' && !RETRYABLE_REJECTIONS.has(code));
    const state = !code ? 'imported' : terminal || attempts >= maxAttempts ? 'rejected' : 'retrying';
    if (code) report(code);
    await documents.put(owner, 'knowledge', intakeId(digest), { recordType: 'rsi-bundle-intake', objectKey, digest, state, attempts,
      ...(code ? { reason: state === 'rejected' && !terminal ? 'campaign_import_retry_exhausted' : code, lastCode: code } : { journalState: outcome?.state ?? null }),
      decidedAt: now().toISOString() }, { expectedRevision: previous?.revision ?? 0 });
    return { objectKey, state, reason: code };
  }
  /** @param {{cursor?:string}} [input] @param {{id?:string}|null} [job] */
  async function poll({ cursor } = {}, job = null) {
    if (!configured()) return { state: 'waiting' };
    const page = await transport.listBundles(cursor);
    /** @type {Record<string, number>} */
    const outcomes = {};
    for (const key of page.keys) {
      let state;
      try { state = (await intake(key)).state; } catch { report('rsi_online_bundle_intake_failed'); state = 'error'; }
      outcomes[state] = (outcomes[state] ?? 0) + 1;
    }
    if (job?.id) {
      try {
        await jobs.enqueue(jobOwner, 'rsi-bundle-poll', page.cursor ? { cursor: page.cursor } : {}, { projectId, idempotencyKey: `rsi-bundle-poll:after:${job.id}`, runAfter: new Date(now().getTime() + delayMs) });
      } catch (error) { if (error?.code !== 'product_job_idempotency_conflict') throw error; }
    }
    return { processed: page.keys.length, outcomes };
  }
  return { poll, intake };
}

/** A source deletion never fails because the optional RSI layer did. What could not be marked in place is retried from a
 * deployment-owned job; when even that cannot be written it is said, and the export path still reads a deleted source as
 * unauthorized and withdraws before any upload. Never throws. jobs may be a getter, read at call time.
 * @param {{initialize:()=>Promise<any>,jobs:any,owner?:string,projectId?:string,report?:(code:string)=>void}} dependencies */
export function createRsiSourceInvalidation({ initialize, jobs, owner = PLATFORM_PUBLISHER_USER_ID, projectId = EVIDENCE_PROJECT_ID, report = () => {} }) {
  /** @param {{userId:string,projectId?:string,sourceRunId?:string}} input */
  return async input => {
    try {
      const online = await initialize();
      return (await online?.invalidateSource(input)) ?? null;
    } catch {
      report('rsi_source_invalidation_failed');
      try {
        const queue = typeof jobs === 'function' ? jobs() : jobs;
        const scope = { userId: input?.userId, ...(input?.projectId ? { projectId: input.projectId } : {}), ...(input?.sourceRunId ? { sourceRunId: input.sourceRunId } : {}) };
        if (!queue || typeof scope.userId !== 'string' || !scope.userId) throw new Error('rsi_source_invalidation_unrecordable');
        await queue.enqueue(owner, 'rsi-incident-export', { invalidateSource: scope },
          { idempotencyKey: `rsi-invalidate-source:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`, projectId, rearmFailed: true });
        return { deferred: true };
      } catch { report('rsi_source_invalidation_retry_unrecorded'); return null; }
    }
  };
}

// A read that may succeed a moment later; any other failure to read the agreement means none is in force.
const TRANSIENT_READ_ERRORS = new Set(['EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'EBUSY', 'EINTR']);

/** Offline experiment code is deliberately absent. Without the deployment file nothing is created: no publisher account
 * or project, transport, cloud SDK, importer, poll or timer. A valid transport section alone admits withdrawals; new
 * exports and imports need every binding.
 * @param {any} dependencies */
export async function createRsiOnlineRuntime({ config, store, documents, jobs, database, agentRuns, assertModelAccess, usageLedger, servingAdapters, canRun = async () => true, authority = null, trust = null, transportFactory = createRsiOssTransport, model = callModelForControlPlane, report = () => {} }) {
  // Withdrawal remains addressable without provisioning an otherwise disabled module.
  const binding = { userId: PLATFORM_PUBLISHER_USER_ID, projectId: EVIDENCE_PROJECT_ID };
  const optedIn = Boolean(config.rsiOnlineConfigFile);
  const loaded = await loadRsiOnlineConfiguration(config.rsiOnlineConfigFile);
  const online = loaded.configuration;
  let publisherReady = false, transport = null;
  if (loaded.transport) {
    try { await ensureEvidenceProject(store); publisherReady = true; } catch { report('rsi_deployment_binding_unavailable'); }
    if (publisherReady) { try { transport = await transportFactory(loaded.transport); } catch { report('rsi_online_transport_unavailable'); } }
  }
  if (!authority && loaded.agreementRef) {
    authority = await createRsiDeploymentAuthority({ agreementRef: loaded.agreementRef }, { tolerateMissing: true }).catch(() => null);
    if (!authority?.isBound?.()) report('rsi_deployment_agreement_unavailable');
  }
  if (online && servingAdapters && publisherReady && !trust) {
    try { trust = await createRsiTrustRegistry(online, servingAdapters); } catch { report('rsi_deployment_binding_unavailable'); }
  }
  const agreementId = authority?.agreementId;
  const canWithdraw = () => Boolean(publisherReady && transport?.available === true);
  const configured = () => Boolean(canWithdraw() && online && authority?.isBound?.(online) === true && trust?.isBound?.(online) === true && servingAdapters);
  const readAuthorizedTranscript = createRsiAuthorizedTranscriptReader({ store, agentRuns, agreementId, authority, assertModelAccess });
  const incidents = createRsiIncidentExports({ documents, jobs, deploymentOwnerId: binding.userId, deploymentProjectId: binding.projectId,
    configured, canWithdraw, readAuthorizedTranscript, putObject: input => transport.putObject(input), headObject: input => transport.headObject(input),
    extract: async input => {
      if (!configured()) throw new Error('rsi_online_configuration_missing');
      const response = await model({ config, usageLedger }, { ...binding, purpose: 'learning', runId: 'rsi-incident-extraction',
        limits: { daily: online.extractionDailyCny, weekly: online.extractionDailyCny * 7 }, signal: AbortSignal.timeout(60000),
        body: { model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 2200,
          messages: [{ role: 'system', content: input.instructions + ' Return no tools, executable instructions, code, commands or permissions.' }, { role: 'user', content: JSON.stringify({ fields: input.fields, messages: input.messages }) }] } });
      return JSON.parse(response.choices?.[0]?.message?.content ?? '{}');
    } });
  const publicationOwner = servingAdapters?.publicationOwnerId ?? PLATFORM_PUBLISHER_USER_ID;
  // The importer also reconciles journals left by an earlier configuration (stop, roll back), so it exists whenever the
  // deployment opted in, bound or not.
  const importer = optedIn && servingAdapters ? new RsiCampaignImporter({ database, owner: publicationOwner,
    isBound: configured, validateAdmission: row => trust?.validateAdmission(row) ?? false, currentTarget: servingAdapters.currentTarget, adapters: servingAdapters.adapters,
    verificationOptions: envelope => trust.verificationOptions(envelope, online), activationPolicy: manifest => trust.activationPolicy(manifest, online),
    verifyObservation: servingAdapters.verifyObservation }) : null;
  if (importer) {
    servingAdapters.connectImporter(importer);
    servingAdapters.setObservationReporter(async witness => {
      const rows = await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='rsi-campaign-import' AND payload->>'operationId'=$2", [publicationOwner, witness.operationId]);
      if (rows.rows.length !== 1) throw new Error('rsi_online_observation_scope_invalid');
      return importer.observe(rows.rows[0].payload.id, { id: witness.id });
    });
  }
  const poller = importer ? createRsiBundlePoller({ transport: { listBundles: cursor => transport.listBundles(cursor), readBundle: digest => transport.readBundle(digest) },
    importer, documents, owner: publicationOwner, jobs, jobOwner: binding.userId, projectId: binding.projectId, configured, report }) : null;
  /** @type {string|null|undefined} the agreement the journals were last reconciled with in this process */
  let sweptAgreement;
  async function sweepAgreement() {
    if (!canWithdraw()) return null;
    let current = null;
    if (authority?.currentAgreementId) {
      try { current = await authority.currentAgreementId(); } catch (error) { if (TRANSIENT_READ_ERRORS.has(error?.code)) return null; current = null; }
    } else current = authority?.agreementId ?? null;
    if (current === sweptAgreement) return null;
    const result = await incidents.invalidateAgreement(current);
    sweptAgreement = current;
    if (result.invalidated.length) report('rsi_incident_agreement_withdrawn');
    return result;
  }
  const worker = createRsiOnlineWorker({ jobs, owner: binding.userId, configured: canWithdraw, incidents, sweep: sweepAgreement, canRun, report,
    pollBundles: poller ? poller.poll : async () => ({ state: 'waiting' }) });
  if (configured() && poller) await jobs.enqueue(binding.userId, 'rsi-bundle-poll', {}, { projectId: binding.projectId, idempotencyKey: 'rsi-bundle-poll:bootstrap' });
  return { worker, importer, configured, canWithdraw, sweepAgreement, configurationIssues: loaded.issues,
    invalidateSource: input => incidents.invalidateSource(input),
    async offerRun(project, runId) {
      if (!configured() || isInternalProject(project.id)) return null;
      const user = await store.userById(project.userId);
      if (!user) return null;
      const authorized = await store.requireProject(user, project.id);
      const run = (await agentRuns.list(authorized)).find(row => row.id === runId);
      if (!run?.transcript?.sha256 || !rsiIncidentRunEligible(run)) return null;
      const activeAgreement = authority.currentAgreementId ? await authority.currentAgreementId() : agreementId;
      if (!await authority.authorizeIncident({ agreementId: activeAgreement, user, project: authorized, run })) return null;
      return incidents.offer({ userId: user.id, projectId: authorized.id, sourceRunId: run.id, sourceRevision: run.transcript.sha256, authorizationId: activeAgreement });
    } };
}
