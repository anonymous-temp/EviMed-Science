import assert from 'node:assert/strict'
import test from 'node:test'
import { vcrSubjectLabel, vcrSubjectLabels, vcrVisibleQuestion } from '../index.mjs'

test('a pseudonymous key reads as P- and six digits, and any other key is its own label', () => {
  assert.equal(vcrSubjectLabel('Pee008d6ee9ef7847'), 'P-EE008D')
  assert.equal(vcrSubjectLabel('P-0302'), 'P-0302')
  assert.equal(vcrSubjectLabel('conversation-case:abc'), 'conversation-case:abc')
  assert.equal(vcrSubjectLabel(null), '')
})

test('the labels of a roster are unique, the same for the same key whatever else is in it, and longer only where two keys share the short form', () => {
  const first = 'Pee008d6ee9ef7847'
  const second = 'Pee008d6e00000001'
  const third = 'Pa1b2c3d4e5f60718'
  const labels = vcrSubjectLabels([first, second, third, first])
  assert.equal(labels.size, 3)
  assert.equal(labels.get(third), 'P-A1B2C3', 'a key nobody shares keeps the short form')
  assert.equal(labels.get(first), 'P-EE008D6EE')
  assert.equal(labels.get(second), 'P-EE008D6E0')
  assert.equal(new Set(labels.values()).size, 3)
  // The same key alone reads the short form, and a roster that holds no collision gives exactly that.
  assert.equal(vcrSubjectLabels([first, third]).get(first), vcrSubjectLabel(first))
  // A roster in another order gives the same labels.
  assert.deepEqual([...vcrSubjectLabels([third, second, first])].sort(), [...labels].sort())
  assert.equal(vcrSubjectLabels(['P-0302', 'x']).get('P-0302'), 'P-0302')
})

test('the sentence of a patient\'s trial search names the person by the label, never by the key', () => {
  assert.equal(vcrVisibleQuestion({ purpose: 'trial_search', subjectKey: 'Pee008d6ee9ef7847' }), '为 P-EE008D 找试验')
  assert.equal(vcrVisibleQuestion({ purpose: 'trial_search' }), '为患者找试验')
})
