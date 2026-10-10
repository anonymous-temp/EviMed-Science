import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
import {evolutionToolArchiveId} from '../src/evolutionService.mjs';
import {DEFAULT_EVOLUTION_POLICY} from '../src/evolutionPolicy.mjs';
const make=async({auditOnly=false,interrupt=false}={})=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service}),calls=new Map(),published=[];
 for(const id of ['a','b'])await pool.add({id,moduleId:'tools',sourceRoot:id,sourceHash:id.repeat(64),pool:'confirmation',scope:'public',reservedHidden:true,curatorIndependent:true,equivalentVariant:{input:{value:1}},abstentionExpected:id==='a'});
 const candidate={id:'candidate',frozenAt:'2026-10-03',policy:{},proposal:{mechanisms:['m']}};
 await f.service.save('archive',candidate.id,{candidate,moduleId:'tools',status:'frozen'});
 await f.service.save('mission','mission',{moduleId:'tools',candidate,status:'frozen',dependencies:[],epoch:'epoch',modelReleasedAt:'2026-10-01',baseline:{policy:{}},successConditions:{slices:[]},auditOnly,kind:'research'});
 let shouldInterrupt=interrupt;
 const adapter={enabled:true,evaluate:async input=>{
  const units=[];
  for(const item of input.batch)for(const suffix of ['',':equivalent']){
   const id=`${item.id}${suffix}`,key=`${input.role}:${input.repeat}:${id}`;
   const unit=await input.checkpointUnit(id,async()=>{
    if(shouldInterrupt&&input.role==='candidate'){shouldInterrupt=false;throw Object.assign(Error('unpaid budget stop'),{code:'usage_budget_exceeded',status:402});}
    calls.set(key,(calls.get(key)??0)+1);return{id,groupId:item.id,score:input.role==='candidate'?0.83:0.8,sourceHash:item.sourceHash};
   });units.push(unit);
  }
  return{status:'measured',pool:'confirmation',units,costCny:1,contextBytes:100,evidenceTier:'exact'};
 },publish:async(c,result)=>{published.push(result);return{status:'published'};}};
 const missions=createEvolutionMissions({service:f.service,taskPool:pool,policy:{},map:{},signals:{},config:{},adapters:{tools:adapter}});
 return{f,missions,calls,published};
};
test('one candidate first answer per unit resumes over an unpaid budget stop and equivalent gain is required',async()=>{
 const fixture=await make({interrupt:true});
 const waiting=await fixture.missions.run({missionId:'mission'});assert.equal(waiting.payload.status,'waiting_confirmation');
 const finished=await fixture.missions.run({missionId:'mission'});assert.equal(finished.payload.status,'complete');assert.equal(fixture.published.length,1);
 assert.ok([...fixture.calls.values()].every(count=>count===1));assert.equal(fixture.calls.size,16);
});
test('a third-module held-out audit can record nonregression without publishing',async()=>{
 const fixture=await make({auditOnly:true});
 const finished=await fixture.missions.run({missionId:'mission'});assert.equal(finished.payload.status,'complete');assert.equal(fixture.published.length,0);
 const verdict=(await fixture.f.service.list('candidate-verdict'))[0];assert.equal(verdict.payload.auditOnly,true);assert.equal(finished.payload.confirmedPromotions,0);
});
test('tools mission dispatches the owned legacy builder and keeps real result identity in its ledger',async()=>{
 const f=evolutionServiceFixture();let seen;
 f.service.callbacks.runToolMission=async payload=>{seen=payload;return{status:'published',digest:'sha256:actual',publication:{id:'actual-tool'},evaluationReceiptHash:'a'.repeat(64)};};
 await f.service.save('mission','mission-tool',{moduleId:'tools',kind:'research',status:'ready',dependencies:[],results:[],opportunityId:'dossier'});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{tools:{enabled:true}}});
 const result=await missions.run({missionId:'mission-tool'});
 assert.equal(seen.missionId,'mission-tool');assert.equal(seen.opportunityId,'dossier');assert.equal(result.payload.status,'complete');assert.equal(result.payload.results[0].publicationId,'actual-tool');
});
test('a waiting tool candidate retains an archive without occupying its later serving identity',async()=>{
 const f=evolutionServiceFixture(),candidate={id:'tool-public-calculation',track:'M',files:{'scripts/sum.py':'def sum(values): return 1\n'}};
 f.service.callbacks.runToolMission=async()=>({status:'repair',candidate});
 await f.service.save('mission','mission-tool',{moduleId:'tools',kind:'research',status:'ready',dependencies:[],results:[]});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{tools:{enabled:true}}});
 await missions.run({missionId:'mission-tool'});
 const archive=await f.service.get(evolutionToolArchiveId(candidate));
 assert.equal(archive.payload.status,'stepping-stone');assert.equal(await f.service.get(candidate.id),null);
 const tool=await f.service.registerTool({id:candidate.id,track:'M',artifactDigest:'published-digest',status:'staged'});
 assert.equal(tool.payload.recordType,'evolution-tool');
 assert.deepEqual((await f.service.get(archive.id)).payload.candidate,candidate);
});
test('finished missions release unused share reservations and free telemetry allocates none',async()=>{
 const f=evolutionServiceFixture();
 const policy={assignedPolicy:async()=>({id:'P',policy:{version:1,budgetShares:{research:0.4,maintenance:0.1}}})};
 const missions=createEvolutionMissions({service:f.service,policy,map:{},taskPool:{},signals:{},config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10}});
 const one=await missions.create({id:'one',moduleId:'tools',category:'research'});
 await f.service.save('mission','one',{...one.payload,status:'complete',researchCostCny:1},one);
 const two=await missions.create({id:'two',moduleId:'tools',category:'research'});assert.equal(two.payload.budget.reservedCny,10);
 const before=(await f.service.list('mission')).length;
 assert.equal(await missions.ensureJob({kind:'evolution-event',payload:{},id:'event'}),null);
 assert.equal((await f.service.list('mission')).length,before);
});
test('multi-day confirmation adds daily funding without resetting mission spend or reservations',async()=>{
 const f=evolutionServiceFixture();let spent=10;
 const P={version:1,budgetShares:{research:0.4}};
 const missions=createEvolutionMissions({service:f.service,policy:{assignedPolicy:async()=>({id:'P',policy:P}),current:async()=>({policy:P})},map:{},taskPool:{},signals:{},cost:async()=>spent,config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10}});
 const initial=await missions.create({id:'multiday',moduleId:'tools',category:'research'});
 assert.equal((await missions.fund(initial)).payload.budget.reservedCny,10);
 f.advance(86400000);const funded=await missions.fund(initial);
 assert.equal(funded.payload.budget.reservedCny,20);assert.equal(funded.payload.researchCostCny,10);assert.equal(funded.payload.budget.tranches.length,2);
 assert.equal((await missions.fund(funded)).payload.budget.reservedCny,20);
 spent=20;f.advance(86400000);const third=await missions.fund(funded);
 assert.equal(third.payload.budget.reservedCny,30);assert.equal(third.payload.budget.tranches[2].spentBefore,20);
});
test('a sealed promotion verdict awaits a concrete publication without reporting adoption',async()=>{
 const fixture=await make();let publishes=0;
 fixture.missions.register({tools:{...fixture.missions.adapters.tools,publish:async()=>{publishes++;return{status:'review',reason:'code-change-requires-release-pr'};}}});
 const first=await fixture.missions.run({missionId:'mission'});
 assert.equal(first.payload.status,'waiting_resource');assert.equal(first.payload.confirmedPromotions,0);assert.equal(first.payload.reason,'code-change-requires-release-pr');
 const callCount=fixture.calls.size;
 await fixture.missions.run({missionId:'mission'});assert.equal(fixture.calls.size,callCount);assert.equal(publishes,2);
 assert.equal((await fixture.f.service.get('candidate')).payload.status,'frozen');
});
test('measurement integrity requires every frozen original and equivalent unit exactly once',async()=>{
 const {validateEvolutionMeasurements}=await import('../src/evolutionMissions.mjs');
 const batch=[{id:'a',sourceHash:'hash',equivalentVariant:{input:{}}}];
 const units=[{id:'a',groupId:'a',sourceHash:'hash',score:0.9},{id:'a:equivalent',groupId:'a',sourceHash:'hash',score:0.9}];
 assert.deepEqual(validateEvolutionMeasurements(batch,{units}),[]);
 assert.ok(validateEvolutionMeasurements(batch,{units:[units[0],units[0]]}).includes('frozen-batch-incomplete'));
 assert.ok(validateEvolutionMeasurements(batch,{units:units.map(unit=>({...unit,sourceHash:'changed'}))}).includes('source-or-group-mismatch'));
 assert.ok(validateEvolutionMeasurements(batch,{units:units.map(unit=>({...unit,score:1.1}))}).includes('score-outside-full-scale'));
});
test('module activation is idempotent and never replaces a newer incompatible baseline',async()=>{
 const f=evolutionServiceFixture(),missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{}});
 const {createHash}=await import('node:crypto');const {canonicalJson}=await import('@evimed/domain');
 const candidate={id:'module-candidate',policy:{plannerInstructions:'A bounded planner.'}};
 const hash=createHash('sha256').update(canonicalJson(candidate)).digest('hex');
 await f.service.save('mission','publish-mission',{baseline:{revisionId:'default:old'}});
 await f.service.save('candidate-verdict','module-verdict',{promote:true,confirmatory:true,receiptValid:true,firstAttempt:true,moduleId:'autopilot',candidateId:candidate.id,candidateHash:hash,missionId:'publish-mission'});
 const first=await missions.publish('autopilot',candidate,{verdictId:'module-verdict'});
 const repeated=await missions.publish('autopilot',candidate,{verdictId:'module-verdict'});assert.deepEqual(repeated,first);
 const active=await f.service.get('evolution-module-policy-autopilot');assert.equal(active.revision,1);
 await f.service.save('module-policy',active.id,{...active.payload,revisionId:'newer',candidateId:'newer',verdictId:'newer'},active);
 assert.equal((await missions.publish('autopilot',candidate,{verdictId:'module-verdict'})).reason,'baseline-changed-reconfirmation-required');
 assert.equal((await f.service.get(active.id)).payload.candidateId,'newer');
});
test('code-only module missions produce review inputs without claiming a promotion',async()=>{
 const f=evolutionServiceFixture();f.service.callbacks.runModuleEngineMission=async()=>({status:'review',review:{identity:'review-1',bundlePath:'actual-bundle'}});
 await f.service.save('mission','engine-module',{moduleId:'memory',status:'ready',dependencies:[],kind:'research'});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{memory:{enabled:true}}});
 const result=await missions.run({missionId:'engine-module'});
 // The mission's work is the review input; what a human does with it is not this mission's to wait for (review D-E3).
 assert.equal(result.payload.status,'complete');assert.equal(result.payload.completed,true);assert.deepEqual(result.payload.result,{outcome:'review-prepared',reviewId:'review-1'});
 assert.equal(result.payload.lastResult,'review');assert.equal(result.payload.engineReview.bundlePath,'actual-bundle');assert.equal(result.payload.confirmedPromotions,0);
});
test('a repair requires an independent executed public failure receipt rather than a proposer boolean',async()=>{
 const {validEvolutionFailureReproduction,evolutionFailureReproductionHash}=await import('../src/evolutionMissions.mjs');
 const {createHash}=await import('node:crypto'),{canonicalJson}=await import('@evimed/domain');
 const baseline={revisionId:'default:base',policy:{}};
 const identity={missionId:'mission',moduleId:'autopilot',baseline};
 const record={recordType:'evolution-failure-reproduction',missionId:'mission',moduleId:'autopilot',baselineHash:createHash('sha256').update(canonicalJson(baseline)).digest('hex'),scope:'public',independent:true,executed:true,baselineFailed:true,referenceVerified:true,taskId:'public-regression',sourceRoot:'public-study',sourceHash:'a'.repeat(64),executionReceiptHash:'b'.repeat(64)};
 record.receiptHash=evolutionFailureReproductionHash(record);assert.equal(validEvolutionFailureReproduction(record,identity),true);
 assert.equal(validEvolutionFailureReproduction({...record,scope:'tenant'},identity),false);
 assert.equal(validEvolutionFailureReproduction({...record,executed:false},identity),false);
 assert.equal(validEvolutionFailureReproduction(record,{...identity,baseline:{...baseline,revisionId:'changed'}}),false);
 const f=evolutionServiceFixture();await f.service.save('mission','repair-mission',{moduleId:'autopilot',status:'ready',dependencies:[],sources:['repair'],kind:'research',preparedCandidateState:{candidate:{policy:{plannerInstructions:'Changed'},proposal:{opportunityKind:'repair',failureReproduced:true}},baseline}});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{autopilot:{enabled:true}}});
 assert.equal((await missions.run({missionId:'repair-mission'})).payload.reason,'repair-failure-reproduction-required');
});
test('smoke budget deferral preserves the prepared proposal and completed first answers',async()=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service}),calls=new Map();let proposals=0,stop=true;
 for(const id of ['a','b'])await pool.add({id,moduleId:'autopilot',sourceRoot:`public:${id}`,sourceHash:id.repeat(64),scope:'public',pool:'development',baselineKnownCorrect:true});
 const candidate={policy:{plannerInstructions:'Revised planner.'},proposal:{components:['plannerInstructions'],mechanisms:['m'],change:'Change the planner.',reason:'Improve bounded planning.',rollbackVersion:'default',predictedBenefits:[],possibleHarms:[],costChange:0}};
 const adapter={enabled:true,propose:async()=>{proposals++;return candidate;},prepare:async value=>({status:'prepared',candidate:value,baseline:{policy:{plannerInstructions:'Baseline'},revisionId:'default:baseline'}}),smoke:async input=>{
  for(const item of input.batch)await input.checkpointUnit(item.id,async()=>{
   if(input.arm==='candidate'&&stop){stop=false;throw Object.assign(Error('unpaid'),{code:'usage_budget_exceeded',status:402});}
   const key=`${input.arm}:${item.id}`;calls.set(key,(calls.get(key)??0)+1);return{score:1};
  });return{passed:true};
 }};
 await f.service.save('mission','smoke-mission',{moduleId:'autopilot',kind:'research',status:'ready',dependencies:[],round:1,maxRounds:10,epoch:'epoch',successConditions:{},sources:[]});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:pool,signals:{},config:{},screen:async()=>({passed:true}),adapters:{autopilot:adapter}});
 const waiting=await missions.run({missionId:'smoke-mission'});assert.equal(waiting.payload.reason,'development-budget');assert.ok(waiting.payload.preparedCandidateState);
 const resumed=await missions.run({missionId:'smoke-mission'});assert.equal(resumed.payload.status,'waiting_confirmation');assert.equal(proposals,1);assert.equal(calls.size,4);assert.ok([...calls.values()].every(count=>count===1));assert.ok(resumed.payload.candidate.frozenAt);
});
test('resource acquisition resumes only a new matched resource, with a new bounded window',async()=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});
 const missions=createEvolutionMissions({service:f.service,taskPool:pool,policy:{},map:{},signals:{},config:{},adapters:{}});
 await f.service.save('mission','stopped',{moduleId:'memory',kind:'acquire-resource',status:'waiting_resource',resourceStopped:true,resourceAttempts:3,resourceWindowStartedAt:'2026-08-01',wakeConditions:['new-data'],dependencies:[]});
 assert.deepEqual(await missions.wake({type:'budget-window'}),[]);
 assert.deepEqual(await missions.wake({type:'dataset-ready',semanticsMatched:false}),[]);
 assert.deepEqual(await missions.wake({type:'dataset-ready',semanticsMatched:true}),['stopped']);
 const row=await f.service.get('stopped');assert.equal(row.payload.resourceAttempts,0);assert.equal(row.payload.resourceStopped,false);assert.equal(row.payload.resourceWindowStartedAt,f.service.now().toISOString());
});

// The weekly planner, with the policy, map and signals it reads reduced to doubles.
const planner=(adapters,{callbacks={},config={}}={})=>{
 const f=evolutionServiceFixture(),P=DEFAULT_EVOLUTION_POLICY;Object.assign(f.service.callbacks,callbacks);
 const missions=createEvolutionMissions({service:f.service,policy:{assignedPolicy:async()=>({id:'P',policy:P}),current:async()=>({policy:P})},map:{rebuild:async()=>({counts:{}})},taskPool:{},signals:{aggregate:async()=>[]},
  config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10,...config},adapters});
 return{f,missions};
};
const WEEK=7*86400000;
const opportunity=(missions,id,moduleId,{failures=1,prerequisites}={})=>missions.opportunity({id,moduleId,sources:['repair'],taskFamily:id,mechanismFamily:id,evidenceRoots:[id],features:{runtimeFailures:failures},...(prerequisites?{prerequisites}:{})});
test('an engine module answers an opportunity with a review input and plans its next opportunity the week after',async()=>{
 const {f,missions}=planner({runtime:{enabled:true}},{callbacks:{runModuleEngineMission:async()=>({status:'review',review:{identity:'review-1'}})}});
 await opportunity(missions,'opp-a','runtime',{failures:30});await opportunity(missions,'opp-b','runtime',{failures:3});
 const first=await missions.plan({week:'2026-10-05'});assert.equal(first.missions.length,1);
 const done=await missions.run({missionId:first.missions[0]});
 assert.equal(done.payload.opportunityId,'opp-a');assert.equal(done.payload.status,'complete');assert.deepEqual(done.payload.result,{outcome:'review-prepared',reviewId:'review-1'});
 const answered=await f.service.get('opp-a');assert.equal(answered.payload.status,'review');assert.equal(answered.payload.review.reviewId,'review-1');
 f.advance(WEEK);
 const second=await missions.plan({week:'2026-10-12'});assert.equal(second.missions.length,1);
 assert.equal((await f.service.get(second.missions[0])).payload.opportunityId,'opp-b');
 await missions.run({missionId:second.missions[0]});f.advance(WEEK);
 const third=await missions.plan({week:'2026-10-19'});
 assert.deepEqual((await Promise.all(third.missions.map(id=>f.service.get(id)))).map(row=>row.payload.kind),['baseline-audit'],'an answered opportunity is not worked a second time');
});
test('a mission parked past its resource window ends deferred; its opportunity keeps the wake conditions and comes back on a matching event',async()=>{
 const {f,missions}=planner({tools:{enabled:true}},{callbacks:{acquireResource:async()=>({ready:false,reason:'pending',wakeConditions:['new-data']})}});
 await opportunity(missions,'availability','tools',{failures:60,prerequisites:['measured-execution-reference']});await opportunity(missions,'paper','tools',{failures:30});
 const first=await missions.plan({week:'2026-10-05'});
 const parked=await missions.run({missionId:first.missions[0]});assert.equal(parked.payload.opportunityId,'availability');assert.equal(parked.payload.status,'waiting_resource');
 f.advance(15*86400000);
 const later=await missions.plan({week:'2026-10-19'});
 const deferred=await f.service.get(first.missions[0]);assert.equal(deferred.payload.status,'deferred');assert.ok(deferred.payload.deferredAt);
 const dossier=await f.service.get('availability');assert.equal(dossier.payload.deferred,true);assert.equal(dossier.payload.deferredAt,deferred.payload.deferredAt);assert.deepEqual(dossier.payload.wakeConditions,['new-data']);
 assert.deepEqual((await Promise.all(later.missions.map(id=>f.service.get(id)))).map(row=>row.payload.opportunityId),['paper'],'the module is not held by the deferred opportunity');
 await missions.wake({type:'tool-ready'});assert.equal((await f.service.get('availability')).payload.deferred,true,'an event the opportunity does not wait for leaves it deferred');
 await missions.wake({type:'dataset-ready',semanticsMatched:false});assert.equal((await f.service.get('availability')).payload.deferred,true,'a dataset that does not match its semantics is not a new resource');
 await missions.wake({type:'dataset-ready',semanticsMatched:true});
 const reopened=await f.service.get('availability');assert.equal(reopened.payload.deferred,false);assert.equal(reopened.payload.deferredAt,null);assert.deepEqual(reopened.payload.wakeConditions,[]);
 // A deferral also ends when what the opportunity rests on changes.
 await f.service.save('dossier','availability',{...reopened.payload,deferred:true,deferredAt:'2026-10-19T00:00:00.000Z',wakeConditions:['new-tool']},reopened);
 await opportunity(missions,'availability','tools',{failures:61,prerequisites:['measured-execution-reference']});
 assert.equal((await f.service.get('availability')).payload.deferred,false);
});
test('a repair that cannot reproduce its failure is deferred when its window has passed, whatever woke nothing in the meantime',async()=>{
 const {f,missions}=planner({autopilot:{enabled:true}});
 await opportunity(missions,'repair-opportunity','autopilot',{failures:5});
 await f.service.save('mission','repair-parked',{moduleId:'autopilot',kind:'research',status:'waiting_resource',reason:'repair-failure-reproduction-required',opportunityId:'repair-opportunity',week:'2026-09-14',
  createdAt:f.service.now().toISOString(),wakeConditions:[],dependencies:[],budget:{category:'research',reservedCny:10}});
 f.advance(13*86400000);await missions.plan({week:'2026-10-12'});
 assert.equal((await f.service.get('repair-parked')).payload.status,'waiting_resource','inside its window it is left alone');
 f.advance(2*86400000);await missions.plan({week:'2026-10-19'});
 const row=await f.service.get('repair-parked');assert.equal(row.payload.status,'deferred');assert.equal(row.payload.reason,'repair-failure-reproduction-required');
 assert.deepEqual((await f.service.get('repair-opportunity')).payload.wakeConditions,['new-data','new-method','new-tool','new-model'],'a mission parked with no wake condition leaves the closed default');
});
test('a module whose best opportunity is parked inside its resource window takes the next-ranked one the week after',async()=>{
 const {f,missions}=planner({tools:{enabled:true}},{callbacks:{acquireResource:async()=>({ready:false,reason:'pending',wakeConditions:['new-data']})}});
 const opportunities=async plan=>(await Promise.all(plan.missions.map(id=>f.service.get(id)))).map(row=>row.payload.opportunityId);
 await opportunity(missions,'availability','tools',{failures:60,prerequisites:['measured-execution-reference']});await opportunity(missions,'paper','tools',{failures:30});
 const first=await missions.plan({week:'2026-10-05'});assert.deepEqual(await opportunities(first),['availability']);
 const parked=await missions.run({missionId:first.missions[0]});assert.equal(parked.payload.status,'waiting_resource');
 f.advance(WEEK);
 const second=await missions.plan({week:'2026-10-12'});
 assert.deepEqual(await opportunities(second),['paper'],'the parked opportunity holds the module');
 const decision=(await f.service.get(second.missions[0])).payload.decisions.find(item=>item.policyField==='weights');
 assert.deepEqual([decision.choice,decision.opportunities.map(item=>item.id)],['paper',['paper']],'the recorded choice names what could be chosen, so a replay under other weights sees the same options');
 assert.equal((await f.service.get(first.missions[0])).payload.resourceAttempts,1,'planning does not run a parked mission again');
 assert.deepEqual((await missions.plan({week:'2026-10-12'})).missions,[],'one mission per module and week');
 f.advance(6*86400000);
 assert.deepEqual((await missions.plan({week:'2026-10-19'})).missions,[],'every opportunity of the module has an open mission');
});
