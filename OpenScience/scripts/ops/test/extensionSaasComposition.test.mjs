import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAssessmentCurrentFacts, createPrivateAssessmentFactories, openPrivateAssessmentFixture, assertOwnedRelayIdentity,assertRelayPhysicalAdmission } from '../extension-saas-acceptance-composition.mjs';
test('private composition requires real kernel and lexical sources rather than serialized flags or arbitrary factories', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const factories = createPrivateAssessmentFactories({ admission: { root: '/tmp/fixture', recordPath: '/tmp/fixture/admission.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } });
  assert.equal(Object.isFrozen(factories), true);
  assert.throws(() => factories.runtimeManagerFactory({ runtimeMode: 'mock' }, {}), /real_kernel/);
  assert.throws(() => factories.extensionIntegrationFactory({ config: {}, database: {} }), /sources_changed/);
  assert.throws(() => createPrivateAssessmentFactories({ admission: { root: '/tmp/fixture', recordPath: '/tmp/fixture/admission.json', publicKey: 'invalid' } }));
});
test('current fact sources fail before deployment/image/DB work when trusted local composition is unavailable', async () => {
  assert.throws(() => createAssessmentCurrentFacts({ getConfig: true, getDatabase: () => null }));
  const facts = createAssessmentCurrentFacts({ getConfig: () => null, getDatabase: () => null });
  await assert.rejects(facts({}), /fact_sources_unavailable/);
});
test('private fixture startup requires an explicit ephemeral signer before loading ambient configuration', async () => {
  await assert.rejects(openPrivateAssessmentFixture({ overrides: {}, admission: {} }), /explicit_fixture_signing_secret_required/);
});
test('relay rejects inheritedimage volume mounts but exactowned cleanup identity remains valid; approvedreadonly tmpfs masks them',()=>{
 const expected={id:'a'.repeat(64),name:'owned-relay',imageId:'sha256:'+'a'.repeat(64),rootDigest:'sha256:'+'b'.repeat(64),networkName:'owned-internal',networkId:'c'.repeat(64)};
 const actual={Id:expected.id,Name:'/owned-relay',Image:expected.imageId,Config:{User:'10001:10001',Labels:{'io.evimed.campaign-root':expected.rootDigest,'io.evimed.campaign-component':'relay'}},HostConfig:{ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Tmpfs:{'/runtime':'ro,noexec,nosuid,nodev,size=1m,mode=0555','/workspace':'ro,noexec,nosuid,nodev,size=1m,mode=0555'}},Mounts:[],NetworkSettings:{Networks:{'owned-internal':{NetworkID:expected.networkId},bridge:{NetworkID:'external'}}}};
 assert.doesNotThrow(()=>assertRelayPhysicalAdmission(actual,expected));
 const inherited={...actual,Mounts:[{Type:'volume',Destination:'/runtime',RW:true,Source:'/anonymous-volume'}]};
 assert.throws(()=>assertRelayPhysicalAdmission(inherited,expected),/physical_boundary/);assert.doesNotThrow(()=>assertOwnedRelayIdentity(inherited,expected));
 assert.throws(()=>assertOwnedRelayIdentity({...inherited,Id:'foreign'},expected),/identity_unconfirmed/);
 const writable={...actual,HostConfig:{...actual.HostConfig,Tmpfs:{...actual.HostConfig.Tmpfs,'/runtime':'rw,noexec,nosuid,nodev,size=1m,mode=0555'}}};assert.throws(()=>assertRelayPhysicalAdmission(writable,expected),/physical_boundary/);
});
