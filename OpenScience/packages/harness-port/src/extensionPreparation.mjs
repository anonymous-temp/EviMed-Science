import { canonicalExtensionCoordinate } from '@evimed/domain'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import SEAMS from '../seam-manifest.json' with { type: 'json' }

/** Public content describes an exact coordinate. Trusted controller policy supplies
 * any local acquisition path, script approvals and process containment separately.
 * @typedef {{nativeSpec:string,packageName:string,version:string,integrity:string}} PreparedArtifactBinding */
/** @typedef {{resolve:(coordinate:unknown)=>Promise<PreparedArtifactBinding>,timeoutMs:number,cancelGraceMs:number,terminateAndWait:()=>Promise<void>,approvedBuilds?:string[]}} PreparationPolicy */

/** Wrap only the actual pinned manager inside a controller-owned disposable profile.
 * This object must never be attached to a serving kernel or exposed as a public remote.
 * @param {any} ctx @param {PreparationPolicy} policy */
export async function createNativeExtensionPreparer(ctx, policy) {
  const { PluginManager } = await import('@deepseek-ai/dsh-plugin-manager')
  if (!(ctx.pluginManager instanceof PluginManager) || ctx.get('hmr') !== undefined) throw new Error('extension_preparer_profile_invalid')
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1000 || policy.timeoutMs > 600000
    || !Number.isSafeInteger(policy.cancelGraceMs) || policy.cancelGraceMs < 100 || policy.cancelGraceMs > 30000
    || typeof policy.terminateAndWait !== 'function' || typeof policy.resolve !== 'function') throw new Error('extension_preparer_policy_invalid')
  const manager = ctx.pluginManager
  let occupied = false
  const requestIds = new Set()
  /** @param {unknown} coordinate */
  async function binding(coordinate) {
    canonicalExtensionCoordinate(coordinate)
    const resolved = await policy.resolve(coordinate)
    if (!resolved || typeof resolved.nativeSpec !== 'string' || !resolved.nativeSpec || resolved.nativeSpec.startsWith('-')
      || typeof resolved.packageName !== 'string' || !resolved.packageName || typeof resolved.version !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(resolved.integrity)) throw new Error('extension_preparer_binding_invalid')
    return resolved
  }
  return Object.freeze({
    /** @param {unknown} coordinate @param {AbortSignal} [signal] */
    async inspect(coordinate, signal) {
      signal?.throwIfAborted()
      const resolved = await binding(coordinate)
      const deadline = AbortSignal.timeout(policy.timeoutMs)
      const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
      const answer = await manager.inspect(resolved.nativeSpec, undefined, stop)
      stop.throwIfAborted()
      signal?.throwIfAborted()
      if (answer.status !== 'accepted') return { status: 'refused', problem: answer.problem }
      if ((answer.name !== undefined && answer.name !== resolved.packageName)
        || (answer.version !== undefined && answer.version !== resolved.version)) throw new Error('extension_preparer_identity_mismatch')
      return { status: answer.status, name: answer.name ?? resolved.packageName, version: answer.version ?? resolved.version,
        kind: answer.kind, bundle: answer.bundle, integrity: resolved.integrity }
    },
    /** The caller owns this id through its leased job. Build policy is constructor-only.
     * @param {{coordinate:unknown,requestId:string,exactIdentity:string}} request @param {AbortSignal} [signal] */
    async prepare(request, signal) {
      if (!request || Object.keys(request).some(key => !['coordinate', 'requestId', 'exactIdentity'].includes(key))
        || typeof request.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/u.test(request.requestId)) throw new Error('extension_preparer_request_invalid')
      if (occupied || requestIds.has(request.requestId)) throw new Error('extension_preparer_busy')
      signal?.throwIfAborted()
      const resolved = await binding(request.coordinate)
      if (resolved.integrity !== request.exactIdentity) throw new Error('extension_preparer_identity_mismatch')
      if (occupied || requestIds.has(request.requestId)) throw new Error('extension_preparer_busy')
      occupied = true
      requestIds.add(request.requestId)
      const deadline = AbortSignal.timeout(policy.timeoutMs)
      const stop = signal ? AbortSignal.any([signal, deadline]) : deadline
      /** @type {Promise<unknown>|undefined} */
      let cancellation
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let killTimer
      /** @type {Promise<void>|undefined} */
      let termination
      let terminationError = false
      const cancel = () => {
        cancellation ??= manager.cancelInstall(request.requestId).catch(() => { terminationError = true })
        // Native cancellation normally joins pnpm and restores files. The outer
        // provider kills and joins the whole disposable process if it exceeds grace.
        killTimer ??= setTimeout(() => {
          termination = policy.terminateAndWait().catch(() => { terminationError = true })
        }, policy.cancelGraceMs)
      }
      const pending = manager.installBundle(resolved.nativeSpec, { requestId: request.requestId, enabled: false,
        ...(policy.approvedBuilds === undefined ? {} : { approvedBuilds: [...policy.approvedBuilds] }) })
      stop.addEventListener('abort', cancel, { once: true })
      if (stop.aborted) cancel()
      try {
        const result = await pending
        if (cancellation) await cancellation
        if (termination) await termination
        if (terminationError) throw new Error('extension_preparer_termination_failed')
        if (result.application === 'failed') return { status: 'failed', code: result.error?.code ?? 'operation-error' }
        if (result.application === 'cancelled') return { status: 'cancelled' }
        const bundles = await manager.listBundles()
        const installed = bundles.find((/** @type {any} */ bundle) => bundle.name === resolved.packageName)
        if (!installed || installed.version !== resolved.version || installed.error || installed.enabled) throw new Error('extension_preparer_inventory_mismatch')
        return { status: 'prepared', name: installed.name, version: installed.version, integrity: resolved.integrity,
          application: result.application, rows: installed.rows.map((/** @type {any} */ row) => ({ rowId: row.rowId, moduleName: row.moduleName })) }
      } finally {
        stop.removeEventListener('abort', cancel)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (termination) await termination
        occupied = false
      }
    },
    async inventory() {
      return (await manager.listBundles()).map((/** @type {any} */ item) => ({ name: item.name, version: item.version ?? null,
        installed: item.installed, enabled: item.enabled, error: item.error?.code ?? null,
        rows: item.rows.map((/** @type {any} */ row) => ({ rowId: row.rowId, moduleName: row.moduleName })) }))
    },
  })
}

/** Native profile bootstrap for an ALREADY isolated controller job. This helper
 * provides no mount, network or process isolation: the controller must supply it.
 * No customer workspace, credential or control socket belongs in that process.
 * Both filesystem locations and the executable are trusted deployment settings.
 * @param {{profileRoot:string,installationAnchor:string,pnpmCommand:string,onProgress?:(state:{requestId:string,phase:string})=>void}} options
 * @param {PreparationPolicy} policy */
export async function createDisposableNativeExtensionPreparer(options, policy) {
  if (!path.isAbsolute(options.profileRoot) || !path.isAbsolute(options.installationAnchor)
    || typeof options.pnpmCommand !== 'string' || !options.pnpmCommand) throw new Error('extension_preparer_bootstrap_invalid')
  const root = await realpath(options.profileRoot)
  if (root !== path.resolve(options.profileRoot) || (await readdir(root)).length !== 0) throw new Error('extension_preparer_profile_not_empty')
  const installationAnchor = await realpath(options.installationAnchor)
  const installation = JSON.parse(await readFile(installationAnchor, 'utf8'))
  if (installation.version !== '0.1.7-rc.2') throw new Error('extension_preparer_kernel_version_invalid')
  const home = path.join(root, 'home')
  const profile = path.join(root, 'profile')
  await mkdir(home, { mode: 0o700 }); await mkdir(profile, { mode: 0o700 })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'evimed-extension-preparation', private: true,
    packageManager: `pnpm@${SEAMS.pnpm}`, dsh: { profile: { bundles: [] } } }), { mode: 0o600, flag: 'wx' })
  await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600, flag: 'wx' })
  const [{ Context }, { PluginManager }] = await Promise.all([import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-plugin-manager')])
  const ctx = new Context()
  try {
    ctx.provide('profileContext', { name: 'extension-preparation', dir: profile, patchPath: path.join(profile, 'cordis.patch.yml'),
      installAnchor: installationAnchor, cwd: profile, home, overlays: [], startedBundles: [], telemetryDisabledEnv: '1',
      packageManager: { command: options.pnpmCommand, args: [], env: { PATH: process.env.PATH ?? '', HOME: home,
        XDG_CACHE_HOME: path.join(home, 'cache'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' } } })
    // Preparation performs metadata composition only; no candidate loader/plugin
    // is instantiated, so no row is allowed to execute in this context.
    ctx.provide('loader', /** @type {any} */ ({ entries: () => [] }))
    new PluginManager(ctx, { pnpmCommand: options.pnpmCommand, outputBytes: 16384, lockWaitMs: 1000,
      inspectTimeoutMs: Math.min(policy.timeoutMs, 20000), githubConnectionTimeoutMs: 5000,
      idleTimeoutMs: Math.min(policy.timeoutMs, 60000), fallbackRegistries: [] })
    if (options.onProgress) ctx.on('plugin-manager/install-state', (state) => {
      options.onProgress?.({ requestId: state.requestId, phase: state.phase })
    })
    const preparer = await createNativeExtensionPreparer(ctx, policy)
    return { preparer, dispose: async () => { await ctx.fiber.dispose() } }
  } catch {
    await ctx.fiber.dispose()
    throw new Error('extension_preparer_bootstrap_failed')
  }
}
