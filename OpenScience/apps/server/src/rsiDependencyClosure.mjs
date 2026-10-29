import { readFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { init, parse } from 'es-module-lexer'
import { rsiDigest } from './rsiCampaignBundle.mjs'

/** The registry is deployment code, never campaign input. Runtime surfaces remain unqualified until their complete kernel profile is registered. */
export const RSI_DEPENDENCY_PROFILES = Object.freeze({
  'frontier-selection': { roots: ['apps/server/src/frontierPipeline.mjs', 'packages/domain/src/frontierMix.mjs'], resources: ['apps/server/src/frontierTagSeed.json', 'apps/server/package.json', 'packages/domain/package.json', 'pnpm-lock.yaml'], requiredSettings: ['model', 'provider'], requiredPins: [], runtimeFileDependencies: {
    // Only frontierTagSeed is deployment data; security's filesystem helpers operate on caller-owned workspace state, not executable/configuration inputs to selection.
    // Source-bound declarations must be re-audited after either module changes.
    'apps/server/src/frontierPersistence.mjs': { sourceDigest: '68683a7dc9e8175266e2c545388a7c4c5b58d6542394b61190a4045b90f56030', resources: ['apps/server/src/frontierTagSeed.json'] },
    'apps/server/src/security.mjs': { sourceDigest: 'c433c369f8dd1d0d778fab7686498872808ca68b0dec78c3c0f6f25af15b97fb', resources: [] },
  } },
})
/** Compute a source graph without importing or executing candidate code. Unknown dynamic edges fail closed.
 * @param {{rootDir:string,surface:string,registry?:any,settings?:any,pins?:any,provenance?:any}} input */
export async function computeRsiDependencyClosure({ rootDir, surface, registry = RSI_DEPENDENCY_PROFILES, settings = {}, pins = {}, provenance = {} }) {
  try {
    const profile = Object.hasOwn(registry, surface) ? registry[surface] : null
    if (!profile || !profile.roots?.length) throw new Error('campaign_closure_profile_unknown')
    if ((profile.requiredSettings ?? []).some(/** @param {string} key */ key => settings[key] === undefined) || (profile.requiredPins ?? []).some(/** @param {string} key */ key => pins[key] === undefined)) throw new Error('campaign_closure_configuration_unknown')
    const root = await realpath(rootDir); const files = new Map(); const externals = new Map()
    /** @param {string} relative */
    const read = async relative => {
      if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('campaign_closure_path_invalid')
      const absolute = path.resolve(root, relative)
      if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute || !absolute.startsWith(root + path.sep)) throw new Error('campaign_closure_path_invalid')
      const bytes = await readFile(absolute)
      files.set(relative, createHash('sha256').update(bytes).digest('hex'))
      return bytes.toString('utf8')
    }
    await init
    const queue = [...profile.roots]
    const visited = new Set()
    let lock = null
    for (const resource of profile.resources ?? []) {
      const content = await read(resource)
      if (resource === 'pnpm-lock.yaml') { lock = YAML.parse(content); files.delete(resource) }
    }
    while (queue.length) {
      const relative = queue.shift()
      if (visited.has(relative)) continue
      visited.add(relative)
      const source = await read(relative)
      if (relative.endsWith('.cjs')) throw new Error('campaign_closure_commonjs_unsupported')
      if (!/\.[cm]?js$/.test(relative)) continue
      const [imports] = parse(source)
      for (const edge of imports) {
        if (edge.d === -2) continue // import.meta is not a dependency edge.
        if (!edge.n) throw new Error('campaign_closure_dynamic_unresolved')
        const specifier = edge.n
        if (['node:module', 'module', 'node:vm', 'vm'].includes(specifier)) throw new Error('campaign_closure_runtime_loader_unsupported')
        if (['node:fs', 'node:fs/promises', 'fs', 'fs/promises'].includes(specifier)) {
          const declaration = profile.runtimeFileDependencies?.[relative]
          if (!declaration || declaration.sourceDigest !== files.get(relative) || !Array.isArray(declaration.resources)) throw new Error('campaign_closure_runtime_files_undeclared')
          for (const resource of declaration.resources) {
            if (typeof resource !== 'string' || /\.[cm]?js$/.test(resource)) throw new Error('campaign_closure_runtime_loader_unsupported')
            await read(resource)
          }
          continue
        }
        if (specifier.startsWith('node:')) continue
        if (specifier.startsWith('.')) { const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)); queue.push(resolved); continue }
        let workspace = profile.workspacePackages?.[specifier]
        if (!workspace && specifier.startsWith('@evimed/')) {
          const name = specifier.split('/').slice(0, 2).join('/')
          const directory = (/** @type {Record<string,string>} */ ({ '@evimed/domain': 'packages/domain', '@evimed/harness-port': 'packages/harness-port', '@evimed/dsh-socket': 'packages/socket', '@evimed/shared': 'packages/shared' }))[name]
          if (directory) {
            const manifest = JSON.parse(await read(`${directory}/package.json`))
            const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
            const exported = typeof manifest.exports === 'string' && subpath === '.' ? manifest.exports : manifest.exports?.[subpath]
            if (typeof exported !== 'string' || !exported.startsWith('./')) throw new Error('campaign_closure_workspace_unresolved')
            workspace = path.posix.join(directory, exported)
          }
        }
        if (workspace) { queue.push(workspace); continue }
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        let external = profile.externalVersions?.[packageName]
        if (!external) {
          let directory = path.posix.dirname(relative)
          while (directory !== '.') {
            const manifestPath = `${directory}/package.json`
            let present = false
            try { present = (await lstat(path.join(root, manifestPath))).isFile() } catch { /* Walk toward the owning checked-in package. */ }
            if (present) {
              const manifest = JSON.parse(await read(manifestPath))
              external = manifest.dependencies?.[packageName] ?? manifest.optionalDependencies?.[packageName]
              break
            }
            directory = path.posix.dirname(directory)
          }
        }
        if (!external || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(external)) throw new Error('campaign_closure_external_unresolved')
        if (!profile.resources?.includes('pnpm-lock.yaml')) throw new Error('campaign_closure_lock_missing')
        const lockKey = `${packageName}@${external}`
        if (!lock?.packages?.[lockKey]) throw new Error('campaign_closure_lock_unresolved')
        const visitLock = (/** @type {string} */ key) => {
          if (externals.has(key)) return
          const snapshot = lock.snapshots?.[key]; const metadata = lock.packages?.[key.split('(')[0]]
          if (!snapshot || !metadata) throw new Error('campaign_closure_lock_unresolved')
          externals.set(key, rsiDigest({ snapshot, metadata }))
          for (const [name, version] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visitLock(`${name}@${version}`)
        }
        visitLock(lockKey)
      }
    }
    const entries = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, sha256]) => ({ path: file, sha256 }))
    const dependencies = [...externals].sort(([a], [b]) => a.localeCompare(b, 'en'))
    return { qualified: true, issues: [], surface, dependencyDigest: rsiDigest({ surface, entries, dependencies, settings, pins, runtimeFileDependencies: profile.runtimeFileDependencies ?? {} }), entries, dependencies, provenance }
  } catch (error) { return { qualified: false, issues: [error instanceof Error && error.message.startsWith('campaign_') ? error.message : 'campaign_closure_file_unavailable'], surface, dependencyDigest: null, entries: [], dependencies: [], provenance } }
}
