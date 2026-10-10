import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GEO_SPECIFIED_TOPICS} from '@evimed/domain';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions,evolutionDeterministicChecks} from '../src/evolutionMissions.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
import {createModuleEvolutionEvaluators} from '../src/moduleEvolutionEvaluators.mjs';

// The promotion bars (review D-E19). Autopilot's decisions are checked against closed expected actions, a written checklist, so it is no longer a model
// score that has to be calibrated and none ever was. Frontier and 循证 GEO are model-scored; the numbers they check by code count as the share of units
// that pass against the incumbent's share, not as "every unit of one run came out perfect".

// ---- the evaluators: what each unit reports
const cases=JSON.parse(await readFile(new URL('../../../evals/autopilot-next-action/cases.json',import.meta.url),'utf8')).cases;
const bound={userId:'operator',projectId:'evimed-evolution',missionId:'evolution-mission-test',pool:'confirmation',arm:'candidate',candidate:{},checkpointUnit:null};
test('autopilot is a checklist: the share of expected actions met, with no judge to calibrate',async()=>{
 const batch=cases.slice(0,3);
 const decisions=new Map([[batch[0].id,batch[0].expect[0]],[batch[1].id,batch[1].expect[1]],[batch[2].id,{action:'run',taskType:'not-an-expected-type'}]]);
 const planner={config:{},model:'fake',decide:async({episodeId})=>({...decisions.get(episodeId.split(':').at(-1)),policyRevisionId:'revision'})};
 const result=await createModuleEvolutionEvaluators({planner}).autopilot({...bound,batch,pool:'development'});
 assert.deepEqual(result.units.map(unit=>unit.score),[1,1,0]);
 assert.equal(result.evidenceTier,'checklist');assert.equal(result.checkScope,'closed-expected-actions');assert.equal(result.evaluatorVersion,'autopilot-checklist-v1');
 assert.equal('deterministicChecksPassed' in result,false,'a checklist claims no deterministic-check flag of its own');
});
test('a frontier unit says whether its numbers were checked and right, and the run claims no "all passed"',async()=>{
 let right=true;
 const editor={config:{},model:'fake',edit:async()=>({output:{lane:'research'},numbers:{missing:right?[]:['12 of 100'],unitMismatches:[]},modelInput:'source text',modelInputSha256:'a'.repeat(64),verification:'passed',editorVersion:'edit-v1'})};
 const runner=createModuleEvolutionEvaluators({editor,judgeFrontier:async()=>({supported:true})}).frontier;
 const item={id:'paper-1',expect:['research'],edit:{},sourceHash:'b'.repeat(64)};
 const good=await runner({...bound,batch:[item]});
 assert.deepEqual(good.units.map(unit=>[unit.deterministicPassed,unit.score]),[[true,1]]);assert.equal(good.evidenceTier,'model');assert.equal('deterministicChecksPassed' in good,false);
 right=false;
 const bad=await runner({...bound,batch:[item]});
 assert.deepEqual(bad.units.map(unit=>[unit.deterministicPassed,unit.score]),[[false,0]],'the failure is in the unit and in its score');
});
test('a 循证 GEO unit says whether it stated a quantity its claims do not',async()=>{
 let answer='The dose is 5 mg.';
 const geoJudge={model:'fake',judge:async()=>({statements:[{topic:GEO_SPECIFIED_TOPICS[0],verdict:'correct'}],checks:{omittedSafety:[],offLabel:[]},dropped:[],refusal:false})};
 const runner=createModuleEvolutionEvaluators({geoJudge,generateGeo:async()=>({text:answer})}).geo;
 const item={id:'card-1',claims:[{quote:'The dose is 5 mg.'}],question:'What is the dose?',sourceHash:'c'.repeat(64)};
 const grounded=await runner({...bound,batch:[item]});
 assert.deepEqual(grounded.units.map(unit=>[unit.deterministicPassed,unit.score]),[[true,1]]);assert.equal('deterministicChecksPassed' in grounded,false);
 answer='The dose is 50 mg.';
 const invented=await runner({...bound,batch:[item]});
 assert.deepEqual(invented.units.map(unit=>[unit.deterministicPassed,unit.score]),[[false,0]]);
});

// ---- the comparison with the incumbent
const unit=(id,group,passed,extra={})=>({id,groupId:group,score:1,deterministicPassed:passed,...extra});
const run=flags=>({units:flags.flatMap(([group,passed])=>[unit(group,group,passed),unit(`${group}:equivalent`,group,passed)])});
const baselines=flags=>[run(flags),run(flags),run(flags)];
test('the share of units whose check passed is compared with the incumbent\'s, within the noise of its own repeats',()=>{
 // The incumbent gets one group wrong in every run; a candidate that gets the same one wrong is no worse, though not every unit passed.
 const same=evolutionDeterministicChecks(run([['a',true],['b',true],['c',false]]),baselines([['a',true],['b',true],['c',false]]));
 assert.deepEqual([same.ran,same.nonInferior,same.regressed],[true,true,false]);assert.ok(Math.abs(same.candidate-2/3)<1e-9&&Math.abs(same.baseline-2/3)<1e-9);assert.equal(same.delta,0.02);
 const better=evolutionDeterministicChecks(run([['a',true],['b',true],['c',true]]),baselines([['a',true],['b',true],['c',false]]));
 assert.equal(better.nonInferior,true);
 const worse=evolutionDeterministicChecks(run([['a',true],['b',false],['c',false]]),baselines([['a',true],['b',true],['c',false]]));
 assert.deepEqual([worse.ran,worse.nonInferior,worse.regressed],[true,false,true]);
 // The incumbent\'s own repeats set the band: when they disagree a lot, a small difference is noise.
 const noisy=[run([['a',true],['b',true],['c',true],['d',true]]),run([['a',false],['b',true],['c',false],['d',true]]),run([['a',true],['b',false],['c',true],['d',false]])];
 const within=evolutionDeterministicChecks(run([['a',true],['b',true],['c',false],['d',true]]),noisy);
 assert.equal(within.regressed,false,'0.75 against a mean of 0.67 is inside a band of '+within.delta.toFixed(2));
 // A group a unit of either side lacks, a missing check, or fewer than three baselines: nothing was measured.
 for(const [label,candidate,base] of [['no check on a unit',{units:[{id:'a',groupId:'a',score:1}]},baselines([['a',true]])],['groups differ',run([['x',true]]),baselines([['a',true]])],['two baselines',run([['a',true]]),baselines([['a',true]]).slice(0,2)],['empty',{units:[]},baselines([['a',true]])]])
  assert.deepEqual(evolutionDeterministicChecks(candidate,base),{ran:false,nonInferior:false,regressed:false},label);
 // Units kept from before the evaluators named the check read it from their slices.
 const legacy=evolutionDeterministicChecks({units:[{id:'a',groupId:'a',score:1,slices:{numbers:true}},{id:'b',groupId:'b',score:1,slices:{unsupportedNumbers:0}}]},baselines([['a',true],['b',true]]));
 assert.equal(legacy.ran,true);assert.equal(legacy.nonInferior,true);
});

// ---- the whole decision, through a mission
const mission=async({tier='model',calibrated=true,baselineFlags,candidateFlags,baselineScore=0.5,candidateScore=0.9,flags=true})=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});
 for(const id of ['a','b'])await pool.add({id,moduleId:'tools',sourceRoot:id,sourceHash:id.repeat(64),pool:'confirmation',scope:'public',reservedHidden:true,curatorIndependent:true,equivalentVariant:{input:{value:1}},abstentionExpected:id==='a'});
 const candidate={id:'candidate',frozenAt:'2026-10-03',policy:{},proposal:{mechanisms:['m']}};
 await f.service.save('archive',candidate.id,{candidate,moduleId:'tools',status:'frozen'});
 await f.service.save('mission','mission',{moduleId:'tools',candidate,status:'frozen',dependencies:[],epoch:'epoch',modelReleasedAt:'2026-10-01',baseline:{policy:{}},successConditions:{slices:[]},kind:'research'});
 const adapter={enabled:true,publish:async()=>({status:'published'}),evaluate:async input=>{
  const arm=input.role==='candidate'?candidateFlags:baselineFlags,units=[];
  for(const item of input.batch)for(const suffix of ['',':equivalent']){
   const id=`${item.id}${suffix}`;
   units.push(await input.checkpointUnit(id,async()=>({id,groupId:item.id,sourceHash:item.sourceHash,score:input.role==='candidate'?candidateScore:baselineScore,...(flags?{deterministicPassed:arm[item.id]}:{})})));
  }
  return{status:'measured',pool:'confirmation',units,costCny:1,contextBytes:100,evidenceTier:tier,anchorCalibrated:calibrated};
 }};
 const missions=createEvolutionMissions({service:f.service,taskPool:pool,policy:{},map:{},signals:{},config:{},adapters:{tools:adapter}});
 await missions.run({missionId:'mission'});
 return(await f.service.list('candidate-verdict'))[0].payload;
};
test('a model-scored candidate that gains is promoted although the incumbent, and so the candidate, gets some numbers wrong',async()=>{
 const verdict=await mission({baselineFlags:{a:true,b:false},candidateFlags:{a:true,b:false}});
 assert.deepEqual([verdict.outcome,verdict.promote,verdict.deterministicChecksPassed],['improved',true,true]);
 assert.equal(verdict.deterministic.ran,true);assert.equal(verdict.deterministic.regressed,false);
});
test('a model-scored candidate that gains but checks out worse than the incumbent on its numbers is a regression, not invalid evidence',async()=>{
 const verdict=await mission({baselineFlags:{a:true,b:true},candidateFlags:{a:true,b:false}});
 assert.deepEqual([verdict.outcome,verdict.reason,verdict.promote],['regressed','deterministic-check-regressed',false]);
 assert.equal(verdict.deterministic.regressed,true);
});
test('checks that did not run, or a scorer that was not calibrated, still stop a model-scored promotion, for the reason that is true',async()=>{
 const missing=await mission({baselineFlags:{},candidateFlags:{},flags:false});
 assert.deepEqual([missing.outcome,missing.reason],['invalid-evidence','deterministic-checks-missing']);assert.equal(missing.deterministic.ran,false);
 const uncalibrated=await mission({baselineFlags:{a:true,b:true},candidateFlags:{a:true,b:true},calibrated:false});
 assert.deepEqual([uncalibrated.outcome,uncalibrated.reason],['invalid-evidence','model-score-not-calibrated']);
});
test('a checklist-scored candidate is promoted on its gain over the incumbent with no calibration and no flags, and is not promoted on a loss',async()=>{
 const gain=await mission({tier:'checklist',calibrated:false,flags:false,baselineFlags:{},candidateFlags:{}});
 assert.deepEqual([gain.outcome,gain.promote,gain.evidenceTier],['improved',true,'checklist']);
 const loss=await mission({tier:'checklist',calibrated:false,flags:false,baselineFlags:{},candidateFlags:{},candidateScore:0.3});
 assert.deepEqual([loss.outcome,loss.promote],['regressed',false]);
});
