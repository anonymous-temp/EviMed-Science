import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
  const settings = { model: 'deepseek-flash', provider: 'deepseek', scoreVersion: 'frontier-score-test', node: process.version }
  const actual = await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings })
  assert.equal(actual.qualified, true, actual.issues.join(','))
  // What decides selection and nothing beside it: an unrelated release, a pipeline or another domain module, no longer moves the digest.
  assert.deepEqual(actual.entries.map(entry => entry.path), ['apps/server/src/frontierSelection.mjs', 'packages/domain/src/frontier-selection.json', 'packages/domain/src/frontierGenres.mjs', 'packages/domain/src/frontierMix.mjs', 'packages/domain/src/frontierSelection.mjs', 'packages/domain/src/frontierVocabulary.mjs'])
  assert.deepEqual(actual.dependencies, [])
  const { scoreVersion, ...unscored } = settings
  assert.deepEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: unscored })).issues, ['campaign_closure_configuration_unknown'], 'what a score means is not optional')
  assert.notEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-selection', settings: { ...settings, scoreVersion: `${scoreVersion}-2` } })).dependencyDigest, actual.dependencyDigest, 'a new scale is a new consumer')
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
test('the module consumers have qualified closures from their real roots, one per surface, each bound to what the prompt under test runs in', async () => {
  const rootDir = fileURLToPath(new URL('../../../', import.meta.url))
  const settings = { model: 'deepseek-flash', provider: 'deepseek' }
  const closures = {}
  for (const surface of ['frontier-edit', 'frontier-screen']) {
    closures[surface] = await computeRsiDependencyClosure({ rootDir, surface, settings })
    assert.equal(closures[surface].qualified, true, `${surface}: ${closures[surface].issues.join(',')}`)
    assert.ok(closures[surface].entries.some(entry => entry.path === 'apps/server/src/moduleEvolutionPolicies.mjs'), 'the serving validation is in it')
    assert.ok(closures[surface].entries.some(entry => entry.path === 'apps/server/src/modelGateway.mjs'), 'the call the prompt goes out on is in it')
  }
  assert.ok(closures['frontier-edit'].entries.some(entry => entry.path === 'apps/server/src/frontierEditor.mjs' || entry.path === 'apps/server/src/frontierNumbers.mjs'))
  assert.equal(new Set(Object.values(closures).map(closure => closure.dependencyDigest)).size, 2, 'a surface is part of the digest, so two surfaces of one editor never certify each other')
  assert.notEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-edit', settings: { ...settings, model: 'deepseek-other' } })).dependencyDigest, closures['frontier-edit'].dependencyDigest, 'the solver is part of it')
  // A module with no profile stays refused; settings a profile requires are not optional.
  assert.deepEqual((await computeRsiDependencyClosure({ rootDir, surface: 'geo-supplements', settings })).issues, ['campaign_closure_profile_unknown'])
  assert.deepEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-edit', settings: {} })).issues, ['campaign_closure_configuration_unknown'])
})
test('a dynamic edge is declared or refused: without its declarations the editor\'s graph does not qualify, and a changed reader falls out of its declaration', async () => {
  const { RSI_DEPENDENCY_PROFILES } = await import('../src/rsiDependencyClosure.mjs')
  const rootDir = fileURLToPath(new URL('../../../', import.meta.url))
  const settings = { model: 'deepseek-flash', provider: 'deepseek' }
  const editor = RSI_DEPENDENCY_PROFILES['frontier-edit']
  for (const relative of Object.keys(editor.runtimeFileDependencies)) {
    const { [relative]: _dropped, ...rest } = editor.runtimeFileDependencies
    const registry = { 'frontier-edit': { ...editor, runtimeFileDependencies: rest } }
    assert.deepEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-edit', settings, registry })).issues, ['campaign_closure_runtime_files_undeclared'], relative)
    const stale = { 'frontier-edit': { ...editor, runtimeFileDependencies: { ...rest, [relative]: { sourceDigest: 'f'.repeat(64), resources: [] } } } }
    assert.deepEqual((await computeRsiDependencyClosure({ rootDir, surface: 'frontier-edit', settings, registry: stale })).issues, ['campaign_closure_runtime_files_undeclared'], `${relative}, stale`)
  }
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

test('source-bound runtime file declarations hash resources and reject unreviewed loader changes', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'rsi-declared-'))
  try {
    const source = "import {readFileSync as read} from 'node:fs'; export const value=JSON.parse(read(new URL('./config.json',import.meta.url),'utf8'))"
    await writeFile(path.join(rootDir, 'entry.mjs'), source)
    await writeFile(path.join(rootDir, 'config.json'), '{"value":1}')
    const input = { rootDir, surface: 'test', registry: { test: { roots: ['entry.mjs'], runtimeFileDependencies: { 'entry.mjs': { sourceDigest: createHash('sha256').update(source).digest('hex'), resources: ['config.json'] } } } } }
    const first = await computeRsiDependencyClosure(input)
    assert.equal(first.qualified, true)
    await writeFile(path.join(rootDir, 'config.json'), '{"value":2}')
    assert.notEqual((await computeRsiDependencyClosure(input)).dependencyDigest, first.dependencyDigest)
    await writeFile(path.join(rootDir, 'entry.mjs'), source + '\n// loader changed')
    assert.equal((await computeRsiDependencyClosure(input)).qualified, false)
  } finally { await rm(rootDir, { recursive: true, force: true }) }
})

// A frontier round that edits one of these files (frontierPersistence.mjs gains DDL every round) fails here by name, not as an
// opaque campaign_closure_runtime_files_undeclared deep in the campaign tests: re-read the file's filesystem calls, update its
// `resources` if it reads anything new, then pin the new digest in RSI_DEPENDENCY_PROFILES.
test('every source-bound runtime file declaration is pinned to the file as it is now', async () => {
  const { readFile } = await import('node:fs/promises')
  const { RSI_DEPENDENCY_PROFILES } = await import('../src/rsiDependencyClosure.mjs')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  for (const [surface, profile] of Object.entries(RSI_DEPENDENCY_PROFILES)) {
    for (const [relative, declaration] of Object.entries(profile.runtimeFileDependencies ?? {})) {
      const digest = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')
      assert.equal(declaration.sourceDigest, digest, `${surface}: ${relative} changed — re-audit its filesystem reads, then pin ${digest}`)
    }
  }
})
