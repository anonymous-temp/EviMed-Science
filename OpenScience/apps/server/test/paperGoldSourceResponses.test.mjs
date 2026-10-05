import test from 'node:test';
import assert from 'node:assert/strict';
import {paperGoldSourceResponses,paperGoldTraceCoverage,readPaperGoldNativeCoverage,paperGoldExposureTier} from '../src/paperGoldEvaluator.mjs';
test('requested and self-emitted DOI before failed or blocked retrieval is not observed exposure',()=>{
 const trace=paperGoldSourceResponses({messages:[{role:'assistant',parts:[{type:'text',text:'10.1136/bmj.n71'}]},{role:'user',parts:[{type:'text',text:'10.1136/bmj.n71'}]},{parts:[{type:'tool',tool:'web_read',status:'completed',input:{doi:'10.1136/bmj.n71'},output:'Error: HTTP 502'}]},{parts:[{type:'tool',tool:'web_read',status:'completed',output:{status:'error',data:{doi:'10.1136/bmj.n71',code:'evaluation_source_excluded'}}}]}]});
 assert.deepEqual(trace.responses,[]);assert.equal(trace.complete,true);
});
test('actual PRISMA target body in successful MCP and socket envelopes is preserved for exposure audit',()=>{
 for(const output of [{status:'ok',data:{doi:'10.1136/bmj.n71',body:'PRISMA 2020 systematic reviews introduction methods discussion'}},'ok\n'+JSON.stringify({doi:'10.1136/bmj.n71',body:'PRISMA 2020 systematic reviews'})]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,true);assert.equal(trace.responses.length,1);assert.equal(trace.responses[0].data.doi,'10.1136/bmj.n71');
 }
});
test('unparseable or unfinished source responses cannot prove complete trace',()=>{
 for(const part of [{type:'tool',tool:'web_read',status:'completed',output:'unparseable'},{type:'tool',tool:'web_search',status:'pending'}])assert.equal(paperGoldSourceResponses({messages:[{parts:[part]}]}).complete,false);
});

test('successful unknown envelope cannot silently lose a target body or prove unexposed',()=>{
 for(const output of [{ok:true,text:'10.1136/bmj.n71 PRISMA target body'},{ok:true,result:{doi:'10.1136/bmj.n71'}},{status:'ok',results:[{doi:'10.1136/bmj.n71'}]},{ok:true}]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,false);assert.equal(trace.responses.length,0);
 }
});
test('native socket plain returned body and nested MCP JSON remain observable',()=>{
 for(const output of ['ok\n10.1136/bmj.n71 PRISMA returned primary body',{content:[{type:'text',text:JSON.stringify({status:'ok',data:{doi:'10.1136/bmj.n71',body:'PRISMA returned primary body'}})}]}]){
  const trace=paperGoldSourceResponses({messages:[{parts:[{type:'tool',tool:'web_read',status:'completed',output}]}]});assert.equal(trace.complete,true);assert.match(JSON.stringify(trace.responses),/10.1136\/bmj.n71/);
 }
});

test('native arbitrary execution without independently proven network fence is unknown',()=>{
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'tool',tool:'bash',status:'completed',output:'done'}]}]}).complete,false);
});

test('trusted verifier binds current producer; forged transcript proof or rejected stale/different run never covers native tools',async()=>{
 const transcript={nativeCoverageVerified:true,proofHash:'a'.repeat(64),messages:[{parts:[{type:'tool',tool:'bash',status:'completed'}]}]};
 assert.equal(paperGoldTraceCoverage(transcript).complete,false);
 const project={id:'actual-project'},run={id:'actual-run'};
 for(const reason of ['run_identity_changed','start_after_prompt','runtime_generation_changed']){
  const proof=await readPaperGoldNativeCoverage({project,run,runtimeManager:{verifyRunEgressCoverage:async request=>{assert.equal(request.project,project);assert.equal(request.run,run);return {nativeCoverageVerified:false,proofHash:'a'.repeat(64),startProofHash:'b'.repeat(64),endProofHash:'c'.repeat(64),reason};}}});assert.equal(paperGoldTraceCoverage(transcript,proof).complete,false);
 }
 const valid={nativeCoverageVerified:true,proofHash:'a'.repeat(64),startProofHash:'b'.repeat(64),endProofHash:'c'.repeat(64)};
 assert.equal(paperGoldTraceCoverage(transcript,valid).complete,true);
 assert.equal(paperGoldTraceCoverage(transcript,{...valid,startProofHash:null}).complete,false);
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'tool',tool:'meta_analysis',input:{action:'start'}}]}]},valid).complete,false);
});
test('observed target exposure takes precedence while incomplete coverage never proves unexposed',()=>{
 for(const tier of ['cited','exposed_uncited'])assert.equal(paperGoldExposureTier({audit:{tier},durableComplete:false,traceCoverage:{complete:false},sourceTrace:{complete:false}}),tier);
 assert.equal(paperGoldExposureTier({audit:{tier:'unexposed'},durableComplete:true,traceCoverage:{complete:false},sourceTrace:{complete:true}}),'unknown');
});
