// The kernel's queue/steer behaviour, said where the typing happens.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY, busyHint } from '../src/runtimeUiControls.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

test('while the agent runs, the composer says what Enter and Ctrl/⌘+Enter do', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const entry = ctx.slots.registrations.find((/** @type {any} */ candidate) => candidate.name === 'conversation.input.dock');
  assert.equal(entry.options.id, 'evimed-busy-hint', 'a list seat takes an id');
  assert.match(renderStatic(entry.component, { session: { running: true } }), /运行中：Enter 排队 · Ctrl\/⌘\+Enter 插话/);
  assert.equal(renderStatic(entry.component, { session: { running: false } }), '');
  assert.equal(renderStatic(entry.component, {}), '');
  assert.equal(busyHint(), '运行中：Enter 排队 · Ctrl/⌘+Enter 插话');
  assert.equal(BODY.name, 'controls');
});

test('outside a frame there is no hint', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ candidate) => candidate.name === 'conversation.input.dock').length, 0);
});
