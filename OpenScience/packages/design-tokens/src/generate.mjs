#!/usr/bin/env node
/**
 * Write the six artifacts into `dist/`, after checking the table keeps its
 * contrast promises.
 *
 *   node src/generate.mjs           # write
 *   node src/generate.mjs --check   # exit 1 if any artifact is stale
 *
 * `--check` runs in CI. An artifact nobody checks is how two hand-maintained
 * tables drifted in the first place, and a generated file is only a single
 * source while something fails when it goes stale.
 *
 * @module @evimed/design-tokens/generate
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { echartsTheme, elementPlusCss, figmaTokens, tailwindPresetModule } from './artifacts.mjs'
import { contrastFailures } from './contrast.mjs'
import { standaloneTokensCss } from './css.mjs'
import { DESIGN_TOKENS_VERSION } from './index.mjs'
import { kernelThemeTokens } from './kernel.mjs'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

/** @param {unknown} value @returns {string} */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Artifact name → its bytes. The whole output of the package, in one place.
 * @returns {Record<string, string>}
 */
export function artifacts() {
  return {
    'tokens.css': standaloneTokensCss(),
    'tailwind-preset.js': tailwindPresetModule(),
    'element-plus.css': elementPlusCss(),
    'echarts-theme.json': json({ light: echartsTheme('light'), dark: echartsTheme('dark') }),
    'dsh-theme.json': json(kernelThemeTokens()),
    'figma-tokens.json': json(figmaTokens()),
  }
}

const failures = contrastFailures()
if (failures.length > 0) {
  console.error(`design tokens: ${failures.length} contrast promise(s) broken — the build stops here.`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

const files = artifacts()
const checking = process.argv.includes('--check')
/** @type {string[]} */
const stale = []

mkdirSync(dist, { recursive: true })
for (const [name, content] of Object.entries(files)) {
  const path = `${dist}${name}`
  if (checking) {
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      current = ''
    }
    if (current !== content) stale.push(name)
  } else {
    writeFileSync(path, content)
  }
}

if (checking) {
  if (stale.length > 0) {
    console.error(`design tokens: stale artifact(s) — run \`pnpm --filter @evimed/design-tokens build\`:`)
    for (const name of stale) console.error(`  dist/${name}`)
    process.exit(1)
  }
  console.log(`design tokens ${DESIGN_TOKENS_VERSION}: ${Object.keys(files).length} artifacts up to date`)
} else {
  console.log(`design tokens ${DESIGN_TOKENS_VERSION}: wrote ${Object.keys(files).length} artifacts to dist/`)
}
