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
     * The left column, replaced by a rail.
     *
     * The kernel's own left column is a second navigation: brand, new session,
     * a workspace tree and the session list — all of which the hosted shell
     * already shows, under different words (任务 / 会话 / 运行). Side by side
     * with the shell's sidebar that made the session page read as three shells
     * nested in each other, which is the first thing an operator said about it
     * (2026-09-15 walk, A1/A6).
     *
     * Occupying `sidebar` replaces the column outright — the layout package's
     * own contract says so, and says the seats it declares go with it. The
     * column cannot be removed entirely: closed, the frame still reserves a
     * 56 px rail. So this renders that rail, with the one control the kernel's
     * column had that the shell's does not duplicate — start a new task — and
     * closes itself once on first paint, because the frame opens it at 280 px.
     *
     * Navigation leaves through the bridge's channel, which owns the sequence
     * the shell validates. If the bridge is not present this renders a rail
     * with no actions rather than throwing: the conversation is what matters.
     */
    // Hook-free on purpose. The kernel hands this bundle React through the
    // loader's `require`, and how much of React that object carries is the
    // loader's business, not ours: `createElement` is the only member the
    // brand occupants have ever needed. One closure flag and a deferred call
    // do what a `useRef` + `useEffect` pair would, without widening what this
    // file assumes about its host.
    let railCollapseRequested = false;
    const Rail = ({ collapsed }) => {
      if (!railCollapseRequested && !collapsed) {
        railCollapseRequested = true;
        // Deferred out of the render pass: `toggleSidebar` writes the layout
        // store, and writing another component's store while rendering is the
        // one thing React asks you not to do. Once only — a researcher who
        // reopens the column keeps it open.
        try {
          target.setTimeout?.(() => {
            try { ctx.layout?.toggleSidebar?.(); } catch { /* geometry is cosmetic */ }
          }, 0);
        } catch { /* no timer, no auto-collapse; the rail still renders */ }
      }
      const go = (destination) => () => {
        try { target.__EVIMED_SHELL__?.navigate?.(destination); } catch { /* no channel, no navigation */ }
      };
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
          height: '100%', padding: '12px 0', boxSizing: 'border-box' },
      },
      h('button', { type: 'button', onClick: go('new-task'), title: '新任务', 'aria-label': '新任务',
        style: { display: 'grid', placeItems: 'center', width: '28px', height: '28px', padding: 0,
          border: 'none', borderRadius: '8px', background: 'transparent', cursor: 'pointer', color: 'inherit' } },
      h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', width: 16, height: 16,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'M12 5v14M5 12h14' }))),
      // The mark sits at the foot rather than the head: the product's own
      // brand is already at the top of the shell's sidebar, one column left,
      // and two of them stacked is the duplication this rail exists to end.
      h('div', { style: { marginTop: 'auto', opacity: 0.55 } }, h(Mark, { size: 18 })));
    };
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
    guarded('sidebar rail', () => ctx.slots.inject('sidebar', () => ctx.slots.register({ name: 'sidebar', priority: below }, Rail)));
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
    ].join('\n');
    doc.head.appendChild(style);
    ctx.effect(() => () => { style.remove(); }, 'evimed-shell: stylesheet');
  }
}
