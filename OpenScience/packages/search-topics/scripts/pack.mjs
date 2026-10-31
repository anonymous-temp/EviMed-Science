import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const pins = JSON.parse(await readFile(new URL('../../../deps-version.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const destination = resolve(process.argv[2] ?? join(root, '../../../outputs/dsh-search-topics'))
await mkdir(destination, { recursive: true })
const stage = await mkdtemp(join(tmpdir(), 'evimed-search-topics-pack-'))
try {
  for (const entry of manifest.files) await cp(join(root, entry), join(stage, entry), { recursive: true })
  const { scripts: _scripts, ...published } = manifest
  published.files = [...manifest.files, 'compatibility.json']
  published.engines = { ...manifest.engines, dsh: pins.dsh.version }
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)
  await writeFile(join(stage, 'compatibility.json'), `${JSON.stringify({
    dsh: pins.dsh.version,
    cordis: pins.dsh.cordisVersion ?? pins.dsh.cordis,
    node: manifest.engines.node,
    carrier: 'webServer.register',
    endpoint: 'GET /api/evimed-search/topics',
  }, null, 2)}\n`)
  const result = spawnSync('npm', ['pack', stage, '--json', '--ignore-scripts', '--pack-destination', destination], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`)
  const packed = JSON.parse(result.stdout)[0]
  const artifact = join(destination, packed.filename)
  const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex')
  await writeFile(`${artifact}.sha256`, `${sha256}  ${packed.filename}\n`)
  process.stdout.write(`${JSON.stringify({ artifact, sha256, entries: packed.files.map((/** @type {{path: string}} */ entry) => entry.path) }, null, 2)}\n`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
