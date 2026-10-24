import assert from 'node:assert/strict'
import test from 'node:test'

import { SEAMS } from '@evimed/harness-port'

import { METHODS_SECTION_NAME, SELECTION_FILE, apply } from '../plugins/capsule.mjs'

// What a conversation is shown of the mounted methods is decided when it begins, from the selection the control plane wrote
// beside them, and kept for it (2026-10-23). The runtime used to read the directory once, when it started, and every conversation
// of its life carried that list.

const DIR = '/runtime/capsule-methods'
const skill = (/** @type {string} */ name) => ['---', `name: ${name}`, `description: Words of ${name}.`, `whenToUse: When ${name}.`, '---', '', '## Purpose', name].join('\n')

/** A kernel in miniature: a file system, the hooks the plugin subscribes to and the registries it writes to. */
function kernel(/** @type {Record<string, string>} */ files = {}, { receiptThrows = false } = {}) {
  /** @type {Map<string, Function[]>} */ const handlers = new Map()
  /** @type {any[]} */ const sections = []
  /** @type {Record<string, any>} */ const provided = {}
  /** @type {any[]} */ const sessions = []
  /** @type {string[]} */ const degraded = []
  const fs = {
    resolve: async (/** @type {string} */ relative, /** @type {{cwd: string}} */ { cwd }) => `${cwd}/${relative}`.replace(/\/\.$/, ''),
    readText: async (/** @type {string} */ target) => { if (!(target in files)) throw new Error('ENOENT'); return files[target] },
    listDir: async (/** @type {string} */ target) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${target}/`)).map((path) => path.slice(target.length + 1).split('/')[0]))]
      .map((name) => ({ name, isDirectory: !name.includes('.') || name.startsWith('_lm') })),
  }
  const diagnostics = {
    mountedMethods() {},
    sessionMethods: (/** @type {string} */ sessionId, /** @type {any[]} */ methods) => { if (receiptThrows) throw new Error('the receipt store is down'); sessions.push({ sessionId, methods }) },
    degrade: (/** @type {string} */ line) => degraded.push(line),
  }
  const services = { systemPrompt: { section: (/** @type {any} */ section) => { sections.push(section); return () => {} } }, tools: { register: () => () => {} } }
  const ctx = new Proxy({
    effect: (/** @type {any} */ fn) => fn(),
    provide: (/** @type {string} */ key, /** @type {any} */ value) => { provided[key] = value },
    get: (/** @type {string} */ key) => (key === 'fs' ? fs : key === 'evimedDiagnostics' ? diagnostics : undefined),
    on: (/** @type {string} */ event, /** @type {Function} */ fn) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return () => {} },
  }, { get: (target, key) => (typeof key === 'string' && key in services ? /** @type {any} */ (services)[key] : /** @type {any} */ (target)[key]) })
  /** A step claims its input, then the kernel assembles the prompt through every hook. */
  const claim = (/** @type {any} */ agent, /** @type {string} */ id, turn = 1) => {
    for (const handler of handlers.get(SEAMS.events.inputClaimed) ?? []) handler({ agent, turn, message: { source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text: id }] } })
  }
  const assembleWith = async (/** @type {any} */ agent, /** @type {any} */ assembly) => {
    const list = handlers.get(SEAMS.events.promptAssemble) ?? []
    const run = async (/** @type {number} */ index) => (list[index] ? list[index](assembly, { agent }, () => run(index + 1)) : assembly)
    await run(0)
    return assembly
  }
  const assemble = (/** @type {any} */ agent) => assembleWith(agent, { sections: [{ name: METHODS_SECTION_NAME, text: sections[0]?.text ?? '' }, { name: 'other', text: 'unrelated' }], tools: [] })
  return { files, ctx, sections, provided, sessions, degraded, claim, assemble, assembleWith }
}

const root = (/** @type {string} */ id) => ({ session: { id, header: {} } })
const child = (/** @type {string} */ id, /** @type {string} */ parent) => ({ session: { id, header: { origin: 'subagent', parentSession: parent } } })
const config = { methodsDir: DIR, recallUrl: '', tokenFile: '', recallTimeoutMs: 1000 }
const selection = (/** @type {string} */ version, /** @type {[string, string | null][]} */ entries) => JSON.stringify({ version, methods: entries.map(([directory, reason]) => ({ directory, reason })) })
const A = `_lm${'a'.repeat(32)}`
const B = `_lm${'b'.repeat(32)}`
const C = `_lm${'c'.repeat(32)}`

test('a conversation is shown the selection written when its first prompt arrived, with the reasons, and that is its receipt', async () => {
  const k = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'), [`${DIR}/${B}/SKILL.md`]: skill('beta'), [`${DIR}/${C}/SKILL.md`]: skill('gamma'),
    [`${DIR}/${SELECTION_FILE}`]: selection('v1', [[A, 'recent']]) })
  await apply(k.ctx, config)
  assert.match(k.sections[0].text, /alpha/, 'the launch list is the fallback')
  // The control plane rewrites the selection for the conversation about to begin.
  k.files[`${DIR}/${SELECTION_FILE}`] = selection('v2', [[B, 'similarity'], [C, 'dependency'], [A, 'explore']])
  const one = root('s1')
  k.claim(one, 'r1')
  const assembly = await k.assemble(one)
  const methods = assembly.sections.find((/** @type {any} */ section) => section.name === METHODS_SECTION_NAME)
  assert.match(methods.text, /beta[\s\S]*gamma[\s\S]*alpha/, 'in the order the selection lists them')
  assert.equal(methods.interpolate, false, 'cards are literal text')
  assert.equal(assembly.sections.find((/** @type {any} */ section) => section.name === 'other').text, 'unrelated', 'nothing else is touched')
  assert.deepEqual(k.sessions.map((entry) => [entry.sessionId, entry.methods.map((/** @type {any} */ method) => [method.name, method.reason])]),
    [['s1', [['beta', 'similarity'], ['gamma', 'dependency'], ['alpha', 'explore']]]])
  assert.match(k.sessions[0].methods[0].digest, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(k.provided.evimedCapsuleMethods.forSession('s1').map((/** @type {any} */ method) => method.name), ['beta', 'gamma', 'alpha'])
  assert.deepEqual(k.provided.evimedCapsuleMethods.map((/** @type {any} */ method) => method.name), ['alpha'], 'the list the runtime started with is unchanged for any reader that takes it as a list')
})

test('a running turn and the rest of the conversation keep what they began with; the next turn after the selection changed is given the new one', async () => {
  const k = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'), [`${DIR}/${B}/SKILL.md`]: skill('beta'), [`${DIR}/${SELECTION_FILE}`]: selection('v1', [[A, 'similarity']]) })
  await apply(k.ctx, config)
  const one = root('s1')
  k.claim(one, 'r1', 1)
  await k.assemble(one)
  // Another conversation begins and the control plane rewrites the selection.
  k.files[`${DIR}/${SELECTION_FILE}`] = selection('v2', [[B, 'similarity']])
  const two = root('s2')
  k.claim(two, 'r2', 1)
  const second = await k.assemble(two)
  assert.match(second.sections[0].text, /beta/)
  assert.doesNotMatch(second.sections[0].text, /alpha/)
  // The first conversation: its later steps (nothing claimed) and its next turn (claimed, selection changed).
  const step = await k.assemble(one)
  assert.match(step.sections[0].text, /alpha/, 'a step of the running turn keeps what the turn began with')
  k.claim(one, 'r3', 1)
  assert.match((await k.assemble(one)).sections[0].text, /alpha/, 'a claim in the same turn (a steer) does not renew')
  k.claim(one, 'r4', 2)
  const renewed = await k.assemble(one)
  assert.match(renewed.sections[0].text, /beta/, 'the next turn is given what the control plane selected since')
  assert.deepEqual(k.sessions.filter((entry) => entry.sessionId === 's1').map((entry) => entry.methods.map((/** @type {any} */ method) => method.name)), [['alpha'], ['beta']])
  // And a turn that finds the same selection is not renewed again.
  k.claim(one, 'r5', 3)
  await k.assemble(one)
  assert.equal(k.sessions.filter((entry) => entry.sessionId === 's1').length, 2)
})

test('a child is given its parent conversation\'s methods, and a conversation with none the newest list', async () => {
  const k = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'), [`${DIR}/${B}/SKILL.md`]: skill('beta'), [`${DIR}/${SELECTION_FILE}`]: selection('v1', [[A, 'similarity']]) })
  await apply(k.ctx, config)
  const one = root('s1')
  k.claim(one, 'r1')
  await k.assemble(one)
  k.files[`${DIR}/${SELECTION_FILE}`] = selection('v2', [[B, 'similarity']])
  const two = root('s2')
  k.claim(two, 'r2')
  await k.assemble(two)
  assert.match((await k.assemble(child('c1', 's1'))).sections[0].text, /alpha/)
  assert.match((await k.assemble(child('c2', 's2'))).sections[0].text, /beta/)
  assert.deepEqual(k.provided.evimedCapsuleMethods.forSession('s1').map((/** @type {any} */ method) => method.name), ['alpha'])
  assert.deepEqual(k.provided.evimedCapsuleMethods.forSession('unknown').map((/** @type {any} */ method) => method.name), ['beta'])
  // A child asked before any conversation was prepared is given the runtime's own.
  const fresh = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha') })
  await apply(fresh.ctx, config)
  assert.match((await fresh.assemble(child('c', 'nobody'))).sections[0].text, /alpha/)
})

test('without a selection file every directory is listed as it always was, and a conversation that finds nothing is shown nothing', async () => {
  const k = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'), [`${DIR}/${B}/SKILL.md`]: skill('beta') })
  await apply(k.ctx, config)
  const one = root('s1')
  k.claim(one, 'r1')
  const text = (await k.assemble(one)).sections[0].text
  assert.match(text, /alpha/)
  assert.match(text, /beta/)
  assert.deepEqual(k.sessions[0].methods.map((/** @type {any} */ method) => method.reason), [null, null], 'no reason is known for what was only listed')
  // A selection that lists nothing is a conversation with no methods section at all.
  const empty = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'), [`${DIR}/${SELECTION_FILE}`]: selection('v1', [[A, 'recent']]) })
  await apply(empty.ctx, config)
  empty.files[`${DIR}/${SELECTION_FILE}`] = selection('v2', [])
  const two = root('s2')
  empty.claim(two, 'r2')
  assert.equal((await empty.assemble(two)).sections[0].text, '')
  // The section holds its place when the runtime was launched with no method at all.
  const bare = kernel({ [`${DIR}/${SELECTION_FILE}`]: selection('v0', []) })
  await apply(bare.ctx, config)
  assert.equal(bare.sections.length, 1)
  assert.equal(bare.sections[0].name, METHODS_SECTION_NAME)
  bare.files[`${DIR}/${A}/SKILL.md`] = skill('alpha')
  bare.files[`${DIR}/${SELECTION_FILE}`] = selection('v1', [[A, 'similarity']])
  const three = root('s3')
  bare.claim(three, 'r3')
  assert.match((await bare.assemble(three)).sections[0].text, /alpha/, 'a runtime launched with none is given one')
})

test('a selection that cannot be trusted or read costs the conversation its methods, never its answer', async () => {
  const k = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha'),
    [`${DIR}/${SELECTION_FILE}`]: JSON.stringify({ version: 'v1', methods: [{ directory: '../../etc', reason: 'similarity' }, { directory: '.hidden', reason: null }, { directory: 'a/b', reason: null }, { directory: A, reason: 'similarity' }] }) })
  await apply(k.ctx, config)
  const one = root('s1')
  k.claim(one, 'r1')
  const assembly = await k.assemble(one)
  assert.deepEqual(k.sessions[0].methods.map((/** @type {any} */ method) => method.name), ['alpha'], 'a name that is a path out of the directory is not followed')
  assert.match(assembly.sections[0].text, /alpha/)
  k.files[`${DIR}/${SELECTION_FILE}`] = '{ not json'
  const two = root('s2')
  k.claim(two, 'r2')
  assert.match((await k.assemble(two)).sections[0].text, /alpha/, 'a file that cannot be read is no selection: the directories are listed')
  // An assembly with no section list (another shape of the kernel) is left alone: there is nothing to put the methods in.
  const odd = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha') })
  await apply(odd.ctx, config)
  const three = root('s3')
  odd.claim(three, 'r3')
  const shapeless = { tools: [] }
  assert.deepEqual(await odd.assembleWith(three, shapeless), { tools: [] })
  // A receipt that cannot be stored is said, and the conversation is still shown what it was given.
  const broken = kernel({ [`${DIR}/${A}/SKILL.md`]: skill('alpha') }, { receiptThrows: true })
  await apply(broken.ctx, config)
  const four = root('s4')
  broken.claim(four, 'r4')
  assert.match((await broken.assemble(four)).sections[0].text, /launch|alpha/)
  assert.deepEqual(broken.degraded.filter((line) => line.startsWith('conversation methods')), ['conversation methods not read: the receipt store is down'])
})
