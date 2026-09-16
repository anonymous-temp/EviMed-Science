// The hosted shell of the kernel's browser application, exercised against a
// recording fake of the two services it injects. The kernel's own brand plugin
// occupies slots the same way; what is asserted here is that this one occupies
// exactly the documented slots, selects the product's language through the
// documented locale surface, and does nothing at all outside the hosted frame.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, EVIMED_DICTIONARIES, EVIMED_LOCALE } from '../src/runtimeUiShell.mjs';

/** @param {{framed?: boolean, withReact?: boolean, localeApi?: boolean, capabilities?: any[]}} [options] */
function fixture({ framed = true, withReact = true, localeApi = true, capabilities = [] } = {}) {
  /** @type {Record<string, any>} */ const occupants = {};
  /** @type {Record<string, number>} */ const priorities = {};
  /** @type {any[]} */ const injected = [];
  /** @type {any[]} */ const languages = [];
  /** @type {any[]} */ const dictionaries = [];
  /** @type {string[]} */ const selected = [];
  /** @type {any[]} */ const effects = [];
  /** @type {any[]} */ const styles = [];
  const head = { appendChild: (/** @type {any} */ node) => styles.push(node) };
  // `any` on purpose: the shell writes `__EVIMED_SHELL__` onto its target at
  // run time, which is the seam the frame's navigation leaves through, and an
  // inferred literal type has no room for a property the code under test adds.
  /** @type {any} */
  const target = {
    __EVIMED_FRAME__: framed ? { version: 1, frameId: 'frame-a', projectId: 'project-a', shellOrigin: 'https://app.example', cwd: '/workspace', capabilities } : undefined,
    parent: {},
    document: { head, title: 'DeepSeek Harness', querySelector: () => null, createElement: () => {
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
    register: (/** @type {{name: string, priority?: number, id?: string, key?: string}} */ spec, /** @type {any} */ component) => {
      // The kernel's rule for a list slot, learned from its own refusal:
      // `list slot "conversation.input.dock" requires options.id`. `key` is
      // what the right sidebar's tab slot takes; passing it here registered
      // nothing and the dock silently did not appear.
      if (spec.name === 'conversation.input.dock' && !spec.id) throw new Error(`list slot "${spec.name}" requires options.id`);
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

test('the left column, the three brand slots and the hero workspace picker are occupied, nothing else', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(Object.keys(f.occupants).sort(), [
    'conversation.hero.brand.mark', 'conversation.hero.workspace', 'sidebar',
    'sidebar.brand.mark', 'sidebar.brand.name',
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
  // `sidebar` is the whole left column, and occupying it replaces the column
  // rather than adding to it (the layout package's own contract says so). The
  // rail is what takes its place: one control, and the mark at the foot.
  // `sidebar` is the whole left column, and occupying it replaces the column
  // rather than adding to it (the layout package's own contract says so). The
  // occupant renders nothing; the stylesheet below removes the column's width,
  // which occupying the slot does not.
  assert.equal(f.occupants.sidebar({ collapsed: false }), null);
  const sheet = f.styles.map((/** @type {any} */ node) => node.textContent).join('\n');
  // Hiding the column is not enough on its own: removing it from the grid's
  // flow shifts the conversation into the sidebar's 280 px track, so the two
  // remaining columns are pinned to the tracks they belong in.
  for (const rule of ['[class$="_sidebarCol"]{display:none', '[class$="_centerCol"]{grid-column:1 / 3', '[class$="_rightbarCol"]{grid-column:3']) {
    assert.ok(sheet.includes(rule), `missing layout rule: ${rule}`);
  }
  // Only the sidebar's drag handle is hidden. Both handles carry one class, so
  // a rule keyed on the class alone also took the right panel's resize — they
  // are told apart by position instead, and hiding all of them again would be
  // invisible in every test that only reads the class.
  assert.ok(sheet.includes('[class$="_overlayLayer"] + [class$="_handle"]{display:none'), 'the sidebar handle rule is missing');
  assert.ok(!/(^|\n)\s*'\[class\$="_handle"\]\{display:none/.test(sheet), 'every handle is hidden, including the right panel\'s resize');

  // And the right column itself is never occupied. `rightbar` is a layout slot
  // like `sidebar`: occupying it replaces the whole column, which is the thing
  // the left column had to be undone from. Content that belongs there
  // registers a tab through `sidebarRightTabs` (port: registerRightSidebarTab).
  assert.equal(f.occupants.rightbar, undefined, 'the shell occupies the right column');
});

// Not the blank-session hero: its seat is `conversation.hero.agentPreset`,
// declared by `ui-agent-preset`, which this deployment disables — a disabled
// row declares no slot, so occupying it registered nothing and rendered
// nothing, silently. Measured on the deployed build before this moved.
test('the composer dock offers the capability cards the control plane handed the frame', () => {
  const capabilities = [
    { id: 'meta-analysis', title: '自动化 Meta 分析', category: '证据综合', brief: '请以「自动化 Meta 分析」能力完成以下任务：\n\n…' },
    { id: 'broken', title: '', category: '', brief: '' },
  ];
  const f = fixture({ capabilities });
  apply(f.ctx, {}, f.target, f.require);
  const dock = f.occupants['conversation.input.dock'];
  assert.ok(dock, 'the dock is occupied when there are cards to show');
  assert.equal(f.occupants['conversation.hero.agentPreset'], undefined);

  // The fixture's `createElement` keeps children as its rest arguments, so a
  // mapped list arrives as one nested array.
  const cards = dock({}).children[1].children.flat();
  // A malformed entry costs that entry, never the dock.
  assert.equal(cards.length, 1, 'the entry with no title or brief is dropped');
  assert.match(JSON.stringify(cards), /自动化 Meta 分析/);

  // The click leaves through the shell carrying the brief. Writing the draft
  // here would not work from the hero, where there is no session yet.
  /** @type {any[]} */ const sent = [];
  f.target.__EVIMED_SHELL__ = { navigate: (/** @type {any} */ ...args) => sent.push(args) };
  cards[0].props.onClick();
  assert.deepEqual(sent, [['new-task', capabilities[0].brief]]);

  // Without the bridge there is no channel, and a click must still not throw:
  // the conversation is what this frame is for.
  delete f.target.__EVIMED_SHELL__;
  assert.doesNotThrow(() => cards[0].props.onClick());
});

test('a deployment that sent no cards leaves the dock alone', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, f.require);
  assert.equal(f.occupants['conversation.input.dock'], undefined);
  assert.ok(!f.injected.includes('conversation.input.dock'));
});

test('a slot the kernel refuses costs that slot, never the bridge sharing the bundle', () => {
  const f = fixture();
  f.ctx.slots.register = (spec, component) => {
    if (spec.name === 'conversation.hero.workspace') throw new Error('single slot already has a registration');
    f.occupants[spec.name] = component; return () => {};
  };
  assert.doesNotThrow(() => apply(f.ctx, {}, f.target, f.require));
  assert.deepEqual(Object.keys(f.occupants).sort(), ['conversation.hero.brand.mark', 'sidebar', 'sidebar.brand.mark', 'sidebar.brand.name']);
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
  assert.deepEqual(Object.keys(f.occupants).length, 5, 'the brand does not depend on the language');
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
  // One stylesheet, and exactly one. The shell appends a `<link rel="icon">`
  // to the same head, so the sheet is selected rather than assumed to be the
  // only thing there.
  const sheets = f.styles.filter((/** @type {any} */ node) => 'data-evimed-shell' in (node.attributes ?? {}));
  assert.equal(sheets.length, 1);
  const css = sheets[0].textContent;
  assert.match(css, /aria-label="Add workspace"/);
  assert.match(css, /aria-label="添加工作区"/);
  assert.match(css, /_previewBadge"\]:empty/);
  // The hero workspace chip: the kernel renders the button itself and only
  // its popup through the slot the shell occupies, so withdrawing the popup
  // left a button that opens nothing.
  assert.match(css, /_heroWorkspaceRow"\]\{display:none/);
  assert.equal(sheets[0].attributes['data-evimed-shell'], '');
});

test('a page the control plane did not serve is left alone', () => {
  const f = fixture({ framed: false });
  apply(f.ctx, {}, f.target, f.require);
  assert.deepEqual(Object.keys(f.occupants), []);
  assert.deepEqual(f.selected, []);
  assert.equal(f.styles.length, 0);
  assert.equal(f.target.document.title, 'DeepSeek Harness', 'a page that is not ours keeps its own name');
});

test('a page the control plane served is branded whether or not it is embedded', () => {
  // The guard used to also require `parent !== self`, so opening the frame's
  // address in a tab got the kernel unbranded: its whale in the sidebar, its
  // own title, and the swimming fish on an empty conversation. One condition,
  // one uncovered path (2026-09-16 review, §4.1 item 8).
  const own = fixture();
  own.target.parent = own.target;
  apply(own.ctx, {}, own.target, own.require);
  assert.ok(Object.keys(own.occupants).length > 0, 'the brand slots are occupied at the top level too');
  assert.equal(own.target.document.title, 'EviMed 研究会话');
  const icon = own.styles.find((/** @type {any} */ node) => node.attributes?.rel === 'icon');
  assert.ok(icon, "the document's icon is replaced, not left as the kernel's whale");
  assert.match(String(icon.attributes.href), /^data:image\/svg\+xml,/);
});
