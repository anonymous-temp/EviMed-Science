#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [profile, product] = process.argv.slice(2)
const products = ['virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control', 'virtual-research-suite']
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile ?? '') || !products.includes(product)) throw new Error('Usage: DSH_HOME=<directory> node install.mjs <new-profile> <product>')
if (!process.env.DSH_HOME) throw new Error('DSH_HOME must name the operator-owned DSH home')
const home = resolve(process.env.DSH_HOME), profileDir = join(home, 'profiles', profile)
let exists = false
try { await access(profileDir); exists = true } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
const bundleDir = dirname(fileURLToPath(import.meta.url))
const manifestBytes = await readFile(join(bundleDir, 'manifest.json'))
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
const manifest = JSON.parse(manifestBytes.toString('utf8'))
if (manifest.format !== 1 || !Array.isArray(manifest.artifacts)) throw new Error('release_manifest_invalid')
const byName = new Map()
for (const artifact of manifest.artifacts) {
  if (!/^evimed-[a-z0-9.-]+\.tgz$/.test(artifact.file) || !/^@evimed\/[a-z0-9-]+$/.test(artifact.package)) throw new Error('release_manifest_invalid')
  const file = join(bundleDir, artifact.file), bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error(`artifact_hash_mismatch: ${artifact.package}`)
  byName.set(artifact.package, file)
}
for (const name of ['@evimed/domain', '@evimed/design-tokens', '@evimed/harness-port', '@evimed/research-plugin-runtime', `@evimed/${product}`]) if (!byName.has(name)) throw new Error(`artifact_missing: ${name}`)
/** @param {string[]} args */
const run = (args) => { const child = spawnSync('dsh', args, { stdio: 'inherit', env: { ...process.env, DSH_HOME: home } }); if (child.status !== 0) throw new Error(`dsh_failed: ${args[0]}`) }
const overrideNames = ['@evimed/domain', '@evimed/design-tokens', '@evimed/harness-port', '@evimed/research-plugin-runtime']
const yaml = `overrides:\n${overrideNames.map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${byName.get(name)}`)}`).join('\n')}\n`
const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')
const receiptPath = join(profileDir, 'evimed-research-release.json')
if (!exists) {
  await mkdir(home, { recursive: true })
  run(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
  const template = await readFile(workspaceFile, 'utf8')
  if (/^overrides\s*:/m.test(template)) throw new Error('profile_template_has_overrides')
  await writeFile(workspaceFile, `\n${yaml}`, { flag: 'a' })
  await writeFile(receiptPath, JSON.stringify({ format: 1, manifestHash, bundleDir }, null, 2), { flag: 'wx' })
} else {
  let receipt
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) } catch { throw new Error('profile_not_managed_by_this_installer') }
  if (receipt.format !== 1 || receipt.manifestHash !== manifestHash || receipt.bundleDir !== bundleDir) throw new Error('profile_release_mismatch')
  if (!(await readFile(workspaceFile, 'utf8')).includes(yaml)) throw new Error('profile_overrides_changed')
}
run(['plugin', '--profile', profile, 'add', byName.get(`@evimed/${product}`), '--ignore-scripts', '--offline'])
console.log(`Installed ${product} in DSH profile ${profile}. Configure its host or standalone adapter before use.`)
