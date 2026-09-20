/**
 * The frame's palette and type: direction A (「循证青」, evidence teal), laid
 * over the kernel's own theme through its documented override.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client (`dsh-client-ui-theme`
 * and every stylesheet that reads a `--dsw-*` token):
 *
 *  - `ctx.theme.overrideTokens(source, tokens)` stacks one layer per source and
 *    validates shape only (`{ light, dark }` strings), not names. `ui-layout`'s
 *    presenter writes the composed tokens as inline custom properties on
 *    `body`, so the layer beats every author rule of the token sheets, and the
 *    sheets' own derived tokens (`--dsw-specific-menu: var(--dsw-alias-bg-layer-3)`,
 *    `--dsw-font-markdown-*-font-family: var(--dsw-font-family)`) follow it.
 *  - The `--dsw-static-deepseek-*` ramp is the same in both schemes upstream; the
 *    alias layer picks different steps per scheme. Every alias that reads the
 *    ramp is set directly below, so what each ramp step still decides is only
 *    what reads it directly:
 *      500 — the 「思考中」 line (`ui-chat` turnStatus: base colour of a
 *            text-clipped gradient) and the code / HTML / Markdown file icons;
 *      200 — the moving band of that same gradient;
 *      450 — the "running" state dot and the Word file icon;
 *      50, 100, 400 — no direct reader left.
 *    (`--dsw-linear-gradient-think` is declared upstream and read by nothing.)
 *  - `--dsw-alias-brand-primary` is NOT an accent: it is the high-contrast
 *    neutral behind primary buttons and several focus rings (`#0f1115` light).
 *    Pointing it at a hue puts white text on a mid tone; it is left alone.
 *  - The send button's glyph is a hard-coded `#fff` on
 *    `--dsw-alias-button-info-fill`, so that fill must carry white in BOTH
 *    schemes — upstream's blue carried it at 4.23:1 (light) and 2.7:1 (dark).
 *    It is the brand's 700 step in both, 5.59:1.
 *  - The layer is memory-only: the presenter re-applies the composed snapshot on
 *    every `theme/change`, and a layer lives exactly as long as the theme
 *    runtime that holds it. So the body registers it in an effect (released on
 *    unload), and puts it back if a change ever arrives without it.
 *  - The embedding page has no channel into the theme (no listener, no query,
 *    no storage key). The shell's light/dark/system choice therefore arrives as
 *    a bridge message (`evimed.runtime-ui.theme`) and is applied with
 *    `ctx.theme.setTheme`, the runtime's only preference write — process-local
 *    on this non-loopback page, which is right: the shell owns the preference.
 *
 * Values are appendix D §7 of the 2026-09-18 review (§7.1 ramps, §7.3/§7.4 the
 * semantic layer, §7.5 the status dots, §7.6 the frame mapping, §6.3 the
 * working line), the same table the shell's tokens come from (C10). Where a
 * row is read differently from §7.6, the reason is beside it. Geometry (radii,
 * spacing) has no token family in the kernel; the little of it the shell body
 * touches lives in its stylesheet, pinned to the kernel version.
 *
 * @module @evimed/harness-port/runtime-ui-theme
 */

/**
 * Optional services only: `theme` is reached through `ctx.inject`.
 * @type {string[]}
 */
export const inject = [];

/** The override layer's identity: one layer per source. */
export const THEME_LAYER_SOURCE = '@evimed/dsh-socket';

/**
 * The override layer's table, as the build inlined it.
 *
 * The values are `packages/domain/src/designTokens.mjs` — the one module the
 * shell's stylesheet and Tailwind theme are generated from — carried here as
 * data in the frame's vocabulary, because a body may import nothing. This
 * function is the read, not the decision: it used to be a second copy of the
 * ramp, and the shell and the frame drifted apart on three of its sixty rows.
 *
 * @param {any} [vocabulary] the frame kit's build-time table
 * @returns {Record<string, { light: string, dark: string }>}
 */
export function evimedThemeTokens(vocabulary) {
  const tokens = vocabulary && vocabulary.themeTokens;
  return tokens && typeof tokens === 'object' ? tokens : {};
}


/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global.
 * @param {(id: string) => any} [_require]
 * @param {any} [kit] The frame kit.
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  if (!kit || !kit.ours) return;
  const tokens = evimedThemeTokens(kit.vocabulary);
  const source = '@evimed/dsh-socket';
  const probe = '--dsw-static-deepseek-500';
  kit.withServices(['theme'], (/** @type {any} */ scope) => {
    const theme = scope.theme;
    /** @type {(() => void) | null} */
    let release = null;
    let live = true;
    let restored = 0;
    const layer = () => { release = theme.overrideTokens(source, tokens); };
    scope.effect(() => {
      layer();
      // Not live first: releasing the layer emits a change the watch below
      // must not answer by putting it back.
      return () => { live = false; release?.(); release = null; };
    }, 'evimed-theme: token layer');
    // A change that arrives without the layer — anything else overriding under
    // this source, or a restack that dropped it — gets it back. A bounded
    // number of times, so two layers that both insist cannot become a loop.
    scope.effect(() => scope.on('theme/change', (/** @type {any} */ snapshot) => {
      if (!live) return;
      const scheme = snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light';
      if (!tokens[probe] || snapshot?.active?.tokens?.[probe] === tokens[probe][scheme]) return;
      if (restored >= 5) return;
      restored++;
      layer();
    }), 'evimed-theme: layer watch');
    // The shell's own light/dark/system choice, applied when it arrives and
    // whenever it changes.
    const follow = (/** @type {any} */ value) => {
      const preference = value && ['light', 'dark', 'system'].includes(value.preference) ? value.preference : null;
      if (!preference) return;
      try { theme.setTheme(preference); } catch (error) { target.console?.warn?.('[evimed-theme] preference not applied:', error); }
    };
    follow(kit.hub.getState().theme);
    scope.effect(() => kit.hub.on('theme', follow), 'evimed-theme: shell preference');
  });
}

/** The body as the socket's build composes it. */
export const BODY = Object.freeze({ name: 'theme', inject, parts: Object.freeze([evimedThemeTokens, apply]) });
