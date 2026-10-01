import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { createNativeExtensionPreparer, createDisposableNativeExtensionPreparer } from '../src/extensionPreparation.mjs'

const coordinate = Object.freeze({ kind: 'npm', name: 'evimed-native-test', version: '1.0.0' })
const integrity = `sha256:${'a'.repeat(64)}`

/** Actual manager, actual pnpm and a disposable local bundle; no candidate host code is loaded.
 * @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'evimed-preparer-sdk-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = path.join(root, 'profile')
  const bundle = path.join(root, 'bundle')
  await mkdir(profile); await mkdir(bundle)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-native-test', version: '0.1.7-rc.2', dependencies: {} }))
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'native-test-profile', private: true, packageManager: 'pnpm@11.7.0', dsh: { profile: { bundles: [] } } }))
  await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: coordinate.name, version: coordinate.version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(path.join(bundle, 'cordis.patch.yml'), '[]\n')
  const ctx = new Context()
  ctx.provide('profileContext', { name: 'native-test', dir: profile, patchPath: path.join(profile, 'cordis.patch.yml'),
    installAnchor: path.join(root, 'package.json'), cwd: profile, home: root, overlays: [], startedBundles: [], telemetryDisabledEnv: '1',
    packageManager: { command: 'pnpm', args: [], env: { PATH: process.env.PATH ?? '', HOME: root, DSH_TELEMETRY_DISABLED: '1' } } })
  ctx.provide('loader', { entries: () => [] })
  const manager = new PluginManager(ctx, { pnpmCommand: 'pnpm', outputBytes: 16384, lockWaitMs: 1000, inspectTimeoutMs: 2000,
    githubConnectionTimeoutMs: 2000, idleTimeoutMs: 10000, fallbackRegistries: [] })
  const adapter = await createNativeExtensionPreparer(ctx, { resolve: async () => ({ nativeSpec: bundle, packageName: coordinate.name,
    version: coordinate.version, integrity }), timeoutMs: 20000, cancelGraceMs: 1000, terminateAndWait: async () => {} })
  t.after(() => ctx.fiber.dispose())
  return { adapter, manager, ctx, profile, bundle, root }
}

test('real manager inspects and installs an exact native bundle without activating it', async t => {
  const { adapter, profile } = await fixture(t)
  assert.deepEqual(await adapter.inspect(coordinate), { status: 'accepted', name: coordinate.name, version: '1.0.0', kind: 'path', bundle: true, integrity })
  const result = await adapter.prepare({ coordinate, requestId: 'native-sdk-install', exactIdentity: integrity })
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  assert.equal(result.application, 'restart-required')
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, [])
  assert.ok(manifest.dependencies[coordinate.name])
  assert.deepEqual(await adapter.inventory(), [{ name: coordinate.name, version: '1.0.0', installed: true, enabled: false, error: null, rows: [] }])
})

test('client extras, nonexact coordinates and identity mismatch never start native installation', async t => {
  const { adapter, profile } = await fixture(t)
  const before = await readFile(path.join(profile, 'package.json'), 'utf8')
  await assert.rejects(adapter.prepare(/** @type {any} */ ({ coordinate, requestId: 'bad', exactIdentity: integrity, env: {} })), /extension_preparer_request_invalid/u)
  await assert.rejects(adapter.inspect({ ...coordinate, version: 'latest' }), /extension_contract_invalid/u)
  await assert.rejects(adapter.prepare({ coordinate, requestId: 'bad', exactIdentity: `sha256:${'b'.repeat(64)}` }), /extension_preparer_identity_mismatch/u)
  await assert.rejects(adapter.prepare({ coordinate, requestId: 'stopped', exactIdentity: integrity }, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), before)
})

test('native manager cannot be wrapped on a profile with HMR', async t => {
  const { ctx } = await fixture(t)
  ctx.provide('hmr', {})
  await assert.rejects(createNativeExtensionPreparer(ctx, /** @type {any} */ ({})), /extension_preparer_profile_invalid/u)
})

test('cancellation waits for an actual native pnpm process and restored profile files', async t => {
  const { adapter, manager, ctx, profile } = await fixture(t)
  const before = await readFile(path.join(profile, 'package.json'), 'utf8')
  const controller = new globalThis.AbortController()
  let observedPnpm = false
  ctx.on('plugin-manager/install-log', (/** @type {any} */ output) => {
    if (output.requestId === 'native-cancel' && output.text.length > 0) {
      observedPnpm = true
      controller.abort()
    }
  })
  const result = await adapter.prepare({ coordinate, requestId: 'native-cancel', exactIdentity: integrity }, controller.signal)
  assert.equal(observedPnpm, true, 'must observe output from real pnpm before cancelling')
  assert.equal(result.status, 'cancelled', JSON.stringify(result))
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), before)
  assert.equal(await manager.waitForInstall(/** @type {any} */ ('native-cancel')), null)
})

test('disposable bootstrap constructs real native services and refuses reuse of its profile', async t => {
  const { root, bundle } = await fixture(t)
  const scratch = path.join(root, 'scratch')
  await mkdir(scratch)
  const options = { profileRoot: await realpath(scratch), installationAnchor: path.join(root, 'package.json'), pnpmCommand: 'pnpm' }
  const policy = { resolve: async () => ({ nativeSpec: bundle, packageName: coordinate.name, version: '1.0.0', integrity }),
    timeoutMs: 10000, cancelGraceMs: 1000, terminateAndWait: async () => {} }
  const prepared = await createDisposableNativeExtensionPreparer(options, policy)
  try {
    assert.equal((await prepared.preparer.inspect(coordinate)).status, 'accepted')
    assert.deepEqual(await prepared.preparer.inventory(), [])
    const result = await prepared.preparer.prepare({ coordinate, requestId: 'native-bootstrap', exactIdentity: integrity })
    assert.equal(result.status, 'prepared', JSON.stringify(result))
    await assert.rejects(createDisposableNativeExtensionPreparer(options, policy), /extension_preparer_profile_not_empty/u)
  } finally { await prepared.dispose() }
})
