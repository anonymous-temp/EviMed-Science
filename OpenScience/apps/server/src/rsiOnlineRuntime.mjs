import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { ensureEvidenceProject, isInternalProject } from './internalProjects.mjs';
import { readVerifiedRunTranscript } from './runTranscripts.mjs';
import { preservedConversationHistory } from './conversationHistory.mjs';
import { createRsiIncidentExports } from './rsiIncidentExports.mjs';
import { loadRsiOnlineConfiguration } from './rsiOnlineConfiguration.mjs';
import { createRsiOssTransport } from './rsiOssTransport.mjs';
import { createRsiOnlineWorker } from './rsiOnlineWorker.mjs';
import { callModelForControlPlane } from './modelGateway.mjs';
import { createRsiDeploymentAuthority, createRsiTrustRegistry } from './rsiDeploymentAuthority.mjs';
import { RsiCampaignImporter } from './rsiCampaignImporter.mjs';

/** Canonical source reader: project authorization, exact retained bytes, root prose, one run.
 * The authority port resolves a deployment-owned agreement; it never accepts a request's boolean.
 * @param {any} dependencies */
export function createRsiAuthorizedTranscriptReader({ store, agentRuns, agreementId, authority, assertModelAccess, readTranscript = readVerifiedRunTranscript }) {
  return async binding => {
    if (!agreementId || binding.authorizationId !== agreementId || !authority) return null;
    const user = await store.userById(binding.userId);
    if (!user) return null;
    let project;
    try { project = await store.requireProject(user, binding.projectId); } catch { return null; }
    if (isInternalProject(project.id)) return null;
    const run = (await agentRuns.list(project)).find(row => row.id === binding.sourceRunId);
    if (!run || run.transcript?.sha256 !== binding.sourceRevision) return null;
    if (!await authority.authorizeIncident({ agreementId, user, project, run })) return null;
    let verified;
    try { verified = await readTranscript(project, run, binding.sourceRevision); } catch { return null; }
    const history = await preservedConversationHistory(project, run.sessionId, [run], async () => verified, { runId: run.id });
    const messages = history.messages.slice(-12).map(message => ({ id: `${run.id}:${message.seq}`, role: message.role, text: message.text }));
    if (!messages.length || JSON.stringify(messages).length > 32000) return null;
    // This separate privacy assertion uses the SOURCE identity even though the publisher pays.
    if (assertModelAccess) await assertModelAccess({ userId: user.id, projectId: project.id, runId: run.id, sessionId: run.sessionId }, { messages });
    return { ...binding, authorized: true, valid: true, messages };
  };
}

/** Offline experiment code is deliberately absent. No cloud client/model/import is initialized
 * without complete bindings and an independently configured authority/trust adapter.
 * @param {any} dependencies */
export async function createRsiOnlineRuntime({ config, store, documents, jobs, database, agentRuns, assertModelAccess, usageLedger, servingAdapters, authority = null, trust = null, transportFactory = createRsiOssTransport, model = callModelForControlPlane, report = () => {} }) {
  const binding = await ensureEvidenceProject(store);
  const loaded = await loadRsiOnlineConfiguration(config.rsiOnlineConfigFile);
  const online = loaded.configuration;
  if (online && servingAdapters) {
    try {
      authority ??= await createRsiDeploymentAuthority(online);
      trust ??= await createRsiTrustRegistry(online, servingAdapters);
    } catch { report('rsi_deployment_binding_unavailable'); }
  }
  const agreementId = authority?.agreementId;
  let transport = null;
  const configured = () => Boolean(online && authority?.isBound?.(online) === true && trust?.isBound?.(online) === true && transport?.available === true && servingAdapters);
  if (online && authority?.isBound?.(online) === true && trust?.isBound?.(online) === true && servingAdapters) {
    try { transport = await transportFactory(online.transport); } catch { report('rsi_online_transport_unavailable'); }
  }
  const readAuthorizedTranscript = createRsiAuthorizedTranscriptReader({ store, agentRuns, agreementId, authority, assertModelAccess });
  const incidents = createRsiIncidentExports({ documents, jobs, deploymentOwnerId: binding.userId, deploymentProjectId: binding.projectId,
    configured, readAuthorizedTranscript, putObject: input => transport.putObject(input), headObject: input => transport.headObject(input),
    extract: async input => {
      if (!configured()) throw new Error('rsi_online_configuration_missing');
      const response = await model({ config, usageLedger }, { ...binding, purpose: 'learning', runId: 'rsi-incident-extraction',
        limits: { daily: online.extractionDailyCny, weekly: online.extractionDailyCny * 7 }, signal: AbortSignal.timeout(60000),
        body: { model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 2200,
          messages: [{ role: 'system', content: input.instructions + ' Return no tools, executable instructions, code, commands or permissions.' }, { role: 'user', content: JSON.stringify({ fields: input.fields, messages: input.messages }) }] } });
      return JSON.parse(response.choices?.[0]?.message?.content ?? '{}');
    } });
  const importer = servingAdapters && new RsiCampaignImporter({ database, owner: PLATFORM_PUBLISHER_USER_ID,
    isBound: configured, currentTarget: servingAdapters.currentTarget, adapters: servingAdapters.adapters,
    verificationOptions: envelope => trust.verificationOptions(envelope, online), activationPolicy: manifest => trust.activationPolicy(manifest, online),
    verifyObservation: servingAdapters.verifyObservation });
  if (importer) {
    servingAdapters.connectImporter(importer);
    servingAdapters.setObservationReporter(async witness => {
      const rows = await database.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='rsi-campaign-import' AND payload->>'operationId'=$2", [binding.userId, witness.operationId]);
      if (rows.rows.length !== 1) throw new Error('rsi_online_observation_scope_invalid');
      return importer.observe(rows.rows[0].payload.id, { id: witness.id });
    });
  }
  /** @param {{cursor?:string}} input */
  async function pollBundles({ cursor } = {}) {
    if (!configured()) return { state: 'waiting' };
    const page = await transport.listBundles(cursor);
    const results = [];
    for (const key of page.keys) {
      const digest = /^rsi\/v1\/bundles\/([a-f0-9]{64})\.json$/.exec(key)?.[1];
      if (!digest) throw new Error('rsi_online_bundle_key_invalid');
      const stored = await transport.readBundle(digest);
      if (stored) results.push(await importer.importBundle(JSON.parse(stored.bytes.toString('utf8'))));
    }
    await jobs.enqueue(binding.userId, 'rsi-bundle-poll', { cursor: page.cursor ?? undefined }, { projectId: binding.projectId, idempotencyKey: `rsi-poll:${Date.now()}`, runAfter: new Date(Date.now() + 60000) });
    return { results };
  }
  const worker = createRsiOnlineWorker({ jobs, owner: binding.userId, configured, incidents, pollBundles, report });
  if (configured()) await jobs.enqueue(binding.userId, 'rsi-bundle-poll', {}, { projectId: binding.projectId, idempotencyKey: 'rsi-bundle-poll:bootstrap' });
  return { worker, importer, configured, configurationIssues: loaded.issues,
    invalidateSource: input => incidents.invalidateSource(input),
    async offerRun(project, runId) {
      if (!configured() || isInternalProject(project.id)) return null;
      const user = await store.userById(project.userId);
      if (!user) return null;
      const authorized = await store.requireProject(user, project.id);
      const run = (await agentRuns.list(authorized)).find(row => row.id === runId);
      if (!run?.transcript?.sha256) return null;
      if (!await authority.authorizeIncident({ agreementId: agreementId, user, project: authorized, run })) return null;
      return incidents.offer({ userId: user.id, projectId: authorized.id, sourceRunId: run.id, sourceRevision: run.transcript.sha256, authorizationId: agreementId });
    } };
}
