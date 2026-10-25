import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoSourceOwnership } from '../src/geoSourceOwnership.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
const url=process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,opts={skip:!url&&'Disposable local Postgres required'},user={id:'d3-owner'};
let isolated,database,store,service,project,documents,ownership,selectionRef;
const urls=Array.from({length:1001},(_,n)=>`https://shared.example/s?id=${n}`);
before(async()=>{
 if(!url)return;
 isolated=await createGeoTestDatabase(url,'geod3');database=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});store=new GeoStore({database});await store.ready();await new GeoMeasureStore(database).ready();documents=new ProductDocuments(database);ownership=new GeoSourceOwnership({documents});
 await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'D3','development'),('d3-viewer','Viewer','development')",[user.id]);
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d3-control','D3',1048576)",[user.id]);
 project=await store.createProject({userId:user.id,projectId:'d3-control',engines:['deepseek'],coverageDays:90,product:{brandName:'Alpha'}});
 service=new GeoService({store,documents,config:{geoEnabled:true,geoAudience:'all'}});await store.addMember({geoId:project.id,userId:'d3-viewer',role:'viewer',invitedBy:user.id});
 await store.query("INSERT INTO evimed_geo.sources(id,user_id,geo_project_id,domain,name,kind,layer) VALUES('d3-src',$1,$2,'shared.example','Shared','news','owned')",[user.id,project.id]);
 for(const version of [1,2]){
  const group=`d3-g${version}`,round=`d3-r${version}`;
  await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,$4,'P2','Same')",[group,user.id,project.id,version]);
  await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'baseline','done',$4,'{deepseek}','2026-10-01','{\"mode\":\"web\"}')",[round,user.id,project.id,version]);
  for(let n=0;n<50;n++){
   const question=`d3-q${version}-${n}`,snapshot=`d3-s${version}-${n}`,links=version===1&&n===0?[...urls.map(url=>({url,domain:'shared.example'})),{url:'https://unknown.example/a',domain:'unknown.example'}]:n<25?[{url:urls[0],domain:'shared.example'}]:[];
   await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured,original_id) VALUES($1,$2,$3,$4,$5,'P2','Original question?',true,'001')",[question,user.id,project.id,group,version]);
   await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations) VALUES($1,$2,$3,$4,$5,'deepseek','2026-10-01','valid',$6,'{\"mode\":\"web\"}',$7::jsonb)",[snapshot,user.id,project.id,round,question,`Original ${snapshot}`,JSON.stringify(links)]);
   await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,retrieval_triggered,mentions_ours,statements,checks) VALUES($1,$2,$3,'2026-10-02',$4::jsonb,$5,$6,'[]','{\"judgementCoverage\":{\"status\":\"complete\"}}')",[snapshot,user.id,project.id,JSON.stringify([{name:'Alpha',ours:true,count:n<10?1:0}]),n<25,n<10]);
  }
 }
 await ownership.set(project,{target:{kind:'domain',value:'shared.example'},relation:'own',expectedRevision:0});
 for(const [n,relation,active] of [[0,'other',true],[1,'partner',true],[2,'competitor',true],[3,'partner',false]]) await ownership.set(project,{target:{kind:'page',value:urls[n]},relation,active,expectedRevision:0});
 await store.query("INSERT INTO evimed_geo.claims(id,user_id,geo_project_id,claim_key,version,statement,quote,source_ref,status) VALUES('d3-claim',$1,$2,'claim',1,'Claim','Quote','Source','active')",[user.id,project.id]);
 await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,group_id,title,claim_ids,current_result_version_id) VALUES('d3-article',$1,$2,'d3-g1','Old version article','{d3-claim}','001')",[user.id,project.id]);
 await store.query("INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,published_at,article_id,group_id,article_result_version_id,article_digest) VALUES('d3-publication',$1,$2,$3,'shared.example/s?id=2','other','Publication','2026-10-01','d3-article','d3-g1','001',$4)",[user.id,project.id,urls[2],'a'.repeat(64)]);
 selectionRef=(await readGeoSelection(store,project,{}, {history:true})).selection.reference;
});
after(async()=>{await database?.close();await isolated?.drop();});
async function allMembers(view,row,column){const items=[];for(let offset=0;offset<row.values[column].members.total;offset+=50){const page=await service.analysisMembers(user,project.id,{selectionRef:view.selection.reference,...view.view,rowKey:row.key,columnKey:column,expectedDigest:view.digest,limit:50,offset});items.push(...page.items);}return items;}
test('V20 batches 1001 actual URLs, exact-page overrides, inactive fallback, all paginated members and authority',opts,async()=>{
 const original=GeoSourceOwnership.prototype.resolve,calls=[];GeoSourceOwnership.prototype.resolve=async function(p,urls){calls.push(urls);return original.call(this,p,urls);};
 let view;try{view=await service.analysis(user,project.id,{selectionRef,viewId:'V20'});}finally{GeoSourceOwnership.prototype.resolve=original;}
 assert.deepEqual(calls.map(call=>call.length),[1000,2]);assert.equal(new Set(calls.flat()).size,1002);
 const own=view.rows.find(row=>row.dimensions.relationship==='own'),other=view.rows.find(row=>row.dimensions.relationship==='other'),unknown=view.rows.find(row=>row.dimensions.relationship==='unknown');
 assert.equal(own.values.pages.value,998);assert.equal(other.values.answers.value,50);assert.equal(unknown.values.pages.value,1);
 const pages=await allMembers(view,own,'pages');assert.equal(pages.length,998);assert.ok(pages.some(page=>page.source.originalUrls.includes(urls[1000])));assert.ok(pages.some(page=>page.source.originalUrls.includes(urls[3])));
 assert.ok(pages.every(page=>page.citingAnswers.every(answer=>answer.answer.answer_text.startsWith('Original')&&answer.question.originalId==='001')));
 const detail=await allMembers(view,other,'pairs');assert.equal(detail[0].source.pages[0].annotations[0].origin,'page');assert.equal(detail[0].source.pages[0].annotations[0].reference.revision,1);
 assert.equal((await service.analysis({id:'d3-viewer'},project.id,{selectionRef,...view.view})).digest,view.digest);
 await assert.rejects(service.analysis({id:'stranger'},project.id,{selectionRef,...view.view}),error=>error.status===404);
 await assert.rejects(service.analysisMembers(user,project.id,{selectionRef,...view.view,rowKey:'outside',columnKey:'pages',expectedDigest:view.digest}),error=>error.status===404);
 await assert.rejects(service.analysisMembers({id:'d3-viewer'},project.id,{selectionRef,...view.view,rowKey:own.key,columnKey:'pages',expectedDigest:'0'.repeat(64)}),error=>error.status===409);
});
test('V21 exact group/version metrics and current links freeze through all five exports and N09 unsent row focus',opts,async()=>{
 const views=[];for(const ownedMetricId of ['M-08','M-08S']){
  const view=await service.analysis(user,project.id,{selectionRef,viewId:'V21',ownedMetricId});assert.equal(view.rows.length,2);
  const first=view.rows.find(row=>row.dimensions.groupId==='d3-g1'),second=view.rows.find(row=>row.dimensions.groupId==='d3-g2');
  assert.equal(first.values.mention.value,20);assert.equal(first.values.mention.denominator,50);assert.equal(first.values.owned.denominator,ownedMetricId==='M-08'?25:50);assert.equal(first.values.sample.value,50);
  assert.equal(first.dimensions.gaps.content.items[0].resultVersionId,'001');assert.equal(second.dimensions.gaps.content.items.length,0);assert.equal(first.dimensions.gaps.evidence.items[0].id,'d3-claim');assert.equal(first.dimensions.gaps.source.publications[0].resultVersionId,'001');
  assert.equal((await allMembers(view,first,'mention')).length,50);views.push(view);
 }
 views.push(await service.analysis(user,project.id,{selectionRef,viewId:'V20'}));
 const adapter=new GeoPlanContext({documents,store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=adapter;
 for(const view of views){
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef,view:view.view,expectedDigest:view.digest}),first=full.rows[0],column=view.view.viewId==='V21'?'owned':'pairs';
  const staged=await adapter.stage(user,project.id,{requestKey:`d3-${view.view.viewId}-${view.view.ownedMetricId??'all'}`,sessionId:'d3-session',mode:'analysis',selectionRef,view:view.view,expectedDigest:view.digest,intent:'next_steps',focus:{rowKey:first.key,columnKey:column}});assert.ok(staged.draft);
  const saved=await documents.get(project.userId,'geo-plan-context',staged.referenceId);assert.equal(saved.payload.state,'staged');assert.deepEqual(saved.payload.basis.focus,{rowKey:first.key,columnKey:column});assert.equal(saved.payload.basis.intent,'next_steps');
  const request={requestId:`request-${view.view.viewId}-${view.view.ownedMetricId??'all'}`,sessionId:'d3-session',content:[{type:'text',text:'Plan next steps from selected analysis.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
  assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50})).rows,full.rows);
  const calls=[];await service.selectedExport(user,project,{selectionRef,view:view.view,expectedDigest:view.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(...args)=>{calls.push(args);return{id:'export'};}});assert.deepEqual(calls[0][1].cover.analysis.rows,full.rows);
  if(process.env.GEO_D3_RECEIPTS_DIR){await mkdir(process.env.GEO_D3_RECEIPTS_DIR,{recursive:true});await writeFile(`${process.env.GEO_D3_RECEIPTS_DIR}/document-${view.view.viewId}-${view.view.ownedMetricId??'all'}.json`,JSON.stringify({...freezeGeoAnalysisDocument(full),version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));}
  await ownership.set(project,{target:{kind:'page',value:urls[0]},relation:'other',expectedRevision:(await ownership.read(project,{kind:'page',value:urls[0]})).revision});
  await assert.rejects(service.analysis(user,project.id,{selectionRef,...view.view,expectedDigest:view.digest}),error=>error.status===409);
  assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50})).rows,full.rows);
  // Each next live view is refreshed after annotation revisions; already frozen exports remain immutable.
  for(const next of views.slice(views.indexOf(view)+1)){const refreshed=await service.analysis(user,project.id,{selectionRef,...next.view});Object.assign(next,refreshed);}
 }
 await assert.rejects(service.selectedExport({id:'d3-viewer'},project,{selectionRef,view:{viewId:'V20'}},{requestFrozen:async()=>assert.fail()}),error=>error.status===403);
});
test('V21 paginates 251 exact groups and null owned coordinates through bounded native pages without a latest fallback',opts,async()=>{
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d3-wide-control','Wide',1048576)",[user.id]);
 const wide=await store.createProject({userId:user.id,projectId:'d3-wide-control',engines:['deepseek'],coverageDays:90,product:{brandName:'Alpha'}});
 await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) SELECT 'd3-wide-g'||n,$1,$2,1,'P2','Same, quoted group' FROM generate_series(1,251)n",[user.id,wide.id]);
 await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured,original_id) SELECT 'd3-wide-q'||n,$1,$2,'d3-wide-g'||n,1,'P2','Original wide question?',true,'001' FROM generate_series(1,251)n",[user.id,wide.id]);
 await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('d3-wide-r',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01','{\"mode\":\"web\"}')",[user.id,wide.id]);
 await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations) SELECT 'd3-wide-s'||n,$1,$2,'d3-wide-r','d3-wide-q'||n,'deepseek','2026-10-01','valid','Original wide answer','{\"mode\":\"web\"}','[]' FROM generate_series(1,251)n",[user.id,wide.id]);
 const view=await service.analysis(user,wide.id,{round:'d3-wide-r',viewId:'V21',limit:50});assert.equal(view.page.total,251);
 const full=await freezeSelectedGeoAnalysis(store,wide,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
 const last=await service.analysis(user,wide.id,{selectionRef:view.selection.reference,...view.view,expectedDigest:view.digest,offset:250,limit:50});assert.equal(last.rows.length,1);assert.deepEqual(last.rows[0],full.rows[250]);
 assert.ok(full.rows.every(row=>row.values.owned.value===null&&row.values.owned.reason==='owned_not_registered'&&row.values.sample.value===1));
 const adapter=service.planContexts;
 const staged=await adapter.stage(user,wide.id,{requestKey:'d3-wide',sessionId:'d3-wide-session',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'next_steps',focus:{rowKey:full.rows[250].key,columnKey:'owned'}});
 const request={requestId:'d3-wide-request',sessionId:'d3-wide-session',content:[{type:'text',text:'Explain this selected group.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await adapter.prepare(user,{id:wide.projectId,userId:user.id},request);await adapter.bind(user,{id:wide.projectId,userId:user.id},request);
 const saved=await documents.get(wide.userId,'geo-plan-context',staged.referenceId);assert.ok(saved.payload.basis.analysis.frozenPages.pages.length>0);
 const native=[];for(let offset=0;offset<full.rows.length;offset+=50)native.push(...(await service.runtimeRead(wide,'analysis',{planContextRef:staged.referenceId,offset,limit:50})).rows);assert.deepEqual(native,full.rows);
 await assert.rejects(service.analysis(user,wide.id,{selectionRef,...view.view}),error=>error.status===404);
 await store.query("UPDATE evimed_geo.snapshots SET answer_text='Changed after freeze' WHERE id='d3-wide-s251'");
 await assert.rejects(service.analysis(user,wide.id,{selectionRef:view.selection.reference,...view.view,expectedDigest:view.digest}),error=>error.status===409);
 assert.deepEqual((await service.runtimeRead(wide,'analysis',{planContextRef:staged.referenceId,offset:250,limit:50})).rows,full.rows.slice(250));
 if(process.env.GEO_D3_RECEIPTS_DIR)await writeFile(`${process.env.GEO_D3_RECEIPTS_DIR}/document-V21-wide-null.json`,JSON.stringify({...freezeGeoAnalysisDocument(full),version:1,rendererVersion:'pandoc-chromium-v1',sourceDigest:full.digest,sourceType:'typed-table',formats:['csv','xlsx','docx','pdf','html']},null,2));
});
test('V21 planning focus stages an exact child strategy, retains parent analysis and imports only its producing run strategy file',opts,async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {createGeoDeliveryImport,geoStructuredRunPaths}=await import('../src/geoDeliveryImport.mjs');
 const parent=await service.analysis(user,project.id,{selectionRef,viewId:'V21',ownedMetricId:'M-08S'}),focus=parent.rows.find(row=>row.dimensions.groupId==='d3-g2'),adapter=service.planContexts;
 const input={requestKey:'d3-strategy-focus',sessionId:'d3-plan-session',mode:'strategy',selectionRef:parent.selection.reference,view:parent.view,expectedDigest:parent.digest,intent:'next_steps',focus:{rowKey:focus.key,columnKey:'owned'}};
 const staged=await adapter.stage(user,project.id,input),saved=await documents.get(project.userId,'geo-plan-context',staged.referenceId);
 assert.equal(saved.payload.mode,'strategy');assert.deepEqual(saved.payload.groupIds,['d3-g2']);assert.deepEqual(saved.payload.basis.groups.map(group=>[group.id,group.setVersion]),[['d3-g2',2]]);
 assert.equal(saved.payload.basis.selection.counts.snapshots,50);assert.notEqual(saved.payload.basis.selection.reference,parent.selection.reference);assert.equal(saved.payload.basis.analysis.selection.reference,parent.selection.reference);assert.equal(saved.payload.basis.analysis.digest,parent.digest);
 assert.equal(saved.payload.basis.analysisFocus.groupId,'d3-g2');assert.equal(saved.payload.basis.analysisFocus.setVersion,2);assert.match(staged.draft,/生成|调整|拟定/);
 for(const changes of [{groupIds:['d3-g1']},{url:urls[0]},{sourceId:'d3-src'},{focus:{rowKey:'outside',columnKey:'owned'}},{view:{viewId:'V20'}}]) await assert.rejects(adapter.stage(user,project.id,{...input,...changes,requestKey:`reject-${Object.keys(changes)[0]}`}),error=>error.status===400||error.status===409);
 await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId}),error=>error.status===404);
 const request={requestId:'d3-plan-request',sessionId:'d3-plan-session',content:[{type:'text',text:staged.draft}],geoPlanContext:{referenceId:staged.referenceId}},control={id:project.projectId,userId:user.id};
 await adapter.prepare(user,control,request);await adapter.bind(user,control,request);const route=await adapter.routingInputForRequest(control,request);assert.equal(route.mode,'strategy');assert.equal(route.originalText,staged.draft);
 const analysis=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50});assert.equal(analysis.digest,parent.digest);assert.deepEqual(analysis.rows,(await freezeSelectedGeoAnalysis(store,project,{selectionRef:parent.selection.reference,view:parent.view,expectedDigest:parent.digest})).rows);
 await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,viewId:'V20'}),error=>error.status===400);
 const run={id:'d3-producing-plan-run',sessionId:request.sessionId,status:'succeeded',effectiveAgentId:'geo-strategy',kernelRequestIds:[request.requestId],outputFiles:['deliverables/d3-plan/strategy.json']};
 const bound=await adapter.forRun(project,run);assert.equal(bound.mode,'strategy');assert.deepEqual(geoStructuredRunPaths(run,bound),run.outputFiles);
 const root=await mkdtemp(join(tmpdir(),'evimed-d3-plan-'));try{
  await mkdir(join(root,'deliverables/d3-plan'),{recursive:true});await writeFile(join(root,run.outputFiles[0]),JSON.stringify({summary:'Scoped observed opportunity plan',gaps:[{gapId:'d3-gap',groupId:'d3-g2',class:'missing_evidence',text:'Inspect explicit evidence linkage'}],actions:[{gapId:'d3-gap',groupId:'d3-g2',gapClass:'missing_evidence',kind:'fill_gap',what:{title:'Inspect exact group evidence'},work:{mode:'new',outputs:['review.md']}}]}));
  const importer=createGeoDeliveryImport({store,planningContext:(p,r)=>adapter.forRun(p,r),readRunFile:async(_p,r,path)=>{assert.equal(r.id,run.id);assert.equal(path,run.outputFiles[0]);return readFile(join(root,path));}});
  await importer({...control,workspaceDir:root},run);
  const stored=await store.latestStrategy(project.id,{scopeKey:bound.scopeKey});assert.ok(stored);assert.equal(stored.runId,run.id);assert.equal(stored.basis.analysis.digest,parent.digest);
  const plan=await service.strategy(user,project.id,{selectionRef:bound.basis.selection.reference});assert.equal(plan.version,stored.version);assert.deepEqual(plan.basis.groups.map(group=>group.id),['d3-g2']);assert.equal(plan.scopeKey,bound.scopeKey);
 }finally{await rm(root,{recursive:true,force:true});}
});
