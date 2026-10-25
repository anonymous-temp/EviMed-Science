import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { mkdir,writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { EvidenceZoneService } from '../src/evidenceZoneService.mjs';
import { createSourceChanges } from '../src/sourceChanges.mjs';
import { PLATFORM_PUBLISHER_USER_ID,geoClaimApplicability } from '@evimed/domain';
import { freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,opts={skip:!url&&'Disposable local Postgres required'};
let isolated,database,store,service,project,documents,changes;const user={id:'support-owner'};
before(async()=>{
 if(!url)return;isolated=await createGeoTestDatabase(url,'geosupport');
 database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
 store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();await new EvidenceZoneService({database}).ready();documents=new ProductDocuments(database);
 await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Support','development'),('support-viewer','Viewer','development')",[user.id]);
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'support-control','Support',1048576)",[user.id]);
 project=await store.createProject({userId:user.id,projectId:'support-control',engines:['deepseek'],coverageDays:90,product:{brandName:'Alpha'}});
 service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});await store.addMember({geoId:project.id,userId:'support-viewer',role:'viewer',invitedBy:user.id});
 await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES('support-zone',$1,'Evidence','draft')",[user.id]);
 await store.query("UPDATE evimed_geo.projects SET product_zone_id='support-zone' WHERE id=$1",[project.id]);project.productZoneId='support-zone';
 const claims=[1,2].map(n=>({id:'support-c'+n,key:'claim'+n,version:1,status:'active',statement:'Same claim',quote:'Preserved quote '+n,sourceRef:'https://doi.org/10.1000/support'+n,population:n===1?'Adults':'Children',elements:{dose:n===1?'10 mg':'5 mg'},cardId:'support-card',cardClaimId:'C'+n,cardRevision:1}));
 const cardClaims=claims.map((claim,n)=>({claimId:claim.cardClaimId,claimType:'direct',claim:claim.statement,supportQuote:claim.quote,sourceIndexes:[n+1]}));
 const sources=claims.map(claim=>({title:claim.sourceRef,url:claim.sourceRef,documentText:claim.quote}));
 await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,sources,claims,revision) VALUES('support-card','support-zone',$1,'Card','academic','draft',$2::jsonb,$3::jsonb,1)",[user.id,JSON.stringify(sources),JSON.stringify(cardClaims)]);
 await database.query("INSERT INTO evimed_frontier.evidence_card_revisions(card_id,revision,snapshot) VALUES('support-card',1,$1::jsonb)",[JSON.stringify({id:'support-card',revision:1,claims:cardClaims,sources})]);
 for(const claim of claims)await store.query("INSERT INTO evimed_geo.claims(id,user_id,geo_project_id,claim_key,version,statement,quote,source_ref,status,card_id,card_claim_id,card_revision) VALUES($1,$2,$3,$4,1,$5,$6,$7,'active','support-card',$8,1)",[claim.id,user.id,project.id,claim.key,claim.statement,claim.quote,claim.sourceRef,claim.cardClaimId]);
 for(const [id,n,date] of [['old',1,'2026-10-01'],['new',2,'2026-10-02']]){
  await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,$4,'P2','Same group')",['g-'+id,user.id,project.id,n]);
  await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES($1,$2,$3,$4,$5,'P2','Original?',true)",['q-'+id,user.id,project.id,'g-'+id,n]);
  const value={version:n,data:{findings:[{id:'f1',statement:id==='old'?'Frozen original finding':'New replacement finding'}]}};
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,created_at,surface,ref) VALUES($1,$2,$3,'baseline','done',$4,'{deepseek}',$5,$5::date,'{\"mode\":\"web\"}',$6::jsonb)",[id,user.id,project.id,n,date,JSON.stringify({evaluationBasis:{claims,value}})]);
  await store.writeValue(user.id,project.id,value.data);
  const count=id==='old'?37:1;
  for(let index=0;index<count;index++){
   const snapshot='s-'+id+'-'+index;
   await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) VALUES($1,$2,$3,$4,$5,'deepseek',$6,'valid','Preserved answer quote','{\"mode\":\"web\"}')",[snapshot,user.id,project.id,id,'q-'+id,date]);
   const claim=claims[index%2],statement={text:'Preserved answer quote',claimId:claim.id,claimVersion:1,applicability:geoClaimApplicability(claim),verdict:index%2?'wrong':'correct'};
   await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,statements,checks,judge_extract) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)",[snapshot,user.id,project.id,date,JSON.stringify([statement]),JSON.stringify({judgementCoverage:{status:index===36?'partial':'complete'}}),JSON.stringify({valueBasisVersion:n,valueCoverage:[{findingId:'f1',status:index===36?'not_addressed':'represented',quote:'Preserved answer quote'}]})]);
  }
 }
 changes=createSourceChanges({documents,ownerUserId:PLATFORM_PUBLISHER_USER_ID});
});
after(async()=>{await database?.close();await isolated?.drop();});

test('V16 actual selected sources, complete observation members and frozen native/export context agree',opts,async()=>{
 const view=await service.analysis(user,project.id,{viewId:'V16',round:'old'});
 assert.equal(view.rows.length,2);assert.ok(view.rows.every(row=>row.dimensions.claimVersion===1));
 assert.equal(view.rows.reduce((sum,row)=>sum+row.values.observations.value,0),37);
 assert.equal(view.rows.reduce((sum,row)=>sum+(row.values.supported.value??0),0),19);
 assert.equal(view.rows.reduce((sum,row)=>sum+(row.values.contradicted.value??0),0),18);
 assert.equal((await service.analysis({id:'support-viewer'},project.id,{...view.view,selectionRef:view.selection.reference})).digest,view.digest);
 await assert.rejects(service.analysis({id:'stranger'},project.id,{viewId:'V16',round:'old'}),error=>error.status===404);
 const finding=await service.analysis(user,project.id,{viewId:'V16',evidenceKind:'findings',selectionRef:view.selection.reference});
 assert.equal(finding.rows.length,1);assert.equal(finding.rows[0].values.observations.value,37);assert.equal(finding.rows[0].values.uncertain.value,1);
 assert.equal(finding.rows[0].dimensions.finding.statement,'Frozen original finding');
 const row=finding.rows[0],all=[];
 for(let offset=0;offset<37;offset+=20){const page=await service.analysisMembers(user,project.id,{...finding.view,selectionRef:finding.selection.reference,rowKey:row.key,columnKey:'observations',expectedDigest:finding.digest,offset,limit:20});all.push(...page.items);}
 assert.equal(new Set(all.map(item=>item.id)).size,37);assert.ok(all.every(item=>item.answer.answer_text==='Preserved answer quote'));
 const adapter=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=adapter;const preserved=[];
 for(const current of [view,finding]){
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:current.selection.reference,view:current.view,expectedDigest:current.digest});
  const staged=await adapter.stage(user,project.id,{requestKey:'support-'+current.view.evidenceKind,sessionId:'support-session',mode:'analysis',selectionRef:current.selection.reference,view:current.view,expectedDigest:current.digest,intent:'explain'});
  const request={requestId:'native-'+current.view.evidenceKind,sessionId:'support-session',content:[{type:'text',text:'Explain the selected evidence.'}],geoPlanContext:{referenceId:staged.referenceId}};await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
  assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50})).rows,full.rows);
  preserved.push({referenceId:staged.referenceId,rows:full.rows});
  const doc=freezeGeoAnalysisDocument(full);assert.ok(doc.canonicalMarkdown.includes('s-old-36')||current.view.evidenceKind==='claims');
  if(process.env.GEO_E2_RECEIPTS_DIR){await mkdir(process.env.GEO_E2_RECEIPTS_DIR,{recursive:true});await writeFile(`${process.env.GEO_E2_RECEIPTS_DIR}/document-V16-${current.view.evidenceKind}.json`,JSON.stringify({...doc,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 }
 await changes.record('10.1000/support2',{kind:'retraction',date:'2026-10-20',noticeIdentifier:'10.1000/notice'},{assertedBy:'operator'});
 const changed=await service.analysis(user,project.id,{...view.view,selectionRef:view.selection.reference});
 assert.equal(changed.rows.find(row=>row.dimensions.claimId==='support-c2').values.updateNeeded.value,18);
 assert.equal(changed.rows.find(row=>row.dimensions.claimId==='support-c1').values.supported.value,19);
 assert.equal((await service.analysis(user,project.id,{...finding.view,selectionRef:finding.selection.reference})).digest,finding.digest,'Source changes do not reinterpret finding-expression observations');
 for(const saved of preserved)assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:saved.referenceId,limit:50})).rows,saved.rows);
 const changedFull=await freezeSelectedGeoAnalysis(store,project,{selectionRef:changed.selection.reference,view:changed.view,expectedDigest:changed.digest});
 const updatedDocument=freezeGeoAnalysisDocument(changedFull);
 assert.ok(updatedDocument.typedTable.rows.every(row=>Object.values(row).every(value=>typeof value!=='string'||value.length<=32767)), 'Every context cell must remain renderable after source notices expand it');
 for(const row of changedFull.rows){
  const main=updatedDocument.typedTable.rows.find(item=>item.key===row.key);
  const parts=updatedDocument.typedTable.rows.filter(item=>item.context_parent===row.key&&item.context_field==='dimensions');
  const dimensions=main.dimensions??parts.map(item=>item.dimensions).join('');
  assert.deepEqual(JSON.parse(dimensions),row.dimensions,'Continuation rows preserve the entire exact object context');
 }
 if(process.env.GEO_E2_RECEIPTS_DIR){await writeFile(`${process.env.GEO_E2_RECEIPTS_DIR}/document-V16-updated.json`,JSON.stringify({...updatedDocument,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:changed.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 await assert.rejects(service.analysisMembers(user,project.id,{...view.view,selectionRef:view.selection.reference,rowKey:view.rows[0].key,columnKey:'observations',expectedDigest:view.digest}),error=>error.status===409);
});
