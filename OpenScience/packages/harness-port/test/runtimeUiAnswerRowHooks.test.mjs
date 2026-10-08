/**
 * E-11 against the actual pinned slot registry and renderer (the kernel's own
 * `ui-renderer`, loaded through its public module factory), not a fake of them.
 *
 * `ui-chat` registers its `assistant-step` row with
 * `inject: () => ({ hooks: { presentation } })`; the renderer hands a render the
 * props of the entry that WINS, the lowest priority, and builds `usePresentation`
 * from THAT entry's `inject`. A takeover registered without it won, drew the
 * kernel's row with props that lack the hook, and the row threw
 * `usePresentation is not a function` (booted 0.1.7-rc.2, 2026-10-08) — after
 * which the renderer retired the takeover. The first test is the shipped shape;
 * the second is the old registration, held as the control: it must fail here, or
 * the first proves nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { nativeUiAssembly } from './helpers/nativeUiAssembly.mjs';

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const slot = 'conversation.chat.node';

/** @param {any} t @param {(ctx: any, kit: any, React: any) => void} takeOver */
async function answerRow(t, takeOver) {
  const moduleId = 'js' + 'dom';
  const { JSDOM } = require(moduleId);
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
  const { ctx, React } = await nativeUiAssembly(dom);
  const { createFrameKit } = await import('../src/runtimeUiKit.mjs');
  const { FRAME_VOCABULARY } = await import('../src/runtimeUiFrame.mjs');
  const current = /** @type {any} */ (globalThis);
  const old = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map((name) => [name, Object.getOwnPropertyDescriptor(current, name)]));
  current.window = dom.window;
  current.document = dom.window.document;
  current.IS_REACT_ACT_ENVIRONMENT = true;
  const source = (/** @type {any} */ value) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const binding = { key: 'actual-session', ctx, hooks: {}, keyedHooks: {}, props: { sessionId: 'actual-session' } };
  ctx.slots.provideRoot({ props: {} });
  ctx.slots.installScope('session', { current: source(binding), bindingSource: () => source(binding), renderArea: (/** @type {any} */ _binding, /** @type {any} */ props) => props.children });
  ctx.slots.installLocale({ ...source({ revision: 0 }), bind: () => (/** @type {string} */ key) => key });
  const h = React.createElement;
  const node = { kind: 'assistant-step', data: { finalNode: { seq: 7 } }, location: { kind: 'step', turn: { turn: 1, start: { time: 1 } } } };
  ctx.slots.register({ name: 'root', children: { [slot]: { kind: 'keyed', scope: 'session' } } },
    (/** @type {any} */ props) => h(props.SessionProvider, null, props.renderSlot(slot, { node }, { entryKey: 'assistant-step' })));
  // The kernel's row, registered as `ui-chat` registers it: with the policy hook it injects.
  /** @param {any} props */
  function KernelAnswer(props) {
    assert.equal(typeof props.usePresentation, 'function', 'usePresentation is not a function');
    return h('p', { 'data-kernel-answer': '' }, `answer, work details ${props.usePresentation((/** @type {any} */ policy) => policy.workDetails)}`);
  }
  ctx.slots.register({ name: slot, key: 'assistant-step', locale: 'chat', inject: () => ({ hooks: { presentation: source({ workDetails: 'folded' }) } }) }, KernelAnswer);
  /** @type {any[]} */
  const crashes = [];
  ctx.slots.onEntryError((/** @type {string} */ key, /** @type {any} */ registration, /** @type {any} */ error, /** @type {any} */ info) => crashes.push({ key, priority: registration?.options?.priority ?? 0, message: String(error?.message ?? error), retired: info?.abdicated }));
  const target = { __EVIMED_FRAME__: { version: 1 }, console: { warn() {}, error() {} } };
  const kit = createFrameKit(ctx, target, () => React, FRAME_VOCABULARY);
  takeOver(ctx, kit, React);
  /** @type {any} */ let unmount;
  t.after(async () => {
    await React.act(async () => unmount?.());
    await ctx.fiber.dispose();
    dom.window.close();
    for (const [name, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(current, name, descriptor); else delete current[name]; }
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await React.act(async () => { unmount = ctx.uiRenderer.mount(dom.window.document.getElementById('root')); await new Promise((resolve) => setTimeout(resolve, 20)); });
  } finally { console.error = originalError; }
  return { ctx, document: dom.window.document, crashes };
}

test('the bodies that take the answer row over draw the kernel\'s row with its own hooks, on the actual registry', async (t) => {
  const { apply: applyChecks } = await import('../src/runtimeUiReplyChecks.mjs');
  const { apply: applyPanels } = await import('../src/runtimeUiPanels.mjs');
  const { apply: applySources } = await import('../src/runtimeUiSources.mjs');
  const f = await answerRow(t, (ctx, kit) => {
    const target = { __EVIMED_FRAME__: { version: 1 }, console: { warn() {}, error() {} } };
    for (const apply of [applyChecks, applyPanels, applySources]) apply(ctx, {}, target, undefined, kit);
  });
  assert.deepEqual(f.crashes, [], 'no entry crashed, so none was retired');
  assert.equal(f.document.querySelector('[data-kernel-answer]')?.textContent, 'answer, work details folded', 'the kernel\'s row rendered with the hook its own registration injects');
  // All three takeovers are still registered below the kernel's entry.
  const priorities = f.ctx.slots.entries(slot).filter((/** @type {any} */ entry) => entry.options.key === 'assistant-step').map((/** @type {any} */ entry) => entry.options.priority ?? 0).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b);
  assert.deepEqual(priorities, [-3, -2, -1, 0]);
});

test('control: a takeover registered without the shipped entry\'s inject crashes the way R12 did', async (t) => {
  const f = await answerRow(t, (_ctx, kit, React) => {
    const h = React.createElement;
    /** @param {any} props */
    function Takeover(props) {
      const Shadowed = kit.shadowed(slot, 'assistant-step', Takeover);
      return Shadowed ? h(Shadowed, props) : null;
    }
    kit.occupy({ slot, key: 'assistant-step', priority: -1, locale: 'chat' }, Takeover);
  });
  assert.ok(f.crashes.length >= 1, 'the old registration is the failure this file exists to catch');
  assert.match(f.crashes[0].message, /usePresentation is not a function/);
  assert.equal(f.crashes[0].priority, -1, 'it was the takeover that was retired');
});
