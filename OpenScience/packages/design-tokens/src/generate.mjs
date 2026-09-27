#!/usr/bin/env node
/**
 * Write the artifacts into `dist/`, after checking the table keeps its
 * contrast promises — and keep the version honest about them.
 *
 *   node src/generate.mjs                  # write
 *   node src/generate.mjs --check          # exit 1 if any artifact is stale,
 *                                          # or changed under an unchanged version
 *   node src/generate.mjs --record-release # write, then record this version's
 *                                          # artifact digests in src/release.json
 *
 * `--check` runs in CI. An artifact nobody checks is how two hand-maintained
 * tables drifted in the first place, and a generated file is only a single
 * source while something fails when it goes stale.
 *
 * The version rule (fusion audit F-G3): `src/release.json` holds the digest of
 * every artifact the current version shipped. When the bytes change and the
 * version does not, the check fails — the Vue shell pins a version, and a pin
 * that stays equal while the values move is a pin that cannot see drift.
 * `--record-release` refuses to re-record an unchanged version, so the only
 * way past the check is a version bump.
 *
 * @module @evimed/design-tokens/generate
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { dtcgFiles, echartsTheme, elementPlusCss, figmaTokens, tailwindPresetModule } from './artifacts.mjs'
import { contrastFailures } from './contrast.mjs'
import { standaloneTokensCss } from './css.mjs'
import { DESIGN_TOKENS_VERSION } from './index.mjs'
import { kernelThemeTokens } from './kernel.mjs'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const releaseFile = fileURLToPath(new URL('./release.json', import.meta.url))
const packageFile = fileURLToPath(new URL('../package.json', import.meta.url))

/** @param {unknown} value @returns {string} */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * Artifact name (relative to `dist/`) → its bytes. The whole output of the
 * package, in one place.
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
    ...Object.fromEntries(Object.entries(dtcgFiles()).map(([name, value]) => [`dtcg/${name}`, json(value)])),
  }
}

/**
 * One sha256 per artifact.
 * @param {Record<string, string>} files
 * @returns {Record<string, string>}
 */
export function artifactDigests(files = artifacts()) {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => [name, `sha256:${createHash('sha256').update(content).digest('hex')}`]),
  )
}

/**
 * What `src/release.json` says the current version shipped.
 * @returns {{ version: string, artifacts: Record<string, string> }}
 */
export function readRelease() {
  return JSON.parse(readFileSync(releaseFile, 'utf8'))
}

/**
 * Every way the version and the artifacts disagree, as lines a build log can
 * print. Empty means the version is honest.
 * @param {Record<string, string>} [files]
 * @returns {string[]}
 */
export function releaseProblems(files = artifacts()) {
  /** @type {string[]} */
  const problems = []
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
  const release = readRelease()
  if (pkg.version !== DESIGN_TOKENS_VERSION) {
    problems.push(`package.json says ${pkg.version} and DESIGN_TOKENS_VERSION says ${DESIGN_TOKENS_VERSION}`)
  }
  if (release.version !== DESIGN_TOKENS_VERSION) {
    problems.push(
      `src/release.json records ${release.version}, the table is ${DESIGN_TOKENS_VERSION} — run \`node src/generate.mjs --record-release\``,
    )
    return problems
  }
  const digests = artifactDigests(files)
  const changed = [...new Set([...Object.keys(digests), ...Object.keys(release.artifacts)])]
    .filter((name) => digests[name] !== release.artifacts[name])
    .sort()
  if (changed.length > 0) {
    problems.push(
      `the artifacts changed but the version is still ${DESIGN_TOKENS_VERSION} (${changed.join(', ')}): ` +
        'bump the version in package.json and DESIGN_TOKENS_VERSION (a tuned value is a patch, a new token a minor, ' +
        'a removed or re-meant one a major), then run `node src/generate.mjs --record-release`',
    )
  }
  return problems
}

/** Write every artifact into `dist/`. @param {Record<string, string>} files */
function write(files) {
  for (const [name, content] of Object.entries(files)) {
    const path = `${dist}${name}`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function main() {
  const failures = contrastFailures()
  if (failures.length > 0) {
    console.error(`design tokens: ${failures.length} contrast promise(s) broken — the build stops here.`)
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }

  const files = artifacts()

  if (process.argv.includes('--check')) {
    /** @type {string[]} */
    const stale = []
    for (const [name, content] of Object.entries(files)) {
      let current = ''
      try {
        current = readFileSync(`${dist}${name}`, 'utf8')
      } catch {
        current = ''
      }
      if (current !== content) stale.push(name)
    }
    if (stale.length > 0) {
      console.error('design tokens: stale artifact(s) — run `pnpm --filter @evimed/design-tokens build`:')
      for (const name of stale) console.error(`  dist/${name}`)
      process.exit(1)
    }
    const problems = releaseProblems(files)
    if (problems.length > 0) {
      console.error('design tokens: the version does not match the artifacts:')
      for (const problem of problems) console.error(`  ${problem}`)
      process.exit(1)
    }
    console.log(`design tokens ${DESIGN_TOKENS_VERSION}: ${Object.keys(files).length} artifacts up to date`)
    return
  }

  write(files)

  if (process.argv.includes('--record-release')) {
    const release = readRelease()
    const digests = artifactDigests(files)
    const same = JSON.stringify(release.artifacts) === JSON.stringify(digests)
    if (release.version === DESIGN_TOKENS_VERSION && !same) {
      console.error(
        `design tokens: ${DESIGN_TOKENS_VERSION} is already recorded with other artifacts — bump the version before recording.`,
      )
      process.exit(1)
    }
    writeFileSync(releaseFile, json({ version: DESIGN_TOKENS_VERSION, artifacts: digests }))
    console.log(`design tokens ${DESIGN_TOKENS_VERSION}: recorded ${Object.keys(digests).length} artifact digests in src/release.json`)
    return
  }

  console.log(`design tokens ${DESIGN_TOKENS_VERSION}: wrote ${Object.keys(files).length} artifacts to dist/`)
  const problems = releaseProblems(files)
  if (problems.length > 0) {
    console.error('design tokens: the version does not match the artifacts yet:')
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
}

// Run only as a script: the tests import `artifacts()` from here, and an
// import must not rewrite `dist/` behind the check that reads it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
