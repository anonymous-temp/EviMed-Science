import test from 'node:test';import assert from 'node:assert/strict';
import{approvedBodyHash,seedMemoryProof,personalRetrievalProof}from'../personal_context.mjs';
const seed={id:'handoff',kind:'user-authored',statement:'For my handoff notes, always list owner before deadline.',requiredValues:['owner before deadline']};
seed.proposition={text:seed.statement,sourceQuote:seed.statement,statementSha256:approvedBodyHash(seed.statement),sha256:approvedBodyHash(seed.statement)};
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
 for(const item of seeds)item.proposition??={text:item.statement,sourceQuote:item.statement,statementSha256:approvedBodyHash(item.statement),sha256:approvedBodyHash(item.statement)};
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

test('proposition overlap ranks a relevant paraphrase ahead of unrelated alphabetical records',async()=>{
 const records=['a','b','c','d','e'].map(name=>({id:`viking://user/owned/memories/preferences/${name}.md`,value:'Forecast accounting uses EUR.'}));
 records.push({id:'viking://user/owned/memories/preferences/z.md',value:'Handoff notes put the owner ahead of the due date.'});
 let calls=0;const proof=await seedMemoryProof([seed],{engine:'native',records},{judge:async input=>{calls++;return {ok:true,score:input.answer.startsWith('Handoff')?1:0,points:[{verdict:input.answer.startsWith('Handoff')?'covered':'missing',contradicted:false}]};}});
 assert.equal(proof[0].recordId,records[5].id);assert.equal(calls,1);
});

test('malformed seed judgement preserves both raw responses and accounted cost in failure evidence',async()=>{
 const {boundedSemanticJudge}=await import('../automatic_judge.mjs');
 const bad=await boundedSemanticJudge({chat:async()=>({message:{content:'not JSON'},usage:{promptTokens:2,completionTokens:3},cost:.01})});
 await assert.rejects(seedMemoryProof([seed],profile('Stored body'),{judge:bad}),error=>{
  const attempt=error.semanticSeedEvidence?.attempts?.[0];assert.equal(attempt.raw.length,2);assert.equal(attempt.cost,.02);assert.equal(attempt.tokens.calls,2);assert.equal(attempt.result.malformed,true);return true;
 });
});
test('a thrown provider call retains attempted request and unknown response/cost without retry',async()=>{
 const {boundedSemanticJudge}=await import('../automatic_judge.mjs');let calls=0;
 const failed=await boundedSemanticJudge({chat:async()=>{calls++;throw Error('Shared budget accounting unavailable');}});
 await assert.rejects(seedMemoryProof([seed],profile('Stored body'),{judge:failed}),error=>{
  const attempt=error.semanticSeedEvidence.interrupted.raw[0];assert.equal(attempt.request.model,'deepseek-v4-pro');assert.ok(attempt.request.messages.length);assert.equal(attempt.state,'unknown-no-response');assert.equal(attempt.response,null);assert.equal(attempt.cost,null);return true;
 });assert.equal(calls,1);
});
