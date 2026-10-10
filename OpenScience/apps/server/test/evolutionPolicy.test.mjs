import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPolicyProposal,DEFAULT_EVOLUTION_POLICY,createEvolutionPolicy,replayPolicyPrefixes,policyRankingAccuracy,evolutionPolicyProposalMessages} from '../src/evolutionPolicy.mjs';
import {rankHandbookEntries,handbookRetirementReason,handbookUtility} from '../src/handbookUtility.mjs';
const store=()=>{const rows=new Map();return {get:async id=>rows.get(id),list:async type=>[...rows.values()].filter(r=>r.type===type),save:async(type,id,payload)=>{const row={type,id,payload,revision:1};rows.set(id,row);return row;}};};
test('policy cannot modify evaluator or more than one policy field',()=>{assert.throws(()=>applyPolicyProposal(DEFAULT_EVOLUTION_POLICY,{field:'evaluator',value:[],hypothesis:'x'}));assert.throws(()=>applyPolicyProposal(DEFAULT_EVOLUTION_POLICY,{field:'weights',value:{demand:4},hypothesis:'x',budgetShares:{}}));assert.throws(()=>applyPolicyProposal(DEFAULT_EVOLUTION_POLICY,{field:'budgetShares',value:{research:1.5},hypothesis:'x'}));});
test('prefix replay stops when branch changes and does not invent downstream results',()=>{const [result]=replayPolicyPrefixes([{id:'m',decisions:[{id:'1',choice:'a',gain:1},{id:'2',choice:'b',gain:8},{id:'3',choice:'c',gain:9}]}],p=>p.id==='2'?'d':p.choice);assert.equal(result.observed.length,1);assert.equal(result.unknown.status,'unobserved');assert.equal(policyRankingAccuracy([{confirmedGain:3,score:4},{confirmedGain:1,score:2}],c=>c.score).accuracy,1);});
test('policy trial waits for a real month and uses stable mission assignment',async()=>{const service=store(),now=()=>new Date('2026-10-01T00:00:00Z');const p=createEvolutionPolicy({service,now,propose:async()=>({field:'resourceStop',value:{attempts:2,days:10},hypothesis:'less noise'})});const trial=await p.monthly({replay:async()=>({independent:true,observedNonInferior:true,rankingNonInferior:true,expectedCostCny:1,baselineCostCny:1})});assert.equal(trial.payload.month,'2026-11');assert.deepEqual(await p.evaluateTrial(),[{id:trial.id,status:'pending',reason:'real_month_incomplete'}]);assert.deepEqual(await p.assignedPolicy('m',new Date('2026-11-12')),await p.assignedPolicy('m',new Date('2026-11-20')));});
test('probation utility shrinks to prior and unique coverage cannot be retired',()=>{assert.equal(handbookUtility({}).mean,.5);const unknown={id:'unknown',semanticRelevance:0};const ranked=rankHandbookEntries([...Array.from({length:6},(_,i)=>({id:String(i),usefulCount:10,semanticRelevance:10})),unknown]);assert.ok(ranked.includes(unknown));const item={id:'a',scope:'rare',harmfulCount:2,usefulCount:0};assert.equal(handbookRetirementReason(item,[item],new Date()),null);assert.equal(handbookRetirementReason(item,[item,{id:'b',scope:'rare'}],new Date()),'harm_exceeds_use');});
test('monthly proposal cannot observe held-out replay missions',async()=>{const service=store();let proposalInput,replayInput;const p=createEvolutionPolicy({service,now:()=>new Date('2026-10-02'),propose:async input=>{proposalInput=input;return {field:'resourceStop',value:{attempts:2,days:10},hypothesis:'less noise'};}});await p.monthly({missions:[{id:'development',replayIndependent:false},{id:'secret',replayIndependent:true,decisions:[{choice:'heldout'}]}],replay:async input=>{replayInput=input;return null;}});assert.deepEqual(proposalInput.missions.map(m=>m.id),['development']);assert.deepEqual(replayInput.missions.map(m=>m.id),['secret']);});
test('month-end counts failed assignment costs and rolls back incomplete measurement',async()=>{const service=store();let instant=new Date('2026-10-02');const p=createEvolutionPolicy({service,now:()=>instant,propose:async()=>({field:'resourceStop',value:{attempts:2,days:10},hypothesis:'less noise'})});const trial=await p.monthly({replay:async()=>({independent:true,observedNonInferior:true,rankingNonInferior:true,expectedCostCny:1,baselineCostCny:1})});instant=new Date('2026-12-01');const missions=[{month:'2026-11',epoch:'default',policyVersion:1,completed:true,researchCostCny:10,regressions:0,overfitGap:0},{month:'2026-11',epoch:'default',policyVersion:2,completed:false,researchCostCny:25}];const [outcome]=await p.evaluateTrial({missions});assert.equal(outcome.payload.status,'rolled_back');assert.equal(outcome.payload.reason,'month_measurement_incomplete');assert.equal(outcome.payload.candidateObjective.cost,25);assert.equal(outcome.payload.candidateObjective.missions,1);assert.equal((await p.assignedPolicy('m',instant)).policy.version,1);assert.equal((await service.get(trial.id)).payload.status,'rolled_back');});
test('policy audit subset retains every failed cost and needs two observed pairs per arm',async()=>{
 const service=store();let instant=new Date('2026-10-02');const p=createEvolutionPolicy({service,now:()=>instant,propose:async()=>({field:'resourceStop',value:{attempts:2,days:10},hypothesis:'less noise'})});
 await p.monthly({replay:async()=>({independent:true,observedNonInferior:true,rankingNonInferior:true,expectedCostCny:1,baselineCostCny:1})});instant=new Date('2026-12-01');
 const observed=(policyVersion,id)=>({id,month:'2026-11',epoch:'default',auditEpoch:'default',policyVersion,completed:true,researchCostCny:1,regressions:0,auditReceiptId:id,developmentGain:0.1,auditGain:0.1,overfitGap:0,confirmedOnNewTasks:true,confirmedPromotions:1});
 const missions=[observed(1,'a'),observed(1,'b'),observed(2,'c'),observed(2,'d'),{month:'2026-11',epoch:'default',policyVersion:2,completed:false,researchCostCny:30,regressions:0}];
 const [result]=await p.evaluateTrial({missions});assert.equal(result.payload.status,'rolled_back');assert.equal(result.payload.candidateObjective.cost,32);assert.equal(result.payload.candidateObjective.comparableAudits,2);assert.equal(result.payload.candidateObjective.failures,1);assert.equal(result.payload.candidateObjective.overfitGap,0);
});
test('a malformed proposal is recorded as invalid with its reason, not asked for again that month, and is no trial',async()=>{
 const service=store();let asked=0;
 const p=createEvolutionPolicy({service,now:()=>new Date('2026-10-02'),propose:async()=>{asked++;return {field:'weights',value:{demand:4},hypothesis:'x'};}});
 const trial=await p.monthly({});
 assert.equal(trial.payload.status,'proposal_invalid');assert.equal(trial.payload.reason,'evolution_policy_value_invalid');assert.equal(trial.payload.proposalMonth,'2026-10');assert.equal(trial.payload.proposal.field,'weights');
 assert.equal((await p.monthly({})).payload.status,'proposal_invalid');assert.equal(asked,1);
 assert.deepEqual(await p.evaluateTrial(),[]);assert.equal((await p.assignedPolicy('m',new Date('2026-11-12'))).policy.version,1);
 // Only the proposal is judged here: the proposer failing (a spent budget, a provider outage) is still the caller's to retry.
 const broken=createEvolutionPolicy({service:store(),now:()=>new Date('2026-10-02'),propose:async()=>{throw Object.assign(new Error('spent'),{code:'usage_budget_exceeded'});}});
 await assert.rejects(broken.monthly({}),{code:'usage_budget_exceeded'});
});
test('the proposer is shown bounded summaries of missions and cards, never their payloads',()=>{
 const mission=index=>({id:`m${index}`,moduleId:'frontier',kind:'research',status:'rejected',month:'2026-09',policyVersion:1,epoch:'e',completed:true,createdAt:`2026-09-${String(1+index%28).padStart(2,'0')}T00:00:00Z`,
  result:{outcome:'regressed',reason:'floor'},researchCostCny:2.5,confirmedPromotions:0,newSupportedFamilies:0,regressions:1,round:3,
  decisions:[{opportunities:Array.from({length:50},(_,i)=>({id:`o${i}`}))}],policySnapshot:DEFAULT_EVOLUTION_POLICY,baseline:{policy:{text:'x'.repeat(5000)}},results:[{big:'y'.repeat(5000)}]});
 const card=index=>({mechanism:`mechanism ${index} ${'z'.repeat(1000)}`,problem:'problem',falsifiableExpectation:'expect',targetObjects:['frontier'],quote:'q'.repeat(4000),source:{url:'https://example.test',digest:'d'}});
 const [system,user]=evolutionPolicyProposalMessages({baseline:DEFAULT_EVOLUTION_POLICY,epoch:'e',missions:Array.from({length:400},(_,i)=>mission(i)),mechanismCards:Array.from({length:100},(_,i)=>card(i))});
 assert.equal(system.role,'system');
 const sent=JSON.parse(user.content);
 assert.ok(sent.missions.length<=120&&sent.missions.length>0);assert.ok(sent.mechanismCards.length<=40&&sent.mechanismCards.length>0);
 assert.deepEqual(Object.keys(sent.missions[0]).sort(),['completed','confirmedPromotions','id','kind','moduleId','month','newSupportedFamilies','outcome','policyVersion','reason','regressions','researchCostCny','round','status']);
 assert.equal(sent.missions[0].outcome,'regressed');assert.equal(sent.missions[0].researchCostCny,2.5);
 assert.ok(user.content.length<80_000,`the message is ${user.content.length} characters`);
 assert.ok(!user.content.includes('policySnapshot')&&!user.content.includes('zzzzzzzzzzzz'.repeat(30)));
});
test('the proposer itself is handed the bounded summaries, and the message built from them keeps the same bound',async()=>{
 const service=store();let handed;
 const p=createEvolutionPolicy({service,now:()=>new Date('2026-10-02'),propose:async input=>{handed=input;return {field:'resourceStop',value:{attempts:2,days:10},hypothesis:'x'};}});
 const mission={id:'m1',moduleId:'tools',kind:'research',status:'rejected',month:'2026-09',policyVersion:1,completed:true,result:{outcome:'regressed',reason:'floor'},researchCostCny:2,
  decisions:[{big:'x'.repeat(10_000)}],policySnapshot:DEFAULT_EVOLUTION_POLICY,baseline:{policy:{text:'y'.repeat(5_000)}}};
 await p.monthly({missions:[mission,{...mission,id:'held-out',replayIndependent:true}],mechanismCards:[{mechanism:'a',problem:'b',falsifiableExpectation:'c',targetObjects:['tools'],quote:'q'.repeat(5_000),source:{url:'https://example.test'}}],replay:async()=>null});
 assert.deepEqual(handed.missions.map(item=>[item.id,item.outcome,item.reason,item.researchCostCny]),[['m1','regressed','floor',2]]);
 assert.ok(!('decisions' in handed.missions[0])&&!('policySnapshot' in handed.missions[0])&&!('baseline' in handed.missions[0]));
 assert.deepEqual(Object.keys(handed.mechanismCards[0]).sort(),['estimatedCostCny','falsifiableExpectation','mechanism','problem','targetObjects']);
 const [,user]=evolutionPolicyProposalMessages(handed);
 assert.deepEqual(JSON.parse(user.content).missions,handed.missions);assert.deepEqual(JSON.parse(user.content).mechanismCards,handed.mechanismCards);
});
