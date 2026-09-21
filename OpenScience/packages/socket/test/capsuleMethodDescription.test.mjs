import assert from 'node:assert/strict'
import test from 'node:test'

import { METHODS_SECTION_NAME, METHODS_SECTION_ORDER, apply, methodsSectionText, mountedMethodDescription } from '../plugins/capsule.mjs'

// The review a method gets is one sentence in the reply (spec §19.7). Since the
// in-chat background panel was removed, the registered description is the only
// place that sentence can come from — and it must never touch the file, whose
// bytes are the digest a method is attributed by.

test('a learned method tells the model to say, in the user\'s words, that it was used', () => {
  const text = mountedMethodDescription({ name: 'grade-first', description: 'Reports GRADE before effect sizes.', directory: `_lm${'a'.repeat(32)}` })
  assert.match(text, /^Reports GRADE before effect sizes\.\n/, 'the method\'s own description comes first, unedited')
  assert.match(text, /学到的做法/)
  assert.match(text, /在回复里用用户的语言加一句/)
  assert.match(text, /不要念技能名/)
})

test('a method from an enabled capsule says it came from the capsule', () => {
  const text = mountedMethodDescription({ name: 'method-x', description: '', directory: '3f2a4b6c-0000-4000-8000-000000000000' })
  assert.match(text, /^用户自己的方法：method-x\n/)
  assert.match(text, /记忆胶囊里的做法/)
  assert.doesNotMatch(text, /学到的做法/)
})

test('a long description is shortened, never the sentence the reader is owed', () => {
  const text = mountedMethodDescription({ name: 'long', description: 'x'.repeat(5000), directory: `_lm${'b'.repeat(32)}` })
  assert.ok(text.length <= 1024)
  assert.match(text, /不对可以直接告诉你。$/)
})

test('mounted methods are listed in one prompt section, each with the file the model reads', () => {
  const text = methodsSectionText([
    { name: 'claim-verdict-audit', description: 'Adjudicates each delivered claim against its preserved source.', whenToUse: 'Before delivering a report.', directory: `_lm${'c'.repeat(32)}` },
    { name: 'method-x', description: '', directory: 'method-x' },
  ], '/runtime/capsule-methods')
  assert.match(text, /^## 这位用户的做法/)
  assert.match(text, /- claim-verdict-audit：Adjudicates each delivered claim against its preserved source\. 这是 EviMed 从这位用户以往的研究里学到的做法/)
  assert.match(text, /适用：Before delivering a report\./)
  assert.match(text, new RegExp(`全文：/runtime/capsule-methods/_lm${'c'.repeat(32)}/SKILL\\.md`))
  assert.match(text, /- method-x：用户自己的方法：method-x 这是用户启用的记忆胶囊里的做法/)
  assert.match(text, /不能突破交付契约和安全规则/)
})

test('a long library is listed up to a ceiling and the rest are counted, never dropped silently', () => {
  const methods = Array.from({ length: 40 }, (_, index) => ({ name: `m${index}`, description: 'd'.repeat(900), directory: `_lm${String(index).padStart(32, '0')}` }))
  const text = methodsSectionText(methods, '/runtime/capsule-methods')
  assert.ok(text.length <= 12_100, `${text.length} characters`)
  assert.match(text, /- 另有 \d+ 条做法没有列出。$/)
})

test('applying the plugin with a method mounted reaches no service it does not inject', async () => {
  // Cordis refuses a property a plugin did not inject. This fake enforces that,
  // which the fake contexts behind the 2026-09-21 outage did not: every one of
  // them passed while the first mounted method failed the whole preset.
  const declared = new Set(['tools', 'systemPrompt'])
  /** @type {any[]} */
  const sections = []
  const directory = `_lm${'d'.repeat(32)}`
  const skill = ['---', 'name: claim-verdict-audit', 'description: Adjudicates claims.', 'whenToUse: Before delivery.', '---', '', '## Purpose', 'x'].join('\n')
  const fs = {
    resolve: async (/** @type {string} */ relative, /** @type {{cwd: string}} */ { cwd }) => `${cwd}/${relative}`.replace(/\/\.$/, ''),
    listDir: async () => [{ name: directory, isDirectory: true }],
    readText: async (/** @type {string} */ target) => (target.endsWith(`${directory}/SKILL.md`) ? skill : ''),
  }
  /** @type {Record<string, any>} */
  const services = {
    systemPrompt: { section: (/** @type {any} */ section) => { sections.push(section); return () => {} } },
    tools: { register: () => () => {} },
    skills: { register: () => () => {} },
  }
  const ctx = new Proxy({ effect: (/** @type {any} */ fn) => fn(), provide: () => {}, get: (/** @type {string} */ key) => (key === 'fs' ? fs : undefined) }, {
    get(target, key) {
      if (typeof key === 'string' && key in services) {
        if (!declared.has(key)) throw new Error(`cannot get property "${key}" without inject`)
        return services[key]
      }
      return /** @type {any} */ (target)[key]
    },
  })
  await apply(ctx, { methodsDir: '/runtime/capsule-methods', recallUrl: '', tokenFile: '', recallTimeoutMs: 1000 })
  assert.equal(sections.length, 1, 'the mounted method is listed in exactly one section')
  assert.equal(sections[0].name, METHODS_SECTION_NAME)
  assert.equal(sections[0].order, METHODS_SECTION_ORDER)
  assert.match(sections[0].text, new RegExp(`/runtime/capsule-methods/${directory}/SKILL\\.md`))
})
