import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ProductDocuments,ProductJobs} from '../src/productStore.mjs';
import {migrateProductStore} from '../src/productPersistence.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';
import {createEvolutionSignals} from '../src/evolutionSignals.mjs';
import {createEvolutionGrowth} from '../src/evolutionGrowth.mjs';
import {evolutionAccountFloors} from '../src/evolutionAccountClasses.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url&&'A disposable localhost test PostgreSQL database is required'};
// The module's owner is the first operator; a second operator and five researchers make the two classes.
const owner=`evolution_${randomUUID()}`,secondOperator=`operator_${randomUUID()}`,researchers=Array.from({length:5},()=>`researcher_${randomUUID()}`);
const operators=[owner,secondOperator];
let database,documents,jobs,service,signals;
const make=(config={})=>{
 const settings={operatorUsers:operators,...config},floors=evolutionAccountFloors(settings);
 const evolution=new EvolutionService({documents,jobs,ownerId:owner,config:settings});
 return{evolution,floors,signals:createEvolutionSignals({service:evolution,capabilityIds:async()=>['statistical-analysis'],operatorIds:()=>operators,floors})};
};
before(async()=>{
 if(!url)return;
 database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:8,databaseConnectionTimeoutMs:3000});
 await database.migrate();await migrateProductStore(database);
 for(const id of [owner,secondOperator,...researchers]){
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Signal floor test','development')",[id]);
  for(const project of id===owner?['evimed-evolution','research']:['research'])await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Floors',1048576)",[id,project]);
 }
 documents=new ProductDocuments(database);jobs=new ProductJobs(database);
 ({evolution:service,signals}=make());
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,secondOperator,...researchers]]);await database.close();}});
const signal=(userId,eventId,patch={})=>({userId,projectId:'research',eventId,kind:'unmet-demand',moduleId:'tools',capability:'statistical-analysis',operation:'transform',dataShape:'table',reason:'missing-tool',...patch});

test('an operator account aggregates on its own at a floor of one while researchers still need five, each class counted apart',options,async()=>{
 await signals.record(signal(owner,'demand'));
 for(const id of researchers.slice(0,3))await signals.record(signal(id,'demand'));
 const first=await signals.aggregate();
 assert.deepEqual(first.map(row=>[row.payload.accountClass,row.payload.distinctAccounts,row.payload.occurrences]),[['operator',1,1]],
  'three researchers are below five and are not counted towards the operator, nor the operator towards them');
 assert.deepEqual(signals.counters,{aggregated:{user:0,operator:1},heldBack:{user:1,operator:0}});
 for(const id of researchers.slice(3))await signals.record(signal(id,'demand'));
 const second=await signals.aggregate();
 assert.deepEqual(second.map(row=>[row.payload.accountClass,row.payload.distinctAccounts]).sort(),[['operator',1],['user',5]]);
 assert.deepEqual(signals.counters,{aggregated:{user:1,operator:1},heldBack:{user:0,operator:0}});
 const user=second.find(row=>row.payload.accountClass==='user');
 assert.equal(user.payload.occurrences,5,'the researchers\' summary counts their five signals only');
 assert.notEqual(user.id,second.find(row=>row.payload.accountClass==='operator').id,'a class has a summary of its own');
 assert.ok(!JSON.stringify(second).includes('researcher_')&&!JSON.stringify(second).includes(owner),'no account is named in a summary');
 const again=await signals.aggregate();
 assert.deepEqual(again.map(row=>[row.id,row.revision]).sort(),second.map(row=>[row.id,row.revision]).sort(),'a pass over the same signals writes nothing new');
});
test('a second operator joins the operator class; the floor is the configured number',options,async()=>{
 const strict=make({evolutionOperatorSignalFloor:2});
 await strict.signals.record(signal(owner,'second-kind',{kind:'route-override',moduleId:'runtime',fromCapability:'statistical-analysis',operation:'route',dataShape:'none',reason:'unsupported'}));
 const held=await strict.signals.aggregate();
 assert.ok(!held.some(row=>row.payload.kind==='route-override'),'one operator is below a floor of two');
 assert.equal(strict.signals.counters.heldBack.operator,2,'the earlier test\'s operator group is below two as well');
 await strict.signals.record(signal(secondOperator,'second-kind',{kind:'route-override',moduleId:'runtime',fromCapability:'statistical-analysis',operation:'route',dataShape:'none',reason:'unsupported'}));
 const met=(await strict.signals.aggregate()).find(row=>row.payload.kind==='route-override');
 assert.equal(met.payload.accountClass,'operator');assert.equal(met.payload.distinctAccounts,2);
});
test('the growth collector turns an operator summary into an opportunity at its floor and leaves researcher summaries below five alone',options,async()=>{
 const offered=[];
 const collector=createEvolutionGrowth({service,database,opportunity:async item=>{offered.push(item);},floors:evolutionAccountFloors({}),operatorIds:()=>operators});
 const operatorOnly=await service.save('signal-summary','floor-test-operator',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'table',reason:'unsupported'},accountClass:'operator',occurrences:2,distinctAccounts:1});
 await service.save('signal-summary','floor-test-user-low',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'text',reason:'unsupported'},accountClass:'user',occurrences:3,distinctAccounts:3});
 await service.save('signal-summary','floor-test-legacy-low',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'image',reason:'unsupported'},occurrences:1,distinctAccounts:1});
 await collector.collect();
 const mine=offered.filter(item=>item.moduleId==='sources');
 assert.deepEqual(mine.map(item=>item.evidenceRoots),[[operatorOnly.id]],'only the operator summary passes its floor');
 assert.equal(mine[0].features.accountClass,'operator');assert.equal(mine[0].features.demandFloor,1);
});
test('an operator lead is queued at once, a researcher lead accumulates to five, and the lead says how many of each it saw',options,async()=>{
 const lead=(userId,gapCode,event)=>({track:'M',source:'runtime-failure',gapCode,userId,projectId:'research',sourceEventId:event});
 const mine=await service.addLead(lead(owner,'method-missing','operator-event'));
 assert.equal(mine.payload.status,'queued');assert.equal(mine.payload.operatorAccounts,1);assert.equal(mine.payload.userAccounts,0);
 let shared;
 for(const id of researchers.slice(0,4))shared=await service.addLead(lead(id,'connector','researcher-event'));
 assert.equal(shared.payload.status,'accumulating');assert.equal(shared.payload.distinctAccounts,4);
 shared=await service.addLead(lead(researchers[4],'connector','researcher-event'));
 assert.equal(shared.payload.status,'queued');assert.equal(shared.payload.distinctAccounts,5);
 // A lead the operator also saw is read at the operator floor, whatever the researchers counted.
 let mixed;
 for(const id of researchers.slice(0,2))mixed=await service.addLead(lead(id,'extraction','mixed-event'));
 assert.equal(mixed.payload.status,'accumulating');
 mixed=await service.addLead(lead(owner,'extraction','mixed-event'));
 assert.equal(mixed.payload.status,'queued');assert.equal(mixed.payload.operatorAccounts,1);assert.equal(mixed.payload.userAccounts,2);
});
test('resumed research finished in a window is counted for the operator class and withheld for researchers below five',options,async()=>{
 const from='2026-10-01T00:00:00.000Z',to='2026-11-01T00:00:00.000Z';
 const waiter=(userId,id)=>service.save('waiter',`floor-waiter-${id}`,{status:'resolved',projectId:'research',agendaId:id,completedResearchAt:'2026-10-05T00:00:00.000Z'},null,userId);
 const counter=createEvolutionGrowth({service,database,opportunity:async()=>{},floors:evolutionAccountFloors({}),operatorIds:()=>operators});
 for(const [index,id] of researchers.slice(0,3).entries())await waiter(id,`u${index}`);
 assert.equal(await counter.completedAggregate(from,to),null,'three researchers are below five');
 await waiter(owner,'op');
 assert.equal(await counter.completedAggregate(from,to),1,'the operator class counts on its own');
 for(const [index,id] of researchers.slice(3).entries())await waiter(id,`u${index+3}`);
 assert.equal(await counter.completedAggregate(from,to),6,'both classes now reach their floors');
});
