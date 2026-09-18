// The frame layer's build form.
//
// The bodies reach the browser as `toString()` text inside one loader entry,
// evaluated on another origin where no module of ours exists. What is asserted
// here is that the text the build emits is self-sufficient — every body and
// the kit evaluate in an empty context and still register — that the one
// registration path refuses the slot misuses that used to ship as silent
// no-ops, and that a body can be switched off or can fail without taking the
// others (or the conversation) with it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { FRAME_BODIES, FRAME_SWITCHABLE_BODIES, FRAME_VOCABULARY, partsSource, renderFrameClient } from '../src/runtimeUiFrame.mjs';
import { KIT_PARTS, createFrameKit } from '../src/runtimeUiKit.mjs';
import { GEOMETRY_KERNEL_PIN } from '../src/runtimeUiShell.mjs';
import { RUNTIME_UI_KERNEL_PIN, RUNTIME_UI_SLOTS } from '../src/runtimeUiSlots.mjs';
import { fakeCtx, fakeTarget, kernelSlots, realReact } from './helpers/frameFakes.mjs';

/** The services every hosted page provides, as recording fakes. */
function services() {
  // One generation object for the page's life: a fresh one per read is a
  // reconnect on every read, and the bridge would re-establish forever.
  const generation = {};
  return {
    slots: kernelSlots(),
    locale: { addLanguage: () => () => {}, register: () => () => {}, setLocale() {}, subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh-x-evimed' }) },
    sessions: {
      refresh: async () => {}, create: async () => 'session-a', open() {}, scope: () => ({}), search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
      list: { getSnapshot: () => ({ current: 'session-a', byId: {} }), subscribe: () => () => {} },
    },
    conversation: { input: { for: () => ({ setDraft() {}, notify() {} }) } },
    connection: { generation: { getSnapshot: () => generation, subscribe: () => () => {} } },
    workspaces: { create: async () => ({ workspaceId: 'w', sessionIds: [] }), list: { getSnapshot: () => ({ items: [] }) } },
    loader: { await: async () => {} },
  };
}

/**
 * Evaluate source text in a context holding only what a browser page gives
 * every script — no module, no Node global.
 * @param {string} source @param {Record<string, any>} [globals]
 */
function evaluate(source, globals = {}) {
  return vm.runInNewContext(source, { console, Promise, AbortController: globalThis.AbortController, ...globals });
}

test('every body and the kit evaluate from their emitted text alone, and still register', () => {
  const createKit = evaluate(partsSource(KIT_PARTS, 'createFrameKit'));
  assert.equal(typeof createKit, 'function');
  assert.ok(FRAME_BODIES.length >= 4, 'no bodies were read, so this test walked nothing');
  assert.ok(FRAME_BODIES.some((body) => body.name === 'bridge') && FRAME_BODIES.some((body) => body.name === 'shell'));
  const { React } = realReact();
  for (const body of FRAME_BODIES) {
    const apply = evaluate(partsSource(body.parts, 'apply'));
    assert.equal(typeof apply, 'function', `${body.name} did not evaluate standalone`);
    const ctx = services();
    const context = /** @type {any} */ ({ effects: [] });
    Object.assign(context, ctx, {
      effect: (/** @type {() => any} */ setup) => { context.effects.push(setup()); },
      inject: (/** @type {string[]} */ names, /** @type {(scope: any) => void} */ callback) => { if (names.every((name) => context[name] !== undefined)) callback(context); },
      on: () => () => {},
      get: (/** @type {string} */ name) => context[name],
    });
    const target = fakeTarget({ frame: { capabilities: [{ id: 'meta-analysis', title: '自动化 Meta 分析', category: '证据综合', brief: '请以「自动化 Meta 分析」能力完成以下任务：\n…' }] } });
    const kit = createKit(context, target, (/** @type {string} */ id) => (id === 'react' ? React : undefined), FRAME_VOCABULARY);
    assert.doesNotThrow(() => apply(context, {}, target, (/** @type {string} */ id) => (id === 'react' ? React : undefined), kit), `${body.name} failed when applied from its own text`);
    assert.deepEqual(target.warnings.filter((/** @type {any[]} */ entry) => String(entry[0]).includes('refused')), [], `${body.name}: the kernel refused a registration`);
    for (const registration of context.slots.registrations.filter((/** @type {any} */ entry) => entry.component !== 'shipped')) {
      const contract = /** @type {any} */ (RUNTIME_UI_SLOTS)[registration.name];
      assert.ok(contract, `${body.name} occupied ${registration.name}, which the pinned table does not know`);
      if (contract.kind === 'list') assert.equal(typeof registration.options.id, 'string');
      if (contract.kind === 'keyed') assert.equal(typeof registration.options.key, 'string');
      if (contract.kind === 'single') assert.ok(registration.options.priority < 0, `${registration.name} at priority ${registration.options.priority}`);
    }
  }
});

test('no body text reaches for a module: React arrives through the loader, everything else is a parameter', () => {
  const source = renderFrameClient();
  assert.doesNotMatch(source, /\bimport\s*[({'"]|\bfrom\s+['"]|require\(\s*['"](?!react['"])/);
  assert.doesNotMatch(source, /@deepseek-ai\/|node:/);
});

test('the registration path refuses each slot misuse by name, before the kernel can refuse it silently', () => {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const kit = createFrameKit(ctx, fakeTarget(), undefined, FRAME_VOCABULARY);
  const Nothing = () => null;
  // A list slot takes an id; a key registers nothing there.
  assert.throws(() => kit.occupy({ slot: 'conversation.input.right', key: 'x' }, Nothing), /list slot "conversation.input.right" needs an id/);
  // A keyed slot takes a key; an id registers nothing there.
  assert.throws(() => kit.occupy({ slot: 'tool.call.toolview', id: 'x' }, Nothing), /keyed slot "tool.call.toolview" needs a key/);
  // A single slot sits below the kernel's own occupant at 0.
  assert.throws(() => kit.occupy({ slot: 'sidebar' }, Nothing), /single slot "sidebar" needs a priority below 0/);
  assert.throws(() => kit.occupy({ slot: 'sidebar', priority: 0 }, Nothing), /priority below 0/);
  // A shipped key is taken over only from below it.
  assert.throws(() => kit.occupy({ slot: 'conversation.chat.node', key: 'system-prompt' }, Nothing), /held by a shipped entry/);
  // A slot nobody read the contract of is not occupied at all.
  assert.throws(() => kit.occupy({ slot: 'conversation.nonexistent', id: 'x' }, Nothing), /not in the pinned slot table/);
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.component !== 'shipped').length, 0);

  // The right shapes register.
  kit.occupy({ slot: 'conversation.input.right', id: 'evimed-hint' }, Nothing);
  kit.occupy({ slot: 'tool.call.toolview', key: 'evimed_plan' }, Nothing);
  kit.occupy({ slot: 'conversation.chat.node', key: 'system-prompt', priority: -1 }, Nothing);
  kit.occupy({ slot: 'sidebar', priority: -1 }, Nothing);
  assert.equal(ctx.slots.registrations.filter((/** @type {any} */ entry) => entry.component === Nothing).length, 4);
});

test('a refusal the kernel makes later, inside the declaring registration, costs the occupant and not the declarer', () => {
  const target = fakeTarget();
  const ctx = fakeCtx({ slots: kernelSlots() });
  ctx.slots.register = () => { throw new Error('already has a registration'); };
  const kit = createFrameKit(ctx, target, undefined, FRAME_VOCABULARY);
  assert.doesNotThrow(() => kit.occupy({ slot: 'sidebar', priority: -1 }, () => null));
  assert.ok(target.warnings.some((/** @type {any[]} */ entry) => String(entry[0]).includes('sidebar was refused by the kernel')));
});

/**
 * Load the composed client text the way the kernel's loader does.
 * @param {Record<string, any>} frame @param {Record<string, any>} [globals]
 */
function loadClient(frame, globals = {}) {
  /** @type {any} */
  let registration;
  const target = fakeTarget({ frame });
  const { React } = realReact();
  const context = { __ModuleLoader__: { load: (/** @type {any} */ value) => { registration = value; } },
    ...target, console: target.console, AbortController: globalThis.AbortController, Promise, ...globals };
  context.globalThis = context;
  vm.runInNewContext(renderFrameClient(), context);
  const plugin = registration.factory((/** @type {string} */ id) => (id === 'react' ? React : undefined));
  return { plugin, target: context };
}

test('a body the control plane switched off is skipped, and the bridge is not switchable', () => {
  assert.ok(!FRAME_SWITCHABLE_BODIES.includes('bridge'));
  const ctx = /** @type {any} */ ({ ...services(), effect: () => {}, inject: () => {}, on: () => () => {} });
  const { plugin, target } = loadClient({ off: ['shell', 'bridge'] });
  plugin.apply(ctx, {});
  // The shell's stylesheet and brand are absent; the bridge (not switchable)
  // still announced itself.
  assert.equal(target.document.head.children.filter((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes).length, 0);
  assert.ok(!ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'sidebar'));
  assert.ok(target.__EVIMED_SHELL__, 'the bridge was skipped with the shell');
});

test('a body that throws while starting is logged and the others still start', () => {
  const ctx = /** @type {any} */ ({ ...services(), effect: () => {}, inject: () => {}, on: () => () => {} });
  // A locale runtime whose every method throws: the language body logs and
  // falls back; the shell after it still brands the page.
  ctx.locale = { addLanguage() { throw new Error('boom'); }, register() { throw new Error('boom'); }, setLocale() { throw new Error('boom'); } };
  const { plugin, target } = loadClient({});
  assert.doesNotThrow(() => plugin.apply(ctx, {}));
  assert.ok(ctx.slots.registrations.some((/** @type {any} */ entry) => entry.name === 'sidebar'), 'the shell did not start after the language body failed');
  assert.ok(target.__EVIMED_SHELL__);
});

test('outside a page the control plane served, no body runs and the loader is asked for nothing', () => {
  /** @type {any} */
  let registration;
  vm.runInNewContext(renderFrameClient(), { __ModuleLoader__: { load: (/** @type {any} */ value) => { registration = value; } } });
  /** @type {string[]} */
  const required = [];
  const plugin = registration.factory((/** @type {string} */ id) => { required.push(id); return undefined; });
  assert.equal(plugin.apply({}, {}), undefined);
  assert.deepEqual(required, []);
});

test('the parts a body is built from must be named declarations', () => {
  const arrow = () => 1;
  assert.throws(() => partsSource([arrow], 'arrow'), /function declaration/);
  function named() { return 1; }
  assert.throws(() => partsSource([named], 'apply'), /declare no apply/);
  assert.equal(vm.runInNewContext(partsSource([named], 'named'))(), 1);
});

test('the pinned slot contracts and the stylesheet were read against the kernel this repository pins', async () => {
  const deps = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'));
  assert.match(String(deps.dsh?.version ?? ''), /^\d+\.\d+\.\d+/, 'deps-version.json names no dsh pin');
  // Moving the kernel pin fails here until someone re-reads the slot
  // registry and the layout the stylesheet reaches into.
  assert.equal(RUNTIME_UI_KERNEL_PIN, deps.dsh.version, `the slot table was read against ${RUNTIME_UI_KERNEL_PIN}, not the pinned kernel`);
  assert.equal(GEOMETRY_KERNEL_PIN, deps.dsh.version);
  assert.equal(FRAME_VOCABULARY.kernelPin, RUNTIME_UI_KERNEL_PIN);
});

test('the frame draws the socket tools under their contractual names', () => {
  assert.deepEqual({ ...FRAME_VOCABULARY.tools }, {
    plan: 'evimed_plan', delegate: 'evimed_delegate', submit: 'evimed_submit_deliverable',
    await: 'evimed_await', packageCheck: 'evimed_package_check', claimUpsert: 'evimed_claim_upsert',
  });
});
