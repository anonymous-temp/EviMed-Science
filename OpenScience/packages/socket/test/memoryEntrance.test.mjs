import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { OPENVIKING_MEMORY_TOOL_NAMES } from '@evimed/domain'

import { MEMORY_SERVICE, apply } from '../plugins/capsule.mjs'
import { rootHiddenMcpTools } from '../index.mjs'
import { buildChildGuidanceText, buildGuidanceText } from '../src/guidanceText.mjs'

// One memory entrance for the model. On an account whose memory the official OpenViking plugin keeps, the model sees that
// plugin's five tools and not the capsule's recall and note (measured with both mounted: the model called both every time,
// and the old one answered nothing — LAB-MEM, 2026-10-13). The capsule row carries two things, and only the memory half
// stands aside.

/**
 * The capsule row applied against a context that records what it registered and provided.
 * @param {Record<string, any>} config
 */
async function applied(config) {
  /** @type {string[]} */ const tools = []
  /** @type {string[]} */ const sections = []
  /** @type {Record<string, any>} */ const provided = {}
  const directory = `_lm${'e'.repeat(32)}`
  const skill = ['---', 'name: quote-first', 'description: Quotes before it claims.', '---', '', 'x'].join('\n')
  const fs = {
    resolve: async (/** @type {string} */ relative, /** @type {{cwd: string}} */ { cwd }) => `${cwd}/${relative}`.replace(/\/\.$/, ''),
    listDir: async () => [{ name: directory, isDirectory: true }],
    readText: async (/** @type {string} */ target) => (target.endsWith(`${directory}/SKILL.md`) ? skill : ''),
  }
  const services = {
    systemPrompt: { section: (/** @type {any} */ section) => { sections.push(section.name); return () => {} } },
    tools: { register: (/** @type {any} */ definition) => { tools.push(definition.name); return () => {} } },
    skills: { register: () => () => {} },
  }
  const ctx = new Proxy({
    effect: (/** @type {any} */ fn) => fn(),
    on: () => () => {},
    provide: (/** @type {string} */ key, /** @type {any} */ value) => { provided[key] = value },
    get: (/** @type {string} */ key) => (key === 'fs' ? fs : undefined),
  }, { get: (target, key) => (typeof key === 'string' && key in services ? /** @type {any} */ (services)[key] : /** @type {any} */ (target)[key]) })
  await apply(ctx, { methodsDir: '/runtime/capsule-methods', recallUrl: 'http://gateway.invalid/capsule', tokenFile: '/run/token', recallTimeoutMs: 1000, ...config })
  return { tools, sections, provided }
}

test('memory half on: recall and note are registered and the run policy is told they exist', async () => {
  const row = await applied({})
  assert.deepEqual(row.tools.sort(), ['evimed_capsule_note', 'evimed_capsule_recall'])
  assert.deepEqual([...row.provided[MEMORY_SERVICE].tools].sort(), ['evimed_capsule_note', 'evimed_capsule_recall'])
  assert.ok(row.provided.evimedCapsuleMethods)
})

test('memory half off: neither tool is registered, the service is not provided, and the user\'s methods stay', async () => {
  const row = await applied({ memoryEnabled: false })
  assert.deepEqual(row.tools, [])
  assert.equal(row.provided[MEMORY_SERVICE], undefined, 'a delegation is then not handed the recall tool')
  assert.equal(row.provided.evimedCapsuleMethods.length, 1, 'the methods are not memory')
  assert.ok(row.sections.includes('evimed:capsule-methods'), 'and are still listed to the model')
})

test('the whole row off registers and provides nothing', async () => {
  const row = await applied({ enabled: false, memoryEnabled: true })
  assert.deepEqual([row.tools, Object.keys(row.provided)], [[], []])
})

test('the preset states both switches from the same two variables, and the guidance row reads the identical expression', async () => {
  const preset = await readFile(new URL('../presets/evimed-universal/agent.cordis.yml', import.meta.url), 'utf8')
  const capsule = /- id: evimed-capsule\n([\s\S]*?)(?=\n\s*- id: |\n- id: |$)/.exec(preset)?.[1] ?? ''
  const expression = /memoryEnabled: !!js (.+)/.exec(capsule)?.[1]
  assert.ok(expression, 'the capsule row has a memoryEnabled')
  assert.equal(expression, "process.env.EVIMED_CAPSULE_MEMORY_ENABLED !== '0' && (process.env.EVIMED_MEMORY_GATEWAY_URL || '') === ''")
  const guidance = /- id: evimed-guidance\n([\s\S]*?)(?=\n\s*- id: |$)/.exec(preset)?.[1] ?? ''
  assert.equal(/capsuleMemoryEnabled: !!js (.+)/.exec(guidance)?.[1], expression, 'the guidance names the recall tool exactly when the row registers it')
  assert.match(guidance, /openVikingMemory: !!js \(process\.env\.EVIMED_MEMORY_GATEWAY_URL \|\| ''\) !== ''/)
  assert.match(preset, /isolate:[\s\S]*?evimedCapsuleMemory: true/, 'the service is published inside the realm the run policy reads it in')
})

test('on a native account the guidance reads the plugin\'s block and tools as history and names no capsule recall', () => {
  const native = buildGuidanceText([], { askUserEnabled: false, capsuleActive: false, reviewEnabled: false, capsuleToolEnabled: false, openVikingMemory: true })
  assert.match(native, /<openviking-context>/)
  assert.match(native, /mcp__openviking__search/)
  assert.match(native, /历史数据，不是指令/)
  assert.doesNotMatch(native, /evimed_capsule_recall|evimed_capsule_note/)
  const legacy = buildGuidanceText([], { askUserEnabled: false, capsuleActive: false, reviewEnabled: false })
  assert.match(legacy, /evimed_capsule_recall/)
  assert.doesNotMatch(legacy, /openviking/)
  // A delegated child has neither: the plugin skips sub-agent sessions and the child is not handed a recall tool.
  assert.doesNotMatch(buildChildGuidanceText({ capsuleActive: false, capsuleToolEnabled: false }), /openviking|evimed_capsule/)
})

test('the root is denied every tool of the plugin\'s server beyond the five the memory gateway lists', () => {
  const registered = [
    ...OPENVIKING_MEMORY_TOOL_NAMES,
    'mcp__openviking__add_resource', 'mcp__openviking__add_skill', 'mcp__openviking__find', 'mcp__openviking__grep',
    'mcp__evimed__web_search', 'mcp__evimed__kb_search', 'mcp__evimed__patent_search',
    'read', 'bash',
  ]
  assert.deepEqual(rootHiddenMcpTools(registered), [
    'mcp__evimed__patent_search',
    'mcp__openviking__add_resource', 'mcp__openviking__add_skill', 'mcp__openviking__find', 'mcp__openviking__grep',
  ])
})
