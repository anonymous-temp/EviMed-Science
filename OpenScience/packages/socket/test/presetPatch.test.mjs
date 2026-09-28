/**
 * The preset as the kernel reads it, generated from the preset as we edit it.
 *
 * DSH 0.1.7 deleted `dsh-agent-presets` and its directory roots: a preset is a
 * host row of `@deepseek-ai/dsh-agent-preset` whose `config.plugins` is the
 * agent's entry list, inserted by a bundle patch. Every reader of our
 * composition — the kernel-defaults invariants, the composition references,
 * the plugin-switch and scoped-inject tests — reads
 * `presets/evimed-universal/agent.cordis.yml`, so that stays the source, and
 * the kernel-facing patch is generated from it. A patch edited by hand, or a
 * source edited without regenerating, is a composition nobody tested; this is
 * what makes either one red.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'

import { PRESET_NAME } from '../index.mjs'
import { PRESET_ID, PRESET_PATCH_URL, PRESET_ROW_ID, readPresetPatchSource } from '../scripts/build-preset.mjs'

/** A `!!js` scalar kept as text, the way the kernel's loader receives it. */
const jsTag = { tag: '!!js', resolve: (/** @type {string} */ value) => `!!js ${value}` }

test('the committed preset patch is exactly what the preset source generates', async () => {
  const committed = await readFile(PRESET_PATCH_URL, 'utf8')
  assert.equal(committed, await readPresetPatchSource(), 'run `node scripts/build-preset.mjs` in packages/socket and commit the result')
})

test('the patch inserts one preset row, the one the control plane asks for, carrying every row of the source', async () => {
  const patch = parse(await readFile(PRESET_PATCH_URL, 'utf8'), { customTags: [jsTag] })
  const source = parse(await readFile(new URL('../presets/evimed-universal/agent.cordis.yml', import.meta.url), 'utf8'), { customTags: [jsTag] })
  assert.equal(PRESET_ID, PRESET_NAME)
  assert.equal(patch.length, 1)
  const rows = patch[0].insert
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, PRESET_ROW_ID)
  assert.equal(rows[0].name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(rows[0].config.id, PRESET_NAME)
  assert.deepEqual(rows[0].config.plugins, source, 'the kernel mounts the same entries the source declares, `!!js` expressions included')
  assert.ok(source.length >= 10, 'the source was read, so the comparison compared something')
})

test('the bundle lists the preset patch after its own host patch, and ships it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/evimed-universal.patch.yml'])
  assert.ok(manifest.files.includes('presets'), 'the patch lives under a directory the package ships')
})
