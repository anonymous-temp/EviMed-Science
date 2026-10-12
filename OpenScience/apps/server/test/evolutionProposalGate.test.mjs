import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions,validEvolutionFailureReproduction,evolutionFailureReproductionHash} from '../src/evolutionMissions.mjs';
import {createEvolutionLoops} from '../src/evolutionLoops.mjs';
import {evolutionRecordedFailures} from '../src/evolutionGrowth.mjs';
import {canonicalJson,evolutionProposalIssues} from '@evimed/domain';

// The proposal gate of the module loops. The ledger's rejection records (15 of them, 2026-10-07 to 12, `proposal-metadata` and `candidate-screen`) were:
//   rollbackVersion-required, description-too-long, prediction-required   (10-07, frontier, before the platform wrote the rollback revision)
//   description-too-long, reproducible-failure-required                   (10-12, autopilot: three of five attempts)
//   reproducible-failure-required alone                                    (10-12, autopilot: two more)
//   description-too-long alone                                             (10-12, frontier: two attempts after three the model screen refused)
// and three `candidate-screen` refusals by the model reviewer (grader-gaming and the like), which are the gate working and are not touched here.

const proposalFor=(extra={})=>({components:['plannerInstructions'],mechanisms:['stricter-fallback'],change:'Ask the planner to name the stop rule it applied.',reason:'Planner fallbacks hide which rule fired.',
  rollbackVersion:'default:baseline',predictedBenefits:['fewer silent fallbacks'],possibleHarms:['longer prompts'],costChange:0,...extra});

// --- description-too-long -------------------------------------------------------------------------------------------------------------------
const harness=async({proposal,screen=async()=>({passed:true})})=>{
 const f=evolutionServiceFixture();let prepared=0;
 const adapter={enabled:true,propose:async()=>proposal,prepare:async value=>{prepared++;return{status:'prepared',candidate:value,baseline:{policy:{},revisionId:'default:baseline'}};}};
 await f.service.save('mission','mission',{moduleId:'autopilot',status:'ready',dependencies:[],epoch:'epoch',kind:'research',round:1,maxRounds:10,consecutiveStalls:0,sources:[],successConditions:{}});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},screen,adapters:{autopilot:adapter}});
 return{f,missions,prepared:()=>prepared};
};
test('a proposal whose description is three times the limit is no longer sent back for its length: it is shortened, recorded as shortened, and judged on what it says',async()=>{
 const long={policy:{plannerInstructions:'Revised.'},proposal:proposalFor({change:'Make the planner write down, before it chooses a task type, the stop rule or the pause rule it applied and the evidence that triggered it. '.repeat(2),reason:'Planner fallbacks currently hide which rule fired, and the next repair needs that record to be able to tell a bad rule from a bad input. '.repeat(2)})};
 assert.deepEqual(evolutionProposalIssues(long.proposal),['description-too-long'],'the shape the ledger recorded');
 const {f,missions,prepared}=await harness({proposal:long});
 const row=await missions.run({missionId:'mission'});
 assert.equal(prepared(),1,'the proposal passed the gate and reached preparation');
 assert.notEqual(row.payload.proposalFeedback?.reason,'proposal-metadata');assert.equal((await f.service.list('proposal-rejection')).length,0);
 const state=row.payload.preparedCandidateState??(await f.service.get('mission')).payload.preparedCandidateState;
 assert.ok(state.candidate.proposal.descriptionShortened.fromCharacters>200);assert.deepEqual(evolutionProposalIssues(state.candidate.proposal),[]);
});
test('a proposal sent back is sent back with its own text, the limits it was measured against and its measured length, and the rejection record keeps the length',async()=>{
 const missing={policy:{plannerInstructions:'Revised.'},proposal:proposalFor({predictedBenefits:undefined,change:'x'.repeat(30),reason:'y'.repeat(300)})};
 const {f,missions,prepared}=await harness({proposal:missing});
 const row=await missions.run({missionId:'mission'});
 assert.equal(prepared(),0);assert.equal(row.payload.proposalFeedback.reason,'proposal-metadata');assert.deepEqual(row.payload.proposalFeedback.detail,['prediction-required'],'the length is not one of the issues any more');
 const feedback=row.payload.proposalFeedback;
 assert.deepEqual([feedback.limits.descriptionCharacters,feedback.limits.changeCharacters,feedback.limits.reasonCharacters],[200,100,90]);
 assert.ok(feedback.limits.mechanisms>=1);assert.equal(feedback.previous.change,'x'.repeat(30));assert.deepEqual(feedback.previous.components,['plannerInstructions']);
 assert.equal(feedback.previous.descriptionCharacters,200,'the length of the proposal as the contract read it, after the cut');
 const [rejection]=await f.service.list('proposal-rejection');assert.equal(rejection.payload.descriptionCharacters,200);assert.deepEqual(rejection.payload.detail,['prediction-required']);
});

// --- reproducible-failure-required ----------------------------------------------------------------------------------------------------------
const loops=async(config={})=>{
 const {service,...rest}=evolutionServiceFixture();
 const model=async()=>({policy:{plannerInstructions:'Revised planner.'},proposal:proposalFor({opportunityKind:'repair',failureReproduced:true,rollbackVersion:'invented'})});
 const made=createEvolutionLoops({service,config:{autopilotEnabled:true,frontierEnabled:true,...config},database:{query:async()=>({rows:[{cost:0,count:0}]})},registry:{list:()=>[]},model});
 made.configureModules({readDevelopmentTasks:async()=>[],editor:{}});
 return{service,loops:made,...rest};
};
test('one definition of a recorded failure serves both the opportunity and the proposal that answers it',()=>{
 const observation=counts=>({recordType:'evolution-module-observation',moduleId:'frontier',kind:'edit-verification',counts});
 assert.equal(evolutionRecordedFailures(observation({failed:1})),1,'a title-only edit');
 assert.equal(evolutionRecordedFailures(observation({failed:0,numberFailures:2,unitMismatches:1})),3,'a number or unit the source does not have: opened an opportunity, and used to be refused as no failure');
 assert.equal(evolutionRecordedFailures(observation({failed:0,numbersChecked:9})),0);assert.equal(evolutionRecordedFailures(observation({})),0,'a screened-out entry carries no failure');
 assert.equal(evolutionRecordedFailures({recordType:'evolution-signal-summary',moduleId:'autopilot',kind:'planner-fallback',occurrences:7}),7,'a repair signal');
 assert.equal(evolutionRecordedFailures({recordType:'evolution-signal-summary',moduleId:'autopilot',kind:'unmet-demand',occurrences:7}),0,'a demand is not a failure');
 assert.equal(evolutionRecordedFailures({recordType:'evolution-dossier'}),0);
});
test('an autopilot repair opened by a platform signal passes the proposal gate: the failure the platform recorded is read from the signal',async()=>{
 const {service,loops:made}=await loops();
 await service.save('signal-summary','evolution-signal-summary-a',{moduleId:'autopilot',kind:'planner-fallback',codes:{operation:'plan'},occurrences:7,distinctAccounts:3,accountClass:'user',scope:'platform-aggregate'});
 await service.save('dossier','dossier-signal',{opportunity:true,moduleId:'autopilot',sources:['repair'],evidenceRoots:['evolution-signal-summary-a']});
 const proposed=await made.missions.adapters.autopilot.propose({id:'mission-autopilot',moduleId:'autopilot',opportunityId:'dossier-signal',sources:['repair']});
 assert.equal(proposed.proposal.failureReproduced,true);assert.equal(proposed.proposal.opportunityKind,'repair');
 assert.deepEqual(evolutionProposalIssues(proposed.proposal),[],'the five identical refusals of the ledger');
 // The model's own claim still counts for nothing: a repair resting on no recorded failure is sent back.
 await service.save('signal-summary','evolution-signal-summary-demand',{moduleId:'autopilot',kind:'unmet-demand',occurrences:9,distinctAccounts:5,accountClass:'user'});
 await service.save('dossier','dossier-demand',{opportunity:true,moduleId:'autopilot',sources:['repair'],evidenceRoots:['evolution-signal-summary-demand']});
 const unrecorded=await made.missions.adapters.autopilot.propose({id:'mission-demand',moduleId:'autopilot',opportunityId:'dossier-demand',sources:['repair']});
 assert.deepEqual(evolutionProposalIssues(unrecorded.proposal),['reproducible-failure-required']);
 // A signal of another module is not this module's failure.
 await service.save('dossier','dossier-elsewhere',{opportunity:true,moduleId:'autopilot',sources:['repair'],evidenceRoots:['evolution-signal-summary-a']});
 const frontier=await made.missions.adapters.frontier.propose({id:'mission-frontier',moduleId:'frontier',opportunityId:'dossier-elsewhere',sources:['repair']});
 assert.deepEqual(evolutionProposalIssues(frontier.proposal),['reproducible-failure-required']);
});
test('a frontier repair opened by a failed number check passes the proposal gate although no edit came out title-only',async()=>{
 const {service,loops:made}=await loops();
 await service.save('module-observation','evolution-module-observation-numbers',{moduleId:'frontier',kind:'edit-verification',counts:{failed:0,numbersChecked:4,numberFailures:1,unitMismatches:0},policyRevisionId:'frontier-editor-1.abc'});
 await service.save('dossier','dossier-numbers',{opportunity:true,moduleId:'frontier',sources:['repair'],evidenceRoots:['evolution-module-observation-numbers']});
 const proposed=await made.missions.adapters.frontier.propose({id:'mission-numbers',moduleId:'frontier',opportunityId:'dossier-numbers',sources:['repair']});
 assert.deepEqual(evolutionProposalIssues(proposed.proposal),[]);
});

const baseline={revisionId:'default:abc',policy:{editInstructions:'Edit.'}};
const reproduce=(made,extra={})=>made.service.callbacks.reproduceEvolutionFailure({missionId:'mission-frontier',moduleId:'frontier',baseline,opportunityId:'dossier-edits',...extra},{});
const frontierRepair=async(made,observations)=>{
 await made.service.save('mission','mission-frontier',{epoch:'epoch',moduleId:'frontier'});
 for(const [id,payload] of Object.entries(observations))await made.service.save('module-observation',id,{moduleId:'frontier',kind:'edit-verification',policyRevisionId:'frontier-editor-1.abc',...payload});
 await made.service.save('dossier','dossier-edits',{opportunity:true,moduleId:'frontier',sources:['repair'],evidenceRoots:Object.keys(observations)});
};
test('no public development case fails on the baseline: the receipt is written by code from the production observations the dossier rests on',async()=>{
 const made=await loops();
 await frontierRepair(made,{'obs-numbers':{counts:{failed:0,numberFailures:1}},'obs-title-only':{counts:{failed:1,numberFailures:0}},'obs-clean':{counts:{failed:0,numberFailures:0}},
  'obs-screened':{kind:'screened-out',counts:{failed:1}}});
 const result=await reproduce(made);
 assert.equal(result.status,'reproduced');
 const receipt=(await made.service.get(result.receiptId)).payload;
 assert.equal(receipt.basis,'platform-observation');assert.deepEqual(receipt.observationIds,['obs-numbers','obs-title-only'],'only the observations that counted a failure, decided by a deterministic check');
 assert.equal(receipt.failures,2);assert.equal(receipt.scope,'public');
 assert.equal(validEvolutionFailureReproduction(receipt,{missionId:'mission-frontier',moduleId:'frontier',baseline}),true,'the mission reads it as it reads an executed receipt');
 assert.deepEqual(await reproduce(made),result,'the same receipt the second time');assert.equal((await made.service.list('failure-reproduction')).length,1);
 // Edited receipts and receipts of another basis do not pass.
 assert.equal(validEvolutionFailureReproduction({...receipt,observationKind:'screened-out'},{missionId:'mission-frontier',moduleId:'frontier',baseline}),false);
 const forged={...receipt,observationIds:[]};forged.receiptHash=evolutionFailureReproductionHash(forged);
 assert.equal(validEvolutionFailureReproduction(forged,{missionId:'mission-frontier',moduleId:'frontier',baseline}),false,'a platform observation names its observations');
 assert.equal(validEvolutionFailureReproduction({...receipt,basis:'model-said-so'},{missionId:'mission-frontier',moduleId:'frontier',baseline}),false);
 assert.equal(validEvolutionFailureReproduction(receipt,{missionId:'mission-frontier',moduleId:'frontier',baseline:{...baseline,revisionId:'changed'}}),false);
});
test('without a recorded deterministic failure there is no receipt, and an observation of another policy is no evidence for a promoted baseline',async()=>{
 const made=await loops();
 await frontierRepair(made,{'obs-clean':{counts:{failed:0,numberFailures:0}},'obs-screened':{kind:'screened-out',counts:{failed:1}}});
 assert.deepEqual(await reproduce(made),{status:'waiting_resource',reason:'verified_public_failure_not_reproduced'});
 const other=await loops();
 await frontierRepair(other,{'obs-numbers':{counts:{failed:0,numberFailures:1}}});
 assert.deepEqual(await reproduce(other,{baseline:{revisionId:'evolution-module-policy-frontier:3',policy:{}}}),{status:'waiting_resource',reason:'verified_public_failure_not_reproduced'});
 assert.equal((await reproduce(other,{baseline:{revisionId:'evolution-module-policy-frontier:3',policy:{}}})).status,'waiting_resource');
 await other.service.save('module-observation','obs-promoted',{moduleId:'frontier',kind:'edit-verification',counts:{failed:1},policyRevisionId:'evolution-module-policy-frontier:3'});
 const dossier=await other.service.get('dossier-edits');
 await other.service.save('dossier','dossier-edits',{...dossier.payload,evidenceRoots:['obs-numbers','obs-promoted']},dossier);
 const promoted=await reproduce(other,{baseline:{revisionId:'evolution-module-policy-frontier:3',policy:{}}});
 assert.equal(promoted.status,'reproduced');assert.deepEqual((await other.service.get(promoted.receiptId)).payload.observationIds,['obs-promoted']);
});
test('the repair gate accepts an observation receipt the way it accepts an executed one',async()=>{
 const f=evolutionServiceFixture();
 const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
 const proof={missionId:'repair-mission',moduleId:'frontier',baselineHash:hash(baseline),basis:'platform-observation',observationKind:'edit-verification',observationIds:['obs-1'],failures:1,taskId:'obs-1',
  sourceRoot:'observation:frontier:edit-verification',sourceHash:'a'.repeat(64),scope:'public',independent:true,executed:true,baselineFailed:true,referenceVerified:true,executionReceiptHash:'b'.repeat(64)};
 await f.service.save('failure-reproduction','receipt',{...proof,receiptHash:evolutionFailureReproductionHash(proof)});
 await f.service.save('mission','repair-mission',{moduleId:'frontier',status:'ready',dependencies:[],sources:['repair'],kind:'research',failureReproductionReceiptId:'receipt',
  preparedCandidateState:{candidate:{policy:{editInstructions:'Changed'},proposal:{opportunityKind:'repair',failureReproduced:true}},baseline}});
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config:{},adapters:{frontier:{enabled:true}}});
 const row=await missions.run({missionId:'repair-mission'});
 assert.notEqual(row.payload.reason,'repair-failure-reproduction-required','the receipt is accepted; the mission goes on to its development tasks');
});
