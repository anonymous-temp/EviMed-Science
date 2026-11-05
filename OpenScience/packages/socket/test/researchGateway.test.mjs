import assert from 'node:assert/strict'
import test from 'node:test'
import { VCR_JOB_METHODS, VCR_ENGINE_METHODS } from '@evimed/domain'
import { projectResearchInvocation } from '@evimed/research-plugin-runtime/hosted-protocol'
import { createResearchGatewayAdapter } from '../src/researchGateway.mjs'
import { renderResearchReport } from '../../research-plugin-runtime/report.mjs'

const registry = { jobMethods: VCR_JOB_METHODS, methods: VCR_ENGINE_METHODS }
test('research tools project only their owned methods and immutable arguments', () => {
  assert.deepEqual(projectResearchInvocation('virtual_trial_start', { method: 'design.analytic', scenario: { endpoint: {} } }, registry),
    { operation: 'simulate', body: { action: 'start', kind: 'design_analytic', scenario: { endpoint: {} } } })
  assert.throws(() => projectResearchInvocation('virtual_trial_start', { method: 'comparator.evalue', scenario: {} }, registry))
  assert.equal(projectResearchInvocation('virtual_trial_describe', { method: 'evidence.network' }, registry).body.action, 'shape')
  assert.throws(() => projectResearchInvocation('virtual_trial_start', { method: 'design.analytic', scenario: {}, projectId: 'other' }, registry))
  assert.throws(() => projectResearchInvocation('virtual_trial_start', { method: 'design.analytic', scenario: {}, version: 'wrong' }, registry))
  assert.deepEqual(projectResearchInvocation('synthetic_control_report', { jobId: 'owned' }, registry),
    { operation: 'simulate', body: { action: 'status', jobId: 'owned' } })
})

test('hosted adapter sends native proof and reloads the workload token per call', async () => {
  /** @type {Array<{url:any,headers:any,body:any,redirect:any}>} */
  const calls = []; let tokens = 0
  const adapter = createResearchGatewayAdapter({ gatewayUrl: 'http://127.0.0.1/internal/vcr/v1/simulate',
    readToken: async () => `token${++tokens}`, fetchImpl: async (url, init) => {
      calls.push({ url, headers: init?.headers, body: JSON.parse(String(init?.body)), redirect: init?.redirect })
      return new Response(JSON.stringify({ data: { jobId: 'job_owned', state: 'queued' } }))
    } })
  const controller = new AbortController()
  const call = { name: 'virtual_trial_start', args: { method: 'design.analytic', scenario: {} }, sessionId: 'session1', callId: 'call1', signal: controller.signal }
  await adapter.forCall(call).start()
  await adapter.forCall({ ...call, name: 'virtual_trial_read', args: { jobId: 'job_owned' } }).read()
  assert.equal(tokens, 2)
  assert.equal(calls[0].headers.authorization, 'Bearer token1')
  assert.deepEqual(JSON.parse(calls[0].headers['x-evimed-execution-context']), { v: 1, sessionId: 'session1', callId: 'call1' })
  assert.equal(calls[0].redirect, 'error')
  assert.equal(calls[1].body.action, 'status')
  controller.abort()
  await assert.rejects(adapter.forCall(call).start())
  assert.equal(calls.length, 2)
})

test('hosted adapter refuses credentials in configured URL and bounded response overflow', async () => {
  assert.throws(() => createResearchGatewayAdapter({ gatewayUrl: 'https://secret@example.test/internal/vcr/v1/simulate', readToken: async () => 'token' }))
  const adapter = createResearchGatewayAdapter({ gatewayUrl: 'http://127.0.0.1/internal/vcr/v1/simulate', readToken: async () => 'token',
    fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) })
  await assert.rejects(adapter.forCall({ name: 'virtual_trial_read', args: { jobId: 'owned' }, sessionId: 's', callId: 'c', signal: new AbortController().signal }).read(), /research_response_too_large/)
})

test('hosted report preserves the producing job method and actual result measures', async () => {
  const adapter = createResearchGatewayAdapter({ gatewayUrl: 'http://127.0.0.1/internal/vcr/v1/simulate', readToken: async () => 'token',
    fetchImpl: async () => new Response(JSON.stringify({ data: { jobId: 'owned', state: 'succeeded', method: 'design.analytic', methodVersion: '1.4.0',
      result: { conclusion: 'estimable', measures: [{ name: 'patients', value: 436, unit: 'patients' }] } } })) })
  const result = await adapter.forCall({ name: 'virtual_trial_report', args: { jobId: 'owned' }, sessionId: 's', callId: 'c', signal: new AbortController().signal }).read()
  assert.equal(result.status, 'succeeded')
  const report = renderResearchReport(result, null)
  assert.match(report, /design\.analytic.*1\.4\.0/)
  assert.match(report, /436/)
  assert.doesNotMatch(report, /version Not reported/)
})
