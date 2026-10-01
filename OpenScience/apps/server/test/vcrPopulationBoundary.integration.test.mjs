import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { Readable } from 'node:stream';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrJobs } from '../src/vcrJobs.mjs';
import { VcrService } from '../src/vcrService.mjs';
import { createVcrGatewayHandler } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options={skip:!url && 'A local PostgreSQL is required.'};
let isolated,database,store,study,handler;
const valid={n:500,population:{variables:[{name:'age',family:'normal',mean:65,sd:10}]}};
before(async()=>{
  if(!url)return;
  isolated=await createGeoTestDatabase(url,'populationboundary');
  database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:5000});
  store=new VcrStore({database});await store.ready();
  study=await store.createStudy({userId:'alice',projectId:'boundary',name:'Population boundary'});
  const config={vcrEnabled:true,vcrAudience:'all',vcrJobCpuSeconds:60,vcrStudyCpuBudget:1200,vcrMaxConcurrentJobs:1,modelGatewayInternalUrl:'http://127.0.0.1/internal/models/v1'};
  const service=new VcrService({store,config});
  const jobs=new VcrJobs({store,config,engine:{configured:()=>true}});
  handler=createVcrGatewayHandler(config,{assertActiveModelGatewayToken:()=>({userId:'alice',projectId:'boundary'})},{vcr:{store,service,jobs}});
});
after(async()=>{await database?.close();await isolated?.drop();});
async function ask(scenario,inputs=[]){
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({action:'start',kind:'generate_population',scenario,inputs}))]),
    {method:'POST',url:'/internal/vcr/v1/simulate',headers:{authorization:'Bearer test','content-type':'application/json'}});
  const res={status:0,body:'',writeHead(status){this.status=status;},end(body){this.body=body.toString();}};
  await handler(req,res);return {status:res.status,body:JSON.parse(res.body)};
}
test('C2-26 hostile LLM population payloads reach the real queue validator and never create patient jobs',options,async()=>{
  let deep={op:'compare',column:'age',comparator:'gt',value:18};
  for(let i=0;i<40;i++)deep={op:'not',arg:deep};
  const scenarios=[
    {...valid,patients:[{name:'PHI_CANARY',outcome:1}]}, {...valid,records:[{age:44}]}, {...valid,prompt:'Use an LLM to invent 500 patients and outcomes'},
    {n:500,population:{variables:[{name:'age',family:'llm'}]}},
    {...valid,population:{...valid.population,constraints:{op:'filter',expression:'system(unsafe)'}}},
    {...valid,population:{...valid.population,constraints:{op:'compare',column:'absent_column',comparator:'gt',value:0}}},
    {...valid,population:{...valid.population,constraints:deep}},
  ];
  for(const scenario of scenarios){
    const result=await ask(scenario);assert.equal(result.status,400);
    assert.deepEqual(result.body.alternatives.map(row=>row.kind),['reference_scenario','registered_model','authorized_data']);
  }
  const forged=await ask(valid,[{kind:'evidence',id:'invented',location:'/etc/passwd',hash:'a'.repeat(64)}]);assert.equal(forged.status,400);
  assert.equal((await store.rows('SELECT id FROM evimed_vcr.jobs WHERE study_id=$1',[study.id])).length,0);
  const good=await ask(valid);assert.equal(good.status,200);assert.equal(good.body.data.state,'queued');
  assert.equal((await store.rows('SELECT id FROM evimed_vcr.jobs WHERE study_id=$1',[study.id])).length,1);
  assert.equal((await store.results(study.id)).length,0,'Parameterization is not a fabricated patient result.');
});
