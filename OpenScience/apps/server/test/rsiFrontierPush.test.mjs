// The production side of the monthly RSI snapshot: the push script and its systemd unit. The script runs with `docker` and
// `rsync` replaced by recorders, against directories of its own.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'

const deploy = new URL('../../../deploy/rsi-campaign/production/', import.meta.url)
const SCRIPT = new URL('rsi-frontier-push.sh', deploy).pathname

/** @param {string} dockerBody the fake `docker`'s shell body; it is handed the export script on stdin */
async function host(dockerBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rsi-push-'))
  const dirs = { bin: path.join(root, 'bin'), lib: path.join(root, 'lib'), conf: path.join(root, 'conf'), out: path.join(root, 'out'), log: path.join(root, 'calls.log') }
  for (const dir of [dirs.bin, dirs.lib, dirs.conf]) await mkdir(dir)
  await writeFile(path.join(dirs.lib, 'rsi-frontier-export.mjs'), '// the export\n')
  await writeFile(path.join(dirs.conf, 'lab-host'), 'lab.example\n')
  await writeFile(path.join(dirs.bin, 'docker'), `#!/usr/bin/env bash\necho "docker $*" >> "${dirs.log}"\ncat > /dev/null\n${dockerBody}\n`)
  await writeFile(path.join(dirs.bin, 'rsync'), `#!/usr/bin/env bash\necho "rsync \${@: -2}" >> "${dirs.log}"\n`)
  await chmod(path.join(dirs.bin, 'docker'), 0o755); await chmod(path.join(dirs.bin, 'rsync'), 0o755)
  const run = (/** @type {string} */ month = '2026-10') => spawnSync('bash', [SCRIPT, month], { encoding: 'utf8',
    env: { ...process.env, PATH: `${dirs.bin}:${process.env.PATH}`, RSI_LIB_DIR: dirs.lib, RSI_EXPORT_DIR: dirs.out, RSI_CONFIG_DIR: dirs.conf } })
  return { ...dirs, run, calls: async () => (await readFile(dirs.log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    listing: async () => (await readdir(dirs.out).catch(() => [])).sort(), cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('the export is niced and heap-capped inside the container, compressed as it streams, and pushed data first and checksum last', async () => {
  const h = await host(`echo '{"days":[1,2,3]}'`)
  try {
    const result = h.run()
    assert.equal(result.status, 0, result.stderr)
    const calls = await h.calls()
    assert.match(calls[0], /^docker exec -i \S+ nice -n 10 node --max-old-space-size=512 --input-type=module - --from 2026-08-01 --to 2026-09-30$/)
    assert.deepEqual(await h.listing(), ['frontier-2026-10.json.gz', 'frontier-2026-10.json.gz.sha256'], 'no temporary file is left')
    const archive = await readFile(path.join(h.out, 'frontier-2026-10.json.gz'))
    assert.equal(gunzipSync(archive).toString(), '{"days":[1,2,3]}\n')
    assert.equal((await readFile(path.join(h.out, 'frontier-2026-10.json.gz.sha256'), 'utf8')).split(' ')[0], createHash('sha256').update(archive).digest('hex'))
    assert.deepEqual(calls.slice(1), [`rsync ${h.out}/frontier-2026-10.json.gz rsi-inbox@lab.example:frontier-2026-10.json.gz`,
      `rsync ${h.out}/frontier-2026-10.json.gz.sha256 rsi-inbox@lab.example:frontier-2026-10.json.gz.sha256`])
    // Run again: the export is there, nothing is exported twice and the push is repeated.
    assert.equal(h.run().status, 0)
    assert.equal((await h.calls()).filter(line => line.startsWith('docker')).length, 1)
  } finally { await h.cleanup() }
})

test('a failed export leaves nothing on the host, not even a partial archive or an uncompressed copy, and pushes nothing', async () => {
  const h = await host(`echo '{"days":[1,'\nexit 7`)
  try {
    await mkdir(h.out)
    // What an earlier version of the script left behind after a failure.
    await writeFile(path.join(h.out, 'frontier-2026-10.json.tmp'), '{"uncompressed":true}')
    const result = h.run()
    assert.notEqual(result.status, 0)
    assert.deepEqual(await h.listing(), [])
    assert.equal((await h.calls()).some(line => line.startsWith('rsync')), false)
    // The retry finds a clean directory.
    await writeFile(path.join(h.bin, 'docker'), `#!/usr/bin/env bash\ncat > /dev/null\necho '{"ok":true}'\n`)
    assert.equal(h.run().status, 0)
    assert.deepEqual(await h.listing(), ['frontier-2026-10.json.gz', 'frontier-2026-10.json.gz.sha256'])
  } finally { await h.cleanup() }
})

test('the unit retries a failure a few times, spaced out, and then stays failed for the operator', async () => {
  const text = await readFile(new URL('evimed-rsi-frontier-push.service', deploy), 'utf8')
  /** @type {Record<string, Record<string, string>>} */
  const sections = {}
  let section = ''
  for (const line of text.split('\n')) {
    const header = /^\[(\w+)\]$/.exec(line)
    if (header) { section = header[1]; sections[section] = {}; continue }
    const pair = /^(\w+)=(.*)$/.exec(line)
    if (pair && section) sections[section][pair[1]] = pair[2]
  }
  assert.equal(sections.Service.Restart, 'on-failure')
  assert.equal(sections.Service.RestartSec, '15min')
  assert.equal(sections.Unit.StartLimitIntervalSec, '6h')
  assert.equal(sections.Unit.StartLimitBurst, '4')
  assert.equal(sections.Service.Type, 'oneshot')
})

const exportScript = new URL('../../../scripts/ops/rsi-frontier-export.mjs', import.meta.url).pathname
const repoRoot = new URL('../../../', import.meta.url).pathname

/**
 * A serving release for the export, as a directory: the real frontier pipeline, editor and domain re-exported, a configuration of `config`, a database
 * that records every statement and answers the module-policy read with `policyRow`, and — `serving` — the real serving adapters, an older module
 * without `rsiIncumbent`, or none at all. Returns what the export wrote and the statements it sent.
 * @param {{config:any, policyRow?:any, serving:'real'|'older'|'absent'}} release
 */
async function exportFrom({ config, policyRow = null, serving }) {
  const app = await mkdtemp(path.join(os.tmpdir(), 'rsi-export-app-'))
  try {
    const put = async (/** @type {string} */ file, /** @type {string} */ text) => { await mkdir(path.dirname(path.join(app, file)), { recursive: true }); await writeFile(path.join(app, file), text) }
    const real = (/** @type {string} */ file) => `export * from ${JSON.stringify(`file://${path.join(repoRoot, file)}`)}\n`
    await put('apps/server/src/config.mjs', `export const loadConfig = () => (${JSON.stringify(config)})\n`)
    await put('apps/server/src/controlPlaneDatabase.mjs', `import { appendFileSync } from 'node:fs'
export class ControlPlaneDatabase {
  constructor() { this.pool = { connect: async () => ({ release() {}, query: async (sql, params = []) => {
    appendFileSync(process.env.FAKE_QUERY_LOG, JSON.stringify({ sql, params }) + '\\n')
    return { rows: /evimed_product\\.documents/.test(sql) ? ${JSON.stringify(policyRow ? [policyRow] : [])} : [] }
  } }) } }
  async close() {}
}
`)
    for (const file of ['apps/server/src/frontierPipeline.mjs', 'apps/server/src/frontierEditor.mjs', 'packages/domain/index.mjs']) await put(file, real(file))
    for (const file of ['packages/domain/src/frontierMix.mjs', 'packages/domain/src/frontierSelection.mjs', 'packages/domain/src/frontier-selection.json', 'packages/domain/src/frontierGenres.mjs',
      'packages/domain/src/frontierVocabulary.mjs']) await put(file, '// consumer file\n')
    if (serving === 'real') await put('apps/server/src/rsiServingAdapters.mjs', real('apps/server/src/rsiServingAdapters.mjs'))
    if (serving === 'older') await put('apps/server/src/rsiServingAdapters.mjs', 'export const createRsiServingAdapters = () => null\n')
    const log = path.join(app, 'queries.jsonl')
    const done = spawnSync(process.execPath, ['--input-type=module', '-', '--from', '2026-10-01', '--to', '2026-10-01'], { input: await readFile(exportScript, 'utf8'), encoding: 'utf8',
      env: { PATH: process.env.PATH, RSI_EXPORT_APP_ROOT: app, FAKE_QUERY_LOG: log, OPEN_SCIENCE_RELEASE_ID: 'release-test.1' }, maxBuffer: 1 << 24 })
    assert.equal(done.status, 0, done.stderr)
    const queries = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return { document: JSON.parse(done.stdout), queries }
  } finally { await rm(app, { recursive: true, force: true }) }
}

test('the export reads the incumbent policy row by the serving layer\'s own statement, owner included, and names it by the serving layer\'s own function', async () => {
  const { createRsiServingAdapters, rsiIncumbent, rsiPolicyDefaults } = await import('../src/rsiServingAdapters.mjs')
  const config = { operatorUsers: ['operator-1', 'operator-2'], frontierSelectThreshold: 64, frontierTimeZone: 'Asia/Shanghai' }
  const policyRow = { payload: { status: 'active', policy: { selectionThreshold: 70 } }, revision: 7 }
  const { document, queries } = await exportFrom({ config, policyRow, serving: 'real' })
  // What the serving layer itself sends for the same module (its `currentTarget`, owner = the evolution service's owner, the first operator).
  /** @type {{sql:string, params:any[]}[]} */
  const served = []
  const adapters = createRsiServingAdapters({ config: { ...config, rootDir: repoRoot }, service: { owner: async () => config.operatorUsers[0] }, database: {}, documents: {},
    computeClosure: async () => ({ qualified: true, dependencyDigest: 'a'.repeat(64) }) })
  const target = await adapters.currentTarget('frontier-selection', { query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => { served.push({ sql, params }); return { rows: [policyRow] } } })
  const reads = (/** @type {{sql:string}[]} */ list) => list.filter((q) => /evimed_product\.documents/.test(q.sql))
  assert.deepEqual(reads(queries), reads(served), 'the same statement over the same owner and record')
  assert.deepEqual(reads(queries)[0].params, ['operator-1', 'evolution-module-policy-frontier'])
  assert.deepEqual(document.incumbent, { revisionId: target.baselineRevision, threshold: 70 })
  assert.equal(document.incumbent.revisionId, rsiIncumbent('frontier', policyRow, rsiPolicyDefaults('frontier', config)).revisionId)
  assert.deepEqual([document.settings.threshold, document.settings.thresholdSource], [70, 'module-policy'])
  const exportCode = await readFile(exportScript, 'utf8')
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(exportCode.replace(/\/\*[\s\S]*?\*\//g, '')), 'the export writes nothing')
  assert.doesNotMatch(exportCode, /payload->>'status'/, 'the status of the row is not read by a second rule')
})

test('a release that cannot name its incumbent as the serving layer would still exports the month, without an incumbent, at the configured line', async () => {
  const config = { operatorUsers: ['operator-1'], frontierSelectThreshold: 64, frontierTimeZone: 'Asia/Shanghai' }
  const policyRow = { payload: { status: 'active', policy: { selectionThreshold: 70 } }, revision: 7 }
  for (const [release, why] of [[{ config, policyRow, serving: 'absent' }, 'a release from before the serving adapters'],
    [{ config, policyRow, serving: 'older' }, 'serving adapters without rsiIncumbent'],
    [{ config: { ...config, operatorUsers: [] }, policyRow, serving: 'real' }, 'no operator owns the module policy']]) {
    const { document, queries } = await exportFrom(/** @type {any} */ (release))
    assert.equal(Object.hasOwn(document, 'incumbent'), false, why)
    assert.deepEqual([document.settings.threshold, document.settings.thresholdSource], [64, 'config'], why)
    assert.equal(queries.some((q) => /evimed_product\.documents/.test(q.sql)), false, `${why}: no policy row is read`)
    assert.equal(document.schema, 'rsi-frontier-export-v1')
    assert.equal(document.days.length, 1)
  }
})
