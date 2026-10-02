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
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evimed-assessment-admission-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let allowed = true;
  const input = { project: { id: 'project', userId: 'owner' }, actor: { id: 'owner', accountCreatedAt: 'epoch' },
    entry: { id: 'cowork', integrity: digest('pinned package'), coordinate: {kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'a'.repeat(40)}, executionClass:'isolated-tool' },
    artifact: { artifactDigest: digest('owned exact artifact'), adapterRevision:digest('contained adapter') },
    identity: { runtimeImageDigest: digest('actual fixture image'), permissionProfileRevision:digest('permissions'),
      adapterRevision:extensionProofAdapterRevision(digest('contained adapter'),digest('adapter'),sha), packageIntegrity:digest('pinned package'),
      sourceCommit:'a'.repeat(40),executionClass:'isolated-tool' } };
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
  const scope = { ownerId: 'owner', projectId: 'project', actorId: 'owner', actorAccountCreatedAt: 'epoch', ownerAccountCreatedAt: 'epoch', projectCreatedAt: 'project-epoch' };
  const content = { schemaVersion: 1, identity, scope, assessmentAdmission: authority.marker,
    bindings: { desiredRevision: 1, legacyRevision: 0, personalRevision: 0, installations: [{extensionId:plugin.extensionId,assessmentAdmissionDigest:admission.assessmentAdmissionDigest,artifactDigest:plugin.artifactDigest,integrity:plugin.integrity,coordinate:canonicalExtensionCoordinate(plugin.coordinate)}] },
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
