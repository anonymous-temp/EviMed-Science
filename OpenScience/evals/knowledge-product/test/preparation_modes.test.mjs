import test from'node:test';import assert from'node:assert/strict';import b from'../cases.json'with{type:'json'};
import{seedProposition,approvedBodyHash,personalRetrievalProof}from'../personal_context.mjs';import{freezeCanaryMemory}from'../protocol.mjs';import{boundedSemanticJudge}from'../automatic_judge.mjs';
test('reviewed propositions retain their exact grounded first sentence and exclude only remember speech acts',()=>{
 const seeds=b.cases.flatMap(c=>c.memorySeeds??[]);assert.equal(seeds.length,38);
 for(const seed of seeds){assert.equal(seedProposition(seed),seed.statement.split('. ')[0]+'.');assert.ok(!seed.proposition.text.includes('Please remember'));}
 const wrong=structuredClone(seeds[0]);wrong.proposition.text='Invented scope';assert.throws(()=>seedProposition(wrong),/grounded|scope/);
 const scoped=structuredClone(seeds[0]);scoped.proposition.text=scoped.proposition.sourceQuote='List owner before deadline';scoped.proposition.sha256=approvedBodyHash(scoped.proposition.text);assert.throws(()=>seedProposition(scoped),/scope/);
});
test('functional canary identity freezes stable native memory but cannot qualify main semantic evidence',async()=>{
 const profile={engine:'native',pending:[],records:[{id:'viking://user/owned/memories/preferences/heading.md',value:'Use heading NONCE_42'}]},call=async(method,url)=>url==='/api/memory/profile'?profile:{learningPaused:true,recallPaused:false};
 const proof=await freezeCanaryMemory(call,{seedIds:['archive'],marker:'NONCE_42'});assert.equal(proof.mode,'canary-presence-only');
 assert.throws(()=>personalRetrievalProof({memorySeeds:[]},{memoryFreeze:proof}),/Canary/);
 await assert.rejects(freezeCanaryMemory(call,{seedIds:['archive'],marker:'OTHER',timeoutMs:0}),/not ready/);
});
test('semantic provider retries only malformed structure, never a valid partial or missing rating',async()=>{
 for(const verdict of ['partial','missing']){let calls=0;const judge=await boundedSemanticJudge({chat:async()=>{calls++;return {message:{content:JSON.stringify({points:[{id:'p',verdict,contradicted:false}]})},usage:{promptTokens:1,completionTokens:1},cost:.01};}});const result=await judge({question:'q',reference:{keyPoints:[{id:'p',text:'x'}]},answer:'a'});assert.equal(calls,1);assert.equal(result.raw.length,1);}
 let calls=0;const judge=await boundedSemanticJudge({chat:async()=>{calls++;return {message:{content:calls===1?'not JSON':JSON.stringify({points:[{id:'p',verdict:'covered',contradicted:false}]})},usage:{promptTokens:1,completionTokens:1},cost:.01};}});
 const result=await judge({question:'q',reference:{keyPoints:[{id:'p',text:'x'}]},answer:'a'});assert.equal(calls,2);assert.equal(result.score,1);assert.equal(result.cost,.02);
});

test('invalid verdict structures have a hard two-response bound with raw cost retained',async()=>{
 let calls=0;const judge=await boundedSemanticJudge({chat:async()=>{calls++;return {message:{content:calls===1?JSON.stringify({points:[{id:'p',verdict:'contradiction',contradicted:true}]}):'invalid JSON'},usage:{promptTokens:2,completionTokens:3},cost:.01};}});
 const result=await judge({question:'q',reference:{keyPoints:[{id:'p',text:'x'}]},answer:'a'});assert.equal(calls,2);assert.equal(result.malformed,true);assert.equal(result.raw.length,2);assert.equal(result.cost,.02);
});

test('fixed pre-main calibration declares one Pro protocol and all five required controls',async()=>{
 const {readFile}=await import('node:fs/promises');const calibration=JSON.parse(await readFile(new URL('../semantic-seed-calibration.json',import.meta.url),'utf8'));
 assert.equal(calibration.model,'deepseek-v4-pro');assert.equal(calibration.provider,'deepseek-pro');assert.equal(calibration.maximumResponsesPerCheck,2);
 assert.deepEqual(calibration.checks.map(c=>[c.id,c.requiredScore??c.requiredScoreLessThan]),[['positive-paraphrase',1],['negated-ordering',0],['reversed-ordering',0],['unrelated-currency',0],['missing-scope',1]]);
});

test('a substantive second-sentence qualification cannot hide behind a save request',()=>{
 const statement='Always list owner first. Except in emergency notes. Please remember this as my working preference.',text='Always list owner first.';
 const seed={statement,proposition:{text,sourceQuote:text,statementSha256:approvedBodyHash(statement),sha256:approvedBodyHash(text)}};
 assert.throws(()=>seedProposition(seed),/substantive suffix/);
});
