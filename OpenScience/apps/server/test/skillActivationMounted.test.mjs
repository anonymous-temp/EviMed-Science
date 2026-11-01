import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillLibraryService } from '../src/skillLibraryService.mjs'
import { createPlatformSkillCatalogue } from '../src/platformSkillCatalogue.mjs'

const user = { id: 'owner' }, project = { id: 'one', userId: user.id }
const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64)

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
  return new SkillLibraryService(null, { documents,
    projectAccess: async (actor, selected) => { if (selected.userId !== actor.id) throw Object.assign(new Error('missing'), { status: 404 }) },
    platformCatalogue: createPlatformSkillCatalogue({ rootDir: new URL('../../..', import.meta.url).pathname }) })
}
/** A generation as the generation state and the runtime record carry it. */
const generation = (hash, selectionRevision, disabled = []) => ({ reference: { generationHash: hash }, pins: [], selectionRevision, platformSkills: { disabled, disabledPlugins: [] } })
/** The generation state after the apply worker's proof failed: nothing proven (`effective` null), the saved choices as `desired`. */
const failedState = (phase, desired, effective = null) => ({ payload: { phase, error: 'personal_skill_apply_failed', desired, effective, lastGood: effective, runtimeGeneration: null } })

test('a failed proof does not read as a failure while the live runtime carries the saved generation', async () => {
  const service = fixture()
  // Revision 1 of the project's selection; the runtime was launched with exactly this generation.
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['curated:matplotlib'] })
  const saved = generation(HASH, 1, ['curated:matplotlib'])
  service.projectActivation = async () => ({ state: failedState('failed', saved), runtimeGeneration: 'live-runtime', captured: saved,
    builtins: { annotation: true, mermaid: false } })
  const view = await service.projectPlatform(user, project)
  assert.equal(view.activation.phase, 'effective')
  assert.equal(view.activation.live, true)
  assert.equal(view.activation.savedRevision, 1)
  assert.equal(view.activation.effectiveRevision, 1)
  // The proof did fail, and the code that says so is still on the record for whoever reads it.
  assert.equal(view.activation.error, 'personal_skill_apply_failed')
  // What the page's switches say is what the runtime carries.
  assert.equal(view.items.find(item => item.id === 'curated:matplotlib').effective, false)
  const read = await service.projectSelections(user, project)
  assert.equal(read.activation.phase, 'effective')
  assert.deepEqual(read.activation.effectiveBuiltins, { annotation: true, mermaid: false })
})

test('a failed proof still reads as a failure when the saved generation is not what the runtime carries', async () => {
  const service = fixture()
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['curated:matplotlib'] })
  const saved = generation(HASH, 1, ['curated:matplotlib'])
  const phaseWith = async (state, observed) => {
    service.projectActivation = async () => ({ state, ...observed })
    return (await service.projectSelections(user, project)).activation
  }
  // The ordinary baseline is mounted: nothing of the saved choices is in effect.
  const baseline = await phaseWith(failedState('failed', saved), { runtimeGeneration: 'live-runtime', captured: { reference: null, pins: [], selectionRevision: 1, findings: [] } })
  assert.equal(baseline.phase, 'failed')
  assert.equal(baseline.effectiveRevision, null)
  assert.equal(baseline.error, 'personal_skill_apply_failed')
  // Another generation is mounted.
  assert.equal((await phaseWith(failedState('failed', saved), { runtimeGeneration: 'live-runtime', captured: generation(OTHER, 1) })).phase, 'failed')
  // No runtime runs: there is nothing mounted to read, and the record stands until a start proves it again.
  assert.equal((await phaseWith(failedState('failed', saved), { runtimeGeneration: null, captured: null })).phase, 'failed')
  // A selection that was never prepared (no reference) has nothing a runtime could carry.
  assert.equal((await phaseWith(failedState('failed', { ...saved, reference: null }), { runtimeGeneration: 'live-runtime', captured: { reference: null, pins: [] } })).phase, 'failed')
  // The previously proven generation was restored: rolled back, and the saved choices are not in effect.
  const previous = generation(OTHER, 0)
  const rolledBack = await phaseWith({ payload: { ...failedState('rolled-back', saved, previous).payload, runtimeGeneration: 'live-runtime' } }, { runtimeGeneration: 'live-runtime', captured: previous })
  assert.equal(rolledBack.phase, 'rolled-back')
  assert.equal(rolledBack.effectiveRevision, 0)
})

test('a failed proof of an older selection never marks a newer saved selection as mounted', async () => {
  const service = fixture()
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['curated:matplotlib'] })
  await service.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: [] })
  // The runtime carries the generation of revision 1; the saved selection is revision 2.
  const old = generation(HASH, 1, ['curated:matplotlib'])
  service.projectActivation = async () => ({ state: failedState('failed', old), runtimeGeneration: 'live-runtime', captured: old })
  const activation = (await service.projectSelections(user, project)).activation
  assert.equal(activation.savedRevision, 2)
  assert.equal(activation.phase, 'waiting')
  assert.equal(activation.effectiveRevision, null)
})

test('a rolled-back record whose restored generation is the saved one reads as in effect', async () => {
  const service = fixture()
  await service.saveProjectPlatform(user, project, { expectedRevision: 0, disabled: ['curated:matplotlib'] })
  const saved = generation(HASH, 1, ['curated:matplotlib'])
  // The first proof failed; the restored runtime (the same generation) was proven on its second boot.
  const state = { payload: { ...failedState('rolled-back', saved, saved).payload, runtimeGeneration: 'live-runtime' } }
  service.projectActivation = async () => ({ state, runtimeGeneration: 'live-runtime', captured: saved })
  const activation = (await service.projectSelections(user, project)).activation
  assert.equal(activation.phase, 'effective')
  assert.equal(activation.effectiveRevision, 1)
})
