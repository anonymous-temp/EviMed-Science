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
await writeFile(join(output, 'manifest.json'), JSON.stringify({ format: 1, artifacts, installer: { file: installer, sha256: installerHash }, engine: { requiredSeparately: true, packageLockSha256: createHash('sha256').update(engineLock).digest('hex') } }, null, 2) + '\n', { flag: 'wx' })
console.log(`Release created: ${output}`)
