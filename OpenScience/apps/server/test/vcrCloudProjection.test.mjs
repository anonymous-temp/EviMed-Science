import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudProjection, cloudPermission, originalProjectionSpan, requireCloudPermission, vcrCloudDestinations } from '../src/vcrCloudProjection.mjs';

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
