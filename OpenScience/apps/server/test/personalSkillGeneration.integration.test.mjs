import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RuntimeManager } from '../src/runtimeManager.mjs'
import { parsePersonalSkill } from '@evimed/harness-port/personal-skills'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs'
import { SkillLibraryService } from '../src/skillLibraryService.mjs'
import { SkillLibraryArtifacts } from '../src/skillLibraryArtifacts.mjs'
import { PluginService } from '../src/pluginService.mjs'
import { PersonalSkillGenerationService, verifyPersonalSkillGeneration } from '../src/personalSkillGenerationService.mjs'
import { PersonalSkillGenerationWorker } from '../src/personalSkillGenerationWorker.mjs'

const configured = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL
const options = { skip: !configured && 'A local PostgreSQL fixture is required.' }
const user = { id: `generation_${randomUUID()}` }
const project = { userId: user.id, id: 'project' }
const identities = { baseRuntimeImageDigest: process.env.OPEN_SCIENCE_TEST_PERSONAL_SKILL_IMAGE ?? `sha256:${'a'.repeat(64)}`, adapterRevision: `sha256:${'b'.repeat(64)}`, permissionProfileRevision: `sha256:${'c'.repeat(64)}` }
let database, isolated, root, skills, plugins, generations, created
before(async () => {
  if (!configured) return
  isolated = await createGeoTestDatabase(configured, 'personalgen')
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  await database.migrate()
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Generation fixture','development')", [user.id])
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Project',1048576)", [user.id, project.id])
  const selectedParent = process.env.OPEN_SCIENCE_TEST_PERSONAL_SKILL_DATA
  if (selectedParent && !path.isAbsolute(selectedParent)) throw new Error('Personal fixture parent must be absolute')
  const parent = selectedParent ?? (process.env.OPEN_SCIENCE_TEST_PERSONAL_SKILL_IMAGE ? new URL('../../../../.evimed-local/extensions/build/fixtures/', import.meta.url).pathname : os.tmpdir())
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  if (selectedParent) { const info = await fs.lstat(parent); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Personal fixture parent must be an owned private directory') }
  root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'personal-generation-')))
  const libraryRoot = path.join(root, '.openscience', 'skill-library'); await fs.mkdir(libraryRoot, { recursive: true })
  const artifacts = new SkillLibraryArtifacts({ root: libraryRoot, parseSkill: parsePersonalSkill })
  skills = new SkillLibraryService(database, { artifacts, projectAccess: async (actor, selected) => {
    const found = await database.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2', [actor.id, selected.id])
    assert.equal(found.rowCount, 1)
  } })
  // A short wait: the fence test below holds the project's lock and expects the refusal.
  plugins = new PluginService(database, { admissionWaitMs: 50 })
  generations = new PersonalSkillGenerationService(database, { config: { dataDir: root }, skillService: skills, pluginService: plugins,
    resolveUser: async () => user, identities: async () => identities, ledgerBusy: async () => false })
  created = await skills.create(user, { expectedRevision: 0, title: 'Review', description: 'Review sources', instructions: 'Old instructions.' })
  await skills.saveProjectSelections(user, project, { expectedRevision: 0, skills: [{ skillId: created.id, revision: 1 }] })
})
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }) })

test('real pool1 shared admission materializes native bytes and atomically records desired generation/job', options, async () => {
  const candidate = await plugins.withAdmission(project, () => database.transaction(async () => generations.reconcile(user, project)))
  const verified = await verifyPersonalSkillGeneration(generations.config, project, candidate.reference, identities.baseRuntimeImageDigest)
  assert.equal((await parsePersonalSkill(verified.mountRoot, { expectedName: created.payload.nativeName })).instructions, 'Old instructions.')
  assert.equal(candidate.pins[0].revision, 1)
  const jobs = await database.query("SELECT kind FROM evimed_product.jobs WHERE user_id=$1", [user.id])
  assert.deepEqual(jobs.rows.map(row => row.kind), ['personal-skill-apply'])
  await generations.markEffective(project, candidate, 'runtime-one')
})

test('real pool1 selection + generation outbox failure rolls back and retains the last good native bytes', options, async () => {
  const before = await generations.current(project)
  const updated = await skills.update(user, created.id, { expectedRevision: 1, title: 'Review', description: 'Review sources', instructions: 'New instructions.' })
  const original = generations.jobs.enqueue
  generations.jobs.enqueue = async () => { throw new Error('injected outbox failure') }
  try {
    await assert.rejects(plugins.withAdmission(project, () => database.transaction(async () => {
      await skills.saveProjectSelections(user, project, { expectedRevision: 1, skills: [{ skillId: created.id, revision: updated.revision }] })
      await generations.reconcile(user, project)
    })), /outbox failure/u)
  } finally { generations.jobs.enqueue = original }
  assert.equal((await skills.projectSelections(user, project)).revision, 1)
  const after = await generations.current(project)
  assert.equal(after.revision, before.revision)
  const mounted = await verifyPersonalSkillGeneration(generations.config, project, after.payload.lastGood.reference)
  assert.equal((await parsePersonalSkill(mounted.mountRoot)).instructions, 'Old instructions.')
  assert.equal((await database.query('SELECT count(*)::integer AS count FROM evimed_product.jobs WHERE user_id=$1', [user.id])).rows[0].count, 1)
})

test('real exclusive project apply fence prevents a concurrent selection mutation before any write', options, async () => {
  const blocker = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  let acquired, release
  const held = new Promise(resolve => { acquired = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const pending = blocker.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`plugin-project:${user.id}:${project.id}`])
    acquired(); await gate
  })
  await held
  try {
    await assert.rejects(plugins.withAdmission(project, () => skills.saveProjectSelections(user, project,
      { expectedRevision: 1, skills: [] })), { code: 'plugin_apply_in_progress' })
    assert.equal((await skills.projectSelections(user, project)).revision, 1)
  } finally { release(); await pending; await blocker.close() }
})

test('image-unavailable intent has a durable waiting job and cannot manufacture an effective generation', options, async () => {
  const acquire = generations.identities
  generations.identities = async () => { throw new Error('fixture image unavailable') }
  try {
    const waiting = await plugins.withAdmission(project, () => database.transaction(async () => {
      await skills.saveProjectSelections(user, project, { expectedRevision: 1, skills: [{ skillId: created.id, revision: 2 }] })
      return generations.reconcile(user, project)
    }))
    assert.equal(waiting.reference, null)
    assert.equal(waiting.waiting, true)
    const current = await generations.current(project)
    assert.equal(current.payload.effective.pins[0].revision, 1)
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'generationHash' IS NULL", [user.id])).rows[0].count, 1)
  } finally { generations.identities = acquire }
})

test('leased apply waits for queued/native activity and failed new selection restores a safe baseline', options, async () => {
  const desired = await generations.reconcile(user, project)
  const current = await generations.current(project)
  let active = current.payload.lastGood
  let queued = true
  let replaced = 0
  const runtime = { runtimeGeneration: () => 'fixture-runtime', runtimePersonalSkillGeneration: () => active,
    pluginRuntimeBusy: async () => queued, replacePersonalSkillRuntime: async (_project, candidate) => { active = candidate; replaced++ },
    probePersonalSkillGeneration: async () => { throw new Error('fixture native proof failed') } }
  const worker = new PersonalSkillGenerationWorker({ service: generations, runtime, resolveProject: async () => project, ledgerBusy: async () => false })
  // Retire older superseded fixture jobs, retaining only this current apply.
  await database.query("UPDATE evimed_product.jobs SET status='succeeded' WHERE user_id=$1 AND payload->>'generationHash' IS DISTINCT FROM $2", [user.id, desired.reference.generationHash])
  await worker.tick()
  assert.equal(replaced, 0)
  queued = false
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND status='queued'", [user.id])
  await worker.tick()
  assert.equal(replaced, 2)
  assert.equal(active.reference, null)
  assert.equal((await generations.current(project)).payload.phase, 'failed')
  assert.equal((await generations.current(project)).payload.lastGood.reference.generationHash, current.payload.lastGood.reference.generationHash)
  await worker.close()
})

test('generation publication shares finite library/global storage admission and keeps the previous durable state on exhaustion', options, async () => {
  const before = await generations.current(project)
  const budget = skills.artifacts.maxGlobalBytes
  const acquire = generations.identities
  skills.artifacts.maxGlobalBytes = 1
  // Exact cached immutable bytes remain usable while no capacity is available.
  assert.equal((await generations.reconcile(user, project)).reference.generationHash, before.payload.desired.reference.generationHash)
  generations.identities = async () => ({ ...identities, adapterRevision: `sha256:${'d'.repeat(64)}` })
  try {
    await assert.rejects(plugins.withAdmission(project, () => database.transaction(() => generations.reconcile(user, project))), { code: 'extension_storage_capacity' })
    assert.equal((await generations.current(project)).revision, before.revision)
  } finally { skills.artifacts.maxGlobalBytes = budget; generations.identities = acquire }
})

test('cold recovery never requires retired identities, preserves active pins and leaves new startup unverified', options, async () => {
  const prior = await generations.current(project)
  const capturedOldPins = structuredClone(prior.payload.lastGood)
  const acquire = generations.identities
  const busy = generations.ledgerBusy
  const currentIdentity = { ...identities, baseRuntimeImageDigest: `sha256:${'e'.repeat(64)}`, adapterRevision: `sha256:${'f'.repeat(64)}` }
  generations.identities = async () => currentIdentity
  try {
    const cold = await generations.prepareForRuntime(project)
    assert.equal(cold.identity.baseRuntimeImageDigest, currentIdentity.baseRuntimeImageDigest)
    assert.equal(cold.pins[0].revision, 2)
    assert.notEqual(cold.reference.generationHash, capturedOldPins.reference.generationHash)
    assert.equal((await generations.current(project)).payload.lastGood.reference.generationHash, capturedOldPins.reference.generationHash)
    assert.equal((await parsePersonalSkill((await verifyPersonalSkillGeneration(generations.config, project, capturedOldPins.reference)).mountRoot)).instructions, 'Old instructions.')
    generations.ledgerBusy = async () => true
    assert.deepEqual((await generations.prepareForRuntime(project)).pins, [])
    // A new permission identity requiring publication must also fall back
    // safely when storage prevents preparing the optional generation.
    const budget = skills.artifacts.maxGlobalBytes
    skills.artifacts.maxGlobalBytes = 1
    generations.identities = async () => ({ ...currentIdentity, permissionProfileRevision: `sha256:${'9'.repeat(64)}` })
    try { assert.equal((await generations.prepareForRuntime(project)).reference, null) }
    finally { skills.artifacts.maxGlobalBytes = budget }
    generations.identities = async () => { throw new Error('current image is unavailable; retired image removed') }
    const unavailable = await generations.prepareForRuntime(project)
    assert.equal(unavailable.reference, null)
    const state = await generations.current(project)
    assert.equal(state.payload.desired.waiting, true)
    assert.equal(state.payload.lastGood.reference.generationHash, capturedOldPins.reference.generationHash)
  } finally { generations.identities = acquire; generations.ledgerBusy = busy }
})

test('pool1 held apply renews through replacement/probe beyond the original lease and joins its callbacks', options, async () => {
  const desired = await generations.reconcile(user, project)
  await database.query("UPDATE evimed_product.jobs SET status='succeeded' WHERE user_id=$1 AND status='queued'", [user.id])
  const scope = desired.scope
  const job = await generations.jobs.enqueue(user.id, 'personal-skill-apply', { ...scope, generationHash: desired.reference.generationHash, selectionRevision: desired.selectionRevision },
    { idempotencyKey: 'long-lease-control', projectId: project.id })
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
  let active = null
  let proofs = 0
  let renewals = 0
  const renew = generations.jobs.renew.bind(generations.jobs)
  generations.jobs.renew = (...args) => { renewals++; return renew(...args) }
  const runtime = { runtimeGeneration: () => 'fixture-runtime', runtimePersonalSkillGeneration: () => active, pluginRuntimeBusy: async () => false,
    replacePersonalSkillRuntime: async (_project, candidate) => { active = candidate; await new Promise(resolve => setTimeout(resolve, 1500)) },
    probePersonalSkillGeneration: async () => { proofs++; await new Promise(resolve => setTimeout(resolve, 500)); return { generation: 'fixture-runtime' } } }
  const worker = new PersonalSkillGenerationWorker({ service: generations, runtime, resolveProject: async () => project, ledgerBusy: async () => false, leaseMs: 1000 })
  try {
    await worker.tick(); await worker.close()
    assert.equal(proofs, 1)
    assert.ok(renewals >= 5)
    assert.equal((await generations.jobs.get(user.id, job.id)).status, 'succeeded')
    assert.equal((await generations.current(project)).payload.effective.reference.generationHash, desired.reference.generationHash)
    const settledRenewals = renewals
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(renewals, settledRenewals, 'no renewal callback remains after owned scope release')
    assert.equal(database.pool.totalCount, 1)
  } finally { await worker.close(); generations.jobs.renew = renew }
})

test('controller verifier rejects unreadable, writable and unexpected generation entries without widening private ancestors', options, async () => {
  const candidate = await generations.reconcile(user, project)
  const verified = await verifyPersonalSkillGeneration(generations.config, project, candidate.reference)
  const file = path.join(verified.mountRoot, candidate.pins[0].nativeName, 'SKILL.md')
  assert.equal((await fs.stat(file)).mode & 0o7777, 0o444)
  assert.equal((await fs.stat(verified.mountRoot)).mode & 0o7777, 0o755)
  for (const privateRoot of [verified.root, path.dirname(verified.root), path.dirname(path.dirname(verified.root))]) assert.equal((await fs.stat(privateRoot)).mode & 0o7777, 0o700)
  for (const mode of [0o400, 0o644, 0o4755]) {
    await fs.chmod(file, mode)
    await assert.rejects(verifyPersonalSkillGeneration(generations.config, project, candidate.reference), { code: 'extension_contract_invalid' })
  }
  await fs.chmod(file, 0o444)
  const extra = path.join(verified.mountRoot, 'unexpected')
  await fs.mkdir(extra, { mode: 0o755 })
  try { await assert.rejects(verifyPersonalSkillGeneration(generations.config, project, candidate.reference), { code: 'extension_contract_invalid' }) }
  finally { await fs.rmdir(extra) }
  await verifyPersonalSkillGeneration(generations.config, project, candidate.reference)
})

test('actual Linux UID1000 generation is read by UID10001 native provider only after immutable readable projection', {
  ...options, skip: options.skip || !process.env.OPEN_SCIENCE_TEST_PERSONAL_SKILL_IMAGE && 'A trusted existing local native SDK image is required.', timeout: 60000,
}, async () => {
  const image = process.env.OPEN_SCIENCE_TEST_PERSONAL_SKILL_IMAGE
  assert.match(image, /^sha256:[a-f0-9]{64}$/u)
  const docker = promisify(execFile)
  const candidate = await generations.reconcile(user, project)
  const verified = await verifyPersonalSkillGeneration(generations.config, project, candidate.reference, image)
  const suffix = randomUUID()
  const volume = `evimed-personal-reader-${suffix}`
  const writer = `evimed-personal-writer-${suffix}`
  const reader = `evimed-personal-reader-container-${suffix}`
  const nodeWriter = `const fs=require('node:fs');const root='/fixture/owner/project/generation/skills';fs.chownSync('/fixture',1000,1000);process.setgid(1000);process.setuid(1000);if(process.argv[1]==='private'){fs.mkdirSync(root,{recursive:true,mode:0o700});fs.cpSync('/source',root,{recursive:true});}function mode(p){const s=fs.lstatSync(p);fs.chmodSync(p,s.isDirectory()?(process.argv[1]==='private'?0o700:0o755):(process.argv[1]==='private'?0o400:0o444));if(s.isDirectory())for(const n of fs.readdirSync(p))mode(p+'/'+n);}mode(root);if(process.argv[1]==='private'){console.log('fixture-ready');setTimeout(()=>{},45000);}`
  const nodeReader = `const fs=require('node:fs');const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');const stat=fs.statSync('/input/'+process.argv[1]+'/SKILL.md');const info={readerUid:process.getuid(),fileUid:stat.uid,fileMode:stat.mode&4095};(async()=>{try{const r=createRequire('/opt/evimed/dsh-home-seed/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/package.json');const {parsePersonalSkill}=await import(pathToFileURL(r.resolve('@evimed/harness-port/personal-skills')).href);const skill=await parsePersonalSkill('/input',{expectedName:process.argv[1]});console.log(JSON.stringify({...info,name:skill.name,instructions:skill.instructions}));}catch{console.log(JSON.stringify({...info,failed:true}));process.exitCode=1;}})();`
  const limits = ['--pull','never','--network','none','--read-only','--pids-limit','64','--memory','256m','--cpus','0.5','--tmpfs','/tmp:size=16m,mode=1777','--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m,mode=0555','--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m,mode=0555','--security-opt','no-new-privileges']
  try {
    await docker('docker', ['volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=size=32m,mode=0755',volume], { timeout: 10000 })
    const write = async action => {
      await docker('docker', ['create',...limits,'--name',writer,'--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID',
        '--mount',`type=bind,source=${verified.mountRoot},target=/source,readonly`,'--mount',`type=volume,source=${volume},target=/fixture`,'--entrypoint','node',image,'-e',nodeWriter,action], { timeout: 15000 })
      await docker('docker',['start',writer],{timeout:15000})
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const logs = await docker('docker',['logs',writer],{timeout:1000,maxBuffer:1024*1024})
        if (logs.stdout.includes('fixture-ready')) { ready = true; break }
        await new Promise(resolve => setTimeout(resolve,20))
      }
      assert.equal(ready,true,(await docker('docker',['logs',writer],{timeout:1000,maxBuffer:32768})).stderr)
    }
    await write('private')
    await docker('docker', ['create',...limits,'--name',reader,'--cap-drop','ALL','--user','10001:10001',
      '--mount',`type=volume,source=${volume},target=/input,volume-subpath=owner/project/generation/skills,readonly`,'--entrypoint','node',image,'-e',nodeReader,candidate.pins[0].nativeName], { timeout: 15000 })
    const inspect = JSON.parse((await docker('docker',['inspect',reader])).stdout)[0]
    assert.equal(inspect.Image,image);assert.equal(inspect.Config.User,'10001:10001')
    assert.equal(inspect.HostConfig.NetworkMode,'none');assert.equal(inspect.HostConfig.ReadonlyRootfs,true)
    assert.deepEqual(inspect.HostConfig.CapDrop,['ALL']);assert.equal(inspect.HostConfig.Mounts.length,1)
    assert.equal(inspect.HostConfig.Mounts[0].Source,volume);assert.equal(inspect.HostConfig.Mounts[0].ReadOnly,true)
    assert.equal(inspect.HostConfig.Mounts[0].VolumeOptions.Subpath,'owner/project/generation/skills')
    await docker('docker',['start','--attach',reader],{timeout:15000,maxBuffer:512*1024+1024}).catch(()=>{})
    assert.notEqual(JSON.parse((await docker('docker',['inspect',reader])).stdout)[0].State.ExitCode,0,'private Linux generation modes deny the distinct UID')
    await docker('docker',['exec',writer,'node','-e',nodeWriter,'readable'],{timeout:15000,maxBuffer:1024*1024})
    const output=await docker('docker',['start','--attach',reader],{timeout:15000,maxBuffer:512*1024+1024})
    const skill=JSON.parse(output.stdout)
    assert.equal(skill.readerUid,10001);assert.equal(skill.fileUid,1000);assert.equal(skill.fileMode,0o444)
    assert.equal(skill.name,candidate.pins[0].nativeName);assert.equal(skill.instructions,'New instructions.')
    assert.equal(JSON.parse((await docker('docker',['inspect',reader])).stdout)[0].State.ExitCode,0)
  } finally {
    for(const name of [writer,reader]){
      await docker('docker',['rm','--force','--volumes',name],{timeout:15000}).catch(error=>{if(!/no such (?:container|object)/iu.test(String(error.stderr)))throw error})
      await assert.rejects(docker('docker',['inspect',name]),/no such/iu)
    }
    await docker('docker',['volume','rm',volume],{timeout:15000})
    await assert.rejects(docker('docker',['volume','inspect',volume]),/no such/iu)
  }
})

test('actual pool1 removal barrier rejects new native turns, preserves active steer, and reaches baseline after failed idle apply', options, async () => {
  const active = (await generations.current(project)).payload.effective
  const manager = new RuntimeManager({ runtimeIdleTimeoutMs: 0 })
  manager.pluginService = plugins; manager.personalSkillGenerations = generations
  manager.runtimes.set(manager.key(project), { personalSkillGeneration: active })
  let running = true
  let forwarded = 0
  manager.assertInteractiveRuntimeAvailable = () => {}
  manager.enforceProjectQuota = async () => {}
  manager.callKernel = async (_runtime, _project, method) => {
    if (method === 'session/list') return { items: [{ sessionId: 'existing-turn', running }] }
    if (method === 'session/prompt') forwarded++
    return {}
  }
  const captured = manager.runtimePersonalSkillPins(project)
  // Root's onRemoved callback performs this same transactional reconciliation
  // even though the project's selection CAS does not change.
  const onRemoved = skills.onRemoved
  skills.onRemoved = () => plugins.withAdmission(project, () => generations.reconcile(user, project))
  try { await skills.remove(user, created.id, { expectedRevision: 2 }) }
  finally { skills.onRemoved = onRemoved }
  assert.equal((await skills.projectSelections(user, project)).revision, 2)
  const removed = await generations.current(project)
  assert.deepEqual(removed.payload.desired.pins, [])
  assert.deepEqual(manager.runtimePersonalSkillPins(project), captured)
  await assert.rejects(manager.dispatchPrompt(project, 'new-turn', { text: `/${created.payload.nativeName}`, mode: 'queue' }), error => error.definitivelyRejected === true)
  assert.equal(forwarded, 0)
  assert.equal(await plugins.hasPendingPrompts(project), false)
  await manager.dispatchPrompt(project, 'existing-turn', { text: 'Keep working on the captured method.', mode: 'steer' })
  assert.equal(forwarded, 1)
  running = false
  await assert.rejects(manager.dispatchPrompt(project, 'existing-turn', { text: 'New steering cannot revive an idle turn.', mode: 'steer' }), error => error.definitivelyRejected === true)
  await assert.rejects(generations.requireInvocation(project, created.id, 2), { status: 404 })
  let actual = active
  let busy = true
  let replacements = 0
  const workerRuntime = { runtimeGeneration: () => 'fixture-runtime', runtimePersonalSkillGeneration: () => actual,
    pluginRuntimeBusy: async () => busy, replacePersonalSkillRuntime: async (_project, candidate) => { actual = candidate; replacements++ },
    probePersonalSkillGeneration: async () => { throw new Error('removed generation probe failure fixture') } }
  const worker = new PersonalSkillGenerationWorker({ service: generations, runtime: workerRuntime, resolveProject: async () => project, ledgerBusy: async () => false })
  await database.query("UPDATE evimed_product.jobs SET status='succeeded' WHERE user_id=$1 AND payload->>'generationHash' IS DISTINCT FROM $2", [user.id, removed.payload.desired.reference.generationHash])
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND status='queued'", [user.id])
  try {
    await worker.tick(); assert.equal(replacements, 0)
    busy = false
    await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND status='queued'", [user.id])
    await worker.tick()
    assert.equal(actual.reference, null)
    assert.deepEqual(actual.pins, [])
    manager.runtimes.get(manager.key(project)).personalSkillGeneration = actual
    await manager.dispatchPrompt(project, 'ordinary-research', { text: 'Research without the removed optional method.', mode: 'queue' })
    assert.equal(forwarded, 2)
    assert.equal(await plugins.hasPendingPrompts(project), false)
    assert.equal((await generations.prepareForRuntime(project)).pins.length, 0, 'cold recovery cannot resurrect removed lastGood')
  } finally { await worker.close() }
})

test('personal publication counts the fixed extension-generations companion and refuses unsafe companion paths', options, async () => {
  const companion = path.join(root, '.openscience', 'extension-generations')
  const extra = await skills.create(user, { expectedRevision: 0, title: 'Companion control', description: 'Fixture', instructions: 'Fixture instructions.' })
  await skills.saveProjectSelections(user, project, { expectedRevision: 2, skills: [{ skillId: extra.id, revision: 1 }] })
  await fs.mkdir(companion, { mode: 0o700 })
  await fs.writeFile(path.join(companion, 'bounded-fixture'), Buffer.alloc(2 * 1024 * 1024), { mode: 0o400 })
  const budget = skills.artifacts.maxGlobalBytes
  skills.artifacts.maxGlobalBytes = 1024 * 1024
  try { await assert.rejects(generations.reconcile(user, project), { code: 'extension_storage_capacity' }) }
  finally { skills.artifacts.maxGlobalBytes = budget; await fs.rm(companion, { recursive: true, force: true }) }
  await fs.symlink(skills.artifacts.root, companion)
  try { await assert.rejects(generations.reconcile(user, project), { code: 'path_forbidden' }) }
  finally { await fs.unlink(companion) }
  const previousMask = process.umask(0o077)
  try {
    const candidate = await generations.reconcile(user, project)
    const verified = await verifyPersonalSkillGeneration(generations.config, project, candidate.reference)
    assert.equal((await fs.stat(path.join(verified.mountRoot, candidate.pins[0].nativeName, 'SKILL.md'))).mode & 0o7777, 0o444)
  } finally { process.umask(previousMask) }
})

test('failed restoration of a still-permitted retired generation performs one bounded baseline recovery', options, async () => {
  const desired = await generations.reconcile(user, project)
  await database.query("UPDATE evimed_product.jobs SET status='succeeded' WHERE user_id=$1 AND status='queued'", [user.id])
  const job = await generations.jobs.enqueue(user.id, 'personal-skill-apply', { ...desired.scope, generationHash: desired.reference.generationHash, selectionRevision: desired.selectionRevision },
    { idempotencyKey: 'retired-restore-control', projectId: project.id })
  await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
  const retired = { ...desired, reference: { ...desired.reference, generationHash: 'f'.repeat(64) } }
  let active = retired
  const starts = []
  const runtime = { runtimeGeneration: () => 'fixture-runtime', runtimePersonalSkillGeneration: () => active, pluginRuntimeBusy: async () => false,
    replacePersonalSkillRuntime: async (_project, candidate) => {
      starts.push(candidate.reference?.generationHash ?? null)
      if (candidate === retired) throw new Error('fixture retired image is absent')
      active = candidate
    }, probePersonalSkillGeneration: async () => { throw new Error('fixture candidate proof failed') } }
  const worker = new PersonalSkillGenerationWorker({ service: generations, runtime, resolveProject: async () => project, ledgerBusy: async () => false })
  try {
    await worker.tick()
    assert.deepEqual(starts, [desired.reference.generationHash, retired.reference.generationHash, null])
    assert.equal(active.reference, null)
    assert.equal((await generations.jobs.get(user.id, job.id)).status, 'succeeded')
    assert.equal((await generations.current(project)).payload.effective, null)
  } finally { await worker.close() }
})
