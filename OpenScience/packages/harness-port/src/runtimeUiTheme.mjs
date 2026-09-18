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
 * The layer, token name → `{ light, dark }`.
 * @returns {Record<string, { light: string, dark: string }>}
 */
export function evimedThemeTokens() {
  /** @param {string} light @param {string} [dark] */
  const both = (light, dark = light) => ({ light, dark });
  // Direction A. Brand (OKLCH H=185), cold neutral (H=232), semantic (§7.3).
  const brand = { 50: '#f0fbf9', 100: '#e1f7f3', 200: '#c3ece6', 300: '#98dbd2', 400: '#63c5b9', 500: '#26ac9f', 600: '#008f84', 700: '#00756b', 800: '#005e56', 900: '#004841' };
  const n = { 50: '#f8f8f9', 100: '#f0f1f2', 150: '#e9ebed', 200: '#dfe2e4', 300: '#c8cdcf', 400: '#acb2b5', 500: '#90979b', 600: '#767d81', 700: '#606669', 800: '#4c5154', 900: '#3a3e40', 950: '#242628', strong: '#8e969b' };
  const dark = { bg: '#14181a', surface: '#1d2225', surface2: '#272d30', faint: '#292f32', border: '#3a4044', strong: '#646c71' };
  const danger = { 300: '#ffb7ae', 400: '#ff8b7f', 600: '#cf463e', 700: '#af302b' };
  const warn = { 50: '#fff7ef', 300: '#efc392', 600: '#ab6c00', 700: '#8c5700' };
  const ok = { 50: '#f3fbf4', 300: '#aadbb3', 600: '#3a9052', 700: '#25773e' };
  const info = { 300: '#aacfff', 400: '#79b4ff', 600: '#1f7ae0', 700: '#0362bf' };
  const fontFamily = 'Inter, "SF Pro Text", system-ui, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  // Conversation prose keeps the size the reader chose (12–17 px) and only the
  // leading changes, to 1.75 (§7.6, §8): CJK body text needs more than Latin,
  // and upstream's was a fixed 24 px — 1.71 at the default size, tighter above.
  const proseLine = 'calc(var(--dsh-content-font-size, 14px) * 1.75)';
  const prose = (/** @type {string} */ lead) => both(`${lead}var(--dsh-content-font-size, 14px) / ${proseLine} var(--dsw-font-family)`);
  return {
    // The ramp, by what still reads it (see the module note).
    // 500 + 200: the working line is a lightness shimmer between the muted and
    // the text colour, no hue (§6.3, §7.6); 500 also colours three file icons,
    // which read as neutral glyphs.
    '--dsw-static-deepseek-500': both(n[700], n[400]),
    '--dsw-static-deepseek-200': both(n[950], n[100]),
    // 450: the running dot is info blue (§7.5: 4.27:1 light, 7.48:1 dark; a
    // graphic needs 3:1 — the brand's own 500 step would be 2.81:1).
    '--dsw-static-deepseek-450': both(info[600], info[400]),
    // No direct reader left; the brand steps, for anything added later.
    '--dsw-static-deepseek-50': both(brand[50]),
    '--dsw-static-deepseek-100': both(brand[100]),
    '--dsw-static-deepseek-400': both(brand[400]),
    // Accents.
    '--dsw-alias-button-info-fill': both(brand[700]),
    '--dsw-alias-button-info-hover': both(brand[800]),
    '--dsw-alias-link': both(info[700], info[300]),
    '--dsw-alias-state-business-primary': both(brand[700], brand[400]),
    '--dsw-alias-state-business-tertiary': both(brand[100], brand[900]),
    '--dsw-alias-markdown-citation': both(brand[700], brand[400]),
    '--dsw-alias-bg-multi-select': both(brand[100], brand[900]),
    '--dsw-alias-interactive-bg-hover-accent': both(brand[100], brand[900]),
    // Surfaces: canvas, then layers (the light layers step down in lightness,
    // the dark ones up).
    '--dsw-alias-bg-base': both('#ffffff', dark.bg),
    '--dsw-alias-bg-layer-1': both(n[50], dark.surface),
    '--dsw-alias-bg-layer-2': both(n[100], dark.surface2),
    '--dsw-alias-bg-layer-3': both(n[150], dark.faint),
    '--dsw-alias-bg-module-platform': both(n[100], dark.surface2),
    '--dsw-alias-bg-overlay': both(n[200], dark.border),
    // Menus and pickers (the slash menu, the @ picker, the subagent menu)
    // derive from layer 3 upstream; left there they would turn grey. They are
    // the popover surface, as in the shell.
    '--dsw-specific-menu': both('#ffffff', dark.surface2),
    '--dsw-specific-bubble': both(brand[50], dark.surface2),
    '--dsw-specific-bubble-highlight': both(brand[100], dark.border),
    '--dsw-specific-input-major': both('#ffffff', dark.surface),
    '--dsw-specific-selector': both(n[100], dark.surface2),
    '--dsw-specific-tip': both(n[100], dark.surface2),
    '--dsw-specific-sidebar-fill': both(n[50], dark.bg),
    '--dsw-specific-sidebar-nav-item-active': both(brand[100], brand[900]),
    '--dsw-specific-sidebar-nav-item-hover': both(n[100], dark.surface2),
    // Its one reader is the 「推荐」 badge of a question card, whose text is
    // the send button's fill; a light chip is the only ground that carries it
    // in both schemes (5.00:1).
    '--dsw-specific-sidebar-nav-item-active-accent': both(brand[100]),
    // Text. One reading of §7.6, which maps tertiary to n-600: that is 4.18:1
    // on white, below AA for the kernel's most-read text token (tool
    // summaries, metadata, the transcript's secondary lines). Secondary and
    // tertiary each sit one step darker than that row, so every text token but
    // the caption clears 4.5:1 on every light surface, and tertiary equals the
    // shell's own `--muted` (n-700).
    '--dsw-alias-label-primary': both(n[950], n[100]),
    '--dsw-alias-label-secondary': both(n[800], n[300]),
    '--dsw-alias-label-tertiary': both(n[700], n[400]),
    '--dsw-alias-label-caption': both(n[600], n[500]),
    '--dsw-alias-label-dimmed': both(n[300], n[800]),
    '--dsw-alias-label-primary-dimmed': both(n[900], n[200]),
    '--dsw-alias-label-primary-bluish': both(brand[900], n[100]),
    // Borders: hairline to control boundary (l4 backs every input and elevated
    // stroke, and is the 3:1 control edge of §7.5).
    '--dsw-alias-border-l1': both(n[150], dark.faint),
    '--dsw-alias-border-l2': both(n[200], dark.border),
    '--dsw-alias-border-l2-darkmode-thin': both(n[200], dark.faint),
    '--dsw-alias-border-l3': both(n[300], n[800]),
    '--dsw-alias-border-l4': both(n.strong, dark.strong),
    // States. Red is spent on danger alone; warning is amber, success green.
    '--dsw-alias-state-error-primary': both(danger[700], danger[300]),
    '--dsw-alias-state-error-secondary': both(danger[600], danger[400]),
    '--dsw-alias-state-warn-primary': both(warn[700], warn[300]),
    '--dsw-alias-state-warn-secondary': both(warn[600], warn[300]),
    '--dsw-alias-state-warn-tertiary': both(warn[50], '#27241f'),
    '--dsw-alias-state-warn-label': both(warn[700], warn[300]),
    '--dsw-alias-state-success-primary': both(ok[700], ok[300]),
    '--dsw-alias-state-success-secondary': both(ok[600], ok[300]),
    '--dsw-alias-state-success-tertiary': both(ok[50], '#233c2c'),
    // Type: the shell's stack, and prose leading.
    '--dsw-font-family': both(fontFamily),
    '--dsw-font-markdown-base': prose(''),
    '--dsw-font-markdown-base-strong': prose('600 '),
    '--dsw-font-markdown-base-italic': prose('italic '),
    '--dsw-font-markdown-base-strong-italic': prose('italic 600 '),
    '--dsw-font-markdown-base-line-height': both(proseLine),
    '--dsw-font-markdown-base-strong-line-height': both(proseLine),
    '--dsw-font-markdown-base-italic-line-height': both(proseLine),
    '--dsw-font-markdown-base-strong-italic-line-height': both(proseLine),
  };
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
  const tokens = evimedThemeTokens();
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
      if (snapshot?.active?.tokens?.[probe] === tokens[probe][scheme]) return;
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
