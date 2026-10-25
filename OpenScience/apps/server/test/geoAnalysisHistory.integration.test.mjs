import assert from 'node:assert/strict';
import test from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {GeoStore} from '../src/geoStore.mjs';
import {GeoMeasureStore} from '../src/geoMeasureStore.mjs';
import {GeoService} from '../src/geoService.mjs';
import {ProductDocuments} from '../src/productStore.mjs';
import {GeoSignals} from '../src/geoSignals.mjs';
import {GeoGroupChanges} from '../src/geoGroupChanges.mjs';
import {GeoSignalDiscovery} from '../src/geoSignalDiscovery.mjs';
import {GeoOwnedPublications} from '../src/geoOwnedPublications.mjs';
import {measureRound} from '../src/geoMetricsJob.mjs';
import {readGeoSelection} from '../src/geoReadScope.mjs';
import {buildGeoHistoryAnalysis,readGeoHistoryContext} from '../src/geoAnalysisHistory.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {seedGeoProject} from './helpers/geoMeasureFixtures.mjs';
import {GeoPlanContext} from '../src/geoPlanContext.mjs';
import {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument} from '../src/geoAnalysis.mjs';
import {GEO_ANALYSIS_REGISTRY} from '../src/geoAnalysisRegistry.mjs';
import {mkdir,writeFile} from 'node:fs/promises';

const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
test('history reads real producers, exact cohorts and bound attempts under tenant scope',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'historyanalysis');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();const measure=new GeoMeasureStore(database);await measure.ready();
 await seedGeoProject(database,{id:'history-geo',userId:'history-owner',projectId:'history-control',engines:['deepseek'],groups:[{id:'g',pool:'P2'}],questions:Array.from({length:50},(_,i)=>({id:'q'+i,groupId:'g',text:'Original question '+i}))});
 const project=await measure.project('history-geo'),documents=new ProductDocuments(database),runs=[];
 const service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 const signals=new GeoSignals({store,documents,service,runs:async()=>runs,resultForRun:async()=>({present:true})});service.signals=signals;
 for(const [id,day,mentioned] of [['r1','01',false],['r2','03',true]]){
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,finished_at,sample_date,surface)
   VALUES($1,$2,$3,'baseline','done',1,'{deepseek}',$4::timestamptz,$4::date,$5)`,[id,project.userId,project.id,'2026-10-'+day+'T00:00:00Z',JSON.stringify({mode:'web',measurementContract:{samplingMode:'recurring',repeats:1,engines:['deepseek'],sourceBasis:'answers',reportPresentation:'summary',metricIds:['M-01','M-03']}})]);
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text,surface)
   SELECT $1||'-q'||n,$2,$3,$1,'q'||n,'deepseek','valid',$4,repeat('Original preserved answer ',100),'{"mode":"web"}' FROM generate_series(0,49)n`,[id,project.userId,project.id,'2026-10-'+day+'T00:00:00Z']);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,created_at,brands,mentions_ours,statements,checks,retrieval_triggered)
   SELECT $1||'-q'||n,$2,$3,'2026-10-04','2026-10-04',$4,$5,'[{"text":"Retained statement","verdict":"correct"}]','{"judgementCoverage":{"status":"complete"}}',true FROM generate_series(0,49)n`,[id,project.userId,project.id,JSON.stringify(mentioned?[{name:project.product.brandName,ours:true,count:1}]:[]),mentioned]);
  if(id==='r2'){
   await store.query("UPDATE evimed_geo.snapshots SET asked_at='2026-10-04T00:00:00Z' WHERE round_id='r2' AND substring(question_id from 2)::integer>=25");
   await store.query("UPDATE evimed_geo.facts SET mentions_ours=false,brands='[]' WHERE snapshot_id LIKE 'r2-q%' AND substring(snapshot_id from 5)::integer>=25");
  }
  await measureRound({store:measure},id);
 }
 await store.query("UPDATE evimed_geo.questions SET client_tags=CASE WHEN substring(id from 2)::integer<25 THEN ARRAY['tag-A']::text[] ELSE ARRAY['tag-B']::text[] END");
 await new GeoGroupChanges({store,signals}).project(project);
 const groups=(await documents.list(project.userId,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal',kind:'group_changed'}})).items;
 assert.equal(groups.length,1);const group=groups[0];assert.ok(group.payload.basis.sides.before.targetPages);
 const history=[{kind:'business_closed',snapshotId:'r1-q1',changedAt:'2026-10-02T00:00:00Z'},{kind:'business_reopened',snapshotId:'r2-q0',previousClosedSnapshotId:'r1-q1',changedAt:'2026-10-04T00:00:00Z'}];
 await store.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,statement,status,judgment_history)
  VALUES('error',$1,$2,'fingerprint','deepseek','q0','r1-q0','r2-q0','Original issue','open',$3)`,[project.userId,project.id,JSON.stringify(history)]);
 const error=(await store.query("SELECT * FROM evimed_geo.errors WHERE id='error'")).rows[0];await new GeoSignalDiscovery({store,signals}).errorEvents(project,error);
 const issue=(await documents.list(project.userId,'geo-signal',{projectId:project.projectId,filter:{recordType:'geo-signal',kind:'error_observed'}})).items.find(row=>row.payload.eventVersion==='first');
 await documents.put(project.userId,'geo-plan-context','historical-context',{recordType:'geo-plan-context',geoId:project.id,mode:'signal',state:'bound',sessionId:'session',requestId:'accepted-request',basis:{signal:{id:issue.id,basisDigest:issue.payload.basisDigest}}},{projectId:project.projectId,expectedRevision:0});
 runs.push({id:'handling-run',sessionId:'session',kernelRequestIds:['accepted-request'],status:'succeeded',startedAt:'2026-10-01T01:00:00Z',finishedAt:'2026-10-02T00:00:00Z'});
 runs.push({id:'unrelated-same-session',sessionId:'session',kernelRequestIds:['unrelated'],status:'succeeded'});
 for(let index=0;index<105;index++)await signals.record(project,{kind:'citation_observed',objectKey:'page-'+index,eventVersion:'first',title:'Preserved citation '+index,observedAt:index===104?null:'2026-10-02T00:00:00Z',basis:{snapshotId:'r1-q0',groupId:'g',questionVersion:1}});
 await store.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('foreign-owner','Foreign','development')");
 await store.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('foreign-owner','history-control','Foreign',1048576)");
 await documents.put('foreign-owner','geo-signal','foreign-signal',{recordType:'geo-signal',geoId:project.id,kind:'citation_observed',title:'PRIVATE FOREIGN SIGNAL'},{projectId:project.projectId,expectedRevision:0});
 const selected=await readGeoSelection(store,project,{from:'2026-10-01',to:'2026-10-04'});
 const source=await readGeoHistoryContext(store,project,selected,{viewId:'V15'},{service});
 const errorView=buildGeoHistoryAnalysis(selected,{viewId:'V15'},{execution:{history:source}});
 assert.equal(errorView.rows[0].values.observations.value,2);assert.equal(errorView.rows[0].values.recurrences.value,1);assert.equal(errorView.rows[0].values.closedObservations.value,1);assert.equal(errorView.rows[0].values.tasks.value,1);
 assert.equal(errorView.rows[0].dimensions.currentStatus,'open');assert.equal(errorView.rows[0].dimensions.objects.find(item=>item.kind==='task_attempt').runId,'handling-run');
 const publicHistory=await service.analysis({id:project.userId},project.id,{viewId:'V15',selectionRef:selected.selection.reference});assert.ok(publicHistory.rows.length);
 const timeline=await readGeoHistoryContext(store,project,selected,{viewId:'V27'},{service});
 assert.equal(timeline.signals.length,108);assert.doesNotMatch(JSON.stringify(timeline),/PRIVATE FOREIGN|unrelated-same-session/);
 const change=timeline.signals.find(item=>item.kind==='group_changed');assert.equal(change.cohorts.before.length,50);assert.equal(change.cohorts.after.length,50);assert.match(change.cohorts.before[0].preservedAnswer.text,/Original preserved answer/);
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},{execution:{history:timeline}});
 assert.equal(view.chart.trend.length,2);assert.equal(view.chart.timeline.undated,1);
 const interval=view.chart.trend.find(point=>point.roundId==='r2');assert.equal(interval.value,50);assert.equal(interval.observedFrom,'2026-10-03T00:00:00.000Z');assert.equal(interval.observedTo,'2026-10-04T00:00:00.000Z');assert.equal(interval.at,interval.observedTo);
 const tagged=await readGeoSelection(store,project,{from:'2026-10-01',to:'2026-10-04',clientTags:['tag-A']});
 const taggedContext=await readGeoHistoryContext(store,project,tagged,{viewId:'V27'},{service});assert.equal(taggedContext.signals.some(item=>item.kind==='group_changed'),false);
 const taggedView=buildGeoHistoryAnalysis(tagged,{viewId:'V27'},{execution:{history:timeline}});assert.equal(taggedView.rows.flatMap(row=>row.dimensions.objects).some(item=>item.kind==='group_changed'),false);
 const unknownTime=structuredClone(selected);unknownTime.rows.find(row=>row.roundId==='r2').askedAt=null;
 const unknownView=buildGeoHistoryAnalysis(unknownTime,{viewId:'V27'},{execution:{history:timeline}}),unknownPoint=unknownView.chart.trend.find(point=>point.roundId==='r2');assert.equal(unknownPoint.at,null);assert.equal(unknownPoint.unknownTimes,1);assert.equal(unknownPoint.value,50);
 const errorEvents=view.rows.flatMap(row=>row.dimensions.objects).filter(item=>item.id.startsWith('error-observation:'));
 assert.equal(errorEvents.length,2);assert.ok(errorEvents.every(item=>item.signalId));
 const user={id:project.userId},contexts=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=contexts;
 const frozenHistories=[];
 for(const [name,descriptor,scope] of [
  ['errors',{viewId:'V15'},{}],['business',{viewId:'V27'},{}],
  ['tagged',{viewId:'V27'}, {clientTags:['tag-A']}],['accuracy',{viewId:'V27',metricId:'M-06'},{}]
 ]){
  const live=await service.analysis(user,project.id,{from:'2026-10-01',to:'2026-10-04',...scope,...descriptor});
  assert.ok(live.rows.length,name);
  for(const row of live.rows)for(const value of Object.values(row.values))if(value.members){
   const items=[];let offset=0;
   do{
    const part=await service.analysisMembers(user,project.id,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:row.key,columnKey:value.members.columnKey,offset,limit:37});
    assert.equal(part.digest,live.digest);assert.equal(part.total,value.members.total);items.push(...part.items);offset=part.nextOffset;
   }while(offset!==null);
   assert.equal(items.length,value.members.total);assert.equal(new Set(items.map(item=>item.id)).size,items.length);
   assert.ok(items.every(item=>item.unit===value.members.unit));
  }
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest},{service});
  const document=freezeGeoAnalysisDocument(full);assert.equal(document.cover.analysis.digest,live.digest);
  for(const row of full.rows){
   const typed=document.typedTable.rows.find(item=>item.key===row.key);
   const parts=document.typedTable.rows.filter(item=>item.context_parent===row.key&&item.context_field==='dimensions');
   const dimensions=typed.dimensions??parts.map(item=>item.dimensions).join('');
   assert.deepEqual(JSON.parse(dimensions),row.dimensions);
  }
  assert.ok(document.typedTable.rows.every(row=>Object.values(row).every(value=>typeof value!=='string'||Array.from(value).length<=32767)));
  if(name==='business'){
   const objects=full.rows.flatMap(row=>row.dimensions.objects),before=objects.filter(item=>item.unit==='history_answer_refs'&&item.side==='before');
   assert.equal(before.length,50);assert.ok(before.every(item=>item.preservedAnswer.text.includes('Original preserved answer')));
   assert.ok(objects.every(item=>Buffer.byteLength(JSON.stringify(item))<150000));
  }
  if(process.env.GEO_F4_RECEIPTS_DIR){
   await mkdir(process.env.GEO_F4_RECEIPTS_DIR,{recursive:true});
   await writeFile(`${process.env.GEO_F4_RECEIPTS_DIR}/document-${name}.json`,JSON.stringify({...document,version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));
  }
  let exported=null;
  await service.selectedExport(user,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(_user,payload)=>{exported=payload;return {id:'export'};}});
  assert.equal(exported.canonicalMarkdown,document.canonicalMarkdown);assert.deepEqual(exported.typedTable,document.typedTable);
  const staged=await contexts.stage(user,project.id,{requestKey:`history-${name}`,sessionId:'history-session',mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
  const request={requestId:`history-request-${name}`,sessionId:'history-session',content:[{type:'text',text:'Explain these retained historical events and their exact observations.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
  for(const row of full.rows){
   const objects=[];let offset=0;
   do{const part=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,rowKey:row.key,columnKey:'objects',offset,limit:37});objects.push(...part.items);offset=part.nextOffset;}while(offset!==null);
   assert.deepEqual(objects,row.dimensions.objects);
  }
  frozenHistories.push({live,full,referenceId:staged.referenceId});
 }
 for(const bad of [{viewId:'V15',metricId:'M-01'},{viewId:'V27',metricId:'M-16'},{viewId:'V27',dimension:'group'},{viewId:'V27',financeFacet:'ledger'}])await assert.rejects(service.analysis(user,project.id,bad),e=>e.status===400);
 await assert.rejects(service.analysis({id:'foreign-owner'},project.id,{viewId:'V27'}),e=>e.status===404);
 // V28 is the common export/conversation action, not an additional analysis page.
 assert.deepEqual(Object.keys(GEO_ANALYSIS_REGISTRY).sort(),Array.from({length:27},(_,index)=>'V'+String(index+1).padStart(2,'0')));
 const catalogue=[];
 for(const viewId of Object.keys(GEO_ANALYSIS_REGISTRY).sort()){
  const live=await service.analysis(user,project.id,{viewId,selectionRef:selected.selection.reference});
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest},{service});
  const exported=freezeGeoAnalysisDocument(full);
  assert.equal(exported.cover.analysis.digest,live.digest);assert.equal(full.rows.length,live.page.total);
  assert.equal(full.selection.reference,selected.selection.reference);
  const staged=await contexts.stage(user,project.id,{requestKey:`catalogue-${viewId}`,sessionId:'history-session',mode:'analysis',selectionRef:live.selection.reference,view:live.view,expectedDigest:live.digest,intent:'explain'});
  const request={requestId:`catalogue-request-${viewId}`,sessionId:'history-session',content:[{type:'text',text:'Explain this exact selected analysis, including unknown readings.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(user,{id:project.projectId,userId:project.userId},request);await contexts.bind(user,{id:project.projectId,userId:project.userId},request);
  const native=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,offset:0,limit:50});
  assert.equal(native.digest,full.digest);assert.equal(native.selection.reference,full.selection.reference);
  catalogue.push({viewId,digest:full.digest,total:full.rows.length,availability:full.availability,exportDigest:exported.cover.analysis.digest,nativeDigest:native.digest});
 }
 if(process.env.GEO_F4_RECEIPTS_DIR)await writeFile(`${process.env.GEO_F4_RECEIPTS_DIR}/catalogue-v28.json`,JSON.stringify(catalogue,null,2));
 await store.query("UPDATE evimed_geo.facts SET brands='[]',mentions_ours=false WHERE snapshot_id='r2-q0'");
 const after=await readGeoHistoryContext(store,project,selected,{viewId:'V27'},{service});
 assert.deepEqual(after.signals.find(item=>item.kind==='group_changed').cohorts,change.cohorts,'historical producer sides never re-resolve the changed live selection');
 await documents.put(project.userId,'geo-signal',group.id,{...group.payload,disposition:'ignored'},{projectId:project.projectId,expectedRevision:group.revision});
 const ignored=await readGeoHistoryContext(store,project,selected,{viewId:'V27'},{service});
 assert.equal(ignored.signals.find(item=>item.kind==='group_changed').disposition,'ignored');assert.deepEqual(ignored.signals.find(item=>item.kind==='group_changed').cohorts,change.cohorts);
 const retained=frozenHistories.find(item=>item.live.view.viewId==='V27');
 const retainedRow=retained.full.rows.find(row=>row.dimensions.eventKind==='group_changed');
 await assert.rejects(service.analysisMembers(user,project.id,{...retained.live.view,selectionRef:retained.live.selection.reference,expectedDigest:retained.live.digest,rowKey:retainedRow.key,columnKey:'events'}),e=>e.status===409);
 const retainedObjects=[];let retainedOffset=0;
 do{const part=await service.runtimeRead(project,'analysis',{planContextRef:retained.referenceId,rowKey:retainedRow.key,columnKey:'objects',offset:retainedOffset,limit:37});retainedObjects.push(...part.items);retainedOffset=part.nextOffset;}while(retainedOffset!==null);
 assert.deepEqual(retainedObjects,retainedRow.dimensions.objects,'the accepted native analysis does not re-read changed facts or current handling');
 await store.query(`INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,title,current_result_version_id,content_sha256)
  VALUES('article',$1,$2,'Current version','v2',repeat('2',64))`,[project.userId,project.id]);
 for(const [version,digest] of [['v1','1'],['v2','2']])await store.query(`INSERT INTO evimed_geo.article_versions(geo_project_id,user_id,article_id,result_version_id,digest,path,association,created_at)
  VALUES($1,$2,'article',$3,repeat($4,64),$3||'.md','{"groupId":"g"}','2026-10-01')`,[project.id,project.userId,version,digest]);
 await store.query(`INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,published_at,article_id,article_result_version_id,article_digest)
  VALUES('owned',$1,$2,'https://example.org/owned','example.org/owned','brand_site','Owned page','2026-10-01T00:00:00Z','article','v1',repeat('1',64))`,[project.userId,project.id]);
 await new GeoOwnedPublications({store,documents,now:()=>new Date('2026-10-24')}).confirm(project,'owned',{requestKey:'explicit-update',expectedRevision:0,expectedResultVersionId:'v1',expectedDigest:'1'.repeat(64),resultVersionId:'v2',digest:'2'.repeat(64),publishedAt:'2026-10-03T00:00:00Z'});
 const updated=await readGeoHistoryContext(store,project,selected,{viewId:'V27'},{service});
 assert.equal(updated.publicationHistory.length,2);
 const publicationView=buildGeoHistoryAnalysis(selected,{viewId:'V27'},{execution:{history:updated}});
 const receipts=publicationView.rows.flatMap(row=>row.dimensions.objects).filter(item=>item.kind==='publication_update');
 assert.equal(receipts.length,2);assert.deepEqual(receipts.map(item=>item.resultVersionId).sort(),['v1','v2']);assert.ok(receipts.every(item=>item.pinState==='exact'&&item.recordedAt));
 assert.equal(receipts.find(item=>item.resultVersionId==='v1').at,'2026-10-01T00:00:00.000Z');
 const pageId=group.payload.basis.sides.before.targetPages.pages[0].id,page=await documents.get(project.userId,'geo-signal',pageId);
 await documents.put(project.userId,'geo-signal',pageId,{...page.payload,targets:[]},{projectId:project.projectId,expectedRevision:page.revision});
 await assert.rejects(readGeoHistoryContext(store,project,selected,{viewId:'V27'},{service}),e=>e.status===409);
});

test('M-20 keeps unpaired and suspect asks in exact history members; real unknown-time error receipts stay observations',{skip:!url},async t=>{
 const isolated=await createGeoTestDatabase(url,'historypopulation');
 const database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:3,databaseConnectionTimeoutMs:3000});
 t.after(async()=>{await database.close();await isolated.drop();});
 const store=new GeoStore({database});await store.ready();const measure=new GeoMeasureStore(database);await measure.ready();
 await seedGeoProject(database,{id:'population-geo',userId:'population-owner',projectId:'population-control',engines:['deepseek','kimi'],groups:[{id:'g',pool:'P2'}],questions:Array.from({length:52},(_,i)=>({id:'q'+i,groupId:'g',text:'Question '+i}))});
 const project=await measure.project('population-geo'),user={id:project.userId},documents=new ProductDocuments(database);
 const service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});
 await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,finished_at,surface)
  VALUES('r',$1,$2,'baseline','done',1,'{deepseek,kimi}','2026-10-07T00:00:00Z','{"mode":"web"}')`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text,surface)
  SELECT 'q'||n||'-'||engine,$1,$2,'r','q'||n,engine,'valid','2026-10-01T00:00:00Z','Retained answer','{"mode":"web"}' FROM generate_series(0,49)n CROSS JOIN unnest(ARRAY['deepseek','kimi']) engine`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text,surface)
  VALUES('unpaired',$1,$2,'r','q50','deepseek','valid','2026-10-05T00:00:00Z','Unpaired answer','{"mode":"web"}'),
  ('suspect',$1,$2,'r','q51','deepseek','suspect','2026-10-06T00:00:00Z','Suspect answer','{"mode":"web"}')`,[project.userId,project.id]);
 await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,created_at,brands,mentions_ours,statements,checks)
  SELECT id,$1,$2,'2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','[]',false,'[]','{"judgementCoverage":{"status":"complete"}}' FROM evimed_geo.snapshots WHERE geo_project_id=$2`,[project.userId,project.id]);
 await measureRound({store:measure},'r');
 const live=await service.analysis(user,project.id,{viewId:'V27',metricId:'M-20'}),row=live.rows.find(row=>row.metricId==='M-20');
 assert.equal(row.values.reading.denominator,102);assert.equal(row.values.reading.members.total,102);assert.equal(row.values.reading.members.unit,'asks');
 assert.equal(live.chart.trend[0].observedTo,'2026-10-06T00:00:00.000Z');
 const ids=[];let offset=0;
 do{const part=await service.analysisMembers(user,project.id,{...live.view,selectionRef:live.selection.reference,expectedDigest:live.digest,rowKey:row.key,columnKey:'reading',offset,limit:37});ids.push(...part.items.map(item=>item.snapshotId));offset=part.nextOffset;}while(offset!==null);
 assert.equal(new Set(ids).size,102);assert.ok(ids.includes('unpaired')&&ids.includes('suspect'));
 await store.query("UPDATE evimed_geo.snapshots SET asked_at=NULL WHERE id='suspect'");
 const unknown=await service.analysis(user,project.id,{viewId:'V27',metricId:'M-20'});
 assert.equal(unknown.chart.trend[0].at,null);assert.equal(unknown.chart.trend[0].unknownTimes,1);assert.equal(unknown.chart.trend[0].value,live.chart.trend[0].value);
 await store.query("UPDATE evimed_geo.facts SET statements='[{\"text\":\"Retained wrong statement\",\"verdict\":\"wrong\",\"claimId\":null}]' WHERE snapshot_id IN ('q0-deepseek','unpaired')");
 const errorInput={userId:project.userId,geoProjectId:project.id,fingerprint:'exact-error',engine:'deepseek',statement:'Retained wrong statement',errorType:'unfounded',severity:'S1',claimId:null,evidenceQuote:null,action:null,responsible:null};
 const first=await measure.upsertError({...errorInput,id:'issue',questionId:'q0',snapshotId:'q0-deepseek',now:new Date('2026-10-02')});assert.equal(first.created,true);
 await store.query("UPDATE evimed_geo.snapshots SET asked_at=NULL WHERE id='unpaired'");
 for(let attempt=0;attempt<2;attempt++)await measure.upsertError({...errorInput,id:'ignored-new-id',questionId:'q50',snapshotId:'unpaired',now:new Date('2026-10-07T00:00:00Z')});
 await store.query(`UPDATE evimed_geo.errors SET judgment_history=judgment_history || '[{"kind":"legacy_identity_promoted","proofSnapshotIds":["q0-deepseek"]}]' WHERE id='issue'`);
 const history=await service.analysis(user,project.id,{viewId:'V15'}),errorRow=history.rows[0];
 assert.equal(errorRow.values.observations.value,2);assert.equal(errorRow.values.judgments.value,0);assert.equal(errorRow.values.recurrences.value,0);assert.equal(errorRow.values.records.value,1);
 const full=await freezeSelectedGeoAnalysis(store,project,{view:history.view,selectionRef:history.selection.reference,expectedDigest:history.digest},{service});
 const item=full.rows[0].dimensions.objects.find(item=>item.snapshotId==='unpaired');assert.equal(item.at,null);assert.equal(new Date(item.recordedAt).toISOString(),'2026-10-07T00:00:00.000Z');
 const stored=(await store.query("SELECT judgment_history FROM evimed_geo.errors WHERE id='issue'")).rows[0].judgment_history;
 assert.equal(item.recordedAt,stored.find(receipt=>receipt.kind==='wrong_occurrence_time_unknown').recordedAt);
 assert.equal(full.rows[0].dimensions.objects.filter(item=>item.snapshotId==='unpaired').length,1);
});
