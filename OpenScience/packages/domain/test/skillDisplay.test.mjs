import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { MCP_TOOL_BASE_NAMES } from '../index.mjs'
import { RESEARCH_TOOL_DISPLAY, RESEARCH_TOOL_GROUPS, RESEARCH_TOOL_GROUP_MODULES, researchToolGroups, researchToolsOfModule } from '../src/researchToolDisplay.mjs'
import { SKILL_DISPLAY, SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_GROUPS, SKILL_DISPLAY_LOOPX_GROUP, skillDisplay } from '../src/skillDisplay.mjs'
import { SKILL_PACKAGES } from '../src/skillPackages.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CJK = /[㐀-鿿]/
/** The origins the runtime image mounts as skill roots a model can see: what a researcher is offered. */
const MODEL_VISIBLE = new Set(['core', 'curated', 'office', 'community', 'evimed'])

/** Skill folders in a root, by name (a folder holding a SKILL.md). @param {string} relative */
function skillFolders(relative) {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
}

test('every model-visible shipped skill has a Chinese name, a use, a trigger and a group — and nothing else does', () => {
  const shipped = [...SKILL_PACKAGES.values()].filter((record) => MODEL_VISIBLE.has(record.origin)).map((record) => record.name).sort()
  assert.equal(shipped.length, 57, 'the platform ships fifty-seven skills a model can load')
  assert.deepEqual(Object.keys(SKILL_DISPLAY).sort(), shipped, 'the display table and the shipped skills name the same set')
  for (const [name, row] of Object.entries(SKILL_DISPLAY)) {
    assert.ok(SKILL_DISPLAY_GROUPS.includes(row.group), `${name}: group ${row.group} is not a listed group`)
    const words = /** @type {Record<string, string>} */ (/** @type {unknown} */ (row))
    for (const field of ['title', 'use', 'when']) {
      assert.ok(typeof words[field] === 'string' && CJK.test(words[field]), `${name}.${field} is a Chinese sentence`)
    }
    assert.ok(!/\bSKILL\.md\b|\.mjs\b|\.py\b/.test(`${row.title}${row.use}${row.when}`), `${name} names a file`)
  }
})

test('the method pack\'s and the long task\'s groups are listed groups no shipped skill belongs to (neither is in the table)', () => {
  for (const group of [SKILL_DISPLAY_GEO_GROUP, SKILL_DISPLAY_LOOPX_GROUP]) {
    assert.ok(SKILL_DISPLAY_GROUPS.includes(group), group)
    assert.ok(Object.values(SKILL_DISPLAY).every((row) => row.group !== group), `${group} is read from the pack's index / the LoopX record, not from this table`)
  }
  assert.equal(SKILL_DISPLAY_LOOPX_GROUP, '长任务')
})

test('a skill is listed by what it is for, never by where it came from: no 社区 group, the community presentation skill is an office document', () => {
  assert.ok(!SKILL_DISPLAY_GROUPS.includes('社区'))
  assert.equal(SKILL_DISPLAY['dsh-ppt'].group, '办公文档')
  assert.equal(SKILL_DISPLAY['deep-structural-analysis'].group, '写作与核查')
  for (const group of SKILL_DISPLAY_GROUPS.filter((name) => name !== SKILL_DISPLAY_GEO_GROUP && name !== SKILL_DISPLAY_LOOPX_GROUP)) {
    assert.ok(Object.values(SKILL_DISPLAY).some((row) => row.group === group), `${group} has a skill`)
  }
})

test('the display names are unique within the skills a researcher sees, so two rows are never the same word', () => {
  const titles = Object.values(SKILL_DISPLAY).map((row) => row.title)
  assert.equal(new Set(titles).size, titles.length)
})

test('the shipped skill folders on disk are exactly the ones the table describes (the root lists are not retyped)', () => {
  const folders = [
    ...skillFolders('runtime/skills/core'), ...skillFolders('runtime/skills/curated-scientific').filter((name) => name !== 'digest-repins.jsonl'),
    ...skillFolders('runtime/skills/office').filter((name) => name !== 'shared'), ...skillFolders('runtime/skills/community'),
    'open-domain-answer',
  ].sort()
  assert.deepEqual(Object.keys(SKILL_DISPLAY).sort(), folders)
})

test('skillDisplay answers a known name and null for anything else, including inherited property names', () => {
  assert.equal(skillDisplay('survival-analysis')?.title, '生存分析')
  assert.equal(skillDisplay('no-such-skill'), null)
  assert.equal(skillDisplay('constructor'), null)
  assert.equal(skillDisplay(undefined), null)
})

test('every research tool the MCP server publishes has one sentence and a group, and no sentence belongs to a tool that is gone', () => {
  assert.deepEqual(Object.keys(RESEARCH_TOOL_DISPLAY).sort(), [...MCP_TOOL_BASE_NAMES].sort())
  for (const [name, row] of Object.entries(RESEARCH_TOOL_DISPLAY)) {
    assert.ok(RESEARCH_TOOL_GROUPS.includes(row.group), `${name}: group ${row.group} is not a listed group`)
    assert.ok(CJK.test(row.use) && row.use.length <= 80, `${name}: one short Chinese sentence`)
    assert.ok(!new RegExp(`\\b${name}\\b`).test(row.use), `${name}: the sentence does not repeat the tool's own identifier`)
  }
})

// A tool's sentence says what it does (owner ruling 2026-10-10, R37): it does not tell the reader to check the result against
// another source, and does not rate the platform's own output.
test('no research tool\'s sentence asks the reader to check it elsewhere', () => {
  for (const [name, row] of Object.entries(RESEARCH_TOOL_DISPLAY)) {
    assert.doesNotMatch(row.use, /需再对照|请再核对|以官方来源为准|仅供参考/, `${name}: ${row.use}`)
  }
  assert.equal(RESEARCH_TOOL_DISPLAY.pharmacy_reference_search.use, '检索药学参考资料，作为决策参考。')
})

test('the grouped list carries every tool once, in the groups\' order', () => {
  const groups = researchToolGroups()
  assert.deepEqual(groups.map((group) => group.title), RESEARCH_TOOL_GROUPS.filter((title) => groups.some((group) => group.title === title)))
  assert.equal(groups.reduce((sum, group) => sum + group.tools.length, 0), MCP_TOOL_BASE_NAMES.length)
})

test('the tools of a module are named by their group, and a list without some tools leaves their groups out when empty', () => {
  assert.deepEqual(Object.keys(RESEARCH_TOOL_GROUP_MODULES).sort(), ['循证 GEO', '虚拟临床研究'].sort())
  for (const group of Object.keys(RESEARCH_TOOL_GROUP_MODULES)) assert.ok(RESEARCH_TOOL_GROUPS.includes(group), `${group} is a listed group`)
  assert.deepEqual(researchToolsOfModule('geo').sort(), ['geo_read', 'geo_visibility_probe', 'geo_write', 'social_posts_search'])
  assert.deepEqual(researchToolsOfModule('vcr').sort(), ['curve_digitize', 'evidence_pool', 'vcr_read', 'vcr_simulate', 'vcr_write'])
  const without = researchToolGroups({ without: researchToolsOfModule('geo') })
  assert.ok(!without.some((group) => group.title === '循证 GEO'))
  assert.equal(without.reduce((sum, group) => sum + group.tools.length, 0), MCP_TOOL_BASE_NAMES.length - 4)
})
