import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { delegationToolFilter, validateCapabilityManifest } from '../../../packages/domain/src/capabilityManifest.mjs';
import { isClinicalContractKind } from '../../../packages/domain/src/contractKinds.mjs';
import { runGate } from '../../../packages/domain/src/contractRegistry.mjs';
import { GENE_EXPRESSION_CAPABILITY_ID, GENE_EXPRESSION_CONTRACT_KIND, GENE_EXPRESSION_RESULT_FILES, MCP_TOOL_BASE_NAMES } from '@evimed/domain';

// The gene-expression-analysis capability (the public NCBI Gene Expression Omnibus; not 循证 GEO): its manifest, its skill, its
// contract and the names that keep it apart from the pharma module.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('the manifest is valid, clinical like its sibling data analysis, and every output is optional', async () => {
  const source = parse(await read('capabilities/gene-expression-analysis/capability.yaml'));
  const validated = validateCapabilityManifest(source);
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  assert.equal(source.id, GENE_EXPRESSION_CAPABILITY_ID);
  assert.equal(source.id, 'gene-expression-analysis');
  assert.deepEqual(source.skills, ['gene-expression-analysis']);
  // The two tools of the workflow, the render that carries every number into the report, and a literature lookup for the series'
  // publication. Not one of the pharma module's tools.
  assert.deepEqual(source.tools, [
    'mcp__evimed__gene_expression_series', 'mcp__evimed__gene_expression_differential', 'mcp__evimed__research_calculate', 'mcp__evimed__literature_search',
  ]);
  assert.ok(source.tools.every((tool) => MCP_TOOL_BASE_NAMES.includes(tool.replace('mcp__evimed__', ''))));
  assert.ok(source.produces[0].outputs.every((output) => !output.required), 'a refused computation must still be a deliverable report');
  assert.equal(source.produces[0].contractKind, GENE_EXPRESSION_CONTRACT_KIND);
  assert.deepEqual(source.produces[0].outputs.map((output) => output.path).sort(),
    [...Object.values(GENE_EXPRESSION_RESULT_FILES), 'gene-expression-report.md'].sort());
  assert.equal(isClinicalContractKind(GENE_EXPRESSION_CONTRACT_KIND), true);
  assert.deepEqual(source.inputs.required, ['seriesAccession']);
  assert.ok(delegationToolFilter(source, { allowBash: true }).includes('bash'));
});

test('no identifier of this capability is the bare name of the pharma module', async () => {
  const source = parse(await read('capabilities/gene-expression-analysis/capability.yaml'));
  const names = [source.id, source.skills[0], ...source.tools, source.produces[0].contractKind, ...source.produces[0].outputs.map((output) => output.path), ...source.dataSources];
  for (const name of names) {
    assert.doesNotMatch(name.replace(/^mcp__evimed__/, ''), /^geo[-_]|[-_]geo[-_]/, `${name} must say gene-expression, never bare geo`);
  }
});

test('the skill ships byte-identically in the injected tree and says what it must about the method', async () => {
  for (const name of ['SKILL.md', 'scripts/verify_result.py']) {
    const canonical = await read(`capabilities/gene-expression-analysis/${name}`);
    assert.equal(await read(`capability-skills/gene-expression-analysis/${name}`), canonical, name);
    const packed = await read(`packages/socket/capability-skills/gene-expression-analysis/${name}`).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (packed !== null) assert.equal(packed, canonical);
  }
  const skill = await read('capabilities/gene-expression-analysis/SKILL.md');
  for (const needed of ['not limma', 'empirical-Bayes', 'never compute a statistic', 'research_calculate', 'action=render', 'unknown', 'probe']) {
    assert.ok(skill.includes(needed), `the skill must say: ${needed}`);
  }
  // Every file a run is told to produce or read is named where the contract names it.
  for (const file of ['gene-expression-report.md', 'gene-expression-top-table.md', 'scripts/verify_result.py']) assert.ok(skill.includes(file), file);
});

test('a refused computation, with only a short report, is a delivery; and a package with findings is delivered with them', async () => {
  const source = parse(await read('capabilities/gene-expression-analysis/capability.yaml'));
  const gate = runGate({
    contractKind: GENE_EXPRESSION_CONTRACT_KIND, expectedOutputs: source.produces[0].outputs,
    files: new Map([['gene-expression-report.md', 'The series is larger than this deployment computes in one run, so no comparison was made.']]),
  });
  assert.equal(gate.ok, true, JSON.stringify(gate.issues));
});
