import test from 'node:test'
import assert from 'node:assert/strict'
import { VCR_JOB_METHODS, VCR_ENGINE_METHODS, RESEARCH_NATIVE_BUNDLES } from '@evimed/domain'
import { isResearchPluginTool, projectResearchInvocation, researchPluginOfTool } from '../hostedProtocol.mjs'

const registry = { jobMethods: VCR_JOB_METHODS, methods: VCR_ENGINE_METHODS }
const project = (tool, args) => projectResearchInvocation(tool, args, registry)

test('the lab tools project onto the simulate operation, one action each, and nothing else', () => {
  const manifest = { objective: { measure: 'power', direction: 'maximize' } }
  assert.deepEqual(project('virtual_trial_search', { manifest }), { operation: 'simulate', body: { action: 'search', manifest } })
  assert.deepEqual(project('virtual_trial_search', { campaignId: 'cmp_1' }), { operation: 'simulate', body: { action: 'search_status', campaignId: 'cmp_1' } })
  assert.deepEqual(project('virtual_trial_search', { campaignId: 'cmp_1', cancel: true }), { operation: 'simulate', body: { action: 'search_cancel', campaignId: 'cmp_1' } })
  assert.deepEqual(project('virtual_trial_compare', { experiment: { arms: [] } }), { operation: 'simulate', body: { action: 'compare', experiment: { arms: [] } } })
  assert.deepEqual(project('virtual_trial_compare', { experimentId: 'exp_1' }), { operation: 'simulate', body: { action: 'compare_status', experimentId: 'exp_1' } })
  for (const [tool, args] of [['virtual_trial_search', { manifest, campaignId: 'cmp_1' }], ['virtual_trial_search', { manifest: [] }], ['virtual_trial_search', { jobId: 'x' }],
    ['virtual_trial_compare', { experiment: {}, experimentId: 'x' }], ['virtual_trial_compare', { method: 'design.simulate' }]]) {
    assert.throws(() => project(tool, args), /research_(invocation_invalid|campaign_required|experiment_required)/, `${tool} ${JSON.stringify(args)}`)
  }
  assert.throws(() => project('virtual_cohort_search', { manifest }), /research_invocation_invalid/, 'the lab is the trial plugin\'s')
})

test('the lab tools are research tools of the trial plugin and in its bundle inventory', () => {
  assert.equal(isResearchPluginTool('virtual_trial_search'), true)
  assert.equal(isResearchPluginTool('virtual_trial_compare'), true)
  assert.equal(isResearchPluginTool('virtual_patient_search'), false)
  assert.equal(researchPluginOfTool('virtual_trial_search'), 'virtual-trial')
  assert.equal(researchPluginOfTool('synthetic_control_start'), 'synthetic-control')
  assert.deepEqual(RESEARCH_NATIVE_BUNDLES['virtual-trial'].tools.slice(-2), ['virtual_trial_search', 'virtual_trial_compare'])
  assert.equal(RESEARCH_NATIVE_BUNDLES['virtual-cohort'].tools.length, 5)
})
