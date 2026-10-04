import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { delegationToolFilter, validateCapabilityManifest } from '../../../packages/domain/src/capabilityManifest.mjs';
import { isClinicalContractKind } from '../../../packages/domain/src/contractKinds.mjs';
import { runGate } from '../../../packages/domain/src/contractRegistry.mjs';
import { statisticalAnalysisFindings } from '../../../packages/domain/src/statisticalAnalysisContract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('statistical capability is clinical, optional-output and uses the existing native bash grant', async () => {
  const source = parse(await read('capabilities/statistical-analysis/capability.yaml'));
  const validated = validateCapabilityManifest(source);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  // One MCP tool, the one the two data capabilities share: what the project's datasets mean (N03). No retrieval, no engine.
  assert.deepEqual(source.tools, ['mcp__evimed__dataset_semantics']);
  assert.deepEqual(source.skills, ['statistical-analysis']);
  assert.ok(source.produces[0].outputs.every((output) => !output.required));
  assert.ok(delegationToolFilter(source, { allowBash: true }).includes('bash'));
  assert.equal(isClinicalContractKind('statistical-analysis-package'), true);
  assert.equal(runGate({ contractKind: 'statistical-analysis-package', expectedOutputs: source.produces[0].outputs,
    files: new Map([['statistical-report.md', 'The available data support a descriptive result.']]) }).ok, true);
});

test('statistical helper and skill ship byte-identically in injected and packed trees', async () => {
  for (const name of ['SKILL.md', 'scripts/run_analysis.py', 'scripts/analysis_methods.py', 'scripts/analysis_method_records.json']) {
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

test('the actual hosted registry loads both optional-output analysis capabilities', async () => {
  const { loadAgentRegistry } = await import('../src/agentRegistry.mjs');
  const registry = await loadAgentRegistry({ packageDirs: [path.join(root, 'runtime/skills/evimed')], capabilityDirs: [path.join(root, 'capabilities')] });
  for (const name of ['statistical-analysis', 'dataset-research-scoping']) {
    const agent = registry.get(name);
    assert.ok(agent, name);
    assert.equal(agent.completionChecks.includes('requiredOutputsExist'), false);
    assert.equal(agent.outputs.some((output) => output.required), false);
  }
});

const execFile = promisify(execFileCallback);

test('what the reference-checked helper returns is what the results contract reads: complete, partial and declined entries alike', async (t) => {
  // The helper needs the runtime image's numerical stack; a host without it has nothing to ask.
  try { await execFile('python3', ['-c', 'import numpy, pandas, scipy, statsmodels']); }
  catch { t.skip('numpy, pandas, scipy and statsmodels are not installed here'); return; }
  const script = [
    'import json, sys',
    "sys.path.insert(0, '.')",
    'import analysis_methods as am',
    'time = [5, 8, 12, 3, 9, 15, 20, 7, 11, 4]',
    'event = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1]',
    'analyses = [',
    "  am.compare_groups([1.0, 2.0, 3.0, 4.0, 5.0, 7.0], ['a', 'a', 'a', 'b', 'b', 'b'], contrast=('a', 'b'), label='difference'),",
    "  am.kaplan_meier(time, event, label='curve'),",
    "  am.contingency_test([[0, 20], [3, 17]], label='zero-cell table'),",
    "  am.logistic_regression([0, 0, 0, 1, 1, 1], [1, 2, 3, 4, 5, 6], label='separated'),",
    "  am.compare_groups([1.0, 2.0, 3.0, 4.0], ['a', 'a', 'b', 'b'], subject=[1, 1, 2, 2], label='repeated'),",
    "  am.cox_regression(time, event, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], label='hazard'),",
    ']',
    "print(json.dumps({'schemaVersion': 1, 'analyses': analyses}, allow_nan=False))",
  ].join('\n');
  const { stdout } = await execFile('python3', ['-c', script], { cwd: path.join(root, 'capabilities/statistical-analysis/scripts') });
  const results = JSON.parse(stdout);
  assert.deepEqual(results.analyses.map((entry) => entry.status), ['complete', 'complete', 'partial', 'unsupported', 'unsupported', 'complete']);
  for (const entry of results.analyses) {
    assert.equal(entry.seeded, false);
    assert.match(entry.methodRecord.digest, /^[a-f0-9]{64}$/);
    assert.match(entry.methodRecord.codeSha256, /^[a-f0-9]{64}$/);
    if (entry.status === 'unsupported') assert.ok(entry.reason && entry.estimate === null && entry.pValue === null, entry.id);
  }
  const { issues, metrics } = statisticalAnalysisFindings({ files: new Map([['analysis-results.json', JSON.stringify(results)]]) });
  assert.deepEqual(issues.filter((issue) => ['statistical-results-shape', 'statistical-finite-results'].includes(issue.check)), [],
    'a declined analysis has no number, so the contract has nothing to say about it, and a complete one has a finite estimate');
  assert.deepEqual([metrics.statisticalComplete, metrics.statisticalPartial, metrics.statisticalUnsupported], [3, 1, 2]);
});
