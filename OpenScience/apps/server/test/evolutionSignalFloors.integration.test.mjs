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
// The module's owner is the first operator; a second operator and five researchers make the two classes. A researcher passes on their own
// (the floor is one account, `EVOLUTION_DEMAND_MIN_ACCOUNTS`); the operator floor is one by default and the operator may raise it to five.
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

test('each class is counted on its own at its own floor: a researcher alone passes at one, an operator under a raised floor is held, and neither counts towards the other',options,async()=>{
 assert.deepEqual(signals.floors,{user:1,operator:1},'the default floors are one account of either class');
 await signals.record(signal(researchers[0],'demand'));
 const alone=await signals.aggregate();
 assert.deepEqual(alone.map(row=>[row.payload.accountClass,row.payload.distinctAccounts,row.payload.occurrences]),[['user',1,1]],'one researcher passes the researcher floor on their own');
 assert.deepEqual(signals.counters,{aggregated:{user:1,operator:0},heldBack:{user:0,operator:0}});
 // An operator floor of two is not met by one operator and one researcher: the classes are not pooled.
 const strict=make({evolutionOperatorSignalFloor:2});
 await strict.signals.record(signal(owner,'demand'));
 const apart=await strict.signals.aggregate();
 assert.deepEqual(apart.map(row=>[row.payload.accountClass,row.payload.distinctAccounts,row.payload.occurrences]),[['user',1,1]],'a researcher is not counted towards the operator floor');
 assert.deepEqual(strict.signals.counters,{aggregated:{user:1,operator:0},heldBack:{user:0,operator:1}});
 const first=await signals.aggregate();
 assert.deepEqual(first.map(row=>[row.payload.accountClass,row.payload.distinctAccounts,row.payload.occurrences]).sort(),[['operator',1,1],['user',1,1]],
  'at the default operator floor the same operator signal passes, and the researcher\'s summary does not count it');
 assert.deepEqual(signals.counters,{aggregated:{user:1,operator:1},heldBack:{user:0,operator:0}});
 for(const id of researchers.slice(1))await signals.record(signal(id,'demand'));
 const second=await signals.aggregate();
 assert.deepEqual(second.map(row=>[row.payload.accountClass,row.payload.distinctAccounts]).sort(),[['operator',1],['user',5]],'five researchers are one summary, and the operator is not among them');
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
test('the growth collector offers a summary that meets its own class floor, reads a record without a class as a researcher, and leaves an operator summary under a raised floor alone',options,async()=>{
 const offered=[];
 const collect=async floors=>{offered.length=0;await createEvolutionGrowth({service,database,opportunity:async item=>{offered.push(item);},floors,operatorIds:()=>operators}).collect();return offered.filter(item=>item.moduleId==='sources');};
 const operatorOnly=await service.save('signal-summary','floor-test-operator',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'table',reason:'unsupported'},accountClass:'operator',occurrences:2,distinctAccounts:1});
 const userThree=await service.save('signal-summary','floor-test-user',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'text',reason:'unsupported'},accountClass:'user',occurrences:3,distinctAccounts:3});
 const legacyOne=await service.save('signal-summary','floor-test-legacy',{moduleId:'sources',kind:'source-omission',codes:{capability:'unknown',operation:'unknown',dataShape:'image',reason:'unsupported'},occurrences:1,distinctAccounts:1});
 const roots=items=>items.map(item=>item.evidenceRoots[0]).sort();
 const defaults=await collect(evolutionAccountFloors({}));
 assert.deepEqual(roots(defaults),[operatorOnly.id,userThree.id,legacyOne.id].sort(),'each summary meets its class floor of one, the record with no class counting as a researcher\'s');
 const byRoot=id=>defaults.find(item=>item.evidenceRoots[0]===id);
 assert.equal(byRoot(operatorOnly.id).features.accountClass,'operator');assert.equal(byRoot(operatorOnly.id).features.demandFloor,1);
 assert.equal(byRoot(userThree.id).features.accountClass,undefined);assert.equal(byRoot(userThree.id).features.distinctAccounts,3);
 assert.equal(byRoot(legacyOne.id).features.accountClass,undefined);
 const strict=await collect(evolutionAccountFloors({evolutionOperatorSignalFloor:2}));
 assert.deepEqual(roots(strict),[userThree.id,legacyOne.id].sort(),'one operator account is under a raised operator floor of two; the researcher summaries still pass at one');
});
test('a researcher lead and an operator lead are queued at once at the default floors, a raised operator floor holds an operator-only lead, and the lead says how many of each it saw',options,async()=>{
 const lead=(userId,gapCode,event)=>({track:'M',source:'runtime-failure',gapCode,userId,projectId:'research',sourceEventId:event});
 const mine=await service.addLead(lead(owner,'method-missing','operator-event'));
 assert.equal(mine.payload.status,'queued');assert.equal(mine.payload.operatorAccounts,1);assert.equal(mine.payload.userAccounts,0);
 let shared=await service.addLead(lead(researchers[0],'connector','researcher-event'));
 assert.equal(shared.payload.status,'queued','one researcher opens a lead on their own');assert.equal(shared.payload.distinctAccounts,1);assert.equal(shared.payload.operatorAccounts,undefined,'no operator saw it');
 for(const id of researchers.slice(1))shared=await service.addLead(lead(id,'connector','researcher-event'));
 assert.equal(shared.payload.status,'queued');assert.equal(shared.payload.distinctAccounts,5,'every researcher is still counted, privately');
 // Under an operator floor of two one operator does not open a lead; a second operator does, and so does a researcher alone.
 const strict=make({evolutionOperatorSignalFloor:2}).evolution;
 let pair=await strict.addLead(lead(owner,'routing','pair-event'));
 assert.equal(pair.payload.status,'accumulating','one operator is below a floor of two');assert.equal(pair.payload.operatorAccounts,1);assert.equal(pair.payload.userAccounts,0);
 pair=await strict.addLead(lead(secondOperator,'routing','pair-event'));
 assert.equal(pair.payload.status,'queued');assert.equal(pair.payload.operatorAccounts,2);assert.equal(pair.payload.userAccounts,0);
 // A lead the researcher also saw is read at the researcher floor, whatever the operators counted.
 let mixed=await strict.addLead(lead(owner,'writing','mixed-event'));
 assert.equal(mixed.payload.status,'accumulating');
 mixed=await strict.addLead(lead(researchers[0],'writing','mixed-event'));
 assert.equal(mixed.payload.status,'queued');assert.equal(mixed.payload.operatorAccounts,1);assert.equal(mixed.payload.userAccounts,1);
});
test('resumed research finished in a window is counted per class at its own floor: a researcher counts alone, an operator only at the configured floor',options,async()=>{
 const from='2026-10-01T00:00:00.000Z',to='2026-11-01T00:00:00.000Z';
 const waiter=(userId,id)=>service.save('waiter',`floor-waiter-${id}`,{status:'resolved',projectId:'research',agendaId:id,completedResearchAt:'2026-10-05T00:00:00.000Z'},null,userId);
 const counterAt=floors=>createEvolutionGrowth({service,database,opportunity:async()=>{},floors,operatorIds:()=>operators});
 const counter=counterAt(evolutionAccountFloors({})),strict=counterAt(evolutionAccountFloors({evolutionOperatorSignalFloor:2}));
 assert.equal(await counter.completedAggregate(from,to),null,'no account finished one, so nothing is said');
 await waiter(owner,'op');
 assert.equal(await counter.completedAggregate(from,to),1,'the operator class counts on its own at the default floor of one');
 assert.equal(await strict.completedAggregate(from,to),null,'one operator is under a raised floor of two');
 await waiter(researchers[0],'u0');
 assert.equal(await counter.completedAggregate(from,to),2);
 assert.equal(await strict.completedAggregate(from,to),1,'the researcher counts at one; the operator still does not, and the researcher is not counted towards it');
 await waiter(secondOperator,'op2');
 assert.equal(await strict.completedAggregate(from,to),3,'two operators reach the raised floor');
 for(const [index,id] of researchers.slice(1).entries())await waiter(id,`u${index+1}`);
 assert.equal(await counter.completedAggregate(from,to),7,'both classes count in full');
 assert.equal(await strict.completedAggregate(from,to),7);
});
