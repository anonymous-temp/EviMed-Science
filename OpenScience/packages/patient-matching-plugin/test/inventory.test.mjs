import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TOOL_MANIFEST } from '../src/manifest.mjs'
test('the generated passive domain inventory matches the sole executable tool manifest', async () => {
  const generated = JSON.parse(await readFile(new URL('../../domain/src/patientMatchingTools.json', import.meta.url), 'utf8'))
  assert.deepEqual(generated, TOOL_MANIFEST.map(tool => tool.name))
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/build-inventory.mjs', import.meta.url)), '--check'], { encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
})
