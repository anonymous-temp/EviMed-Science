/**
 * The hosted shell of the kernel's browser application.
 *
 * The kernel's web client is a slot system: packages declare slots
 * (`sidebar.brand.mark`, `conversation.hero.brand.mark`, ...) and any plugin
 * may occupy one. Its own brand package fills them only in an `official`
 * build, and its README says a deployment with its own identity "composes a
 * different package into the same slots instead". This is that package, in
 * the same shape as the official one: no DOM patching, no CSS by hashed class
 * name, only the composition surfaces the kernel documents.
 *
 * Four things it does, and why each is here rather than in our own page:
 *
 *  - The left column. `sidebar` is the whole navigation column, and the layout
 *    package's own contract says occupying it replaces that column rather than
 *    adding to it. The hosted product has one navigation, in the shell around
 *    this frame; the kernel's second one — brand, new session, workspace tree,
 *    session list — was the same information under different words beside it.
 *    A rail takes its place (the frame reserves 56 px even closed, so this is
 *    the smallest the column gets).
 *  - Brand. The EviMed mark occupies the sidebar mark, the sidebar name and
 *    the conversation hero; the kernel's fish and wordmark fall back only
 *    where nothing occupies the slot, so this leaves nothing of theirs. The
 *    two sidebar brand seats are declared by the column this file replaces, so
 *    they are dead while the rail is registered — kept because they are what
 *    the page falls back to if the rail registration ever does not take, and
 *    the kernel's own wordmark appearing there would be worse than dead code.
 *  - Language. The kernel ships `zh` and `en` and picks by the browser's
 *    `navigator` on a non-loopback page, where the user cannot switch (the
 *    General settings row is disabled in the hosted composition). A Chinese
 *    product face must not depend on a browser preference, so this registers
 *    a private-use language `zh-x-evimed` whose fallback is `zh` and selects
 *    it. Its own dictionary is small: the kernel's copy speaks of "building",
 *    which is the wrong verb for a research bench, and the "Preview" badge
 *    describes the kernel's release stage, not ours. Lookup walks the fallback
 *    chain per namespace, so every string this pack does not name stays the
 *    kernel's own Chinese.
 *  - Surfaces the hosted deployment does not offer. The hero's workspace
 *    picker slot is occupied by nothing, because a project's workspace is
 *    bound by the control plane and `workspace/create` is refused for any
 *    other path. The sidebar's "add workspace" button reaches the same refused
 *    method, and is hidden by its accessible name in both shipped languages.
 *    Hiding a control is presentation; the refusal lives in
 *    `@evimed/domain`'s runtime-UI surface and does not depend on this file.
 *
 * The body is self-contained for browser bundling: the socket's build emits
 * `apply.toString()`, so nothing here may close over a module import. React
 * arrives through the loader's `require`, exactly as the kernel's own client
 * bundles receive it.
 */

/** Services this plugin needs: the slot registry and the locale runtime. */
export const inject = ['slots', 'locale'];

/** The private-use tag of the product's language pack; falls back to `zh`. */
export const EVIMED_LOCALE = 'zh-x-evimed';

/**
 * The strings the product rephrases, per kernel namespace. Keys are the
 * kernel's own; anything absent here resolves through `zh`.
 */
export const EVIMED_DICTIONARIES = Object.freeze({
  conversation: Object.freeze({
    'hero.headline': '从一个研究问题开始',
    'hero.preview': '',
    'placeholder.hero': '描述你的研究问题或任务… / 调用指令，@ 引用文件或会话',
    'placeholder.default': '继续这项研究，或提出下一个任务… / 调用指令，@ 引用文件或会话',
  }),
});

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global, injectable by the contract suite.
 * @param {(id: string) => any} [require] The loader's module resolver; React comes from it.
 */
export function apply(ctx, _config, target = globalThis, require = undefined) {
  const frame = target.__EVIMED_FRAME__;
  if (!frame || frame.version !== 1 || target.parent === target) return;

  const dictionaries = {
    conversation: {
      'hero.headline': '从一个研究问题开始',
      'hero.preview': '',
      'placeholder.hero': '描述你的研究问题或任务… / 调用指令，@ 引用文件或会话',
      'placeholder.default': '继续这项研究，或提出下一个任务… / 调用指令，@ 引用文件或会话',
    },
  };
  const localeId = 'zh-x-evimed';
  /**
   * The capability cards the hero offers, handed over in the frame's bootstrap
   * object by the control plane. Validated rather than trusted: this file
   * renders them, and a malformed entry must cost that entry, not the hero.
   */
  const capabilities = (Array.isArray(frame.capabilities) ? frame.capabilities : [])
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.title === 'string'
      && typeof entry.category === 'string' && typeof entry.brief === 'string'
      && entry.title && entry.brief && entry.brief.length <= 100_000)
    .slice(0, 24);

  // --- brand -------------------------------------------------------------
  /** @type {any} */
  let react = null;
  try { react = typeof require === 'function' ? require('react') : null; } catch { react = null; }
  const h = react && typeof react.createElement === 'function' ? react.createElement : null;
  if (h) {
    /** @param {{size?: number, className?: string}} props */
    const Mark = ({ size, className }) => {
      const px = Number(size) > 0 ? Number(size) : 24;
      return h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 48 48', width: px, height: px,
        role: 'img', 'aria-label': 'EviMed', className: className || undefined },
      h('g', { fill: 'none', stroke: '#2563EB', strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 3.5 },
        h('path', { d: 'M18 27 9.5 18.5M18 27 29.5 12.5M18 27l16 7' })),
      h('g', { fill: '#2563EB' },
        h('circle', { cx: 9, cy: 18, r: 5 }), h('circle', { cx: 18, cy: 27, r: 5.5 }),
        h('circle', { cx: 30, cy: 12, r: 5 }), h('circle', { cx: 35, cy: 34, r: 5 })));
    };
    const Name = () => h('span', { style: { fontWeight: 600, letterSpacing: '0.01em' } }, 'EviMed');
    const Nothing = () => null;

    /**
     * The fifteen research capabilities, one row above the composer.
     *
     * They were a navigation row and a page of cards, which is a page most
     * researchers never opened; what an empty composer asks instead is that
     * you already know what to type (2026-09-15 walk, P2-1). This is the
     * catalogue where the typing happens.
     *
     * `conversation.input.dock` and not the blank-session hero, for a reason
     * worth writing down: the hero's own seat is `conversation.hero.agentPreset`,
     * and `ui-agent-preset` is one of the fourteen rows this deployment
     * disables — a disabled row declares no slot, so occupying it registered
     * nothing and rendered nothing, silently. Measured on the deployed build
     * before this line was written. The dock is declared by `ui-conversation`,
     * which the hosted composition must load for there to be a conversation at
     * all. A list slot is registered with an `id` — `key`, which the right
     * sidebar's tab slot takes, is refused here with `requires options.id`,
     * and the refusal is caught, so the dock simply did not appear.
     *
     * Always visible rather than only on a blank session, which is the honest
     * reading of §9.8 anyway: a capability is a suggestion, not a binding, and
     * the turn where someone realises they want a Meta-analysis is usually not
     * the first one.
     *
     * A card fills the brief and names the capability in it — a high-confidence
     * expectation the delivery gate reads (§9.4). The brief comes from
     * `@evimed/domain`, the same function the 「科研能力」 page calls: two
     * spellings would be two different expectations.
     *
     * The click leaves through the shell rather than writing the draft here.
     * The shell opens a task carrying it, which is the path the capability page
     * has always taken and the only one that also works from the hero, where
     * there is no session yet to write into.
     */
    const CapabilityDock = () => h('details', {
      style: { width: '100%', margin: '0 0 6px' },
    },
    h('summary', {
      style: { cursor: 'pointer', fontSize: '12px', opacity: 0.6, listStyle: 'none', padding: '2px 0' },
    }, `科研能力 · ${capabilities.length} 项`),
    h('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '6px 0 2px' },
    }, capabilities.map((capability) => h('button', {
      key: capability.id,
      type: 'button',
      title: `${capability.category} · ${capability.title}`,
      onClick: () => {
        try { target.__EVIMED_SHELL__?.navigate?.('new-task', capability.brief); } catch { /* no channel, no navigation */ }
      },
      style: { padding: '4px 10px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '12px' },
    }, capability.title))));

    /**
     * The left column, removed.
     *
     * The kernel's own left column is a second navigation: brand, new session,
     * a workspace tree and the session list — all of which the hosted shell
     * already shows one column to the left, under different words (任务 /
     * 会话 / 运行). Side by side that is what made the session page read as
     * three shells nested in each other, which is the first thing an operator
     * said about it (2026-09-15 walk, A1/A6).
     *
     * Occupying `sidebar` replaces the column outright — the layout package's
     * own contract says so, and says the seats it declares go with it. What it
     * does not do is take the column's WIDTH: the frame sizes that from its own
     * store, so an occupant that renders nothing leaves 280 px of empty column
     * (measured on the deployed build, 2026-09-15). `ctx.layout.toggleSidebar`
     * would close it to a 56 px rail, and did not fire from inside the
     * occupant; the rule below removes the column instead, which is the better
     * outcome anyway — there is nothing in it the shell does not already offer.
     *
     * Presentation only, and the same handle the two rules beside it use: a
     * CSS-module class has a stable suffix and a hashed prefix. If upstream
     * renames it the column comes back, which is a cosmetic regression and not
     * a broken page.
     */
    // A single slot renders its LOWEST-priority registration and refuses a
    // second one at the same priority. The kernel's own occupants register at
    // the default 0 — the workspace picker always, the official brand in an
    // official build — so ours sit below them and shadow rather than collide.
    // Registered at 0, the picker slot threw "already has a registration",
    // and that one throw failed the whole loader entry, bridge included: the
    // frame never bound its session (2026-09-09, first release of this file).
    const below = -1;
    /** Cosmetic work must never sink the bridge that shares this bundle.
     *  @param {string} label @param {() => unknown} fn */
    const guarded = (label, fn) => {
      try { return fn(); } catch (error) { target.console?.warn?.(`[evimed-shell] ${label} unavailable:`, error); return undefined; }
    };
    guarded('sidebar brand', () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: below }, Mark);
      yield ctx.slots.register({ name: 'sidebar.brand.name', priority: below }, Name);
    })));
    guarded('hero brand', () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: below }, Mark)));
    guarded('sidebar column', () => ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', priority: below }, Nothing)));
    if (capabilities.length) {
      guarded('capability dock', () => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'evimed-capabilities' }, CapabilityDock)));
    }
    // The picker is a popup the chip opens; an occupant that renders nothing
    // leaves the chip (the bound workspace's name) and removes the choice.
    guarded('workspace picker', () => ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({ name: 'conversation.hero.workspace', priority: below }, Nothing)));
  }

  // --- language ----------------------------------------------------------
  const locale = ctx.locale;
  if (locale && typeof locale.addLanguage === 'function' && typeof locale.register === 'function' && typeof locale.setLocale === 'function') {
    try {
      ctx.effect(() => locale.addLanguage({ id: localeId, label: '中文', fallback: 'zh' }), 'evimed-shell: language');
      for (const [ns, dict] of Object.entries(dictionaries)) {
        ctx.effect(() => locale.register(ns, localeId, dict), `evimed-shell: ${ns} dictionary`);
      }
      locale.setLocale(localeId);
    } catch (error) {
      // The pack is a refinement; the language is the requirement.
      try { locale.setLocale('zh'); } catch { /* the kernel keeps its browser-derived choice */ }
      target.console?.warn?.('[evimed-shell] language pack unavailable:', error);
    }
  }

  // --- controls the deployment does not offer -----------------------------
  const doc = target.document;
  if (doc && typeof doc.createElement === 'function' && doc.head) {
    const style = doc.createElement('style');
    style.setAttribute('data-evimed-shell', '');
    // Accessible names in both shipped languages, from the kernel's own
    // dictionaries (`workspace.add`). An empty preview badge keeps its pill
    // without this rule.
    //
    // The hero's workspace chip is rendered by the kernel itself, outside any
    // slot; only the picker it opens lives in `conversation.hero.workspace`,
    // which the shell occupies with nothing. Left alone, the chip stays as a
    // button labelled with the container's directory name that opens nothing —
    // a dead control on the first screen. Its row is a CSS-module class, so
    // the suffix selector is the only handle, and hiding is all it is used for.
    style.textContent = [
      'button[aria-label="Add workspace"],button[aria-label="添加工作区"]{display:none !important}',
      '[class$="_previewBadge"]:empty{display:none !important}',
      '[class$="_heroWorkspaceRow"]{display:none !important}',
      // The left column, which `sidebar` occupies with nothing.
      //
      // Occupying the slot replaces the column's CONTENT; the frame still
      // sizes the column from its own store, so on its own that leaves 280 px
      // of empty gutter between the product's navigation and the conversation
      // (measured on the deployed build, 2026-09-15). `ctx.layout.toggleSidebar`
      // would narrow it and did not fire from inside the occupant.
      //
      // Removing the column from flow shifts the remaining items up a track —
      // the conversation landed in the 280 px sidebar track and the right
      // column took the 1fr one, also measured — so each is pinned to the
      // track it belongs in and the conversation spans the two on the left.
      // Verified in the live frame with the right panel both open (680 + 528)
      // and closed (1208 + 0) before it was written here.
      //
      // The two resize handles share one class, so this takes the right
      // panel's drag with the sidebar's. That panel is still opened, closed
      // and made fullscreen from the conversation header, which is where its
      // contract says its controls live; a stray 8 px drag target over the
      // conversation would be worse.
      '[class$="_sidebarCol"]{display:none !important}',
      '[class$="_centerCol"]{grid-column:1 / 3 !important}',
      '[class$="_rightbarCol"]{grid-column:3 !important}',
      '[class$="_handle"]{display:none !important}',
    ].join('\n');
    doc.head.appendChild(style);
    ctx.effect(() => () => { style.remove(); }, 'evimed-shell: stylesheet');
  }
}
