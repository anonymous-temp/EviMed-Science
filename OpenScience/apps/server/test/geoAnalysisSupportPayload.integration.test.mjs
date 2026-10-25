import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
const root=new URL('../../../../',import.meta.url),load=p=>import(new URL(p,root));
const {ControlPlaneDatabase}=await load('OpenScience/apps/server/src/controlPlaneDatabase.mjs');
const {GeoStore}=await load('OpenScience/apps/server/src/geoStore.mjs');
const {GeoMeasureStore}=await load('OpenScience/apps/server/src/geoMeasureStore.mjs');
const {GeoService}=await load('OpenScience/apps/server/src/geoService.mjs');
const {EvidenceZoneService}=await load('OpenScience/apps/server/src/evidenceZoneService.mjs');
const {createGeoTestDatabase}=await load('OpenScience/apps/server/test/helpers/geoTestDatabase.mjs');
const {seedGeoProject}=await load('OpenScience/apps/server/test/helpers/geoMeasureFixtures.mjs');
const {geoClaimApplicability}=await load('OpenScience/packages/domain/index.mjs');
const {readGeoValueCoverage}=await load('OpenScience/apps/server/src/geoValueStore.mjs');
const output={};
test('ordinary evidence rows stay thin while exact members and exports retain complete original judgments',{skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL},async()=>{
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'quality_e2');let database;
 try{
  database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:3000});const measure=new GeoMeasureStore(database);await measure.ready();const store=new GeoStore({database});await store.ready();await new EvidenceZoneService({database}).ready();
  const user={id:'quality-owner'},claim={id:'quality-claim',key:'label',version:1,status:'active',statement:'Adults may use the treatment.',quote:'Adults may use the treatment.',sourceRef:'https://doi.org/10.1000/qpg',population:'Adults',cardId:'quality-card',cardClaimId:'C1',cardRevision:1};
  for(const [id,owner,control] of [['quality-geo',user.id,'quality-control'],['quality-other',user.id,'quality-other-control'],['quality-foreign','quality-stranger','quality-foreign-control']])await seedGeoProject(database,{id,userId:owner,projectId:control,engines:['deepseek'],groups:[{id:id+'-group',pool:'P2'}],questions:[{id:id+'-q',groupId:id+'-group',text:'Question?'}],claims:[]});
  const project=await measure.project('quality-geo');await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES('quality-zone',$1,'Quality','draft')",[user.id]);await database.query("UPDATE evimed_geo.projects SET product_zone_id='quality-zone' WHERE id=$1",[project.id]);project.productZoneId='quality-zone';
  const cardClaims=[{claimId:'C1',claimType:'direct',claim:claim.statement,supportQuote:claim.quote,sourceIndexes:[1]}],sources=[{url:claim.sourceRef,documentText:claim.quote}];await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,sources,claims,revision) VALUES('quality-card','quality-zone',$1,'Quality','academic','draft',$2::jsonb,$3::jsonb,1)",[user.id,JSON.stringify(sources),JSON.stringify(cardClaims)]);await database.query("INSERT INTO evimed_frontier.evidence_card_revisions(card_id,revision,snapshot) VALUES('quality-card',1,$1::jsonb)",[JSON.stringify({revision:1,sources,claims:cardClaims})]);
  await database.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES('quality-round',$1,$2,'baseline','done',1,'{deepseek}',$3::jsonb)",[user.id,project.id,JSON.stringify({evaluationBasis:{claims:[claim]}})]);
  const statements=Array.from({length:5},(_,i)=>({claimId:claim.id,claimVersion:1,applicability:geoClaimApplicability(claim),text:['Alpha','Beta','Gamma','Delta','Epsilon'][i]+' Adult treatment context. '.repeat(60),verdict:'correct',evidence:claim.quote}));
  await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text,asked_at) SELECT 'quality-s'||n,$1,$2,'quality-round','quality-geo-q','deepseek','valid',$3,'2026-10-01' FROM generate_series(1,200)n",[user.id,project.id,statements.map(s=>s.text).join('\n')]);
  for(let n=1;n<=200;n++)await measure.writeFacts({id:'quality-s'+n,userId:user.id,geoProjectId:project.id},{parserVersion:'quality',judgedAt:'2026-10-01T01:00:00Z',statements,assessmentBasis:[claim],checks:{judgementCoverage:{status:'complete'}}});
  const service=new GeoService({store,config:{geoEnabled:true,geoAudience:'all'}});
  const started=performance.now(),view=await service.analysis(user,project.id,{viewId:'V16',round:'quality-round',limit:1});
  output.payload={jsonBytes:Buffer.byteLength(JSON.stringify(view)),elapsedMs:performance.now()-started};
  assert.equal(view.rows[0].values.supported.value,1000);assert.equal(view.page.shown,1);
  assert.equal(Object.hasOwn(view.rows[0].dimensions,'objects'),false);assert.equal(view.rowContext,'member_details');
  assert.ok(output.payload.jsonBytes<100000,'A single grid row must not contain the complete object relation');
  const row=view.rows[0],members=await service.analysisMembers(user,project.id,{...view.view,selectionRef:view.selection.reference,expectedDigest:view.digest,rowKey:row.key,columnKey:'observations',limit:20});
  assert.equal(members.items.length,20);assert.equal(members.total,1000);
  assert.equal(members.items[0].originalAssessment.assessment.statements.length,5);
  const {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument}=await load('OpenScience/apps/server/src/geoAnalysis.mjs');
  const {freezeGeoAnalysisPages}=await load('OpenScience/apps/server/src/geoAnalysisFrozenPages.mjs');
  assert.throws(()=>freezeGeoAnalysisDocument(view),{code:'geo_read_filter_invalid'});
  assert.throws(()=>freezeGeoAnalysisPages(view,{parentId:'gpc_preview',project,actorId:user.id}),{code:'geo_plan_basis_unavailable'});
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
  assert.equal(full.digest,view.digest);assert.equal(full.rows[0].dimensions.objects.length,1000);
  assert.deepEqual(full.rows[0].values,row.values);
  const exported=freezeGeoAnalysisDocument(full);assert.equal(exported.cover.analysis.rows[0].dimensions.objects.length,1000);
  const head=(await database.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'snapshotId'='quality-s1'",[user.id])).rows[0];output.controlVariants=[];
  for(const [name,projectId,payload] of [['document-project','quality-other-control',head.payload],['payload-project',head.project_id,{...head.payload,projectId:'quality-other-control'}],['payload-geo',head.project_id,{...head.payload,geoProjectId:'quality-other'}],['snapshot-id',head.project_id,{...head.payload,snapshotId:'quality-s2'}],['record-kind',head.project_id,{...head.payload,recordType:'other'}]]){
   const changed={...payload,assessment:{...payload.assessment,statements:[{...statements[0],text:'FOREIGN CONTROL SENTINEL'}]}};
   await database.query("UPDATE evimed_product.documents SET project_id=$3,payload=$4::jsonb WHERE user_id=$1 AND kind='knowledge' AND id=$2",[user.id,head.id,projectId,JSON.stringify(changed)]);
   const scoped=await service.analysis(user,project.id,{viewId:'V16',round:'quality-round',limit:1});assert.ok(!JSON.stringify(scoped).includes('FOREIGN CONTROL SENTINEL'),name);assert.equal(scoped.rows[0].values.supported.value,1000,name);const fact=await measure.roundFactRows('quality-round',project.id,user.id,['quality-s1']);assert.ok(!JSON.stringify(fact).includes('FOREIGN CONTROL SENTINEL'),name);output.controlVariants.push(name);
   await database.query("UPDATE evimed_product.documents SET project_id=$3,payload=$4::jsonb WHERE user_id=$1 AND kind='knowledge' AND id=$2",[user.id,head.id,head.project_id,JSON.stringify(head.payload)]);
  }
  await assert.rejects(service.analysis({id:'quality-stranger'},project.id,{viewId:'V16',selectionRef:view.selection.reference}),e=>e.status===404);
  const foreign=await readGeoValueCoverage(store,project.id,{}, {project,selected:{rows:[{snapshotId:'quality-foreign-snapshot'}]}});assert.deepEqual(foreign.observations,[]);
 }finally{await database?.close();await isolated.drop();}
});
