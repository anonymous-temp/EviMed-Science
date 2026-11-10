#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = process.argv[2] && resolve(process.argv[2])
if (!output) throw new Error('Usage: node pack-release.mjs <new-output-directory>')
await mkdir(output) // Refuse an existing directory; never overwrite another release.
const names = ['design-tokens', 'domain', 'harness-port', 'research-plugin-runtime', 'virtual-trial', 'virtual-cohort', 'virtual-patient', 'synthetic-control', 'virtual-research-suite']
const artifacts = []
for (const directory of names) {
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'packages', directory, 'package.json'), 'utf8'))
  const name = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`
  const command = spawnSync('pnpm', ['--dir', join(sourceRoot, 'packages', directory), 'pack', '--pack-destination', output], { stdio: 'inherit' })
  if (command.status !== 0) throw new Error(`pack_failed: ${pkg.name}`)
  const bytes = await readFile(join(output, name))
  artifacts.push({ package: pkg.name, version: pkg.version, file: name, bytes: (await stat(join(output, name))).size, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const installer = 'install.mjs'
await copyFile(join(dirname(fileURLToPath(import.meta.url)), installer), join(output, installer))
const installerHash = createHash('sha256').update(await readFile(join(output, installer))).digest('hex')
const engineLock = await readFile(join(sourceRoot, '..', '项目代码', 'vcr-engine', 'R', 'package-lock.json'))
const snapshot = JSON.parse(await readFile(join(sourceRoot, '..', '项目代码', 'vcr-engine', 'R', 'domain-snapshot.json'), 'utf8'))
const pins = JSON.parse(await readFile(join(sourceRoot, 'deps-version.json'), 'utf8'))
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })
const state = spawnSync('git', ['status', '--porcelain', '--', ...names.map(name => `packages/${name}`), 'deps-version.json', '../项目代码/vcr-engine/R/package-lock.json', '../项目代码/vcr-engine/R/domain-snapshot.json'], { cwd: sourceRoot, encoding: 'utf8' })
if (revision.status !== 0 || state.status !== 0) throw new Error('release_source_identity_unavailable')
await writeFile(join(output, 'manifest.json'), JSON.stringify({ format: 1, artifacts,
  source: { revision: revision.stdout.trim(), dirty: Boolean(state.stdout.trim()) },
  compatibility: { dsh: pins.dsh.version },
  installer: { file: installer, sha256: installerHash },
  engine: { requiredSeparately: true, packageLockSha256: createHash('sha256').update(engineLock).digest('hex'),
    methods: Object.fromEntries(Object.entries(snapshot.methods).map(([id, entry]) => [id, /** @type {any} */ (entry).version])) },
}, null, 2) + '\n', { flag: 'wx' })
console.log(`Release created: ${output}`)
