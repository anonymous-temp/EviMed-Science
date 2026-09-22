// The hosted shell body — brand, left column, document identity, stylesheet —
// exercised against a slot registry that refuses what the pinned kernel
// refuses. What is asserted is that it occupies exactly the documented slots,
// below the kernel's own occupants, and does nothing outside a page the
// control plane served.
import assert from 'node:assert/strict';
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

test('the left column, the three brand slots, the hero workspace picker and the attachment strip are occupied below the kernel, nothing else', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  const occupants = f.occupants();
  assert.deepEqual(Object.keys(occupants).sort(), [
    'conversation.hero.brand.mark', 'conversation.hero.workspace', 'conversation.input.attachments', 'sidebar', 'sidebar.brand.mark', 'sidebar.brand.name',
  ]);
  // Uploads are refused on this surface; the strip of chips that would be
  // refused at send renders nothing.
  assert.equal(renderStatic(occupants['conversation.input.attachments'].component), '');
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

test('a slot the kernel refuses costs that slot, never the rest of the body', () => {
  const f = fixture();
  const register = f.ctx.slots.register;
  f.ctx.slots.register = (/** @type {any} */ options, /** @type {any} */ component) => {
    if (options.name === 'conversation.hero.workspace') throw new Error('single slot already has a registration');
    return register(options, component);
  };
  assert.doesNotThrow(() => apply(f.ctx, {}, f.target, undefined, f.kit));
  assert.deepEqual(Object.keys(f.occupants()).sort(), ['conversation.hero.brand.mark', 'conversation.input.attachments', 'sidebar', 'sidebar.brand.mark', 'sidebar.brand.name']);
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
  assert.equal(f.target.document.title, 'EviMed 研究会话');
  const icon = f.target.document.head.children.find((/** @type {any} */ node) => node.attributes?.rel === 'icon');
  assert.ok(icon, "the document's icon is replaced, not left as the kernel's whale");
  assert.equal(icon.attributes.href, EVIMED_FAVICON);
  assert.match(EVIMED_FAVICON, /^data:image\/svg\+xml,.*%2300756b/, 'the icon carries the brand teal');
});

test('unloading the body removes its stylesheet', () => {
  const f = fixture();
  apply(f.ctx, {}, f.target, undefined, f.kit);
  f.ctx.dispose();
  assert.equal(f.target.document.head.children.filter((/** @type {any} */ node) => 'data-evimed-shell' in node.attributes).length, 0);
});
