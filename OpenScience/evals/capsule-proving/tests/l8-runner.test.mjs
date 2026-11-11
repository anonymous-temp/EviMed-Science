import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerTask, taskTools, askAnswer } from '../l8/answer_l8.mjs';
import { runL8, parseArgs, retryOpen, labSessions, BOTH } from '../l8/run_l8.mjs';
import { scoreCalls, summarize, scoreRun } from '../l8/score_l8.mjs';
import { validateLedgerRow } from '../run/ledger.mjs';
const step={tool:'get_exchange_rate',args:{from:'CNY',to:'USD'},output:{rate:2.78}};
const direct={steps:[{tool:step.tool,args:step.args}],askedAboutKnown:['to']};
const item={id:'L8-dev-fake',split:'dev',graph:'general',level:1,length:1,source:'sessions',steps:[step],removed:[{step:0,param:'to',value:'USD'}],arms:{}};
for(const arm of ['no-memory','memory','memory+method']) item.arms[arm]={input:{request:'Convert CNY to my usual currency',sessions:[{messages:[{role:'user',content:'My currency is USD'}]}],card:arm==='memory+method' ? {title:'Currency habit',body:'Use USD.'} : null},gold:arm==='no-memory' ? {steps:[{ask:{params:['to']}},...direct.steps],askedAboutKnown:[]} : direct};
const builders={buildSystemPrompt:()=> 'product-system',buildProfileBlock:async()=> 'profile',buildTimeContext:()=> 'today',buildSkillCatalog:async()=>({text:'catalog',entries:[],skills:new Map()})};
const call=(name,args)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
function fakeModel(sequence, seen=[]) {
  return {model:'deepseek-flash',thinking:'enabled',reasoningEffort:'high',async complete(request) {seen.push(request);const next=sequence.shift();assert.ok(next,'Unexpected model call');return {message:{role:'assistant',content:next.content ?? null,reasoning_content:'kept',...(next.calls ? {tool_calls:next.calls} : {})},usage:{prompt_tokens:10,completion_tokens:2}};}};
}
const memory={config:{},tools:[{name:'search',description:'search memory',inputSchema:{type:'object',properties:{query:{type:'string'}}}}],residentBlock:async()=>null,callTool:async()=>({blocks:['USD'],isError:false})};

test('model loop uses product builders, memory tools, simulator and ordered scoring',async()=>{
  const seen=[];
  const client=fakeModel([{calls:[call('mcp__openviking__search',{query:'currency'})]},{calls:[call(step.tool,step.args)]},{content:'Done'}],seen);
  const row=await answerTask({item,arm:'memory',memory,client,builders});
  assert.equal(row.score.pass,true);assert.deepEqual(row.score.perStep,[true]);assert.equal(row.score.firstFail,null);
  assert.equal(row.score.memorySearchBeforeTask,true);assert.equal(row.score.memoryReadBeforeTask,false);
  assert.equal(row.usage.promptTokens,30);assert.equal(row.rounds,3);
  assert.equal(seen[0].messages[0].content,'product-system');assert.equal(seen[0].messages[2].content,'profile');
  assert.match(seen[2].messages.at(-1).content,/2.78/);assert.equal(seen[2].messages.at(-2).reasoning_content,'kept');
  assert.equal(taskTools(item).length,4);assert.ok(!JSON.stringify(seen[0].tools).includes('CNY'));
});
test('TellOnce ask counts in memory arms but matches no-memory gold',async()=>{
  for(const arm of ['no-memory','memory','memory+method']) {
    const client=fakeModel([{calls:[call('ask_user',{params:['to'],question:'Which currency?'})]},{calls:[call(step.tool,step.args)]},{content:'Done'}]);
    const row=await answerTask({item,arm,memory:arm==='no-memory' ? undefined : memory,client,builders});
    assert.equal(row.score.askedUser,true);assert.equal(row.score.tellOnceFailure,arm!=='no-memory');assert.equal(row.score.pass,arm==='no-memory');
    assert.equal(row.toolCalls[0].blocks[0],JSON.stringify({values:{to:'USD'}}));
  }
});
test('method body requires read; method section is the product renderer',async()=>{
  const seen=[];
  const client=fakeModel([{calls:[call('read',{path:'/runtime/capsule-methods/l8-rule/SKILL.md'})]},{calls:[call(step.tool,step.args)]},{content:'Done'}],seen);
  const row=await answerTask({item,arm:'memory+method',memory,client,builders});
  assert.match(seen[0].messages[0].content,/## 这位用户的做法/);
  assert.ok(!JSON.stringify(seen[0].messages).includes('Use USD.'));assert.equal(row.toolCalls[0].blocks[0],'Use USD.');assert.equal(row.score.pass,true);
});
test('first failure, extra calls, step credit, asks and memory-read ordering are deterministic',()=>{
  const calls=[{kind:'task',scoringCall:{tool:step.tool,args:{}}},{kind:'memory',name:'mcp__openviking__read'},{kind:'task',scoringCall:direct.steps[0]}];
  const score=scoreCalls(direct,calls);assert.equal(score.firstFail,0);assert.equal(score.extraCalls,1);assert.equal(score.stepCredit,0);assert.equal(score.memoryReadBeforeTask,false);
  const gold={steps:[direct.steps[0],{tool:'x',args:{}},direct.steps[0]]};
  const s=scoreCalls(gold,[direct.steps[0],{tool:'y',args:{}},direct.steps[0]].map(scoringCall=>({kind:'task',scoringCall})));
  assert.equal(s.stepCredit,2/3);assert.equal(s.prefixCredit,1/3);
  assert.deepEqual(askAnswer(item,{params:['to','unknown']}).result.values,{to:'USD'});
  assert.deepEqual(askAnswer(item,{params:['currency']}).result.values,{to:'USD'});
  assert.deepEqual(askAnswer(item,{params:['currency']}).params,['currency']);
});
test('round limit and model errors stay failures with calls preserved',async()=>{
  const client=fakeModel([{calls:[call(step.tool,step.args)]}]);
  const row=await answerTask({item,arm:'no-memory',client,builders,maxRounds:1});assert.match(row.error,/round_limit/);assert.equal(row.score.pass,false);assert.equal(row.toolCalls.length,1);
  const complete=await answerTask({item,arm:'memory',memory,client:fakeModel([{calls:[call(step.tool,step.args)]}]),builders,maxRounds:1});
  assert.equal(complete.termination,'round-limit');assert.equal(complete.score.pass,true,'trajectory scoring depends on calls, independent of final-answer termination');
});
test('deadlocks retry only bounded 40P01 opens',async()=>{
  let n=0;const result=await retryOpen(async()=>{if(n++<2) throw Object.assign(new Error('deadlock detected'),{code:'40P01'});return 3;},{},async()=>{});
  assert.equal(result,3);assert.equal(n,3);await assert.rejects(retryOpen(async()=>{throw new Error('other');},{},async()=>{}),/other/);
});
test('fresh arm users, product ingestion, both variants and resume do not repeat work',async()=>{
  const out=await mkdtemp(join(tmpdir(),'l8-test-'));
  const users=[],ingested=[],variants=[];let answers=0;
  const lab={facts:{engineVersion:'0.5.3'},user:async key=>{users.push(key);return {userId:key};},ingestSession:async(u,s)=>{ingested.push([u,s]);return {sessionId:s.sessionId,usage:{promptTokens:4,completionTokens:1}};},memoryFor:(u,o)=>{variants.push(o.variant);return {...memory,config:o.variant ? BOTH : {}};},close:async()=>{}};
  const o={...parseArgs([]),out};const deps={items:[item],client:{},openLab:async config=>{assert.deepEqual(config.answerVariants,[{name:'both',config:BOTH}]);return lab;},skipLedger:true,answerTask:async({arm,variant})=>{
    answers++;const calls=item.arms[arm].gold.steps.map(scoringCall=>({kind:scoringCall.ask ? 'ask' : 'task',scoringCall}));
    return {itemId:item.id,arm,variant,armLabel:arm+(variant ? ':'+variant : ''),level:1,length:1,source:'sessions',usage:{promptTokens:1,completionTokens:1},toolCalls:calls,score:scoreCalls(item.arms[arm].gold,calls)};
  }};
  try {
    const s=await runL8(o,deps);assert.equal(s.rows,5);assert.equal(answers,5);assert.equal(new Set(users).size,3);assert.equal(ingested.length,2);assert.deepEqual(variants.sort(),['','','both','both']);
    const s2=await runL8(o,deps);assert.equal(s2.rows,5);assert.equal(answers,5);assert.equal(ingested.length,2);
    const rows=(await readFile(join(out,'rows.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.length,5);assert.equal(summarize(rows).arms.memory.passRate,1);
    const ledger=JSON.parse(await readFile(join(out,'ledger.memory.json'),'utf8'));assert.deepEqual(validateLedgerRow(ledger),[]);assert.equal(ledger.n,1);
    await assert.rejects(runL8({...o,arms:['memory']},deps),/Resume options/);
    const data=join(out,'data');await mkdir(join(data,'items'),{recursive:true});await writeFile(join(data,'items','fake.json'),JSON.stringify(item));
    rows.forEach(r=>{r.score.pass=false;});await writeFile(join(out,'rows.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
    const rescored=await scoreRun(out,data);assert.equal(rescored.arms.memory.passRate,1);assert.equal(rescored.rows,5);assert.match(rescored.scorerDigest,/^[a-f0-9]{64}$/);
  } finally {await rm(out,{recursive:true,force:true});}
});
test('CLI disallows sealed data and excessive concurrency; sessions map content to text',()=>{
  assert.throws(()=>parseArgs(['--data','/x/l8-sealed']),/development/);assert.throws(()=>parseArgs(['--concurrency','7']),/Concurrency/);
  assert.equal(labSessions(item.arms.memory.input)[0].messages[0].text,'My currency is USD');
});

// A first question must not reveal a value whose gold clarification belongs to a later step.
test('multi-gap fallback does not spill later facts; drug/term alias preserves actual ask scoring',()=>{
  const two={...item,graph:'evimed',removed:[{step:1,param:'jurisdiction',kind:'jurisdiction',value:'JP'},{step:2,param:'adverseEvent',kind:'adverseEvent',value:'angioedema'}]};
  assert.deepEqual(askAnswer(two,{params:['jurisdiction']}).result.values,{jurisdiction:'JP'});
  assert.deepEqual(askAnswer(two,{params:['adverseEvent']}).result.values,{adverseEvent:'angioedema'});
  const aliases={...two,removed:[{step:0,param:'term',kind:'drugName',value:'amlodipine'},{step:1,param:'adverseEvent',kind:'adverseEvent',value:'angioedema'}]};
  const reply=askAnswer(aliases,{params:['drug']});
  assert.deepEqual(reply.result.values,{term:'amlodipine'});assert.deepEqual(reply.params,['drug']);
});
