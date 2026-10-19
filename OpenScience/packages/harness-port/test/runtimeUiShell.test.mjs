// The hosted shell body — brand, left column, document identity, stylesheet —
// exercised against a slot registry that refuses what the pinned kernel
// refuses. What is asserted is that it occupies exactly the documented slots,
// below the kernel's own occupants, and does nothing outside a page the
// control plane served.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { EVIMED_FAVICON, GEOMETRY_KERNEL_PIN, apply, inject, shellStylesheet } from '../src/runtimeUiShell.mjs';
import { fakeCtx, fakeTarget, kernelSlots, kitFor, renderStatic } from './helpers/frameFakes.mjs';

/** @param {{ framed?: boolean, react?: boolean, embedded?: boolean }} [options] */
function fixture({ framed = true, react = true, embedded = true } = {}) {
  const ctx = fakeCtx({ slots: kernelSlots() });
  const target = fakeTarget({ framed, embedded });
  const kit = kitFor(ctx, target, { react });
  /** @returns {Record<string, any>} */
  const occupants = () => Object.fromEntries(ctx.slots.registrations
    .filter((/** @type {any} */ entry) => entry.component !== 'shipped')
    .map((/** @type {any} */ entry) => [entry.name, entry]));
  return { ctx, target, kit, occupants };
}

test('the shell requires only the slot registry', () => {
  assert.deepEqual(inject, ['slots']);
});

test('the left column, the three brand slots and the hero workspace picker are occupied below the kernel, nothing else', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  const occupants = f.occupants();
  assert.deepEqual(Object.keys(occupants).sort(), [
    'conversation.hero.brand.mark', 'conversation.hero.workspace', 'sidebar', 'sidebar.brand.mark', 'sidebar.brand.name',
  ]);
  // The draft's attachment strip is the kernel's own: occupied by nothing, it
  // hid every attached file once uploads were allowed (2026-09-22).
  assert.equal(occupants['conversation.input.attachments'], undefined);
  for (const entry of Object.values(occupants)) assert.ok(entry.options.priority < 0, `${entry.name} sits at or above the kernel's own occupant`);
  // The mark honours the size its host asks for and names the product.
  const mark = renderStatic(occupants['sidebar.brand.mark'].component, { size: 34, className: 'fish' });
  assert.match(mark, /width="34"/);
  assert.match(mark, /aria-label="EviMed"/);
  assert.match(mark, /class="fish"/);
  assert.match(mark, /var\(--dsw-alias-state-business-primary/, 'the mark follows the theme layer rather than a literal colour');
  // Not the deepseek ramp: under direction A its 500 step is the working line's grey.
  assert.doesNotMatch(mark, /deepseek-500/);
  assert.equal(renderStatic(occupants['sidebar.brand.name'].component), '<span style="font-weight:600">EviMed</span>');
  // An occupant that renders nothing is how a popup slot and a column are withdrawn.
  assert.equal(renderStatic(occupants['conversation.hero.workspace'].component), '');
  assert.equal(renderStatic(occupants.sidebar.component, { collapsed: false }), '');
  // The right column itself is never occupied: content there registers a tab.
  assert.equal(occupants.rightbar, undefined);
});

test('the stylesheet removes the left column, keeps the right panel resizable, and never scrolls the conversation sideways', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  const sheets = f.target.document.head.children.filter((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes);
  assert.equal(sheets.length, 1);
  const css = sheets[0].textContent;
  for (const rule of ['[class$="_sidebarCol"]{display:none', '[class$="_centerCol"]{grid-column:1 / 3', '[class$="_rightbarCol"]{grid-column:3']) {
    assert.ok(css.includes(rule), `missing layout rule: ${rule}`);
  }
  // Only the sidebar's handle is hidden; both carry one class.
  assert.ok(css.includes('[class$="_overlayLayer"] + [class$="_handle"]{display:none'));
  assert.doesNotMatch(css, /(^|\n)\[class\$="_handle"\]\{display:none/);
  // The conversation's scroll body holds to vertical scrolling, and the
  // transcript clips its own sideways overflow without becoming a scroll
  // container (the sticky rail must stay attached to the real one).
  assert.ok(css.includes('[data-conversation-scroll]{overflow-x:hidden'));
  assert.ok(css.includes('[class$="_scroll"]:has(> [data-chat-flow]){overflow-x:clip'));
  // Hidden controls are named by their accessible names in both shipped languages.
  assert.match(css, /aria-label="Add workspace"/);
  // The composer's paperclip is the kernel's own and is left visible: files
  // attach through the frame's upload carrier (2026-09-22).
  assert.doesNotMatch(css, /添加附件|Add attachment/, 'the paperclip is not hidden');
  // One hosted permission preset: the access-mode chip chooses nothing.
  assert.ok(css.includes('button[aria-label^="访问模式"],button[aria-label^="Access mode"]{display:none'));
  // The reading width is the kernel's formula, not a width a stray drag set.
  // Pinned on the element that defines the variable, found by the kernel's
  // own data attribute; the embedded body keeps its narrower formula.
  assert.ok(css.includes('[data-conversation-content]:not([class*="_embeddedBody"]){--dsh-chat-content-width:clamp(680px,calc(var(--dsh-conversation-column-width,0px) * .64),920px) !important}'));
  // No rule names a CSS-module hash: those change with every client build.
  // A suffix (`[class$="_x"]`) or substring (`[class*="_x"]`) of a module's
  // local name is what the kernel keeps; `.<6 chars>_name` is a build's.
  assert.doesNotMatch(css, /\.[A-Za-z0-9]{6}_[A-Za-z]/, 'a selector names a hashed class');
  assert.match(css, /aria-label="添加工作区"/);
  assert.match(css, /_previewBadge"\]:empty/);
  // The hero's workspace chip is hidden as a button — not the whole row, whose
  // second seat is where the role cards sit — and not the composer's editable,
  // which carries the same label while it waits for a workspace.
  assert.match(css, /button\[aria-label="选择工作区"\],button\[aria-label="Choose workspace"\]\{display:none/);
  assert.doesNotMatch(css, /_heroWorkspaceRow/);
  assert.equal(sheets[0].attributes['data-evimed-kernel'], GEOMETRY_KERNEL_PIN);
  assert.ok(shellStylesheet(GEOMETRY_KERNEL_PIN).startsWith(`/* evimed-shell: selectors read against dsh-client ${GEOMETRY_KERNEL_PIN} */`));
});

test("the kernel's line about the host having no desktop is hidden, and the retry row of a failed presented-files host is not", () => {
  const css = shellStylesheet(GEOMETRY_KERNEL_PIN);
  assert.ok(css.includes('span[class$="_hostStatus"]{display:none !important}'), "the line 「此主机没有可用的桌面…」 is a span; the failure row is a div with a button");
});

test("operators can use native kernel statistics while ordinary reader chrome stays compact", () => {
  const css = shellStylesheet(GEOMETRY_KERNEL_PIN);
  // The session statistics under the composer, by their stable data attributes: the 0.2.0 row and each 0.2.1 pill
  // (`span[data-composer-stat="activity"|"usage"]`, read off a live 0.2.1-rc.2 frame).
  assert.ok(css.includes('[data-composer-stats],[data-composer-stat]{display:none !important}'));
  // The footer's usage and duration pills are its only dialog triggers; the
  // copy and branch buttons open none, and the clock is a plain span.
  assert.ok(css.includes('[data-turn-tail] span:has(> button[aria-haspopup="dialog"]){display:none !important}'));
  assert.doesNotMatch(css, /\[data-turn-tail\]\{display:none|aria-label="复制"|aria-label="在新对话中分支"/, 'the footer itself stays');
  // A tool row that renders nothing leaves no gap. The path is the renderer's
  // own: a flow item holds the chat-node outlet anchor, the call row, and the
  // tool-view outlet anchor (both anchors `display:contents`); a call with
  // sub-calls keeps its row.
  assert.ok(css.includes('[data-chat-flow-kind="tool-call"]:has(> [data-slot="conversation.chat.node"] > [data-chat-call-id] > [data-slot="tool.call.toolview"]:only-child:empty){display:none !important}'));
  // A row the researcher's transcript draws nothing for leaves no band either:
  // the flow item is hidden when its chat-node outlet anchor holds nothing, and
  // only for the three kinds `runtimeUiTranscript.mjs` takes over.
  assert.ok(css.includes(':is([data-chat-flow-kind="unknown"],[data-chat-flow-kind="system-prompt"],[data-chat-flow-kind="context"]):has(> [data-slot="conversation.chat.node"]:empty){display:none !important}'));
  assert.doesNotMatch(css, /\[data-chat-flow-kind="(?:assistant-step|user|compaction)"\]/, 'a row the reader is meant to see is never hidden by shape');
  // The host supplies the existing operator flag; this is presentation only.
  const operator = fixture();
  operator.target.__EVIMED_FRAME__.operator = true;
  const kit = kitFor(operator.ctx, operator.target);
  apply(operator.ctx, {}, operator.target, undefined, kit);
  const sheet = operator.target.document.head.children.find((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes);
  assert.ok(!sheet.textContent.includes('[data-composer-stat]'));
  assert.ok(!sheet.textContent.includes('[data-turn-tail] span:has(> button[aria-haspopup="dialog"]){display:none !important}'));
});

test('the context ring goes with the session statistics for a researcher, and an operator keeps both', () => {
  const ring = '[class$="_dock"] > span:has(> button[aria-haspopup="dialog"][aria-label^="上下文已用"])';
  const ringEnglish = '[class$="_dock"] > span:has(> button[aria-haspopup="dialog"][aria-label$="of context used"])';
  const researcher = shellStylesheet(GEOMETRY_KERNEL_PIN);
  const operator = shellStylesheet(GEOMETRY_KERNEL_PIN, true);
  // The ring is the kernel's, outside any slot: found by its stable button
  // (a dialog trigger) and the name the locale key `context.aria` gives it, in
  // `zh` (which the product's pack falls back to) and in `en`. The wrapper goes,
  // so the row keeps no gap.
  assert.ok(researcher.includes(ring) && researcher.includes(ringEnglish));
  // 0.2.1 draws the ring inside the dock slot's own outlet, so it is also found anywhere under the kernel's dock marker.
  const nested = '[data-composer-dock] span:has(> button[aria-haspopup="dialog"][aria-label^="上下文已用"])';
  const nestedEnglish = '[data-composer-dock] span:has(> button[aria-haspopup="dialog"][aria-label$="of context used"])';
  assert.ok(researcher.includes(`${ring},${ringEnglish},${nested},${nestedEnglish}{display:none !important}`));
  assert.ok(!operator.includes('上下文已用') && !operator.includes('of context used'), 'an operator keeps the ring beside the statistics');
  assert.ok(!operator.includes('[data-composer-stat]'));
  // Never the whole dock, which the kernel fills with other things, and never by a hashed class.
  assert.doesNotMatch(researcher, /_dock"\]\{display:none/);
  assert.doesNotMatch(researcher, /\.[A-Za-z0-9]{6}_[A-Za-z]/);
});

test('the composer keeps at least 16 px, or the device inset when that is larger, under its card', () => {
  // E-17: the kernel's own `.root{padding:0 16px 4px}` is all there was (measured
  // on 0.1.7-rc.2: 4 px under the lowest control), and the shell added none.
  for (const css of [shellStylesheet(GEOMETRY_KERNEL_PIN), shellStylesheet(GEOMETRY_KERNEL_PIN, true)]) {
    const rule = css.split('\n').find((line) => line.includes('padding-bottom:max(16px,env(safe-area-inset-bottom))'));
    assert.ok(rule, 'one placement rule, in the shell stylesheet');
    // The composer of a conversation: the root that holds the card and the dock row; never the hero composer, which is centred.
    assert.ok(rule.startsWith('[class$="_root"]:not([class*="_hero"]):has(> [class$="_card"] ~ [class$="_dock"]){'));
    assert.ok(rule.endsWith('!important}'));
    // Suffix classes and stable attributes only: the kernel's hashes are not ours.
    assert.doesNotMatch(rule, /\.[A-Za-z0-9]{6}_[A-Za-z]/);
  }
  assert.equal(shellStylesheet(GEOMETRY_KERNEL_PIN).split('\n').filter((line) => line.includes('safe-area-inset-bottom')).length, 1, 'stated once');
});

test('a slot the kernel refuses costs that slot, never the rest of the body', () => {
  const f = fixture();
  const register = f.ctx.slots.register;
  f.ctx.slots.register = (/** @type {any} */ options, /** @type {any} */ component) => {
    if (options.name === 'conversation.hero.workspace') throw new Error('single slot already has a registration');
    return register(options, component);
  };
  assert.doesNotThrow(() => apply(f.ctx, {}, f.target, undefined, f.kit));
  assert.deepEqual(Object.keys(f.occupants()).sort(), ['conversation.hero.brand.mark', 'sidebar', 'sidebar.brand.mark', 'sidebar.brand.name']);
});

test('without React the brand is left to the kernel fallback and the stylesheet still applies', () => {
  const f = fixture({ react: false });
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.deepEqual(Object.keys(f.occupants()), []);
  assert.equal(f.target.document.head.children.filter((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes).length, 1);
});

test('a page the control plane did not serve is left alone', () => {
  const f = fixture({ framed: false });
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.deepEqual(Object.keys(f.occupants()), []);
  assert.equal(f.target.document.head.children.length, 0);
  assert.equal(f.target.document.title, 'DeepSeek Harness', 'a page that is not ours keeps its own name');
});

test('a page the control plane served is branded whether or not it is embedded', () => {
  // The guard used to also require `parent !== self`, so opening the frame's
  // address in a tab got the kernel unbranded (2026-09-16 review, §4.1 item 8).
  const f = fixture({ embedded: false });
  apply(f.ctx, {}, f.target, undefined, f.kit);
  assert.ok(Object.keys(f.occupants()).length > 0);
  assert.equal(f.target.document.title, 'EviMed 对话');
  const icon = f.target.document.head.children.find((/** @type {any} */ node) => node.attributes?.rel === 'icon');
  assert.ok(icon, "the document's icon is replaced, not left as the kernel's whale");
  assert.equal(icon.attributes.href, EVIMED_FAVICON);
  // The EviMed molecule in brand blue (spec §3.2); the retired teal plus is gone.
  assert.match(EVIMED_FAVICON, /^data:image\/svg\+xml,.*fill='%230a5dc1'/, 'the icon carries the brand blue');
  assert.match(EVIMED_FAVICON, /d='M25\.90815,23\.256664C/, 'the icon is the molecule mark');
  assert.doesNotMatch(EVIMED_FAVICON, /00756b|63c5b9/i, 'the retired teal is gone');
  // Well-formed once decoded: one svg with one path.
  const decoded = decodeURIComponent(EVIMED_FAVICON.slice('data:image/svg+xml,'.length));
  assert.match(decoded, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 32 32'><path [^<>]+\/><\/svg>$/);
});

test('unloading the body removes its stylesheet', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  f.ctx.dispose();
  assert.equal(f.target.document.head.children.filter((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes).length, 0);
});

// R19.2 (found by the integrated acceptance of 2026-10-17 on a real frame at 390 px): three surfaces belong to bundles installed
// beside the kernel and no slot or locale key reaches them, so the shell's stylesheet shapes them; what they draw is recorded
// in fixtures/pluginSurfaces.json, and runtimeUiShell.chromium.test.mjs lays the sheet over it in a real browser.
const surfaces = JSON.parse(readFileSync(new URL('./fixtures/pluginSurfaces.json', import.meta.url), 'utf8'));

test('the Mermaid toolbars keep every label on one line and wrap as a whole, in the card and in the full-screen viewer', () => {
  const css = shellStylesheet(GEOMETRY_KERNEL_PIN);
  assert.ok(css.includes('.dsh-mmd-badge,.dsh-mmd-btn,.dsh-mmd-viewer-title{white-space:nowrap}'));
  assert.ok(css.includes('.dsh-mmd-bar,.dsh-mmd-viewer-bar{flex-wrap:wrap;row-gap:4px}'));
  assert.ok(css.includes('@media (max-width:480px){'), 'the compact padding is a property of a narrow frame, not of the bundle');
  // Every class the rules name is one the bundle draws, in its markup and its own sheet: a renamed class is a rule that matches nothing.
  const drawn = surfaces.mermaid.html + surfaces.mermaid.viewerHtml;
  for (const name of ['dsh-mmd-badge', 'dsh-mmd-btn', 'dsh-mmd-viewer-title', 'dsh-mmd-bar', 'dsh-mmd-viewer-bar', 'dsh-mmd-action-slot']) {
    assert.ok(drawn.includes(`class="${name}"`) || drawn.includes(` ${name}"`) || drawn.includes(`${name} `), `${name} is drawn by the bundle`);
    assert.ok(css.includes(`.${name}`), `${name} is shaped`);
    assert.ok(surfaces.mermaid.css.includes(`.${name}`), `${name} is in the bundle's own sheet`);
  }
  // The bundle's own sheet sets no white-space on a label and no wrapping on its bars: the rules fill a gap, they override nothing.
  assert.doesNotMatch(surfaces.mermaid.css, /\.dsh-mmd-(?:badge|btn|viewer-title|bar|viewer-bar)\{[^}]*(?:white-space|flex-wrap)/);
});

test("LoopX's goal bar gets the lower edge it was drawn without, and the dock's gap separates it from the composer card", () => {
  const css = shellStylesheet(GEOMETRY_KERNEL_PIN);
  const dock = '[data-slot="conversation.input.dock"] > [class$="_dock"]:has(> section[aria-busy])';
  assert.ok(css.includes(`${dock}{margin-bottom:0}`), 'the bundle tucks the dock three pixels under the card with a negative margin');
  assert.ok(css.includes('[data-slot="conversation.input.dock"] > [class$="_dock"] > section[aria-busy]{border-bottom:1px solid var(--color-border,var(--dsw-alias-border-l1));border-radius:12px}'));
  // Found by structure and a suffix: the bundle's hash is not ours (and a hashed class is a rule nobody can read).
  assert.doesNotMatch(css, /_xPytW/);
  // What the bundle draws: one dock holding one section that carries `aria-busy`, with the negative margin and the open lower edge.
  assert.match(surfaces.goalbar.html, /^<div class="_xPytW_dock"><section class="_xPytW_panel"[^>]* aria-busy=/);
  assert.match(surfaces.goalbar.css, /\._xPytW_dock\{[^}]*margin:0 auto calc\(0px - var\(--dsh-composer-stack-gap,0px\) - 3px\)/);
  assert.match(surfaces.goalbar.css, /\._xPytW_panel\{[^}]*border-bottom:0/);
});

test("the `/` menu's skill rows show their name alone; the commands' own Chinese lines stay", () => {
  const css = shellStylesheet(GEOMETRY_KERNEL_PIN);
  assert.ok(css.includes('[id^="dsh-slash-option-skill-"] [class$="_itemDescription"]{display:none}'));
  assert.ok(css.includes('[id^="dsh-slash-option-skill-"] [class$="_itemName"]{max-width:100%}'), 'the name is held to 40% of the row only to leave room for a description');
  assert.doesNotMatch(css, /dsh-slash-option-(?!skill-)/, 'a command, a file or a reference row keeps what it says');
  assert.ok(surfaces.menu.html.includes('id="dsh-slash-option-skill-0"') && surfaces.menu.html.includes('id="dsh-slash-option-command-1"'));
  assert.match(surfaces.menu.css, /_itemName\{[^}]*max-width:40%/);
});

test('the three rules are the researcher\'s and the operator\'s alike', () => {
  for (const css of [shellStylesheet(GEOMETRY_KERNEL_PIN), shellStylesheet(GEOMETRY_KERNEL_PIN, true)]) {
    assert.ok(css.includes('.dsh-mmd-badge,.dsh-mmd-btn') && css.includes('section[aria-busy]') && css.includes('dsh-slash-option-skill-'));
  }
});
