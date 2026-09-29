import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { HOST_PLUGIN_IDS, PLUGIN_SPECIFIERS } from '../index.mjs'

test('the specialist execution context bridge is always mounted at host scope', async () => {
  assert.ok(HOST_PLUGIN_IDS.includes('evimed-engine-context'))
  assert.equal(PLUGIN_SPECIFIERS['evimed-engine-context'], './plugins/engine-context.mjs')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: evimed-engine-context\s+name: '@evimed\/dsh-socket\/plugins\/engine-context'/)
  const plugin = await import('../plugins/engine-context.mjs')
  assert.deepEqual(plugin.inject, ['tools'])
})
