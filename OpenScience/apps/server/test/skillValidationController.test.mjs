import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalJson } from '@evimed/domain'
import { RuntimeControllerClient, RUNTIME_CONTROLLER_PROTOCOL_VERSION } from '../src/runtimeControllerClient.mjs'
import { createRuntimeController } from '../src/runtimeControllerServer.mjs'
import { createSkillValidationController, skillValidationRoot, skillValidationPlan, validateSkillReference } from '../src/skillValidationController.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const imageId = `sha256:${'a'.repeat(64)}`
const nativeName = `personal-${'b'.repeat(16)}-${'c'.repeat(32)}`
const output = { name: 'imported-review', description: 'Review the evidence', instructions: '# Review\nUse evidence.',
  invocation: { userInvocable: true, modelInvocable: true }, metadata: { title: 'Review' } }
const pause = () => new Promise(resolve => setTimeout(resolve, 15))

/** Lifecycle tests use a real owned child process and a fake Docker inventory;
 * only the separate Docker integration tests establish native parsing/containment.
 * @param {import('node:test').TestContext} t @param {any} hooks */
async function fixture(t, hooks = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skill-controller-')))
  const state = path.join(root, 'docker-state.json')
  const mode = path.join(root, 'mode')
  const started = path.join(root, 'started')
  const captured = path.join(root, 'created-args.json')
  const binary = path.join(root, 'docker.mjs')
  await fs.writeFile(mode, 'ok')
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const state=${JSON.stringify(state)},mode=${JSON.stringify(mode)},started=${JSON.stringify(started)},captured=${JSON.stringify(captured)};
const args=process.argv.slice(2), behavior=fs.readFileSync(mode,'utf8');
if(args[0]==='image'){console.log(${JSON.stringify(imageId)});process.exit(0);}
if(args[0]==='inspect'){if(!fs.existsSync(state)){console.error('No such container');process.exit(1);}const current=JSON.parse(fs.readFileSync(state,'utf8'));if(/^[a-f0-9]{64}$/.test(args.at(-1))&&args.at(-1)!==current.Id){console.error('No such container');process.exit(1);}console.log(fs.readFileSync(state,'utf8'));process.exit(0);}
if(args[0]==='create'){
 const labels=Object.fromEntries(args.filter((x,i)=>args[i-1]==='--label').map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];}));
 const mount=args[args.indexOf('--mount')+1];const source=mount.split(',').find(part=>part.startsWith('src=')).slice(4);
 fs.writeFileSync(captured,JSON.stringify(args));
 try{fs.writeFileSync(state,JSON.stringify({Id:'d'.repeat(64),Config:{Labels:labels,User:'10001:10001'},Image:${JSON.stringify(imageId)},State:{Running:false},
 HostConfig:{Tmpfs:{'/workspace':'ro,noexec,nosuid,nodev,size=1m','/runtime':'ro,noexec,nosuid,nodev,size=1m'},ReadonlyRootfs:true,NetworkMode:'none',Memory:268435456,MemorySwap:268435456,NanoCpus:500000000,PidsLimit:32,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Mounts:[{Type:'bind',Source:source,Target:'/input',ReadOnly:true}]},
 Mounts:[{Destination:'/input',RW:false}]}),{flag:'wx'});}catch{process.exit(1);}
 if(behavior==='gated-create'){setInterval(()=>{if(fs.existsSync(mode+'.release')){console.log('d'.repeat(64));process.exit(0);}},10);}else if(behavior==='uncertain'){setTimeout(()=>{},10000);}else{console.log('d'.repeat(64));process.exit(0);}
}
if(args[0]==='rm'){if(behavior==='rm-fails')process.exit(1);fs.rmSync(state,{force:true});process.exit(0);}
if(args[0]==='start'){
 fs.writeFileSync(started,String(process.pid));
 if(behavior==='ok'||behavior==='gated-create'){console.log(${JSON.stringify(JSON.stringify(output))});process.exit(0);}
 if(behavior==='rewrite'){
  const capturedArgs=JSON.parse(fs.readFileSync(captured,'utf8'));
  const mount=capturedArgs[capturedArgs.indexOf('--mount')+1];
  const source=mount.split(',').find(part=>part.startsWith('src=')).slice(4)+'/bundle/SKILL.md';
  const original=fs.readFileSync(source);fs.writeFileSync(source,'changed');fs.writeFileSync(source,original);
  console.log(${JSON.stringify(JSON.stringify(output))});process.exit(0);
 }
 if(behavior==='output-path'){console.log(JSON.stringify({...${JSON.stringify(output)},resourceBase:{path:'/input'}}));process.exit(0);}
 if(behavior==='overflow'){process.stdout.write('x'.repeat(524289));}
 setInterval(()=>{if(!fs.existsSync(state))process.exit(1);},20);
}
`, { mode: 0o700 })
  const config = { dataDir: root, runtimeContainerBin: binary, runtimeContainerImage: 'trusted:fixture', runtimeContainerUser: '1000:1000' }
  const reference = { ownerHash: sha('alice'), kind: 'imports', contentId: sha('skill-one'), expectedName: null }
  const directory = skillValidationRoot(config, reference)
  await fs.mkdir(path.join(directory, 'bundle'), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, 'bundle/SKILL.md'), '---\nname: imported-review\ndescription: Review the evidence\n---\n# Review\nUse evidence.\n', { mode: 0o400 })
  const controller = createSkillValidationController(config, { availableMemory: async () => 2 * 1024 ** 3, ...hooks })
  t.after(async () => {
    await fs.rm(state, { force: true })
    await controller.close().catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  })
  return { controller, config, reference, directory, state, mode, started, captured }
}
async function waitStarted(started) {
  for (let count = 0; count < 200; count++) {
    if (await fs.stat(started).then(() => true, () => false)) return Number(await fs.readFile(started, 'utf8'))
    await pause()
  }
  throw new Error('owned test child did not start')
}

test('only four opaque fields select one fixed private directory and sandbox command', () => {
  const config = { dataDir: '/srv/data', runtimeContainerImage: 'ignored', runtimeContainerUser: '1000:1000' }
  const reference = { ownerHash: 'a'.repeat(64), kind: 'imports', contentId: 'b'.repeat(64), expectedName: null }
  const plan = skillValidationPlan(config, reference, imageId, '00000000-0000-0000-0000-000000000001')
  assert(plan.args.includes('/workspace:ro,noexec,nosuid,nodev,size=1m'))
  assert(plan.args.includes('/runtime:ro,noexec,nosuid,nodev,size=1m'))
  assert.equal(plan.args.at(-2), '/opt/evimed/socket/scripts/validate-personal-skill.mjs')
  assert.ok(plan.args.includes('--network=none') && plan.args.includes('--read-only'))
  assert.equal(plan.args.filter(value => value === '--mount').length, 1)
  assert.ok(plan.args.includes(`type=bind,src=/srv/data/.openscience/skill-validation-state/projections/${reference.ownerHash}/00000000-0000-0000-0000-000000000001/input,dst=/input,readonly`))
  assert.equal(plan.args[plan.args.indexOf('--user')+1], '10001:10001')
  assert.ok(plan.args.includes(imageId))
  for (const extra of ['path', 'image', 'argv', 'env', 'exec', 'root', 'command', 'ownerId']) assert.throws(() => validateSkillReference({ ...reference, [extra]: '/secret' }))
  assert.throws(() => validateSkillReference({ ...reference, contentId: '../escape' }))
  assert.throws(() => validateSkillReference({ ...reference, kind: 'uploads' }))
})

test('normal lifecycle cleans its exact physical slot and omits paths/diagnostics', async t => {
  const { controller, reference, state, captured, directory } = await fixture(t)
  const sourceFile = path.join(directory, 'bundle/SKILL.md')
  const original = await fs.readFile(sourceFile)
  const originalStat = await fs.stat(sourceFile)
  assert.deepEqual(await controller.validate(reference), output)
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
  const args = JSON.parse(await fs.readFile(captured, 'utf8'))
  assert.equal(args.filter(value => value === '--mount').length, 1)
  assert.ok(!args.some(value => value.includes('credentials') || value.includes('docker.sock')))
  const mount = args[args.indexOf('--mount')+1]
  const projected = mount.split(',').find(value=>value.startsWith('src=')).slice(4)
  assert.notEqual(projected,directory)
  await assert.rejects(fs.stat(projected),{code:'ENOENT'})
  assert.deepEqual(await fs.readFile(sourceFile),original)
  const after = await fs.stat(sourceFile)
  assert.equal(after.mode,originalStat.mode)
  assert.equal(after.ino,originalStat.ino)
  assert.equal(after.ctimeMs,originalStat.ctimeMs)
})

test('links, unexpected resources, foreign namespaces and bad package integrity are refused before creation', async t => {
  const { controller, reference, directory, state } = await fixture(t)
  await fs.symlink('/tmp', path.join(directory, 'bundle', 'resource'))
  await assert.rejects(controller.validate(reference))
  await fs.rm(path.join(directory, 'bundle', 'resource'))
  await fs.link(path.join(directory, 'bundle/SKILL.md'), path.join(directory, 'bundle/copy.txt'))
  await assert.rejects(controller.validate(reference))
  await fs.rm(path.join(directory, 'bundle/copy.txt'))
  await fs.writeFile(path.join(directory, 'bundle', 'secrets.json'), '{}')
  await assert.rejects(controller.validate(reference))
  await assert.rejects(controller.validate({ ...reference, ownerHash: sha('bob') }))
  await assert.rejects(controller.validate({ ...reference, kind: 'packages', expectedName: nativeName }))
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
})

test('abort, deadline and removed source root still terminate and join the actual owned child', async t => {
  let expire
  const { controller, reference, directory, mode, started, state } = await fixture(t, { setTimer: callback => { expire = callback; return 1 }, clearTimer: () => {} })
  await fs.writeFile(mode, 'hang')
  const control = new AbortController()
  const pending = controller.validate(reference, control.signal).catch(error => error)
  const pid = await waitStarted(started)
  await fs.rm(directory, { recursive: true, force: true })
  control.abort()
  assert.ok(await pending)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
  // Recreate immutable input and observe the fixed deadline path separately.
  await fs.mkdir(path.join(directory, 'bundle'), { recursive: true })
  await fs.writeFile(path.join(directory, 'bundle/SKILL.md'), '---\nname: imported-review\ndescription: review\n---\nbody')
  await fs.rm(started)
  const deadline = controller.validate(reference).catch(error => error)
  const nextPid = await waitStarted(started)
  expire()
  assert.equal((await deadline).status, 504)
  assert.throws(() => process.kill(nextPid, 0), { code: 'ESRCH' })
})

test('output overflow, path leakage and failed cancellation never free uncertain capacity', async t => {
  const { controller, reference, mode, state } = await fixture(t)
  await fs.writeFile(mode, 'overflow')
  await assert.rejects(controller.validate(reference))
  await fs.writeFile(mode, 'output-path')
  await assert.rejects(controller.validate(reference))
  await fs.writeFile(mode, 'rm-fails')
  const control = new AbortController()
  const pending = controller.validate(reference, control.signal).catch(error => error)
  for (let count = 0; count < 200; count++) { if (await fs.stat(state).then(() => true, () => false)) break; await pause() }
  control.abort()
  assert.equal((await pending).code, 'product_state_unavailable')
  await assert.rejects(controller.validate(reference), /busy/u)
  await fs.writeFile(mode, 'ok')
})

test('version 8 exposes only the fixed validation reference and keeps version-7 citation start shape', async t => {
  assert.equal(RUNTIME_CONTROLLER_PROTOCOL_VERSION, 8)
  const { config, reference } = await fixture(t)
  const client = new RuntimeControllerClient(config)
  let received
  client.request = async (...args) => { received = args; return output }
  await client.validatePersonalSkill(reference)
  assert.deepEqual(received.slice(0, 3), ['POST', '/v1/skills/validate', reference])
  assert.equal(received[3].maxResponseBytes, 512 * 1024 + 1024)
  await client.startRuntime({ id: 'project', userId: 'alice', activeWorkspace: '' }, 12000, 'pw_0123456789012345')
  assert.deepEqual(Object.keys(received[2]).sort(), ['activeWorkspace', 'capsuleGatewayUrl', 'password', 'pluginConfig', 'port', 'projectId', 'publicSourceGatewayUrl', 'revisionGatewayUrl', 'userId'])
  const server = createRuntimeController({ ...config, runtimeControllerSocket: path.join(config.dataDir, 'controller.sock'), production: false },
    { skillValidation: { availableMemory: async () => 2 * 1024 ** 3 } })
  t.after(() => server.close())
  await server.listen()
  const actual = new RuntimeControllerClient({ ...config, runtimeControllerSocket: path.join(config.dataDir, 'controller.sock') })
  assert.deepEqual(await actual.validatePersonalSkill(reference), output)
  await assert.rejects(actual.request('POST', '/v1/skills/validate', { ...reference, path: '/secret' }), { code: 'runtime_controller_payload_invalid' })
})

test('canonical package manifest hashes every resource and the exact authored skill', async t => {
  const { config, controller, reference, mode } = await fixture(t)
  const file = `---\nname: ${nativeName}\ndescription: review\n---\nbody`
  const resources = []
  const contentId = sha(canonicalJson({ file, resources }))
  const packageReference = { ...reference, kind: 'packages', contentId, expectedName: nativeName }
  const directory = skillValidationRoot(config, packageReference)
  await fs.mkdir(path.join(directory, nativeName), { recursive: true })
  await fs.writeFile(path.join(directory, nativeName, 'SKILL.md'), file)
  await fs.writeFile(path.join(directory, 'manifest.json'), `${canonicalJson({ schemaVersion: 1, nativeName, digest: `sha256:${contentId}`, resources })}\n`)
  // The fake returns a different native name: validation observes that mismatch.
  await assert.rejects(controller.validate(packageReference))
  await fs.writeFile(path.join(directory, nativeName, 'SKILL.md'), file + '\nchanged')
  await assert.rejects(controller.validate(packageReference))
  await fs.writeFile(mode, 'ok')
})

test('early joined cancellation persists across restart and prevents later physical creation', async t => {
  const { controller, config, reference, state } = await fixture(t)
  assert.deepEqual(await controller.cancel(reference), { cancelled: true })
  const restarted = createSkillValidationController(config, { availableMemory: async () => 2 * 1024 ** 3 })
  await assert.rejects(restarted.validate(reference), /cancelled/u)
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
  await restarted.close()
})

test('restoring changed input bytes cannot hide a mutation during native validation', async t => {
  const { controller, reference, mode, state } = await fixture(t)
  await fs.writeFile(mode, 'rewrite')
  await assert.rejects(controller.validate(reference), { code: 'extension_contract_invalid' })
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
})

test('uncertain Docker creation keeps durable capacity and can never return a cancelled ACK', async t => {
  const { controller, reference, mode, config } = await fixture(t)
  await fs.writeFile(mode, 'uncertain')
  await assert.rejects(controller.validate(reference), /uncertain/u)
  await assert.rejects(controller.cancel(reference), /uncertain/u)
  await assert.rejects(controller.validate(reference), /busy/u)
  await fs.stat(path.join(config.dataDir, '.openscience/skill-validation-state/creation-uncertain.json'))
})

test('client abort and timeout wait for joined cancellation and report a lost ACK as unknown', async () => {
  for (const reason of [{ code: 'runtime_controller_timeout', name: 'Error' }, { name: 'AbortError' }]) {
    const client = new RuntimeControllerClient({})
    let release
    let completed = false
    const gate = new Promise(resolve => { release = resolve })
    client.request = async (_method, route, _body, options) => {
      if (route.endsWith('/validate')) { options.onDispatch(); throw reason }
      assert.equal(route, '/v1/skills/cancel')
      await gate
      return { cancelled: true }
    }
    const result = client.validatePersonalSkill({ ownerHash: 'a'.repeat(64), kind: 'imports', contentId: 'b'.repeat(64), expectedName: null })
      .then(() => null, error => { completed = true; return error })
    await pause()
    assert.equal(completed, false)
    release()
    assert.equal(await result, reason)
  }
  const client = new RuntimeControllerClient({})
  client.request = async (_method, route, _body, options) => {
    if (route.endsWith('/validate')) { options.onDispatch(); throw { code: 'runtime_controller_timeout' } }
    throw new Error('lost cancellation acknowledgment')
  }
  await assert.rejects(client.validatePersonalSkill({ ownerHash: 'a'.repeat(64), kind: 'imports', contentId: 'b'.repeat(64), expectedName: null }),
    { code: 'product_state_unavailable', status: 503 })
})

test('real Unix-socket client disconnect joins the owned process before rejection', async t => {
  const { config, reference, mode, started, state } = await fixture(t)
  await fs.writeFile(mode, 'hang')
  const server = createRuntimeController({ ...config, runtimeControllerSocket: path.join(config.dataDir, 'abort.sock'), production: false },
    { skillValidation: { availableMemory: async () => 2 * 1024 ** 3 } })
  t.after(() => server.close())
  await server.listen()
  const client = new RuntimeControllerClient({ ...config, runtimeControllerSocket: path.join(config.dataDir, 'abort.sock') })
  const control = new AbortController()
  const pending = client.validatePersonalSkill(reference, { signal: control.signal }).catch(error => error)
  const pid = await waitStarted(started)
  control.abort()
  assert.equal((await pending).name, 'AbortError')
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(fs.stat(state), { code: 'ENOENT' })
})

test('all settled non-success paths delete owned projection bytes; unknown creation retains them with its marker', async t => {
  for (const behavior of ['output-path','overflow']) {
    const f=await fixture(t)
    await fs.writeFile(f.mode,behavior)
    await assert.rejects(f.controller.validate(f.reference))
    const owner=path.join(f.config.dataDir,'.openscience/skill-validation-state/projections',f.reference.ownerHash)
    assert.deepEqual(await fs.readdir(owner).catch(error=>{if(error.code==='ENOENT')return[];throw error}),[])
  }
  const f=await fixture(t)
  await fs.writeFile(f.mode,'uncertain')
  await assert.rejects(f.controller.validate(f.reference))
  const marker=JSON.parse(await fs.readFile(path.join(f.config.dataDir,'.openscience/skill-validation-state/creation-uncertain.json'),'utf8'))
  const projected=path.join(f.config.dataDir,'.openscience/skill-validation-state/projections',f.reference.ownerHash,marker.jobId,'input')
  assert.equal((await fs.stat(projected)).mode&0o7777,0o755)
  assert.equal((await fs.stat(path.join(projected,'bundle/SKILL.md'))).mode&0o7777,0o444)
  await assert.rejects(f.controller.cancel(f.reference),/uncertain/u)
  await fs.stat(projected)
})

test('same-name copied-label replacement is never removed or acknowledged as the captured worker', async t => {
  const f=await fixture(t)
  await fs.writeFile(f.mode,'hang')
  const pending=f.controller.validate(f.reference).catch(error=>error)
  const pid=await waitStarted(f.started)
  const original=JSON.parse(await fs.readFile(f.state,'utf8'))
  const replacement={...original,Id:'e'.repeat(64)}
  await fs.writeFile(f.state,JSON.stringify(replacement))
  await assert.rejects(f.controller.cancel(f.reference),/replacement/u)
  assert.equal((await pending).code,'product_state_unavailable')
  assert.equal(JSON.parse(await fs.readFile(f.state,'utf8')).Id,replacement.Id)
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
  const marker=JSON.parse(await fs.readFile(path.join(f.config.dataDir,'.openscience/skill-validation-state/creation-uncertain.json'),'utf8'))
  assert.equal(marker.containerId,original.Id)
  await assert.rejects(f.controller.validate(f.reference),/busy/u)
})

test('restart cancellation cannot claim a matching-name worker without persisted confirmed ID', async t => {
  const f=await fixture(t)
  await fs.writeFile(f.mode,'hang')
  const pending=f.controller.validate(f.reference).catch(error=>error)
  await waitStarted(f.started)
  const markerPath=path.join(f.config.dataDir,'.openscience/skill-validation-state/creation-uncertain.json')
  const marker=JSON.parse(await fs.readFile(markerPath,'utf8'))
  delete marker.containerId
  await fs.writeFile(markerPath,JSON.stringify(marker))
  const restarted=createSkillValidationController(f.config,{availableMemory:async()=>2*1024**3})
  await assert.rejects(restarted.cancel(f.reference),/uncertain/u)
  await fs.stat(f.state)
  // Test recovery explicitly restores the confirmed owner record; no source
  // recovery path invents this identity from the current name occupant.
  marker.containerId='d'.repeat(64);await fs.writeFile(markerPath,JSON.stringify(marker))
  await f.controller.cancel(f.reference);await pending;await restarted.close()
})

test('the isolated validator resolves through the actual runtime image seed, never a stale fixture path',async()=>{
  const dockerfile=await fs.readFile(new URL('../../../deploy/runtime-dsh/Dockerfile',import.meta.url),'utf8')
  const script=await fs.readFile(new URL('../../../scripts/runtime/validate-personal-skill.mjs',import.meta.url),'utf8')
  const seed=dockerfile.match(/^ENV DSH_HOME_SEED=(\S+)$/m)?.[1]
  assert.ok(seed?.startsWith('/opt/evimed/'))
  assert.ok(script.includes(`createRequire('${seed}/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/package.json')`))
  assert.ok(!script.includes('/usr/local/share/evimed/dsh-home-seed'))
})


test('container creation yields the controller event loop while awaiting its owned acknowledgement', {timeout:5000}, async t=>{
  const f=await fixture(t)
  await fs.writeFile(f.mode,'gated-create')
  let released=false
  const timer=setInterval(()=>{void fs.stat(f.captured).then(async()=>{if(released)return;released=true;clearInterval(timer);await fs.writeFile(f.mode+'.release','owned acknowledgement may finish');},()=>{});},10)
  t.after(()=>clearInterval(timer))
  assert.deepEqual(await f.controller.validate(f.reference),output)
  assert.equal(released,true)
})


test('cancellation during create acknowledgement joins the owned container without starting it', {timeout:5000}, async t=>{
  const f=await fixture(t),abort=new AbortController()
  await fs.writeFile(f.mode,'gated-create')
  const running=f.controller.validate(f.reference,abort.signal)
  const rejected=assert.rejects(running,{code:'extension_contract_invalid'})
  for(let attempt=0;attempt<200;attempt++){
    if(await fs.stat(f.captured).then(()=>true,()=>false))break
    await new Promise(resolve=>setTimeout(resolve,5))
  }
  await fs.stat(f.captured)
  abort.abort()
  await fs.writeFile(f.mode+'.release','return owned ID after cancellation')
  await rejected
  await assert.rejects(fs.stat(f.started),{code:'ENOENT'})
  await assert.rejects(fs.stat(f.state),{code:'ENOENT'})
})
