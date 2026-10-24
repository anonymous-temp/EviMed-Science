import test from 'node:test';import assert from 'node:assert/strict';
import{seedMemoryProof,personalRetrievalProof}from'../personal_context.mjs';
const seed={id:'handoff',kind:'user-authored',statement:'For my handoff notes, always list owner before deadline.',requiredValues:['owner before deadline']};
const uri='viking://user/owned/memories/preferences/handoff.md';
const profile=value=>({engine:'native',records:[{id:uri,value}]});
const judge=async({answer})=>({ok:true,score:answer.includes('the owner before the deadline')?1:0,malformed:false,points:[{id:'authored',verdict:answer.includes('the owner before the deadline')?'covered':'missing',contradicted:answer.includes('not list')}],cost:0.01});
test('semantic seed proof handles articles but rejects negation and reversed relations',async()=>{
 const proof=await seedMemoryProof([seed],profile('Always list the owner before the deadline.'),{judge});assert.equal(proof[0].approvedValue,'Always list the owner before the deadline.');assert.equal(proof[0].judge.cost,0.01);assert.ok(proof[0].bodySha256);
 for(const value of ['Do not list the owner before the deadline.','Always list deadline before owner.'])await assert.rejects(seedMemoryProof([seed],profile(value),{judge}),/represented/);
 await assert.rejects(seedMemoryProof([seed],profile('owner before deadline')),/judge/);
});
test('native provenance binds each returned URI to its own approved body, never across results',async()=>{
 const proof=await seedMemoryProof([seed],profile('Always list the owner before the deadline.'),{judge}),c={memorySeeds:[seed]},base={memoryFreeze:{provenance:proof}};
 const tool=output=>({name:'mcp__openviking__search',status:'completed',output});
 for(const output of [{memories:[{uri,text:'Wrong fact'}]},{memories:[{uri,text:'Wrong fact'},{uri:'viking://user/foreign/memories/p.md',text:proof[0].approvedValue}]}])assert.throws(()=>personalRetrievalProof(c,{...base,retrieval:[tool(output)]}),/provenance/);
 assert.equal(personalRetrievalProof(c,{...base,retrieval:[tool({result:{memories:[{uri,content:proof[0].approvedValue}]}})]}).length,1);
});

test('merged native files are judged per user statement and semantic errors never become a pass',async()=>{
 const seeds=[seed,{id:'currency',kind:'user-authored',statement:'Use EUR for my forecasts.',requiredValues:['EUR']}];
 let calls=0;const merged='List the owner before the deadline. Forecast currency is EUR.';
 const proof=await seedMemoryProof(seeds,profile(merged),{judge:async input=>{calls++;assert.ok(seeds.some(s=>s.statement===input.reference.keyPoints[0].text));return {ok:true,score:1,points:[{verdict:'covered',contradicted:false}]};}});
 assert.equal(calls,2);assert.equal(proof[0].uri,proof[1].uri);
 for(const judge of [async()=>{throw Error('Shared budget refused');},async()=>({ok:true,score:1,malformed:true,points:[]})])await assert.rejects(seedMemoryProof([seed],profile(merged),{judge}),/budget|malformed/);
});

test('actual MCP text envelopes keep read bodies tied to one explicit input URI',async()=>{
 const proof=await seedMemoryProof([seed],profile('Always list the owner before the deadline.'),{judge}),c={memorySeeds:[seed]},e={memoryFreeze:{provenance:proof}};
 const body={result:{content:[{type:'text',text:proof[0].approvedValue}]}};
 const read={name:'mcp__openviking__read',status:'completed',input:JSON.stringify({uris:[uri]}),output:body};
 assert.equal(personalRetrievalProof(c,{...e,retrieval:[read]}).length,1);
 read.input={uris:[uri,'viking://user/foreign/memories/other.md']};assert.throws(()=>personalRetrievalProof(c,{...e,retrieval:[read]}),/provenance/);
});
