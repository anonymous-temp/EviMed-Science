import assert from 'node:assert/strict';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {GeoStore} from '../src/geoStore.mjs';
import {GeoMeasureStore} from '../src/geoMeasureStore.mjs';
import {GeoService} from '../src/geoService.mjs';
import {ProductDocuments} from '../src/productStore.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {seedGeoProject} from './helpers/geoMeasureFixtures.mjs';
import {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument} from '../src/geoAnalysis.mjs';
import {GeoPlanContext} from '../src/geoPlanContext.mjs';
import {errorFingerprint} from '../src/geoErrorIdentity.mjs';
import {geoClaimApplicability} from '@evimed/domain';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('preserved clinical identity survives V13 and unsupported list filters are refused',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'f1origin');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:2000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();
 const user={id:'f1-spec-owner'},id='f1-spec-geo';
 await seedGeoProject(database,{id,userId:user.id,projectId:'f1-spec-control',engines:['deepseek'],groups:[{id:'g',pool:'P2'}],questions:[{id:'q',groupId:'g',text:'Question'}],claims:[{key:'claim',statement:'Original adult statement',quote:'Preserved adult quotation'}]});
 const originalClaim={id:id+'_claim_0',version:1,population:'Adults',elements:{dose:'10 mg'},inLabel:false};
 const original={text:'Original answer misstatement',claimId:originalClaim.id,claimVersion:1,applicability:geoClaimApplicability(originalClaim),verdict:'wrong'};
 const fingerprint=errorFingerprint(original);
 await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,ref) VALUES('r',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01',$3::jsonb)",[user.id,id,JSON.stringify({evaluationBasis:{claims:[originalClaim]}})]);
 await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text,asked_at) VALUES('s',$1,$2,'r','q','deepseek','valid','Original answer misstatement','2026-10-01')",[user.id,id]);
 await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,statements,checks) VALUES('s',$1,$2,'2026-10-01',$3::jsonb,'{\"judgementCoverage\":{\"status\":\"complete\"}}')",[user.id,id,JSON.stringify([original])]);
 await store.query("UPDATE evimed_geo.claims SET version=3,population='Children',elements='{\"dose\":\"5 mg\"}',in_label=true WHERE id=$1",[originalClaim.id]);
 for(const [errorId,severity,quote] of [['e1','S1','Preserved adult quotation'],['e2','S4','Second quotation']])await store.query("INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,claim_id,error_type,severity,statement,evidence_quote) VALUES($1,$2,$3,$4,'deepseek','q','s','s',$5,'number',$6,'Original answer misstatement',$7)",[errorId,user.id,id,errorId==='e1'?fingerprint:'second-fingerprint',originalClaim.id,severity,quote]);
 const project=await new GeoMeasureStore(database).project(id),service=new GeoService({store,documents:new ProductDocuments(database),config:{geoEnabled:true,geoAudience:'all'}});
 const diagnosis=await service.diagnosis(user,id,{round:'r'});
 const view=await service.analysis(user,id,{viewId:'V13',round:'r'}),row=view.rows[0];
 const page=await service.analysisMembers(user,id,{...view.view,selectionRef:view.selection.reference,rowKey:row.key,columnKey:'total',expectedDigest:view.digest});
 const exact=page.items.find(item=>item.id==='e1'),origin=diagnosis.errors.find(item=>item.id==='e1');
 const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view}),document=freezeGeoAnalysisDocument(full);
 if(process.env.GEO_F1_RECEIPTS_DIR){const {writeFile}=await import('node:fs/promises');await writeFile(process.env.GEO_F1_RECEIPTS_DIR+'/document-original.json',JSON.stringify({...document,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 const adapter=new GeoPlanContext({documents:new ProductDocuments(database),store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=adapter;
 const staged=await adapter.stage(user,id,{requestKey:'original-identity',sessionId:'original-session',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'explain'});
 const request={requestId:'original-native-input',sessionId:'original-session',content:[{type:'text',text:'Explain the original and current clinical conditions separately.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
 const native=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId});
 assert.deepEqual(native.rows[0].dimensions.objects.find(item=>item.id==='e1').originalErrorAssessment,exact.originalErrorAssessment);
 await t.test('preserved original identity survives analysis/frozen document',()=>{
  assert.equal(origin.claimVersion,1);assert.equal(origin.applicability.population,'Adults');
  assert.equal(exact.claimVersion,1);assert.equal(exact.applicability.population,'Adults');assert.equal(exact.applicability.inLabel,false);
  assert.equal(exact.currentClaim.version,3);assert.equal(exact.currentClaim.applicability.population,'Children');
  assert.equal(exact.originalErrorAssessment.statement.claimVersion,1);assert.equal(exact.originalErrorAssessment.claim.population,'Adults');
  assert.ok(JSON.stringify(full).includes('Adults'));assert.ok(document.canonicalMarkdown.includes('Adults'));
  const missing=page.items.find(item=>item.id==='e2');assert.equal(missing.originalErrorAssessment,null);assert.equal(missing.claimVersion,null);assert.equal(missing.applicability,null);
 });
 for(const error of page.items){
  const addressed=await service.diagnosis(user,id,{selectionRef:view.selection.reference,errorFingerprint:error.fingerprint,errorLimit:500,errorOffset:0});
  const actual=addressed.errors.find(item=>item.id===error.id);
  assert.equal(actual.claimVersion,error.claimVersion);assert.deepEqual(actual.applicability,error.applicability);
  assert.deepEqual(actual.originalErrorAssessment,error.originalErrorAssessment);assert.deepEqual(actual.currentClaim,error.currentClaim);
 }
 for(const filter of [{errorSeverities:['S4']},{errorStatuses:['open']},{errorTypes:['number']},{errorSearch:'original'},{errorLimit:5},{errorOffset:1},{questionId:'q'},{errorTrace:'traced'},{errorJudgmentState:'active'},{errorFingerprint:fingerprint}]){
  await assert.rejects(service.runtimeRead(project,'analysis',{viewId:'V13',selectionRef:view.selection.reference,...filter}),error=>error.status===400);
  await assert.rejects(service.analysis(user,id,{viewId:'V13',selectionRef:view.selection.reference,...filter}),error=>error.status===400);
 }
});
