/**
 * The design tokens — one table, seven generated artifacts.
 *
 * Hidden knowledge: EviMed and EviMed Science are one product to a reader and
 * two codebases to us — a Vue shell, a React surface, and a third-party
 * conversation kernel inside a cross-origin frame. Colour, type and geometry
 * all cross that boundary. Every time the boundary was maintained by hand the
 * two sides drifted, twice within a month (2026-09-20, 2026-09-23), because
 * "change it in both places" is an instruction and an instruction is only
 * honest while the two agree.
 *
 * So the table lives here once and is *generated* into everything that reads
 * it (fusion plan §6.1):
 *
 *  - `dist/tokens.css`         CSS custom properties — both front ends link it
 *  - `dist/tailwind-preset.js` a Tailwind preset — both `tailwind.config.js`
 *                              files extend it
 *  - `dist/element-plus.css`   Element Plus theme variables, for the Vue shell
 *  - `dist/echarts-theme.json` the ECharts theme both sides register
 *  - `dist/dsh-theme.json`     `ctx.theme.overrideTokens` for the kernel frame
 *  - `dist/figma-tokens.json`  Tokens Studio, so a design file cannot invent a
 *                              colour the code does not have
 *  - `dist/dtcg/`              the DTCG 2025.10 export (2.1): a base file, one
 *                              file per theme and motion setting, and a
 *                              resolver — the subset Figma's native variable
 *                              import accepts, one file per mode
 *
 * `scripts/build/generate-design-tokens.mjs --check` and
 * `apps/web/src/app/designTokens.test.ts` both regenerate and compare, so a
 * stale artifact is a red test rather than a shell and a stylesheet that
 * disagree about their palette.
 *
 * Values follow the owner-approved warm-paper and terracotta direction
 * (2026-10-26). `OpenScience/DESIGN.md` is the design language in prose. Contrast figures in the `note` fields
 * are measured with the WCAG 2.1 relative-luminance formula — `contrast.mjs`
 * recomputes them at build time and fails the build on a shortfall, so a note
 * cannot quietly become fiction.
 *
 * @module @evimed/design-tokens
 */

/**
 * The table's version, semantic: a removed or re-meant token is a major, a
 * new token a minor, a tuned value a patch. It moves whenever an artifact's
 * bytes do — `src/release.json` records the digest of the artifacts this
 * version shipped, and `generate.mjs --check` fails when the artifacts change
 * under an unchanged version (fusion audit F-G3: 646d165d5 moved six ramp
 * steps and the version still read 2.0.0, so "both sides pin one version"
 * could not see the drift).
 */
export const DESIGN_TOKENS_VERSION = '3.0.0'

/* ------------------------------------------------------------------ ramps -- */

/**
 * Theme-independent primitives. A role below points at a step; the dark theme
 * points the same role at a *different step* rather than inverting a colour.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const COLOR_RAMPS = Object.freeze({
  /** Terracotta actions; the logo has its own neutral brand-ink role. */
  brand: Object.freeze({
    50: '#fbefe8',
    100: '#f6dfd1',
    200: '#edbfa7',
    300: '#e3a385',
    400: '#d98c6b',
    500: '#bc6442',
    600: '#a34427',
    700: '#8d3922',
    800: '#71301f',
    900: '#55281d',
    950: '#321c16',
  }),
  /**
   * Warm paper and ink. The control step is measured separately because a
   * meaningful control boundary needs 3:1 on every surface it occupies.
   */
  n: Object.freeze({
    0: '#fffdf8',
    25: '#f7f5ef',
    50: '#f2efe7',
    100: '#ebe7de',
    150: '#e3ded3',
    200: '#d6d0c4',
    300: '#bcb5a9',
    400: '#9b9387',
    500: '#686157',
    600: '#645c52',
    700: '#494239',
    800: '#36302a',
    900: '#24211e',
    950: '#191714',
    control: '#8c8173',
  }),
  /** Dark ink surfaces, one step lighter per layer. */
  dark: Object.freeze({
    bg: '#171512',
    surface: '#211e1a',
    'surface-2': '#2a2621',
    'border-faint': '#2a2621',
    border: '#342f29',
    'border-strong': '#81766a',
  }),
  /** Clinical safety, deletion and severe errors use a distinct crimson. */
  danger: Object.freeze({
    50: '#fdf0f2',
    100: '#f9dfe4',
    300: '#e58b9c',
    400: '#d75d78',
    600: '#ad2f45',
    700: '#97263a',
    800: '#822235',
    950: '#3b121c',
  }),
  /** Needs attention, not danger: an unverified quotation, a paused probe. */
  warn: Object.freeze({
    50: '#fff5e5',
    100: '#ffeacc',
    300: '#e0b169',
    400: '#c98a1f',
    600: '#925100', // Keeps attention text readable on the deepest paper surface.
    700: '#8c5000',
    800: '#7f4800',
    950: '#331d00',
  }),
  /** Live, passed, a move in the wanted direction. */
  ok: Object.freeze({
    50: '#eaf5ef',
    100: '#d5ebdf',
    300: '#7cc0a0',
    400: '#3f9c73',
    600: '#1a6f44', // Keeps completed-state text readable on the deepest paper surface.
    700: '#1a6a42',
    800: '#155636',
    950: '#082418',
  }),
  /** Deep navy information, independent from actions and safety. */
  info: Object.freeze({
    50: '#eaf0f5',
    100: '#dfe5e9',
    300: '#9bbbd5',
    400: '#8ba3b3',
    600: '#526c7d',
    700: '#18324d',
    800: '#354957',
    950: '#142330',
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
 * @type {Readonly<Record<string, ColorRole>>}
 */
export const COLOR_ROLES = Object.freeze(
  /** @type {Record<string, ColorRole>} */ ({
    /* --- surfaces ------------------------------------------------------- */
    // The warm-paper canvas separates a lighter reading surface without a
    // border; the kernel frame takes the same value, so the conversation and
    // the shell around it are still one surface.
    bg: { light: 'n-25', dark: 'dark-bg' },
    // The card, dialog, menu, popover and reading surface.
    surface: { light: 'n-0', dark: 'dark-surface' },
    // Sidebar, table header, inset track, code block — the kernel's
    // `bg-layer-1` and its sidebar fill, so the two sidebars are one grey.
    'surface-1': { light: 'n-50', dark: 'dark-surface' },
    // Hover, the neutral selected row, a skeleton bar, a secondary button.
    'surface-2': { light: 'n-100', dark: 'dark-surface-2' },
    // The hover and pressed step of something already on surface-2.
    'surface-3': { light: 'n-150', dark: 'dark-border' },
    // Modal scrim. Not `black/30`: an opacity modifier on a Tailwind default
    // is a colour no theme switch can reach.
    scrim: { light: 'rgba(36, 33, 30, 0.32)', dark: 'rgba(0, 0, 0, 0.56)' },

    /* --- borders -------------------------------------------------------- */
    // Decoration: separators, a card's edge, a table rule.
    'border-hairline': { light: 'n-150', dark: 'dark-border' },
    'border-faint': { light: 'n-100', dark: 'dark-border-faint' },
    // A pill or segment whose ground already separates it from the page.
    'border-light': { light: 'n-200', dark: 'dark-border' },
    // The visible boundary of a control (WCAG 1.4.11 wants 3:1).
    'border-control': { light: 'n-control', dark: 'dark-border-strong', note: '3.50 on the page, 3.32 on the sidebar' },

    /* --- text ----------------------------------------------------------- */
    text: { light: 'n-900', dark: '#f2eee6', note: '14.69 on the page' },
    'text-2': { light: 'n-700', dark: '#d1c8ba', note: '9.08 on the page' },
    'text-3': { light: 'n-500', dark: '#a99e8f', note: '5.61 on the page, 5.32 on the sidebar — nothing lighter carries text' },
    // Document titles use warm ink; a read row steps down to text-2.
    'title-ink': { light: 'n-900', dark: '#f2eee6', note: '14.69 on the page' },
    // Decorative icons and rules only. Meaningful graphics have their own
    // measured 3:1 roles; contrast.mjs prevents status dots borrowing this one.
    'text-graphic': { light: 'n-400', dark: 'n-600', note: 'decorative graphics only, 2.78 on the page — never text, never a status' },

    // Identity is neutral ink; actions retain their separate terracotta role.
    'brand-ink': { light: 'n-900', dark: 'n-25' },

    /* --- accent --------------------------------------------------------- */
    // One accent: primary actions, links, button focus, selected rows and
    // "our" comparison series. Verification and information have separate roles.
    accent: { light: 'brand-600', dark: 'brand-400', note: '5.64 on the page; white on it 6.15' },
    'accent-fg': { light: '#ffffff', dark: 'dark-bg' },
    // Selected rows and the current sidebar row. Never text.
    'accent-soft': { light: 'brand-50', dark: 'brand-950' },
    // The pressed state of an accent surface.
    'accent-pressed': { light: 'brand-700', dark: 'brand-300' },
    // Text on `accent-soft`. Same step as the ramp's 800, different job.
    'accent-strong': { light: 'brand-800', dark: 'brand-300', note: 'on accent-soft: 8.68' },

    /* --- status: colour is never the only carrier ----------------------- */
    ok: { light: 'ok-600', dark: 'ok-300' },
    'ok-soft': { light: 'ok-50', dark: 'ok-950' },
    warn: { light: 'warn-600', dark: 'warn-300' },
    'warn-soft': { light: 'warn-50', dark: 'warn-950' },
    'warn-strong': { light: 'warn-800', dark: 'warn-300', note: 'on warn-soft: 6.87' },
    // Red is spent on clinical safety, deletion and a severe error, and on
    // nothing else. Low certainty is not red: it is a shorter confidence bar.
    error: { light: 'danger-600', dark: 'danger-300', note: '5.89 on the page' },
    'error-fg': { light: '#ffffff', dark: 'dark-bg' },
    danger: { light: 'danger-600', dark: 'danger-300' },
    'danger-soft': { light: 'danger-50', dark: 'danger-950' },
    'danger-strong': { light: 'danger-800', dark: 'danger-300', note: 'on danger-soft: 8.49' },
    info: { light: 'info-700', dark: 'info-300' },
    'info-soft': { light: 'info-50', dark: 'info-950' },
    // Links wear the accent: one accent colour on the whole product.
    link: { light: 'brand-600', dark: 'brand-400', note: '5.64 on the page' },

    /* --- product marks -------------------------------------------------- */
    // A verified claim uses success green, independent from the action accent.
    'verify-ok': { light: 'ok-600', dark: 'ok-300' },
    // "Needs checking" is amber and never red: it is not a clinical alarm.
    'verify-pending': { light: 'warn-600', dark: 'warn-300' },
    // A located quotation in a preserved source, and a search hit. Body text
    // on it still reads.
    highlight: { light: '#fdeba8', dark: 'warn-800' },
    focus: { light: 'brand-600', dark: 'brand-400', note: '2 px ring, 5.64 on the page' },
    // Field focus uses identity ink; buttons and links keep accent focus.
    'focus-input': { light: 'n-900', dark: 'n-25' },
    badge: { light: 'danger-600', dark: 'danger-600', note: 'unread count; white on it 6.42' },
    'badge-fg': { light: '#ffffff', dark: '#ffffff' },
    // The membership card's one gradient — the single brand moment a settings
    // page is allowed.
    'member-from': { light: '#f6d58e', dark: '#7a6329' },
    'member-to': { light: '#fbe7be', dark: '#5c4a1d' },

    /* --- run-state dots: graphics, 3:1, always beside a shape and a word - */
    // Every dot clears 3:1 on the canvas, cards and sidebar in both themes.
    // Dots always accompany a shape and a word.
    'dot-running': { light: 'info-700', dark: 'info-300' },
    'dot-done': { light: 'ok-600', dark: 'ok-300' },
    'dot-review': { light: 'warn-600', dark: 'warn-400' },
    'dot-failed': { light: 'danger-600', dark: 'danger-400' },
    'dot-canceled': { light: 'n-control', dark: 'n-control' },

    /* --- chart chrome --------------------------------------------------- */
    'chart-grid': { light: 'n-150', dark: 'dark-border' },
    'chart-axis': { light: 'n-control', dark: 'dark-border-strong' },
    // The measurement noise band behind a trend line: inside it, a move is
    // "持平" rather than a change.
    'chart-band': { light: 'brand-50', dark: 'brand-950' },
    // The target line.
    'chart-target': { light: 'n-700', dark: 'n-300' },
  }),
)

/**
 * Names kept so a page written against the older table keeps rendering, each
 * pointing at the role that replaced it. They are emitted as CSS variables
 * too; `DESIGN.md` names the replacement, and the page rewrites are what
 * removes the call sites.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const COLOR_ROLE_ALIASES = Object.freeze({
  border: 'border-hairline',
  'border-strong': 'border-control',
  muted: 'text-3',
})

/**
 * What changes when the reader asks the system for more contrast
 * (`prefers-contrast: more`, spec §10.9): secondary text and every rule step
 * one shade towards the text colour, in both schemes. Only these roles move;
 * the rest of the table already clears its floor. `contrast.mjs` measures the
 * whole rule list again with these in place, so "more" can never mean less.
 *
 * @type {Readonly<Record<string, ColorRole>>}
 */
export const COLOR_ROLES_MORE_CONTRAST = Object.freeze(
  /** @type {Record<string, ColorRole>} */ ({
    'text-2': { light: 'n-800', dark: '#f2eee6' },
    'text-3': { light: 'n-700', dark: '#d1c8ba' },
    'text-graphic': { light: 'n-500', dark: 'n-400' },
    'border-hairline': { light: 'n-300', dark: 'dark-border-strong' },
    'border-light': { light: 'n-control', dark: 'dark-border-strong' },
    'border-control': { light: 'n-600', dark: 'n-300' },
  }),
)

/* ------------------------------------------------------------------- data -- */

/**
 * Data colour, which is a different problem from interface colour: a series is
 * identified by its colour and nothing else, so the set is closed and ordered.
 *
 * Three groups, and which one a chart uses is decided by whether the chart has
 * an "us":
 *
 *  - `own` + `rivals`: a comparison. Ours is always the brand; every
 *    competitor is a grey, darkest for the highest rank. A chart of eight
 *    rainbow brands tells a reader nothing about which one is theirs, and the
 *    GEO dashboard shipped exactly that.
 *  - `series`: no "us" — study types, source kinds. Fixed order, never cycled;
 *    the order is the colour-vision mechanism, not decoration.
 *  - `heat`: one hue, six lightness steps. Never red-to-green: that pair is
 *    invisible to 8% of men and means the opposite in a Chinese market chart.
 *
 * Shared with `@ai4s/shared`'s `CHART_PALETTE_*` and
 * `runtime/skills/core/publication-figures/openscience.mplstyle` — change all
 * three together and re-run the dataviz validator.
 */
export const CHART_COLORS = Object.freeze({
  own: COLOR_RAMPS.brand[600],
  // Darkest for the highest rank; every grey clears 3:1 on warm paper and
  // on the dark canvas. Scientific category colours below remain stable.
  rivals: Object.freeze(['#626a73', '#737c85', '#838c95']),
  series: Object.freeze(['#0a5dc1', '#e07b39', '#1d9a87', '#7b5cd6', '#c94f7c', '#c7a12b', '#5a626b', '#b4bcc5']),
  // Step 4 was #3e7ed4: white on it was 4.09:1 and the body colour 4.06:1, so the number in a heat cell of that step failed both
  // (axe color-contrast on the 引擎读数 and 试验设计 heat tables, r19-guards2). #2e73cf carries white at 4.70:1.
  heat: Object.freeze(['#f3f6fa', '#dce8f7', '#b3cdef', '#7fa9e3', '#2e73cf', '#0a5dc1']),
  /** Only for defects and safety: S3 severe, S2 moderate, S1 minor. */
  severity: Object.freeze({ s3: '#c0362c', s2: '#e0877f', s1: '#939ca6' }),
  /**
   * Data with a midpoint — an effect size, a change against a baseline: blue
   * at one end, a light grey middle, orange at the other (spec §32.4). The two
   * arms are matched step for step in CIE lightness (L* 41 / 62 / 84 either
   * side of a 95 middle), so neither end reads as the louder one; the orange
   * is the categorical slot-2 hue; neither arm follows the action accent. Seven steps, index 3 is
   * the midpoint. Never red to green, for the reason the heat ramp is not.
   */
  diverging: Object.freeze(['#0a5dc1', '#5f97e0', '#bcd3f3', '#edf0f3', '#f9c7ab', '#dd7b3c', '#9f4600']),
  /**
   * A cell with no reading. A grey darker than the midpoint and without a hue,
   * so "not measured" never passes for "no change"; a chart still names it in
   * its legend.
   */
  missing: '#bac2ca',
})

/**
 * Eight categorical chart slots in a fixed order, per scheme.
 * @type {Readonly<{ light: readonly string[], dark: readonly string[] }>}
 */
/**
 * Our own series, per scheme. One value served both until 2.1.2, and on a dark
 * card `#0a5dc1` measured 2.76:1 — under the 3:1 a line or a mark needs (WCAG
 * 1.4.11, spec §32.4); the dark scheme takes brand-400, its accent everywhere
 * else. `CHART_COLORS.own` stays the light value for single-scheme exports.
 */
export const CHART_OWN = Object.freeze({
  light: CHART_COLORS.own,
  dark: COLOR_RAMPS.brand[400],
})

export const CHART_SERIES = Object.freeze({
  light: CHART_COLORS.series,
  dark: Object.freeze(['#5690dd', '#e8975f', '#3fb5a2', '#9b82e2', '#d7749a', '#d4b551', '#8a939c', '#c8cfd6']),
})

/**
 * Study-type badges: a soft ground with its own deep text, one pair per kind.
 * A reader tells an RCT from a guideline at a glance, before reading a word.
 *
 * @type {Readonly<Record<string, { fg: string, bg: string, label: string }>>}
 */
export const STUDY_TYPE_BADGES = Object.freeze({
  synthesis: Object.freeze({ fg: '#0c3e7f', bg: '#eef4fc', label: 'Meta 分析 / 系统综述' }),
  rct: Object.freeze({ fg: '#8a4b12', bg: '#fcf0e4', label: '随机对照试验' }),
  guideline: Object.freeze({ fg: '#5b3fb0', bg: '#f2eefc', label: '指南' }),
  label: Object.freeze({ fg: '#0f6b5e', bg: '#e8f5f2', label: '说明书' }),
  other: Object.freeze({ fg: '#3e454d', bg: '#edf0f3', label: '其他研究' }),
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
 * The typefaces, 2.1 (spec §5.1). Latin faces lead so numbers, DOIs, doses and
 * identifiers keep the metrics the scale was measured against; then every
 * Chinese face a reader's OS might carry — without named CJK faces Windows
 * falls to the bitmap-hinted SimSun. Three things changed from 2.0:
 *
 *  - **A punctuation face comes first.** Inter's Latin subset covers the
 *    general-punctuation block, so a Chinese “quotation” and a …… were drawn
 *    in Inter's Latin shapes: narrow quotes, an ellipsis sitting on the
 *    baseline. "EviMed CJK Punct" is those few code points only
 *    (`CJK_PUNCT_RANGE`), taken from the reader's own Chinese system face
 *    (`CJK_PUNCT_FACES`, `local()` sources — nothing new travels over the wire
 *    and no font package enters the lockfile). Text marked English
 *    (`[lang|="en"]`) takes `FONT_STACKS_EN`, which leaves it out.
 *  - **`system-ui` moved to the end.** On a Simplified Chinese Windows it *is*
 *    Microsoft YaHei UI, and in second place it shadowed every Chinese face
 *    after it. HarmonyOS Sans SC and MiSans are gone: on a desktop they only
 *    ever matched a font the reader installed, and on the phones that ship
 *    them they are the system face anyway.
 *  - **The serif ends in a sans.** Windows has no bold 宋体, so a 600 serif
 *    title fell to a regular-only SimSun and looked thin. The serif stack's
 *    Chinese part now ends in PingFang / YaHei: on Windows a document title is
 *    a bold 黑体.
 *
 * The serif is confined to the wordmark, the home headline and the title of a
 * document (§3.4) — the three rungs below with `family: 'serif'` — and the
 * generated stylesheet binds the family to those rung classes, so a page never
 * names the serif itself.
 *
 * @type {Readonly<Record<'sans' | 'serif' | 'mono', string>>}
 */
export const FONT_STACKS = Object.freeze({
  sans: '"EviMed CJK Punct", Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif',
  serif:
    '"EviMed CJK Punct Serif", "Source Serif 4", "Songti SC", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace',
})

/**
 * The same stacks without the punctuation face, for text marked English: an
 * English quotation keeps its own Latin quotes and dashes.
 *
 * @type {Readonly<Record<'sans' | 'serif', string>>}
 */
export const FONT_STACKS_EN = Object.freeze({
  sans: FONT_STACKS.sans.replace('"EviMed CJK Punct", ', ''),
  serif: FONT_STACKS.serif.replace('"EviMed CJK Punct Serif", ', ''),
})

/**
 * The code points the punctuation face covers: the em dash (a Chinese ——),
 * the single and double quotation marks, and the ellipsis. Every other
 * character falls through to the next face in the stack.
 */
export const CJK_PUNCT_RANGE = 'U+2014, U+2018-2019, U+201C-201D, U+2026'

/**
 * One `@font-face` of the punctuation face.
 * @typedef {{ family: string, weight: number, local: readonly string[] }} PunctFace
 */

/**
 * Where the punctuation face comes from: the reader's own Chinese system face,
 * by the full and PostScript names each platform publishes (macOS, Windows,
 * Android and most Linux, Source Han installs). Two weights, because Chinese
 * hierarchy is 400 and 600 only (§5.3). The serif's 600 ends in YaHei Bold for
 * the reason its stack does: Windows has no bold 宋体.
 *
 * The spec's first design was a 1.5 KB subset of Noto Sans SC inlined per
 * weight; `local()` gives the same glyphs from the font already on the
 * machine, without a binary in the repository or a package in the lockfile.
 * Where none of these faces exists the face does not load, and the stack falls
 * through to Inter as it did before.
 *
 * @type {readonly PunctFace[]}
 */
export const CJK_PUNCT_FACES = Object.freeze([
  Object.freeze({
    family: 'EviMed CJK Punct',
    weight: 400,
    local: Object.freeze([
      'PingFangSC-Regular',
      'PingFang SC Regular',
      'Microsoft YaHei',
      'MicrosoftYaHei',
      'NotoSansSC-Regular',
      'Noto Sans SC Regular',
      'NotoSansCJKsc-Regular',
      'Noto Sans CJK SC Regular',
      'SourceHanSansSC-Regular',
    ]),
  }),
  Object.freeze({
    family: 'EviMed CJK Punct',
    weight: 600,
    local: Object.freeze([
      'PingFangSC-Semibold',
      'PingFang SC Semibold',
      'Microsoft YaHei Bold',
      'MicrosoftYaHei-Bold',
      'NotoSansSC-SemiBold',
      'NotoSansSC-Bold',
      'NotoSansCJKsc-Bold',
      'Noto Sans CJK SC Bold',
      'SourceHanSansSC-Bold',
    ]),
  }),
  Object.freeze({
    family: 'EviMed CJK Punct Serif',
    weight: 400,
    local: Object.freeze([
      'STSongti-SC-Regular',
      'Songti SC Regular',
      'NotoSerifSC-Regular',
      'Noto Serif SC Regular',
      'NotoSerifCJKsc-Regular',
      'Noto Serif CJK SC Regular',
      'SourceHanSerifSC-Regular',
      'SimSun',
    ]),
  }),
  Object.freeze({
    family: 'EviMed CJK Punct Serif',
    weight: 600,
    local: Object.freeze([
      'STSongti-SC-Bold',
      'Songti SC Bold',
      'NotoSerifSC-SemiBold',
      'NotoSerifCJKsc-SemiBold',
      'Noto Serif CJK SC SemiBold',
      'SourceHanSerifSC-SemiBold',
      'Microsoft YaHei Bold',
      'MicrosoftYaHei-Bold',
    ]),
  }),
])

/**
 * The closed size scale, in px. A size outside it is a defect: the generated
 * preset carries exactly these and ESLint rejects `text-[Npx]`.
 *
 * The table speaks px because the design does; every artifact a browser reads
 * emits rem (1 rem = 16 px, `rem()` below), so a reader who raised the
 * browser's default font size gets a larger interface (spec §5.2, §10.6). A px
 * size ignores that setting entirely.
 *
 * Nine, up from five. The five-rung scale of 2026-09-23 was the right cure for
 * a page carrying eleven size × weight pairs, and the wrong medicine for a
 * dashboard: with 24 px as the ceiling a KPI could not out-shout its own
 * label, which is a large part of why 循证 GEO reads as small. The dense end
 * gains 13 and the loud end gains 32 and 40, and the loud end is admissible
 * only on a data page.
 *
 * @type {readonly number[]}
 */
export const TYPE_SIZES = Object.freeze([12, 13, 14, 16, 18, 20, 24, 32, 40])

/** The only three weights. Chinese screen faces without a 500 cut fall to 400. */
export const FONT_WEIGHTS = Object.freeze({ regular: 400, medium: 500, semibold: 600 })

/**
 * A named rung.
 * @typedef {{ size: number, lineHeight: string, use: string, family?: 'serif' }} TypeRung
 */

/**
 * The rungs, by what they are for. Names, not sizes, are what a page says, so
 * a rung can be re-tuned without a sweep.
 *
 * Line height is size + 8 for interface text, 1.75 for prose, 1.3 for
 * headings. No letter-spacing anywhere — tracking on Chinese breaks the
 * character grid.
 *
 * @type {Readonly<Record<string, TypeRung>>}
 */
export const TYPE_SCALE = Object.freeze(
  /** @type {Record<string, TypeRung>} */ ({
    badge: { size: 12, lineHeight: '1', use: 'a count inside a pill' },
    meta: { size: 12, lineHeight: '1.5', use: 'the densest metadata: dates, journals, counts, legends' },
    caption: { size: 12, lineHeight: '20px', use: 'captions and secondary one-liners' },
    compact: { size: 13, lineHeight: '20px', use: 'held in reserve for a dense grid whose 12 px cells are too small (a control is ui, a table head and a heat cell caption)' },
    ui: { size: 14, lineHeight: '22px', use: 'interface text, chat, list rows, controls — the default' },
    // Retired: the 13 px `ui-sm` was an unnamed second interface size. `compact`
    // is the deliberate one; this alias keeps unmigrated pages rendering at `ui`.
    'ui-sm': { size: 14, lineHeight: '22px', use: 'retired alias of `ui`' },
    body: { size: 16, lineHeight: '1.75', use: 'report prose and the reading column' },
    // An article's own text in the frontier reader (2026-10-23): 16 below 1280 px and 18 from there, its AI 导读 a step above (18 / 20),
    // all at 1.8 — the sizes of the scale, read at the line height of a long text.
    reading: { size: 16, lineHeight: '1.8', use: "an article's text in the reader, below 1280 px" },
    'reading-lg': { size: 18, lineHeight: '1.8', use: "an article's text from 1280 px; its AI 导读 below 1280 px" },
    'reading-xl': { size: 20, lineHeight: '1.8', use: "an article's AI 导读 from 1280 px" },
    wordmark: { size: 16, lineHeight: '1.3', use: 'the EviMed lockup in the sidebar', family: 'serif' },
    section: { size: 18, lineHeight: '26px', use: 'a section heading inside an answer or a report' },
    heading: { size: 20, lineHeight: '28px', use: 'a card heading on a data page, a document title in a preview pane' },
    title: { size: 24, lineHeight: '32px', use: 'every page H1' },
    'doc-title': { size: 24, lineHeight: '34px', use: 'the title of a report, article or evidence card', family: 'serif' },
    display: { size: 24, lineHeight: '1.3', use: 'a full-page empty state, the login page' },
    metric: { size: 32, lineHeight: '40px', use: 'a KPI number — data pages only' },
    'metric-lg': { size: 40, lineHeight: '48px', use: 'the one leading KPI of a dashboard' },
    hero: { size: 40, lineHeight: '50px', use: 'the home headline — one per product', family: 'serif' },
  }),
)

/* --------------------------------------------------------------- geometry -- */

/**
 * Base 4, and seven steps: 8 inside a group, 16–24 between groups, 32–48
 * between sections.
 */
export const SPACE = Object.freeze({
  base: 4,
  scale: Object.freeze([4, 8, 12, 16, 20, 24, 32, 40, 48, 64]),
  cardPadding: 16,
  gridGap: 12,
  pageGutter: 24,
  sectionGap: 32,
})

/**
 * Container widths — three, and a page uses exactly one for its title and its
 * body both (`PageShell` makes that structural rather than a convention).
 *
 * The single 960 column of 2026-09-23 is gone: it made a reading page too wide
 * and a dashboard too narrow, and a dashboard squeezed into a document column
 * is the structural half of why 循证 GEO looks cheap.
 *
 *  - `read` 720 — an answer, a report, an article, an evidence card
 *  - `page` 1040 — a list: tools, the frontier feed, capsules, settings
 *  - `wide` 1200 (1280 at ≥1440) — a dashboard: GEO, the evidence zone, the
 *    three-column knowledge base
 */
export const CONTAINERS = Object.freeze({
  narrow: 560,
  read: 720,
  content: 720,
  page: 1040,
  wide: 1200,
  wideMax: 1280,
  full: 1040,
  measure: 560,
  measureBody: 640,
  sidebar: 280,
  sidebarCollapsed: 56,
})

/**
 * Radii, by what wears them: a tag 6, a control 8, a card 12, a panel or
 * dialog 16, the composer 24, a pill fully round. A chart's bars and cells
 * take 2–4 and are not counted.
 */
export const RADII = Object.freeze({
  tag: 6,
  control: 8,
  card: 12,
  panel: 16,
  composer: 24,
  chip: 999,
})

/**
 * Control heights: 28 small, 36 default, 44 for a primary action; a tag is 22.
 * Controls on one line share a height.
 */
export const CONTROL_HEIGHTS = Object.freeze({
  tag: 22,
  sm: 28,
  inline: 28,
  control: 36,
  formPrimary: 44,
})

/** Two icon sizes: inline with text, and a chrome glyph. */
export const ICON_SIZES = Object.freeze({ inline: 16, chrome: 20 })

/**
 * One stroke for every icon, set once in the stylesheet (`svg.lucide`) so a
 * call site cannot pick its own. 1.5 splits the difference between the
 * kernel's 1.75 and the 1.4 of EviMed's hand-drawn set.
 */
export const ICON_STROKE = 1.5

/**
 * Three levels, and the rule is that a line comes first: a static card is a
 * hairline ring, and only what genuinely floats casts a shadow.
 */
export const ELEVATION = Object.freeze({
  flat: 'none',
  e1: '0 1px 2px rgba(36, 33, 30, 0.04), 0 0 0 1px rgba(36, 33, 30, 0.06)',
  e2: '0 6px 24px rgba(36, 33, 30, 0.06), 0 1px 3px rgba(36, 33, 30, 0.06), 0 0 0 1px rgba(36, 33, 30, 0.05)',
  e3: '0 24px 56px rgba(36, 33, 30, 0.14), 0 0 0 1px rgba(36, 33, 30, 0.06)',
  /** Retired names, pointed at their replacements. */
  pop: '0 6px 24px rgba(36, 33, 30, 0.06), 0 1px 3px rgba(36, 33, 30, 0.06), 0 0 0 1px rgba(36, 33, 30, 0.05)',
  modal: '0 24px 56px rgba(36, 33, 30, 0.14), 0 0 0 1px rgba(36, 33, 30, 0.06)',
})

/**
 * A state change, a container, a page — one easing in and one out (spec
 * §9.2). The exit curve accelerates away: a layer that leaves should not
 * linger at the end of its path the way an arriving one settles into place.
 */
export const MOTION = Object.freeze({
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
  easeStandard: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  easeExit: 'cubic-bezier(0.3, 0, 1, 1)',
})

/**
 * How far a layer travels as it arrives, in px: a drawer 24, a toast 8, a menu
 * 4 (spec §9.2). Custom properties rather than literals in a keyframe, so
 * `prefers-reduced-motion` sets every distance to 0 in one place and keeps the
 * fade (§9.5: remove the movement, keep a fade of 120 ms at most).
 */
export const MOTION_DISTANCE = Object.freeze({ drawer: 24, toast: 8, menu: 4 })

/* ------------------------------------------------------------ tokens 2.1 -- */

/**
 * Stacking layers (spec §7.4). A covering problem is solved by putting the
 * layer in the right tier, never by a larger number: a menu and a dialog were
 * both 50 and a drawer 40, so what covered what was render order.
 *
 * Page 0; sticky headers, tabs and a bottom composer 10; drawers 40; modal
 * dialogs 50; popovers — menus, dropdowns, the citation card — 60, so one
 * opened inside a dialog is still visible; toasts 70; tooltips 80; the skip
 * link 90, above everything.
 */
export const Z_INDEX = Object.freeze({
  page: 0,
  sticky: 10,
  drawer: 40,
  modal: 50,
  popover: 60,
  toast: 70,
  tooltip: 80,
  skip: 90,
})

/**
 * Breakpoints, in px: Tailwind's defaults, stated here so the Vue shell and a
 * chart's own layout read the same numbers (spec §6.5).
 */
export const BREAKPOINTS = Object.freeze({ sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 })

/**
 * Opacity is spent in three places, and a colour's pale version is never one
 * of them (spec §7.5): a disabled control, the scrim (a colour role), and an
 * item being dragged.
 */
export const OPACITY = Object.freeze({ disabled: 0.4, drag: 0.8 })

/**
 * The focus ring: a 2 px outline 2 px outside the control (spec §10.3). An
 * outline, not a box-shadow — forced-colours mode removes every shadow, and a
 * ring drawn with one vanishes with it.
 */
export const FOCUS_RING = Object.freeze({ width: 2, offset: 2 })

/**
 * A tooltip shows after 300 ms of hover (at once on focus) and hides 100 ms
 * after the pointer leaves (spec §9.3, §22.8). In ms.
 */
export const TOOLTIP_DELAYS = Object.freeze({ show: 300, hide: 100 })

/**
 * How long a toast stays, in ms (spec §22.1): a success 5 s, one that carries
 * an action (撤销, 查看) 10 s, and an error until it is closed — an error that
 * leaves by itself is an error the reader may never have seen. `0` means "no
 * timer", which is also how Element Plus's `ElMessage` reads it.
 */
export const TOAST_DURATIONS = Object.freeze({ success: 5000, action: 10000, error: 0 })

/**
 * Chart strokes, in px (spec §32.4): a series line 2 and a marker 5 by
 * default; in a comparison our line is 2.5 and every other one 1.5, so ours is
 * found by weight as well as by colour.
 */
export const CHART_STROKES = Object.freeze({ line: 2, own: 2.5, other: 1.5, marker: 5 })

/**
 * px → rem, the unit every browser-facing type size is written in.
 * @param {number} px
 * @returns {string}
 */
export function rem(px) {
  return `${px / 16}rem`
}

/**
 * A rung's line height in the unit a browser reads: a px value becomes rem so
 * it grows with the size it belongs to; a unitless ratio stays as it is.
 * @param {string} lineHeight
 * @returns {string}
 */
export function remLineHeight(lineHeight) {
  const px = /^(\d+(?:\.\d+)?)px$/.exec(lineHeight)
  return px ? rem(Number(px[1])) : lineHeight
}
