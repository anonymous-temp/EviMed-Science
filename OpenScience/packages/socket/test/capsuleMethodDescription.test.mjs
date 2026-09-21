import assert from 'node:assert/strict'
import test from 'node:test'

import { mountedMethodDescription } from '../plugins/capsule.mjs'

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
