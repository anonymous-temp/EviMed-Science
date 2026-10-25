import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillLibraryService } from '../src/skillLibraryService.mjs'
import { createPlatformSkillCatalogue } from '../src/platformSkillCatalogue.mjs'

const user = { id: 'owner' }, project = { id: 'one', userId: user.id }
function fixture() {
  const rows = new Map()
  const documents = {
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null) },
    async put(owner, kind, id, payload, options) {
      const key = `${owner}:${kind}:${id}`, old = rows.get(key)
      if ((old?.revision ?? 0) !== options.expectedRevision) throw Object.assign(new Error('conflict'), { code: 'product_revision_conflict' })
      const row = { id, payload, revision: options.expectedRevision + 1 }
      rows.set(key, structuredClone(row)); return structuredClone(row)
    },
  }
  const service = new SkillLibraryService(null, { documents,
    projectAccess: async (actor, selected) => { if (selected.userId !== actor.id) throw Object.assign(new Error('missing'), { status: 404 }) },
    platformCatalogue: createPlatformSkillCatalogue({ rootDir: new URL('../../..', import.meta.url).pathname }),
  })
  return { service, documents }
}

test('optional platform choices persist in the existing project selection, retain personal pins and isolate projects/accounts', async () => {
  const { service, documents } = fixture()
  await documents.put(user.id, 'extension-defaults', 'skills:project:one', { skills: [{ skillId: 'existing' }] }, { expectedRevision: 0 })
  const saved = await service.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: ['office:docx'] })
  assert.equal(saved.revision, 2)
  assert.equal(saved.items.find(item => item.id === 'office:docx').enabled, false)
  assert.equal(saved.items.find(item => item.id === 'office:docx').effective, null)
  assert.equal(saved.activation.phase, 'waiting')
  assert.deepEqual((await service.projectSelections(user, project)).payload.skills, [{ skillId: 'existing' }])
  const fresh = new SkillLibraryService(null, { documents, projectAccess: service.projectAccess, platformCatalogue: service.platformCatalogue })
  assert.deepEqual((await fresh.projectPlatform(user, project)).payload.disabled, ['office:docx'])
  assert.deepEqual((await fresh.projectPlatform(user, { id: 'two', userId: user.id })).payload.disabled, [])
  await assert.rejects(service.projectPlatform({ id: 'outsider' }, project), { status: 404 })
  await assert.rejects(service.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: [] }), { code: 'product_revision_conflict' })
  await assert.rejects(service.saveProjectPlatform(user, project, { expectedRevision: 2, disabled: ['core:stats-integrity'] }), { status: 409 })
  await assert.rejects(service.saveProjectPlatform(user, project, { expectedRevision: 2, disabled: ['office:unknown'] }), { status: 404 })
})

test('saved, waiting, effective and apply failure read back without claiming the saved policy is running', async () => {
  const { service, documents } = fixture()
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['office:docx'] })
  let state = { payload: { phase: 'waiting', runtimeGeneration: 'fixture', desired: { selectionRevision: 1 }, effective: { reference: { generationHash: 'a' }, selectionRevision: 0, platformSkills: { disabled: [] } }, error: null } }
  service.projectActivation = async () => ({ state, runtimeGeneration: 'fixture', captured: state.payload.effective })
  let view = await service.projectPlatform(user, project)
  assert.equal(view.activation.effectiveRevision, 0)
  assert.equal(view.items.find(item => item.id === 'office:docx').effective, true)
  state.payload.phase = 'failed'; state.payload.error = 'personal_skill_apply_failed'
  view = await service.projectPlatform(user, project)
  assert.equal(view.activation.phase, 'failed')
  assert.equal(view.activation.error, 'personal_skill_apply_failed')
  assert.equal(view.items.find(item => item.id === 'office:docx').effective, true)
  state = { payload: { phase: 'effective', runtimeGeneration: 'fixture', desired: { selectionRevision: 1 }, effective: { reference: { generationHash: 'b' }, selectionRevision: 1, platformSkills: { disabled: ['office:docx'] } }, error: null } }
  view = await service.projectPlatform(user, project)
  assert.equal(view.items.find(item => item.id === 'office:docx').effective, false)
  assert.equal((await service.projectSelections(user, project)).activation.phase, 'effective')
  await documents.put(user.id, 'extension-defaults', 'skills:project:one', { skills: [], disabledPlatformSkills: [] }, { expectedRevision: 1 })
  assert.equal((await service.projectPlatform(user, project)).activation.phase, 'waiting')
})

test('platform provenance identifies a verbatim publisher, derived upstream and first party methods', async () => {
  const { service } = fixture(), catalogue = await service.listPlatform(user)
  const byId = id => catalogue.items.find(item => item.id === id)
  assert.equal(byId('core:humanizer').provenance.publisher, 'blader')
  assert.equal(byId('core:humanizer').provenance.repository, 'https://github.com/blader/humanizer')
  assert.equal(byId('core:humanizer').provenance.license, 'MIT')
  assert.equal(byId('core:humanizer').provenance.version, '3.1.0')
  assert.equal(byId('curated:survival-analysis').provenance.kind, 'first-party-derived')
  assert.equal(byId('curated:survival-analysis').provenance.publisher, 'EviMed Science')
  assert.equal(byId('curated:survival-analysis').provenance.upstreamPublisher, 'K-Dense-AI')
  assert.equal(byId('office:docx').provenance.kind, 'first-party')
  assert.equal(byId('core:deep-research').requirement.required, false)
  assert.equal(byId('curated:statistical-analysis').requirement.required, false)
  assert.equal(byId('office:docx').requirement.required, false)
  assert.equal(byId('curated:matplotlib').provenance.kind, 'upstream-adapted')
})

test('persisted effect is historical when the current runtime is missing or has a different captured generation', async () => {
  const { service } = fixture()
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['office:docx'] })
  const effective = { reference: { generationHash: 'a'.repeat(64) }, selectionRevision: 1, platformSkills: { disabled: ['office:docx'] } }
  const state = { payload: { phase: 'effective', runtimeGeneration: 'old-runtime', desired: effective, effective } }
  service.projectActivation = async () => ({ state, runtimeGeneration: null, captured: null })
  assert.equal((await service.projectPlatform(user, project)).items.find(item => item.id === 'office:docx').effective, null)
  service.projectActivation = async () => ({ state, runtimeGeneration: 'new-runtime', captured: { reference: null, platformSkills: { disabled: [] } } })
  const fallback = await service.projectPlatform(user, project)
  assert.equal(fallback.activation.phase, 'waiting')
  assert.equal(fallback.activation.effectiveRevision, null)
  service.projectActivation = async () => ({ state, runtimeGeneration: 'old-runtime', captured: effective })
  assert.equal((await service.projectPlatform(user, project)).items.find(item => item.id === 'office:docx').effective, false)
})

test('optional builtin controls share project revision, preserve skills, and cannot enable a deployment-disabled integration', async () => {
  const { service } = fixture()
  const result = await service.saveProjectBuiltins(user, project, { expectedRevision: 0, disabled: ['annotation'] })
  assert.equal(result.revision, 1)
  assert.deepEqual(result.payload.disabled, ['annotation'])
  assert.equal(result.items.find(item => item.id === 'annotation').enabled, false)
  assert.equal(result.items.find(item => item.id === 'annotation').effective, null)
  await service.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: ['office:docx'] })
  assert.equal((await service.projectBuiltins(user, project)).items.find(item => item.id === 'annotation').enabled, false)
  await assert.rejects(service.saveProjectBuiltins(user, project, { expectedRevision: 2, disabled: ['memory'] }), { status: 400 })
  service.builtinAvailability.annotation = false
  const unavailable = await service.saveProjectBuiltins(user, project, { expectedRevision: 2, disabled: [] })
  assert.equal(unavailable.items.find(item => item.id === 'annotation').enabled, false)
  assert.equal(unavailable.items.find(item => item.id === 'annotation').reason, 'deployment_disabled')
  assert.deepEqual(unavailable.payload.disabled, [])
})

test('a saved disabled id that left the catalogue never blocks a later save and is not sent back to the page', async () => {
  const { service, documents } = fixture()
  // A release removed the skill this project had switched off (and one became required by a workflow).
  await documents.put(user.id, 'extension-defaults', 'skills:project:one', { skills: [], disabledPlatformSkills: ['community:retired-skill', 'core:domain-check', 'office:docx'] }, { expectedRevision: 0 })
  const view = await service.projectPlatform(user, project)
  assert.deepEqual(view.payload.disabled, ['office:docx'], 'the page is given only ids it can show and switch')
  assert.deepEqual(view.staleDisabled, ['community:retired-skill', 'core:domain-check'])
  // The page re-sends what it holds, or (an older page) the stale ids too: neither is refused.
  const saved = await service.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: ['community:retired-skill', 'office:docx', 'office:pptx'] })
  assert.deepEqual(saved.payload.disabled, ['office:docx', 'office:pptx'])
  assert.deepEqual((await service.projectSelections(user, project)).payload.disabledPlatformSkills, ['office:docx', 'office:pptx'], 'the stale id is dropped from storage')
  // A newly named unknown id is still refused.
  await assert.rejects(service.saveProjectPlatform(user, project, { expectedRevision: 2, disabled: ['community:never-shipped'] }), { status: 404 })
})
