/**
 * The token table's own promises.
 *
 * Not a snapshot of every value — that test would only assert that the file
 * equals itself. These are the invariants the design language claims out loud
 * and that a well-meant edit can quietly break.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { artifacts } from '../src/generate.mjs'
import {
  CHART_COLORS,
  COLOR_RAMPS,
  COLOR_ROLES,
  CONTAINERS,
  CONTROL_HEIGHTS,
  RADII,
  STUDY_TYPE_BADGES,
  TYPE_SCALE,
  TYPE_SIZES,
  colorRole,
  resolveColor,
} from '../src/index.mjs'
import { contrastFailures, quotedContrast } from '../src/contrast.mjs'
import { designTokensCss } from '../src/css.mjs'
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
