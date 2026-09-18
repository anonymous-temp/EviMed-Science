// The transcript without its backstage rows, for a researcher; every row for
// an operator.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY } from '../src/runtimeUiTranscript.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, realReact, renderStatic } from './helpers/frameFakes.mjs';

/** A kernel whose context row is a real component, so a pass-through can be seen. */
function kernel() {
  const slots = kernelSlots();
  const { React } = realReact();
  /** @param {any} props */
  const KernelContextRow = (/** @type {any} */ props) => React.createElement('div', { 'data-kernel-context': props.node.data.provenance.role }, props.t('message.contextRecall'));
  const shipped = /** @type {any} */ (slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === 'context'));
  shipped.component = KernelContextRow;
  return slots;
}

/** @param {string} role */
const contextNode = (role) => ({ key: 'n1', kind: 'context', data: { content: [], source: {}, provenance: { role, label: '@deepseek-ai/dsh-system-prompt' }, form: null } });
const t = (/** @type {string} */ key) => ({ 'message.contextRecall': '跨会话召回' })[key] ?? key;

test("a researcher's transcript draws neither the system prompt nor injected context", () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const ours = ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.priority === -1);
  assert.deepEqual(ours.map((/** @type {any} */ entry) => entry.options.key).sort(), ['context', 'system-prompt']);
  assert.ok(ours.every((/** @type {any} */ entry) => entry.options.locale === 'chat'));
  const byKey = (/** @type {string} */ key) => ours.find((/** @type {any} */ entry) => entry.options.key === key).component;
  assert.equal(renderStatic(byKey('system-prompt'), { node: { kind: 'system-prompt', data: {} }, t }), '');
  assert.equal(renderStatic(byKey('context'), { node: contextNode('inject'), t }), '');
  assert.deepEqual(target.warnings, []);
});

test("a cross-session recall is the researcher's own reference and keeps the kernel's own row", () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const ContextRow = ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === 'context' && entry.options.priority === -1).component;
  assert.equal(renderStatic(ContextRow, { node: contextNode('recall'), t }), '<div data-kernel-context="recall">跨会话召回</div>');
});

test("an operator's transcript is the kernel's own, every row of it", () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget({ frame: { operator: true } });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
  assert.equal(BODY.name, 'transcript');
});

test('outside a frame nothing is taken over', () => {
  const ctx = fakeCtx({ slots: kernel() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
});
