import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { canonicalJson } from '@evimed/domain'
import { createSkillValidationController, skillValidationRoot } from '../src/skillValidationController.mjs'
import { RuntimeControllerClient } from '../src/runtimeControllerClient.mjs'
import { createRuntimeController } from '../src/runtimeControllerServer.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const nativeName = `personal-${'b'.repeat(16)}-${'c'.repeat(32)}`
const selectedImage = process.env.EVIMED_SKILL_VALIDATION_TEST_IMAGE

/** An existing local fixture contains the actual pinned provider and this fixed helper.
 * These are Docker/native-parser tests, not research-kernel or SaaS qualification.
 * @param {import('node:test').TestContext} t */
async function fixture(t) {
  if (!selectedImage) { t.skip('Set EVIMED_SKILL_VALIDATION_TEST_IMAGE to an existing offline native SDK fixture.'); return null }
  const image = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', selectedImage], { encoding: 'utf8', timeout: 5000 })
  assert.equal(image.status, 0, 'the explicit test image must already exist; tests never pull it')
  const base = process.env.EVIMED_SKILL_VALIDATION_TEST_DATA
  assert.ok(base && path.isAbsolute(base), 'Docker fixture data needs an explicit daemon-shared private test directory')
  await fs.mkdir(base, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'native-validation-')))
  const config = { dataDir: root, runtimeContainerBin: 'docker', runtimeContainerImage: image.stdout.trim(),
    runtimeContainerUser: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` }
  const reference = { ownerHash: sha('native-fixture-owner'), kind: 'imports', contentId: sha('native-fixture-skill'), expectedName: null }
  const directory = skillValidationRoot(config, reference)
  await fs.mkdir(path.join(directory, 'bundle'), { recursive: true, mode: 0o700 })
  const file = path.join(directory, 'bundle/SKILL.md')
  await fs.writeFile(file, '---\nname: imported-review\ndescription: Evidence review\nuser-invocable: true\ndisable-model-invocation: true\nmetadata:\n  title: 我的审稿方法\n---\n# Review\nRead preserved evidence.\n', { mode: 0o400 })
  const controller = createSkillValidationController(config, { availableMemory: async () => 2 * 1024 ** 3 })
  t.after(async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { config, controller, reference, directory, file, imageId: image.stdout.trim() }
}

test('actual isolated Docker native provider returns content and invocation with no host locator', async t => {
  const source = await fixture(t)
  if (!source) return
  const { controller, reference, directory } = source
  await fs.mkdir(path.join(directory, 'bundle', 'scripts'))
  await fs.writeFile(path.join(directory, 'bundle', 'scripts', 'inert.mjs'), 'throw new Error("must never execute")\n', { mode: 0o400 })
  const result = await controller.validate(reference)
  assert.deepEqual(result, { name: 'imported-review', description: 'Evidence review', instructions: '# Review\nRead preserved evidence.',
    invocation: { userInvocable: true, modelInvocable: false }, metadata: { title: '我的审稿方法' } })
  const remaining = spawnSync('docker', ['inspect', 'evimed-skill-validation'], { encoding: 'utf8', timeout: 5000 })
  assert.notEqual(remaining.status, 0, 'completion must have removed the actual physical slot')
})

test('actual pinned parser rejects malformed native YAML without exposing imported text', async t => {
  const source = await fixture(t)
  if (!source) return
  await fs.chmod(source.file, 0o600)
  await fs.writeFile(source.file, '---\nname: [secret-native-diagnostic\ndescription: review\n---\nbody')
  await fs.chmod(source.file, 0o400)
  await assert.rejects(source.controller.validate(source.reference), error => {
    assert.equal(error.code, 'extension_contract_invalid')
    assert.ok(!error.message.includes('secret-native-diagnostic'))
    return true
  })
})

test('actual immutable package identity selects the expected personal native namespace', async t => {
  const source = await fixture(t)
  if (!source) return
  const file = `---\nname: ${nativeName}\ndescription: Personal review\n---\nReview preserved evidence.`
  const resources = []
  const contentId = sha(canonicalJson({ file, resources }))
  const reference = { ...source.reference, kind: 'packages', contentId, expectedName: nativeName }
  const directory = skillValidationRoot(source.config, reference)
  await fs.mkdir(path.join(directory, nativeName), { recursive: true })
  await fs.writeFile(path.join(directory, nativeName, 'SKILL.md'), file, { mode: 0o400 })
  await fs.writeFile(path.join(directory, 'manifest.json'), `${canonicalJson({ schemaVersion: 1, nativeName, digest: `sha256:${contentId}`, resources })}\n`, { mode: 0o400 })
  assert.equal((await source.controller.validate(reference)).name, nativeName)
  await fs.chmod(path.join(directory, nativeName, 'SKILL.md'), 0o600)
  await fs.writeFile(path.join(directory, nativeName, 'SKILL.md'), `${file}\nchanged`)
  await assert.rejects(source.controller.validate(reference))
})

test('actual Docker deadline removes its labeled container before rejection', async t => {
  const source = await fixture(t)
  if (!source) return
  const controller = createSkillValidationController(source.config, { availableMemory: async () => 2 * 1024 ** 3,
    setTimer: callback => setTimeout(callback, 1) })
  t.after(() => controller.close())
  await assert.rejects(controller.validate(source.reference), error => {
    assert.equal(error.status, 504)
    return true
  })
  assert.notEqual(spawnSync('docker', ['inspect', 'evimed-skill-validation'], { timeout: 5000 }).status, 0)
})

test('near-limit native JSON survives the actual Unix client data envelope without cancellation', async t => {
  const source = await fixture(t)
  if (!source) return
  const expected = { name: 'boundary-skill', description: 'Boundary', instructions: '',
    invocation: { modelInvocable: true, userInvocable: true }, metadata: {} }
  const targetBytes = 512 * 1024 - 1
  const remaining = targetBytes - Buffer.byteLength(JSON.stringify(expected))
  expected.instructions = '\\'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2)
  const skill = `---\nname: ${expected.name}\ndescription: ${expected.description}\n---\n${expected.instructions}`
  assert.ok(Buffer.byteLength(skill) <= 262144 + 4096)
  assert.ok(Buffer.byteLength(expected.instructions) <= 262144)
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), targetBytes)
  assert.ok(Buffer.byteLength(JSON.stringify({ data: expected })) > 512 * 1024, 'must exercise framing beyond the old client limit')
  await fs.chmod(source.file, 0o600)
  await fs.writeFile(source.file, skill)
  await fs.chmod(source.file, 0o400)
  // Daemon-shared fixture data may have a long workspace path; Unix sockets
  // use a separate short, private directory within the platform path limit.
  const socketRoot = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'sv-boundary-'))
  const socket = path.join(socketRoot, 'controller.sock')
  const server = createRuntimeController({ ...source.config, runtimeControllerSocket: socket, production: false },
    { skillValidation: { availableMemory: async () => 2 * 1024 ** 3 } })
  t.after(async () => { await server.close(); await fs.rm(socketRoot, { recursive: true, force: true }) })
  await server.listen()
  const client = new RuntimeControllerClient({ ...source.config, runtimeControllerSocket: socket })
  const result = await client.validatePersonalSkill(source.reference)
  assert.deepEqual(result, expected)
  assert.equal(Buffer.byteLength(JSON.stringify(result)), targetBytes)
  const cancellationDirectory = path.join(source.config.dataDir, '.openscience', 'skill-validation-state', 'canceled')
  assert.deepEqual(await fs.readdir(cancellationDirectory).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  }), [], 'successful bounded output must not create a cancellation tombstone')
  assert.notEqual(spawnSync('docker', ['inspect', 'evimed-skill-validation'], { timeout: 5000 }).status, 0)
})
