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
 * Three things it does, and why each is here rather than in our own page:
 *
 *  - Brand. The EviMed mark occupies the sidebar mark, the sidebar name and
 *    the conversation hero; the kernel's fish and wordmark fall back only
 *    where nothing occupies the slot, so this leaves nothing of theirs.
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
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark);
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, Name);
    }));
    ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark));
    // The picker is a popup the chip opens; an occupant that renders nothing
    // leaves the chip (the bound workspace's name) and removes the choice.
    ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({ name: 'conversation.hero.workspace' }, Nothing));
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
    style.textContent = [
      'button[aria-label="Add workspace"],button[aria-label="添加工作区"]{display:none !important}',
      '[class$="_previewBadge"]:empty{display:none !important}',
    ].join('\n');
    doc.head.appendChild(style);
    ctx.effect(() => () => { style.remove(); }, 'evimed-shell: stylesheet');
  }
}
