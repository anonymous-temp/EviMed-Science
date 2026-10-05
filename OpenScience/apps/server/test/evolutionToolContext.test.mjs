import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvolutionToolContext } from '../src/evolutionToolContext.mjs';
const pin = { id: 'tool-method', nativeName: 'platform-' + 'a'.repeat(24), revision: 2, digest: 'sha256:' + 'b'.repeat(64), publicationKind: 'isolated-tool', capabilityIds: ['statistical-analysis'], files: [{ path: 'INSTRUCTIONS.md' }, { path: 'scripts/invoke_isolated.py' }], sourceFiles: { hidden: 'must never appear' } };
test('requested opaque tool maps only to exact scoped runtime pins without implementation leakage', () => {
  const context = renderEvolutionToolContext('调用平台工具 tool-method。', [pin], 'statistical-analysis');
  assert.ok(context.includes(pin.nativeName)); assert.ok(context.includes(pin.digest)); assert.ok(context.includes('/INSTRUCTIONS.md')); assert.ok(context.includes('/scripts/invoke_isolated.py'));
  assert.ok(!context.includes('must never appear'));
  assert.equal(renderEvolutionToolContext('tool-method-extra', [pin], 'statistical-analysis'), '');
  assert.equal(renderEvolutionToolContext('tool-method', [pin], 'other'), '');
  assert.equal(renderEvolutionToolContext('tool-method', [], 'statistical-analysis'), '');
  assert.equal(renderEvolutionToolContext('tool-method', [{ ...pin, nativeName: 'platform-../../escape' }], 'statistical-analysis'), '');
  assert.ok(!renderEvolutionToolContext('tool-method', [{ ...pin, revision: 3, digest: 'sha256:' + 'c'.repeat(64) }], 'statistical-analysis').includes(pin.digest));
});
test('requested-card metadata remains bounded to thirty even for larger immutable search generations', () => {
  const pins = Array.from({ length: 31 }, (_, i) => ({ ...pin, id: `tool-${i}` }));
  const context = renderEvolutionToolContext(pins.map(item => item.id).join(' '), pins, 'statistical-analysis');
  assert.equal((context.match(/"instructionPath"/g) ?? []).length, 30);
});
