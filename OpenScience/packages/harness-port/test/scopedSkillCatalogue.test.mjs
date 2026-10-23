import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createScopedSkillCatalogue, registerScopedSkillCatalogue, SCOPED_SKILL_ROOTS } from '../src/scopedSkillCatalogue.mjs'

/** Real native registry/provider with public scope primitives; synthetic agent identity is a code control, not serving qualification.
 * @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'evimed-scoped-skills-'))), builtin = path.join(root, 'builtin'), community = path.join(root, 'community')
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

test('the private method pack is a known built-in root: its skills read with a real source, and are never copied',async t=>{
  // The production roots name the pack's own `skills/` folder (the preset lists it one level below geo-private).
  const pack=SCOPED_SKILL_ROOTS.find(item=>item.root.endsWith('/geo-private/skills'));
  assert.ok(pack);assert.deepEqual({source:pack.source,duplicate:pack.duplicate},{source:'builtin',duplicate:false});
  const f=await fixture(t),api=createScopedSkillCatalogue(f.ctx,{roots:[{root:f.builtin,source:pack.source,duplicate:pack.duplicate},{root:f.community,source:'community',duplicate:true}]});
  const listed=await api.list({sessionId:f.agent.id}),selected=listed.items.find(item=>item.name==='builtin-review');assert(selected);
  assert.equal(selected.source,'builtin');assert.equal(selected.canDuplicate,false);
  const request={sessionId:f.agent.id,key:selected.key},detail=await api.read(request);
  assert.equal(detail.source,'builtin');assert.equal(detail.canDuplicate,false);assert(detail.instructions.includes('resource'));
  await assert.rejects(api.snapshotBuiltin(request));
  // A root the catalogue does not know stays 'unknown' and its preview is refused: the failure this row exists to remove.
  const unknown=createScopedSkillCatalogue(f.ctx,{roots:[{root:f.community,source:'community',duplicate:true}]});
  const strange=(await unknown.list({sessionId:f.agent.id})).items.find(item=>item.name==='builtin-review');assert.ok(strange);assert.equal(strange.source,'unknown');
  await assert.rejects(unknown.read({sessionId:f.agent.id,key:strange.key}));
});

// SRC Remote binding uses prototype parameter names as named wire fields.
// Internal request-object API tests cannot exercise this boundary.
test('registered catalogue exposes caller wire fields and separate cancellation', async t => {
  const f = await fixture(t), service = await registerScopedSkillCatalogue(f.ctx)
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
  assert.deepEqual(remoteMethods(service).map(item => item.method), ['list', 'read', 'snapshotBuiltin'])
  const expected = { list: ['sessionId', 'signal'], read: ['sessionId', 'key', 'signal'], snapshotBuiltin: ['sessionId', 'key', 'signal'] }
  for (const [method, names] of Object.entries(expected)) {
    const source = Function.prototype.toString.call(Object.getPrototypeOf(service)[method])
    assert.deepEqual(source.slice(source.indexOf('(') + 1, source.indexOf(')')).split(',').map(value => value.trim()), names)
  }
  const listed = await service.list(f.agent.id)
  assert.equal(listed.complete, true)
  // Fixture roots are unknown to the production service, so detail fails closed.
  await assert.rejects(service.read(f.agent.id, listed.items[0].key), /skill_catalogue_unavailable/)
  await assert.rejects(service.snapshotBuiltin(f.agent.id, listed.items[0].key), /skill_catalogue_unavailable/)
})

// Supply a qualified seed's profile/node_modules directory; no kernel binary or provider is started.
test('pinned gateway dispatch accepts flat catalogue arguments', { skip: !process.env.EVIMED_TEST_SEED_MODULES }, async t => {
  const { createRequire } = await import('node:module')
  const seedModules = process.env.EVIMED_TEST_SEED_MODULES
  assert.ok(seedModules)
  const requireSeed = createRequire(path.join(seedModules, '../package.json'))
  const { TypertRegistry } = await import(requireSeed.resolve('@deepseek-ai/dsh-typert-registry'))
  const { TypertGatewayService } = await import(requireSeed.resolve('@deepseek-ai/dsh-api-gateway'))
  const f = await fixture(t)
  new TypertRegistry(f.ctx)
  const gateway = new TypertGatewayService(f.ctx, {})
  await registerScopedSkillCatalogue(f.ctx, { roots: [{ root: f.builtin, source: 'builtin', duplicate: true }, { root: f.community, source: 'community', duplicate: true }] })
  const peer = { principal: { kind: 'owner' }, signal: new globalThis.AbortController().signal }
  const call = (/** @type {string} */ method, /** @type {any} */ args) => gateway.invoke({ namespace: 'evimedSkills', method, args, peer })
  assert.deepEqual(gateway.resolveDescriptor('evimedSkills', 'list', 'evimedSkills/list').parameters.map((/** @type {any} */ item) => item.wire), ['sessionId'])
  const listed = await call('list', { sessionId: f.agent.id })
  assert.equal(listed.complete, true)
  for (const method of ['read', 'snapshotBuiltin']) {
    const descriptor = gateway.resolveDescriptor('evimedSkills', method, 'evimedSkills/' + method)
    assert.deepEqual(descriptor.parameters.map((/** @type {any} */ item) => item.wire), ['sessionId', 'key'])
    const detail = await call(method, { sessionId: f.agent.id, key: listed.items[0].key })
    assert.equal(detail.instructions, 'Use [resource](资料/证据.csv).')
    if (method === 'snapshotBuiltin') assert.ok(detail.entries.some((/** @type {any} */ item) => item.path === 'SKILL.md'))
  }
  const snapshot = f.ctx.skills.snapshot.bind(f.ctx.skills)
  const controller = new globalThis.AbortController()
  let observedCancellation = false
  f.ctx.skills.snapshot = async lookup => {
    assert.ok(lookup?.signal)
    controller.abort()
    observedCancellation = lookup.signal.aborted
    return snapshot(lookup)
  }
  await assert.rejects(gateway.invoke({ namespace: 'evimedSkills', method: 'list', args: { sessionId: f.agent.id }, peer, signal: controller.signal }))
  assert.equal(observedCancellation, true)
  f.ctx.skills.snapshot = snapshot
  const stopped = AbortSignal.abort()
  await assert.rejects(gateway.invoke({ namespace: 'evimedSkills', method: 'list', args: { sessionId: f.agent.id }, peer: { ...peer, signal: stopped } }), error => error instanceof Error && Reflect.get(error, 'code') === 'gateway/peer-disposed')
  await assert.rejects(call('list', { request: { sessionId: f.agent.id } }), error => error instanceof Error && Reflect.get(error, 'code') === 'gateway/arguments-invalid')
})
