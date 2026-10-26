import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeRsiDependencyClosure } from '../src/rsiDependencyClosure.mjs'
test('closure binds helpers and settings but ignores unrelated release files', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'rsi-closure-'))
  try {
    await writeFile(path.join(rootDir, 'entry.mjs'), "import './helper.mjs'")
    await writeFile(path.join(rootDir, 'helper.mjs'), 'export const value=1')
    const registry = { test: { roots: ['entry.mjs'], resources: [] } }
    const input = { rootDir, surface: 'test', registry, settings: { model: 'one' } }
    const first = await computeRsiDependencyClosure(input)
    assert.equal(first.qualified, true)
    await writeFile(path.join(rootDir, 'style.css'), 'color:red')
    assert.equal((await computeRsiDependencyClosure({ ...input, provenance: { image: 'new' } })).dependencyDigest, first.dependencyDigest)
    await writeFile(path.join(rootDir, 'helper.mjs'), 'export const value=2')
    assert.notEqual((await computeRsiDependencyClosure(input)).dependencyDigest, first.dependencyDigest)
    assert.notEqual((await computeRsiDependencyClosure({ ...input, settings: { model: 'two' } })).dependencyDigest, first.dependencyDigest)
    assert.equal((await computeRsiDependencyClosure({ ...input, registry: { test: { roots: ['../escape'] } } })).qualified, false)
    await writeFile(path.join(rootDir, 'entry.mjs'), 'import(variable)')
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
  } finally { await rm(rootDir, { recursive: true, force: true }) }
})
test('path order and absolute checkout location do not affect identity', async () => {
  const roots = await Promise.all([1, 2].map(() => mkdtemp(path.join(tmpdir(), 'rsi-location-'))))
  try {
    for (const rootDir of roots) { await writeFile(path.join(rootDir, 'a.mjs'), 'export const a=1'); await writeFile(path.join(rootDir, 'b.mjs'), 'export const b=2') }
    const a = await computeRsiDependencyClosure({ rootDir: roots[0], surface: 'test', registry: { test: { roots: ['a.mjs', 'b.mjs'] } } })
    const b = await computeRsiDependencyClosure({ rootDir: roots[1], surface: 'test', registry: { test: { roots: ['b.mjs', 'a.mjs'] } } })
    assert.equal(a.qualified, true); assert.equal(a.dependencyDigest, b.dependencyDigest)
    assert.equal((await computeRsiDependencyClosure({ rootDir: roots[0], surface: 'capability-skill' })).qualified, false)
    assert.equal((await computeRsiDependencyClosure({ rootDir: roots[0], surface: 'test', registry: { test: { roots: ['missing.mjs'] } } })).qualified, false)
  } finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) }
})

test('checked-in frontier consumer has a qualified closure independent of UI rebuilds', async () => {
  const rootDir = fileURLToPath(new URL('../../../', import.meta.url))
  const settings = { model: 'deepseek-flash', provider: 'deepseek', node: process.version }
  const actual = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings })
  assert.equal(actual.qualified, true, actual.issues.join(','))
  assert.ok(actual.entries.some(entry => entry.path === 'packages/domain/src/frontierMix.mjs'))
  assert.ok(actual.entries.some(entry => entry.path === 'apps/server/src/frontierTagSeed.json'))
  const copy = await mkdtemp(path.join(tmpdir(), 'rsi-frontier-'))
  try {
    for (const entry of actual.entries) {
      const destination = path.join(copy, entry.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(rootDir, entry.path), destination)
    }
    await copyFile(path.join(rootDir, 'pnpm-lock.yaml'), path.join(copy, 'pnpm-lock.yaml'))
    await mkdir(path.join(copy, 'apps/web/src'), { recursive: true })
    await writeFile(path.join(copy, 'apps/web/src/index.css'), 'body{color:red}')
    const next = await computeRsiDependencyClosure({ rootDir: copy, surface: 'frontier-selection', settings, provenance: { image: 'rebuilt', revision: 'unrelated-ui' } })
    assert.equal(next.qualified, true, next.issues.join(','))
    assert.equal(next.dependencyDigest, actual.dependencyDigest)
    await writeFile(path.join(copy, 'packages/domain/src/frontierMix.mjs'), 'export const changed=true')
    assert.notEqual((await computeRsiDependencyClosure({ rootDir: copy, surface: 'frontier-selection', settings })).dependencyDigest, actual.dependencyDigest)
  } finally { await rm(copy, { recursive: true, force: true }) }
})
test('external versions are derived from owning manifest and affected lock closure', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'rsi-lock-'))
  try {
    await mkdir(path.join(rootDir, 'apps/server/src'), { recursive: true })
    await writeFile(path.join(rootDir, 'apps/server/src/index.mjs'), "import 'external'")
    await writeFile(path.join(rootDir, 'apps/server/package.json'), '{"dependencies":{"external":"1.0.0"}}')
    const lock = 'packages:\n  external@1.0.0:\n    resolution: {integrity: first}\nsnapshots:\n  external@1.0.0: {}\n'
    await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), lock)
    const input = { rootDir, surface: 'test', registry: { test: { roots: ['apps/server/src/index.mjs'], resources: ['pnpm-lock.yaml'] } } }
    const first = await computeRsiDependencyClosure(input)
    assert.equal(first.qualified, true, first.issues.join(','))
    await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), lock.replace('packages:', 'packages:\n  unrelated@2.0.0: {}'))
    assert.equal((await computeRsiDependencyClosure(input)).dependencyDigest, first.dependencyDigest)
    await writeFile(path.join(rootDir, 'pnpm-lock.yaml'), lock.replace('first', 'changed'))
    assert.notEqual((await computeRsiDependencyClosure(input)).dependencyDigest, first.dependencyDigest)
  } finally { await rm(rootDir, { recursive: true, force: true }) }
})
test('CommonJS loaders and undeclared file readers cannot hide dependencies', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'rsi-loader-'))
  try {
    await writeFile(path.join(rootDir, 'helper.cjs'), 'module.exports=1')
    const source = "import { createRequire as loader } from 'node:module'; const require=loader(import.meta.url); require('./helper.cjs')"
    await writeFile(path.join(rootDir, 'entry.mjs'), source)
    const input = { rootDir, surface: 'test', registry: { test: { roots: ['entry.mjs'] } } }
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
    await writeFile(path.join(rootDir, 'helper.cjs'), 'module.exports=2')
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
    await writeFile(path.join(rootDir, 'entry.mjs'), "import * as modules from 'node:module'; modules['create'+'Require'](import.meta.url)(variable)")
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
    await writeFile(path.join(rootDir, 'entry.mjs'), "import { readFileSync as reader } from 'node:fs'; reader('./config.json')")
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
  } finally { await rm(rootDir, { recursive: true, force: true }) }
})
