import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {GeoStore} from '../src/geoStore.mjs';
import {GeoMeasureStore} from '../src/geoMeasureStore.mjs';
import {GeoService} from '../src/geoService.mjs';
import {ProductDocuments} from '../src/productStore.mjs';
import {GeoPlanContext} from '../src/geoPlanContext.mjs';
import {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument} from '../src/geoAnalysis.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {seedGeoProject} from './helpers/geoMeasureFixtures.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,options={skip:!url};
const user={id:'execution-owner'};
let isolated,database,store,service,project,documents;
before(async()=>{
 if(!url)return;isolated=await createGeoTestDatabase(url,'geoexecution');
 database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
 store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();documents=new ProductDocuments(database);
 await seedGeoProject(database,{id:'execution-geo',userId:user.id,projectId:'execution-control',engines:['deepseek','kimi'],groups:[{id:'execution-group',pool:'P2'}],questions:[{id:'execution-question',groupId:'execution-group',text:'Original question?'}],claims:[{key:'label',statement:'Preserved condition',quote:'Preserved quotation'}]});
 project=await new GeoMeasureStore(database).project('execution-geo');service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('execution-viewer','Viewer','development')");
 await store.addMember({geoId:project.id,userId:'execution-viewer',role:'viewer',invitedBy:user.id});
 await store.query("UPDATE evimed_geo.claims SET population='Adults',elements='{\"dose\":0}',in_label=false WHERE geo_project_id=$1",[project.id]);
 for(const round of ['old','new']){
  const day=round==='old'?'2026-10-01':'2026-10-02';
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,created_at,finished_at,sample_date) VALUES($1,$2,$3,'baseline','done',1,'{deepseek,kimi}',$4::timestamptz,$4::timestamptz,$4::date)",[round,user.id,project.id,day]);
  for(const engine of ['deepseek','kimi']){
   await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text) VALUES($1,$2,$3,$4,'execution-question',$5,'valid',$6,'Original answer')",[round+'-'+engine,user.id,project.id,round,engine,day]);
   await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,checks) VALUES($1,$2,$3,$4,'{\"judgementCoverage\":{\"status\":\"complete\"}}')",[round+'-'+engine,user.id,project.id,day]);
  }
 }
 await store.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,claim_id,error_type,severity,statement,status,judgment_state)
 SELECT 'execution-error-'||n,$1,$2,'fingerprint-'||n,CASE WHEN n%2=0 THEN 'deepseek' ELSE 'kimi' END,'execution-question',CASE WHEN n%2=0 THEN 'old-deepseek' ELSE 'old-kimi' END,CASE WHEN n%2=0 THEN 'old-deepseek' ELSE 'old-kimi' END,'execution-geo_claim_0',CASE WHEN n=619 THEN 'dropped_condition' ELSE 'number' END,CASE WHEN n=619 THEN 'S4' WHEN n=2 THEN NULL ELSE 'S1' END,'Error statement '||n,CASE WHEN n=0 THEN 'closed' ELSE 'open' END,CASE WHEN n=1 THEN 'withdrawn' ELSE 'active' END FROM generate_series(0,619)n`,[user.id,project.id]);
 await store.query("INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,error_type,severity,statement) VALUES('new-only',$1,$2,'new-only','deepseek','execution-question','new-deepseek','new-deepseek','number','S1','Outside old selection')",[user.id,project.id]);
});
after(async()=>{await database?.close();await isolated?.drop();});
test('V13 complete error distribution shares scope, exact members, five-format input and frozen native object history',options,async()=>{
 const view=await service.analysis(user,project.id,{viewId:'V13',round:'old'});
 assert.equal(view.rows.reduce((sum,row)=>sum+row.values.total.value,0),619);
 assert.equal(view.rows.reduce((sum,row)=>sum+row.values.unresolved.value,0),618);
 assert.equal((await service.analysis({id:'execution-viewer'},project.id,{...view.view,selectionRef:view.selection.reference})).digest,view.digest);
 await assert.rejects(service.analysis({id:'stranger'},project.id,{viewId:'V13',round:'old'}),error=>error.status===404);
 const rare=view.rows.find(row=>row.dimensions.category==='dropped_condition');
 const rarePage=await service.analysisMembers(user,project.id,{...view.view,selectionRef:view.selection.reference,rowKey:rare.key,columnKey:'engine_kimi',expectedDigest:view.digest});
 assert.equal(rarePage.total,1);assert.match(rarePage.items[0].errorRevision,/^[a-f0-9]{32}$/u);assert.equal(rarePage.items[0].id,'execution-error-619');assert.equal(rarePage.items[0].snapshotId,'old-kimi');
 assert.equal(rarePage.items[0].answer.answer_text,'Original answer');assert.equal(rarePage.items[0].currentClaim.applicability.inLabel,false);assert.equal(rarePage.items[0].currentClaim.applicability.elements.dose,0);
 const number=view.rows.find(row=>row.dimensions.category==='number'),all=[];
 for(let offset=0;offset<618;offset+=50)all.push(...(await service.analysisMembers(user,project.id,{...view.view,selectionRef:view.selection.reference,rowKey:number.key,columnKey:'total',expectedDigest:view.digest,offset,limit:50})).items);
 assert.equal(new Set(all.map(item=>item.id)).size,618);assert.ok(all.every(item=>item.unit==='error_records'));
 const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
 const adapter=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=adapter;
 const staged=await adapter.stage(user,project.id,{requestKey:'error-distribution',sessionId:'execution-session',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'explain'});
 const request={requestId:'execution-native-input',sessionId:'execution-session',content:[{type:'text',text:'Explain the selected error records.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
 const frozen=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50});assert.equal(frozen.digest,full.digest);
 const restored=[];let offset=0;
 while(offset!==null){const page=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:number.key,columnKey:'objects',offset,limit:50});restored.push(...page.items);offset=page.nextOffset;}
 assert.deepEqual(restored,full.rows.find(row=>row.key===number.key).dimensions.objects);
 for(const descriptor of [view.view,{viewId:'V13',errorFacet:'severity',errorView:'active'},{viewId:'V13',errorFacet:'type',errorView:'withdrawn'}]){
  const complete=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:descriptor});
  const doc=freezeGeoAnalysisDocument(complete);assert.equal(doc.cover.analysis.digest,complete.digest);
  if(descriptor.errorView==='withdrawn')assert.equal(complete.rows.reduce((sum,row)=>sum+row.values.total.value,0),1);
  if(process.env.GEO_F1_RECEIPTS_DIR){await mkdir(process.env.GEO_F1_RECEIPTS_DIR,{recursive:true});await writeFile(`${process.env.GEO_F1_RECEIPTS_DIR}/document-${complete.view.errorFacet}-${complete.view.errorView}.json`,JSON.stringify({...doc,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:complete.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 }
 await store.query("UPDATE evimed_geo.errors SET severity='S4',updated_at=now() WHERE id='execution-error-3'");
 await assert.rejects(service.analysisMembers(user,project.id,{...view.view,selectionRef:view.selection.reference,rowKey:number.key,columnKey:'total',expectedDigest:view.digest}),error=>error.status===409);
 const retained=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:number.key,columnKey:'objects',limit:50});assert.deepEqual(retained.items,restored.slice(0,retained.items.length));
});
