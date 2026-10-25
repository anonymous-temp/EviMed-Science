import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { parsePersonalSkill } from '@evimed/harness-port/personal-skills'
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs'
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs'
import { SkillLibraryService } from '../src/skillLibraryService.mjs'
import { SkillLibraryArtifacts } from '../src/skillLibraryArtifacts.mjs'
import { createPlatformSkillCatalogue } from '../src/platformSkillCatalogue.mjs'
import { PluginService } from '../src/pluginService.mjs'
import { PersonalSkillGenerationService } from '../src/personalSkillGenerationService.mjs'
import { RuntimeManager } from '../src/runtimeManager.mjs'
import { personalSkillRuntimeIdentity } from '../src/personalSkillRuntimeIdentity.mjs'
import { AgentBayRuntimeProvider, renderKernelEnvironment } from '../src/agentbay/runtimeProvider.mjs'

test('AgentBay carries an owned native personal revision and binary resources into its immutable projection and launcher environment', {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'A local PostgreSQL fixture is required.',
}, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'abskills')
  const db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000 })
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentbay-skills-')))
  t.after(async () => { await db.close(); await isolated.drop(); await fs.rm(root, { recursive: true, force: true }) })
  await db.migrate()
  const user = { id: 'ab-owner' }, project = { id: 'paper', userId: user.id, rootDir: path.join(root, 'project'), runtimeDir: path.join(root, 'runtime'), workspaceDir: path.join(root, 'project/workspace') }
  await fs.mkdir(project.workspaceDir, { recursive: true })
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'AgentBay fixture','development')", [user.id])
  await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'AgentBay fixture',1048576)", [user.id, project.id])
  const config = { dataDir: root, runtimeProvider: 'agentbay', agentbayImageId: 'imgc-exact-build', runtimeGatewayPublicUrl: 'https://fixture.example/runtime-gateway' }
  const manager = new RuntimeManager(config, { agentbayClient: {} })
  const artifacts = new SkillLibraryArtifacts({ root: path.join(root, 'library'), parseSkill: parsePersonalSkill, minFreeBytes: 0 })
  await fs.mkdir(artifacts.root)
  const skills = new SkillLibraryService(db, { artifacts, projectAccess: async (actor, selected) => { assert.equal(actor.id, selected.userId) },
    platformCatalogue: createPlatformSkillCatalogue({ rootDir: new URL('../../..', import.meta.url).pathname }) })
  const binary = Buffer.from([0, 255, 1, 13, 10, 128, 65]), hex = createHash('sha256').update(binary).digest('hex')
  await artifacts.publish(user, `blobs/${hex}`, binary)
  const skill = await skills.saveContent(user, `skill:${randomUUID()}`, { expectedRevision: 0, title: 'Native method', description: 'Read the preserved bytes', instructions: 'Read resources/input.bin.' },
    [{ id: `resource:${hex}`, path: 'resources/input.bin', digest: `sha256:${hex}`, size: binary.length }])
  const selected = await skills.saveProjectSelections(user, project, { expectedRevision: 0, skills: [{ skillId: skill.id, revision: 1 }] })
  const disabled = await skills.saveProjectPlatform(user, project, { expectedRevision: selected.revision, disabled: ['curated:matplotlib'] })
  await skills.saveProjectBuiltins(user, project, { expectedRevision: disabled.revision, disabled: ['annotation', 'mermaid'] })
  const plugins = new PluginService(db), generations = new PersonalSkillGenerationService(db, { config, skillService: skills, pluginService: plugins,
    resolveUser: async () => user, identities: () => personalSkillRuntimeIdentity(manager), ledgerBusy: async () => false })
  const candidate = await plugins.withAdmission(project, () => generations.reconcile(user, project))
  assert.equal(candidate.pins[0].digest, skill.payload.digest)
  assert.deepEqual(candidate.platformSkills, { disabled: ['curated:matplotlib'], disabledPlugins: ['annotation', 'mermaid'] })
  let record
  const provider = new AgentBayRuntimeProvider(manager, { client: /** @type {any} */ ({ createSession: async () => ({ sessionId: 'isolated-session', session: {} }) }) })
  provider.assertConfigured = () => new URL(config.runtimeGatewayPublicUrl)
  provider.readRecord = async () => null; provider.releaseStrays = async () => {}; provider.ensureContexts = async () => ({}); provider.contextSyncFor = () => []; provider.pushProject = async () => {}
  provider.writeRecord = async (_project, value) => { record = value }
  const plan = await provider.prepare(project, { port: 0, pluginConfig: { revision: 0, enabled: true, settings: { timeoutMs: 15000 } }, capsuleMethodsMounted: 0, personalSkillGeneration: candidate })
  assert.equal(record.personalGenerationHash, candidate.reference.generationHash)
  assert.equal(plan.personalSkillGeneration.reference.generationHash, candidate.reference.generationHash)
  const remote = path.join(root, 'guest'), commands = [], shell = promisify(execFile)
  const map = value => value.replaceAll('/opt/evimed', `${remote}/opt`).replaceAll('/run/evimed', `${remote}/run`)
  provider.writeSessionFile = async (_session, file, value) => { assert.ok(file.startsWith('/run/evimed/uploads/')); const target = map(file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value) }
  provider.command = async (_session, line) => {
    commands.push(line)
    // The SDK transport alone is replaced. Run the real byte decoder, chmod and digest commands in an isolated host directory.
    const translated = map(line).replaceAll('-o root -g root ', '').replaceAll('chown 0:0', 'true').replaceAll('sha256sum ', 'shasum -a 256 ')
      .replaceAll('base64 -d ', process.platform === 'darwin' ? 'base64 -d -i ' : 'base64 -d ')
    const result = await shell('/bin/sh', ['-c', translated])
    return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  }
  await provider.syncPersonalGeneration(project, plan)
  const preserved = map(`${plan.personalSkillsRuntimeDir}/${skill.payload.nativeName}/resources/input.bin`)
  assert.deepEqual(await fs.readFile(preserved), binary)
  assert.equal((await fs.stat(preserved)).mode & 0o777, 0o444)
  assert.ok(commands.some(line => line.includes('chown 0:0') && line.includes('sha256sum')))
  assert.ok(commands.every(line => !line.includes('/workspace/')))
  const env = provider.kernelEnvironment(project, plan)
  assert.deepEqual(JSON.parse(env.EVIMED_DISABLED_PLATFORM_SKILLS), ['curated:matplotlib'])
  assert.deepEqual(JSON.parse(env.EVIMED_DISABLED_CLIENT_BUNDLES), ['annotation', 'mermaid'])
  assert.equal(env.EVIMED_PERSONAL_SKILLS_DIR, plan.personalSkillsRuntimeDir)
  const readback = await shell('/bin/sh', ['-c', renderKernelEnvironment(env) + '\nprintf "%s" "$EVIMED_DISABLED_PLATFORM_SKILLS"'])
  assert.deepEqual(JSON.parse(readback.stdout), ['curated:matplotlib'])
})
