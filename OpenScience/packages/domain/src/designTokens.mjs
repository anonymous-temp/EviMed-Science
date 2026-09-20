/**
 * The design tokens — one table, two consumers.
 *
 * Hidden knowledge: the shell and the kernel conversation are one product to a
 * reader and two codebases to us. Colour already crossed that boundary (both
 * sides resolved the accent to the same teal), but type and geometry did not:
 * the shell had serif page titles on a grey canvas with 32/36/40 px controls
 * and a 232 px sidebar, the kernel a single sans ladder on white with 32 px
 * controls and a 280 px sidebar, and the seam was visible in a screenshot. The
 * two tables that produced it — `apps/web/src/index.css` and
 * `packages/harness-port/src/runtimeUiTheme.mjs` — were both hand-maintained,
 * so "change it in both places" was an instruction, and an instruction is only
 * honest while the two agree.
 *
 * They now derive from here:
 *
 *  - `apps/web/src/index.css` carries a generated block (between the two
 *    markers below) written by `scripts/build/generate-design-tokens.mjs`;
 *    `apps/web/src/app/designTokens.test.ts` regenerates it and fails if the
 *    checked-in CSS differs. A generator whose output nobody checks is how the
 *    two tables drifted in the first place.
 *  - `apps/web/tailwind.config.js` imports the scales directly, so a Tailwind
 *    class and a CSS custom property cannot disagree about what `card` means.
 *  - `packages/harness-port/src/runtimeUiTheme.mjs` takes `kernelThemeTokens()`
 *    and hands it to the kernel's `ctx.theme.overrideTokens`. That is the whole
 *    of what the frame needs: the `--dsw-static-deepseek-*` ramp, the
 *    `--dsw-alias-*` roles and `--dsw-font-*` type.
 *
 * Nothing here is a decision this module gets to make on its own: the values
 * are the agreed target table of
 * `docs/ui-ux-audit/2026-09-20-产品现状根因分析与一次性整改方案.md` §3.12, and
 * `OpenScience/DESIGN.md` is its prose. Contrast figures in the `note` fields
 * are measured with the WCAG 2.1 relative-luminance formula — re-measure when
 * a value moves, never estimate.
 *
 * Reached through its own subpath (`@evimed/domain/design-tokens`), like the
 * delivery gate: sixty token names have no business in the root namespace.
 *
 * @module @evimed/domain/design-tokens
 */

/** Bumped when a consumer must be regenerated, not when a value is tuned. */
export const DESIGN_TOKENS_VERSION = '2.0.0'

/* ------------------------------------------------------------------ ramps -- */

/**
 * Theme-independent primitives. A role below points at a step; the dark theme
 * points the same role at a *different step* rather than inverting a colour.
 *
 * Brand and neutral are generated in OKLCH on one lightness ladder (50 98.0% ·
 * 100 95.8% · 200 91.2% · 300 84.5% · 400 76.0% · 500 67.2% · 600 58.5% ·
 * 700 50.5% · 800 43.2% · 900 36.0% · 950 26.8%) with chroma clamped into
 * sRGB, so "one step darker" is a computation rather than a guess.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const COLOR_RAMPS = Object.freeze({
  /** 循证青, OKLCH H=185. The one accent; see `accent` below. */
  brand: Object.freeze({
    50: '#f0fbf9',
    100: '#e1f7f3',
    200: '#c3ece6',
    300: '#98dbd2',
    400: '#63c5b9',
    500: '#26ac9f',
    600: '#008f84',
    700: '#00756b',
    800: '#005e56',
    900: '#004841',
    950: '#002d29',
  }),
  /**
   * Cool neutral, H=232 with chroma under 0.010 so it reads as paper rather
   * than as blue paper. `500` is 2.96:1 on white — never text, never a dot.
   * `control` is the one hand-placed step: the visible boundary of a control
   * needs 3:1 (WCAG 1.4.11) and no ladder step sat there.
   */
  n: Object.freeze({
    50: '#f8f8f9',
    100: '#f0f1f2',
    150: '#e9ebed',
    200: '#dfe2e4',
    300: '#c8cdcf',
    400: '#acb2b5',
    500: '#90979b',
    600: '#767d81',
    700: '#606669',
    800: '#4c5154',
    900: '#3a3e40',
    950: '#242628',
    control: '#8b9195',
  }),
  /** Dark surfaces on the same hue, one step lighter per layer. */
  dark: Object.freeze({
    bg: '#14181a',
    surface: '#1d2225',
    'surface-2': '#272d30',
    'border-faint': '#292f32',
    border: '#3a4044',
    'border-strong': '#646c71',
  }),
  danger: Object.freeze({
    50: '#fff6f5',
    100: '#ffecea',
    300: '#ffb7ae',
    400: '#ff8b7f',
    600: '#cf463e',
    700: '#af302b',
    800: '#8f2320',
    950: '#470f0d',
  }),
  warn: Object.freeze({
    50: '#fff7ef',
    100: '#ffeedc',
    300: '#efc392',
    400: '#e8a042',
    600: '#ab6c00',
    700: '#8c5700',
    800: '#704500',
    950: '#382000',
  }),
  ok: Object.freeze({
    50: '#f3fbf4',
    300: '#aadbb3',
    600: '#3a9052',
    700: '#25773e',
    800: '#1a5f30',
    950: '#082e14',
  }),
  info: Object.freeze({
    50: '#f4f9ff',
    100: '#e8f2ff',
    300: '#aacfff',
    400: '#79b4ff',
    600: '#1f7ae0',
    700: '#0362bf',
    800: '#004e9c',
    950: '#01254e',
  }),
})

/**
 * Resolve a role's value: either a literal (`#ffffff`, an `rgba()` scrim) or a
 * `<ramp>-<step>` reference such as `n-950` or `dark-surface-2`. The split is
 * at the first hyphen, which is why `dark`'s steps are named rather than
 * numbered.
 *
 * @param {string} reference
 * @returns {string} A CSS colour value.
 */
export function resolveColor(reference) {
  if (!reference.includes('-') || reference.startsWith('#') || reference.includes('(')) return reference
  const cut = reference.indexOf('-')
  const ramp = COLOR_RAMPS[reference.slice(0, cut)]
  const step = ramp?.[reference.slice(cut + 1)]
  if (!step) throw new Error(`design token: unknown colour reference "${reference}"`)
  return step
}

/* ------------------------------------------------------------------ roles -- */

/**
 * One semantic role.
 * @typedef {{ light: string, dark: string, note?: string }} ColorRole
 */

/**
 * The semantic layer. Every role is defined in both schemes; a value is a
 * reference into `COLOR_RAMPS` or a literal.
 *
 * The ladder, in the names the target table uses (§3.12), with the older names
 * kept beside them so a page written before this table keeps rendering:
 * `bg` → `surface-1` → `surface-2`; `border-hairline` / `border-control`;
 * `text` → `text-2` → `text-3`; `accent` / `accent-soft` / `accent-pressed`.
 *
 * @type {Readonly<Record<string, ColorRole>>}
 */
export const COLOR_ROLES = Object.freeze(
  /** @type {Record<string, ColorRole>} */ ({
    /* --- surfaces ------------------------------------------------------- */
    // The page is white, as the kernel's conversation is. The shell's cool
    // paper canvas was the loudest half of the seam: a grey page beside a
    // white conversation reads as two applications in one window.
    bg: { light: '#ffffff', dark: 'dark-bg' },
    // The card, dialog, menu and popover surface. In light it equals the page
    // and a 1 px hairline is the whole edge; in dark a card has to lift off
    // the canvas or it disappears.
    surface: { light: '#ffffff', dark: 'dark-surface' },
    // The one grey step: sidebar, table header, inset track, code block. It is
    // the kernel's `bg-layer-1` and its sidebar fill, so the two sidebars are
    // the same grey.
    'surface-1': { light: 'n-50', dark: 'dark-surface' },
    // Hover, the neutral selected row, a skeleton bar.
    'surface-2': { light: 'n-100', dark: 'dark-surface-2' },
    // Modal scrim. Not `black/30`: an opacity modifier on a Tailwind default
    // is a colour no theme switch can reach.
    scrim: { light: 'rgba(20, 24, 26, 0.32)', dark: 'rgba(0, 0, 0, 0.56)' },

    /* --- borders -------------------------------------------------------- */
    // Decoration: separators, a card's edge, a table rule.
    'border-hairline': { light: 'n-200', dark: 'dark-border' },
    'border-faint': { light: 'n-150', dark: 'dark-border-faint' },
    // The visible boundary of a control (WCAG 1.4.11 wants 3:1).
    'border-control': { light: 'n-control', dark: 'dark-border-strong', note: '3.19 on the page, 3.01 on surface-1' },

    /* --- text ----------------------------------------------------------- */
    text: { light: 'n-950', dark: 'n-100', note: '15.19 on the page, 13.43 on surface-2' },
    'text-2': { light: 'n-800', dark: 'n-300', note: '8.04 on the page, 7.11 on surface-2' },
    'text-3': { light: 'n-700', dark: 'n-400', note: '5.83 on the page, 5.16 on surface-2 — nothing lighter carries text' },

    /* --- accent --------------------------------------------------------- */
    // One accent for the primary action, the focus ring, the selected row and
    // the ✓ verified mark. White on it is 5.59:1, against 4.23:1 on the
    // kernel's own blue — which is why the frame takes ours rather than the
    // other way round.
    accent: { light: 'brand-700', dark: 'brand-400', note: '5.59 on the page; white on it 5.59' },
    'accent-fg': { light: '#ffffff', dark: 'dark-bg' },
    // Selected rows, the current sidebar row, the verified chip. Never text.
    'accent-soft': { light: 'brand-50', dark: 'brand-900' },
    // The pressed state of an accent surface.
    'accent-pressed': { light: 'brand-800', dark: 'brand-300' },
    // Text on `accent-soft`. Same step as `accent-pressed`, different job.
    'accent-strong': { light: 'brand-800', dark: 'brand-300', note: 'on accent-soft: 7.26 light, 6.69 dark' },

    /* --- status: colour is never the only carrier ----------------------- */
    ok: { light: 'ok-700', dark: 'ok-300' },
    'ok-soft': { light: 'ok-50', dark: 'ok-950' },
    warn: { light: 'warn-700', dark: 'warn-300' },
    'warn-soft': { light: 'warn-50', dark: 'warn-950' },
    'warn-strong': { light: 'warn-800', dark: 'warn-300', note: 'on warn-soft: 7.80' },
    // Red is spent on danger and unhandled work, and on nothing else.
    error: { light: 'danger-700', dark: 'danger-300', note: '6.40 on the page' },
    'error-fg': { light: '#ffffff', dark: 'dark-bg' },
    danger: { light: 'danger-700', dark: 'danger-300' },
    'danger-soft': { light: 'danger-50', dark: 'danger-950' },
    'danger-strong': { light: 'danger-800', dark: 'danger-300', note: 'on danger-soft: 8.13' },
    info: { light: 'info-700', dark: 'info-300' },
    'info-soft': { light: 'info-50', dark: 'info-950' },
    // Links are not the brand, so a page full of citations never drowns the
    // primary button.
    link: { light: 'info-700', dark: 'info-300', note: '5.99 on the page' },

    /* --- product marks -------------------------------------------------- */
    // A verified claim, in the brand colour on purpose.
    'verify-ok': { light: 'brand-700', dark: 'brand-300' },
    // "Needs checking" is amber and never red: it is not a clinical alarm.
    'verify-pending': { light: 'warn-800', dark: 'warn-300' },
    // A located quotation in a preserved source; body text on it still reads.
    highlight: { light: 'warn-300', dark: 'warn-800' },
    focus: { light: 'brand-700', dark: 'brand-400', note: '2 px ring, 5.59 light / 8.69 dark' },
    badge: { light: 'danger-700', dark: 'danger-600', note: 'unread count; white on it 6.40 / 4.57' },
    'badge-fg': { light: '#ffffff', dark: '#ffffff' },

    /* --- run-state dots: graphics, 3:1, always beside a shape and a word - */
    'dot-running': { light: 'info-600', dark: 'info-400' },
    'dot-done': { light: 'brand-600', dark: 'brand-400' },
    'dot-review': { light: 'warn-600', dark: 'warn-400' },
    'dot-failed': { light: 'danger-600', dark: 'danger-400' },
    'dot-canceled': { light: 'n-600', dark: 'n-500' },

    /* --- chart chrome --------------------------------------------------- */
    'chart-grid': { light: 'n-200', dark: 'dark-border' },
    'chart-axis': { light: 'n-control', dark: 'dark-border-strong' },
  }),
)

/**
 * Names kept so a page written against the older table keeps rendering, each
 * pointing at the role that replaced it. They are emitted as CSS variables
 * too; `DESIGN.md` names the replacement, and the parallel page rewrites are
 * what removes the call sites.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const COLOR_ROLE_ALIASES = Object.freeze({
  border: 'border-hairline',
  'border-strong': 'border-control',
  muted: 'text-3',
})

/**
 * Eight categorical chart slots in a fixed order — never cycled — shared with
 * `@ai4s/shared`'s `CHART_PALETTE_*` and
 * `runtime/skills/core/publication-figures/openscience.mplstyle`. Change all
 * three together and re-run the dataviz validator. The *order* is the
 * colour-vision mechanism, not decoration.
 *
 * @type {Readonly<{ light: readonly string[], dark: readonly string[] }>}
 */
export const CHART_SERIES = Object.freeze({
  light: Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']),
  dark: Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']),
})

/**
 * A role's value in one scheme.
 * @param {string} role
 * @param {'light' | 'dark'} scheme
 * @returns {string}
 */
export function colorRole(role, scheme) {
  const entry = COLOR_ROLES[role] ?? COLOR_ROLES[COLOR_ROLE_ALIASES[role] ?? '']
  if (!entry) throw new Error(`design token: unknown colour role "${role}"`)
  return resolveColor(entry[scheme])
}

/* ------------------------------------------------------------------- type -- */

/**
 * One sans stack for the shell and the frame. Latin faces lead so numbers,
 * DOIs and identifiers keep the metrics the scale was measured against; then
 * every Chinese face a reader's OS might carry — without named CJK faces
 * Windows falls to the bitmap-hinted SimSun.
 *
 * There is no serif family: page titles were Source Serif 4 / 宋体 while the
 * conversation beside them was sans, and that was half the seam. Mono stays —
 * an identifier is compared character by character.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FONT_STACKS = Object.freeze({
  sans: 'Inter, system-ui, "PingFang SC", "HarmonyOS Sans SC", MiSans, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace',
})

/**
 * The closed size scale, in px. A size outside it is a defect:
 * `designTokens.test.ts` asserts the rungs below use exactly these six.
 * @type {readonly number[]}
 */
export const TYPE_SIZES = Object.freeze([12, 13, 14, 16, 20, 24])

/** The only three weights. Chinese screen faces without a 500 cut fall to 400. */
export const FONT_WEIGHTS = Object.freeze({ regular: 400, medium: 500, semibold: 600 })

/**
 * A named rung.
 * @typedef {{ size: number, lineHeight: string, use: string }} TypeRung
 */

/**
 * The rungs, by what they are for. Eight names over six sizes: the two pairs
 * that share a size differ only in leading, because a count inside a pill and
 * a line of metadata cannot have the same line box.
 *
 * Line height is 22 px for interface text, 1.75 for prose and 1.3 for
 * headings. No letter-spacing anywhere — tracking on Chinese breaks the
 * character grid.
 *
 * @type {Readonly<Record<string, TypeRung>>}
 */
export const TYPE_SCALE = Object.freeze(
  /** @type {Record<string, TypeRung>} */ ({
    badge: { size: 12, lineHeight: '1', use: 'a count inside a pill' },
    meta: { size: 12, lineHeight: '1.5', use: 'the densest metadata: timestamps, counts, units' },
    caption: { size: 13, lineHeight: '20px', use: 'captions and secondary one-liners' },
    ui: { size: 14, lineHeight: '22px', use: 'interface text, chat, list rows, controls — the default' },
    // Retired: the 13 px `ui-sm` and the 13.5 px `ui` were one rung half a
    // pixel apart. Kept as an alias so an unmigrated class renders at `ui`;
    // ESLint rejects new uses.
    'ui-sm': { size: 14, lineHeight: '22px', use: 'retired alias of `ui`' },
    body: { size: 16, lineHeight: '1.75', use: 'report prose and the reading column' },
    wordmark: { size: 16, lineHeight: '1.3', use: 'the EviMed lockup in the sidebar' },
    title: { size: 20, lineHeight: '1.3', use: 'every page H1' },
    display: { size: 24, lineHeight: '1.3', use: 'the home hero, the login page, a full-page empty state' },
  }),
)

/* --------------------------------------------------------------- geometry -- */

/**
 * Base 4, and six steps. `cardPadding` / `gridGap` / `pageGutter` are the
 * three that were hand-picked per page before this table existed.
 */
export const SPACE = Object.freeze({
  base: 4,
  scale: Object.freeze([8, 12, 16, 24, 32, 48]),
  cardPadding: 16,
  gridGap: 12,
  pageGutter: 24,
  sectionGap: 32,
})

/**
 * Container widths. A page's title, its description and its body share one of
 * these — `PageShell` is what makes that structural rather than a convention,
 * after three pages shipped with five different left edges.
 *
 * `full` is retired: it was 1120 px, and a wide page is 1000. It points at
 * `wide` so an unmigrated call site converges instead of breaking.
 */
export const CONTAINERS = Object.freeze({
  narrow: 560,
  content: 748,
  wide: 1000,
  full: 1000,
  sidebar: 280,
  sidebarCollapsed: 56,
})

/** Radii, by what wears them. */
export const RADII = Object.freeze({
  control: 8,
  card: 12,
  panel: 16,
  composer: 24,
  chip: 999,
})

/** Control heights. 40 is a form's primary button and nothing else. */
export const CONTROL_HEIGHTS = Object.freeze({
  chip: 28,
  control: 32,
  row: 36,
  formPrimary: 40,
  bar: 44,
})

/** Two icon sizes: inline with text, and a chrome glyph. */
export const ICON_SIZES = Object.freeze({ inline: 16, chrome: 20 })

/**
 * Three levels. A static card is flat — its 1 px hairline is its whole edge —
 * and only what genuinely floats casts a shadow.
 */
export const ELEVATION = Object.freeze({
  flat: 'none',
  pop: '0 4px 16px rgba(20, 24, 26, 0.10), 0 1px 3px rgba(20, 24, 26, 0.06)',
  modal: '0 16px 48px rgba(20, 24, 26, 0.18), 0 2px 8px rgba(20, 24, 26, 0.08)',
})

/** Two durations and one easing: a state change, and a container. */
export const MOTION = Object.freeze({
  fast: '120ms',
  base: '200ms',
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
})

/* ---------------------------------------------------------- generated CSS -- */

/** The markers `apps/web/src/index.css` carries around the generated block. */
export const DESIGN_TOKENS_CSS_BEGIN = '/* >>> generated from @evimed/domain/design-tokens — run `pnpm tokens:css` <<< */'
/** @see DESIGN_TOKENS_CSS_BEGIN */
export const DESIGN_TOKENS_CSS_END = '/* >>> end generated <<< */'

/**
 * @param {string} name
 * @param {string} value
 * @param {string} [note]
 * @returns {string}
 */
function declaration(name, value, note) {
  return `  --${name}: ${value};${note ? ` /* ${note} */` : ''}`
}

/**
 * A role's CSS value: a `var()` back at the primitive when it references one,
 * so the generated file still reads as a ladder rather than as 60 hex codes.
 *
 * @param {string} reference
 * @returns {string}
 */
function cssColorValue(reference) {
  if (reference.startsWith('#') || reference.includes('(')) return reference
  resolveColor(reference) // throws on an unknown reference
  return `var(--${reference})`
}

/**
 * The block that lives in `apps/web/src/index.css`, markers included.
 *
 * Deterministic: the same module produces the same bytes, which is what lets
 * the test compare them. It carries the primitives, both theme layers, and the
 * geometry and motion a stylesheet outside Tailwind's reach needs.
 *
 * @returns {string}
 */
export function designTokensCss() {
  /** @type {string[]} */
  const lines = []
  lines.push(DESIGN_TOKENS_CSS_BEGIN)
  lines.push('/* Primitive ramps. Theme-independent: a role below points at a step, and')
  lines.push('   the dark theme points the same role at a different step rather than')
  lines.push('   inverting a colour. See packages/domain/src/designTokens.mjs. */')
  lines.push(':root {')
  for (const [ramp, steps] of Object.entries(COLOR_RAMPS)) {
    for (const [step, value] of Object.entries(steps)) {
      lines.push(declaration(`${ramp}-${step}`, value))
    }
  }
  lines.push('}')
  lines.push('')
  lines.push('/* The semantic layer. Contrast notes are measured with the WCAG 2.1')
  lines.push('   relative-luminance formula — re-measure, never estimate. */')
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    lines.push(scheme === 'light' ? ':root,\n[data-theme="light"] {' : '[data-theme="dark"] {')
    // Native controls — scrollbars, a select's list, date pickers — draw in
    // the same scheme as the tokens around them.
    lines.push(`  color-scheme: ${scheme};`)
    for (const [role, entry] of Object.entries(COLOR_ROLES)) {
      lines.push(declaration(role, cssColorValue(entry[scheme]), scheme === 'light' ? entry.note : undefined))
    }
    for (const [alias, role] of Object.entries(COLOR_ROLE_ALIASES)) {
      lines.push(declaration(alias, `var(--${role})`, scheme === 'light' ? `retired name of --${role}` : undefined))
    }
    CHART_SERIES[scheme].forEach((value, index) => lines.push(declaration(`series-${index + 1}`, value)))
    lines.push('}')
    lines.push('')
  }
  lines.push('/* Type, geometry and motion: theme-independent, and readable from a')
  lines.push('   stylesheet that Tailwind does not compile (the kernel frame\'s own). */')
  lines.push(':root {')
  lines.push(declaration('font-sans', FONT_STACKS.sans))
  lines.push(declaration('font-mono', FONT_STACKS.mono))
  for (const [rung, { size, lineHeight }] of Object.entries(TYPE_SCALE)) {
    lines.push(declaration(`text-${rung}`, `${size}px`))
    lines.push(declaration(`leading-${rung}`, lineHeight))
  }
  for (const [name, value] of Object.entries(RADII)) {
    lines.push(declaration(`radius-${name}`, `${value}px`))
  }
  for (const [name, value] of Object.entries(CONTROL_HEIGHTS)) {
    lines.push(declaration(`height-${name}`, `${value}px`))
  }
  for (const [name, value] of Object.entries(CONTAINERS)) {
    lines.push(declaration(`width-${name}`, `${value}px`))
  }
  lines.push(declaration('shadow-pop', ELEVATION.pop))
  lines.push(declaration('shadow-modal', ELEVATION.modal))
  lines.push(declaration('dur-fast', MOTION.fast))
  lines.push(declaration('dur-base', MOTION.base))
  lines.push(declaration('ease-standard', MOTION.easeStandard))
  lines.push('}')
  lines.push(DESIGN_TOKENS_CSS_END)
  return lines.join('\n')
}

/* ------------------------------------------------------- the kernel frame -- */

/**
 * The frame's override layer: token name → `{ light, dark }`, ready for the
 * kernel's `ctx.theme.overrideTokens(source, tokens)`.
 * `packages/harness-port/src/runtimeUiTheme.mjs` is its only consumer and owns
 * the seam; this function owns the values, so the shell and the conversation
 * cannot disagree about what teal is.
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
 *    brand's 700 step is 5.59:1 in both.
 *  - The menu surfaces derive from `bg-layer-3` upstream; left there they turn
 *    grey, so they are set to the popover surface, as in the shell.
 *
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
  const prose = (lead) => both(`${lead}var(--dsh-content-font-size, ${TYPE_SCALE.ui.size}px) / ${proseLine} var(--dsw-font-family)`)
  return {
    // The ramp, by what still reads it. 500 + 200: the working line is a
    // lightness shimmer between the quiet text colour and the loud one, no hue.
    '--dsw-static-deepseek-500': role('text-3'),
    '--dsw-static-deepseek-200': role('text'),
    // 450: the running dot is info blue (a graphic needs 3:1; the brand's own
    // 500 step would be 2.81:1).
    '--dsw-static-deepseek-450': role('dot-running'),
    // No direct reader left; the brand steps, for anything added later.
    '--dsw-static-deepseek-50': both(brand[50]),
    '--dsw-static-deepseek-100': both(brand[100]),
    '--dsw-static-deepseek-400': both(brand[400]),
    // Accents.
    '--dsw-alias-button-info-fill': both(brand[700]),
    '--dsw-alias-button-info-hover': both(brand[800]),
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
    // in both schemes (5.00:1).
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
