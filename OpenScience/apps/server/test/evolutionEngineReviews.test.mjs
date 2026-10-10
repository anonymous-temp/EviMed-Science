import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
import {DEFAULT_EVOLUTION_POLICY} from '../src/evolutionPolicy.mjs';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';
import {engineReviewSummary} from '../src/evolutionEngineReview.mjs';
import {createEvolutionEngineReviews,engineReviewNotice,ENGINE_REVIEW_SOURCE_PREFIX} from '../src/evolutionEngineReviews.mjs';

// A proposal for the platform's own code used to end as a review input on disk that nobody was told of (review D-E3b). Each operator now gets
// one inbox item with the proposal's summary and two actions; the first answer closes the review on its dossier.
const OPERATORS=['operator-a','operator-b'];
const SUMMARY={goal:'Improve the memory module on unfamiliar tasks.',change:'Floor the recall score at 0.2 before ranking.',reason:'Low-scoring records crowd out the profile.',
 files:['apps/server/src/memoryRecallPolicy.mjs','tests/recallFloor.test.mjs'],benefits:['Shorter recall context'],harms:['A relevant weak record may be left out']};
const REVIEW={identity:'r'.repeat(64),relativeDirectory:'.openscience/evolution-engine-review/'+'r'.repeat(64),prepareCommand:"node OpenScience/scripts/dev/open-evolution-pr.mjs --staging='/x' --dry-run",summary:SUMMARY};
/** The inbox as the reviews see it: items per account, resolved by the operator or by default. */
const inbox=()=>{
 const items=new Map(),log=[];let counter=0;
 const doubles={items,log,handlers:[],
  async create(userId,input){
   if(doubles.failFor===userId)throw new Error('inbox unavailable');
   const key=`${userId}:${input.idempotencyKey}`;if(items.has(key))return items.get(key);
   const item={id:`n${++counter}`,userId,revision:1,resolvedAt:null,...input};items.set(key,item);log.push(['create',userId,item.id]);return item;
  },
  async get(userId,id){const item=[...items.values()].find(row=>row.userId===userId&&row.id===id);if(!item)throw new Error('missing');return item;},
  async resolveByDefault(userId,id,{actionId}){const item=await doubles.get(userId,id);item.resolvedAt='now';item.resolution={actionId,source:'default'};log.push(['default',userId,id,actionId]);return item;},
  onAction(handler){doubles.handlers.push(handler);},
  /** What the real inbox does before it resolves an item. */
  async answer(userId,id,actionId){const item=await doubles.get(userId,id);for(const handler of doubles.handlers)await handler(item,actionId);item.resolvedAt='now';item.resolution={actionId,source:'user'};return item;},
 };
 return doubles;
};
const setup=async({moduleId='memory'}={})=>{
 const f=evolutionServiceFixture(),notifications=inbox(),P=DEFAULT_EVOLUTION_POLICY;
 const reviews=createEvolutionEngineReviews({service:f.service,notifications,config:{operatorUsers:OPERATORS}});
 notifications.onAction(reviews.decide);
 f.service.callbacks.engineReviewPrepared=id=>reviews.announce(id);
 f.service.callbacks.announceEngineReviews=()=>reviews.announcePending();
 f.service.callbacks.runModuleEngineMission=async()=>({status:'review',review:REVIEW});
 const missions=createEvolutionMissions({service:f.service,policy:{assignedPolicy:async()=>({id:'P',policy:P}),current:async()=>({policy:P})},map:{rebuild:async()=>({counts:{}})},taskPool:{},signals:{aggregate:async()=>[]},
  config:{evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10},adapters:{[moduleId]:{enabled:true}}});
 await missions.opportunity({id:'opportunity',moduleId,sources:['repair'],taskFamily:'recall',mechanismFamily:'recall',evidenceRoots:['root'],features:{runtimeFailures:4}});
 const [missionId]=(await missions.plan({week:'2026-10-05'})).missions;
 // The engine's own record of the build, where the staged input is named.
 await f.service.save('dossier','engine-record',{moduleEngine:true,moduleId,status:'review',review:REVIEW,goal:SUMMARY.goal});
 return{f,notifications,reviews,missions,missionId};
};
const dossier=async(f,id='opportunity')=>(await f.service.get(id)).payload;

test('the proposal reaches every operator once, as an inbox item with the summary and the two actions, and the module is not held',async()=>{
 const {f,notifications,missions,missionId}=await setup();
 const done=await missions.run({missionId});
 assert.equal(done.payload.status,'complete','the mission ends with the review input');
 assert.deepEqual(notifications.log.filter(([kind])=>kind==='create').map(([,userId])=>userId),OPERATORS);
 const item=[...notifications.items.values()][0];
 assert.equal(item.noticeType,'review');assert.equal(item.source.type,'system');assert.equal(item.source.id,ENGINE_REVIEW_SOURCE_PREFIX+REVIEW.identity);
 assert.deepEqual(item.actions.map(action=>[action.id,action.label]),[['adopt','采纳'],['decline','不采纳']]);
 assert.match(item.title,/记忆/);
 for(const line of ['改动：Floor the recall score at 0.2 before ranking.','原因：Low-scoring records crowd out the profile.','预期：Shorter recall context','可能的代价：A relevant weak record may be left out','涉及文件：apps/server/src/memoryRecallPolicy.mjs、tests/recallFloor.test.mjs'])assert.ok(item.body.includes(line),line);
 assert.ok(!item.body.includes(REVIEW.identity)&&!item.body.includes('.openscience'),'no identity or staging path in the words an operator reads');
 const record=await dossier(f);assert.equal(record.status,'review');assert.equal(record.review.notice.items.length,2);
 // Told once: a repeated pass, the housekeeping catch-up and a replayed mission send nothing new.
 await missions.run({missionId});await f.service.callbacks.announceEngineReviews();
 assert.equal(notifications.log.filter(([kind])=>kind==='create').length,2);
});
test('either action closes the review with who answered and when; an adopted proposal is kept as work to implement',async()=>{
 const {f,notifications,reviews}=await (async()=>{const s=await setup();await s.missions.run({missionId:s.missionId});return s;})();
 const mine=[...notifications.items.values()].find(item=>item.userId==='operator-a'),theirs=[...notifications.items.values()].find(item=>item.userId==='operator-b');
 f.advance(3600_000);
 await notifications.answer('operator-a',mine.id,'adopt');
 const adopted=await dossier(f);
 assert.equal(adopted.status,'adopted');assert.equal(adopted.review.decision.by,'operator-a');assert.equal(adopted.review.decision.at,f.service.now().toISOString());assert.equal(adopted.review.decision.state,'adopted');
 assert.equal(adopted.adoptedWork.reviewId,REVIEW.identity);assert.equal(adopted.adoptedWork.stagedAt,REVIEW.relativeDirectory);assert.equal(adopted.adoptedWork.summary.change,SUMMARY.change);assert.equal(adopted.adoptedWork.adoptedBy,'operator-a');
 assert.equal((await dossier(f,'engine-record')).status,'adopted','the build record follows the review');
 assert.deepEqual([theirs.resolution.actionId,theirs.resolution.source],['adopt','default'],'the other operator\'s copy is settled with the answer');
 assert.equal(reviews.counters.adopted,1);
 // The first answer stands: a later one on any copy changes nothing.
 await notifications.answer('operator-b',theirs.id,'decline');
 assert.equal((await dossier(f)).status,'adopted');assert.equal(reviews.counters.declined,0);
});
test('declining closes the review without adopted work; the module may go on, and new evidence can reopen it',async()=>{
 const s=await setup();await s.missions.run({missionId:s.missionId});
 const mine=[...s.notifications.items.values()].find(item=>item.userId==='operator-b');
 await s.notifications.answer('operator-b',mine.id,'decline');
 const declined=await dossier(s.f);
 assert.equal(declined.status,'declined');assert.equal(declined.review.decision.by,'operator-b');assert.equal(declined.adoptedWork,undefined);assert.equal(s.reviews.counters.declined,1);
 s.f.advance(7*86400000);
 const next=await s.missions.plan({week:'2026-10-12'});
 assert.deepEqual((await Promise.all(next.missions.map(id=>s.f.service.get(id)))).map(row=>row.payload.kind),['baseline-audit'],'a declined proposal is not offered again');
 // What it rested on changed: it is an open opportunity again.
 await s.missions.opportunity({id:'opportunity',moduleId:'memory',sources:['repair'],taskFamily:'recall',mechanismFamily:'recall',evidenceRoots:['root','more'],features:{runtimeFailures:9}});
 assert.equal((await dossier(s.f)).status,'planned');
});
test('adopted work is not reopened by new evidence and is not offered again',async()=>{
 const s=await setup();await s.missions.run({missionId:s.missionId});
 await s.notifications.answer('operator-a',[...s.notifications.items.values()].find(item=>item.userId==='operator-a').id,'adopt');
 await s.missions.opportunity({id:'opportunity',moduleId:'memory',sources:['repair'],taskFamily:'recall',mechanismFamily:'recall',evidenceRoots:['root','more'],features:{runtimeFailures:9}});
 assert.equal((await dossier(s.f)).status,'adopted');
 s.f.advance(7*86400000);
 const next=await s.missions.plan({week:'2026-10-12'});
 assert.deepEqual((await Promise.all(next.missions.map(id=>s.f.service.get(id)))).map(row=>row.payload.kind),['baseline-audit']);
 // A mission that runs again after its end was lost does not turn the answer back into a question.
 await s.missions.run({missionId:s.missionId});assert.equal((await dossier(s.f)).status,'adopted');assert.equal(s.notifications.log.filter(([kind])=>kind==='create').length,2);
});
test('a proposal nobody could be told of is announced by the next housekeeping, and an inbox that fails for one operator still reaches the other',async()=>{
 const s=await setup();s.notifications.failFor='operator-a';
 await s.missions.run({missionId:s.missionId});
 assert.deepEqual(s.notifications.log.filter(([kind])=>kind==='create').map(([,userId])=>userId),['operator-b'],'the operator whose inbox failed is skipped, the other is told');
 assert.equal(s.reviews.counters.announceFailed,1);
 // Nobody could be told: the dossier waits, and a pass later tells them.
 const lone=await setup();lone.notifications.failFor='*';lone.notifications.create=async()=>{throw new Error('inbox unavailable');};
 await lone.missions.run({missionId:lone.missionId});assert.equal((await dossier(lone.f)).review.notice,undefined);
 lone.notifications.create=inbox().create.bind(lone.notifications);delete lone.notifications.failFor;
 assert.equal(await lone.reviews.announcePending(),1);assert.equal((await dossier(lone.f)).review.notice.items.length,2);
 // The worker comes round to it every minute.
 const calls=[];
 const worker=new EvolutionWorker({service:{config:{},callbacks:{announceEngineReviews:async()=>{calls.push('announce');}},now:()=>new Date('2026-10-06T04:00:00Z'),owner:async()=>'operator',reconcileQueued:async()=>{},tools:async()=>[],list:async()=>[],get:async()=>null,save:async()=>{},enqueue:async()=>{},ingestEvent:async()=>{},notifications:{preferences:async()=>({digestTime:'08:00'})}},config:{}});
 await worker.housekeeping();assert.deepEqual(calls,['announce']);await worker.housekeeping();assert.deepEqual(calls,['announce'],'inside the minute it repeats nothing');
});
test('an item that is not an engine review is none of its business',async()=>{
 const s=await setup();await s.missions.run({missionId:s.missionId});
 assert.equal(await s.reviews.decide({source:{type:'system',id:'evolution-decision-x'},userId:'operator-a'},'adopt'),null);
 assert.equal(await s.reviews.decide({source:{type:'run',id:ENGINE_REVIEW_SOURCE_PREFIX+REVIEW.identity},userId:'operator-a'},'adopt'),null);
 assert.equal(await s.reviews.decide({source:{type:'system',id:ENGINE_REVIEW_SOURCE_PREFIX+REVIEW.identity},userId:'operator-a'},'open'),null,'only the two actions are answers');
 assert.equal(await s.reviews.decide({source:{type:'system',id:ENGINE_REVIEW_SOURCE_PREFIX+'f'.repeat(64)},userId:'operator-a'},'adopt'),null,'an unknown review');
 assert.equal((await dossier(s.f)).status,'review');
});
test('the notice reads without a summary too: a proposal prepared before the summary existed still reaches the operators',()=>{
 const text=engineReviewNotice({moduleId:'sources'});
 assert.match(text.title,/知识库/);assert.ok(text.body.includes('采纳后记入待实现的工作'));assert.deepEqual(text.actions.map(action=>action.label),['采纳','不采纳']);
 assert.match(engineReviewNotice({moduleId:'unknown-module'}).title,/平台/);
 const long=engineReviewNotice({moduleId:'runtime',summary:{change:'x'.repeat(900),files:Array.from({length:30},(_,i)=>`f${i}.mjs`)}});
 assert.ok(long.body.length<1200);assert.ok(long.body.includes('等 30 个'));
});
test('the review writer states the proposal\'s own summary, bounded and without touching what the review is named by',()=>{
 const summary=engineReviewSummary({goal:'g'.repeat(500)},{files:{'a.mjs':'1','tests/a.test.mjs':'2'},proposal:{change:' Change  it ',reason:'r'.repeat(300),predictedBenefits:['b',' ',7],possibleHarms:[]}});
 assert.equal(summary.goal.length,300);assert.equal(summary.change,'Change it');assert.equal(summary.reason.length,200);assert.deepEqual(summary.files,['a.mjs','tests/a.test.mjs']);assert.deepEqual(summary.benefits,['b']);assert.deepEqual(summary.harms,[]);
});
test('a failure while recording the answer leaves the item open to be answered again, and nothing is recorded twice',async()=>{
 const s=await setup();await s.missions.run({missionId:s.missionId});
 const mine=[...s.notifications.items.values()].find(item=>item.userId==='operator-a');
 const save=s.f.service.save.bind(s.f.service);let failing=true;
 s.f.service.save=async(...args)=>{if(failing&&args[0]==='dossier')throw new Error('database down');return save(...args);};
 await assert.rejects(s.notifications.answer('operator-a',mine.id,'adopt'),/database down/);
 assert.equal(mine.resolvedAt,null,'the inbox item is still waiting for its answer');assert.equal((await dossier(s.f)).status,'review');
 failing=false;
 await s.notifications.answer('operator-a',mine.id,'adopt');
 assert.equal((await dossier(s.f)).status,'adopted');assert.equal(s.reviews.counters.adopted,1);
});
