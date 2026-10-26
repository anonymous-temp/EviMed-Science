import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRsiOssTransport } from '../src/rsiOssTransport.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-oss-')); const objects = new Map(); const calls = []; const faults = {};
  const config = { region: 'cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', incidentBucket: 'fixture-incidents', bundleBucket: 'fixture-bundles', identityRefs: { production: join(dir, 'prod'), lab: join(dir, 'lab') } };
  for (const path of Object.values(config.identityRefs)) await writeFile(path, JSON.stringify({ accessKeyId: 'fixture', accessKeySecret: 'fixture' }), { mode: 0o600 });
  class SDK {
    constructor(options) { this.bucket = options.bucket; }
    async head(key) { calls.push(['head', key]); if (faults.head) throw faults.head; const row = objects.get(`${this.bucket}/${key}`); if (!row) throw Object.assign(new Error('missing'), { status: 404, code: 'NoSuchKey' }); return { res: { headers: { 'x-oss-meta-sha256': row.digest, 'content-length': String(row.bytes.length) } } }; }
    async put(key, bytes, options) { calls.push(['put', key]); assert.equal(options.headers['x-oss-forbid-overwrite'], 'true'); if (objects.has(`${this.bucket}/${key}`)) throw new Error('exists'); objects.set(`${this.bucket}/${key}`, { bytes, digest: options.headers['x-oss-meta-sha256'] }); if (faults.putAfterStore) throw new Error('network outcome unknown'); }
    async get(key) { calls.push(['get', key]); return { content: objects.get(`${this.bucket}/${key}`).bytes }; }
    async listV2(options) { calls.push(['list', options]); return { objects: [], isTruncated: false }; }
  }
  try { await run({ prod: await createRsiOssTransport({ ...config, role: 'production' }, { sdkFactory: SDK }), lab: await createRsiOssTransport({ ...config, role: 'lab' }, { sdkFactory: SDK }), objects, calls, faults }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function pending(kind = 'incident') { const generation = kind === 'incident' ? 1 : 2; const body = { incidentId: 'incident-123', generation }; const serializedBody = JSON.stringify(body); return { kind, generation, body, serializedBody, digest: sha(serializedBody), streamId: body.incidentId, idempotencyKey: `${body.incidentId}:${kind}` }; }
test('directional roles reject before SDK invocation', () => fixture(async ({ prod, lab, calls }) => {
  await assert.rejects(lab.putObject(pending()), /role_forbidden/); await assert.rejects(prod.readIncident('incident-123'), /role_forbidden/); await assert.rejects(prod.exportBundle({}), /role_forbidden/); await assert.rejects(lab.readBundle('0'.repeat(64)), /role_forbidden/); assert.equal(calls.length, 0);
}));
test('immutable retry, tombstone precedence and pre-consumption fence', () => fixture(async ({ prod, lab, calls }) => {
  const row = pending(); await prod.putObject(row); await prod.putObject(row); assert.equal(calls.filter(call => call[0] === 'put').length, 1); assert.equal((await lab.readIncident(row.streamId)).digest, row.digest);
  await prod.putObject(pending('withdrawal')); await assert.rejects(lab.readIncident(row.streamId), /withdrawn/); await assert.rejects(lab.assertIncidentCurrent(row.streamId), /withdrawn/); await assert.rejects(prod.putObject(row), /withdrawn/);
}));
test('object identity conflicts and byte tampering fail closed', () => fixture(async ({ prod, lab, objects }) => {
  const row = pending(); await assert.rejects(prod.putObject({ ...row, digest: '0'.repeat(64) }), /invalid/); await prod.putObject(row);
  objects.get('fixture-incidents/rsi/v1/incidents/incident-123/1.json').bytes = Buffer.from('tampered'); await assert.rejects(lab.readIncident(row.streamId), /changed/);
}));
test('bundles are content addressed and listing is bounded to named prefixes', () => fixture(async ({ prod, lab, calls }) => {
  const result = await lab.exportBundle({ payload: 'fixture', signature: 'unverified-by-transport' }); assert.equal((await prod.readBundle(result.digest)).digest, result.digest); await prod.listBundles(); assert.equal(calls.at(-1)[1].prefix, 'rsi/v1/bundles/'); await assert.rejects(prod.readBundle('../escape'), /digest_invalid/);
}));

test('unknown PUT outcome reconciles exact stored identity without overwriting', () => fixture(async ({ prod, faults, calls }) => {
  faults.putAfterStore = true; const row = pending(); assert.equal((await prod.putObject(row)).digest, row.digest); assert.equal(calls.filter(call => call[0] === 'put').length, 1);
}));
test('authorization and network HEAD errors are never treated as absence', () => fixture(async ({ prod, faults, calls }) => {
  for (const error of [Object.assign(new Error('denied'), { status: 403, code: 'AccessDenied' }), new Error('timeout'), Object.assign(new Error('unknown404'), { status: 404, code: 'Other' })]) {
    faults.head = error; await assert.rejects(prod.putObject(pending()));
  }
  assert.equal(calls.filter(call => call[0] === 'put').length, 0);
}));
