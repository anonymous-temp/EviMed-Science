/**
 * The hosted shell of the kernel's browser application: brand, the left
 * column, the document's identity, and the stylesheet for what no token or
 * slot reaches.
 *
 * The kernel's web client is a slot system: packages declare slots
 * (`sidebar.brand.mark`, `conversation.hero.brand.mark`, ...) and any plugin
 * may occupy one. Its own brand package fills them only in an `official`
 * build, and its README says a deployment with its own identity "composes a
 * different package into the same slots instead". This body is that package,
 * in the same shape as the official one.
 *
 * What it does, and why each is here rather than in our own page:
 *
 *  - The left column. `sidebar` is the whole navigation column, and the layout
 *    package's own contract says occupying it replaces that column rather than
 *    adding to it. The hosted product has one navigation, in the shell around
 *    this frame; the kernel's second one — brand, new session, workspace tree,
 *    session list — was the same information under different words beside it.
 *  - Brand. The EviMed mark occupies the sidebar mark, the sidebar name and
 *    the conversation hero; the kernel's fish and wordmark fall back only
 *    where nothing occupies the slot. The two sidebar brand seats are declared
 *    by the column this body replaces, so they are dead while the column is
 *    shadowed — kept because they are what the page falls back to if that
 *    registration ever does not take, and the kernel's own wordmark appearing
 *    there would be worse than dead code.
 *  - Surfaces the hosted deployment does not offer. The hero's workspace
 *    picker slot is occupied by nothing, because a project's workspace is
 *    bound by the control plane and `workspace/create` is refused for any
 *    other path. Hiding a control is presentation; the refusal lives in
 *    `@evimed/domain`'s runtime-UI surface and does not depend on this body.
 *
 * The language pack is its own body (`runtimeUiLocale.mjs`), so either can be
 * switched off without the other.
 *
 * @module @evimed/harness-port/runtime-ui-shell
 */

/** Services this body needs: the slot registry. */
export const inject = ['slots'];

/**
 * The kernel client version the stylesheet's selectors were read against.
 *
 * The rules below reach the frame's layout through CSS-module class suffixes
 * (`_sidebarCol`) and stable data attributes, none of which the kernel
 * promises. A test holds this pin to the kernel pin in `deps-version.json`, so
 * moving the kernel forces someone to re-read the layout before the rules ship
 * against markup they were not written for.
 */
export const GEOMETRY_KERNEL_PIN = '0.1.5-rc.2';

/**
 * The product's mark as a data URL, for the document's icon.
 *
 * Inline because this module is bundled into the frame's own page and has no
 * asset pipeline behind it; the same geometry as the React mark below, in the
 * brand's primary teal (`#00756b`, direction A).
 *
 * @returns {string}
 */
export function evimedFavicon() {
  return 'data:image/svg+xml,'
    + "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E"
    + "%3Crect width='48' height='48' rx='10' fill='%2300756b'/%3E"
    + "%3Cpath d='M15 24h18M24 15v18' stroke='white' stroke-width='5' stroke-linecap='round'/%3E"
    + '%3C/svg%3E';
}

/** The same icon, for callers outside the frame. */
export const EVIMED_FAVICON = evimedFavicon();

/**
 * The stylesheet: layout the frame computes from its own store, and controls
 * this deployment does not offer. Presentation only; every rule is a hide or a
 * placement, and a renamed class upstream costs the rule, not the page.
 *
 * @param {string} pin the kernel version the selectors were read against
 * @returns {string}
 */
export function shellStylesheet(pin) {
  return [
    `/* evimed-shell: selectors read against dsh-client ${pin} */`,
    // Accessible names in both shipped languages, from the kernel's own
    // dictionaries (`workspace.add`).
    'button[aria-label="Add workspace"],button[aria-label="添加工作区"]{display:none !important}',
    // An empty preview badge keeps its pill without this rule.
    '[class$="_previewBadge"]:empty{display:none !important}',
    // The hero's workspace chip. The kernel renders the button itself, outside
    // any slot; only the picker it opens lives in `conversation.hero.workspace`,
    // which this body occupies with nothing. Left alone the chip is a button
    // labelled with the container's directory name that opens nothing — a dead
    // control on the first screen. Hidden by its accessible name
    // (`hero.chooseWorkspace`), and as a button: the composer's own editable
    // carries the same label while it waits for a workspace, and must stay.
    //
    // The whole row used to be hidden instead, which also hid the row's second
    // seat, `conversation.hero.agentPreset` — and that is why an occupant there
    // once "registered nothing and rendered nothing".
    'button[aria-label="选择工作区"],button[aria-label="Choose workspace"]{display:none !important}',
    // The composer's access-mode chip (「项目工作区」). A hosted deployment has
    // exactly one permission preset, so the chip opened a picker with one row
    // in it — a control that chooses nothing, beside the one input box the
    // conversation page should be (2026-09-22). Hidden by its accessible name
    // (`permission.trigger`, 「访问模式，当前：…」) in both shipped languages;
    // the preset itself is enforced by the profile and the method ban, not by
    // this chip.
    'button[aria-label^="访问模式"],button[aria-label^="Access mode"]{display:none !important}',
    // The composer's paperclip is the kernel's own and stays: a file attached to
    // a message goes to the project's attachment store through the frame's
    // upload carrier (`__DSH_FILE_UPLOAD__`, runtimeUiTransport.mjs). It was
    // hidden here until 2026-09-22, when uploads were refused on this surface.

    // The left column, which `sidebar` occupies with nothing.
    //
    // Occupying the slot replaces the column's CONTENT; the frame still sizes
    // the column from its own store, so on its own that leaves 280 px of empty
    // gutter between the product's navigation and the conversation (measured
    // on the deployed build, 2026-09-15).
    //
    // Removing the column from flow shifts the remaining items up a track —
    // the conversation landed in the 280 px sidebar track and the right column
    // took the 1fr one, also measured — so each is pinned to the track it
    // belongs in and the conversation spans the two on the left.
    //
    // The two resize handles carry one class and are told apart by position:
    // the frame's children are the three columns, the overlay layer, then the
    // handles, so the sidebar's handle is the one directly after the overlay
    // layer and the right panel's is the one after that. With the panel closed
    // there is only ONE handle in the DOM, and an nth-of-type rule would have
    // hidden the overlay layer instead.
    '[class$="_sidebarCol"]{display:none !important}',
    '[class$="_centerCol"]{grid-column:1 / 3 !important}',
    '[class$="_rightbarCol"]{grid-column:3 !important}',
    '[class$="_overlayLayer"] + [class$="_handle"]{display:none !important}',
    // The conversation never scrolls sideways.
    //
    // Measured at 1440 px with the right panel opening (2026-09-18 walk,
    // screenshot 14): everything inside the conversation's scroll body —
    // messages and composer alike — shifted about 224 px left and was cut at
    // the frame's edge, while the header above it stayed put. That is a
    // horizontal scroll offset on the scroll body, which exists only while
    // something inside overflows it sideways: the transcript's own column is
    // `width:100%` under a max width, but a wide block's bleed is computed
    // from a container width that lags a squeeze reflow by a frame. Clipping
    // at the transcript's own padding box keeps every intended bleed (it is
    // bounded by that box by construction) and removes the offset's cause;
    // the scroll body itself is held to vertical scrolling. `clip` and not
    // `hidden` on the transcript, because `clip` creates no scroll container
    // and so leaves the sticky turn rail and "to bottom" button attached to the
    // real one.
    '[data-conversation-scroll]{overflow-x:hidden !important}',
    '[class$="_scroll"]:has(> [data-chat-flow]){overflow-x:clip !important}',
  ].join('\n');
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global, injectable by the contract suite.
 * @param {(id: string) => any} [_require] The loader's module resolver (React arrives through the kit).
 * @param {any} [kit] The frame kit (`runtimeUiKit.mjs`).
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  // `__EVIMED_FRAME__` is the control plane's own bootstrap object, so its
  // presence — not the window's position — is what says this page is ours.
  // The guard used to also require `target.parent !== target`, which meant
  // that opening the frame's address in a tab got the kernel unbranded (its
  // whale mark, its `DeepSeek Harness` title, the swimming fish on an empty
  // conversation; 2026-09-16 review, §4.1 item 8). One condition, one
  // uncovered path.
  if (!kit || !kit.ours) return;
  const h = kit.h;

  if (h) {
    /** @param {{size?: number, className?: string}} props */
    const Mark = ({ size, className }) => {
      const px = Number(size) > 0 ? Number(size) : 24;
      // The brand's accent, through the frame's own token so the mark follows
      // the theme layer (and its lighter dark-scheme step) like every other
      // accent on the page. Not the deepseek ramp: under direction A its 500
      // step is the working line's muted grey. As style and not as a
      // presentation attribute: an SVG attribute is not a place `var()`
      // resolves.
      const color = 'var(--dsw-alias-state-business-primary, #00756b)';
      return h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 48 48', width: px, height: px,
        role: 'img', 'aria-label': 'EviMed', className: className || undefined },
      h('g', { style: { fill: 'none', stroke: color }, strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 3.5 },
        h('path', { d: 'M18 27 9.5 18.5M18 27 29.5 12.5M18 27l16 7' })),
      h('g', { style: { fill: color } },
        h('circle', { cx: 9, cy: 18, r: 5 }), h('circle', { cx: 18, cy: 27, r: 5.5 }),
        h('circle', { cx: 30, cy: 12, r: 5 }), h('circle', { cx: 35, cy: 34, r: 5 })));
    };
    const Name = () => h('span', { style: { fontWeight: 600 } }, 'EviMed');
    const Nothing = () => null;

    // A single slot renders its LOWEST-priority registration and refuses a
    // second one at the same priority. The kernel's own occupants register at
    // the default 0 — the workspace picker always, the official brand in an
    // official build — so ours sit below them and shadow rather than collide.
    // Registered at 0, the picker slot threw "already has a registration", and
    // that one throw failed the whole loader entry, bridge included: the frame
    // never bound its session (2026-09-09, first release of this file).
    const below = -1;
    kit.guarded('sidebar brand', () => {
      kit.occupy({ slot: 'sidebar.brand.mark', priority: below }, Mark);
      kit.occupy({ slot: 'sidebar.brand.name', priority: below }, Name);
    });
    kit.guarded('hero brand', () => kit.occupy({ slot: 'conversation.hero.brand.mark', priority: below }, Mark));
    // The left column, removed: occupying `sidebar` replaces the column's
    // content, and the stylesheet removes its width. The frame's own room
    // arithmetic still counts the column, though — expanded it is 280 px of
    // the width the right column is weighed against, and with it counted the
    // right column refuses to open below a 980 px frame and sits narrower
    // above. So the column is also told it is collapsed (a 56 px rail in that
    // arithmetic) whenever it says it is not: `ctx.layout.toggleSidebar()` is
    // the layout's own public switch, and the owner props say which way it
    // stands, so this never toggles it open.
    /** @type {any} */
    let layout = null;
    kit.withServices(['layout'], (/** @type {any} */ scope) => { layout = scope.layout; });
    /** @param {{ collapsed?: boolean }} props */
    const LeftColumn = ({ collapsed }) => {
      kit.react.useEffect(() => {
        if (collapsed !== false || !layout || typeof layout.toggleSidebar !== 'function') return;
        try { layout.toggleSidebar(); } catch { /* the column keeps its width; only the room arithmetic suffers */ }
      }, [collapsed]);
      return null;
    };
    kit.guarded('sidebar column', () => kit.occupy({ slot: 'sidebar', priority: below }, kit.react ? LeftColumn : Nothing));
    // The picker is a popup the chip opens; an occupant that renders nothing
    // removes the choice (the chip itself is hidden by the stylesheet).
    kit.guarded('workspace picker', () => kit.occupy({ slot: 'conversation.hero.workspace', priority: below }, Nothing));
    // The draft's attachment strip (`conversation.input.attachments`) is the
    // kernel's own again: it was occupied by nothing here while uploads were
    // refused, and with them allowed it hid every attached file — the upload
    // landed and the composer showed nothing, nor sent (2026-09-22).
  }

  const doc = target.document;
  if (doc && typeof doc.createElement === 'function' && doc.head) {
    // The document's own name and icon.
    //
    // Invisible inside an iframe — the shell's frame carries its own accessible
    // name — and the whole page when the address is opened directly, where the
    // tab read `DeepSeek Harness` under a whale favicon. The kernel's packages
    // are MIT and its brand package documents exactly this substitution;
    // DeepSeek's platform terms §5.2 forbid using their marks without
    // permission and impose no attribution duty, so carrying their mark is the
    // wrong default rather than the polite one.
    try {
      doc.title = 'EviMed 研究会话';
      const icon = doc.querySelector('link[rel~="icon"]') ?? doc.createElement('link');
      icon.setAttribute('rel', 'icon');
      icon.setAttribute('type', 'image/svg+xml');
      icon.setAttribute('href', evimedFavicon());
      if (!icon.parentNode) doc.head.appendChild(icon);
    } catch { /* a document that refuses either is still a working conversation */ }

    const style = doc.createElement('style');
    style.setAttribute('data-evimed-shell', '');
    style.setAttribute('data-evimed-kernel', String(kit.vocabulary?.kernelPin ?? ''));
    style.textContent = shellStylesheet(String(kit.vocabulary?.kernelPin ?? ''));
    doc.head.appendChild(style);
    ctx.effect(() => () => { style.remove(); }, 'evimed-shell: stylesheet');
  }
}

/** The body as the socket's build composes it: its helpers, then `apply`. */
export const BODY = Object.freeze({ name: 'shell', inject, parts: Object.freeze([evimedFavicon, shellStylesheet, apply]) });
