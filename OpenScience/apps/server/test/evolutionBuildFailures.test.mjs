import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvolutionBuilder } from '../src/evolutionBuild.mjs';
test('completed hidden evaluation failures are durable opaque findings; unavailable references are resources',async()=>{
  // The hidden cases' own ids name their publications; what reaches the builder and the failure record must not.
  const failures=[];let result={ok:false,status:'repair',evaluatorHash:'a'.repeat(64),failedCaseIds:['darth-time-dependent','marker-net-benefit']};
  const builder=createEvolutionBuilder({dispatch:async()=>({id:'candidate',publicationKind:'isolated-tool',entrypoint:'scripts/a.py:a',files:{'SKILL.md':'Public instructions','scripts/a.py':'pass'}}),verification:{verify:async()=>({ok:true})},evaluator:{evaluate:async()=>result},publisher:{publish:async()=>{throw new Error('failed candidate cannot publish');}},recordFailure:async failure=>failures.push(failure)});
  const built=await builder.build({id:'dossier'});assert.equal(built.status,'repair');
  assert.equal(built.feedback.failedCaseIds.length,2);assert.ok(built.feedback.failedCaseIds.every(id=>/^case-[a-f0-9]{16}$/.test(id)));assert.equal(new Set(built.feedback.failedCaseIds).size,2);
  assert.doesNotMatch(JSON.stringify([built,failures]),/darth|marker|net-benefit|time-dependent/);
  assert.deepEqual(failures,[{cardId:'dossier',code:'method_implementation',gapCode:'method-implementation',failedCaseIds:built.feedback.failedCaseIds}]);
  // The same case fails under the same token next time, and under another once the definition changes.
  assert.deepEqual((await builder.build({id:'dossier'})).feedback.failedCaseIds,built.feedback.failedCaseIds);failures.pop();
  result={...result,evaluatorHash:'b'.repeat(64)};assert.notDeepEqual((await builder.build({id:'dossier'})).feedback.failedCaseIds,built.feedback.failedCaseIds);failures.pop();
  // A behavioural failure reaches the builder as one closed code and no case at all.
  result={ok:false,status:'repair',evaluatorHash:'a'.repeat(64),failedCaseIds:[],issueCodes:['candidate_generalisation_failed']};
  assert.deepEqual((await builder.build({id:'dossier'})).feedback,{passed:false,failedCaseIds:[],issueCodes:['candidate_generalisation_failed']});assert.equal(failures.length,1);
  result={ok:false,status:'waiting_resource',resourceCode:'hidden_reference_cases_missing',failedCaseIds:[]};
  await builder.build({id:'dossier'});assert.equal(failures.length,1);
  result={ok:false,status:'waiting_resource',failedCaseIds:['execution-resource-case']};
  await builder.build({id:'dossier'});assert.equal(failures.length,1);
});

test('actual new capability manifest rejection becomes durable public repair feedback, while infrastructure errors propagate',async()=>{
 const {createEvolutionEngineReviewWriter}=await import('../src/evolutionEngineReview.mjs');
 const {HttpError}=await import('../src/security.mjs');
 const failures=[];
 const candidate={publicationKind:'engine-pr',files:{'SKILL.md':'Declared public candidate'}};
 const dependencies={dispatch:async()=>candidate,verification:{verify:async()=>{throw Error('must not validate engine review as isolated tool');}},evaluator:{evaluate:async()=>{throw Error('must not evaluate malformed manifest');}},publisher:{publish:async()=>{throw Error('must not publish malformed manifest');}},recordFailure:async failure=>failures.push(failure)};
 const builder=createEvolutionBuilder({...dependencies,writeEnginePrInput:createEvolutionEngineReviewWriter({dataDir:'/unused'})});
 const result=await builder.build({id:'missing-manifest',form:'new-capability'});
 assert.equal(result.status,'repair');assert.equal(failures[0].gapCode,'method-implementation');
 assert.equal(result.feedback.issues[0].message,'A new capability requires exactly one capability.yaml.');
 assert.equal(result.feedback.issues[0].stage,'engine-review');assert.deepEqual(candidate.files,{'SKILL.md':'Declared public candidate'});
 const unavailable=createEvolutionBuilder({...dependencies,writeEnginePrInput:async()=>{throw new HttpError(503,'product_state_unavailable','Review storage unavailable');}});
 await assert.rejects(unavailable.build({id:'resource'}),error=>error.code==='product_state_unavailable');assert.equal(failures.length,1);
});


test('actual malformed candidate file maps become repair without relaxing hydration or swallowing infrastructure failures',async()=>{
 const {hydrateCandidateFiles}=await import('../src/evolutionRuns.mjs');
 const {HttpError}=await import('../src/security.mjs');
 const failures=[];const candidate={publicationKind:'isolated-tool',files:['script.py']};
 const dependencies={dispatch:async()=>hydrateCandidateFiles({}, {},candidate),verification:{verify:async()=>{throw Error('malformed files must not reach verification');}},evaluator:{evaluate:async()=>{throw Error('malformed files must not reach hidden evaluation');}},publisher:{publish:async()=>{throw Error('malformed files must not publish');}},recordFailure:async failure=>failures.push(failure)};
 const result=await createEvolutionBuilder(dependencies).build({id:'invalid-files'});
 assert.equal(result.status,'repair');assert.deepEqual(result.feedback.issueCodes,['evolution_output_invalid']);
 assert.equal(result.feedback.issues[0].message,'Candidate files must be a named map.');
 assert.equal(result.feedback.issues[0].stage,'candidate-delivery');assert.equal(failures[0].gapCode,'method-implementation');
 assert.deepEqual(candidate.files,['script.py']);
 for(const error of [new HttpError(503,'evolution_output_invalid','Storage unavailable'),new HttpError(409,'evolution_output_missing','Delivery not available'),Object.assign(new Error('disk unavailable'),{code:'EIO'})]){
  await assert.rejects(createEvolutionBuilder({...dependencies,dispatch:async()=>{throw error;}}).build({id:'unavailable'}),failure=>failure===error);
 }
 assert.equal(failures.length,1);
});
