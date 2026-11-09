// The part of the packed-install probe that needs no kernel: what `pack-release.mjs` put in the tarballs.
// Hidden knowledge: pnpm rewrites `workspace:^` to the concrete version at pack time; a tarball that still says `workspace:` cannot be
// installed anywhere but in this repository, which is exactly what a packed-install probe exists to catch.
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUNDLES = ['virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control', 'virtual-research-suite']
const COMMON = ['design-tokens', 'domain', 'harness-port', 'research-plugin-runtime']

/** @param {string} tarball @param {string} member */
function member(tarball, member_) {
  const out = spawnSync('tar', ['-xzOf', tarball, member_], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (out.status !== 0) throw new Error(`tar_member_missing:${member_}`)
  return out.stdout
}
/** @param {string} tarball */
function listing(tarball) {
  const out = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (out.status !== 0) throw new Error('tar_list_failed')
  return out.stdout.split('\n').filter(Boolean).map(line => line.replace(/^package\//, ''))
}

/** Returns one row per check: {check, ok, detail}. @param {string} releaseDir */
export function checkPackedRelease(releaseDir) {
  /** @type {{check: string, ok: boolean, detail: string}[]} */ const rows = []
  const add = (check, ok, detail = '') => rows.push({ check, ok: Boolean(ok), detail })
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'))
  for (const artifact of manifest.artifacts) {
    const file = join(releaseDir, artifact.file)
    add(`hash ${artifact.package}`, createHash('sha256').update(readFileSync(file)).digest('hex') === artifact.sha256)
    const pkg = JSON.parse(member(file, 'package/package.json'))
    const entries = listing(file)
    const declared = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }
    const leaked = Object.entries(declared).filter(([, range]) => String(range).startsWith('workspace:') || String(range).startsWith('file:'))
    add(`no workspace:/file: ranges ${artifact.package}`, leaked.length === 0, leaked.map(([n, r]) => `${n}@${r}`).join(','))
    const short = artifact.package.replace('@evimed/', '')
    if (BUNDLES.includes(short)) {
      const patch = pkg.dsh?.bundle?.patch ?? []
      add(`bundle patch listed and present ${artifact.package}`, patch.length === 1 && entries.includes(patch[0].replace(/^\.\//, '')), patch.join(','))
      add(`plugin entry exported and present ${artifact.package}`, pkg.exports?.['./plugin'] === './plugin.mjs' && entries.includes('plugin.mjs'))
      add(`depends on runtime and port ${artifact.package}`, Boolean(pkg.dependencies?.['@evimed/research-plugin-runtime'] && pkg.dependencies?.['@evimed/harness-port']))
      const patchText = member(file, `package/${patch[0].replace(/^\.\//, '')}`)
      add(`patch row names the plugin ${artifact.package}`, patchText.includes(`${artifact.package}/plugin`) && patchText.includes(`id: evimed-${short}`))
      if (short !== 'virtual-research-suite') add(`skill and examples packed ${artifact.package}`, entries.includes('SKILL.md') && entries.some(e => e.startsWith('examples/')))
    }
    add(`no node_modules or test files ${artifact.package}`, !entries.some(e => e.startsWith('node_modules/') || /(^|\/)test\//.test(e)))
  }
  const names = manifest.artifacts.map((/** @type {any} */ a) => a.package)
  for (const id of [...COMMON, ...BUNDLES]) add(`manifest lists @evimed/${id}`, names.includes(`@evimed/${id}`))
  add('manifest names the DSH pin', typeof manifest.compatibility?.dsh === 'string' && manifest.compatibility.dsh.length > 0)
  return rows
}

export { BUNDLES, COMMON, mkdtempSync, rmSync, tmpdir }
