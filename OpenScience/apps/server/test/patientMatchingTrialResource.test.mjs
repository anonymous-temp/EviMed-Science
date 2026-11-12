import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createPatientMatchingTrialResource } from '../src/patientMatchingTrialResource.mjs';

async function fixture(t, { records = 2005, expectedRecords = records, body = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-public-resource-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'records.ndjson'), manifestPath = path.join(directory, 'manifest.json');
  const values = Array.from({ length: records }, (_, index) => ({ registryId: `NCT${String(index).padStart(8, '0')}`, text: `Public trial ${index} with UTF-8 中医 🧬\nCRLF boundary` }));
  const bytes = body ?? `\r\n${values.map((value, index) => `${JSON.stringify(value)}${index % 17 === 0 ? '\r\n \t' : ''}`).join('\r\n')}`;
  await fs.writeFile(recordsPath, bytes, { mode: 0o600 });
  const manifest = { collectionId: 'public-test', recordsPath, recordsSha256: createHash('sha256').update(bytes).digest('hex'), expectedRecords };
  await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const dependencies = { manifestPath, database: null, models: null, authorize: async () => true, createIndex: adapters => adapters };
  return { dependencies, values, recordsPath, manifestPath };
}

test('sparse UTF-8 byte offsets preserve CRLF/blank lines and resume both at and inside a block', async t => {
  const f = await fixture(t), resource = await createPatientMatchingTrialResource(f.dependencies);
  for (const [offset, count] of [[0, 1000], [999, 1000], [1000, 1000], [1001, 1000], [2000, 5], [2005, 0]]) {
    const result = await resource.loadRecords({ input: { offset } });
    assert.deepEqual(result.map(value => ({ registryId: value.registryId, text: value.text })), f.values.slice(offset, offset + count));
    for (const value of result) assert.equal(value.sourceDigest, `sha256:${createHash('sha256').update(value.text).digest('hex')}`);
  }
  assert.equal((await resource.authorize({ operatorBuild: true }, { operation: 'build' })).buildAllowed, true);
  assert.equal((await resource.authorize({ operatorBuild: false }, { operation: 'build' })).buildAllowed, false);
});

test('hash validation checks the exact record count before an index port can be created', async t => {
  for (const expectedRecords of [2, 4]) {
    const f = await fixture(t, { records: 3, expectedRecords });
    await assert.rejects(createPatientMatchingTrialResource(f.dependencies), { code: 'patient_matching_index_resource_invalid' });
  }
});

test('oversized/invalid UTF-8 lines and changed source bytes cannot be loaded', async t => {
  const oversized = await fixture(t, { records: 1, body: 'x'.repeat(256 * 1024 + 1) });
  await assert.rejects(createPatientMatchingTrialResource(oversized.dependencies), { code: 'patient_matching_index_resource_invalid' });
  const invalidUtf8 = await fixture(t, { records: 1, body: Buffer.from([0xff, 0x0a]) });
  await assert.rejects(createPatientMatchingTrialResource(invalidUtf8.dependencies));
  const changed = await fixture(t, { records: 1 }), resource = await createPatientMatchingTrialResource(changed.dependencies);
  await fs.appendFile(changed.recordsPath, '\n');
  await assert.rejects(resource.loadRecords({ input: { offset: 0 } }), { code: 'patient_matching_index_resource_invalid' });
});
