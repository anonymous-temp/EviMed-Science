import assert from 'node:assert/strict'
import test from 'node:test'
import { geoWorkflowState } from '../src/geoWorkflow.mjs'

test('default and completed data never request a programme', () => {
  for (const steps of [{}, {questions:{status:'done'}}, {questions:{status:'minimal'}}]) {
    const view=geoWorkflowState(steps)
    assert.deepEqual(view.requested,[])
    assert.deepEqual(view.nextRunnable,[])
  }
})
test('monitoring needs diagnosis and questions, never distribution', () => {
  const view=geoWorkflowState({monitoring:{requested:true},evidence:{status:'done'},questions:{status:'done'}})
  assert.deepEqual(view.requested,['monitoring'])
  assert.deepEqual(view.required,['evidence','questions','diagnosis','monitoring'])
  assert.deepEqual(view.steps.monitoring.waitingFor,['diagnosis'])
  assert.deepEqual(view.nextRunnable,['diagnosis'])
})
test('a manuscript-only request does not start measurement or publishing', () => {
  const view=geoWorkflowState({content:{requested:true},evidence:{status:'minimal'}})
  assert.deepEqual(view.required,['evidence','content'])
  assert.deepEqual(view.nextRunnable,['content'])
})
test('full explicitly requested programme requires strategy before content', () => {
  const steps=Object.fromEntries(['evidence','journey','questions','diagnosis','sources','content','distribution','monitoring'].map(key=>[key,{requested:true}]))
  const view=geoWorkflowState(steps)
  assert.equal(view.full,true)
  assert.deepEqual(view.steps.content.dependencies,['evidence','sources'])
  assert.deepEqual(view.nextRunnable,['evidence'])
})
test('queued legacy work retains scope and references, without being offered as a new start', () => {
  const view=geoWorkflowState({evidence:{status:'queued',runId:'run-a',updatedAt:'2026-10-31T00:00:00Z'}})
  assert.deepEqual(view.requested,['evidence'])
  assert.deepEqual(view.active,['evidence'])
  assert.deepEqual(view.nextRunnable,[])
  assert.equal(view.steps.evidence.runId,'run-a')
})

test('legacy expanded flags preserve history and admitted work without authorizing later steps', () => {
  const steps={evidence:{status:'done',requested:true,requestOrigin:'legacy'},content:{status:'none',requested:true,requestOrigin:'legacy'},
    diagnosis:{status:'running',requested:true,requestOrigin:'legacy',runId:'accepted'},monitoring:{status:'none',requested:true,requestOrigin:'legacy'}}
  const view=geoWorkflowState(steps)
  assert.deepEqual(view.requested,['diagnosis'])
  assert.deepEqual(view.legacyUnconfirmed,['content','monitoring'])
  assert.equal(view.steps.evidence.status,'done')
  assert.equal(view.steps.diagnosis.runId,'accepted')
  assert.equal(view.required.includes('content'),false)
})
