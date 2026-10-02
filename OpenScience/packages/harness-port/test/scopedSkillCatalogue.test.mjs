import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createScopedSkillCatalogue } from '../src/scopedSkillCatalogue.mjs'

/** Real native registry/provider with public scope primitives; synthetic agent identity is a code control, not serving qualification.
 * @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await fs.mkdtemp('/private/tmp/evimed-scoped-skills-'), builtin = path.join(root, 'builtin'), community = path.join(root, 'community')
  for (const [directory, name, policy] of [[builtin, 'builtin-review', 'user-invocable: false\n'], [community, 'community-review', '']]) {
    await fs.mkdir(path.join(directory, name), { recursive: true })
    await fs.writeFile(path.join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Native evidence review\n${policy}metadata:\n  title: 真实模板\n---\n\nUse [resource](资料/证据.csv).`)
    await fs.mkdir(path.join(directory, name, '资料')); await fs.writeFile(path.join(directory, name, '资料/证据.csv'), '来源,结果\n真实,1\n')
  }
  const ctx = new Context(); new SkillRegistry(ctx)
  const agent = { id: 'scoped-session', session: { header: { id: 'scoped-session', cwd: '/unused-workspace' } } }, outsider = { id: 'other-session', session: { header: { id: 'other-session', cwd: '/unused-workspace' } } }
  const scope = createScope(ctx, agent)
  for (const directory of [builtin, community]) scope.ctx.skills.registerProvider(control => new FileSystemSkillProvider(scope.ctx, control, { providerName: 'filesystem-' + path.basename(directory), customSkillDirs: [directory], includeDefaultRoots: false, watch: false }))
  // One standard filesystem provider owns both roots, as in the actual standing preset.
  await scope.dispose();const standard = createScope(ctx, agent)
  standard.ctx.skills.registerProvider(control => new FileSystemSkillProvider(standard.ctx, control, { providerName: 'filesystem', customSkillDirs: [builtin, community], includeDefaultRoots: false, watch: false }))
  ctx.agents = /** @type {any} */ ({ get: (/** @type {string} */ id) => id === agent.id ? agent : id === outsider.id ? outsider : undefined })
  t.after(async () => { await standard.dispose(); await ctx.fiber.dispose(); await fs.rm(root, { recursive: true, force: true }) })
  return { ctx, root, builtin, community, agent, api: createScopedSkillCatalogue(ctx, { roots: [{ root: builtin, source: 'builtin', duplicate: true }, { root: community, source: 'community', duplicate: true }] }) }
}

test('public scoped native list/get includes model-only skills and winning resources without a second registry', async t => {
  const f = await fixture(t), catalogue = await f.api.list({ sessionId: f.agent.id })
  assert.equal(catalogue.complete, true); assert.deepEqual(catalogue.items.map(item => item.name), ['builtin-review', 'community-review'])
  assert.equal(catalogue.items[0].invocation.userInvocable, false)
  const snapshot = await f.api.snapshotBuiltin({ sessionId: f.agent.id, key: catalogue.items[0].key })
  assert.equal(snapshot.instructions, 'Use [resource](资料/证据.csv).'); assert.equal(snapshot.metadata.title, '真实模板')
  assert(snapshot.entries)
  assert.equal(Buffer.from(snapshot.entries.find(item => item.path === '资料/证据.csv').bytesBase64, 'base64').toString(), '来源,结果\n真实,1\n')
  assert.equal(Object.hasOwn(snapshot, 'resourceBase'), false); assert.equal(Object.hasOwn(snapshot, 'provider'), false)
  assert.equal((await f.api.list({ sessionId: 'other-session' })).items.length, 0)
  await assert.rejects(f.api.list({ sessionId: 'foreign-session' }))
})

test('resource snapshots reject links, protected names and physical Unicode aliases without hiding entries', async t => {
  const f = await fixture(t), name = path.join(f.builtin, 'builtin-review'), catalogue = await f.api.list({ sessionId: f.agent.id }), request = { sessionId: f.agent.id, key: catalogue.items[0].key }
  await fs.symlink('SKILL.md', path.join(name, 'linked.md')); await assert.rejects(f.api.snapshotBuiltin(request)); await fs.unlink(path.join(name, 'linked.md'))
  if (process.platform === 'linux') {
    await fs.writeFile(path.join(name, '资料/café.csv'), 'identical'); await fs.writeFile(path.join(name, '资料/cafe\u0301.csv'), 'identical'); assert.equal((await fs.readdir(path.join(name,'资料'))).length,3); await assert.rejects(f.api.snapshotBuiltin(request))
    await fs.unlink(path.join(name, '资料/cafe\u0301.csv')); await fs.unlink(path.join(name, '资料/café.csv'))
  }
  await fs.writeFile(path.join(name, '.env'), 'fixture-only'); await assert.rejects(f.api.snapshotBuiltin(request))
})

test('personal detail reads actual bounded resources/scripts without allowing byte export or duplication',async t=>{
  const f=await fixture(t),api=createScopedSkillCatalogue(f.ctx,{roots:[{root:f.builtin,source:'personal',duplicate:false},{root:f.community,source:'community',duplicate:true}]});
  await fs.mkdir(path.join(f.builtin,'builtin-review','scripts'));await fs.writeFile(path.join(f.builtin,'builtin-review','scripts/check.py'),"raise RuntimeError('inert')\n");
  const listed=await api.list({sessionId:f.agent.id}),selected=listed.items.find(item=>item.name==='builtin-review');assert(selected);const request={sessionId:f.agent.id,key:selected.key};
  const detail=await api.read(request);assert.equal(detail.source,'personal');assert.equal(detail.canDuplicate,false);assert(detail.resources.some(item=>item.path==='资料/证据.csv'));assert.deepEqual(detail.scripts,[{path:'scripts/check.py',size:Buffer.byteLength("raise RuntimeError('inert')\n")}]);assert.equal(Object.hasOwn(detail,'entries'),false);await assert.rejects(api.snapshotBuiltin(request));
});
