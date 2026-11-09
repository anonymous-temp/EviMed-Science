#!/usr/bin/env node
// R18: pack every VCR bundle with `pnpm pack`, install the packed artifacts into (a) clean standalone DSH profiles and (b) a copy of the hosted
// composition, probe register / call / uninstall for each bundle alone and for all together, and record every case.
//
//   node scripts/ops/vcr-packed-install-probe.mjs --work <new empty dir> --kernel-profile <profile dir holding a DSH CLI and @deepseek-ai/*>
//        --engine <vcr-engine root> [--source-ref <git ref>] [--hosted-home <sealed DSH home of the hosted composition>] [--results <file.json>] [--pack-only]
//
// Never touches the hosted home it is given: it works on a copy under --work. Needs R (VCR_R_LIBS) for the standalone calls, and for the hosted
// copy the registry metadata pnpm re-resolves with on `remove` (export pnpm_config_cache_dir to a cache that holds it, or have network).
// Hidden knowledge: the hosted composition builds its config with any subset of the five bundles removed (the socket's patch rows do not
// require them), so a removed bundle simply drops its row; `dsh plugin remove` re-resolves the profile and needs the registry metadata.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLES, checkPackedRelease } from './vcr-packed-install-probe/packed-checks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const argv = process.argv.slice(2)
const arg = (/** @type {string} */ name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const work = arg('--work') && resolve(/** @type {string} */ (arg('--work')))
const kernelProfile = arg('--kernel-profile') && resolve(/** @type {string} */ (arg('--kernel-profile')))
const engine = arg('--engine') && resolve(/** @type {string} */ (arg('--engine')))
const hostedHome = arg('--hosted-home') && resolve(/** @type {string} */ (arg('--hosted-home')))
const packOnly = argv.includes('--pack-only')
const sourceRef = arg('--source-ref')
if (!work || existsSync(work) && readdirSync(work).length) throw new Error('--work must name a new or empty directory')
if (!packOnly && (!kernelProfile || !engine)) throw new Error('--kernel-profile and --engine are required unless --pack-only')
mkdirSync(work, { recursive: true })

/** @type {{id: string, ok: boolean, detail: string}[]} */ const cases = []
const record = (/** @type {string} */ id, /** @type {boolean} */ ok, detail = '') => { cases.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  -- ${detail}` : ''}`) }
/** @param {string} command @param {string[]} args @param {Record<string,string|undefined>} [env] @param {string} [cwd] */
const run = (command, args, env = {}, cwd = work) => spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 600000 })
const tail = (/** @type {any} */ r) => {
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean)
  const errors = lines.filter(line => /error|ERR_|not found|cannot|refus/i.test(line))
  return (errors.length ? errors.slice(0, 3) : lines.slice(-3)).join(' | ').slice(0, 400)
}

// 1. pack ------------------------------------------------------------------------------------------------------------------
const release = join(work, 'release')
// --source-ref packs a committed tree instead of the working tree (other people's unfinished edits would otherwise be in the artifact):
// the packages, the pin file and the two engine files the manifest digests are exported into a scratch repository under --work.
let sourceRoot = repo
if (sourceRef) {
  const top = run('git', ['rev-parse', '--show-toplevel'], {}, repo).stdout.trim()
  const prefix = repo.slice(top.length + 1)
  const exported = join(work, 'source')
  mkdirSync(exported)
  const paths = [`${prefix}/packages`, `${prefix}/deps-version.json`, '项目代码/vcr-engine/R/package-lock.json', '项目代码/vcr-engine/R/domain-snapshot.json']
  const archive = spawnSync(`git -C '${top}' archive '${sourceRef}' ${paths.map(p => `'${p}'`).join(' ')} | tar -x -C '${exported}'`, { shell: true, encoding: 'utf8' })
  if (archive.status !== 0) throw new Error(`source_export_failed: ${archive.stderr}`)
  // pnpm resolves `workspace:` ranges at pack time through the dependent's node_modules links; make exactly those, nothing is installed.
  for (const dir of readdirSync(join(exported, prefix, 'packages'))) {
    const file = join(exported, prefix, 'packages', dir, 'package.json')
    if (!existsSync(file)) continue
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
      if (!String(range).startsWith('workspace:')) continue
      const target = readdirSync(join(exported, prefix, 'packages')).find(other => { try { return JSON.parse(readFileSync(join(exported, prefix, 'packages', other, 'package.json'), 'utf8')).name === name } catch { return false } })
      if (!target) continue
      mkdirSync(join(exported, prefix, 'packages', dir, 'node_modules', dirname(name)), { recursive: true })
      symlinkSync(join(exported, prefix, 'packages', target), join(exported, prefix, 'packages', dir, 'node_modules', name))
    }
  }
  for (const cmd of [['init', '-q'], ['add', '-A', '--', ':!**/node_modules'], ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'commit', '-q', '-m', `export of ${sourceRef}`]]) run('git', cmd, {}, exported)
  sourceRoot = join(exported, prefix)
}
// The checkout pins pnpm 9.4.0; a newer pnpm on the host would refuse to pack unless told the version mismatch is fine.
const packed = run('node', [join(sourceRoot, 'packages/research-plugin-runtime/scripts/pack-release.mjs'), release], { npm_config_pm_on_fail: 'ignore', pnpm_config_pm_on_fail: 'ignore' })
record('pack: pnpm pack of the nine packages and the manifest', packed.status === 0, packed.status === 0 ? '' : tail(packed) + String(packed.stderr).slice(0, 800))
if (packed.status !== 0) finish()
for (const row of checkPackedRelease(release)) record(`packed: ${row.check}`, row.ok, row.detail)
if (packOnly) finish()

// 2. standalone: clean profiles ----------------------------------------------------------------------------------------------
const cli = join(/** @type {string} */ (kernelProfile), 'node_modules/.bin')
const kernelModules = realpathSync(join(/** @type {string} */ (kernelProfile), 'node_modules/@deepseek-ai'))
const baseEnv = { PATH: `${cli}:${process.env.PATH}`, npm_config_store_dir: join(work, 'store'), pnpm_config_store_dir: join(work, 'store') }
const PREFIX = { 'virtual-trial': 'virtual_trial', 'virtual-cohort': 'virtual_cohort', 'virtual-patient': 'virtual_patient', 'synthetic-control': 'synthetic_control' }
const standaloneHome = join(work, 'standalone-home')
const standaloneEnv = { ...baseEnv, DSH_HOME: standaloneHome, VCR_PLUGIN_MODE: 'standalone', VCR_PLUGIN_WORKSPACE: join(work, 'workspace'), VCR_ENGINE_ROOT: /** @type {string} */ (engine) }
mkdirSync(join(work, 'workspace'), { recursive: true })
const dump = (/** @type {string} */ profile, /** @type {Record<string,string|undefined>} */ env) => run('dsh', ['--profile', profile, '--dump-config'], env)
const row = (/** @type {string} */ text, /** @type {string} */ id) => new RegExp(`^- id: evimed-${id}$`, 'm').test(text)
/** The bundles resolve harness-port beside themselves; the probe scripts live in the profile root and need the same copy. */
function linkPort(/** @type {string} */ profileDir) {
  const bundle = BUNDLES.map(id => join(profileDir, 'node_modules/@evimed', id)).find(existsSync)
  if (!bundle) return
  const target = join(realpathSync(bundle), '..', 'harness-port'), link = join(profileDir, 'node_modules/@evimed/harness-port')
  if (!existsSync(link)) symlinkSync(realpathSync(target), link)
}
function linkKernel(/** @type {string} */ profileDir) { const link = join(profileDir, 'node_modules/@deepseek-ai'); if (!existsSync(link)) symlinkSync(kernelModules, link) }
function installStandalone(/** @type {string} */ profile, /** @type {string} */ id) {
  return run('node', [join(release, 'install.mjs'), profile, id], standaloneEnv)
}
function probeStandalone(/** @type {string} */ profile, /** @type {string[]} */ ids) {
  const dir = join(standaloneHome, 'profiles', profile)
  linkKernel(dir); linkPort(dir)
  const results = []
  const domain = ids.filter(id => PREFIX[/** @type {keyof typeof PREFIX} */ (id)])
  const probe = join(dir, 'installed-native.mjs')
  copyFileSync(join(repo, 'packages/research-plugin-runtime/test/installed-native.mjs'), probe)
  if (domain.length === 4) results.push(run('node', [probe], { ...standaloneEnv, WORKSPACE: join(work, 'workspace'), ENGINE_ROOT: /** @type {string} */ (engine) }, dir))
  else for (const id of domain) results.push(run('node', [probe], { ...standaloneEnv, PLUGIN_CASE: PREFIX[/** @type {keyof typeof PREFIX} */ (id)], WORKSPACE: join(work, 'workspace'), ENGINE_ROOT: /** @type {string} */ (engine) }, dir))
  if (ids.includes('virtual-research-suite')) {
    const suite = join(dir, 'installed-suite.mjs')
    copyFileSync(join(repo, 'packages/virtual-research-suite/installed-native.mjs'), suite)
    results.push(run('node', [suite], { ...standaloneEnv, ...(domain.includes('virtual-trial') ? { WITH_TRIAL: '1', WORKSPACE: join(work, 'workspace'), ENGINE_ROOT: /** @type {string} */ (engine) } : {}) }, dir))
  }
  return results
}
function absentProbe(/** @type {string} */ dir, /** @type {string} */ home, /** @type {string[]} */ ids, /** @type {Record<string,string|undefined>} */ env) {
  const script = join(dir, 'absent.mjs')
  copyFileSync(join(here, 'vcr-packed-install-probe/absent.mjs'), script)
  return run('node', [script, ...ids], env, dir)
}
function standaloneCase(/** @type {string} */ name, /** @type {string[]} */ ids) {
  const profile = `p-${name}`, dir = join(standaloneHome, 'profiles', profile)
  for (const id of ids) {
    const r = installStandalone(profile, id)
    record(`standalone ${name}: install ${id} from the packed artifact`, r.status === 0, r.status === 0 ? '' : tail(r))
    if (r.status !== 0) return
  }
  const d = dump(profile, standaloneEnv)
  record(`standalone ${name}: config shows ${ids.length} row(s)`, d.status === 0 && ids.every(id => row(d.stdout, id)) && BUNDLES.filter(id => !ids.includes(id)).every(id => !row(d.stdout, id)), d.status === 0 ? '' : tail(d))
  const results = probeStandalone(profile, ids)
  record(`standalone ${name}: tools register and a call is accepted (${results.length} probe run(s))`, results.length > 0 && results.every(r => r.status === 0), results.map(r => (r.stdout ?? '').trim().split('\n').slice(-1)[0] || tail(r)).join(' ; '))
  for (const id of ids) {
    const r = run('dsh', ['plugin', '--profile', profile, 'remove', `@evimed/${id}`], standaloneEnv)
    record(`standalone ${name}: remove ${id}`, r.status === 0, r.status === 0 ? '' : tail(r))
  }
  const after = dump(profile, standaloneEnv)
  record(`standalone ${name}: config has no VCR row after removal`, after.status === 0 && BUNDLES.every(id => !row(after.stdout, id)), after.status === 0 ? '' : tail(after))
  const left = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  record(`standalone ${name}: profile manifest keeps no @evimed bundle`, !Object.keys(left.dependencies ?? {}).some(n => n.startsWith('@evimed/')) && !(left.dsh?.profile?.bundles ?? []).some((/** @type {string} */ n) => n.startsWith('@evimed/')), JSON.stringify(left.dependencies ?? {}))
  const gone = absentProbe(dir, standaloneHome, ids, standaloneEnv)
  record(`standalone ${name}: the plugin entries no longer resolve`, gone.status === 0, gone.status === 0 ? '' : tail(gone))
}
for (const id of BUNDLES) standaloneCase(id, [id])
standaloneCase('together', [...BUNDLES])

// 3. the hosted composition (a copy; the sealed original is never opened for writing) ------------------------------------------
if (hostedHome) {
  const home = join(work, 'hosted-home')
  cpSync(hostedHome, home, { recursive: true, verbatimSymlinks: true })
  const profileDir = join(home, 'profiles/evimed-runtime')
  const hcli = join(profileDir, 'node_modules/.bin/dsh')
  const storeDir = readFileSync(join(profileDir, 'node_modules/.modules.yaml'), 'utf8').match(/^\s*"?storeDir"?:\s*"?([^",\s]+)/m)?.[1]
  // pnpm refuses a store other than the one the copied node_modules was linked from; the store is only read (a few new package files are added).
  const storeEnv = storeDir ? { npm_config_store_dir: dirname(storeDir), pnpm_config_store_dir: dirname(storeDir) } : {}
  const hEnv = { ...process.env, ...storeEnv, DSH_HOME: home, PATH: `${join(profileDir, 'node_modules/.bin')}:${process.env.PATH}`, VCR_PLUGIN_MODE: undefined }
  const hdump = () => run(hcli, ['--profile', 'evimed-runtime', '--dump-config'], hEnv)
  const base = hdump()
  record('hosted: the copied composition builds its config', base.status === 0, base.status === 0 ? '' : tail(base))
  const baseline = base.stdout
  const modules = readFileSync(join(profileDir, 'node_modules/.modules.yaml'), 'utf8').match(/^\s*"?storeDir"?:\s*"?([^",\s]+)/m)?.[1]
  const artifact = (/** @type {string} */ id) => readdirSync(release).filter(f => f.startsWith(`evimed-${id}-`) && f.endsWith('.tgz')).map(f => join(release, f))[0]
  const storeArgs = modules ? ['--offline', '--store-dir', modules] : []
  const addArgs = (/** @type {string[]} */ ids) => ['plugin', '--profile', 'evimed-runtime', 'add', '--save-prod', '--save-exact', '--ignore-scripts', ...storeArgs, ...ids.map(artifact)]
  // `remove` re-resolves the whole profile, which needs the registry's metadata: no --offline there (add of a tarball does not).
  const removeArgs = (/** @type {string[]} */ ids) => ['plugin', '--profile', 'evimed-runtime', 'remove', ...(modules ? ['--store-dir', modules] : []), ...ids.map(id => `@evimed/${id}`)]
  const order = () => {
    const file = join(profileDir, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8')), bundles = /** @type {string[]} */ (pkg.dsh.profile.bundles)
    const native = BUNDLES.map(id => `@evimed/${id}`)
    const ordered = bundles.filter(n => !native.includes(n)); ordered.splice(ordered.indexOf('@evimed/dsh-socket'), 0, ...native)
    pkg.dsh.profile.bundles = ordered; writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  }
  const hostedProbe = (/** @type {string[]} */ ids) => {
    linkPort(profileDir)
    const script = join(profileDir, 'hosted-probe.mjs')
    copyFileSync(join(here, 'vcr-packed-install-probe/hosted.mjs'), script)
    return run('node', [script, ...ids], hEnv, profileDir)
  }
  const restoreAll = () => { const a = run(hcli, addArgs(BUNDLES), hEnv); order(); return a }
  for (const id of BUNDLES) {
    const r = run(hcli, removeArgs([id]), hEnv)
    record(`hosted ${id}: remove from the composition`, r.status === 0, r.status === 0 ? '' : tail(r))
    const d = hdump()
    record(`hosted ${id}: composition without it builds and has no such row`, d.status === 0 && !row(d.stdout, id), d.status === 0 ? '' : tail(d))
    const a = run(hcli, addArgs([id]), hEnv); order()
    record(`hosted ${id}: install the packed artifact`, a.status === 0, a.status === 0 ? '' : tail(a))
    const d2 = hdump()
    record(`hosted ${id}: config equals the original byte for byte`, d2.status === 0 && d2.stdout === baseline, d2.status === 0 ? '' : tail(d2))
    const p = hostedProbe([id])
    record(`hosted ${id}: alone, its tools register through the host adapter, a call is accepted, they leave with the provider`, p.status === 0, p.status === 0 ? '' : tail(p))
  }
  const rm = run(hcli, removeArgs([...BUNDLES]), hEnv)
  record('hosted all: remove the five together', rm.status === 0, rm.status === 0 ? '' : tail(rm))
  const dNone = hdump()
  record('hosted all: composition with none of them builds and has none of the rows', dNone.status === 0 && BUNDLES.every(id => !row(dNone.stdout, id)), dNone.status === 0 ? '' : tail(dNone))
  const gone = absentProbe(profileDir, home, BUNDLES, hEnv)
  record('hosted all: the plugin entries no longer resolve', gone.status === 0, gone.status === 0 ? '' : tail(gone))
  const all = restoreAll()
  record('hosted all: install the five packed artifacts in one command', all.status === 0, all.status === 0 ? '' : tail(all))
  const dAll = hdump()
  record('hosted all: config equals the original byte for byte', dAll.status === 0 && dAll.stdout === baseline, dAll.status === 0 ? '' : tail(dAll))
  const pAll = hostedProbe([...BUNDLES])
  record('hosted all: five bundles together register, a call to each is accepted, the suite sees the four, all leave with the provider', pAll.status === 0, pAll.status === 0 ? '' : tail(pAll))
}
finish()

function finish() {
  const failed = cases.filter(c => !c.ok)
  const file = arg('--results')
  if (file) writeFileSync(resolve(file), JSON.stringify({ at: new Date().toISOString(), passed: cases.length - failed.length, failed: failed.length, cases }, null, 2) + '\n')
  console.log(`\n${cases.length - failed.length}/${cases.length} cases passed`)
  process.exit(failed.length ? 1 : 0)
}
