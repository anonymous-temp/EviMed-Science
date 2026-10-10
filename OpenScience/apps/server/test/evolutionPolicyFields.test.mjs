import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
import {createEvolutionTaskPool} from '../src/evolutionTaskPool.mjs';
import {applyPolicyProposal,createEvolutionPolicy,DEFAULT_EVOLUTION_POLICY,EVOLUTION_POLICY_FIELDS,EVOLUTION_STAGNANT_ROUNDS,evolutionPolicyProposalMessages,normalizeEvolutionPolicy} from '../src/evolutionPolicy.mjs';

// The research policy P kept eight fields; five of them changed nothing (review D-E2, D-E6, D-E15): `handbook` and `curriculum` were read by no
// code, `mechanismSchedule` and `stagnationRounds` described rounds a mission never reaches, and `moduleMaximumShare` capped what the one mission a
// week could not exceed. They are gone, a mission ends after three rounds without a gain, and a policy stored with them still loads.
const REMOVED=['moduleMaximumShare','mechanismSchedule','stagnationRounds','curriculum','handbook'];
const LEGACY={schemaVersion:1,version:3,weights:{demand:5,unlock:3,reuse:2,progress:2,exploration:1.5,cost:0.2},budgetShares:{research:0.4,confirmation:0.3,exploration:0.15,maintenance:0.1,meta:0.05},
 moduleMaximumShare:0.5,mechanismSchedule:[3,2,1],stagnationRounds:3,resourceStop:{attempts:2,days:10},curriculum:{minimumSuccess:0.2,maximumSuccess:0.8},handbook:'Change one component.'};
const store=()=>{const rows=new Map();return{rows,get:async id=>rows.get(id),list:async type=>[...rows.values()].filter(r=>r.type===type),save:async(type,id,payload)=>{const row={type,id,payload,revision:1};rows.set(id,row);return row;}};};

test('what is left of the policy is what a change can reach',()=>{
 assert.deepEqual(Object.keys(DEFAULT_EVOLUTION_POLICY).sort(),['budgetShares','resourceStop','schemaVersion','version','weights']);
 assert.deepEqual([...EVOLUTION_POLICY_FIELDS],['weights','budgetShares','resourceStop']);
 for(const field of REMOVED)assert.equal(Object.hasOwn(DEFAULT_EVOLUTION_POLICY,field),false,field);
 assert.equal(EVOLUTION_STAGNANT_ROUNDS,3);
});
test('a stored policy with the removed fields loads without them, with its own values kept',()=>{
 const {policy,ignored}=normalizeEvolutionPolicy(LEGACY);
 assert.deepEqual(Object.keys(policy).sort(),['budgetShares','resourceStop','schemaVersion','version','weights']);
 assert.deepEqual(ignored.sort(),[...REMOVED].sort());
 assert.equal(policy.version,3);assert.equal(policy.weights.demand,5);assert.deepEqual(policy.resourceStop,{attempts:2,days:10});
 policy.weights.demand=99;assert.equal(LEGACY.weights.demand,5,'the stored policy is not shared with the one in use');
 // A field a stored policy lacks takes its default, and a value that is no policy is none.
 assert.deepEqual(normalizeEvolutionPolicy({version:2,weights:LEGACY.weights}).policy.resourceStop,DEFAULT_EVOLUTION_POLICY.resourceStop);
 assert.deepEqual(normalizeEvolutionPolicy(null),{policy:{...DEFAULT_EVOLUTION_POLICY},ignored:[]});
 assert.deepEqual(normalizeEvolutionPolicy({...LEGACY,somethingNew:1}).ignored.sort(),[...REMOVED,'somethingNew'].sort());
});
test('the ignored fields are counted once per stored policy, however often it is read',async()=>{
 const service=store();await service.save('policy','evolution-policy-3',{status:'active',policy:LEGACY});
 const p=createEvolutionPolicy({service,now:()=>new Date('2026-10-12T00:00:00Z')});
 for(let read=0;read<4;read++){const {policy}=await p.current();assert.deepEqual(Object.keys(policy).filter(key=>REMOVED.includes(key)),[]);}
 assert.equal(p.counters.ignoredFields,5);
 // A trial candidate written in the old shape is read in the new one, and counted once, as its own stored policy.
 await service.save('policy-trial','trial-1',{status:'trial',month:'2026-10',candidate:{...LEGACY,version:4,resourceStop:{attempts:2,days:5}}});
 let assigned=null;
 for(let index=0;index<40&&!assigned;index++){const result=await p.assignedPolicy(`mission-${index}`,new Date('2026-10-12T00:00:00Z'));if(result.id==='trial-1')assigned=result;}
 assert.ok(assigned,'some mission is assigned to the trial');
 assert.deepEqual(Object.keys(assigned.policy).sort(),['budgetShares','resourceStop','schemaVersion','version','weights']);assert.equal(assigned.policy.version,4);
 await p.assignedPolicy('mission-again',new Date('2026-10-12T00:00:00Z'));
 assert.equal(p.counters.ignoredFields,10);
});
test('a proposal for a removed field is invalid, and the month goes on; a proposal on a stored policy comes back in the new shape',async()=>{
 for(const field of REMOVED)assert.throws(()=>applyPolicyProposal(DEFAULT_EVOLUTION_POLICY,{field,value:1,hypothesis:'x'}),{message:'evolution_policy_proposal_invalid'},field);
 const next=applyPolicyProposal(LEGACY,{field:'resourceStop',value:{attempts:1,days:7},hypothesis:'stop sooner'});
 assert.deepEqual(Object.keys(next).sort(),['budgetShares','resourceStop','schemaVersion','version','weights']);assert.equal(next.version,4);assert.deepEqual(next.resourceStop,{attempts:1,days:7});
 for(const value of [{attempts:0,days:7},{attempts:2,days:0},{attempts:1.5,days:3},{days:3},null])assert.throws(()=>applyPolicyProposal(LEGACY,{field:'resourceStop',value,hypothesis:'x'}),{message:'evolution_policy_value_invalid'});
 const service=store();let asked=0;
 const p=createEvolutionPolicy({service,now:()=>new Date('2026-10-02'),propose:async()=>{asked++;return{field:'handbook',value:'Be brief.',hypothesis:'shorter'};}});
 const trial=await p.monthly({});
 assert.equal(trial.payload.status,'proposal_invalid');assert.equal(trial.payload.reason,'evolution_policy_proposal_invalid');assert.equal(asked,1);
});
test('the proposer is offered exactly the fields that exist',()=>{
 const [system]=evolutionPolicyProposalMessages({baseline:DEFAULT_EVOLUTION_POLICY,epoch:'e',missions:[],mechanismCards:[]});
 assert.ok(system.content.includes('field must be weights,budgetShares,resourceStop.'));
 for(const field of REMOVED)assert.ok(!system.content.includes(field),field);
});

// The mission side: a mission carries what it needs of the policy, and the stagnation rule is the one in code.
const harness=async({mission={},proposal=null}={})=>{
 const f=evolutionServiceFixture(),pool=createEvolutionTaskPool({service:f.service});let prepared=0;
 for(const id of ['a','b'])await pool.add({id,moduleId:'tools',sourceRoot:id,sourceHash:id.repeat(64),pool:'confirmation',scope:'public',reservedHidden:true,curatorIndependent:true,equivalentVariant:{input:{value:1}},abstentionExpected:id==='a'});
 const candidate={id:'candidate',frozenAt:'2026-10-03',policy:{},proposal:{mechanisms:['m']}};
 await f.service.save('archive',candidate.id,{candidate,moduleId:'tools',status:'frozen'});
 // The candidate and the baseline score alike: no gain, so no promotion, and the mission has to decide whether to try again.
 const adapter={enabled:true,evaluate:async input=>{
  const units=[];
  for(const item of input.batch)for(const suffix of ['',':equivalent']){const id=`${item.id}${suffix}`;units.push(await input.checkpointUnit(id,async()=>({id,groupId:item.id,score:0.8,sourceHash:item.sourceHash})));}
  return{status:'measured',pool:'confirmation',units,costCny:1,contextBytes:100,evidenceTier:'exact'};
 },propose:async()=>proposal,prepare:async value=>{prepared++;return{status:'prepared',candidate:value,baseline:{policy:{},revisionId:'default:baseline'}};}};
 await f.service.save('mission','mission',{moduleId:'tools',candidate,status:'frozen',dependencies:[],epoch:'epoch',modelReleasedAt:'2026-10-01',baseline:{policy:{}},successConditions:{slices:[]},kind:'research',round:1,maxRounds:10,consecutiveStalls:0,...mission});
 const missions=createEvolutionMissions({service:f.service,taskPool:pool,policy:{},map:{},signals:{},config:{},screen:async()=>({passed:true}),adapters:{tools:adapter}});
 return{f,missions,prepared:()=>prepared};
};
test('a mission that stored the old stagnation field is ruled by the one rule: three rounds without a gain end it',async()=>{
 const first=await harness({mission:{stagnationRounds:1,mechanismSchedule:[1,1,1]}});
 const goes=await first.missions.run({missionId:'mission'});
 assert.equal(goes.payload.status,'ready','one round without a gain does not end it');assert.equal(goes.payload.consecutiveStalls,1);assert.equal(goes.payload.round,2);
 const third=await harness({mission:{consecutiveStalls:EVOLUTION_STAGNANT_ROUNDS-1,stagnationRounds:10}});
 const ends=await third.missions.run({missionId:'mission'});
 assert.equal(ends.payload.consecutiveStalls,3);assert.equal(ends.payload.status,'rejected');assert.equal(ends.payload.completed,true);
});
test('a proposal is held to the domain\'s mechanism limit for its round, not to a schedule the mission stored',async()=>{
 const proposal={policy:{plannerInstructions:'Revised.'},proposal:{components:['plannerInstructions'],mechanisms:['one','two','three'],change:'Change the planner.',reason:'Improve it.',rollbackVersion:'default',predictedBenefits:[],possibleHarms:[],costChange:0}};
 const old=await harness({mission:{candidate:null,status:'ready',mechanismSchedule:[1,1,1],stagnationRounds:1},proposal});
 const row=await old.missions.run({missionId:'mission'});
 assert.equal(old.prepared(),1,'three mechanisms in the first round pass the screen; the old schedule would have sent the proposal back');
 assert.notEqual(row.payload.proposalFeedback?.reason,'proposal-metadata');
 const tooMany=await harness({mission:{candidate:null,status:'ready'},proposal:{...proposal,proposal:{...proposal.proposal,mechanisms:['a','b','c','d']}}});
 const refused=await tooMany.missions.run({missionId:'mission'});
 assert.equal(tooMany.prepared(),0);assert.equal(refused.payload.proposalFeedback.reason,'proposal-metadata');assert.ok(refused.payload.proposalFeedback.detail.includes('mechanism-limit'));
});
test('a new mission carries what is left of the policy, and records its decisions on the fields that are left',async()=>{
 const f=evolutionServiceFixture();
 const missions=createEvolutionMissions({service:f.service,policy:{assignedPolicy:async()=>({id:'P',policy:LEGACY})},map:{},taskPool:{},signals:{},config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10}});
 const row=await missions.create({id:'new-mission',moduleId:'tools',category:'research'});
 for(const field of ['mechanismSchedule','stagnationRounds','moduleMaximumShare'])assert.equal(Object.hasOwn(row.payload,field),false,field);
 assert.deepEqual(row.payload.resourceStop,{attempts:2,days:10});
 assert.deepEqual(row.payload.decisions.map(item=>item.policyField),['budgetShares','resourceStop']);
});
