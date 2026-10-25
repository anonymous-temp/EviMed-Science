import assert from 'node:assert/strict'
import test from 'node:test'
import { ChildAttendance } from '../src/childAttendance.mjs'

test('a child keeps the attendance it inherited until it settles, then nothing of it is kept', () => {
  const children = new ChildAttendance()
  const asked = []
  const parents = new Map([['scheduled-root', true], ['person-root', false]])
  const parentUnattended = (/** @type {string} */ id) => { asked.push(id); return parents.get(id) === true }
  children.inherit('child-of-scheduled', 'scheduled-root', parentUnattended)
  children.inherit('child-of-person', 'person-root', parentUnattended)
  children.bind('delegated-child', true)
  assert.equal(children.get('child-of-scheduled'), true)
  assert.equal(children.get('child-of-person'), false)
  assert.equal(children.get('delegated-child'), true)
  // The parent moving on to an attended turn changes nothing for the child it started unattended.
  parents.set('scheduled-root', false)
  assert.equal(children.get('child-of-scheduled'), true)
  // Settled children are released: a runtime that ran thousands of children keeps none of them.
  for (const id of ['child-of-scheduled', 'child-of-person', 'delegated-child']) children.release(id)
  assert.equal(children.size, 0)
  for (let n = 0; n < 1000; n += 1) { children.bind(`c${n}`, n % 2 === 0); children.release(`c${n}`) }
  assert.equal(children.size, 0)
})

test('a child with no parent id or no id of its own records nothing and makes no parent state', () => {
  const children = new ChildAttendance()
  const asked = []
  children.inherit('orphan', '', (/** @type {string} */ id) => { asked.push(id); return true })
  children.inherit('', 'scheduled-root', (/** @type {string} */ id) => { asked.push(id); return true })
  children.bind('', true)
  assert.deepEqual(asked, [], 'no parent state is read, let alone created, for an empty id')
  assert.equal(children.size, 0)
  assert.equal(children.get('orphan'), undefined)
})
