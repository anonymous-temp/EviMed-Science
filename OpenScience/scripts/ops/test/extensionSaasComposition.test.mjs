import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAssessmentCurrentFacts, createPrivateAssessmentFactories, openPrivateAssessmentFixture } from '../extension-saas-acceptance-composition.mjs';
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
