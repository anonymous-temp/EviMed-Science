/* global setImmediate */
// The transcript as a reader takes it in: a finished conversation's whole
// history loaded so the kernel folds each closed turn, for every account; the
// backstage rows hidden for a researcher and kept for an operator.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, BODY, historyWanted, withoutPlatformBlocks } from '../src/runtimeUiTranscript.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, realReact, renderStatic } from './helpers/frameFakes.mjs';

/** A kernel whose context row is a real component, so a pass-through can be seen. */
function kernel() {
  const slots = kernelSlots();
  const { React } = realReact();
  /** @param {any} props */
  const KernelContextRow = (/** @type {any} */ props) => React.createElement('div', { 'data-kernel-context': props.node.data.provenance.role }, props.t('message.contextRecall'));
  const shipped = /** @type {any} */ (slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === 'context'));
  shipped.component = KernelContextRow;
  // The kernel's own user row, as the pinned `ui-chat` draws it (0.1.7-rc.2, `UserStyleBubble` over `contentParts`): every text part of
  // the message joined into one bubble, and any other part as a JSON block. Nothing of a message's text parts is left out.
  /** @param {any} props */
  const KernelUserRow = (/** @type {any} */ props) => React.createElement('div', { 'data-kernel-user': props.node.kind },
    props.node.data.content.filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join(''));
  for (const key of ['user', 'steering']) {
    const row = /** @type {any} */ (slots.registrations.find((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.key === key));
    row.component = KernelUserRow;
  }
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
        // 0.1.7: the session on screen is the row the main view retains.
        getSnapshot: () => ({ byId: current ? { [current]: { id: current, retainedBy: { mainView: 1 } } } : {} }),
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
  const bare = fakeCtx({ slots: kernel(), sessions: { list: { getSnapshot: () => ({ byId: { x: { id: 'x', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } } });
  const target = fakeTarget();
  assert.doesNotThrow(() => apply(bare, {}, target, undefined, kitFor(bare, target)));
});

test("a researcher's transcript draws neither the system prompt, injected context nor an event nobody can render", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const ours = ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.name === 'conversation.chat.node' && entry.options.priority === -1);
  assert.deepEqual(ours.map((/** @type {any} */ entry) => entry.options.key).sort(), ['context', 'steering', 'system-prompt', 'unknown', 'user']);
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

// R6, 2026-10-10: a result revision's frozen selection (`resultRevision.bind`) is appended to the researcher's own prompt as a second text
// part, for the model. The kernel's user row joins every text part into the bubble, so the raw JSON stood under what the researcher wrote.
const SELECTION = '\n<evimed_result_selection>\n{"versionId":"rv_1","anchor":{"kind":"text","selectedText":"0.8"},"preservation":"Read the frozen input."}\n</evimed_result_selection>';
const userNode = (/** @type {string} */ kind, /** @type {any[]} */ content) => ({ key: 'n2', kind, data: { content, time: 1 } });

test("a result revision's model-only block is not drawn under the researcher's own message", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const row = (/** @type {string} */ key) => ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === key && entry.options.priority === -1).component;
  const draft = '请修改所选内容：\n“0.8”\n\n修改要求：把结论写得更谨慎。';
  for (const kind of ['user', 'steering']) {
    const bubble = renderStatic(row(kind), { node: userNode(kind, [{ type: 'text', text: draft }, { type: 'text', text: SELECTION }]), t });
    assert.equal(bubble, `<div data-kernel-user="${kind}">${draft}</div>`);
    assert.doesNotMatch(bubble, /evimed_result_selection|versionId|Read the frozen input/);
  }
  // The block inside the one text part a different carrier may have used.
  const joined = renderStatic(row('user'), { node: userNode('user', [{ type: 'text', text: `${draft}${SELECTION}` }]), t });
  assert.doesNotMatch(joined, /evimed_result_selection|versionId/);
  assert.match(joined, /把结论写得更谨慎/);
  assert.deepEqual(target.warnings, []);
});

test("every other message of a researcher is drawn as the kernel draws it", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget();
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  const row = ctx.slots.registrations.find((/** @type {any} */ entry) => entry.options.key === 'user' && entry.options.priority === -1).component;
  const plain = userNode('user', [{ type: 'text', text: '比较 A 与 B 的疗效，<b>加粗</b> 与 <evimed_other> 的写法照旧。' }]);
  assert.equal(renderStatic(row, { node: plain, t }), '<div data-kernel-user="user">比较 A 与 B 的疗效，&lt;b&gt;加粗&lt;/b&gt; 与 &lt;evimed_other&gt; 的写法照旧。</div>');
  // A message that was only the block leaves nothing to draw (the kernel draws no bubble for an empty text).
  assert.equal(renderStatic(row, { node: userNode('user', [{ type: 'text', text: SELECTION }]), t }), '<div data-kernel-user="user"></div>');
  const content = [{ type: 'text', text: '一句话' }, { type: 'image', attachment: { id: 'a' } }];
  assert.equal(withoutPlatformBlocks(content), content, 'a message without the block is returned as it is, not copied');
  assert.deepEqual(withoutPlatformBlocks([{ type: 'text', text: `一句话${SELECTION}` }, { type: 'image', attachment: { id: 'a' } }]),
    [{ type: 'text', text: '一句话' }, { type: 'image', attachment: { id: 'a' } }]);
  assert.equal(withoutPlatformBlocks(undefined), undefined);
});

test("an operator's transcript keeps the block, as it keeps every other backstage row", () => {
  const ctx = fakeCtx({ slots: kernel(), sessions: sessionsFake({}).service });
  const target = fakeTarget({ frame: { operator: true } });
  apply(ctx, {}, target, undefined, kitFor(ctx, target));
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => ['user', 'steering'].includes(entry.options.key) && entry.options.priority === -1).length, 0);
});
