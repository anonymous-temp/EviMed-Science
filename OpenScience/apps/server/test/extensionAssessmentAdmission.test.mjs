import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, extensionGenerationIdentity, extensionProofAdapterRevision } from '@evimed/domain';
import { createExtensionAssessmentAdmission, assertExtensionAssessmentAdmission } from '../src/extensionAssessmentAdmission.mjs';
import { ExtensionGenerationService, verifyExtensionGeneration } from '../src/extensionGenerationService.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => 'sha256:' + sha(canonicalJson(value));
async function fixture(t, { installerId = 'owner', installerEpoch = 'epoch', installerMembershipEpoch = null, reconcileMembershipEpoch = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-assessment-admission-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let allowed = true;
  const scope = { ownerId: 'owner', projectId: 'project', actorId: 'owner', actorAccountCreatedAt: 'epoch', actorMembershipEpoch: reconcileMembershipEpoch, ownerAccountCreatedAt: 'epoch', projectCreatedAt: 'project-epoch' };
  const input = { project: { id: 'project', userId: 'owner', projectCreatedAt: 'project-epoch' }, actor: { id: installerId, accountCreatedAt: installerEpoch, membershipEpoch: installerMembershipEpoch }, scope,
    entry: { id: 'cowork', integrity: digest('pinned package'), coordinate: {kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'a'.repeat(40)}, executionClass:'isolated-tool' },
    artifact: { artifactDigest: digest('owned exact artifact'), adapterRevision:digest('contained adapter'), suiteRevision:digest('fixture suite') },
    identity: { runtimeImageDigest: digest('actual fixture image'), permissionProfileRevision:digest('permissions'),
      adapterRevision:extensionProofAdapterRevision(digest('contained adapter'),digest('adapter'),sha), packageIntegrity:digest('pinned package'),
      sourceCommit:'a'.repeat(40),executionClass:'isolated-tool',dshVersion:'0.1.7-rc.2',suiteRevision:digest('fixture suite') } };
  const authority = createExtensionAssessmentAdmission({ dataDir: root, evaluate: async value => allowed && canonicalJson(value) === canonicalJson(input) });
  t.after(() => authority.close());
  const admission = await authority.evaluate(input);
  const plugin = { extensionId: 'cowork', coordinate: { kind: 'github', repository: 'Jesse-njx/dsh-cowork', commit: 'a'.repeat(40) },
    integrity: digest('pinned package'), artifactDigest: input.artifact.artifactDigest, configRevision: 1,
    configDigest: digest({ enabled: true, settings: {}, connectionRefs: [] }), enabled: true, settings: {}, connectionRefs: [],
    executionClass: 'isolated-tool', adapterRevision:input.identity.adapterRevision, ...admission };
  const identity = { ownerId: 'owner', projectId: 'project', baseRuntimeImageDigest: input.identity.runtimeImageDigest,
    adapterRevision: digest('adapter'), permissionProfileRevision: digest('permissions'),
    selections: [{ extensionId: plugin.extensionId, artifactDigest: plugin.artifactDigest, configRevision: 1, configDigest: plugin.configDigest, connectionRefs: [] }], skills: [] };
  const content = { schemaVersion: 1, identity, scope, assessmentAdmission: authority.marker,
    bindings: { desiredRevision: 1, legacyRevision: 0, personalRevision: 0, installations: [{extensionId:plugin.extensionId,installationId:'installation',actorId:installerId,actorMembershipEpoch:installerMembershipEpoch,installationRevision:1,prepareJobId:'prepare-job',configDigest:plugin.configDigest,assessmentAdmissionDigest:admission.assessmentAdmissionDigest,artifactDigest:plugin.artifactDigest,integrity:plugin.integrity,coordinate:canonicalExtensionCoordinate(plugin.coordinate)}] },
    projection: { plugins: [plugin], personal: { reference: null, pins: [] } }, findings: [] };
  const manifest = { ...content, reference: { ownerHash: sha('owner'), projectHash: sha('project'),
    generationHash: sha(canonicalJson({ ...content, domainIdentity: extensionGenerationIdentity(identity, { ownerId: 'owner', projectId: 'project' }, sha) })) } };
  const config = { dataDir: root, skillArtifactsRoot: path.join(root, 'skills'), maxGlobalBytes: 1024*1024, maxOwnerBytes: 1024*1024, minFreeBytes: 1 };
  const service = new ExtensionGenerationService({}, { config, extensionService: {}, pluginService: {}, admittedArtifacts: [], identities: async () => identity,
    proofAuthority: null, assessmentAdmission: authority });
  await service.publish(input.project, manifest, { query: async () => ({ rows: [] }) });
  return { authority, config, manifest, input, service, revoke: () => { allowed = false; } };
}
test('assessment admission remains source-assessed and uses a separate digest without a receipt', async t => {
  const f = await fixture(t); const output = await f.authority.evaluate(f.input);
  assert.match(output.assessmentAdmissionDigest, /^sha256:[a-f0-9]{64}$/); assert.equal(output.receiptDigest, undefined);
  assert.equal(f.authority.marker.qualified, false); assert.equal(f.authority.marker.evidenceState, 'source-assessed');
  assert.deepEqual(await verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference, f.authority), f.manifest);
});
test('default serving reader rejects byte-valid assessment manifests before loading any code', async t => {
  const f = await fixture(t); await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference));
});
test('authority cannot move across roots or be reproduced from serialized marker after restart', async t => {
  const f = await fixture(t);
  assert.throws(() => assertExtensionAssessmentAdmission({ ...f.authority }, f.config));
  assert.throws(() => assertExtensionAssessmentAdmission(f.authority, { dataDir: path.join(f.config.dataDir, 'other') }));
  const restarted = createExtensionAssessmentAdmission({ dataDir: f.config.dataDir, evaluate: async () => true });
  t.after(() => restarted.close());
  await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference, restarted));
});
test('current revocation refuses existing physical assessment bytes and no prior admission overrides it', async t => {
  const f = await fixture(t); f.revoke();
  await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference, f.authority));
  await assert.rejects(f.authority.evaluate(f.input));
});
test('identity or artifact drift cannot borrow another assessment digest', async t => {
  const f = await fixture(t);
  await assert.rejects(f.authority.evaluate({ ...f.input, identity: { runtimeImageDigest: digest('other image') } }));
  await assert.rejects(f.authority.evaluate({ ...f.input, artifact: { artifactDigest: digest('other artifact') } }));
  const altered = structuredClone(f.manifest); altered.projection.plugins[0].artifactDigest = digest('other artifact');
  await assert.rejects(f.authority.verifyManifest(f.config, altered));
});
test('closing an owned assessment revokes its in-memory authority and persisted generations', async t => {
  const f = await fixture(t); f.authority.close();
  await assert.rejects(f.authority.evaluate(f.input));
  await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference, f.authority));
});
test('assessment mode cannot hydrate ordinary qualification or mix receipt evidence into its projection', async t => {
  const f = await fixture(t); const mixed = structuredClone(f.manifest); mixed.projection.plugins[0].receiptDigest = digest('fake receipt');
  await assert.rejects(f.authority.verifyManifest(f.config, mixed));
  const normal = structuredClone(f.manifest); delete normal.assessmentAdmission;
  await assert.rejects(f.authority.verifyManifest(f.config, normal));
});

test('a rehashed byte-valid manifest cannot move assessment authority to another image, adapter, permission or installation',async t=>{
  const f=await fixture(t);
  const changes=[
    value=>{value.identity.baseRuntimeImageDigest=digest('other image');},
    value=>{value.identity.permissionProfileRevision=digest('other permission');},
    value=>{value.identity.adapterRevision=digest('other base adapter');},
    value=>{value.projection.plugins[0].integrity=digest('other integrity');},
    value=>{value.projection.plugins[0].coordinate.commit='b'.repeat(40);},
    value=>{value.projection.plugins[0].executionClass='local-only';},
    value=>{value.bindings.installations[0].assessmentAdmissionDigest=digest('different binding');},
  ];
  for(const change of changes){
    const altered=structuredClone(f.manifest);change(altered);const {reference:_reference,...content}=altered;
    altered.reference.generationHash=sha(canonicalJson({...content,domainIdentity:extensionGenerationIdentity(altered.identity,{ownerId:'owner',projectId:'project'},sha)}));
    await assert.rejects(f.service.publish(f.input.project,altered,{query:async()=>({rows:[]})}));
    await assert.rejects(verifyExtensionGeneration(f.config,f.input.project,altered.reference,f.authority));
  }
});

test('actual apply-worker verification forwards only the service constructor assessment authority',async t=>{
  const {ExtensionGenerationWorker}=await import('../src/extensionGenerationWorker.mjs');
  const f=await fixture(t);let prepared=0;
  // Ledger/runtime doubles isolate the worker forwarding contract; immutable files/authority checks are real.
  const client={query:async()=>({rows:[{acquired:true}]})};
  const database={transaction:work=>work(client),withTransactionClient:(_client,work)=>work()};
  const state={revision:1,payload:{desired:f.manifest,effective:null}};
  const jobs={renew:async()=>true,fail:async(_owner,_id,_lease,error)=>({error})};
  const service={config:f.config,assessmentAdmission:f.authority,database,jobs,current:async()=>state,
    assertCurrent:async()=>f.input.project,plugins:{hasPendingPrompts:async()=>false}};
  const runtime={pluginRuntimeBusy:async()=>false,currentGeneration:()=>null,prepareGeneration:async()=>{prepared++;throw Object.assign(new Error('test stops before fake execution'),{joined:false});}};
  const worker=new ExtensionGenerationWorker({service,runtime,resolveProject:async()=>f.input.project,ledgerBusy:async()=>false});
  const job={kind:'plugin-apply',userId:'owner',projectId:'project',id:'owned-test-job',leaseToken:'test',payload:{variant:'extension-generation-v1',reference:f.manifest.reference,stateRevision:1}};
  assert.equal(await worker.runClaimed(job),null);assert.equal(prepared,1);
  service.assessmentAdmission=null;const refused=await worker.runClaimed(job);
  assert.equal(refused.error.code,'extension_contract_invalid');assert.equal(prepared,1);
});

function rehash(manifest) {
  const { reference: _reference, ...content } = manifest;
  manifest.reference.generationHash = sha(canonicalJson({ ...content,
    domainIdentity: extensionGenerationIdentity(manifest.identity,
      { ownerId: manifest.scope.ownerId, projectId: manifest.scope.projectId }, sha) }));
  return manifest;
}

test('real immutable files reject rehashed duplicate, dangling and ambiguous admission bonds', async t => {
  const f = await fixture(t);
  const changes = [
    value => value.bindings.installations.push(structuredClone(value.bindings.installations[0])),
    value => value.bindings.installations.push({ ...value.bindings.installations[0], extensionId: 'not-selected' }),
    value => value.projection.plugins.push(structuredClone(value.projection.plugins[0])),
    value => { value.bindings.installations[0].receiptDigest = digest('unrelated receipt'); },
    value => { value.projection.plugins[0].receiptDigest = digest('unrelated receipt'); },
    value => { delete value.bindings.installations[0].assessmentAdmissionDigest; },
    value => { value.bindings.installations[0].configDigest = digest('unrelated settings'); },
    value => { value.bindings.installations[0].authority = true; },
    value => { value.bindings.authority = true; },
    value => { value.scope.authority = true; },
  ];
  for (const change of changes) {
    const altered = structuredClone(f.manifest); change(altered); rehash(altered);
    await assert.rejects(f.service.publish(f.input.project, altered, { query: async () => ({ rows: [] }) }));
    await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, altered.reference, f.authority));
  }
});

test('frozen reconcile scope and separately bound installer survive while scope or installer drift refuses', async t => {
  const f = await fixture(t, { installerId: 'installer', installerEpoch: 'installer-epoch', installerMembershipEpoch: 'installer-membership', reconcileMembershipEpoch: 'reconciler-membership' });
  assert.notEqual(f.manifest.scope.actorId, f.manifest.bindings.installations[0].actorId);
  assert.deepEqual(await verifyExtensionGeneration(f.config, f.input.project, f.manifest.reference, f.authority), f.manifest);
  const changes = [
    value => { value.scope.actorId = 'unrelated-reconciler'; },
    value => { value.scope.actorAccountCreatedAt = 'other-reconciler-epoch'; },
    value => { value.scope.ownerAccountCreatedAt = 'other-owner-epoch'; },
    value => { value.scope.projectCreatedAt = 'other-project-epoch'; },
    value => { value.bindings.installations[0].actorId = 'unrelated-installer'; },
    value => { value.bindings.installations[0].actorMembershipEpoch = 'reconciler-membership'; },
    value => { value.scope.actorMembershipEpoch = 'installer-membership'; },
  ];
  for (const change of changes) {
    const altered = structuredClone(f.manifest); change(altered); rehash(altered);
    await assert.rejects(f.service.publish(f.input.project, altered, { query: async () => ({ rows: [] }) }));
    await assert.rejects(verifyExtensionGeneration(f.config, f.input.project, altered.reference, f.authority));
  }
});

test('current operation retains frozen reconcile scope when the caller and installer differ', async t => {
  const f = await fixture(t, { installerId: 'installer', installerEpoch: 'installer-epoch' });
  const calls = [], client = {};
  f.service.database = { transaction: work => work(client), withTransactionClient: (_client, work) => work() };
  f.service.extensions = { entries: new Map([[f.input.entry.id, f.input.entry]]), access: {
    account: async user => { calls.push(user.id); return user.accountCreatedAt ?? 'caller-epoch'; },
    project: async () => f.input.project, connections: async () => [] } };
  f.service.plugins = { scope: async () => ({ accountCreatedAt: 'epoch', projectCreatedAt: 'project-epoch' }) };
  f.service.artifacts = new Map([[f.input.entry.id, f.input.artifact]]);
  f.service.current = async () => ({ payload: { phase: 'effective', runtimeGeneration: 'runtime', effective: f.manifest } });
  f.service.jobs = { get: async () => ({ kind: 'extension-prepare', status: 'succeeded',
    payload: { installationId: 'installation', installationRevision: 1, accountCreatedAt: 'installer-epoch' },
    result: { artifactDigest: f.input.artifact.artifactDigest, integrity: f.input.entry.integrity,
      installationId: 'installation', installationRevision: 1 } }) };
  const identity = await f.service.operationIdentity({ id: 'authorized-current-caller' }, 'project', 'cowork', 'runtime');
  assert.equal(identity.userId, 'authorized-current-caller');
  assert.equal(identity.accountCreatedAt, 'caller-epoch');
  assert.ok(calls.includes('installer'));
  assert.equal((await f.authority.evaluate(f.input)).assessmentAdmissionDigest,
    f.manifest.projection.plugins[0].assessmentAdmissionDigest);
});

test('ordinary receipt manifests and the legacy citation projection retain their existing readable format', async t => {
  const f = await fixture(t);
  const ordinary = structuredClone(f.manifest); delete ordinary.assessmentAdmission;
  const pin = ordinary.projection.plugins[0], binding = ordinary.bindings.installations[0];
  delete pin.assessmentAdmissionDigest; delete binding.assessmentAdmissionDigest;
  pin.receiptDigest = binding.receiptDigest = digest('synthetic receipt format control');
  const legacy = { extensionId: 'dsh-cite', coordinate: { kind: 'npm', name: 'dsh-cite', version: '0.1.0' },
    integrity: digest('legacy'), artifactDigest: digest('legacy'), configRevision: 0,
    configDigest: digest({ enabled: true, settings: { timeoutMs: 9000 } }), enabled: true,
    settings: { timeoutMs: 9000 }, connectionRefs: [], compatibility: 'legacy-citation-v1', sourceDocumentId: 'legacy-row' };
  ordinary.projection.plugins.push(legacy);
  ordinary.identity.selections.push({ extensionId: legacy.extensionId, artifactDigest: legacy.artifactDigest,
    configRevision: legacy.configRevision, configDigest: legacy.configDigest, connectionRefs: [] });
  rehash(ordinary);
  const service = new ExtensionGenerationService({}, { config: f.config, extensionService: {}, pluginService: {},
    admittedArtifacts: [], identities: async () => ordinary.identity, proofAuthority: null });
  await service.publish(f.input.project, ordinary, { query: async () => ({ rows: [] }) });
  assert.deepEqual(await verifyExtensionGeneration(f.config, f.input.project, ordinary.reference), ordinary);
  // This asserts immutable format compatibility, not that a synthetic receipt qualifies an extension.
  const mismatched = structuredClone(ordinary); mismatched.bindings.installations[0].receiptDigest = digest('different receipt');
  rehash(mismatched);
  await assert.rejects(service.publish(f.input.project, mismatched, { query: async () => ({ rows: [] }) }));
});
