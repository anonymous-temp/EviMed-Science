// The hosted shell of the kernel's browser application, exercised against a
// recording fake of the two services it injects. The kernel's own brand plugin
// occupies slots the same way; what is asserted here is that this one occupies
// exactly the documented slots, selects the product's language through the
// documented locale surface, and does nothing at all outside the hosted frame.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, EVIMED_DICTIONARIES, EVIMED_LOCALE } from '../src/runtimeUiShell.mjs';

function fixture({ framed = true, withReact = true, localeApi = true } = {}) {
  /** @type {Record<string, any>} */ const occupants = {};
  /** @type {Record<string, number>} */ const priorities = {};
  /** @type {any[]} */ const injected = [];
  /** @type {any[]} */ const languages = [];
  /** @type {any[]} */ const dictionaries = [];
  /** @type {string[]} */ const selected = [];
  /** @type {any[]} */ const effects = [];
  /** @type {any[]} */ const styles = [];
  const head = { appendChild: (/** @type {any} */ node) => styles.push(node) };
  const target = {
    __EVIMED_FRAME__: framed ? { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', cwd: '/workspace' } : undefined,
    parent: {},
    document: { head, createElement: () => {
      /** @type {{attributes: Record<string, string>, textContent: string, setAttribute: (k: string, v: string) => void, remove: () => void}} */
      const node = { attributes: {}, textContent: '', setAttribute(k, v) { node.attributes[k] = v; }, remove() {} };
      return node;
    } },
    console: { warn: () => {} },
  };
  const slots = {
    inject: (/** @type {string} */ name, /** @type {any} */ setup) => {
      injected.push(name);
      const result = setup();
      if (result && typeof result.next === 'function') for (const _ of result) { /* drain the registration set */ }
      return () => {};
    },
    register: (/** @type {{name: string, priority?: number}} */ spec, /** @type {any} */ component) => {
      // The kernel's rule: a single slot renders its lowest priority and
      // refuses a second registration at an occupied one. The kernel's own
      // picker holds `conversation.hero.workspace` at 0.
      if (spec.name === 'conversation.hero.workspace' && (spec.priority ?? 0) === 0) throw new Error(`single slot "${spec.name}" already has a registration at priority 0`);
      occupants[spec.name] = component; priorities[spec.name] = spec.priority ?? 0; return () => {};
    },
  };
  const locale = localeApi ? {
    addLanguage: (/** @type {any} */ input) => { languages.push(input); return () => {}; },
    register: (/** @type {string} */ ns, /** @type {string} */ id, /** @type {any} */ dict) => { dictionaries.push({ ns, id, dict }); return () => {}; },
    setLocale: (/** @type {string} */ id) => { selected.push(id); },
  } : {};
  const ctx = { slots, locale, effect: (/** @type {any} */ setup, /** @type {string} */ label) => { effects.push(label); return setup(); } };
  const require = withReact ? (/** @type {string} */ id) => (id === 'react' ? { createElement: (/** @type {string} */ type, /** @type {any} */ props, /** @type {any[]} */ ...children) => ({ type, props, children }) } : undefined) : undefined;
  return { ctx, target, require, occupants, priorities, injected, languages, dictionaries, selected, effects, styles };
}

test('the shell injects exactly the slot registry and the locale runtime', () => {
  assert.deepEqual(inject, ['slots', 'locale']);
});

test('the three brand slots and the hero workspace picker are occupied, nothing else', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(Object.keys(f.occupants).sort(), [
    'conversation.hero.brand.mark', 'conversation.hero.workspace', 'sidebar.brand.mark', 'sidebar.brand.name',
  ]);
  // The mark honours the size its host surface asks for, as the kernel's own
  // mark does, and names the product for assistive technology.
  const mark = f.occupants['sidebar.brand.mark']({ size: 34, className: 'fish' });
  assert.equal(mark.type, 'svg');
  assert.equal(mark.props.width, 34);
  assert.equal(mark.props['aria-label'], 'EviMed');
  assert.equal(mark.props.className, 'fish');
  assert.equal(f.occupants['sidebar.brand.name']({}).children[0], 'EviMed');
  // An occupant that renders nothing is how a popup slot is withdrawn.
  assert.equal(f.occupants['conversation.hero.workspace']({}), null);
  // Every occupant sits below the kernel's default priority: single slots
  // render the lowest, and a collision at 0 fails the whole loader entry.
  for (const [name, priority] of Object.entries(f.priorities)) assert.ok(priority < 0, `${name} registered at ${priority}`);
});

test('a slot the kernel refuses costs that slot, never the bridge sharing the bundle', () => {
  const f = fixture();
  f.ctx.slots.register = (spec, component) => {
    if (spec.name === 'conversation.hero.workspace') throw new Error('single slot already has a registration');
    f.occupants[spec.name] = component; return () => {};
  };
  assert.doesNotThrow(() => apply(f.ctx, {}, f.target, f.require));
  assert.deepEqual(Object.keys(f.occupants).sort(), ['conversation.hero.brand.mark', 'sidebar.brand.mark', 'sidebar.brand.name']);
  assert.deepEqual(f.selected, [EVIMED_LOCALE], 'the language still applies after a slot failure');
});

test('the product language is a private-use pack over zh, and it is selected', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(f.languages, [{ id: EVIMED_LOCALE, label: '中文', fallback: 'zh' }]);
  assert.equal(EVIMED_LOCALE, 'zh-x-evimed');
  assert.deepEqual(f.selected, [EVIMED_LOCALE]);
  // The pack is small and rephrases only what the kernel says about
  // "building"; everything else must fall through to the kernel's own zh.
  assert.deepEqual(f.dictionaries.map((entry) => entry.ns), Object.keys(EVIMED_DICTIONARIES));
  for (const entry of f.dictionaries) {
    assert.equal(entry.id, EVIMED_LOCALE);
    assert.deepEqual(entry.dict, /** @type {Record<string, any>} */ (EVIMED_DICTIONARIES)[entry.ns], `${entry.ns}: the body registers a dictionary the export does not describe`);
    for (const value of Object.values(entry.dict)) assert.doesNotMatch(value, /[A-Za-z]{3,}/, 'the product face is Chinese');
  }
  assert.ok(Object.keys(EVIMED_DICTIONARIES.conversation).length <= 8, 'the pack should stay a handful of strings');
});

test('a locale runtime without the documented surface still gets zh, not a crash', () => {
  const f = fixture({ localeApi: false });
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(Object.keys(f.occupants).length, 4, 'the brand does not depend on the language');
});

test('a language-pack failure falls back to the kernel zh rather than to the browser', () => {
  const f = fixture();
  f.ctx.locale.addLanguage = () => { throw new Error('duplicate id'); };
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(f.selected, ['zh']);
});

test('without React the brand is left to the kernel fallback and the language still applies', () => {
  const f = fixture({ withReact: false });
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(Object.keys(f.occupants), []);
  assert.deepEqual(f.selected, [EVIMED_LOCALE]);
});

test('the hidden controls are named by their accessible names in both shipped languages', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, f.require);
  assert.equal(f.styles.length, 1);
  const css = f.styles[0].textContent;
  assert.match(css, /aria-label="Add workspace"/);
  assert.match(css, /aria-label="添加工作区"/);
  assert.match(css, /_previewBadge"\]:empty/);
  assert.equal(f.styles[0].attributes['data-evimed-shell'], '');
});

test('outside the hosted frame the shell does nothing', () => {
  const f = fixture({ framed: false });
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(Object.keys(f.occupants), []);
  assert.deepEqual(f.selected, []);
  assert.equal(f.styles.length, 0);
  const own = fixture();
  own.target.parent = own.target;
  apply(own.ctx, {}, own.target, own.require);
  assert.deepEqual(Object.keys(own.occupants), []);
});
