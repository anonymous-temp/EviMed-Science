import './build-inventory.mjs'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const pins = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'))
const destination = resolve(process.argv[2] ?? join(root, '../../../outputs/dsh-patient-matching'))
const stage = await mkdtemp(join(tmpdir(), 'evimed-matching-pack-'))
await mkdir(destination, { recursive: true })
const staged = new Map()
async function stageDependency(name, packageRoot) {
  if (staged.has(name)) return
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  staged.set(name, pkg.version)
  const target = join(stage, 'node_modules', name)
  await mkdir(target, { recursive: true })
  for (const entry of pkg.files ?? (await readdir(packageRoot)).filter(candidate => !['node_modules', 'test', 'tests', '.git'].includes(candidate))) {
    try { await cp(join(packageRoot, entry), join(target, entry), { recursive: true, dereference: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const legal of (await readdir(packageRoot)).filter(candidate => /^(license|notice|copying)(\.|$)/i.test(candidate))) await cp(join(packageRoot, legal), join(target, legal), { recursive: true })
  const { scripts: _scripts, devDependencies: _dev, peerDependencies: _peers, peerDependenciesMeta: _peerMeta, ...published } = pkg
  const dependencies = {}
  const require = createRequire(join(packageRoot, 'package.json'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    const depRoot = dep.startsWith('@evimed/') ? resolve(root, '..', dep.slice('@evimed/'.length)) : dirname(require.resolve(`${dep}/package.json`))
    await stageDependency(dep, depRoot)
    dependencies[dep] = staged.get(dep)
  }
  await writeFile(join(target, 'package.json'), `${JSON.stringify({ ...published, dependencies }, null, 2)}\n`)
}
try {
  for (const entry of manifest.files) await cp(join(root, entry), join(stage, entry), { recursive: true })
  for (const dep of Object.keys(manifest.dependencies)) {
    const depRoot = dep.startsWith('@evimed/') ? resolve(root, '..', dep.slice('@evimed/'.length)) : dirname(createRequire(join(root, 'package.json')).resolve(`${dep}/package.json`))
    await stageDependency(dep, depRoot)
  }
  const { scripts: _scripts, ...published } = manifest
  await writeFile(join(stage, 'package.json'), `${JSON.stringify({ ...published, dependencies: Object.fromEntries(staged), bundledDependencies: [...staged.keys()], files: [...manifest.files, 'compatibility.json'] }, null, 2)}\n`)
  await writeFile(join(stage, 'compatibility.json'), `${JSON.stringify({ kernel: pins.dsh.version, hostAbi: 'patient-matching.host.v1', providerCredential: 'none', reasoning: 'deepseek-flash', dependencies: Object.fromEntries(staged) }, null, 2)}\n`)
  const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { encoding: 'utf8', cwd: stage })
  if (packed.status !== 0) throw new Error(packed.stderr)
  const metadata = JSON.parse(packed.stdout)[0], artifact = join(destination, metadata.filename)
  const bytes = await readFile(artifact), sha256 = createHash('sha256').update(bytes).digest('hex')
  const receipt = { artifact, sha256, integrity: metadata.integrity, bundledDependencies: [...staged.keys()], entries: metadata.files.length }
  await writeFile(`${artifact}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
} finally { await rm(stage, { recursive: true, force: true }) }
