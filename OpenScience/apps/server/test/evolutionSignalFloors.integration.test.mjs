import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ProductDocuments,ProductJobs} from '../src/productStore.mjs';
import {migrateProductStore} from '../src/productPersistence.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL??'';
if(url){const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname));assert.match(parsed.pathname,/evimed_test/);}
const options={skip:!url&&'A disposable localhost test PostgreSQL database is required'};
// The module's owner is the first operator; a second operator and five researchers make the two classes. A researcher passes on their own
// (the floor is one account, `EVOLUTION_DEMAND_MIN_ACCOUNTS`); the operator floor is one by default and the operator may raise it to five.
// What the floors still decide is a lead: the signal summaries, the growth collector and the completed-research count that read them left with the experiment engine.
const owner=`evolution_${randomUUID()}`,secondOperator=`operator_${randomUUID()}`,researchers=Array.from({length:5},()=>`researcher_${randomUUID()}`);
const operators=[owner,secondOperator];
let database,documents,jobs,service;
const make=(config={})=>new EvolutionService({documents,jobs,ownerId:owner,config:{operatorUsers:operators,...config}});
before(async()=>{
 if(!url)return;
 database=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:8,databaseConnectionTimeoutMs:3000});
 await database.migrate();await migrateProductStore(database);
 for(const id of [owner,secondOperator,...researchers]){
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Signal floor test','development')",[id]);
  for(const project of id===owner?['evimed-evolution','research']:['research'])await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Floors',1048576)",[id,project]);
 }
 documents=new ProductDocuments(database);jobs=new ProductJobs(database);
 service=make();
});
after(async()=>{if(database){await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,secondOperator,...researchers]]);await database.close();}});

test('a researcher lead and an operator lead are queued at once at the default floors, a raised operator floor holds an operator-only lead, and the lead says how many of each it saw',options,async()=>{
 const lead=(userId,gapCode,event)=>({track:'M',source:'runtime-failure',gapCode,userId,projectId:'research',sourceEventId:event});
 const mine=await service.addLead(lead(owner,'method-missing','operator-event'));
 assert.equal(mine.payload.status,'queued');assert.equal(mine.payload.operatorAccounts,1);assert.equal(mine.payload.userAccounts,0);
 let shared=await service.addLead(lead(researchers[0],'connector','researcher-event'));
 assert.equal(shared.payload.status,'queued','one researcher opens a lead on their own');assert.equal(shared.payload.distinctAccounts,1);assert.equal(shared.payload.operatorAccounts,undefined,'no operator saw it');
 for(const id of researchers.slice(1))shared=await service.addLead(lead(id,'connector','researcher-event'));
 assert.equal(shared.payload.status,'queued');assert.equal(shared.payload.distinctAccounts,5,'every researcher is still counted, privately');
 // Under an operator floor of two one operator does not open a lead; a second operator does, and so does a researcher alone.
 const strict=make({evolutionOperatorSignalFloor:2});
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
