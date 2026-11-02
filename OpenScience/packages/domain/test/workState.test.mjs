import assert from 'node:assert/strict'
import test from 'node:test'
import { WORK_STATES, WORK_STATE_LABEL, WORK_NEED_KINDS, WORK_NEED_LABEL, workStateLabel } from '../src/workState.mjs'

test('every state and need has one word, and no two states share one', () => {
  for (const state of WORK_STATES) assert.ok(WORK_STATE_LABEL[state], state)
  for (const kind of WORK_NEED_KINDS) assert.ok(WORK_NEED_LABEL[kind], kind)
  assert.equal(new Set(Object.values(WORK_STATE_LABEL)).size, WORK_STATES.length)
})

test('work outside what was asked for says nothing, and a wait names what it waits for', () => {
  assert.equal(workStateLabel(null), '')
  assert.equal(workStateLabel('running'), '进行中')
  assert.equal(workStateLabel('waiting'), '等你')
  assert.equal(workStateLabel('waiting', '设预算'), '等你设预算')
  assert.equal(workStateLabel('running', '设预算'), '进行中')
})
