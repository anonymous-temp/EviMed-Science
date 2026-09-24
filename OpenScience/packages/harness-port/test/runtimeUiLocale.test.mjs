// The product's language pack: a private-use language over the kernel's `zh`,
// selected on every boot, that rephrases a handful of strings and names one
// object one way — and leaves the document saying `zh-CN`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EVIMED_DICTIONARIES, EVIMED_DOCUMENT_LANG, EVIMED_LOCALE, apply, evimedDictionaries, inject } from '../src/runtimeUiLocale.mjs';
import { fakeCtx, fakeTarget, kitFor } from './helpers/frameFakes.mjs';

/**
 * A locale runtime shaped like the pinned one: `subscribe` listeners run in
 * subscription order on every publish, and the kernel's own document sync
 * subscribes first (it is in the locale plugin's apply) and writes the active
 * id — mapping only the exact `zh` to `zh-CN`.
 * @param {any} document
 */
function localeRuntime(document) {
  /** @type {any[]} */ const languages = [];
  /** @type {any[]} */ const dictionaries = [];
  /** @type {string[]} */ const selected = [];
  /** @type {Array<() => void>} */ const listeners = [];
  let active = 'zh';
  const publish = () => { for (const listener of [...listeners]) listener(); };
  const runtime = {
    languages, dictionaries, selected,
    addLanguage: (/** @type {any} */ input) => { languages.push(input); publish(); return () => {}; },
    register: (/** @type {string} */ ns, /** @type {string} */ id, /** @type {any} */ dict) => { dictionaries.push({ ns, id, dict }); publish(); return () => {}; },
    setLocale: (/** @type {string} */ id) => { selected.push(id); active = id; publish(); },
    getSnapshot: () => ({ active }),
    subscribe: (/** @type {() => void} */ listener) => { listeners.push(listener); return () => {}; },
  };
  // The kernel's `syncDocumentLanguage`, subscribed before any plugin of ours.
  runtime.subscribe(() => { document.documentElement.lang = active === 'zh' ? 'zh-CN' : active; });
  return runtime;
}

function fixture() {
  const target = fakeTarget();
  const locale = localeRuntime(target.document);
  const ctx = fakeCtx({ locale });
  const kit = kitFor(ctx, target, { react: false });
  return { ctx, target, locale, kit };
}

test('the language body requires only the locale runtime', () => {
  assert.deepEqual(inject, ['locale']);
});

test('the product language is a private-use pack over zh, registered and selected', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.deepEqual(f.locale.languages, [{ id: EVIMED_LOCALE, label: '中文', fallback: 'zh' }]);
  assert.equal(EVIMED_LOCALE, 'zh-x-evimed');
  assert.deepEqual(f.locale.selected, [EVIMED_LOCALE]);
  assert.deepEqual(f.locale.dictionaries.map((entry) => entry.ns), Object.keys(EVIMED_DICTIONARIES));
  for (const entry of f.locale.dictionaries) {
    assert.equal(entry.id, EVIMED_LOCALE, 'the three-argument register form, never the typed one that demands complete zh and en');
    assert.deepEqual(entry.dict, /** @type {Record<string, any>} */ (EVIMED_DICTIONARIES)[entry.ns], `${entry.ns}: the body registers a dictionary the export does not describe`);
  }
  assert.deepEqual(evimedDictionaries(), JSON.parse(JSON.stringify(EVIMED_DICTIONARIES)));
});

test('the product face is Chinese: EviMed and the names printed on keys are the only Latin words a string of the pack may carry', () => {
  for (const [ns, dict] of Object.entries(EVIMED_DICTIONARIES)) {
    for (const [key, value] of Object.entries(dict)) {
      // Interpolation names (`{count}`) are the kernel's syntax, not copy.
      const copy = value.replaceAll('EviMed', '').replace(/\b(?:Ctrl|Enter)\b/g, '').replace(/\{\w+\}/g, '');
      assert.doesNotMatch(copy, /[A-Za-z]{2,}/, `${ns}/${key} carries a Latin word: ${value}`);
    }
  }
});

test('a delegated child is called a sub-task, everywhere the kernel names it', () => {
  // Three words for one object across four namespaces (A T5 §3b): the
  // transcript's 「{count} 个 subagent」, the catalogue's 「子代理」 and the
  // `/` menu's 「子智能体」.
  assert.equal(EVIMED_DICTIONARIES.chat['message.turnProcess.subagents.one'], '{count} 个子任务');
  assert.equal(EVIMED_DICTIONARIES.chat['message.turnProcess.subagents.other'], '{count} 个子任务');
  assert.equal(EVIMED_DICTIONARIES.subagent['count.total.one'], '{count} 个子任务');
  assert.equal(EVIMED_DICTIONARIES.subagent['count.running.other'], '{count} 个子任务，正在运行');
  assert.equal(EVIMED_DICTIONARIES.subagent['tree.aria'], '子任务会话');
  assert.equal(EVIMED_DICTIONARIES.subagent['switcher.aria'], '切换子任务：{title}');
  assert.equal(EVIMED_DICTIONARIES.workspace['status.subagentsRunning.other'], '{n} 个子任务运行中');
  assert.equal(EVIMED_DICTIONARIES['slash.menu'].subagent, '子任务');
  for (const dict of Object.values(EVIMED_DICTIONARIES)) {
    for (const value of Object.values(dict)) assert.doesNotMatch(value, /子代理|子智能体|subagent/i);
  }
});

test('the strings written for a coding agent on a laptop are rephrased for a hosted research bench, and short', () => {
  assert.equal(/** @type {any} */ (EVIMED_DICTIONARIES).common, undefined, "the kernel's local-build label is drawn only by the left column this deployment removes");
  assert.equal(EVIMED_DICTIONARIES.conversation['tool.title.code'], '运行代码');
  // What to type, and nothing about the machinery.
  assert.equal(EVIMED_DICTIONARIES.conversation['placeholder.hero'], '描述你的研究问题…');
  assert.equal(EVIMED_DICTIONARIES.conversation['placeholder.default'], '继续提问…');
  assert.equal(EVIMED_DICTIONARIES.conversation['placeholder.workspace'], '正在连接…');
  assert.equal(EVIMED_DICTIONARIES.chat['message.maxTokens.hint'], '发送“继续”接着写');
  assert.doesNotMatch(EVIMED_DICTIONARIES.chat['message.maxTokens'], /token/i);
  assert.equal(EVIMED_DICTIONARIES.chat['message.failure.auth'], '服务暂时不可用，请稍后重试', 'a hosted runtime holds no key the reader could fix');
  assert.equal(EVIMED_DICTIONARIES.chat['chat.deepDiving'], 'EviMed 思考中…');
  assert.equal(EVIMED_DICTIONARIES.conversation['hero.preview'], '');
  // A retry says that it is retrying — no attempt count, no countdown.
  assert.equal(EVIMED_DICTIONARIES.chat['message.retry.status'], '{label}');
  assert.equal(EVIMED_DICTIONARIES.chat['message.retry.active'], '正在重试…');
  assert.equal(EVIMED_DICTIONARIES.chat['message.retry.scheduled'], '正在重试…');
  // The kernel's record format is not the reader's business.
  assert.doesNotMatch(EVIMED_DICTIONARIES.subagent['diagnostic.unsupported'], /版本/);
});

test('what Enter does while a run works is the send button\'s tooltip', () => {
  // `input.send.queue` is the primary button's label and tooltip while a
  // typed message waits on a running agent; Ctrl/⌘+Enter steers instead.
  assert.equal(EVIMED_DICTIONARIES.conversation['input.send.queue'], '排队发送 · Ctrl/⌘+Enter 插话');
});

test('the document says zh-CN while the pack is active, after every publish of the locale runtime', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  // The kernel wrote `zh-x-evimed` on selection; the pack, subscribed after
  // it, put `zh-CN` back.
  assert.equal(f.target.document.documentElement.lang, EVIMED_DOCUMENT_LANG);
  // A later publish (a dictionary registered by another plugin) re-runs the
  // kernel's sync first and ours after it.
  f.locale.register('other', EVIMED_LOCALE, {});
  assert.equal(f.target.document.documentElement.lang, 'zh-CN');
  // Switching to another language is left to the kernel's own mapping.
  f.locale.setLocale('en');
  assert.equal(f.target.document.documentElement.lang, 'en');
});

test('a language-pack failure falls back to the kernel zh rather than to the browser', () => {
  const f = fixture();
  f.locale.addLanguage = () => { throw new Error('duplicate id'); };
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.deepEqual(f.locale.selected, ['zh']);
});

test('a locale runtime without the documented surface is left alone', () => {
  const target = fakeTarget();
  const ctx = fakeCtx({ locale: {} });
  assert.doesNotThrow(() => apply(ctx, {}, target, undefined, kitFor(ctx, target, { react: false })));
});

test('a page the control plane did not serve keeps the kernel language', () => {
  const target = fakeTarget({ framed: false });
  const locale = localeRuntime(target.document);
  const ctx = fakeCtx({ locale });
  apply(ctx, {}, target, undefined, kitFor(ctx, target, { react: false }));
  assert.deepEqual(locale.selected, []);
  assert.deepEqual(locale.languages, []);
});
