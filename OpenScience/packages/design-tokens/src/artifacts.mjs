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
  CHART_COLORS,
  CHART_SERIES,
  COLOR_RAMPS,
  COLOR_ROLE_ALIASES,
  COLOR_ROLES,
  CONTAINERS,
  CONTROL_HEIGHTS,
  DESIGN_TOKENS_VERSION,
  ELEVATION,
  FONT_STACKS,
  MOTION,
  RADII,
  SPACE,
  STUDY_TYPE_BADGES,
  TYPE_SCALE,
  colorRole,
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
  const fontSize = Object.fromEntries(
    Object.entries(TYPE_SCALE).map(([rung, { size, lineHeight }]) => [rung, [`${size}px`, lineHeight]]),
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
        transitionDuration: { fast: MOTION.fast, base: MOTION.base, slow: MOTION.slow },
        transitionTimingFunction: { standard: MOTION.easeStandard },
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
        keyframes: {
          'drawer-in': {
            from: { transform: 'translateX(24px)', opacity: '0' },
            to: { transform: 'translateX(0)', opacity: '1' },
          },
        },
        animation: { 'drawer-in': 'drawer-in var(--dur-base) var(--ease-standard)' },
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
  lines.push(`  --el-font-size-base: ${TYPE_SCALE.ui.size}px;`)
  lines.push(`  --el-font-size-small: ${TYPE_SCALE.compact.size}px;`)
  lines.push(`  --el-font-size-extra-small: ${TYPE_SCALE.meta.size}px;`)
  lines.push(`  --el-font-size-medium: ${TYPE_SCALE.body.size}px;`)
  lines.push(`  --el-font-size-large: ${TYPE_SCALE.heading.size}px;`)
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
    line: { symbol: 'circle', symbolSize: 5, smooth: false, lineStyle: { width: 2 } },
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
    },
  }
}
