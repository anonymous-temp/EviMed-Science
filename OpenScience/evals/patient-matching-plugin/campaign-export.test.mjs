import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentDigest } from '../../packages/patient-matching-core/index.mjs';
import { exportCampaign } from './campaign-export.mjs';
test('official export refuses changed corpus provenance before relabeling a saved result', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-export-identity-'));
  try {
    const artifact = path.join(directory, 'artifact'), collection = path.join(directory, 'collection.json'), cases = path.join(directory, 'cases.jsonl'), config = path.join(directory, 'config.json');
    await fs.writeFile(artifact, 'qualified artifact'); await fs.writeFile(collection, '{}'); await fs.writeFile(cases, '{}\n');
    await fs.writeFile(config, JSON.stringify({ out: directory, artifact, artifactSha256: contentDigest('qualified artifact').slice(7), boards: { sigir: {
      collection, collectionDigest: contentDigest('{}'), cases, casesDigest: contentDigest('{}\n'),
    } } }));
    await fs.writeFile(collection, '{"databaseSha256":"a changed corpus"}');
    await assert.rejects(exportCampaign(config, path.join(directory, 'export')), /Frozen collection changed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
