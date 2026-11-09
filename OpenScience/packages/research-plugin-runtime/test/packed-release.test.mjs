// What `pack-release.mjs` puts in the tarballs, with no kernel involved (the kernel half is scripts/ops/vcr-packed-install-probe.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackedRelease } from '../../../scripts/ops/vcr-packed-install-probe/packed-checks.mjs'

test('every packed VCR bundle is installable outside the repository and carries what the composition needs', { timeout: 240000 }, () => {
  const work = mkdtempSync(join(tmpdir(), 'vcr-packed-'))
  try {
    const out = join(work, 'release')
    const run = spawnSync('node', [fileURLToPath(new URL('../scripts/pack-release.mjs', import.meta.url)), out], {
      encoding: 'utf8', env: { ...process.env, npm_config_pm_on_fail: 'ignore', pnpm_config_pm_on_fail: 'ignore' },
    })
    assert.equal(run.status, 0, run.stderr)
    const rows = checkPackedRelease(out)
    assert.ok(rows.length >= 60, `only ${rows.length} checks ran`)
    assert.deepEqual(rows.filter(row => !row.ok), [])
  } finally { rmSync(work, { recursive: true, force: true }) }
})
