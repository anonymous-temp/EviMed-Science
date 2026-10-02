import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink, link, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { parsePersonalSkill, createPersonalSkillProvider } from '../src/personalSkills.mjs'

/** @param {import('node:test').TestContext} t @param {string} content */
async function fixture(t, content) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'evimed-personal-sdk-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'bundle'))
  await writeFile(path.join(root, 'bundle', 'SKILL.md'), content)
  return root
}

test('real pinned provider parses YAML, invocation and metadata without discovering default roots', async t => {
  const root = await fixture(t, '---\nname: personal-alice-review\ndescription: "Review: evidence"\nuser-invocable: true\ndisable-model-invocation: true\nmetadata:\n  title: 我的审稿方法\n---\n\n# Review\nUse preserved sources.\n')
  const parsed = await parsePersonalSkill(root, { expectedName: 'personal-alice-review' })
  assert.equal(parsed.name, 'personal-alice-review')
  assert.equal(parsed.description, 'Review: evidence')
  assert.equal(parsed.metadata.title, '我的审稿方法')
  assert.equal(parsed.instructions, '# Review\nUse preserved sources.')
  assert.equal(parsed.resourceBase?.kind, 'directory')
  assert.deepEqual(parsed.invocation, { userInvocable: true, modelInvocable: false })
})

test('real native parser rejects malformed YAML, invalid policy and unnamed skill', async t => {
  for (const body of ['---\nname: [broken\ndescription: text\n---\nbody', '---\nname: personal-test\ndescription: text\nuser-invocable: wrong\n---\nbody', '# no frontmatter']) {
    await assert.rejects(parsePersonalSkill(await fixture(t, body)), /personal_skill_bundle_invalid/u)
  }
})

test('native discovery must identify one exact skill and cannot shadow the trusted name', async t => {
  const root = await fixture(t, '---\nname: personal-review\ndescription: review\n---\nbody')
  await assert.rejects(parsePersonalSkill(root, { expectedName: 'personal-other' }), /personal_skill_identity_invalid/u)
  await writeFile(path.join(root, 'other.md'), '---\nname: personal-other\ndescription: other\n---\nbody')
  await assert.rejects(parsePersonalSkill(root), /personal_skill_bundle_invalid/u)
})

test('all resources reject symbolic links and hard links before native discovery', async t => {
  const root = await fixture(t, '---\nname: personal-review\ndescription: review\n---\nbody')
  const target = path.join(root, 'bundle', 'SKILL.md')
  const resource = path.join(root, 'bundle', 'resource')
  await symlink(target, resource)
  await assert.rejects(parsePersonalSkill(root), /personal_skill_resource_type/u)
  await rm(resource)
  await link(target, resource)
  await assert.rejects(parsePersonalSkill(root), /personal_skill_resource_type/u)
})

test('pre-aborted parsing never returns a native skill', async t => {
  const root = await fixture(t, '---\nname: personal-review\ndescription: review\n---\nbody')
  await assert.rejects(parsePersonalSkill(root, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('actual native registry loads only selected roots and unregisters their catalog', async t => {
  const root = await fixture(t, '---\nname: personal-selected\ndescription: selected\n---\nselected body')
  const ctx = new Context()
  new SkillRegistry(ctx)
  t.after(() => ctx.fiber.dispose())
  const unregister = await createPersonalSkillProvider(ctx, { roots: [root] })
  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['personal-selected'])
  assert.equal((await ctx.skills.get('personal-selected'))?.content, 'selected body')
  unregister()
  assert.deepEqual(await ctx.skills.list(), [])
})

test('real native bundle wrapper preserves sixteen resource segments but rejects seventeen', async t => {
  const root=await fixture(t,'---\nname: personal-depth\ndescription: Bound resource depth\n---\nbody')
  const resource=Array.from({length:15},()=> '资料').join('/')+'/证据.csv'
  await mkdir(path.dirname(path.join(root,'bundle',resource)),{recursive:true})
  await writeFile(path.join(root,'bundle',resource),'字段,值\n证据,1\n')
  assert.equal((await parsePersonalSkill(root)).name,'personal-depth')
  await mkdir(path.join(root,'bundle',path.dirname(resource),'更深'),{recursive:true})
  await writeFile(path.join(root,'bundle',path.dirname(resource),'更深','证据.csv'),'reject')
  await assert.rejects(parsePersonalSkill(root),/personal_skill_resource_limit/u)
})
