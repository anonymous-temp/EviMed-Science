import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { armEnv, examSpec, wilson, composite, reuseOf, methodLibrary, argsOf } from './run_l3.mjs';
import { seedMethodLibrary, waitForMemoryTools } from '../../general-tasks/runner/cell.mjs';
import { control } from '../../general-tasks/runner/learning-control.mjs';

test('L3 arms isolate methods, learning, pyramid and add-only; unsupported controls refuse', () => {
  for (const arm of ['A','B','E','D','F']) {
    const env = armEnv(arm);
    assert.equal(env.OPEN_SCIENCE_LEARNING_ENABLED, ['E','D','F'].includes(arm) ? 'true' : 'false');
    assert.equal(env.OPEN_SCIENCE_OFFICIAL_PACKS_ENABLED, arm === 'A' ? 'false' : 'true');
    assert.equal(env.EVAL_ADD_ONLY, arm === 'F' ? '1' : '0');
    assert.equal(env.OPEN_SCIENCE_METHOD_PYRAMID_ENABLED, arm === 'D' ? 'true' : 'false');
    assert.equal(env.OPEN_SCIENCE_OFFICIAL_PROMOTION_ENABLED, 'false');
  }
  assert.throws(() => armEnv('C'), /library does not exist/);
  assert.throws(() => armEnv('G'), /experiences/);
});
test('exam setup preserves prerequisite turns without scoring the learning case', () => {
  const cases = [{ id:'G06', turns:[{ text:'setup' }] }, { id:'G07', after:'G06', turns:[{ text:'exam' }] }];
  const spec = examSpec('G07', cases);
  assert.deepEqual(spec.turns.map(t => t.text), ['setup','exam']);
  assert.deepEqual(spec.turnOffsets, { G07:1 });
  assert.equal(spec.id, 'G07');
});
test('Wilson and EvoDS preserve unknowns and report declared proxies', () => {
  assert.equal(wilson(0,0), null);
  const [lo,hi] = wilson(5,10); assert.ok(lo < .5 && hi > .5);
  const score = composite({ status:'pass', checks:[{required:true,ok:true}] }, { modelRequests:{maxEstimatedContextTokens:500000,agentRequests:10} });
  assert.ok(Math.abs(score.score - 1.14) < 1e-10);
  assert.equal(composite(null, {}).result,0);
});
test('seeding uses the authenticated product API with full SKILL text; readiness waits for actual tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'l3-test-'));
  try {
    const skill = '---\nname: example\ndescription: Example\n---\nRead the data.';
    await fs.writeFile(`${dir}/seed.json`, JSON.stringify({ methods:[{skill}] }));
    const calls = [];
    const methods = await seedMethodLibrary({ call: async (...args) => { calls.push(args); return {status:201,json:{data:{id:'m1'}}}; } }, `${dir}/seed.json`);
    assert.deepEqual(calls, [['POST','/api/methods',{skill}]]); assert.equal(methods[0].id,'m1');
    await fs.writeFile(`${dir}/tools.json`, JSON.stringify({names:['bash']}));
    const timer = setTimeout(() => void fs.writeFile(`${dir}/tools.json`,JSON.stringify({names:['mcp__openviking__search']})),25);
    const ready = await waitForMemoryTools(`${dir}/tools.json`, { timeoutMs:1000,pollMs:10 });
    clearTimeout(timer); assert.ok(ready.names.includes('mcp__openviking__search'));
    await fs.writeFile(`${dir}/tools.json`,JSON.stringify({names:[]}));
    await assert.rejects(waitForMemoryTools(`${dir}/tools.json`,{timeoutMs:30,pollMs:5}),/not registered/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('eval pause waits for product worker lanes and reads the account job ledger', async () => {
  const calls = [];
  const worker = {enabled:true,lanes:new Set([Promise.resolve()]),status:()=>({running:false})};
  const app = {learningWorker:worker,store:{database:{query:async (...args)=>{calls.push(args);return{rows:[]};}}}};
  await control(app,'pause',{userId:'u1'});
  assert.equal(worker.enabled,false); assert.equal(calls[0][1][0],'u1');
});

test('cross-task reuse counts distinct exam cases, separating repetitions and unopened cards', () => {
  const rows = [{case:'G04', methodsOpened:[{name:'learned-budget'}]}, {case:'G04', methodsOpened:[{name:'learned-budget'}]},
    {case:'M01', methodsOpened:[{name:'official-source'}]}, {case:'M02', methodsOpened:[{name:'official-source'}]}];
  const reuse = reuseOf(rows, ['learned-budget','never-opened']);
  assert.deepEqual(reuse.reusedAcrossExamCases,['official-source']);
  assert.equal(reuse.learnedTransferShare,.5);
  assert.equal(reuse.crossTaskShare,.5);
});

test('the library snapshot respects the product page limit, follows cursors, and rejects failed reads', async () => {
  const calls = [];
  const api = {call: async (verb, url) => {
    calls.push([verb,url]);
    return {status:200,json:{data:{items:[{id:`m${calls.length}`}],nextCursor:calls.length===1?'page:2':null}}};
  }};
  assert.deepEqual((await methodLibrary(api)).data.items.map(m=>m.id),['m1','m2']);
  assert.deepEqual(calls,[['GET','/api/methods?limit=100'],['GET','/api/methods?limit=100&cursor=page%3A2']]);
  await assert.rejects(methodLibrary({call:async()=>({status:400,json:{error:'bad limit'}})}),/snapshot failed/);
});

test('explicit memory readiness flag does not consume the next CLI option', () => {
  const args = argsOf(['--wait-memory-tools','--arm','B','--repeat','2']);
  assert.equal(args.waitMemoryTools,true); assert.equal(args.arm,'B'); assert.equal(args.repeat,2);
  assert.equal(argsOf(['--no-wait-memory-tools']).waitMemoryTools,false);
});
