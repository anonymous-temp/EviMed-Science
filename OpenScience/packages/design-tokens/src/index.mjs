/**
 * The design tokens — one table, six generated consumers.
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
 *
 * `scripts/build/generate-design-tokens.mjs --check` and
 * `apps/web/src/app/designTokens.test.ts` both regenerate and compare, so a
 * stale artifact is a red test rather than a shell and a stylesheet that
 * disagree about what blue is.
 *
 * Nothing here is a decision this module makes on its own: the values are the
 * design language 2.0 table of
 * `docs/superpowers/specs/2026-09-26-EviMed与EviMed-Science融合方案.md` §5, and
 * `OpenScience/DESIGN.md` is its prose. Contrast figures in the `note` fields
 * are measured with the WCAG 2.1 relative-luminance formula — `contrast.mjs`
 * recomputes them at build time and fails the build on a shortfall, so a note
 * cannot quietly become fiction.
 *
 * @module @evimed/design-tokens
 */

/** Bumped when a consumer must be regenerated, not when a value is tuned. */
export const DESIGN_TOKENS_VERSION = '2.0.0'

/* ------------------------------------------------------------------ ramps -- */

/**
 * Theme-independent primitives. A role below points at a step; the dark theme
 * points the same role at a *different step* rather than inverting a colour.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const COLOR_RAMPS = Object.freeze({
  /**
   * 循证蓝. `600` is EviMed's live brand colour, kept to the byte — the
   * platform has users and a logo already. The other ten steps are filled in
   * around it on one lightness ladder.
   */
  brand: Object.freeze({
    50: '#eef4fc',
    100: '#dde9f9',
    200: '#bcd3f3',
    300: '#8fb5ea',
    400: '#5690dd',
    500: '#2a72d0',
    600: '#0a5dc1',
    700: '#0a4da0',
    800: '#0c3e7f',
    900: '#0e305f',
    950: '#0a1f3e',
  }),
  /**
   * A blue-grey at the brand's own colour temperature, so a grey surface
   * beside a blue one does not read as two products. Body text is `900`, not
   * black: the live EviMed shell set every text role to `#000000` and every
   * secondary role to `#333333`, and a collapsed ramp is why its placeholders
   * were black and its spinners invisible.
   *
   * `control` is the one hand-placed step: the visible boundary of a control
   * needs 3:1 (WCAG 1.4.11) and no ladder step sat there.
   */
  n: Object.freeze({
    0: '#ffffff',
    25: '#fafbfc',
    50: '#f5f7f9',
    100: '#edf0f3',
    150: '#e4e8ec',
    200: '#d6dce2',
    300: '#bac2ca',
    400: '#939ca6',
    500: '#646d77',
    600: '#535b64',
    700: '#3e454d',
    800: '#2a3037',
    900: '#1a1f25',
    950: '#12161b',
    // 3.10 on the sidebar, 3.33 on white. The design language quotes 3.3:1,
    // which is true on white and was 2.90 on the sidebar at #8a939c — a
    // control edge has to clear 3:1 on every ground it actually sits on, so
    // the step is one shade darker than the table's headline figure.
    control: '#858e97',
  }),
  /** Dark surfaces on the same hue, one step lighter per layer. */
  dark: Object.freeze({
    bg: '#0f1318',
    surface: '#161b21',
    'surface-2': '#1e242b',
    'border-faint': '#1e242b',
    border: '#262d35',
    'border-strong': '#646e78',
  }),
  /** Clinical safety, deletion, a severe error. Red is spent here and nowhere else. */
  danger: Object.freeze({
    50: '#fdf1ef',
    100: '#fbe2de',
    300: '#e0877f',
    400: '#d1594e',
    600: '#c0362c',
    700: '#a72d24',
    800: '#9a2a22',
    950: '#3d100c',
  }),
  /** Needs attention, not danger: an unverified quotation, a paused probe. */
  warn: Object.freeze({
    50: '#fff5e5',
    100: '#ffeacc',
    300: '#e0b169',
    400: '#c98a1f',
    600: '#a15c00',
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
    600: '#1e7a4c',
    700: '#1a6a42',
    800: '#155636',
    950: '#082418',
  }),
  /**
   * Informational. On the brand's own hue now that the brand is blue: an
   * "information" blue distinct from the accent would be a second accent.
   */
  info: Object.freeze({
    50: '#eef4fc',
    100: '#dde9f9',
    300: '#8fb5ea',
    400: '#5690dd',
    600: '#2a72d0',
    700: '#0a5dc1',
    800: '#0c3e7f',
    950: '#0a1f3e',
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
    // The canvas. A hair off white so a white card has an edge without a
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
    scrim: { light: 'rgba(15, 19, 24, 0.32)', dark: 'rgba(0, 0, 0, 0.56)' },

    /* --- borders -------------------------------------------------------- */
    // Decoration: separators, a card's edge, a table rule.
    'border-hairline': { light: 'n-150', dark: 'dark-border' },
    'border-faint': { light: 'n-100', dark: 'dark-border-faint' },
    // A pill or segment whose ground already separates it from the page.
    'border-light': { light: 'n-200', dark: 'dark-border' },
    // The visible boundary of a control (WCAG 1.4.11 wants 3:1).
    'border-control': { light: 'n-control', dark: 'dark-border-strong', note: '3.33 on the page, 3.10 on the sidebar' },

    /* --- text ----------------------------------------------------------- */
    text: { light: 'n-900', dark: '#eef1f4', note: '15.09 on the page' },
    'text-2': { light: 'n-700', dark: '#c3cad2', note: '9.30 on the page' },
    'text-3': { light: 'n-500', dark: '#8d96a0', note: '5.13 on the page, 4.76 on surface-1 — nothing lighter carries text' },
    // Icons and rules only. Never a word: 2.90 on the page.
    'text-graphic': { light: 'n-400', dark: 'n-600', note: 'graphics only, 2.90 — never text' },

    /* --- accent --------------------------------------------------------- */
    // One accent: the primary action, the link, the focus ring, the selected
    // row, the ✓ verified mark, and "our" series in a chart.
    accent: { light: 'brand-600', dark: 'brand-400', note: '6.24 on the page; white on it 6.24' },
    'accent-fg': { light: '#ffffff', dark: 'dark-bg' },
    // Selected rows, the current sidebar row, the verified chip. Never text.
    'accent-soft': { light: 'brand-50', dark: 'brand-950' },
    // The pressed state of an accent surface.
    'accent-pressed': { light: 'brand-700', dark: 'brand-300' },
    // Text on `accent-soft`. Same step as the ramp's 800, different job.
    'accent-strong': { light: 'brand-800', dark: 'brand-300', note: 'on accent-soft: 9.93' },

    /* --- status: colour is never the only carrier ----------------------- */
    ok: { light: 'ok-600', dark: 'ok-300' },
    'ok-soft': { light: 'ok-50', dark: 'ok-950' },
    warn: { light: 'warn-600', dark: 'warn-300' },
    'warn-soft': { light: 'warn-50', dark: 'warn-950' },
    'warn-strong': { light: 'warn-800', dark: 'warn-300', note: 'on warn-soft: 7.92' },
    // Red is spent on clinical safety, deletion and a severe error, and on
    // nothing else. Low certainty is not red: it is a shorter blue bar.
    error: { light: 'danger-600', dark: 'danger-300', note: '5.49 on the page' },
    'error-fg': { light: '#ffffff', dark: 'dark-bg' },
    danger: { light: 'danger-600', dark: 'danger-300' },
    'danger-soft': { light: 'danger-50', dark: 'danger-950' },
    'danger-strong': { light: 'danger-800', dark: 'danger-300', note: 'on danger-soft: 8.13' },
    info: { light: 'info-700', dark: 'info-300' },
    'info-soft': { light: 'info-50', dark: 'info-950' },
    // Links wear the accent: one accent colour on the whole product.
    link: { light: 'brand-600', dark: 'brand-400', note: '6.24 on the page' },

    /* --- product marks -------------------------------------------------- */
    // A verified claim, in the brand colour on purpose: verification is the
    // promise the brand makes.
    'verify-ok': { light: 'brand-600', dark: 'brand-300' },
    // "Needs checking" is amber and never red: it is not a clinical alarm.
    'verify-pending': { light: 'warn-600', dark: 'warn-300' },
    // A located quotation in a preserved source, and a search hit. Body text
    // on it still reads.
    highlight: { light: '#fdeba8', dark: 'warn-800' },
    focus: { light: 'brand-600', dark: 'brand-400', note: '2 px ring, 6.24 light' },
    badge: { light: 'danger-600', dark: 'danger-600', note: 'unread count; white on it 5.49 — the dark scheme keeps the same step because white on danger-400 is 4.00' },
    'badge-fg': { light: '#ffffff', dark: '#ffffff' },
    // The membership card's one gradient — the single brand moment a settings
    // page is allowed.
    'member-from': { light: '#f6d58e', dark: '#7a6329' },
    'member-to': { light: '#fbe7be', dark: '#5c4a1d' },

    /* --- run-state dots: graphics, 3:1, always beside a shape and a word - */
    'dot-running': { light: 'brand-500', dark: 'brand-400' },
    'dot-done': { light: 'ok-600', dark: 'ok-300' },
    'dot-review': { light: 'warn-600', dark: 'warn-400' },
    'dot-failed': { light: 'danger-600', dark: 'danger-400' },
    'dot-canceled': { light: 'n-400', dark: 'n-600' },

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
  own: '#0a5dc1',
  rivals: Object.freeze(['#5a626b', '#8a939c', '#b4bcc5']),
  series: Object.freeze(['#0a5dc1', '#e07b39', '#1d9a87', '#7b5cd6', '#c94f7c', '#c7a12b', '#5a626b', '#b4bcc5']),
  heat: Object.freeze(['#f3f6fa', '#dce8f7', '#b3cdef', '#7fa9e3', '#3e7ed4', '#0a5dc1']),
  /** Only for defects and safety: S3 severe, S2 moderate, S1 minor. */
  severity: Object.freeze({ s3: '#c0362c', s2: '#e0877f', s1: '#939ca6' }),
})

/**
 * Eight categorical chart slots in a fixed order, per scheme.
 * @type {Readonly<{ light: readonly string[], dark: readonly string[] }>}
 */
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
 * Latin faces lead so numbers, DOIs, doses and identifiers keep the metrics
 * the scale was measured against; then every Chinese face a reader's OS might
 * carry — without named CJK faces Windows falls to the bitmap-hinted SimSun.
 *
 * The serif is back, and confined: the wordmark, the home headline, and the
 * title of a document. An evidence platform borrows its authority from the
 * journals, and every one of them is set in a serif — but a serif on a button
 * reads as an old intranet, so three places and no fourth.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FONT_STACKS = Object.freeze({
  sans: 'Inter, system-ui, "PingFang SC", "HarmonyOS Sans SC", MiSans, "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: '"Source Serif 4", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace',
})

/**
 * The closed size scale, in px. A size outside it is a defect: the generated
 * preset carries exactly these and ESLint rejects `text-[Npx]`.
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
    compact: { size: 13, lineHeight: '20px', use: 'a small control, a filter chip, a dense data table' },
    ui: { size: 14, lineHeight: '22px', use: 'interface text, chat, list rows, controls — the default' },
    // Retired: the 13 px `ui-sm` was an unnamed second interface size. `compact`
    // is the deliberate one; this alias keeps unmigrated pages rendering at `ui`.
    'ui-sm': { size: 14, lineHeight: '22px', use: 'retired alias of `ui`' },
    body: { size: 16, lineHeight: '1.75', use: 'report prose and the reading column' },
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
  e1: '0 1px 2px rgba(20, 32, 48, 0.04), 0 0 0 1px rgba(20, 32, 48, 0.06)',
  e2: '0 6px 24px rgba(20, 32, 48, 0.06), 0 1px 3px rgba(20, 32, 48, 0.06), 0 0 0 1px rgba(20, 32, 48, 0.05)',
  e3: '0 24px 56px rgba(20, 32, 48, 0.14), 0 0 0 1px rgba(20, 32, 48, 0.06)',
  /** Retired names, pointed at their replacements. */
  pop: '0 6px 24px rgba(20, 32, 48, 0.06), 0 1px 3px rgba(20, 32, 48, 0.06), 0 0 0 1px rgba(20, 32, 48, 0.05)',
  modal: '0 24px 56px rgba(20, 32, 48, 0.14), 0 0 0 1px rgba(20, 32, 48, 0.06)',
})

/** A state change, a container, a page — and one easing. */
export const MOTION = Object.freeze({
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
  easeStandard: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
})
