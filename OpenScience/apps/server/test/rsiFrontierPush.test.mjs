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

test('the export reads only the live module policy row', async () => {
  const code = await readFile(new URL('../../../scripts/ops/rsi-frontier-export.mjs', import.meta.url), 'utf8')
  assert.match(code, /evolution-module-policy-frontier' AND payload->>'status' = 'active' AND deleted_at IS NULL/)
})
