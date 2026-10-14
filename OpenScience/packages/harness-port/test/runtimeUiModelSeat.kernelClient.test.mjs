// Opt-in: the researcher's thinking-intensity seat against the kernel's OWN published client package, not a stand-in for it.
//
// runtimeUiNativeAssembly.test.mjs holds the seat on the pinned slot registry and renderer over a stand-in for the kernel's model seat that is
// transcribed from the shipped client (helpers/nativeModelSeat.mjs). A transcription can drift from the thing it copies, and the kernel's client
// is not a dependency of this package, so this test runs the real one when it is handed. It is skipped otherwise, like the Chromium fixture:
//
//   mkdir /tmp/ms && (cd /tmp/ms && npm pack @deepseek-ai/dsh-client-ui-model-selection@<the pin> && tar xzf *.tgz)
//   EVIMED_MODEL_SELECTION_CLIENT=/tmp/ms/package/lib/client.js npm test -- --test-name-pattern 'kernel client'
//
// Only what the package asks of the rest of the kernel is faked: the session scope and projection, the catalogue and `session.selectModel` of the
// remote, the locale runtime, the command registry and the UI primitives. The package's own ModelDirectoryResolver, ModelDirectory, ModelSelect
// and the `inject` it registers the seat with are the real ones.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as cordis from '@deepseek-ai/cordis';
import { nativeUiAssembly } from './helpers/nativeUiAssembly.mjs';

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const clientPath = process.env.EVIMED_MODEL_SELECTION_CLIENT;
const skip = clientPath ? false : 'Set EVIMED_MODEL_SELECTION_CLIENT to lib/client.js of @deepseek-ai/dsh-client-ui-model-selection at the pinned version';
const pins = JSON.parse(await fs.readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'));

// The catalogue entry as @deepseek-ai/dsh-llm-deepseek builds it (`modelInfo`): Off / Low / High / Max, the default taken from the profile.
const EFFORTS = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];
const CATALOGUE = {
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'deepseek-flash', reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }] }],
  failures: [],
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
};

/** The package's snapshot store (`@deepseek-ai/dsh-client-store` `createSnapshotStore`), as far as the package uses it. @param {any} initial */
function createSnapshotStore(initial) {
  let state = initial;
  /** @type {Set<() => void>} */ const listeners = new Set();
  const publish = (/** @type {any} */ next) => { state = next; for (const listener of [...listeners]) listener(); };
  return {
    getSnapshot: () => state,
    subscribe: (/** @type {() => void} */ listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: publish,
    update: (/** @type {(draft: any) => void} */ change) => { const draft = globalThis.structuredClone(state); change(draft); publish(draft); },
  };
}

/**
 * The kernel's client with the product's body, on the pinned renderer, in one page.
 * @param {import('node:test').TestContext} t
 * @param {{ operator?: boolean, bodyFirst?: boolean }} [options] `bodyFirst`: the product's body starts before the kernel's seat plugin applies
 */
async function mountWithKernelClient(t, { operator = false, bodyFirst = false } = {}) {
  assert.ok(clientPath);
  const moduleId = 'js' + 'dom', { JSDOM } = require(moduleId), dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
  const { ctx, React } = await nativeUiAssembly(dom);
  const { apply } = await import('../src/runtimeUiComposer.mjs'), { createFrameKit } = await import('../src/runtimeUiKit.mjs'), { FRAME_VOCABULARY } = await import('../src/runtimeUiFrame.mjs');
  const current = /** @type {any} */ (globalThis), old = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(current, name)]));
  current.window = dom.window; current.document = dom.window.document; current.IS_REACT_ACT_ENVIRONMENT = true;
  const sessionId = 'kernel-client-session';
  /** What `session.selectModel` was called with. @type {any[]} */
  const wire = [];
  const projection = createSnapshotStore({});
  const remoteSession = {
    modelCatalog: async () => ({ ok: true, value: CATALOGUE }),
    selectModel: async (/** @type {any} */ request) => {
      wire.push(request);
      // The Host's durable `model/selection` record, projected back to the client.
      projection.set({ next: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } });
      return { ok: true, value: undefined };
    },
  };
  ctx.provide('locale', { register: () => () => {}, bind: () => (/** @type {string} */ key) => key });
  ctx.provide('commandUi', { register: () => () => {} });
  ctx.provide('sessions', {
    scope: () => ({ effect: (/** @type {() => void} */ run) => { run(); } }),
    // `getSnapshot().blank` is what the directory asks of the session ("no first message yet"); a conversation with messages is not blank.
    binding: () => ({ session: { getSnapshot: () => ({ blank: false }), projections: { faceOf: () => ({ getSnapshot: () => projection.getSnapshot(), subscribe: (/** @type {() => void} */ listener) => projection.subscribe(listener) }) } } }),
    subagentAddress: () => undefined,
  });
  ctx.provide('remote', { $on: () => () => {}, session: remoteSession });
  ctx.provide('remote.session', remoteSession);

  // The package, evaluated the way the kernel's loader does: it registers one factory and is handed a `require`.
  /** @type {any} */ let definition;
  dom.window.__ModuleLoader__ = { load: (/** @type {any} */ value) => { definition = value; } };
  const bundle = await fs.readFile(/** @type {string} */ (clientPath), 'utf8');
  vm.runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console, globalThis: dom.window, queueMicrotask: globalThis.queueMicrotask, setTimeout, clearTimeout,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
  });
  const menuSurface = React.forwardRef((/** @type {any} */ props, /** @type {any} */ ref) => React.createElement('div',
    { ref, id: props.id, role: props.role, 'aria-label': props['aria-label'], 'aria-busy': props['aria-busy'], style: props.style }, props.children));
  // `rankByName` is a pure function of the primitives package that the picker reads on every render (the first 0.2 candidate
  // moved the picker's own filter there; against the earlier stand-in, which answered null for it, the operator's seat threw
  // "Cannot read properties of null"). An empty query returns the list as it is, which is all this test asks of it.
  const rankByName = (/** @type {any[]} */ items, /** @type {string} */ rawQuery) => {
    const query = String(rawQuery).toLowerCase();
    return query === '' ? items : items.filter(item => String(item.name).toLowerCase().includes(query));
  };
  const primitives = new Proxy({ MenuSurface: menuSurface, StateDot: () => React.createElement('span', { 'data-dot': '' }), Toast: () => null, rankByName },
    { get: (target, key) => (Object.hasOwn(target, key) ? /** @type {any} */ (target)[key] : () => null) });
  const modules = { '@deepseek-ai/dsh-client-ui-primitives': primitives, '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-store': { createSnapshotStore },
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-dom': require('react-dom'), react: React };
  assert.equal(typeof definition?.factory, 'function', 'the package registered its factory');
  const kernel = definition.factory((/** @type {string} */ id) => { if (!Object.hasOwn(modules, id)) throw new Error(`the package asked for ${id}`); return /** @type {any} */ (modules)[id]; });

  // The page: the root, and the composer bar declaring the seat the way `ui-conversation` does.
  const source = (/** @type {any} */ value) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const binding = { key: sessionId, ctx, hooks: {}, keyedHooks: {}, props: { sessionId } };
  ctx.slots.provideRoot({ props: {} });
  ctx.slots.installScope('session', { current: source(binding), bindingSource: () => source(binding), renderArea: (/** @type {any} */ _binding, /** @type {any} */ props) => props.children });
  ctx.slots.installLocale({ ...source({ revision: 0 }), bind: () => (/** @type {string} */ key) => key });
  const h = React.createElement;
  ctx.slots.register({ name: 'root', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } },
    (/** @type {any} */ props) => h(props.SessionProvider, null, props.renderSlot('conversation.composer.bar', {})));
  ctx.slots.register({ name: 'conversation.composer.bar', children: { 'conversation.input.model': { kind: 'single', scope: 'session' } } },
    (/** @type {any} */ props) => h('div', null, h('textarea', { defaultValue: 'a draft' }), props.renderSlot('conversation.input.model', { locked: false })));
  const target = Object.assign(dom.window, { __EVIMED_FRAME__: { version: 1, frameId: 'e'.repeat(32), operator } });
  const kit = createFrameKit(ctx, target, () => React, FRAME_VOCABULARY);
  if (bodyFirst) { apply(ctx, {}, target, undefined, kit); kernel.apply(ctx); } else { kernel.apply(ctx); apply(ctx, {}, target, undefined, kit); }
  /** @type {any} */ let unmount;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await React.act(async () => unmount?.());
    await ctx.fiber.dispose();
    dom.window.close();
    for (const [name, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(current, name, descriptor); else delete current[name]; }
  };
  t.after(cleanup);
  await React.act(async () => { unmount = ctx.uiRenderer.mount(dom.window.document.getElementById('root')); await new Promise(resolve => setTimeout(resolve, 30)); });
  const doc = dom.window.document;
  return {
    ctx, doc, cleanup,
    /** What reached `session.selectModel`, copied out of the package's realm so it can be compared. */
    wire: () => /** @type {any[]} */ (globalThis.structuredClone(wire)),
    trigger: () => /** @type {any} */ (doc.querySelector('button[aria-haspopup="menu"]')),
    rows: () => /** @type {any[]} */ ([...doc.querySelectorAll('[role="menuitemradio"]')]),
    act: (/** @type {() => any} */ run) => React.act(async () => { await run(); await new Promise(resolve => setTimeout(resolve, 15)); }),
  };
}

test('kernel client: the bundle is the pinned version\'s', { skip }, async () => {
  const published = JSON.parse(await fs.readFile(path.join(path.dirname(/** @type {string} */ (clientPath)), '..', 'package.json'), 'utf8'));
  assert.equal(published.name, '@deepseek-ai/dsh-client-ui-model-selection');
  assert.equal(published.version, pins.dsh.version, 'the check is only as good as the version it ran against');
});

for (const bodyFirst of [false, true]) {
  test(`kernel client: the researcher's seat reads and sets the level through the kernel's own directory (${bodyFirst ? 'body starts first' : 'kernel starts first'})`, { skip }, async t => {
    const m = await mountWithKernelClient(t, { bodyFirst });
    assert.equal(m.ctx.slots.entries('conversation.input.model').length, 2, 'the kernel\'s entry at 0 and the product\'s below it');
    assert.equal(m.trigger()?.textContent, '思考强度：高', 'a session with no choice reads the default the adapter was given');
    assert.doesNotMatch(`${m.trigger()?.parentElement?.textContent} ${m.trigger()?.getAttribute('aria-label')} ${m.trigger()?.title}`, /deepseek|provider|\b(?:off|low|high|max)\b/i);
    await m.act(() => m.trigger().click());
    assert.deepEqual(m.rows().map(row => row.textContent), ['关闭', '低', '高', '最高']);
    assert.deepEqual(m.rows().map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true', 'false']);
    await m.act(() => m.rows().find(row => row.textContent === '最高').click());
    assert.deepEqual(m.wire(), [{ sessionId: 'kernel-client-session', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }],
      'the directory sent the certified route and the level, the request the proxy admits');
    assert.equal(m.trigger()?.textContent, '思考强度：最高', 'and, once the Host\'s record is projected back, the control reads it');
    assert.equal(m.doc.body.textContent?.includes('deepseek-flash'), false, 'the kernel\'s own seat was never drawn');
  });
}

test('kernel client: an operator keeps the kernel\'s own seat, and choosing Max there sends exactly what the researcher\'s control sends for 最高', { skip }, async t => {
  const researcher = await mountWithKernelClient(t);
  await researcher.act(() => researcher.trigger().click());
  await researcher.act(() => researcher.rows().find(row => row.textContent === '最高').click());
  const sent = researcher.wire();
  await researcher.cleanup();
  const operator = await mountWithKernelClient(t, { operator: true });
  assert.equal(operator.trigger()?.textContent, 'deepseek-flashHigh', 'the picker an operator has always had');
  assert.doesNotMatch(operator.doc.body.textContent ?? '', /思考强度/);
  await operator.act(() => operator.trigger().click());
  await operator.act(() => /** @type {any[]} */ ([...operator.doc.querySelectorAll('[role="menuitem"]')])[1].click());
  await operator.act(() => operator.rows().find(row => row.textContent === 'Max').click());
  assert.deepEqual(operator.wire(), sent);
});
