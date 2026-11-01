import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VCR_JOB_STATES, VCR_JOB_STATE_LABELS_ZH, VCR_STEP_STATUSES, VCR_STUDY_STATUS_LABELS_ZH, WORK_STATE_LABEL, vcrJobWorkState, vcrStepStateLabel, vcrStepWorkState,
  vcrStudyWorkState,
} from '../index.mjs'

test('a step is worded by the vocabulary of module work, whatever page draws it', () => {
  // The same record, the same word: requested and not started is 待开始 and never 未开始 / 还没开始 / 排队中.
  assert.equal(vcrStepStateLabel({ status: 'none', requested: true }), WORK_STATE_LABEL.todo)
  assert.equal(vcrStepStateLabel({ status: 'queued' }), WORK_STATE_LABEL.queued)
  assert.equal(vcrStepStateLabel({ status: 'running' }), WORK_STATE_LABEL.running)
  assert.equal(vcrStepStateLabel({ status: 'failed' }), WORK_STATE_LABEL.failed, 'a step that failed with part of its work kept is 未完成')
  assert.equal(vcrStepStateLabel({ status: 'minimal' }), WORK_STATE_LABEL.minimal, 'a dependency run at lower precision is not the same as a finished step')
  assert.equal(vcrStepStateLabel({ status: 'done' }), WORK_STATE_LABEL.done)
  assert.equal(vcrStepStateLabel({ status: 'stale' }), WORK_STATE_LABEL.stale)
  assert.notEqual(vcrStepStateLabel({ status: 'minimal' }), vcrStepStateLabel({ status: 'done' }))
  // Every status the study record can hold has an answer, so a new one cannot be drawn as a blank.
  for (const status of VCR_STEP_STATUSES) assert.ok(vcrStepWorkState({ status, requested: true }).state, status)
})

test('work outside what was asked for says nothing but its name, and a held step is startable', () => {
  assert.deepEqual(vcrStepWorkState({ status: 'none', requested: false }), { state: null, detail: null })
  assert.deepEqual(vcrStepWorkState({ status: 'none' }), { state: null, detail: null })
  assert.deepEqual(vcrStepWorkState(undefined), { state: null, detail: null })
  assert.equal(vcrStepStateLabel({ status: 'none', requested: false }), '')
  assert.equal(vcrStepStateLabel({ status: 'none', requested: true, held: true }), WORK_STATE_LABEL.todo)
})

test('a queued step the allowance refused waits for the person, and says on which wallet', () => {
  assert.equal(vcrStepStateLabel({ status: 'queued', waiting: 'allowance' }), '等你充值')
  assert.equal(vcrStepStateLabel({ status: 'queued', waiting: 'simulated_allowance' }), '等你模拟充值')
  // Only while queued: a step that has started waits on nothing, whatever an older write left on its record.
  assert.equal(vcrStepStateLabel({ status: 'running', waiting: 'allowance' }), WORK_STATE_LABEL.running)
})

test('a job past the budget waits for the lead and is not a failure; a paused study is the one project-level state', () => {
  assert.deepEqual(vcrJobWorkState('awaiting_budget'), { state: 'waiting', detail: '确认预算' })
  assert.equal(VCR_JOB_STATE_LABELS_ZH.awaiting_budget, '等你确认预算')
  assert.notEqual(VCR_JOB_STATE_LABELS_ZH.awaiting_budget, VCR_JOB_STATE_LABELS_ZH.failed)
  assert.equal(VCR_JOB_STATE_LABELS_ZH.canceled, WORK_STATE_LABEL.stopped)
  for (const state of VCR_JOB_STATES) assert.ok(vcrJobWorkState(state).state && VCR_JOB_STATE_LABELS_ZH[state], state)
  assert.equal(vcrStudyWorkState('paused'), 'paused')
  assert.equal(VCR_STUDY_STATUS_LABELS_ZH.paused, WORK_STATE_LABEL.paused)
  for (const status of ['draft', 'active', 'archived', undefined]) assert.equal(vcrStudyWorkState(status), null)
})
