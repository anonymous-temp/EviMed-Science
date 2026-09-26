/**
 * The conversation kernel's theme override.
 *
 * The deep-research surface is the DSH kernel's own React app in a cross-origin
 * frame. We do not fork it: `ctx.theme.overrideTokens` takes a map of the
 * kernel's own custom properties, and that is the whole of how the frame comes
 * to look like EviMed. `packages/harness-port/src/runtimeUiTheme.mjs` owns the
 * seam; this module owns the values, so the shell and the conversation cannot
 * disagree about what blue is.
 *
 * Hidden knowledge, read off the pinned 0.1.5-rc.2 client, and the reason this
 * is a hand-written mapping rather than a loop over `COLOR_ROLES`:
 *
 *  - `overrideTokens` validates shape only (`{ light, dark }` strings), not
 *    names. A misspelt token is silently ignored.
 *  - The `--dsw-static-deepseek-*` ramp is one ramp in both schemes upstream;
 *    the alias layer picks steps per scheme. Every alias that reads the ramp is
 *    set below, so what a ramp step still decides is only what reads it
 *    directly: 500 — the 「思考中」 line and the code / HTML / Markdown file
 *    icons; 200 — the moving band of that gradient; 450 — the running dot and
 *    the Word file icon; 50 / 100 / 400 — no direct reader left.
 *  - `--dsw-alias-brand-primary` is NOT an accent: it is the high-contrast
 *    neutral behind primary buttons and several focus rings. Pointing it at a
 *    hue puts white text on a mid tone, so it is left alone.
 *  - The send button's glyph is a hard-coded `#fff` on
 *    `--dsw-alias-button-info-fill`, so that fill must carry white in BOTH
 *    schemes. Upstream's blue carried it at 4.23:1 light and 2.7:1 dark; the
 *    brand's 600 step is 6.24:1 in both.
 *  - The menu surfaces derive from `bg-layer-3` upstream; left there they turn
 *    grey, so they are set to the popover surface, as in the shell.
 *
 * @module @evimed/design-tokens/kernel
 */
import { COLOR_RAMPS, FONT_STACKS, FONT_WEIGHTS, TYPE_SCALE, colorRole } from './index.mjs'

/**
 * @returns {Record<string, { light: string, dark: string }>}
 */
export function kernelThemeTokens() {
  /** @param {string} name @returns {{ light: string, dark: string }} */
  const role = (name) => ({ light: colorRole(name, 'light'), dark: colorRole(name, 'dark') })
  /** @param {string} light @param {string} [dark] @returns {{ light: string, dark: string }} */
  const both = (light, dark = light) => ({ light, dark })
  const brand = COLOR_RAMPS.brand
  const n = COLOR_RAMPS.n
  const dark = COLOR_RAMPS.dark
  // Conversation prose keeps the size the reader chose (12–17 px) and only the
  // leading changes, to 1.75: CJK body text needs more than Latin, and
  // upstream's was a fixed 24 px — 1.71 at the default size, tighter above.
  const proseLine = `calc(var(--dsh-content-font-size, ${TYPE_SCALE.ui.size}px) * ${TYPE_SCALE.body.lineHeight})`
  /** @param {string} lead @returns {{ light: string, dark: string }} */
  const prose = (lead) =>
    both(`${lead}var(--dsh-content-font-size, ${TYPE_SCALE.ui.size}px) / ${proseLine} var(--dsw-font-family)`)
  return {
    // The ramp, by what still reads it. 500 + 200: the working line is a
    // lightness shimmer between the quiet text colour and the loud one, no hue.
    '--dsw-static-deepseek-500': role('text-3'),
    '--dsw-static-deepseek-200': role('text'),
    // 450: the running dot. A graphic needs 3:1 and brand-500 is 4.29 on the
    // canvas, so the brand carries it now that the brand is blue.
    '--dsw-static-deepseek-450': role('dot-running'),
    // No direct reader left; the brand steps, for anything added later.
    '--dsw-static-deepseek-50': both(brand[50]),
    '--dsw-static-deepseek-100': both(brand[100]),
    '--dsw-static-deepseek-400': both(brand[400]),
    // Accents.
    '--dsw-alias-button-info-fill': both(brand[600]),
    '--dsw-alias-button-info-hover': both(brand[700]),
    '--dsw-alias-link': role('link'),
    '--dsw-alias-state-business-primary': role('accent'),
    '--dsw-alias-state-business-tertiary': both(brand[100], brand[900]),
    '--dsw-alias-markdown-citation': role('accent'),
    '--dsw-alias-bg-multi-select': both(brand[100], brand[900]),
    '--dsw-alias-interactive-bg-hover-accent': both(brand[100], brand[900]),
    // Surfaces: the canvas, then the layers.
    '--dsw-alias-bg-base': role('bg'),
    '--dsw-alias-bg-layer-1': role('surface-1'),
    '--dsw-alias-bg-layer-2': role('surface-2'),
    '--dsw-alias-bg-layer-3': both(n[150], dark['border-faint']),
    '--dsw-alias-bg-module-platform': role('surface-2'),
    '--dsw-alias-bg-overlay': both(n[200], dark.border),
    '--dsw-specific-menu': role('surface'),
    '--dsw-specific-bubble': both(brand[50], dark['surface-2']),
    '--dsw-specific-bubble-highlight': both(brand[100], dark.border),
    '--dsw-specific-input-major': role('surface'),
    '--dsw-specific-selector': role('surface-2'),
    '--dsw-specific-tip': role('surface-2'),
    // The two sidebars are the same grey.
    '--dsw-specific-sidebar-fill': role('surface-1'),
    '--dsw-specific-sidebar-nav-item-active': both(brand[100], brand[900]),
    '--dsw-specific-sidebar-nav-item-hover': role('surface-2'),
    // Its one reader is the 「推荐」 badge of a question card, whose text is
    // the send button's fill; a light chip is the only ground that carries it
    // in both schemes (5.29:1).
    '--dsw-specific-sidebar-nav-item-active-accent': both(brand[100]),
    // Text. Secondary and tertiary each sit one step darker than the kernel's
    // own reading of them, so every text token but the caption clears 4.5:1 on
    // every light surface, and tertiary equals the shell's own `text-3`.
    '--dsw-alias-label-primary': role('text'),
    '--dsw-alias-label-secondary': role('text-2'),
    '--dsw-alias-label-tertiary': role('text-3'),
    '--dsw-alias-label-caption': both(n[600], n[500]),
    '--dsw-alias-label-dimmed': both(n[300], n[800]),
    '--dsw-alias-label-primary-dimmed': both(n[900], n[200]),
    '--dsw-alias-label-primary-bluish': both(brand[900], n[100]),
    // Borders: hairline to control boundary. `l4` backs every input and
    // elevated stroke, and is the 3:1 control edge.
    '--dsw-alias-border-l1': role('border-faint'),
    '--dsw-alias-border-l2': role('border-hairline'),
    '--dsw-alias-border-l2-darkmode-thin': both(n[200], dark['border-faint']),
    '--dsw-alias-border-l3': both(n[300], n[800]),
    '--dsw-alias-border-l4': role('border-control'),
    // States. Red is spent on danger alone; warning is amber, success green.
    '--dsw-alias-state-error-primary': role('danger'),
    '--dsw-alias-state-error-secondary': role('dot-failed'),
    '--dsw-alias-state-warn-primary': role('warn'),
    '--dsw-alias-state-warn-secondary': both(COLOR_RAMPS.warn[600], COLOR_RAMPS.warn[300]),
    '--dsw-alias-state-warn-tertiary': both(COLOR_RAMPS.warn[50], '#27241f'),
    '--dsw-alias-state-warn-label': role('warn'),
    '--dsw-alias-state-success-primary': role('ok'),
    '--dsw-alias-state-success-secondary': both(COLOR_RAMPS.ok[600], COLOR_RAMPS.ok[300]),
    '--dsw-alias-state-success-tertiary': both(COLOR_RAMPS.ok[50], '#233c2c'),
    // Type: the shell's one stack, and prose leading.
    '--dsw-font-family': both(FONT_STACKS.sans),
    '--dsw-font-markdown-base': prose(''),
    '--dsw-font-markdown-base-strong': prose(`${FONT_WEIGHTS.semibold} `),
    '--dsw-font-markdown-base-italic': prose('italic '),
    '--dsw-font-markdown-base-strong-italic': prose(`italic ${FONT_WEIGHTS.semibold} `),
    '--dsw-font-markdown-base-line-height': both(proseLine),
    '--dsw-font-markdown-base-strong-line-height': both(proseLine),
    '--dsw-font-markdown-base-italic-line-height': both(proseLine),
    '--dsw-font-markdown-base-strong-italic-line-height': both(proseLine),
  }
}
