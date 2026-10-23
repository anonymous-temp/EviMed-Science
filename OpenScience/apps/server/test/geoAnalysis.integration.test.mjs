import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoMeasureStore } from "../src/geoMeasureStore.mjs";
import { measureRound } from "../src/geoMetricsJob.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
let database, store, measure, isolated, project, service;
const user = { id: "scope-owner" };

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoanalysis");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database }); measure = new GeoMeasureStore(database);
  await measure.ready(); await store.ready();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'GEO test','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'scope-project','GEO test',1048576)", [user.id]);
  project = await store.createProject({ userId: user.id, projectId: "scope-project", engines: ["deepseek", "kimi", "doubao"], coverageDays: 90, product: { brandName: "Ours" } });
  service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  await store.query(`INSERT INTO evimed_geo.question_groups (id,user_id,geo_project_id,set_version,pool,name) VALUES ('g1',$1,$2,1,'P2','Group one'),('g2',$1,$2,1,'P3','Group two')`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.questions (id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured)
    VALUES ('q1',$1,$2,'g1',1,'P2','Which brand?',true),('q2',$1,$2,'g2',1,'P3','What works?',true)`, [user.id, project.id]);
  await store.query(`INSERT INTO evimed_geo.sources (id,user_id,geo_project_id,domain,name,kind,layer) VALUES ('source1',$1,$2,'example.com','Example','medical','owned')`, [user.id, project.id]);
  for (const [round, date] of [["r1", "2026-10-01"], ["r2", "2026-10-02"]]) {
    await store.query(`INSERT INTO evimed_geo.rounds (id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,created_at,surface)
      VALUES ($1,$2,$3,'baseline','done',1,'{deepseek,kimi,doubao}',$4::date,$4::date + interval '3 hours',$4::date,'{"mode":"web"}')`, [round,user.id,project.id,date]);
    for (const [question, engine] of [["q1","deepseek"],["q1","kimi"],["q2","deepseek"],["q2","kimi"],["q1","doubao"]]) {
      const id = `${round}-${question}-${engine}`;
      const mentioned = round === "r2" || engine === "deepseek";
      await store.query(`INSERT INTO evimed_geo.snapshots (id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations)
        VALUES ($1,$2,$3,$4,$5,$6,$7::date,'valid','Original answer','{"mode":"web"}','[{"url":"https://example.com/a","domain":"example.com","inBody":true}]')`, [id,user.id,project.id,round,question,engine,date]);
      await store.query(`INSERT INTO evimed_geo.facts (snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks,retrieval_triggered)
        VALUES ($1,$2,$3,$4::date,$5::jsonb,$6,'[{"text":"Known","verdict":"correct"}]','{"judgementCoverage":{"status":"complete"}}',true)`,
      [id,user.id,project.id,date,JSON.stringify(mentioned ? [{name:"Ours",ours:true,count:1}] : []),mentioned]);
    }
    await store.query(`INSERT INTO evimed_geo.probe_jobs (id,user_id,geo_project_id,round_id,question_id,engine,status,error_code)
      VALUES ($1,$2,$3,$4,'q1','doubao','skipped','engine_paused')`, [`job-${round}`,user.id,project.id,round]);
    await measureRound({ store: measure, now: () => new Date(`${date}T04:00:00Z`) }, round);
  }
  for (const [id, snapshot, type, severity, statement] of [["e1","r1-q1-deepseek","number","S3","Earlier mistake"],
    ["e2","r2-q1-deepseek","number","S3","Dose mistake"],["e3","r2-q2-kimi","number","S1","Other mistake"]]) {
    await store.query(`INSERT INTO evimed_geo.errors (id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,error_type,severity,statement)
      VALUES ($1,$2,$3,$1,$4,$5,$6,$6,$7,$8,$9)`, [id,user.id,project.id,snapshot.endsWith("kimi")?"kimi":"deepseek",snapshot.includes("q1")?"q1":"q2",snapshot,type,severity,statement]);
  }
});
after(async () => { await database?.close(); await isolated?.drop(); });


test("analysis keeps scope, deterministic paging, point/interval members, native and frozen export parity", options, async () => {
  const view = await service.analysis(user, project.id, {viewId:"V02",metricId:"M-01",dimension:"engine",from:"2026-10-01",to:"2026-10-02",limit:1});
  assert.ok(view.page.total > view.rows.length);
  const restored = await service.runtimeRead(project,"analysis",{selectionRef:view.selection.reference,viewId:"V02",metricId:"M-01",dimension:"engine",expectedDigest:view.digest});
  assert.equal(restored.digest,view.digest);
  for (const row of restored.rows) {
    const cell=row.values.current;
    const members=await service.runtimeRead(project,"snapshots",{selectionRef:cell.members.selectionRef,member:cell.members.metric,limit:50});
    assert.equal(members.total,cell.members.total);
    if(row.dimensions.period==="day") assert.ok(members.items.every(item=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(item.askedAt))===row.dimensions.date));
  }
  const {freezeSelectedGeoAnalysis}=await import("../src/geoAnalysis.mjs");
  const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
  assert.equal(full.rows.length,view.page.total);
  const calls=[];
  await service.selectedExport(user,project,{kind:"selected",selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:["csv","xlsx"]},{requestFrozen:async(...args)=>{calls.push(args);return {id:"export"};}});
  assert.equal(calls[0][1].typedTable.rows.length,full.rows.length);
  assert.equal(calls[0][1].revision,view.digest);
  await assert.rejects(service.analysis({id:"stranger"},project.id,{viewId:"V01"}),error=>error.status===404);
  await assert.rejects(service.selectedExport(user,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:"a".repeat(64)},{requestFrozen:async()=>assert.fail()}),error=>error.status===409);
  await store.query("UPDATE evimed_geo.snapshots SET answer_text='Changed' WHERE id='r1-q1-deepseek'");
  await assert.rejects(service.analysis(user,project.id,{selectionRef:view.selection.reference,viewId:"V02",metricId:"M-01",dimension:"engine"}),error=>error.status===409);
});

test('one native adapter freezes exact analysis before later data changes and binds only the actual request', options, async()=>{
  const {GeoPlanContext}=await import('../src/geoPlanContext.mjs');
  const {ProductDocuments}=await import('../src/productStore.mjs');
  const documents=new ProductDocuments(database);
  const adapter=new GeoPlanContext({documents,store,service,authorizeSession:async(_actor,_project,session)=>assert.equal(session,'analysis-session'),runs:async()=>[]});
  service.planContexts=adapter;
  const view=await service.analysis(user,project.id,{viewId:'V01',round:'r2',metricId:'M-01S'});
  const body={requestKey:'analysis-stage',sessionId:'analysis-session',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'explain'};
  const staged=await adapter.stage(user,project.id,body);
  await assert.rejects(adapter.stage(user,project.id,{...body,expectedDigest:'f'.repeat(64)}),error=>error.status===409);
  await assert.rejects(adapter.stage(user,project.id,{...body,requestKey:'focus',focus:{rowKey:'outside',columnKey:'current'}}),error=>error.status===400);
  await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId}),error=>error.status===404);
  const request={requestId:'actual-analysis-request',sessionId:'analysis-session',content:[{type:'text',text:'Explain only the selected value.'}],geoPlanContext:{referenceId:staged.referenceId}};
  await adapter.bind(user,{id:project.projectId,userId:project.userId},request);
  assert.equal(request.geoPlanContext,undefined);assert.match(request.content[1].text,/basis.analysis/);
  const frozen=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId});
  assert.equal(frozen.digest,view.digest);
  await store.query("UPDATE evimed_geo.snapshots SET answer_text='Changed again' WHERE id='r2-q1-deepseek'");
  assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId})).rows,frozen.rows);
  await assert.rejects(service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,round:'r1'}),error=>error.status===400);
  const metric=frozen.rows[0].values.current.members;
  await assert.rejects(service.runtimeRead(project,'snapshots',{selectionRef:metric.selectionRef,member:metric.metric}),error=>error.status===409);
  await assert.rejects(adapter.bind(user,{id:project.projectId,userId:project.userId},{...request,requestId:'other',content:[{type:'text',text:'other'}],geoPlanContext:{referenceId:staged.referenceId}}),error=>error.status===409);
});

test('analysis HTTP parsing and selected export require membership, scope and the expected revision', options, async()=>{
  const {Readable}=await import('node:stream');
  const {createGeoRoutes}=await import('../src/geoRoutes.mjs');
  const calls=[];
  let actor=user;
  const routes=createGeoRoutes({store:{ensureSessionUser:async()=>({user:actor}),assertCsrf:async()=>{}},service,config:{geoEnabled:true,geoAudience:'all'},maxJsonBytes:65536,selectedExporter:{requestFrozen:async(...args)=>{calls.push(args);return {id:'export-selected'};}}});
  const response=()=>({body:'',writeHead(){},end(value){this.body=String(value);}});
  const req=(method,url,body)=>Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{method,url,headers:{'content-type':'application/json'}});
  const res=response();
  await routes(req('GET',`/api/geo/projects/${project.id}/analysis?viewId=V01&round=r2&metricId=M-01S&limit=1`),res);
  const view=JSON.parse(res.body).data;
  assert.equal(view.rows.length,1);
  const output=response();
  await routes(req('POST',`/api/geo/projects/${project.id}/export`,{kind:'selected',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:['csv','xlsx']}),output);
  assert.equal(JSON.parse(output.body).data.id,'export-selected');assert.equal(calls[0][0].id,user.id);
  await assert.rejects(routes(req('GET',`/api/geo/projects/${project.id}/analysis?viewId=V01&sql=all`),response()),error=>error.status===400);
  actor={id:'stranger'};
  await assert.rejects(routes(req('POST',`/api/geo/projects/${project.id}/export`,{kind:'selected',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest}),response()),error=>error.status===404);
});

test('read-only members can inspect selected readings but cannot spend the owner export quota',options,async()=>{
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('analysis-viewer','Viewer','development')");
  await store.addMember({geoId:project.id,userId:'analysis-viewer',role:'viewer',invitedBy:user.id});
  const viewer={id:'analysis-viewer'};
  const view=await service.analysis(viewer,project.id,{viewId:'V01',round:'r2'});
  await assert.rejects(service.selectedExport(viewer,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest},{requestFrozen:async()=>assert.fail('A viewer cannot enqueue exports.')}),error=>error.status===403);
});

test('selected export route returns a format validation error without creating conversion work',options,async()=>{
  const {Readable}=await import('node:stream');
  const {createGeoRoutes}=await import('../src/geoRoutes.mjs');
  const {DocumentExportService}=await import('../src/documentExport.mjs');
  const view=await service.analysis(user,project.id,{viewId:'V01',round:'r2',metricId:'M-01S'});
  let inspected=0;
  const exporter=new DocumentExportService({config:{},documents:{database:{}},jobs:{},controller:{inspectRuntimeImage:async()=>{inspected++;assert.fail('Invalid formats cannot create render work.');}},resolveSource:async()=>assert.fail(),authorize:async()=>{}});
  const routes=createGeoRoutes({store:{ensureSessionUser:async()=>({user}),assertCsrf:async()=>{}},service,config:{geoEnabled:true,geoAudience:'all'},maxJsonBytes:65536,selectedExporter:exporter});
  const body={kind:'selected',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:['exe']};
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST',url:`/api/geo/projects/${project.id}/export`,headers:{'content-type':'application/json'}});
  await assert.rejects(routes(req,{writeHead(){},end(){}}),error=>error.status===400&&error.code==='document_export_format_invalid');
  assert.equal(inspected,0);
});

test('Batch B full aggregates, paginated typed members, five formats and shared native scope retain parity',options,async()=>{
  await store.query("UPDATE evimed_geo.questions SET original_group=CASE WHEN id='q1' THEN 'A, B' ELSE NULL END, original_id=CASE WHEN id='q1' THEN '0007' ELSE '0008' END,original_row_index=4,client_tags=ARRAY['one','two'] WHERE geo_project_id=$1",[project.id]);
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('planned-only',$1,$2,'weekly','queued',1,'{kimi}','2026-10-02','{"mode":"web"}')`,[user.id,project.id]);
  await store.query(`INSERT INTO evimed_geo.probe_jobs(id,user_id,geo_project_id,round_id,question_id,engine,status,error_code) VALUES('planned-job',$1,$2,'planned-only','q1','kimi','queued',NULL)`,[user.id,project.id]);
  const {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument}=await import('../src/geoAnalysis.mjs');
  for(const viewId of ['V06','V07','V11','V12','V14']) {
    const view=await service.analysis(user,project.id,{viewId,from:'2026-10-02',to:'2026-10-02',limit:1});
    assert.ok(view.page.total>=view.page.shown);
    const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});
    assert.equal(full.digest,view.digest);assert.equal(full.rows.length,view.page.total);
    const native=await service.runtimeRead(project,'analysis',{selectionRef:view.selection.reference,...view.view,expectedDigest:view.digest});assert.equal(native.digest,view.digest);
    for(const row of full.rows)for(const [columnKey,cell]of Object.entries(row.values))if(cell.members) {
      const input={selectionRef:cell.members.selectionRef,...view.view,rowKey:row.key,columnKey,expectedDigest:view.digest,limit:1};
      const member=await service.analysisMembers(user,project.id,input);
      assert.equal(member.total,cell.members.total);assert.equal(member.unit,cell.members.unit);
      assert.deepEqual(member,await service.runtimeRead(project,'analysis',input));
      if(member.items[0]?.snapshotId){assert.ok(member.items[0].answer.answer_text);assert.equal(member.items[0].question.originalRow,4);}
    }
    const report=freezeGeoAnalysisDocument(full);assert.equal(report.typedTable.rows.length,full.rows.length);
    const exports=[];await service.selectedExport(user,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(...args)=>{exports.push(args);return {id:'all-formats'};}});
    assert.deepEqual(exports[0][2],['csv','xlsx','docx','pdf','html']);assert.equal(exports[0][1].cover.analysis.digest,view.digest);
    if(viewId==='V11')assert.ok(full.rows.some(row=>row.dimensions.roundId==='planned-only'&&row.dimensions.basis==='scheduled_jobs'&&row.values.pending.value===1));
    await assert.rejects(service.analysisMembers({id:'stranger'},project.id,{selectionRef:view.selection.reference,...view.view,rowKey:full.rows[0].key,columnKey:Object.keys(full.rows[0].values)[0],expectedDigest:view.digest}),error=>error.status===404);
  }
  const view=await service.analysis(user,project.id,{viewId:'V07',from:'2026-10-02',to:'2026-10-02'});
  const member=view.rows.find(row=>row.values.pending.value>0).values.pending.members;
  await store.query("UPDATE evimed_geo.probe_jobs SET status='failed',error_code='timeout' WHERE id='planned-job'");
  await assert.rejects(service.analysisMembers(user,project.id,{selectionRef:member.selectionRef,...member.view,rowKey:member.rowKey,columnKey:member.columnKey,expectedDigest:member.expectedDigest}),error=>error.status===409);
});

test('planned-only new question versions and engines remain context without enlarging observed denominators',options,async()=>{
 await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('planned-v2-group',$1,$2,2,'P2','Version two')`,[user.id,project.id]);
 await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,original_group) VALUES('planned-v2-q',$1,$2,'planned-v2-group',2,'P2','Version two question','Planned category')`,[user.id,project.id]);
 for(const [id,version,engines]of [['observed-only',1,['deepseek']],['planned-v2',2,['kimi']]])await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'weekly','done',$4,$5::text[],'2026-10-03','{"mode":"web"}')`,[id,user.id,project.id,version,engines]);
 await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text) VALUES('observed-v1',$1,$2,'observed-only','q1','deepseek','2026-10-03','valid','Observed only')`,[user.id,project.id]);
 await store.query(`INSERT INTO evimed_geo.probe_jobs(id,user_id,geo_project_id,round_id,question_id,engine,status) VALUES('new-version-job',$1,$2,'planned-v2','planned-v2-q','kimi','queued')`,[user.id,project.id]);
 const scope={from:'2026-10-03',to:'2026-10-03',limit:50};
 const questionView=await service.analysis(user,project.id,{...scope,viewId:'V07'});
 const row=questionView.rows.find(row=>row.dimensions.questionId==='planned-v2-q'&&row.dimensions.engine==='kimi');
 assert.ok(row);assert.equal(row.dimensions.basis,'scheduled_only');assert.equal(row.values.pending.value,1);assert.equal(questionView.selection.counts.snapshots,1);assert.deepEqual(questionView.selection.engines,['deepseek']);
 const coverage=await service.analysis(user,project.id,{...scope,viewId:'V11'});assert.ok(coverage.rows.some(row=>row.dimensions.roundId==='planned-v2'&&row.dimensions.engine==='kimi'&&row.values.pending.value===1));
 assert.ok(coverage.rows.filter(row=>row.dimensions.basis==='observed').every(row=>row.dimensions.engine==='deepseek'));
 const narrowed=await service.analysis(user,project.id,{...scope,viewId:'V07',questionVersion:1});assert.ok(narrowed.rows.every(row=>row.dimensions.questionId!=='planned-v2-q'));
});
