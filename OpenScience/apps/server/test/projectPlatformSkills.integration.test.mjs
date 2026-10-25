import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs'
import { SkillLibraryService } from '../src/skillLibraryService.mjs'
import { createPlatformSkillCatalogue } from '../src/platformSkillCatalogue.mjs'
import { PluginService } from '../src/pluginService.mjs'
import { PersonalSkillGenerationService, verifyPersonalSkillGeneration, personalGenerationForStart } from '../src/personalSkillGenerationService.mjs'
import { PersonalSkillGenerationWorker } from '../src/personalSkillGenerationWorker.mjs'

test('PostgreSQL optional policy survives restart, waits for current work, publishes immutable proof and reports a failed replacement truthfully', {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'A local PostgreSQL fixture is required.',
}, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'platformskills')
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'platform-policy-generation-')))
  t.after(async () => { await database.close(); await isolated.drop(); await fs.rm(root, { recursive: true, force: true }) })
  await database.migrate()
  const user = { id: 'owner' }, project = { id: 'paper', userId: user.id }, second = { id: 'other', userId: user.id }
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Fixture','development')", [user.id])
  for (const item of [project, second]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Fixture',1048576)", [user.id, item.id])
  const options = { artifacts: { root: path.join(root, 'library'), maxGlobalBytes: 1024 * 1024 * 1024, minFreeBytes: 0 },
    projectAccess: async (actor, selected) => { assert.equal(actor.id, selected.userId) },
    platformCatalogue: createPlatformSkillCatalogue({ rootDir: new URL('../../..', import.meta.url).pathname }) }
  await fs.mkdir(options.artifacts.root)
  let skills = new SkillLibraryService(database, options), captured = null, original = null, epoch = 'original-runtime'
  const plugins = new PluginService(database)
  const identity = { baseRuntimeImageDigest: `sha256:${'a'.repeat(64)}`, adapterRevision: `sha256:${'b'.repeat(64)}`, permissionProfileRevision: `sha256:${'c'.repeat(64)}` }
  const service = new PersonalSkillGenerationService(database, { config: { dataDir: root }, skillService: skills, pluginService: plugins,
    resolveUser: async () => user, identities: async () => identity, ledgerBusy: async () => false })
  const observe = async () => ({ state: await service.current(project), runtimeGeneration: captured ? epoch : null, captured })
  skills.projectActivation = observe
  await skills.initializeProject(user, project)
  original = await plugins.withAdmission(project, () => service.reconcile(user, project))
  await service.markEffective(project, original, 'original-runtime')
  captured = original
  await database.query("UPDATE evimed_product.jobs SET status='succeeded' WHERE status='queued'")
  await plugins.withAdmission(project, () => skills.saveProjectPlatform(user, project, { expectedRevision: 1, disabled: ['office:docx'] }))
  skills = new SkillLibraryService(database, options); service.skills = skills
  skills.projectActivation = observe
  assert.deepEqual((await skills.projectPlatform(user, project)).payload.disabled, ['office:docx'])
  assert.deepEqual((await skills.projectPlatform(user, second)).payload.disabled, [])
  const candidate = await plugins.withAdmission(project, () => service.reconcile(user, project))
  assert.notEqual(candidate.reference.generationHash, original.reference.generationHash)
  assert.deepEqual((await verifyPersonalSkillGeneration(service.config, project, candidate.reference)).platformSkills, { disabled: ['office:docx'], disabledPlugins: [] })
  const saved = await service.current(project)
  assert.equal((await personalGenerationForStart({ state: saved, identity, busy: async () => true })).reference.generationHash, original.reference.generationHash)
  assert.equal((await personalGenerationForStart({ state: saved, identity, busy: async () => false })).reference.generationHash, candidate.reference.generationHash)
  let busy = true, replacements = 0
  const runtime = { runtimeGeneration: () => epoch, runtimePersonalSkillGeneration: () => captured, pluginRuntimeBusy: async () => busy,
    async replacePersonalSkillRuntime(_project, desired) { replacements++; captured = desired; epoch = 'fixture-runtime' },
    async probePersonalSkillGeneration() { return { generation: epoch } } }
  const worker = new PersonalSkillGenerationWorker({ service, runtime, resolveProject: async () => project, ledgerBusy: async () => false })
  await worker.tick()
  assert.equal(replacements, 0)
  assert.equal((await skills.projectPlatform(user, project)).items.find(item => item.id === 'office:docx').effective, true)
  busy = false
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE status='queued'")
  await worker.tick()
  const effective = await skills.projectPlatform(user, project)
  assert.equal(replacements, 1)
  assert.equal(effective.activation.phase, 'effective')
  assert.equal(effective.items.find(item => item.id === 'office:docx').effective, false)
  captured = null
  assert.equal((await skills.projectPlatform(user, project)).items.find(item => item.id === 'office:docx').effective, null)
  captured = candidate; epoch = 'cold-runtime'
  assert.equal((await skills.projectPlatform(user, project)).activation.phase, 'waiting')
  const proofJob = await service.requestRuntimeProof(project, captured, epoch)
  assert.equal(proofJob.kind, 'personal-skill-apply')
  assert.equal(await service.requestRuntimeProof(project, captured, epoch), null, 'the runtime epoch has one leased proof job')
  await worker.tick()
  assert.equal(replacements, 1, 'a cold same-generation proof does not replace the running composition')
  assert.equal((await skills.projectPlatform(user, project)).activation.phase, 'effective')
  assert.equal((await service.current(project)).payload.runtimeGeneration, 'cold-runtime')
  await plugins.withAdmission(project, () => skills.saveProjectPlatform(user, project, { expectedRevision: 2, disabled: [] }))
  const enabled = await plugins.withAdmission(project, () => service.reconcile(user, project))
  let fail = true
  runtime.probePersonalSkillGeneration = async () => { if (fail) { fail = false; throw new Error('native proof failed') } return { generation: epoch } }
  await worker.tick()
  const failed = await skills.projectPlatform(user, project)
  assert.equal(failed.activation.phase, 'rolled-back')
  assert.equal(failed.activation.error, 'personal_skill_apply_failed')
  assert.equal(failed.items.find(item => item.id === 'office:docx').enabled, true)
  assert.equal(failed.items.find(item => item.id === 'office:docx').effective, false)
  assert.notEqual(captured.reference.generationHash, enabled.reference.generationHash)
  await worker.close()
})
