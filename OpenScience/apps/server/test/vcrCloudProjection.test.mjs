import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudProjection, cloudAuthorization, cloudPermission, cloudState, deploymentCloudPermission, originalProjectionSpan, requireCloudPermission, vcrCloudDestinations } from '../src/vcrCloudProjection.mjs';

const at = '2026-10-09T00:00:00.000Z';
const origin = 'https://api.example.org';
const permission = { status: 'approved', dataClass: 'deidentified', destinations: [origin], purpose: 'vcr',
  reference: 'Synthetic authorization fixture', retention: 'none', training: 'disabled', humanReview: 'disabled' };

test('view permission never implies cloud permission; destination, expiry, revocation and unknown terms are enforced', () => {
  const value = cloudPermission(permission, 'owner', at);
  requireCloudPermission(value, [origin], at);
  for (const [p, origins] of [[null, [origin]], [{ ...value, status: 'revoked' }, [origin]], [value, ['https://other.example']],
    [value, []], [{ ...value, expiresAt: at }, [origin]], [{ ...value, training: 'unknown' }, [origin]],
    [{ ...value, retention: 'unknown' }, [origin]], [{ ...value, humanReview: 'unknown' }, [origin]]]) {
    assert.throws(() => requireCloudPermission(p, origins, at), { code: 'vcr_cloud_processing_not_authorized' });
  }
  const credentialUrl = new URL(origin); credentialUrl.username = 'synthetic'; credentialUrl.password = 'fixture';
  assert.throws(() => cloudPermission({ ...permission, destinations: [credentialUrl.href] }, 'owner', at));
  assert.deepEqual(vcrCloudDestinations({ deepseekBaseUrl: origin, reviewApiBase: origin + '/v1', reviewJevApiBase: 'https://review.example/v1' }), [origin, 'https://review.example']);
});

test('Chinese and mixed-language repeated identifiers use scoped surrogates and exact UTF-16 quote restoration', () => {
  const text = '😀姓名王小明；Name Alice；王小明否认胸痛。肌酐 1.2 mg/dL。用药 5 mg，2026-10-01停药。';
  const spans = ['王小明', 'Alice'].flatMap(name => [...text.matchAll(new RegExp(name, 'g'))].map(m => ({ start: m.index, end: m.index + name.length, kind: 'person' })));
  const build = key => buildCloudProjection({ text, spans, key: Buffer.alloc(32, key), attestation: 'Synthetic spans independently specified for this fixture' });
  const projection = build(1);
  for (const canary of ['王小明', 'Alice']) assert.ok(!projection.text.includes(canary));
  for (const clinical of ['否认胸痛', '1.2 mg/dL', '5 mg', '2026-10-01']) assert.ok(projection.text.includes(clinical));
  const surrogates = [...projection.text.matchAll(/\[person:[a-f0-9]+\]/g)].map(m => m[0]);
  assert.equal(surrogates[0], surrogates[2]);
  assert.notEqual(build(2).text, projection.text, 'no stable identifier across studies');
  const restored = originalProjectionSpan(projection, text, { start: 0, end: projection.text.length, quote: projection.text });
  assert.equal(restored.quote, text);
  const start = projection.text.indexOf('1.2'); const quote = '1.2 mg/dL';
  assert.equal(originalProjectionSpan(projection, text, { start, end: start + quote.length, quote }).start, text.indexOf('1.2'));
  assert.throws(() => originalProjectionSpan(projection, text + 'changed', { start, end: start + quote.length, quote }));
  assert.throws(() => buildCloudProjection({ text, spans: [{ start: 1, end: 2, kind: 'person' }], key: Buffer.alloc(32), attestation: 'fixture' }), { code: 'vcr_projection_span_invalid' });
});

const providers = { deepseekBaseUrl: origin, reviewApiBase: origin + '/v1', reviewJevApiBase: 'https://review.example/v1' };
const agreements = deploymentCloudPermission({ ...providers, vcrProviderAgreements: true, vcrProviderAgreementReference: 'Agreement 2026-017' });
const allDestinations = [origin, 'https://review.example'];

test('the deployment records its provider agreements only when it claims them, for exactly the destinations it calls', () => {
  assert.equal(deploymentCloudPermission({ ...providers }), null, 'a config that does not say so claims nothing');
  assert.equal(deploymentCloudPermission({ ...providers, vcrProviderAgreements: false }), null);
  assert.equal(deploymentCloudPermission({ vcrProviderAgreements: true, deepseekBaseUrl: 'http://plain.example' }), null, 'no https destination, nothing to claim it for');
  assert.deepEqual(agreements.destinations, [...allDestinations].sort());
  assert.deepEqual([agreements.retention, agreements.training, agreements.humanReview, agreements.dataClass], ['none', 'disabled', 'disabled', 'clinical']);
  assert.equal(agreements.reference, 'Agreement 2026-017');
  assert.match(deploymentCloudPermission({ ...providers, vcrProviderAgreements: true }).reference, /agreements/i, 'a reference is always named');
});

test('under the agreements a document needs no attestation; a revoked source is the one thing nothing overrides', () => {
  assert.deepEqual(cloudAuthorization(null, allDestinations, at, agreements).basis, 'deployment_agreements');
  assert.throws(() => cloudAuthorization(null, allDestinations, at, null), { code: 'vcr_cloud_processing_not_authorized' }, 'without them the old rule stands');
  const revoked = cloudPermission({ status: 'revoked' }, 'operator', at);
  assert.throws(() => cloudAuthorization(revoked, allDestinations, at, agreements), { code: 'vcr_cloud_processing_not_authorized' });
  assert.throws(() => requireCloudPermission(revoked, allDestinations, at, agreements), { code: 'vcr_cloud_processing_not_authorized' });
  // The agreements cover the destinations the deployment calls, not a third party's.
  assert.throws(() => cloudAuthorization(null, ['https://forecast.example'], at, agreements), { code: 'vcr_cloud_processing_not_authorized' });
  assert.throws(() => cloudAuthorization(null, [], at, agreements), { code: 'vcr_cloud_processing_not_authorized' });
  // A source's own approved record stands as it always has, and an expired or unfinished one does not shut the source.
  const own = cloudPermission({ ...permission, destinations: allDestinations }, 'operator', at);
  assert.equal(cloudAuthorization(own, allDestinations, at, agreements).basis, 'source_permission');
  assert.equal(cloudAuthorization({ ...own, expiresAt: at }, allDestinations, at, agreements).basis, 'deployment_agreements');
  assert.equal(cloudAuthorization({ ...own, training: 'unknown' }, allDestinations, at, agreements).basis, 'deployment_agreements');
  assert.throws(() => cloudAuthorization({ ...own, training: 'unknown' }, allDestinations, at, null), { code: 'vcr_cloud_processing_not_authorized' });
});

test('identifiable records are a data class of their own, held to the private terms, and a source can go back to following the deployment', () => {
  const clinical = { ...permission, dataClass: 'clinical', destinations: allDestinations };
  const record = cloudPermission(clinical, 'operator', at);
  assert.equal(record.dataClass, 'clinical');
  requireCloudPermission(record, allDestinations, at);
  assert.throws(() => requireCloudPermission({ ...record, retention: 'limited' }, allDestinations, at), { code: 'vcr_cloud_processing_not_authorized' }, 'identifiable text needs the private terms like de-identified text');
  assert.throws(() => cloudPermission({ ...clinical, dataClass: 'raw' }, 'operator', at), { code: 'vcr_cloud_permission_invalid' });
  assert.equal(cloudPermission({ status: 'default' }, 'operator', at), null, 'clearing the record is its own status');
  assert.throws(() => cloudPermission({ status: 'default', dataClass: 'clinical' }, 'operator', at), { code: 'vcr_cloud_permission_invalid' });
  assert.deepEqual(cloudState(null, allDestinations, at, agreements), { state: 'allowed', basis: 'deployment_agreements' });
  assert.deepEqual(cloudState(null, allDestinations, at, null), { state: 'closed', basis: null });
  assert.deepEqual(cloudState({ schema: 1, status: 'revoked' }, allDestinations, at, agreements), { state: 'restricted', basis: null });
  assert.deepEqual(cloudState(record, allDestinations, at, agreements), { state: 'allowed', basis: 'source_permission' });
});
