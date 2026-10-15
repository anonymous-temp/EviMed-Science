// The plugins page lists what a session of this image is made of, and what it lists is read out of the image's own list.
// Two files make the link (`runtimeInventory.mjs`): the generated inventory (composition snapshot, agent preset, tool names,
// skill roots, LoopX record) and the hand-written words. A new bundle, an enabled row, a skill root, a tool set or a LoopX
// skill with neither an item nor a reason is red here — the failure that hid 长任务, the memory plugin, the kernel's own
// step list and the 51 GEO skills from every person's page (R19, audit A §1 and §5.3).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MCP_TOOL_BASE_NAMES } from '../index.mjs'
import {
  RUNTIME_INVENTORY,
  RUNTIME_INVENTORY_WORDS as WORDS,
  USE_MAX,
  inventorySkillWords,
  listInventory,
  listResearchTools,
  unaccountedInventory,
} from '../src/runtimeInventory.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (/** @type {string} */ file) => readFile(path.join(repoRoot, file), 'utf8')
const EMPTY = { bundles: [], rows: [], agentRows: [], skillRoots: [], skills: [], toolSets: [], dead: [], duplicated: [] }
/** A deep copy the test may change. */
const clone = (/** @type {any} */ value) => JSON.parse(JSON.stringify(value))

test('the committed inventory is what the generator writes from the files now', async () => {
  /** @type {any} */
  const generator = await import(pathToFileURL(path.join(repoRoot, 'scripts/build/generate-runtime-inventory.mjs')).href)
  assert.equal(await read(generator.RUNTIME_INVENTORY_FILE), await generator.renderRuntimeInventoryFile(),
    'run node scripts/build/generate-runtime-inventory.mjs and commit the result')
  const baseline = await read(generator.COMPOSITION_FILE)
  assert.equal(RUNTIME_INVENTORY.composition.rows.length, [...baseline.matchAll(/^- id: /gm)].length, 'every row of the snapshot was read')
  assert.equal(RUNTIME_INVENTORY.composition.bundles.length, new Set([...baseline.matchAll(/^# == ([^,\n]+)/gm)].map((match) => match[1].trim())).size)
})

test('every bundle, mounted row, skill root, tool set and LoopX skill of the image is an item or has its reason — and no word is left over', () => {
  assert.deepEqual(unaccountedInventory(), EMPTY, 'a new bundle, row, root, tool set or skill needs words in runtime-inventory-zh.json (an item, or a plumbing reason)')
})

test('a new bundle, an enabled row, a skill root, a tool set or a skill with no words is seen; a disabled row is not mounted and needs none', () => {
  /** @type {any} */
  const inventory = clone(RUNTIME_INVENTORY)
  inventory.composition.bundles.push('dsh-new-plugin')
  inventory.composition.rows.push({ id: 'new-plugin-row', name: 'dsh-new-plugin', bundle: 'dsh-new-plugin', patchedBy: [], state: 'enabled' })
  inventory.composition.rows.push({ id: 'new-base-row', name: '@deepseek-ai/dsh-new', bundle: '@deepseek-ai/dsh-base', patchedBy: [], state: 'conditional' })
  inventory.composition.rows.push({ id: 'new-base-row-off', name: '@deepseek-ai/dsh-new-off', bundle: '@deepseek-ai/dsh-base', patchedBy: [], state: 'disabled' })
  inventory.preset.rows.push({ id: 'new-agent-row', name: 'x', state: 'enabled' })
  inventory.skillRoots.push({ id: 'new-root', mount: 'new-root', gate: null, kind: 'repo', source: 'runtime/skills/new-root' })
  inventory.toolSets.newSet = ['a']
  inventory.loopxSkills.kept.push('loopx-new')
  const found = unaccountedInventory(inventory)
  assert.deepEqual(found.bundles, ['dsh-new-plugin'])
  assert.deepEqual(found.rows.sort(), ['new-base-row', 'new-plugin-row'])
  assert.deepEqual(found.agentRows, ['new-agent-row'])
  assert.deepEqual(found.skillRoots, ['new-root'])
  assert.deepEqual(found.skills, ['loopx-new'])
  assert.deepEqual(found.toolSets, ['newSet'])
  assert.deepEqual(found.dead, [])
})

test('a word about something the image no longer holds is a dead entry, and a thing said twice is seen', () => {
  /** @type {any} */
  const inventory = clone(RUNTIME_INVENTORY)
  inventory.composition.rows = inventory.composition.rows.filter((/** @type {any} */ row) => row.id !== 'evimed-web')
  inventory.composition.bundles = inventory.composition.bundles.filter((/** @type {string} */ bundle) => bundle !== 'dsh-mermaid')
  const found = unaccountedInventory(inventory)
  assert.ok(found.dead.includes('row evimed-web'), 'a row an item names that the snapshot lost')
  assert.ok(found.dead.includes('bundle dsh-mermaid'))

  /** @type {any} */
  const words = clone(WORDS)
  words.items.web.rows.push('session')
  assert.ok(unaccountedInventory(RUNTIME_INVENTORY, words).duplicated.some((line) => line.startsWith('row session ')), 'an item and a reason both claim `session`')
})

test('the rows the upstream move named — otel, desktop-product-telemetry, product-analytics, ui-settings-session-log — are in the snapshot and accounted for', () => {
  const rows = new Map(RUNTIME_INVENTORY.composition.rows.map((row) => [row.id, row]))
  for (const id of ['otel', 'desktop-product-telemetry', 'product-analytics', 'ui-settings-session-log']) {
    assert.ok(rows.has(id), `${id} is a row of the recorded composition`)
  }
  // The three telemetry rows are off by value, so they are not mounted and say nothing; the hidden panel is one of the kernel's
  // pages and is plumbing.
  for (const id of ['otel', 'desktop-product-telemetry', 'product-analytics']) assert.equal(rows.get(id)?.state, 'disabled', `${id} stays off`)
  assert.ok(WORDS.plumbing.rows.some((group) => group.ids.includes('ui-settings-session-log')))
})

test('every item has its words, a row fits one line, and the controls and links are ones the page knows', () => {
  const groups = new Set(WORDS.groups.map((group) => group.id))
  /** @type {[string, any][]} */
  const entries = Object.entries(WORDS.items)
  const CORNER_QUOTES = /[「」]/
  const RETIRED = /始终开启|计算引擎|共\s*\d+\s*个/
  for (const [id, item] of entries) {
    assert.ok(groups.has(item.group), `${id}: group ${item.group}`)
    for (const field of ['title', 'use', 'does', 'how', 'icon']) assert.ok(typeof item[field] === 'string' && item[field].trim() !== '', `${id}.${field}`)
    assert.ok([...item.use].length <= USE_MAX, `${id}.use is ${[...item.use].length} characters; a row carries ${USE_MAX} at most`)
    assert.match(item.icon, /^[A-Z][A-Za-z0-9]+$/, `${id}.icon is a name of the web's icon set`)
    const sentences = Object.values(item.toolSentences ?? {})
    for (const text of [item.title, item.use, item.does, item.how, ...sentences, ...(item.parts ?? []).flatMap((/** @type {{ title: string, does: string }} */ part) => [part.title, part.does])]) {
      assert.ok(typeof text === 'string' && text.trim() !== '', `${id}: copy has words`)
      assert.ok(!CORNER_QUOTES.test(text), `${id}: ${text} — frontend copy quotes with “”`)
      assert.ok(!RETIRED.test(text), `${id}: ${text} — a state nobody can change, a back-office group and a count of tools are not copy`)
    }
    assert.ok(item.control.kind === 'none' || (item.control.kind === 'switch' && item.control.setting === 'dsh-cite'), `${id}.control`)
    assert.ok(item.opens.kind === 'drawer' || (item.opens.kind === 'page' && /^\/app\/[a-z-]+$/.test(item.opens.to)), `${id}.opens`)
    if (item.control.kind === 'switch') assert.equal(item.gate?.project, item.control.setting, `${id}: a switch is the project setting that gates it`)
    assert.ok(item.gate === null || Object.keys(item.gate).length === 1, `${id}.gate`)
    for (const part of item.parts ?? []) assert.ok(part.title && part.does, `${id} has a part without words`)
  }
  for (const group of WORDS.groups) assert.ok(Object.values(WORDS.items).some((item) => item.group === group.id), `group ${group.id} has no item`)
  assert.ok(!Object.hasOwn(WORDS.items, 'engines'), 'no calculation-engine item: a person cannot choose or switch one')
})

test('every reason is a sentence, every skill root says how it is listed or why it is not', () => {
  for (const group of [...WORDS.plumbing.rows, ...WORDS.plumbing.agentRows, WORDS.plumbing.skills]) {
    assert.ok(group.reason.length >= 40, `a reason: ${group.reason}`)
    assert.ok(group.ids.length > 0, `a reason with nothing under it: ${group.reason}`)
  }
  for (const [bundle, reason] of Object.entries(WORDS.plumbing.bundles)) assert.ok(reason.length >= 40, bundle)
  for (const [set, reason] of Object.entries(WORDS.plumbing.toolSets)) assert.ok(reason.length >= 40, set)
  for (const [root, entry] of Object.entries(WORDS.skillRoots)) {
    assert.ok(entry.listed ? String(entry.how ?? '').length >= 20 : String(entry.reason ?? '').length >= 20, `skill root ${root}`)
  }
})

test('the listed inventory: an item the deployment switched off or the account is not given is not a row; a project setting says on or off', () => {
  const ids = (/** @type {ReturnType<typeof listInventory>} */ groups) => groups.flatMap((group) => group.items.map((item) => item.id))
  assert.deepEqual(ids(listInventory({ config: {}, projectSettings: { 'dsh-cite': true } })),
    ['loopx', 'memory', 'citations', 'annotation', 'diagrams', 'web', 'basics', 'research-tools'])
  const cite = (/** @type {ReturnType<typeof listInventory>} */ groups) => /** @type {any} */ (groups[0].items.find((item) => item.id === 'citations'))
  assert.equal(cite(listInventory({ projectSettings: { 'dsh-cite': true } })).state, 'on')
  assert.equal(cite(listInventory({ projectSettings: { 'dsh-cite': false } })).state, 'off')
  assert.equal(cite(listInventory({})).state, 'off', 'a project that has not said is off: the switch shows what the project holds')

  const off = ids(listInventory({
    config: { loopxEnabled: false, runtimeAnnotationEnabled: false, runtimeMermaidEnabled: false, memoryEnabled: false },
    declinedTools: ['web_read'],
  }))
  assert.deepEqual(off, ['citations', 'basics', 'research-tools'])
  assert.deepEqual(ids(listInventory({ config: { loopxEnabled: null, runtimeMermaidEnabled: undefined } })).slice(0, 2), ['loopx', 'memory'], 'a switch the deployment did not state is not an off')

  const [first] = listInventory({})
  const find = (/** @type {string} */ id) => /** @type {any} */ (first.items.find((item) => item.id === id))
  assert.equal(find('basics').parts.length, 6, 'the six basic abilities, one sentence each')
  assert.deepEqual(first.items.filter((item) => item.showsTools).map((item) => item.id), ['research-tools'], 'one drawer lists the account\'s tools')
  assert.deepEqual(Object.keys(find('citations').toolSentences).sort(), ['cite_bibtex', 'cite_check', 'cite_format', 'cite_lookup'], 'the plugin\'s tool sentences are the vocabulary\'s')
  assert.deepEqual(find('memory').opens, { kind: 'page', to: '/app/memory' }, 'memory is a page, never a drawer')
  assert.match(find('loopx').does, /消耗灵豆，可随时暂停/, 'the cost line lives in the long task drawer')
  for (const item of first.items.filter((entry) => entry.id !== 'loopx')) assert.doesNotMatch(item.use, /灵豆/, `${item.id}: the cost line is the long task's alone`)
})

test('the research tool set is the account\'s: the tools its runtime is not given are not listed, and the count is what is listed', () => {
  const all = listResearchTools()
  // Every tool the server publishes but `web_read`, which is the 网页阅读 row and is not said twice.
  assert.equal(all.count, MCP_TOOL_BASE_NAMES.length - 1)
  assert.equal(all.groups.reduce((sum, group) => sum + group.tools.length, 0), all.count)
  const web = all.groups.find((group) => group.title === '网页与资料')
  assert.ok(web && web.tools.length > 0 && !web.tools.some((sentence) => /读取一个公开网页/.test(sentence)), 'the page-reading sentence is the item\'s')
  const fewer = listResearchTools(['geo_read', 'geo_write', 'vcr_read', 'not-a-tool'])
  assert.equal(fewer.count, all.count - 3)
  assert.ok(fewer.groups.every((group) => group.tools.length > 0))
  const moduleGroup = (/** @type {{ title: string, tools: string[] }[]} */ groups, /** @type {string} */ title) => groups.find((group) => group.title === title)
  assert.equal(moduleGroup(all.groups, '循证 GEO')?.tools.length, 4)
  assert.equal(moduleGroup(fewer.groups, '循证 GEO')?.tools.length, 2)
  const declined = ['geo_visibility_probe', 'geo_read', 'geo_write', 'social_posts_search']
  assert.equal(moduleGroup(listResearchTools(declined).groups, '循证 GEO'), undefined, 'a module an account does not have is not a group')
})

test('the LoopX skills the skills page and the model\'s catalogue carry are the CLI\'s recorded ones: the entry is listed, the rest are accounted', async () => {
  const record = JSON.parse(await read('packages/contracts/loopx/workflow-skills.json'))
  assert.deepEqual(RUNTIME_INVENTORY.loopxSkills.kept, [...record.kept].sort())
  assert.equal(RUNTIME_INVENTORY.loopxSkills.entry, record.entry)
  const words = inventorySkillWords(record.entry)
  assert.equal(words?.itemId, 'loopx')
  assert.equal(words?.title, '长任务')
  assert.equal(inventorySkillWords('loopx-pr-review'), null, 'the repository workflows are not rows')
  const listed = new Set(Object.values(WORDS.items).flatMap((item) => item.skills))
  const reasoned = new Set(WORDS.plumbing.skills.ids)
  for (const name of record.kept) assert.ok(listed.has(name) !== reasoned.has(name), `${name} is listed or reasoned, never both`)
})
