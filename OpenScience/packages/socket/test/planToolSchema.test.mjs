// The plan tool's parameters, compiled by the kernel's own schema DSL
// (`@deepseek-ai/dsh-tools`, the pinned release) rather than by the fake
// registry the plugin suites use. The kernel validates every call against these
// before the tool runs, so two things are only true if the real compiler says
// so: that `studyType` — an enum inside the deliverable objects of an array —
// is a schema the DSL accepts at all (a refused keyword throws at
// registration, and the plugin would not load), and that a value outside the
// domain's vocabulary is refused at the call, naming the field.
import assert from 'node:assert/strict'
import test from 'node:test'

import { loadHarnessModule } from '@evimed/harness-port'
import { STUDY_TYPES } from '@evimed/domain'

import { planToolParameters } from '../src/runPolicy.mjs'

test('the kernel compiles the plan tool and holds studyType to the vocabulary before the tool runs', async () => {
  const { defineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  /** @type {any[]} */
  const calls = []
  const tool = defineTool({
    name: 'evimed_plan',
    description: 'plan',
    parameters: planToolParameters(),
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    execute: async (/** @type {any} */ args) => { calls.push(args); return { ok: true } },
  })
  const field = tool.parameters?.properties?.deliverables?.items?.properties?.studyType
  assert.deepEqual(field?.enum, [...STUDY_TYPES], 'the compiled schema carries the vocabulary the model is shown')
  assert.equal((tool.parameters?.properties?.deliverables?.items?.required ?? []).includes('studyType'), false, 'studyType is optional')

  const deliverable = { id: 'results', contractKind: 'manuscript-section', capability: 'manuscript-support', title: '结果', dependsOn: [] }
  for (const studyType of STUDY_TYPES) {
    await tool.execute({ action: 'write', clarifications: ['x'], deliverables: [{ ...deliverable, studyType }] }, {})
  }
  await tool.execute({ action: 'write', clarifications: ['x'], deliverables: [deliverable] }, {})
  assert.equal(calls.length, STUDY_TYPES.length + 1, 'every declared type, and none, reaches the tool')

  // An empty string is refused too: the description tells the planner to leave
  // the field out when the deliverable reports no one study.
  for (const studyType of ['cohort', '']) {
    await assert.rejects(
      tool.execute({ action: 'write', clarifications: ['x'], deliverables: [{ ...deliverable, studyType }] }, {}),
      (/** @type {any} */ error) => /deliverables\[0\]\.studyType" must be one of \["rct"/.test(String(error?.message)),
      `${JSON.stringify(studyType)} is refused, and the refusal names the field and the values it takes`,
    )
  }
  assert.equal(calls.length, STUDY_TYPES.length + 1, 'a refused call never reaches the tool')
})
