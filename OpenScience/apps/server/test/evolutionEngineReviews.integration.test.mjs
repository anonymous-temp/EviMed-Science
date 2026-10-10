import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ProductDocuments,ProductJobs} from '../src/productStore.mjs';
import {migrateProductStore} from '../src/productPersistence.mjs';
import {NotificationService} from '../src/notificationService.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
import {DEFAULT_EVOLUTION_POLICY} from '../src/evolutionPolicy.mjs';
import {createEvolutionEngineReviews} from '../src/evolutionEngineReviews.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url&&'A disposable localhost test PostgreSQL database is required'};
// The real inbox and the real ledger: a proposal prepared by an engine-module mission reaches each operator's inbox, and answering it there closes the review.
const first=`evolution_${randomUUID()}`,second=`operator_${randomUUID()}`,stranger=`researcher_${randomUUID()}`;
const REVIEW={identity:randomUUID().replaceAll('-','').repeat(2),relativeDirectory:'.openscience/evolution-engine-review/x',prepareCommand:'node open-evolution-pr.mjs --dry-run',
 summary:{goal:'Improve the runtime module.',change:'Retry the first connect once.',reason:'A cold start loses the first frame.',files:['apps/server/src/dshEventPump.mjs'],benefits:['Fewer lost frames'],harms:[]}};
let database,notifications,service,reviews,missions,missionId;
before(async()=>{
 if(!url)return;
 database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:8,databaseConnectionTimeoutMs:3000});
 await database.migrate();await migrateProductStore(database);
 for(const id of [first,second,stranger]){
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Engine review test','development')",[id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Reviews',1048576)",[id,id===first?'evimed-evolution':'default']);
 }
 notifications=new NotificationService(database);
 const config={operatorUsers:[first,second],evolutionDailyBudgetCny:50,evolutionRunBudgetCny:10};
 service=new EvolutionService({documents:new ProductDocuments(database),jobs:new ProductJobs(database),ownerId:first,config,notifications});
 reviews=createEvolutionEngineReviews({service,notifications,config});
 notifications.onAction(reviews.decide);
 service.callbacks.engineReviewPrepared=id=>reviews.announce(id);
 service.callbacks.runModuleEngineMission=async()=>({status:'review',review:REVIEW});
 missions=createEvolutionMissions({service,policy:{assignedPolicy:async()=>({id:'P',policy:DEFAULT_EVOLUTION_POLICY}),current:async()=>({policy:DEFAULT_EVOLUTION_POLICY})},map:{rebuild:async()=>({counts:{}})},taskPool:{},signals:{aggregate:async()=>[]},config,adapters:{runtime:{enabled:true}}});
 await missions.opportunity({id:'review-opportunity',moduleId:'runtime',sources:['repair'],taskFamily:'connect',mechanismFamily:'connect',evidenceRoots:['root'],features:{runtimeFailures:3}});
 [missionId]=(await missions.plan({week:'2026-10-05'})).missions;
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[first,second,stranger]]);await database.close();}});
const waiting=async userId=>(await notifications.list(userId,{unresolvedOnly:true})).items.filter(item=>item.source?.id?.startsWith('evolution-engine-review-'));

test('the prepared proposal is one unresolved review item in each operator\'s inbox and nobody else\'s',options,async()=>{
 await missions.run({missionId});
 const [mine]=await waiting(first),[theirs]=await waiting(second);
 assert.ok(mine&&theirs);assert.equal(mine.noticeType,'review');assert.deepEqual(mine.actions.map(action=>action.id),['adopt','decline']);
 assert.deepEqual(await waiting(stranger),[]);
 await missions.run({missionId});await service.callbacks.engineReviewPrepared('review-opportunity');
 assert.equal((await waiting(first)).length,1,'told once, however often the pass comes round');
});
test('answering it in the inbox closes the review on the dossier with who and when, settles the other copy and keeps the adopted work',options,async()=>{
 const [mine]=await waiting(first),[theirs]=await waiting(second);
 const resolved=await notifications.resolve(second,theirs.id,{actionId:'adopt',expectedRevision:theirs.revision});
 assert.equal(resolved.resolution.actionId,'adopt');
 const record=(await service.get('review-opportunity')).payload;
 assert.equal(record.status,'adopted');assert.equal(record.review.decision.by,second);assert.ok(Date.parse(record.review.decision.at)>0);
 assert.equal(record.adoptedWork.reviewId,REVIEW.identity);assert.equal(record.adoptedWork.stagedAt,REVIEW.relativeDirectory);assert.equal(record.adoptedWork.summary.change,REVIEW.summary.change);
 const settled=await notifications.get(first,mine.id);
 assert.ok(settled.resolvedAt);assert.deepEqual([settled.resolution.actionId,settled.resolution.source],['adopt','default']);
 assert.deepEqual(await waiting(first),[]);assert.deepEqual(await waiting(second),[]);
 // The first answer stands.
 await assert.rejects(notifications.resolve(first,mine.id,{actionId:'decline',expectedRevision:settled.revision}),{code:'notification_already_resolved'});
 assert.equal((await service.get('review-opportunity')).payload.status,'adopted');
});
test('an item that is not an engine review resolves as it always did, whatever handlers are registered',options,async()=>{
 const item=await notifications.create(first,{noticeType:'review',title:'Another question',body:'Body',actions:[{id:'adopt',label:'采纳'},{id:'decline',label:'不采纳'}],source:{type:'system',id:'evolution-decision-unrelated'}});
 const resolved=await notifications.resolve(first,item.id,{actionId:'adopt',expectedRevision:item.revision});
 assert.equal(resolved.resolution.actionId,'adopt');
 assert.equal((await service.get('review-opportunity')).payload.review.decision.by,second,'and the review it was not about is as it was');
});
test('an action handler that throws leaves the inbox item open, and handlers run before the item resolves',options,async()=>{
 const seen=[];
 notifications.onAction(async(item,actionId)=>{seen.push([item.resolvedAt,actionId]);if(item.title==='Handler failure')throw new Error('could not carry it out');});
 const item=await notifications.create(first,{noticeType:'review',title:'Handler failure',body:'Body',actions:[{id:'ok',label:'好'}],source:{type:'system',id:'evolution-engine-review-none'}});
 await assert.rejects(notifications.resolve(first,item.id,{actionId:'ok',expectedRevision:item.revision}),/could not carry it out/);
 assert.equal((await notifications.get(first,item.id)).resolvedAt,null);
 assert.deepEqual(seen.at(-1),[null,'ok'],'the handler saw the item still unresolved');
});
