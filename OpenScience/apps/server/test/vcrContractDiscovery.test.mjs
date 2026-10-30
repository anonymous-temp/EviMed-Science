import assert from 'node:assert/strict';
import test from 'node:test';
import { VCR_REQUIREMENT_CONTRACT, VCR_REQUIREMENT_OPS, validateRequirement } from '@evimed/domain';
import { readFile } from 'node:fs/promises';
import { vcrContractsRead, vcrWriteContracts } from '../src/vcrWriteContracts.mjs';
import { VCR_DATA_INTAKE_CONTRACT } from '../src/vcrDataIntake.mjs';
import { VCR_WRITE_WHATS } from '../src/vcrService.mjs';
import { VcrService } from '../src/vcrService.mjs';

test('static discovery exposes every validator operation and every example validates without a write', () => {
  const shape = vcrContractsRead();
  assert.equal(shape.schemaOnly, true);
  assert.equal(shape.requirementGrammar, VCR_REQUIREMENT_CONTRACT);
  assert.deepEqual(Object.keys(shape.requirementGrammar.nodes), [...VCR_REQUIREMENT_OPS]);
  for (const example of shape.requirementGrammar.examples) assert.deepEqual(validateRequirement(example), [], JSON.stringify(example));
  assert.match(shape.writeEnvelope.rule, /never nested inside data/);
  assert.match(shape.dataIntake.mutability, /Confirmed field maps can be revised/);
  assert.match(shape.dataIntake.mutability, /frozen snapshot is immutable/);
});

test('discovered scalar/list/interval comparators and nested applicability have complete field shapes', () => {
  for (const comparator of VCR_REQUIREMENT_CONTRACT.compare.comparators) {
    const node = { op: 'compare', variable: 'age', comparator,
      value: ['in', 'not_in'].includes(comparator) ? [18, 65] : 18,
      ...(comparator === 'between' ? { highValue: 65 } : {}) };
    assert.deepEqual(validateRequirement(node), [], comparator);
    assert.deepEqual(validateRequirement({ op: 'not', operand: { op: 'any', operands: [node, { op: 'absent', variable: 'condition' }] } }), []);
  }
  for (const unit of VCR_REQUIREMENT_CONTRACT.window.exactlyOne) {
    const node = { op: 'present', variable: 'measurement', window: { [unit]: 1, anchorDate: '2026-01-10' } };
    assert.deepEqual(validateRequirement(node), [], unit);
  }
  for (const comparator of VCR_REQUIREMENT_CONTRACT.elapsed_since.comparators) {
    assert.deepEqual(validateRequirement({ op: 'elapsed_since', variable: 'treatment', days: 180, comparator, deniedSatisfies: false }), []);
  }
  assert.ok(validateRequirement({ op: 'compare', variable: 'pregnancy', comparator: 'eq', value: false }).length, 'boolean values are not in this grammar');
  assert.ok(validateRequirement({ op: 'known', variable: 'pregnancy' }).length, 'do not probe an invented known operator');
  assert.ok(validateRequirement({ op: 'elapsed_since', variable: 'treatment', days: 180, comparator: 'lt', anchor: 'today' }).length);
});

test('contract and intake discovery cannot fall through into arbitrary store or registry data', async () => {
  let touched = false;
  const unexpected = () => { touched = true; throw new Error('A static contract read reached scientific data'); };
  const service = new VcrService({ store: new Proxy({}, { get: () => unexpected }), config: {}, evidence: { registryRecord: unexpected } });
  const contract = await service.runtimeRead({ id: null }, 'contracts');
  assert.equal(contract.schemaOnly, true);
  assert.equal(contract.requirementGrammar.nodes.compare.required.includes('value'), true);
  const intake = await service.runtimeRead({ id: 'study' }, 'data_intake', { registryId: 'unrelated' });
  assert.equal(intake.code, 'vcr_invocation_unavailable');
  assert.equal(touched, false);
});

test('every write the gateway takes has a contract, derived from the list its writer enforces and not written twice', async () => {
  const contracts = vcrWriteContracts();
  const without = VCR_WRITE_WHATS.filter(what => !contracts[what]);
  assert.deepEqual(without, [], 'a write with no contract is one a run can only learn by being refused');
  for (const what of ['history', 'trial_benchmark', 'forecast_design']) {
    assert.ok(contracts[what].fields.length > 0, what);
    assert.equal(contracts[what].additionalProperties, false, what);
  }
  assert.ok(contracts.history.fields.includes('snapshotId'));
  assert.ok(contracts.forecast_design.fields.includes('predictionId'));
  assert.ok(contracts.trial_benchmark.fields.includes('comparisons'));
  // The intake's fields are the union of its actions' own, taken from the adapter's contract.
  const intake = vcrContractsRead('data_intake').writes.data_intake;
  assert.deepEqual(intake.actions, VCR_DATA_INTAKE_CONTRACT.actions);
  for (const fields of Object.values(VCR_DATA_INTAKE_CONTRACT.actions)) for (const field of fields) assert.ok(intake.fields.includes(field), field);
  assert.match(intake.envelope, /items is refused/);
  // A writer that kept its own inline list would be a second copy that can drift from the contract.
  const gateway = await readFile(new URL('../src/vcrGateway.mjs', import.meta.url), 'utf8');
  assert.deepEqual(gateway.match(/item\.only\(\[/g) ?? [], [], 'every writer reads its closed list from VCR_WRITE_FIELDS');
});
