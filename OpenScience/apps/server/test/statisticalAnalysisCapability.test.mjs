import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { delegationToolFilter, validateCapabilityManifest } from '../../../packages/domain/src/capabilityManifest.mjs';
import { isClinicalContractKind } from '../../../packages/domain/src/contractKinds.mjs';
import { runGate } from '../../../packages/domain/src/contractRegistry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('statistical capability is clinical, optional-output and uses the existing native bash grant', async () => {
  const source = parse(await read('capabilities/statistical-analysis/capability.yaml'));
  const validated = validateCapabilityManifest(source);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  assert.deepEqual(source.tools, []);
  assert.deepEqual(source.skills, ['statistical-analysis']);
  assert.ok(source.produces[0].outputs.every((output) => !output.required));
  assert.ok(delegationToolFilter(source, { allowBash: true }).includes('bash'));
  assert.equal(isClinicalContractKind('statistical-analysis-package'), true);
  assert.equal(runGate({ contractKind: 'statistical-analysis-package', expectedOutputs: source.produces[0].outputs,
    files: new Map([['statistical-report.md', 'The available data support a descriptive result.']]) }).ok, true);
});

test('statistical helper and skill ship byte-identically in injected and packed trees', async () => {
  for (const name of ['SKILL.md', 'scripts/run_analysis.py']) {
    const canonical = await read(`capabilities/statistical-analysis/${name}`);
    assert.equal(await read(`capability-skills/statistical-analysis/${name}`), canonical);
    const packed = await read(`packages/socket/capability-skills/statistical-analysis/${name}`).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (packed !== null) assert.equal(packed, canonical);
  }
});

test('scoping keeps its optional partial report under the existing contract', async () => {
  const source = parse(await read('capabilities/dataset-research-scoping/capability.yaml'));
  assert.ok(source.produces[0].outputs.every((output) => !output.required));
  const gate = runGate({ contractKind: 'dataset-scoping-package', expectedOutputs: source.produces[0].outputs,
    files: new Map([['research-portfolio.md', 'The dataset supports a descriptive comparison. Literature access was unavailable.']]) });
  assert.equal(gate.ok, true);
});
