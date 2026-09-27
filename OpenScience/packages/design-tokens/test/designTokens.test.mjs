/**
 * The token table's own promises.
 *
 * Not a snapshot of every value — that test would only assert that the file
 * equals itself. These are the invariants the design language claims out loud
 * and that a well-meant edit can quietly break.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'

import { artifacts, artifactDigests, readRelease, releaseProblems } from '../src/generate.mjs'
import {
  CHART_COLORS,
  CJK_PUNCT_FACES,
  CJK_PUNCT_RANGE,
  COLOR_RAMPS,
  COLOR_ROLES,
  CONTAINERS,
  CONTROL_HEIGHTS,
  DESIGN_TOKENS_VERSION,
  FONT_STACKS,
  FONT_STACKS_EN,
  MOTION,
  RADII,
  STUDY_TYPE_BADGES,
  TOAST_DURATIONS,
  TYPE_SCALE,
  TYPE_SIZES,
  Z_INDEX,
  colorRole,
  resolveColor,
} from '../src/index.mjs'
import { contrastFailures, contrastRatio, measureContrast, quotedContrast } from '../src/contrast.mjs'
import { designTokensCss } from '../src/css.mjs'
import { dtcgColor, tailwindPreset } from '../src/artifacts.mjs'
import { kernelThemeTokens } from '../src/kernel.mjs'

test('every contrast promise in the table is measured and kept', () => {
  assert.deepEqual(contrastFailures(), [])
})

test('the type scale is closed: no rung invents a size', () => {
  const used = [...new Set(Object.values(TYPE_SCALE).map((rung) => rung.size))].sort((a, b) => a - b)
  assert.deepEqual(used, [...TYPE_SIZES].filter((size) => used.includes(size)))
  for (const [name, rung] of Object.entries(TYPE_SCALE)) {
    assert.ok(TYPE_SIZES.includes(rung.size), `rung "${name}" is ${rung.size}px, which is outside the scale`)
  }
})

test('the brand keeps EviMed\'s live colour to the byte', () => {
  // The platform is live and its logo is this blue. A tuned ramp is fine; this
  // step is not ours to tune.
  assert.equal(COLOR_RAMPS.brand[600], '#0a5dc1')
  assert.equal(colorRole('accent', 'light'), '#0a5dc1')
})

test('every role resolves in both schemes', () => {
  for (const role of Object.keys(COLOR_ROLES)) {
    for (const scheme of /** @type {const} */ (['light', 'dark'])) {
      const value = resolveColor(colorRole(role, scheme))
      assert.match(value, /^(#[0-9a-f]{6}|rgba?\()/, `--${role} (${scheme}) is "${value}"`)
    }
  }
})

test('a comparison chart puts us in the brand and every rival in grey', () => {
  assert.equal(CHART_COLORS.own, COLOR_RAMPS.brand[600])
  for (const rival of CHART_COLORS.rivals) {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(rival.slice(offset, offset + 2), 16))
    const spread = Math.max(r, g, b) - Math.min(r, g, b)
    assert.ok(spread <= 20, `rival colour ${rival} is not a grey (channel spread ${spread})`)
  }
})

test('every rival is a visible graphic on white, darkest for the highest rank (appendix E #22)', () => {
  const white = colorRole('surface', 'light')
  const ratios = CHART_COLORS.rivals.map((rival) => contrastRatio(rival, white))
  for (const [index, ratio] of ratios.entries()) {
    // Unrounded: the third rival sits at 3.12 on white and 3.0099 on the page.
    assert.ok(ratio >= 3, `rival ${index + 1} is ${ratio}:1 on white`)
  }
  for (let index = 1; index < ratios.length; index += 1) {
    assert.ok(ratios[index] < ratios[index - 1], `rival ${index + 1} is not lighter than rival ${index}`)
  }
})

test('contrast is compared unrounded — a pair just over a floor is not rounded onto it', () => {
  // The third rival on the page is 3.0099:1. Rounded it would read 3.01, which
  // is harmless here and exactly the flattery that let a 4.4995 pass 4.5 once.
  const exact = contrastRatio(CHART_COLORS.rivals[2], colorRole('bg', 'light'))
  assert.notEqual(exact, quotedContrast(CHART_COLORS.rivals[2], colorRole('bg', 'light')))
  assert.ok(exact >= 3)
})

test('the diverging scale is blue to a grey middle to orange, its arms matched in lightness', () => {
  const steps = CHART_COLORS.diverging
  assert.equal(steps.length, 7)
  assert.equal(steps[0], COLOR_RAMPS.brand[600])
  const luminance = (/** @type {string} */ hex) => contrastRatio(hex, '#000000')
  // Each arm lightens towards the middle, and the two arms mirror each other.
  for (let index = 0; index < 3; index += 1) {
    assert.ok(luminance(steps[index]) < luminance(steps[index + 1]), `blue step ${index} is not darker than ${index + 1}`)
    assert.ok(luminance(steps[6 - index]) < luminance(steps[5 - index]), `orange step ${6 - index} is not darker than ${5 - index}`)
    const ratio = luminance(steps[index]) / luminance(steps[6 - index])
    assert.ok(ratio > 0.9 && ratio < 1.1, `step ${index} and ${6 - index} differ in lightness (${ratio.toFixed(2)})`)
  }
  // The middle and the missing-data colour are neutral, and not the same.
  for (const grey of [steps[3], CHART_COLORS.missing]) {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(grey.slice(offset, offset + 2), 16))
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 20, `${grey} is not a grey`)
  }
  assert.notEqual(CHART_COLORS.missing, steps[3])
})

test('the version moves with the artifacts (fusion audit F-G3)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, DESIGN_TOKENS_VERSION)
  assert.equal(readRelease().version, DESIGN_TOKENS_VERSION)
  assert.deepEqual(releaseProblems(), [])
  // And the check goes red when a value changes under the same version —
  // proved, not assumed: a check that cannot fail is not a check.
  const tuned = { ...artifacts(), 'tokens.css': artifacts()['tokens.css'].replace('#0a5dc1', '#0a5dc2') }
  const problems = releaseProblems(tuned)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /changed but the version is still/)
  assert.match(problems[0], /tokens\.css/)
  assert.deepEqual(Object.keys(readRelease().artifacts).sort(), Object.keys(artifactDigests()).sort())
})

test('type sizes reach the browser in rem, so its default font size is honoured', () => {
  const css = designTokensCss()
  assert.match(css, /--text-ui: 0\.875rem;/)
  assert.match(css, /--leading-ui: 1\.375rem;/)
  assert.match(css, /--leading-body: 1\.75;/)
  assert.doesNotMatch(css, /--text-[a-z-]+: \d+px;/)
  const fontSize = /** @type {any} */ (tailwindPreset().theme).extend.fontSize
  assert.deepEqual(fontSize.ui, ['0.875rem', '1.375rem'])
  assert.deepEqual(fontSize['doc-title'], ['1.5rem', '2.125rem'])
})

test('the 2.1 font stacks: punctuation face first, system-ui last, no desktop-only faces', () => {
  assert.match(FONT_STACKS.sans, /^"EviMed CJK Punct", Inter,/)
  assert.match(FONT_STACKS.sans, /system-ui, sans-serif$/)
  assert.match(FONT_STACKS.serif, /^"EviMed CJK Punct Serif", "Source Serif 4",/)
  // Windows has no bold 宋体: the serif's Chinese part ends in a sans.
  assert.ok(FONT_STACKS.serif.indexOf('"Microsoft YaHei"') > FONT_STACKS.serif.indexOf('"Source Han Serif SC"'))
  for (const stack of Object.values(FONT_STACKS)) assert.doesNotMatch(stack, /HarmonyOS|MiSans/)
  for (const stack of Object.values(FONT_STACKS_EN)) assert.doesNotMatch(stack, /CJK Punct/)
  const css = designTokensCss()
  for (const face of CJK_PUNCT_FACES) {
    assert.ok(css.includes(`font-family: "${face.family}";\n  font-weight: ${face.weight};`), `${face.family} ${face.weight}`)
    assert.ok(face.local.length > 0)
  }
  assert.equal((css.match(new RegExp(`unicode-range: ${CJK_PUNCT_RANGE.replace(/[+]/g, '\\+')};`, 'g')) ?? []).length, CJK_PUNCT_FACES.length)
  // No face is fetched: every source is a font already on the machine.
  assert.doesNotMatch(css, /url\(/)
})

test('the serif rungs carry their family; English text leaves the punctuation face out', () => {
  const css = designTokensCss()
  const serif = Object.entries(TYPE_SCALE).filter(([, rung]) => rung.family === 'serif').map(([name]) => `.text-${name}`)
  assert.ok(css.includes(`${serif.join(',\n')} {\n  font-family: var(--font-serif);\n}`))
  assert.match(css, /:where\(\[lang\|="en"\]\) \{\n {2}font-family: var\(--font-sans-en\);/)
})

test('layers, toasts and motion are tokens now (spec §11.6)', () => {
  const tiers = Object.values(Z_INDEX)
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b))
  assert.ok(Z_INDEX.popover > Z_INDEX.modal, 'a menu opened in a dialog must show above it')
  assert.ok(Z_INDEX.skip > Z_INDEX.tooltip, 'the skip link is above everything')
  assert.equal(TOAST_DURATIONS.error, 0, 'an error toast has no timer')
  assert.ok(TOAST_DURATIONS.action > TOAST_DURATIONS.success)
  assert.equal(MOTION.easeExit, 'cubic-bezier(0.3, 0, 1, 1)')
  const css = designTokensCss()
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{\n {4}--dur-base: var\(--dur-fast\);/)
  assert.match(css, /--motion-drawer: 0px;/)
})

test('the forced-colours and more-contrast layer ships in the tokens (spec §10.9, appendix E #2)', () => {
  const css = artifacts()['tokens.css']
  assert.match(css, /@media \(forced-colors: active\) \{/)
  assert.match(css, /outline: var\(--focus-ring-width\) solid Highlight;/)
  assert.match(css, /\.el-input__wrapper,\n {2}\.el-textarea__inner,\n {2}\.el-select__wrapper \{\n {4}border: 1px solid ButtonBorder;/)
  assert.match(css, /@media \(prefers-contrast: more\) \{/)
  // "More" is measured like the table itself, in both schemes.
  const more = measureContrast().filter((result) => result.variant === 'more')
  assert.ok(more.length > 0)
  assert.ok(more.every((result) => result.ok))
})

test('the DTCG 2025.10 export is well formed and stands alone per mode', () => {
  const files = Object.fromEntries(
    Object.entries(artifacts())
      .filter(([name]) => name.startsWith('dtcg/'))
      .map(([name, content]) => [name.slice('dtcg/'.length), JSON.parse(content)]),
  )
  const resolver = files['evimed.resolver.json']
  assert.equal(resolver.version, '2025.10')
  assert.deepEqual(Object.keys(resolver.modifiers).sort(), ['motion', 'theme'])
  assert.deepEqual(Object.keys(resolver.modifiers.theme.contexts).sort(), ['dark', 'light'])
  assert.deepEqual(Object.keys(resolver.modifiers.motion.contexts).sort(), ['full', 'reduced'])
  const refs = [
    ...resolver.sets.base.sources,
    ...Object.values(resolver.modifiers).flatMap((modifier) => Object.values(modifier.contexts).flat()),
  ].map((source) => source.$ref)
  for (const ref of refs) assert.ok(files[ref], `the resolver names ${ref}, which is not exported`)
  for (const ref of resolver.resolutionOrder.map((/** @type {any} */ entry) => entry.$ref)) {
    const [, kind, name] = ref.split('/')
    assert.ok(resolver[kind]?.[name], `resolutionOrder points at ${ref}`)
  }

  /** @type {string[]} */
  const problems = []
  let leaves = 0
  /** @param {any} node @param {string} path */
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      if (/[{}.]/.test(key)) problems.push(`${path}${key}: a name may not contain { } or .`)
      if (value && typeof value === 'object' && '$value' in value) {
        leaves += 1
        const where = `${path}${key}`
        const v = value.$value
        if (value.$type === 'color') {
          if (v.colorSpace !== 'srgb' || v.components.length !== 3 || !/^#[0-9a-f]{6}$/.test(v.hex)) problems.push(`${where}: colour shape`)
          else if (v.components.some((/** @type {number} */ c, /** @type {number} */ i) => Math.round(c * 255) !== parseInt(v.hex.slice(1 + i * 2, 3 + i * 2), 16))) problems.push(`${where}: components disagree with hex`)
          if (!(v.alpha >= 0 && v.alpha <= 1)) problems.push(`${where}: alpha`)
        } else if (value.$type === 'dimension') {
          if (v.unit !== 'px' || typeof v.value !== 'number') problems.push(`${where}: dimension shape`)
        } else if (value.$type === 'duration') {
          if (v.unit !== 's' || typeof v.value !== 'number') problems.push(`${where}: duration shape`)
        } else if (value.$type === 'number') {
          if (typeof v !== 'number') problems.push(`${where}: number shape`)
        } else {
          // Composite types (shadow, typography, cubicBezier) are not a subset
          // Figma imports; they stay with the component library.
          problems.push(`${where}: type ${value.$type} is outside the exported subset`)
        }
      } else if (value && typeof value === 'object') {
        walk(value, `${path}${key}.`)
      }
    }
  }
  for (const [name, file] of Object.entries(files)) if (name.endsWith('.tokens.json')) walk(file, `${name}:`)
  assert.deepEqual(problems, [])
  assert.ok(leaves > 200, `only ${leaves} tokens were walked`)

  // One theme file per Figma mode: the same names in both.
  const names = (/** @type {any} */ file) => Object.keys(file.role).sort()
  assert.deepEqual(names(files['light.tokens.json']), names(files['dark.tokens.json']))
  assert.equal(files['light.tokens.json'].role.accent.$value.hex, '#0a5dc1')
  // Reduced motion: nothing travels, no fade is longer than the fast step.
  const reduced = files['motion-reduced.tokens.json']
  for (const token of Object.values(reduced.distance)) assert.equal(/** @type {any} */ (token).$value.value, 0)
  for (const token of Object.values(reduced.duration)) assert.ok(/** @type {any} */ (token).$value.value <= 0.12)
  // An rgba scrim keeps its alpha and still carries a six-digit hex.
  assert.deepEqual(dtcgColor('rgba(15, 19, 24, 0.32)'), { colorSpace: 'srgb', components: [0.0588, 0.0745, 0.0941], alpha: 0.32, hex: '#0f1318' })
})

test('the heat ramp is one hue, monotonically darker — never red to green', () => {
  const luminances = CHART_COLORS.heat.map((hex) =>
    [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).reduce((a, b) => a + b, 0),
  )
  for (let index = 1; index < luminances.length; index += 1) {
    assert.ok(luminances[index] < luminances[index - 1], `heat step ${index} is not darker than ${index - 1}`)
  }
})

test('the three containers are the three the language names', () => {
  assert.equal(CONTAINERS.read, 720)
  assert.equal(CONTAINERS.page, 1040)
  assert.equal(CONTAINERS.wide, 1200)
})

test('geometry stays on the closed sets', () => {
  assert.deepEqual(Object.values(RADII).sort((a, b) => a - b), [6, 8, 12, 16, 24, 999])
  assert.deepEqual([...new Set(Object.values(CONTROL_HEIGHTS))].sort((a, b) => a - b), [22, 28, 36, 44])
})

test('each study type has its own pair and a Chinese label', () => {
  const grounds = new Set()
  for (const [kind, badge] of Object.entries(STUDY_TYPE_BADGES)) {
    assert.match(badge.fg, /^#[0-9a-f]{6}$/, kind)
    assert.match(badge.bg, /^#[0-9a-f]{6}$/, kind)
    assert.ok(badge.label.length > 0, kind)
    assert.ok(!grounds.has(badge.bg), `study type "${kind}" reuses another type's ground`)
    grounds.add(badge.bg)
  }
})

test('the kernel override names only tokens the pinned client reads', () => {
  const tokens = kernelThemeTokens()
  // `overrideTokens` validates shape, not names: a misspelt token is silently
  // ignored, so the prefix is the only guard there is.
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(name, /^--dsw-(static|alias|specific|font)-/, name)
    assert.equal(typeof value.light, 'string', name)
    assert.equal(typeof value.dark, 'string', name)
  }
  // The send button's glyph is a hard-coded #fff on this fill, in both schemes.
  assert.equal(tokens['--dsw-alias-button-info-fill'].light, tokens['--dsw-alias-button-info-fill'].dark)
})

test('generation is deterministic — the same table gives the same bytes', () => {
  assert.equal(designTokensCss(), designTokensCss())
  assert.deepEqual(artifacts(), artifacts())
})

test('the artifacts carry the values, not a copy of them', () => {
  const files = artifacts()
  assert.match(files['tokens.css'], /--accent: var\(--brand-600\)/)
  assert.match(files['element-plus.css'], /--el-color-primary: #0a5dc1;/)
  assert.match(files['tailwind-preset.js'], /"accent": "var\(--accent\)"/)
  assert.equal(JSON.parse(files['echarts-theme.json']).light.color[0], '#0a5dc1')
  assert.equal(JSON.parse(files['dsh-theme.json'])['--dsw-alias-link'].light, '#0a5dc1')
  assert.ok(JSON.parse(files['figma-tokens.json']).global.ramp.brand['600'])
})

test('every contrast figure the table quotes is the figure it measures', () => {
  // The `note` fields were prose until 2026-09-26 and two of them were already
  // fiction. A number a reader can quote has to be one the code can reproduce,
  // or the table is documentation of itself.
  const mismatched = []
  for (const [role, entry] of Object.entries(COLOR_ROLES)) {
    const quoted = /(\d+\.\d+) on the page/.exec(entry.note ?? '')
    if (!quoted) continue
    const measured = quotedContrast(resolveColor(colorRole(role, 'light')), resolveColor(colorRole('bg', 'light')))
    if (Math.abs(measured - Number(quoted[1])) > 0.005) {
      mismatched.push(`--${role}: note says ${quoted[1]}, measures ${measured.toFixed(2)}`)
    }
  }
  assert.deepEqual(mismatched, [])
})
