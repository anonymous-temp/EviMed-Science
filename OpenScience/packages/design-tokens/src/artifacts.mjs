/**
 * The four artifacts that are not CSS or the kernel map: the Tailwind preset
 * both front ends extend, the Element Plus theme the Vue shell needs, the
 * ECharts theme both sides register, and the Tokens Studio file a Figma
 * library syncs from.
 *
 * Each is a plain data structure here and a file under `dist/` after
 * `generate.mjs` runs. Nothing downstream re-derives a value: a consumer that
 * computed its own shade is how the tables drifted before.
 *
 * @module @evimed/design-tokens/artifacts
 */
import {
  BREAKPOINTS,
  CHART_COLORS,
  CHART_OWN,
  CHART_SERIES,
  CHART_STROKES,
  COLOR_RAMPS,
  COLOR_ROLE_ALIASES,
  COLOR_ROLES,
  CONTAINERS,
  CONTROL_HEIGHTS,
  DESIGN_TOKENS_VERSION,
  ELEVATION,
  FOCUS_RING,
  FONT_STACKS,
  MOTION,
  MOTION_DISTANCE,
  OPACITY,
  RADII,
  SPACE,
  STUDY_TYPE_BADGES,
  TOAST_DURATIONS,
  TOOLTIP_DELAYS,
  TYPE_SCALE,
  Z_INDEX,
  colorRole,
  rem,
  remLineHeight,
} from './index.mjs'

/* ---------------------------------------------------------------- tailwind -- */

/**
 * The Tailwind preset, as an object.
 *
 * Colours stay `var()` references so a theme switch is a class on `<html>` and
 * not a rebuild. One consequence to know: Tailwind 3 cannot decompose a
 * `var()` colour, so an opacity modifier (`bg-accent/10`) emits no CSS at all
 * — ESLint rejects them, and a tint is its own token (`-soft` / `-strong`).
 *
 * @returns {Record<string, unknown>}
 */
export function tailwindPreset() {
  const colors = Object.fromEntries(
    [...Object.keys(COLOR_ROLES), ...Object.keys(COLOR_ROLE_ALIASES)].map((role) => [role, `var(--${role})`]),
  )
  // rem, so the browser's default font size is honoured (spec §5.2, §10.6).
  const fontSize = Object.fromEntries(
    Object.entries(TYPE_SCALE).map(([rung, { size, lineHeight }]) => [rung, [rem(size), remLineHeight(lineHeight)]]),
  )
  const borderRadius = Object.fromEntries(
    Object.entries(RADII).map(([name, value]) => [name, name === 'chip' ? '9999px' : `${value}px`]),
  )
  // Kebab-case: a Tailwind class is `h-form-primary`, not `h-formPrimary`.
  const height = Object.fromEntries(
    Object.entries(CONTROL_HEIGHTS).map(([name, value]) => [name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), `${value}px`]),
  )
  return {
    darkMode: ['selector', '[data-theme="dark"]'],
    theme: {
      // Tailwind's own values, stated by the table (spec §6.5) so both shells
      // and a chart's layout code read one set.
      screens: Object.fromEntries(Object.entries(BREAKPOINTS).map(([name, value]) => [name, `${value}px`])),
      extend: {
        colors: {
          ...colors,
          // `--badge` is a colour and `badge` is also a type rung, so `unread`
          // names the colour: `text-badge` would otherwise set both at once.
          unread: 'var(--badge)',
          'unread-fg': 'var(--badge-fg)',
          // Retired shorthands the pages still say.
          faint: 'var(--border-faint)',
          strong: 'var(--border-control)',
          // Data colour, reachable as a class on a chart's legend swatch.
          'chart-own': 'var(--chart-own)',
          heat: Object.fromEntries(CHART_COLORS.heat.map((_, index) => [String(index), `var(--heat-${index})`])),
          severity: Object.fromEntries(
            Object.keys(CHART_COLORS.severity).map((level) => [level, `var(--severity-${level})`]),
          ),
        },
        // `var()` rather than the literal, so reduced motion shortens them.
        transitionDuration: { fast: 'var(--dur-fast)', base: 'var(--dur-base)', slow: 'var(--dur-slow)' },
        transitionTimingFunction: { standard: MOTION.easeStandard, exit: MOTION.easeExit },
        // The stacking tiers by name (spec §7.4): `z-modal`, `z-popover`, …
        zIndex: Object.fromEntries(Object.entries(Z_INDEX).map(([name, value]) => [name, String(value)])),
        opacity: Object.fromEntries(Object.entries(OPACITY).map(([name, value]) => [name, String(value)])),
        outlineWidth: { focus: `${FOCUS_RING.width}px` },
        outlineOffset: { focus: `${FOCUS_RING.offset}px` },
        fontFamily: { sans: FONT_STACKS.sans, serif: FONT_STACKS.serif, mono: FONT_STACKS.mono },
        fontSize,
        // Radii by what wears them. `DEFAULT` is the control step, so a bare
        // `rounded` is a control.
        borderRadius: { DEFAULT: borderRadius.control, input: borderRadius.control, ...borderRadius },
        // Named on purpose rather than mapped from `CONTAINERS`: a blanket map
        // would define `max-w-full` as 1040px and silently break every
        // `max-w-full` in both code bases.
        maxWidth: {
          'content-narrow': `${CONTAINERS.narrow}px`,
          read: `${CONTAINERS.read}px`,
          content: `${CONTAINERS.content}px`,
          page: `${CONTAINERS.page}px`,
          wide: `${CONTAINERS.wide}px`,
          'wide-max': `${CONTAINERS.wideMax}px`,
          measure: `${CONTAINERS.measure}px`,
          'measure-body': `${CONTAINERS.measureBody}px`,
          // Retired names of `page`, pointed at the same width so an
          // unmigrated call site converges rather than breaking.
          'content-wide': `${CONTAINERS.full}px`,
          'content-full': `${CONTAINERS.full}px`,
        },
        // Control heights only. Not merged into `spacing`: `p-4` must stay
        // Tailwind's 1rem, not the 4 px of our own scale.
        height,
        minHeight: height,
        boxShadow: { e1: ELEVATION.e1, e2: ELEVATION.e2, e3: ELEVATION.e3, pop: ELEVATION.e2, modal: ELEVATION.e3 },
        // Distances are custom properties, so reduced motion sets them to 0
        // and the layer only fades (spec §9.5).
        keyframes: {
          'drawer-in': {
            from: { transform: 'translateX(var(--motion-drawer))', opacity: '0' },
            to: { transform: 'translateX(0)', opacity: '1' },
          },
          'toast-in': {
            from: { transform: 'translateY(var(--motion-toast))', opacity: '0' },
            to: { transform: 'translateY(0)', opacity: '1' },
          },
          'menu-in': {
            from: { transform: 'translateY(calc(-1 * var(--motion-menu)))', opacity: '0' },
            to: { transform: 'translateY(0)', opacity: '1' },
          },
        },
        animation: {
          'drawer-in': 'drawer-in var(--dur-base) var(--ease-standard)',
          'toast-in': 'toast-in var(--dur-base) var(--ease-standard)',
          'menu-in': 'menu-in var(--dur-fast) var(--ease-standard)',
        },
      },
    },
  }
}

/**
 * The preset as a module, for `dist/tailwind-preset.js`.
 * @returns {string}
 */
export function tailwindPresetModule() {
  return [
    `/* EviMed 设计语言 ${DESIGN_TOKENS_VERSION} — generated by @evimed/design-tokens. Do not edit. */`,
    '/* Both front ends extend this: `presets: [require("@evimed/design-tokens/tailwind")]`. */',
    '',
    `export default ${JSON.stringify(tailwindPreset(), null, 2)}`,
    '',
  ].join('\n')
}

/* ------------------------------------------------------------ element plus -- */

/**
 * Element Plus derives nine shades of its primary from one colour at build
 * time, and mixes them with white — which is why overriding only
 * `--el-color-primary` leaves eight teal-adjacent shades behind. Every derived
 * step is written out here instead, from the brand ramp.
 *
 * The Vue shell links this after Element Plus's own stylesheet. It is what
 * removes the ~100 lines of `!important` the shell used to carry.
 *
 * @returns {string}
 */
export function elementPlusCss() {
  const brand = COLOR_RAMPS.brand
  /** Element Plus's light-N steps, darkest to lightest, as the brand ramp. */
  const lightSteps = [brand[500], brand[400], brand[300], brand[300], brand[200], brand[200], brand[100], brand[100], brand[50]]
  /** @type {string[]} */
  const lines = []
  lines.push(`/* EviMed 设计语言 ${DESIGN_TOKENS_VERSION} — generated by @evimed/design-tokens. Do not edit. */`)
  lines.push('/* Link after element-plus/dist/index.css. Overriding --el-color-primary')
  lines.push('   alone is not enough: Element Plus pre-derives nine light steps at build')
  lines.push('   time, so each one is written out. */')
  lines.push(':root {')
  lines.push(`  --el-color-primary: ${brand[600]};`)
  lightSteps.forEach((value, index) => lines.push(`  --el-color-primary-light-${index + 1}: ${value};`))
  lines.push(`  --el-color-primary-dark-2: ${brand[700]};`)
  for (const [name, role] of /** @type {const} */ ([
    ['success', 'ok'],
    ['warning', 'warn'],
    ['danger', 'error'],
    ['error', 'error'],
    ['info', 'text-3'],
  ])) {
    lines.push(`  --el-color-${name}: ${colorRole(role, 'light')};`)
  }
  lines.push(`  --el-text-color-primary: ${colorRole('text', 'light')};`)
  lines.push(`  --el-text-color-regular: ${colorRole('text-2', 'light')};`)
  lines.push(`  --el-text-color-secondary: ${colorRole('text-3', 'light')};`)
  lines.push(`  --el-text-color-placeholder: ${colorRole('text-3', 'light')};`)
  lines.push(`  --el-text-color-disabled: ${COLOR_RAMPS.n[400]};`)
  lines.push(`  --el-border-color: ${colorRole('border-control', 'light')};`)
  lines.push(`  --el-border-color-light: ${colorRole('border-light', 'light')};`)
  lines.push(`  --el-border-color-lighter: ${colorRole('border-hairline', 'light')};`)
  lines.push(`  --el-border-color-extra-light: ${colorRole('border-faint', 'light')};`)
  lines.push(`  --el-fill-color: ${colorRole('surface-2', 'light')};`)
  lines.push(`  --el-fill-color-light: ${colorRole('surface-1', 'light')};`)
  lines.push(`  --el-fill-color-blank: ${colorRole('surface', 'light')};`)
  lines.push(`  --el-bg-color: ${colorRole('surface', 'light')};`)
  lines.push(`  --el-bg-color-page: ${colorRole('bg', 'light')};`)
  lines.push(`  --el-bg-color-overlay: ${colorRole('surface', 'light')};`)
  lines.push(`  --el-mask-color: ${colorRole('scrim', 'light')};`)
  lines.push(`  --el-font-family: ${FONT_STACKS.sans};`)
  lines.push(`  --el-font-size-base: ${rem(TYPE_SCALE.ui.size)};`)
  lines.push(`  --el-font-size-small: ${rem(TYPE_SCALE.compact.size)};`)
  lines.push(`  --el-font-size-extra-small: ${rem(TYPE_SCALE.meta.size)};`)
  lines.push(`  --el-font-size-medium: ${rem(TYPE_SCALE.body.size)};`)
  lines.push(`  --el-font-size-large: ${rem(TYPE_SCALE.heading.size)};`)
  lines.push(`  --el-border-radius-base: ${RADII.control}px;`)
  lines.push(`  --el-border-radius-small: ${RADII.tag}px;`)
  lines.push(`  --el-border-radius-round: ${RADII.chip}px;`)
  lines.push(`  --el-component-size: ${CONTROL_HEIGHTS.control}px;`)
  lines.push(`  --el-component-size-small: ${CONTROL_HEIGHTS.sm}px;`)
  lines.push(`  --el-component-size-large: ${CONTROL_HEIGHTS.formPrimary}px;`)
  lines.push(`  --el-box-shadow-light: ${ELEVATION.e1};`)
  lines.push(`  --el-box-shadow: ${ELEVATION.e2};`)
  lines.push(`  --el-box-shadow-dark: ${ELEVATION.e3};`)
  lines.push(`  --el-transition-duration: ${MOTION.base};`)
  lines.push(`  --el-transition-duration-fast: ${MOTION.fast};`)
  lines.push('}')
  lines.push('')
  // There are no outlined buttons (spec §17.1): a list of six rows with an
  // outlined button on each reads as a form. Element Plus's default type is
  // an outlined button, so it becomes the secondary button — a surface-2 fill
  // with body text, the surface-3 step on hover and press. The border takes
  // the fill's colour rather than none, so the button keeps its box, and
  // forced colours still draw it (the system colours replace both).
  const fill = colorRole('surface-2', 'light')
  const pressed = colorRole('surface-3', 'light')
  const ink = colorRole('text', 'light')
  lines.push(".el-button:not([class*='el-button--']):not(.is-text):not(.is-link) {")
  for (const [state, bg] of /** @type {const} */ ([['', fill], ['hover-', pressed], ['active-', pressed]])) {
    lines.push(`  --el-button-${state}bg-color: ${bg};`)
    lines.push(`  --el-button-${state}border-color: ${bg};`)
    lines.push(`  --el-button-${state}text-color: ${ink};`)
  }
  lines.push('}')
  lines.push('')
  // Element Plus's own transitions follow reduced motion like ours do.
  lines.push('@media (prefers-reduced-motion: reduce) {')
  lines.push('  :root {')
  lines.push(`    --el-transition-duration: ${MOTION.fast};`)
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

/* ----------------------------------------------------------------- echarts -- */

/**
 * The ECharts theme, registered on both sides so a chart in the Vue shell and
 * a chart in a React page are the same chart.
 *
 * @param {'light' | 'dark'} [scheme]
 * @returns {Record<string, unknown>}
 */
export function echartsTheme(scheme = 'light') {
  const axis = colorRole('chart-axis', scheme)
  const grid = colorRole('chart-grid', scheme)
  const text = colorRole('text', scheme)
  const text2 = colorRole('text-2', scheme)
  const text3 = colorRole('text-3', scheme)
  const surface = colorRole('surface', scheme)
  const axisCommon = {
    axisLine: { show: true, lineStyle: { color: axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: text3, fontSize: TYPE_SCALE.meta.size, fontFamily: FONT_STACKS.sans },
    splitLine: { show: true, lineStyle: { color: grid, width: 1, type: 'solid' } },
    splitArea: { show: false },
  }
  return {
    color: [...CHART_SERIES[scheme]],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_STACKS.sans, color: text },
    // A chart's title is a sentence that states the finding, set where the
    // card's heading is — never "图 1" inside the canvas.
    title: { show: false },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    valueAxis: axisCommon,
    categoryAxis: { ...axisCommon, splitLine: { show: false } },
    logAxis: axisCommon,
    timeAxis: axisCommon,
    legend: {
      textStyle: { color: text2, fontSize: TYPE_SCALE.meta.size, fontFamily: FONT_STACKS.sans },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
    },
    tooltip: {
      backgroundColor: surface,
      borderColor: colorRole('border-hairline', scheme),
      borderWidth: 1,
      padding: [8, 12],
      extraCssText: `border-radius:${RADII.control}px;box-shadow:${ELEVATION.e2};`,
      textStyle: { color: text, fontSize: TYPE_SCALE.compact.size, fontFamily: FONT_STACKS.sans },
      axisPointer: { lineStyle: { color: colorRole('border-control', scheme) }, crossStyle: { color: axis } },
    },
    line: { symbol: 'circle', symbolSize: CHART_STROKES.marker, smooth: false, lineStyle: { width: CHART_STROKES.line } },
    bar: { itemStyle: { borderRadius: [3, 3, 0, 0] } },
    // No pie: a share is a 100% stacked bar. Kept only so a legacy chart is
    // not unreadable if one slips in.
    pie: { itemStyle: { borderColor: surface, borderWidth: 1 } },
    visualMap: { inRange: { color: [...CHART_COLORS.heat] }, textStyle: { color: text3 } },
    heatmap: { itemStyle: { borderColor: surface, borderWidth: 1, borderRadius: 3 } },
  }
}

/* ------------------------------------------------------------------- figma -- */

/**
 * Tokens Studio format, so the Figma library and the code share one table and
 * a design file cannot invent a colour the code does not have.
 * @returns {Record<string, unknown>}
 */
export function figmaTokens() {
  /** @param {string} value @returns {{ value: string, type: string }} */
  const color = (value) => ({ value, type: 'color' })
  /** @param {number|string} value @param {string} type @returns {{ value: string, type: string }} */
  const dim = (value, type) => ({ value: typeof value === 'number' ? `${value}px` : value, type })
  return {
    $themes: [],
    global: {
      ramp: Object.fromEntries(
        Object.entries(COLOR_RAMPS).map(([ramp, steps]) => [
          ramp,
          Object.fromEntries(Object.entries(steps).map(([step, value]) => [step, color(value)])),
        ]),
      ),
      light: Object.fromEntries(Object.keys(COLOR_ROLES).map((role) => [role, color(colorRole(role, 'light'))])),
      dark: Object.fromEntries(Object.keys(COLOR_ROLES).map((role) => [role, color(colorRole(role, 'dark'))])),
      data: {
        own: color(CHART_COLORS.own),
        rival: Object.fromEntries(CHART_COLORS.rivals.map((value, index) => [index + 1, color(value)])),
        series: Object.fromEntries(CHART_COLORS.series.map((value, index) => [index + 1, color(value)])),
        heat: Object.fromEntries(CHART_COLORS.heat.map((value, index) => [index, color(value)])),
        diverging: Object.fromEntries(CHART_COLORS.diverging.map((value, index) => [index, color(value)])),
        missing: color(CHART_COLORS.missing),
        severity: Object.fromEntries(
          Object.entries(CHART_COLORS.severity).map(([level, value]) => [level, color(value)]),
        ),
      },
      study: Object.fromEntries(
        Object.entries(STUDY_TYPE_BADGES).map(([kind, { fg, bg, label }]) => [
          kind,
          { fg: color(fg), bg: color(bg), label: { value: label, type: 'text' } },
        ]),
      ),
      type: Object.fromEntries(
        Object.entries(TYPE_SCALE).map(([rung, { size, lineHeight, family }]) => [
          rung,
          {
            fontSize: dim(size, 'fontSizes'),
            lineHeight: { value: String(lineHeight), type: 'lineHeights' },
            fontFamily: { value: family === 'serif' ? FONT_STACKS.serif : FONT_STACKS.sans, type: 'fontFamilies' },
          },
        ]),
      ),
      space: Object.fromEntries(SPACE.scale.map((step) => [step, dim(step, 'spacing')])),
      radius: Object.fromEntries(Object.entries(RADII).map(([name, value]) => [name, dim(value, 'borderRadius')])),
      size: Object.fromEntries(Object.entries(CONTROL_HEIGHTS).map(([name, value]) => [name, dim(value, 'sizing')])),
      container: Object.fromEntries(Object.entries(CONTAINERS).map(([name, value]) => [name, dim(value, 'sizing')])),
      shadow: {
        e1: { value: ELEVATION.e1, type: 'boxShadow' },
        e2: { value: ELEVATION.e2, type: 'boxShadow' },
        e3: { value: ELEVATION.e3, type: 'boxShadow' },
      },
      opacity: Object.fromEntries(Object.entries(OPACITY).map(([name, value]) => [name, { value: String(value), type: 'opacity' }])),
      zIndex: Object.fromEntries(Object.entries(Z_INDEX).map(([name, value]) => [name, { value: String(value), type: 'other' }])),
      breakpoint: Object.fromEntries(Object.entries(BREAKPOINTS).map(([name, value]) => [name, dim(value, 'sizing')])),
      focusRing: { width: dim(FOCUS_RING.width, 'borderWidth'), offset: dim(FOCUS_RING.offset, 'spacing') },
      chartStroke: Object.fromEntries(Object.entries(CHART_STROKES).map(([name, value]) => [name, dim(value, 'borderWidth')])),
    },
  }
}

/* -------------------------------------------------------------------- dtcg -- */

/**
 * A DTCG 2025.10 colour value: an sRGB object that always carries its 6-digit
 * hex (spec §11.6). `rgba()` literals (the scrims) keep their alpha.
 * @param {string} value `#rrggbb` or `rgba(r, g, b, a)`
 * @returns {{ colorSpace: 'srgb', components: number[], alpha: number, hex: string }}
 */
export function dtcgColor(value) {
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value)
  const channels = rgba
    ? [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])]
    : [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16))
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error(`dtcg: not an sRGB colour: "${value}"`)
  }
  return {
    colorSpace: 'srgb',
    // Four decimals: enough to round-trip every 8-bit channel exactly.
    components: channels.map((channel) => Math.round((channel / 255) * 10000) / 10000),
    alpha: rgba?.[4] !== undefined ? Number(rgba[4]) : 1,
    hex: `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
  }
}

/** @param {string} value @param {string} [description] */
const dtcgColorToken = (value, description) => ({
  $type: 'color',
  $value: dtcgColor(value),
  ...(description ? { $description: description } : {}),
})
/** @param {number} px */
const dtcgDimension = (px) => ({ $type: 'dimension', $value: { value: px, unit: 'px' } })
/** @param {number} ms */
const dtcgDuration = (ms) => ({ $type: 'duration', $value: { value: ms / 1000, unit: 's' } })
/** @param {number} value */
const dtcgNumber = (value) => ({ $type: 'number', $value: value })
/** @param {string} css a `NNNms` duration from `MOTION` */
const msOf = (css) => Number(css.replace(/ms$/, ''))

/**
 * The DTCG 2025.10 export (spec §11.6): a base file, one file per theme and
 * per motion setting, and a resolver that names the two dimensions
 * (`theme: light | dark`, `motion: full | reduced`).
 *
 * Deliberately the subset Figma's native variable import accepts: colours as
 * sRGB objects with a hex, dimensions in px, durations in seconds, numbers.
 * Composite values — shadows, typography, easing curves — stay with the
 * component library, and every value is written out rather than aliased, so
 * each file stands alone as one Figma mode. The table in `index.mjs` stays
 * the one source: these files are an export and nobody edits them.
 *
 * @returns {Record<string, unknown>} file name (under `dist/dtcg/`) → JSON
 */
export function dtcgFiles() {
  const ramps = Object.fromEntries(
    Object.entries(COLOR_RAMPS).map(([ramp, steps]) => [
      ramp,
      Object.fromEntries(Object.entries(steps).map(([step, value]) => [step, dtcgColorToken(value)])),
    ]),
  )
  const base = {
    $description: `EviMed 设计语言 ${DESIGN_TOKENS_VERSION} — theme-independent tokens. Generated by @evimed/design-tokens; do not edit.`,
    color: ramps,
    data: {
      own: dtcgColorToken(CHART_COLORS.own, 'ours, in every comparison'),
      rival: Object.fromEntries(CHART_COLORS.rivals.map((value, index) => [String(index + 1), dtcgColorToken(value)])),
      heat: Object.fromEntries(CHART_COLORS.heat.map((value, index) => [String(index), dtcgColorToken(value)])),
      diverging: Object.fromEntries(CHART_COLORS.diverging.map((value, index) => [String(index), dtcgColorToken(value)])),
      missing: dtcgColorToken(CHART_COLORS.missing, 'a cell with no reading'),
      severity: Object.fromEntries(Object.entries(CHART_COLORS.severity).map(([level, value]) => [level, dtcgColorToken(value)])),
      study: Object.fromEntries(
        Object.entries(STUDY_TYPE_BADGES).map(([kind, { fg, bg, label }]) => [
          kind,
          { $description: label, fg: dtcgColorToken(fg), bg: dtcgColorToken(bg) },
        ]),
      ),
    },
    'font-size': Object.fromEntries(Object.entries(TYPE_SCALE).map(([rung, { size }]) => [rung, dtcgDimension(size)])),
    space: Object.fromEntries(SPACE.scale.map((step) => [String(step), dtcgDimension(step)])),
    radius: Object.fromEntries(Object.entries(RADII).map(([name, value]) => [name, dtcgDimension(value)])),
    height: Object.fromEntries(Object.entries(CONTROL_HEIGHTS).map(([name, value]) => [name, dtcgDimension(value)])),
    width: Object.fromEntries(Object.entries(CONTAINERS).map(([name, value]) => [name, dtcgDimension(value)])),
    breakpoint: Object.fromEntries(Object.entries(BREAKPOINTS).map(([name, value]) => [name, dtcgDimension(value)])),
    'focus-ring': { width: dtcgDimension(FOCUS_RING.width), offset: dtcgDimension(FOCUS_RING.offset) },
    'chart-stroke': Object.fromEntries(Object.entries(CHART_STROKES).map(([name, value]) => [name, dtcgDimension(value)])),
    'z-index': Object.fromEntries(Object.entries(Z_INDEX).map(([name, value]) => [name, dtcgNumber(value)])),
    opacity: Object.fromEntries(Object.entries(OPACITY).map(([name, value]) => [name, dtcgNumber(value)])),
    tooltip: { show: dtcgDuration(TOOLTIP_DELAYS.show), hide: dtcgDuration(TOOLTIP_DELAYS.hide) },
    // An error toast has no duration: it stays until it is closed.
    toast: { success: dtcgDuration(TOAST_DURATIONS.success), action: dtcgDuration(TOAST_DURATIONS.action) },
  }
  /** @param {'light' | 'dark'} scheme */
  const theme = (scheme) => ({
    $description: `EviMed ${DESIGN_TOKENS_VERSION} — the ${scheme} theme: every role resolved to a value. One Figma mode.`,
    role: Object.fromEntries(
      Object.entries(COLOR_ROLES).map(([role, entry]) => [role, dtcgColorToken(colorRole(role, scheme), entry.note)]),
    ),
    own: dtcgColorToken(CHART_OWN[scheme], 'ours, in every comparison'),
    series: Object.fromEntries(CHART_SERIES[scheme].map((value, index) => [String(index + 1), dtcgColorToken(value)])),
  })
  /** @param {'full' | 'reduced'} setting */
  const motion = (setting) => {
    // Reduced motion (spec §9.5): no layer travels, no fade longer than fast.
    const cap = (/** @type {number} */ ms) => (setting === 'reduced' ? Math.min(ms, msOf(MOTION.fast)) : ms)
    return {
      $description: `EviMed ${DESIGN_TOKENS_VERSION} — motion, ${setting === 'full' ? 'as designed' : 'for prefers-reduced-motion'}.`,
      duration: {
        fast: dtcgDuration(cap(msOf(MOTION.fast))),
        base: dtcgDuration(cap(msOf(MOTION.base))),
        slow: dtcgDuration(cap(msOf(MOTION.slow))),
      },
      distance: Object.fromEntries(
        Object.entries(MOTION_DISTANCE).map(([name, value]) => [name, dtcgDimension(setting === 'reduced' ? 0 : value)]),
      ),
    }
  }
  const resolver = {
    $schema: 'https://www.designtokens.org/schemas/2025.10/resolver.json',
    name: 'EviMed',
    version: '2025.10',
    description: `EviMed 设计语言 ${DESIGN_TOKENS_VERSION}: two themes and two motion settings over one base.`,
    sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } },
    modifiers: {
      theme: {
        description: 'The colour scheme; each context is one Figma mode.',
        default: 'light',
        contexts: { light: [{ $ref: 'light.tokens.json' }], dark: [{ $ref: 'dark.tokens.json' }] },
      },
      motion: {
        description: 'prefers-reduced-motion',
        default: 'full',
        contexts: { full: [{ $ref: 'motion-full.tokens.json' }], reduced: [{ $ref: 'motion-reduced.tokens.json' }] },
      },
    },
    resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' }, { $ref: '#/modifiers/motion' }],
  }
  return {
    'base.tokens.json': base,
    'light.tokens.json': theme('light'),
    'dark.tokens.json': theme('dark'),
    'motion-full.tokens.json': motion('full'),
    'motion-reduced.tokens.json': motion('reduced'),
    'evimed.resolver.json': resolver,
  }
}
