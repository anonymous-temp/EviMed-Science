import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evolutionDataMatch } from '@evimed/domain';
import { evolutionDatasetMetadata } from '../src/evolutionIntegration.mjs';
test('native text semantics maps to JSON string without coercing outcome codes or unknown units', () => {
  const requirement = { schema: { fields: [{ name: 'type', type: 'string', constraints: { required: true, enum: ['Yes', 'No'] } }] }, researchRules: { requiredSemanticsChecks: ['drift'] } };
  const asset = (type, codes) => ({ tables: [{ variables: [{ name: 'type', facts: { type: { value: type, basis: 'dictionary-stated' }, allowedValues: { value: codes.map(code => ({ code })) } } }] }], lastCheck: { checkedAt: '2026-10-05T00:00:00Z', clean: [{ family: 'drift' }], findings: [], notChecked: [] } });
  const text = evolutionDatasetMetadata(asset('text', ['Yes', 'No']));
  assert.equal(text.fields[0].type, 'string');
  assert.equal(text.fields[0].unit, undefined);
  assert.deepEqual(text.fields[0].categories, ['Yes', 'No']);
  assert.equal(evolutionDataMatch(requirement, text).matched, true);
  for (const [type, codes] of [['integer', ['Yes', 'No']], ['number', ['Yes', 'No']], ['text', [1, 0]], ['text', ['Yes', 'Maybe']], [undefined, ['Yes', 'No']]]) {
    assert.equal(evolutionDataMatch(requirement, evolutionDatasetMetadata(asset(type, codes))).matched, false);
  }
});
test('actual native same-byte drift evidence admits exact source while changed or unavailable drift does not', () => {
  const program = `import sys,tempfile,pathlib,json\nsys.path.insert(0,${JSON.stringify(new URL('../../../runtime/mcp/evimed-research/', import.meta.url).pathname)})\nimport data_semantics_checks as checks\nwith tempfile.TemporaryDirectory() as root:\n p=pathlib.Path(root)/'sample.csv';p.write_text('value\\n1\\n2\\n')\n table=checks.read_tables(root,'sample.csv')[0]\n previous={'sha256':table.sha256,'rows':2,'bytes':table.bytes,'columns':[]}\n results=[]\n for prior in [previous,None,{**previous,'sha256':'different'}]:\n  found=[];notes=[];clean=[]\n  checks.check_drift(table,prior,{},found,notes,clean)\n  results.append({'findings':found,'notChecked':notes,'clean':clean,'checkedAt':'2026-10-04T00:00:00Z'})\n print(json.dumps(results))\n`;
  const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const checks = JSON.parse(result.stdout);
  const requirement = { schema: { fields: [] }, researchRules: { requiredSemanticsChecks: ['drift'] } };
  const match = value => evolutionDataMatch(requirement, evolutionDatasetMetadata({ lastCheck: value }));
  assert.equal(checks[0].findings[0].outcome, 'source_unchanged');
  assert.equal(match(checks[0]).matched, true);
  assert.equal(match(checks[1]).matched, false);
  assert.equal(match(checks[2]).matched, false);
  for (const contradiction of [{ family: 'drift', outcome: 'column_removed', severity: 'attention' }, { family: 'drift', outcome: 'source_changed', severity: 'information' }]) assert.equal(match({ ...checks[0], findings: [...checks[0].findings, contradiction] }).matched, false);
  assert.equal(match({ ...checks[0], notChecked: [{ family: 'drift', reason: 'no_baseline' }] }).matched, false);
});
