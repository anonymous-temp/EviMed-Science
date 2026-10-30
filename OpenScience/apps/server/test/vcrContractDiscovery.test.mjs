import assert from 'node:assert/strict';
import test from 'node:test';
import { VCR_REQUIREMENT_CONTRACT, VCR_REQUIREMENT_OPS, validateRequirement } from '@evimed/domain';
import { vcrContractsRead } from '../src/vcrWriteContracts.mjs';
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
