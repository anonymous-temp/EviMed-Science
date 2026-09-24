/* global setImmediate */
// The transcript as a reader takes it in: a finished conversation's whole
// history loaded so the kernel folds each closed turn, for every account; the
// backstage rows hidden for a researcher and kept for an operator.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY, historyWanted } from '../src/runtimeUiTranscript.mjs';
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

/**
 * The session controller as the frame sees it: a list with the current
 * session, and each session's face — a snapshot that changes, subscribers,
 * and the jump loader, recorded.
 * @param {Record<string, any>} initial snapshots by session id
 */
function sessionsFake(initial) {
  /** @type {Set<() => void>} */
  const listListeners = new Set();
  let current = Object.keys(initial)[0] ?? null;
  /** @type {Map<string, any>} */
  const faces = new Map();
  /** @type {string[]} */
  const loads = [];
  /** @type {Set<string>} */
  const bound = new Set(Object.keys(initial));
  for (const [id, snapshot] of Object.entries(initial)) {
    /** @type {Set<() => void>} */
    const listeners = new Set();
    let state = { openState: 'open', hasMore: true, loadingOlder: false, running: false, ...snapshot };
    faces.set(id, {
      listeners,
      getSnapshot: () => state,
      subscribe: (/** @type {() => void} */ listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      loadThrough: (/** @type {number} */ seq) => { loads.push(`${id}@${seq}`); return Promise.resolve(); },
      /** @param {Record<string, any>} patch */
      set(patch) { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); },
    });
  }
  return {
    faces, loads, bound,
    service: {
      list: {
        getSnapshot: () => ({ current }),
        subscribe: (/** @type {() => void} */ listener) => { listListeners.add(listener); return () => { listListeners.delete(listener); }; },
      },
      binding: (/** @type {string} */ id) => (bound.has(id) && faces.has(id) ? { sessionId: id, session: faces.get(id) } : undefined),
    },
    /** @param {string} id */
    open(id) { current = id; for (const listener of [...listListeners]) listener(); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** @param {any} sessions @param {{ operator?: boolean }} [options] */
function frame(sessions, { operator = false } = {}) {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessions.service });
  const target = fakeTarget({ frame: { operator } });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  return { ctx, target };
}

test('a finished conversation is read to its first event, once, so the kernel folds every closed turn', async () => {
  assert.equal(historyWanted({ openState: 'open', hasMore: true, loadingOlder: false, running: false }), true);
  assert.equal(historyWanted({ openState: 'open', hasMore: true, running: true }), false, 'a running turn stays open by the kernel\'s own rule');
  assert.equal(historyWanted({ openState: 'open', hasMore: false }), false, 'a short conversation is complete already');
  assert.equal(historyWanted({ openState: 'loading', hasMore: true }), false);
  assert.equal(historyWanted({ openState: 'open', hasMore: true, loadingOlder: true }), false, 'the reader is paging it already');
  assert.equal(historyWanted(null), false);

  const s = sessionsFake({ 'session-a': {} });
  const f = frame(s);
  await settle();
  assert.deepEqual(s.loads, ['session-a@0'], "through the session's own jump loader, to the first event");
  s.faces.get('session-a').set({ loadingOlder: true });
  s.faces.get('session-a').set({ loadingOlder: false, hasMore: false });
  await settle();
  assert.deepEqual(s.loads, ['session-a@0'], 'one read per opening of the window, never a loop');
  // The window was rebuilt from its tail (a reconnect): read again.
  s.faces.get('session-a').set({ openState: 'loading', hasMore: true });
  s.faces.get('session-a').set({ openState: 'open' });
  await settle();
  assert.deepEqual(s.loads, ['session-a@0', 'session-a@0']);
  assert.deepEqual(f.target.warnings, []);
});

test('a running conversation stays as it is until it finishes, and then folds', async () => {
  const s = sessionsFake({ 'session-a': { running: true } });
  frame(s);
  await settle();
  assert.deepEqual(s.loads, []);
  s.faces.get('session-a').set({ running: false });
  await settle();
  assert.deepEqual(s.loads, ['session-a@0']);
});

test('the conversation on screen is the one read, as the reader moves between them', async () => {
  const s = sessionsFake({ 'session-a': { running: true }, 'session-b': {}, 'session-c': {} });
  s.bound.delete('session-c');
  const f = frame(s);
  s.open('session-b');
  await settle();
  assert.deepEqual(s.loads, ['session-b@0']);
  assert.equal(s.faces.get('session-a').listeners.size, 0, 'the one left behind is no longer followed');
  // A session the controller has not bound yet is picked up when it is.
  s.open('session-c');
  await settle();
  assert.deepEqual(s.loads, ['session-b@0']);
  s.bound.add('session-c');
  s.open('session-c');
  await settle();
  assert.deepEqual(s.loads, ['session-b@0', 'session-c@0']);
  f.ctx.dispose();
  assert.equal(s.faces.get('session-c').listeners.size, 0, 'unloading the body lets go of the session');
});

test("an operator's conversations fold too; a controller without the loader is left alone", async () => {
  const s = sessionsFake({ 'session-a': {} });
  frame(s, { operator: true });
  await settle();
  assert.deepEqual(s.loads, ['session-a@0']);
  const bare = fakeCtx({ slots: kernel(), sessions: { list: { getSnapshot: () => ({ current: 'x' }), subscribe: () => () => {} } } });
  const target = fakeTarget();
  assert.doesNotThrow(() => apply(bare, {}, target, undefined, kitFor(bare, target)));
});

test("a researcher's transcript draws neither the system prompt, injected context nor an event nobody can render", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const ours = ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.priority === -1);
  assert.deepEqual(ours.map((/** @type {any} */ entry) => entry.options.key).sort(), ['context', 'system-prompt', 'unknown']);
  assert.ok(ours.every((/** @type {any} */ entry) => entry.options.locale === 'chat'));
  const byKey = (/** @type {string} */ key) => ours.find((/** @type {any} */ entry) => entry.options.key === key).component;
  assert.equal(renderStatic(byKey('system-prompt'), { node: { kind: 'system-prompt', data: {} }, t }), '');
  assert.equal(renderStatic(byKey('context'), { node: contextNode('inject'), t }), '');
  assert.equal(renderStatic(byKey('unknown'), { node: { kind: 'unknown', data: { type: 'evimed/whatever' } }, t }), '', 'the event type and its raw payload are an operator\'s');
  assert.deepEqual(target.warnings, []);
});

test("a cross-session recall is the researcher's own reference and keeps the kernel's own row", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const ContextRow = ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === 'context' && entry.options.priority === -1).component;
  assert.equal(renderStatic(ContextRow, { node: contextNode('recall'), t }), '<div data-kernel-context="recall">跨会话召回</div>');
});

test("an operator's transcript is the kernel's own, every row of it", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget({ frame: { operator: true } });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
  assert.equal(BODY.name, 'transcript');
});

test('outside a frame nothing is taken over and nothing is read', async () => {
  const s = sessionsFake({ 'session-a': {} });
  const ctx = fakeCtx({ slots: kernel(), sessions: s.service });
  const target = fakeTarget({ framed: false });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  await settle();
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.options.priority === -1).length, 0);
  assert.deepEqual(s.loads, []);
});
