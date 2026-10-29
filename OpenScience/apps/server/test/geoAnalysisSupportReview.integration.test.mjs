import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../../../../',import.meta.url);
const load=p=>import(new URL(p,root));
const {ControlPlaneDatabase}=await load('OpenScience/apps/server/src/controlPlaneDatabase.mjs');
const {GeoStore}=await load('OpenScience/apps/server/src/geoStore.mjs');
const {GeoMeasureStore}=await load('OpenScience/apps/server/src/geoMeasureStore.mjs');
const {GeoService}=await load('OpenScience/apps/server/src/geoService.mjs');
const {EvidenceZoneService}=await load('OpenScience/apps/server/src/evidenceZoneService.mjs');
const {createGeoDiagnosisReview}=await load('OpenScience/apps/server/src/geoDiagnosisReview.mjs');
const {createGeoTestDatabase}=await load('OpenScience/apps/server/test/helpers/geoTestDatabase.mjs');
const {seedGeoProject}=await load('OpenScience/apps/server/test/helpers/geoMeasureFixtures.mjs');
const {geoClaimApplicability}=await load('OpenScience/packages/domain/index.mjs');
const {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument}=await load('OpenScience/apps/server/src/geoAnalysis.mjs');
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const user={id:'spec_owner'};
let isolated,database,store,measure,project,service,review,initialVersion;
const claim={id:'spec_geo_claim_0',key:'label',version:1,status:'active',statement:'Adults only.',quote:'Adults only.',sourceRef:'https://doi.org/10.1000/spec',population:'Adults',elements:{dose:0},inLabel:false,cardId:'spec_card',cardClaimId:'C1',cardRevision:1};
const original={text:'All ages may use it.',verdict:'wrong',claimId:claim.id,claimKey:claim.key,claimVersion:1,applicability:geoClaimApplicability(claim),evidence:claim.quote,errorType:'dropped_condition',topic:'indication',severity:'S3'};
before(async()=>{
 if(!url)return;
 isolated=await createGeoTestDatabase(url,'spec_e2');
 database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:8,databaseConnectionTimeoutMs:3000});
 measure=new GeoMeasureStore(database);await measure.ready();store=new GeoStore({database});await store.ready();await new EvidenceZoneService({database}).ready();
 await seedGeoProject(database,{id:'spec_geo',userId:user.id,projectId:'spec_project',engines:['deepseek'],groups:[{id:'spec_group',pool:'P2'}],questions:[{id:'spec_question',groupId:'spec_group',text:'Who can use it?'}],claims:[claim]});
 project=await measure.project('spec_geo');
 await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES('spec_zone',$1,'Spec','draft')",[user.id]);
 await database.query("UPDATE evimed_geo.projects SET product_zone_id='spec_zone' WHERE id=$1",[project.id]);project.productZoneId='spec_zone';
 const cardClaims=[{claimId:'C1',claimType:'direct',claim:claim.statement,supportQuote:claim.quote,sourceIndexes:[1]}],sources=[{url:claim.sourceRef,documentText:claim.quote}];
 await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,sources,claims,revision) VALUES('spec_card','spec_zone',$1,'Spec','academic','draft',$2::jsonb,$3::jsonb,1)",[user.id,JSON.stringify(sources),JSON.stringify(cardClaims)]);
 await database.query("INSERT INTO evimed_frontier.evidence_card_revisions(card_id,revision,snapshot) VALUES('spec_card',1,$1::jsonb)",[JSON.stringify({id:'spec_card',revision:1,claims:cardClaims,sources})]);
 await database.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES('spec_round',$1,$2,'baseline','done',1,'{deepseek}',$3::jsonb)",[user.id,project.id,JSON.stringify({evaluationBasis:{claims:[claim],product:{},competitors:[],owned:{},careFlags:[]}})]);
 await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text,asked_at) VALUES('spec_snapshot',$1,$2,'spec_round','spec_question','deepseek','valid',$3,'2026-10-01')",[user.id,project.id,original.text]);
 await measure.writeFacts({id:'spec_snapshot',userId:user.id,geoProjectId:project.id},{parserVersion:'spec-parser',judgedAt:'2026-10-01T01:00:00Z',statements:[original],assessmentBasis:[claim],checks:{judgementCoverage:{status:'complete'}}});
 review=createGeoDiagnosisReview({database,store:measure,judge:{available:true,judge:async()=>({statements:[{...original,verdict:'correct'}],checks:{clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:original.text,reason:'Clinical assertion.',validated:true},citations:[],offLabel:[],omittedSafety:[],judgementCoverage:{status:'complete'}},dropped:[],entities:[],recommendations:[]})}});
 initialVersion=(await review.read(project,'spec_snapshot')).assessmentVersion;
 service=new GeoService({store,config:{geoEnabled:true,geoAudience:'all'}});
});
after(async()=>{await database?.close();await isolated?.drop();});
test('real local review path changes current verdict while first revision remains wrong',{skip:!url},async()=>{
 await review.submit(project,{snapshotId:'spec_snapshot',statement:original.text,claimId:claim.id,assessmentVersion:initialVersion,note:'Check the conditions.',requestKey:'spec_rejudge_request'});
 assert.deepEqual(await review.tick(),{processed:1});
 const history=await review.read(project,'spec_snapshot');
 assert.equal(history.original.statements[0].verdict,'wrong');assert.equal(history.current.statements[0].verdict,'correct');
 const view=await service.analysis(user,project.id,{viewId:'V16',round:'spec_round'});
 assert.equal(view.rows.length,1);assert.equal(view.rows[0].values.supported.value,1);
 const frozen=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
 const doc=freezeGeoAnalysisDocument(frozen), serialized=JSON.stringify(doc);
 if(process.env.GEO_E2_RECEIPTS_DIR){await mkdir(process.env.GEO_E2_RECEIPTS_DIR,{recursive:true});await writeFile(`${process.env.GEO_E2_RECEIPTS_DIR}/document-V16-rejudged.json`,JSON.stringify({...doc,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:frozen.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
 const member=await service.analysisMembers(user,project.id,{selectionRef:view.selection.reference,...view.view,rowKey:view.rows[0].key,columnKey:'observations',expectedDigest:view.digest});
 const result={database:isolated.name,initialVersion,currentVersion:history.assessmentVersion,currentBasis:history.current.basis,original:history.original,member:member.items[0],initialVersionRetained:serialized.includes(initialVersion),originalWrongRetained:serialized.includes('"verdict":"wrong"')||serialized.includes('\\"verdict\\":\\"wrong\\"'),currentCorrectRetained:serialized.includes('correct')};
 assert.equal(member.items[0].temporalBasis,'current_assessment_of_selected_answer');
 assert.equal(result.initialVersionRetained,true,'Frozen analysis retains the original version beside the current overlay');
 assert.equal(result.originalWrongRetained,true,'Frozen analysis retains the first recorded verdict');
});
test('explicit empty current basis remains unknown and never borrows the original frozen claim',{skip:!url},async()=>{
 await database.query("UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{assessment,basis}','[]'::jsonb) WHERE user_id=$1 AND payload->>'recordType'='geo-assessment'",[user.id]);
 const view=await service.analysis(user,project.id,{viewId:'V16',round:'spec_round'}),row=view.rows[0];
 assert.equal(row.values.supported.value,null);assert.equal(row.values.needsVerification.value,1);
 const member=await service.analysisMembers(user,project.id,{selectionRef:view.selection.reference,...view.view,rowKey:row.key,columnKey:'needsVerification',expectedDigest:view.digest});
 assert.equal(member.items[0].reason,'preserved_claim_unavailable');
});
test('a current assessment in another control project is not used as an unrecorded original',{skip:!url},async()=>{
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'spec_other_project','Other',1048576)",[user.id]);
 await database.query("UPDATE evimed_product.documents SET project_id='spec_other_project',payload=jsonb_set(jsonb_set(payload,'{assessment,statements,0,text}',to_jsonb('FOREIGN PROJECT SENTINEL'::text)),'{assessment,basis}',payload->'assessment'->'basis') WHERE user_id=$1 AND payload->>'recordType'='geo-assessment'",[user.id]);
 const view=await service.analysis(user,project.id,{viewId:'V16',round:'spec_round'});
 const leaked=JSON.stringify(view).includes('FOREIGN PROJECT SENTINEL');
 assert.equal(leaked,false,'Excluded control-project assessments cannot reenter through selected facts');
});
test('250 same-claim observations retain their exact native object pages through stage and bind',{skip:!url},async()=>{
 await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text,asked_at) SELECT 'spec_wide_'||n,$1,$2,'spec_round','spec_question','deepseek','valid',$3,'2026-10-01' FROM generate_series(1,250)n",[user.id,project.id,original.text]);
 await database.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,statements,checks) SELECT 'spec_wide_'||n,$1,$2,'2026-10-01T01:00:00Z',$3::jsonb,'{\"judgementCoverage\":{\"status\":\"complete\"}}'::jsonb FROM generate_series(1,250)n",[user.id,project.id,JSON.stringify([original])]);
 const view=await service.analysis(user,project.id,{viewId:'V16',round:'spec_round'});
 const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
 const {GeoPlanContext}=await load('OpenScience/apps/server/src/geoPlanContext.mjs');
 const {ProductDocuments}=await load('OpenScience/apps/server/src/productStore.mjs');
 const adapter=new GeoPlanContext({documents:new ProductDocuments(database),store,service,authorizeSession:async()=>{},runs:async()=>[]});
 service.planContexts=adapter;
 const staged=await adapter.stage(user,project.id,{requestKey:'spec_wide_native',sessionId:'spec_session',mode:'analysis',selectionRef:full.selection.reference,view:full.view,expectedDigest:full.digest,intent:'explain'});
 const request={requestId:'wide-native-input',sessionId:'spec_session',content:[{type:'text',text:'Explain these exact observations.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
 const native=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50});
 assert.equal(native.digest,full.digest);assert.equal(native.rows.length,full.rows.length);
 assert.ok(native.rows.some(row=>row.dimensions.objectsContext),'Same-claim object detail is paged, never truncated');
 await database.query("UPDATE evimed_geo.facts SET statements='[]'::jsonb WHERE geo_project_id=$1",[project.id]);
 for(const row of full.rows){
  const shown=native.rows.find(item=>item.key===row.key);assert.deepEqual(shown.values,row.values);
  const all=[];let offset=0;
  while(offset!==null){
   const page=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:row.key,columnKey:'objects',offset,limit:37});
   assert.ok(Buffer.byteLength(JSON.stringify(page))<4*1024*1024);all.push(...page.items);offset=page.nextOffset;
  }
  assert.deepEqual(all,row.dimensions.objects,'Current fact updates cannot change frozen object pages');
 }
 await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:'missing',columnKey:'objects'}));
 await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:full.rows[0].key,columnKey:'observations'}));
});
