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

test('the members of an aggregate cell are read over HTTP by the path the page calls', options, async () => {
  const { Readable } = await import('node:stream');
  const { createGeoRoutes } = await import('../src/geoRoutes.mjs');
  const routes = createGeoRoutes({ store: { ensureSessionUser: async () => ({ user }), assertCsrf: async () => {} }, service, config: { geoEnabled: true, geoAudience: 'all' }, maxJsonBytes: 65536 });
  const get = async (url) => {
    const res = { status: 0, body: '', writeHead(status) { this.status = status; return this; }, end(chunk = '') { this.body = String(chunk); } };
    await routes(Object.assign(Readable.from([]), { method: 'GET', url, headers: {} }), res);
    return { status: res.status, data: JSON.parse(res.body).data };
  };
  const view = await service.analysis(user, project.id, { viewId: 'V06', from: '2026-10-02', to: '2026-10-02', limit: 1 });
  const { freezeSelectedGeoAnalysis } = await import('../src/geoAnalysis.mjs');
  const full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
  let compared = 0;
  for (const row of full.rows) for (const [columnKey, cell] of Object.entries(row.values)) if (cell.members) {
    // The page's own query leaves a null descriptor field out (geoAnalysisClient.analysisQuery).
    const query = new URLSearchParams(Object.entries({ selectionRef: cell.members.selectionRef, ...view.view, rowKey: row.key, columnKey, expectedDigest: view.digest, limit: 50 })
      .filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]));
    const answer = await get(`/api/geo/projects/${project.id}/analysis/members?${query}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.data, JSON.parse(JSON.stringify(await service.analysisMembers(user, project.id, { ...Object.fromEntries(query), limit: 50 }))));
    assert.equal(answer.data.total, cell.members.total);
    compared += 1;
  }
  assert.ok(compared > 0, 'the view has at least one cell with members, so the route was exercised');
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

test('V06 valid and empty metric reasons agree across authorized runtime and export',options,async()=>{
 const view=await service.analysis(user,project.id,{viewId:'V06',round:'r2',metricId:'M-01',engines:['deepseek','doubao'],limit:50});
 const native=await service.runtimeRead(project,'analysis',{selectionRef:view.selection.reference,...view.view,expectedDigest:view.digest});assert.deepEqual(native.rows,view.rows);
 const metricCells=view.rows.map(row=>row.values.metric);assert.ok(metricCells.some(cell=>cell.value===100&&cell.reason===null));
 assert.ok(metricCells.filter(cell=>cell.value===null).every(cell=>cell.reason===cell.metric?.reason));
 const exports=[];await service.selectedExport(user,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:['csv']},{requestFrozen:async(...args)=>{exports.push(args);return {};}});
 const frozen=exports[0][1].cover.analysis;assert.equal(frozen.digest,view.digest);assert.ok(exports[0][1].typedTable.rows.some(row=>JSON.parse(row.cells_metadata).metric.reason===null));
});

test('C1 exact matrix cells and same-day actual round members retain native/export/authorization parity',options,async()=>{
 const {freezeSelectedGeoAnalysis,freezeGeoAnalysisDocument}=await import('../src/geoAnalysis.mjs');
 await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('c1-g1',$1,$2,9,'P2','Same'),('c1-g2',$1,$2,9,'P2','Same')`,[user.id,project.id]);
 const qs=['c1-g1','c1-g2'].flatMap(group=>Array.from({length:50},(_,n)=>({id:`${group}-q${n}`,group_id:group,text:`Question ${n}`,original_id:n===0?'=公式,Unicode药':'0007',original_row_index:n+1})));
 await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,original_id,original_row_index,original_group,client_tags) SELECT x.id,$1,$2,x.group_id,9,'P2',x.text,x.original_id,x.original_row_index,'Client, 分类',ARRAY['中文','tag'] FROM jsonb_to_recordset($3::jsonb) AS x(id text,group_id text,text text,original_id text,original_row_index integer)`,[user.id,project.id,JSON.stringify(qs)]);
 for(const round of ['c1-r1','c1-r2']){
 await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'baseline','done',9,'{deepseek,kimi}','2026-10-04','{"mode":"web"}')`,[round,user.id,project.id]);
 const snapshots=qs.flatMap(q=>['deepseek','kimi'].map(engine=>({id:`${round}-${q.id}-${engine}`,question_id:q.id,engine,mentioned:(q.group_id==='c1-g1')!==(engine==='deepseek')})));
 await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) SELECT x.id,$1,$2,$3,x.question_id,x.engine,'2026-10-04T03:00:00Z','valid','Exact original answer','{"mode":"web"}' FROM jsonb_to_recordset($4::jsonb) AS x(id text,question_id text,engine text)`,[user.id,project.id,round,JSON.stringify(snapshots)]);
 await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks) SELECT x.id,$1,$2,'2026-10-04',CASE WHEN x.mentioned THEN '[{"name":"Ours","ours":true,"count":1}]'::jsonb ELSE '[]'::jsonb END,x.mentioned,'[]','{"judgementCoverage":{"status":"complete"}}' FROM jsonb_to_recordset($3::jsonb) AS x(id text,mentioned boolean)`,[user.id,project.id,JSON.stringify(snapshots)]);
 }
 const matrix=await service.analysis(user,project.id,{viewId:'V05',metricId:'M-01',round:'c1-r1',engines:['deepseek','kimi'],limit:1});
 const full=await freezeSelectedGeoAnalysis(store,project,{selectionRef:matrix.selection.reference,view:matrix.view,expectedDigest:matrix.digest});
 assert.equal(full.rows.length,4);assert.deepEqual(full.rows.map(row=>row.values.current.value).sort((a,b)=>a-b),[0,0,100,100]);
 for(const row of full.rows){
  const member=row.values.current.members;assert.equal(member.total,50);assert.equal(row.values.current.metric.denominator,50);assert.equal(row.dimensions.setVersion,9);
  const input={selectionRef:member.selectionRef,...member.view,rowKey:member.rowKey,columnKey:member.columnKey,expectedDigest:member.expectedDigest,limit:20};
  const pages=await Promise.all([0,20,40].map(offset=>service.analysisMembers(user,project.id,{...input,offset})));const items=pages.flatMap(page=>page.items);
  assert.deepEqual(items.map(item=>item.id).sort(),qs.filter(q=>q.group_id===row.dimensions.groupId).map(q=>`c1-r1-${q.id}-${row.dimensions.engine}`).sort());
  assert.ok(items.every(item=>item.question.originalGroup==='Client, 分类'&&item.question.clientTags.includes('中文')));assert.equal(items.find(item=>item.question.originalRow===1).question.originalId,'=公式,Unicode药');
  assert.deepEqual(pages[0],await service.runtimeRead(project,'analysis',input));
  await assert.rejects(service.analysisMembers(user,project.id,{...input,rowKey:'outside'}),error=>error.status===404);
  await assert.rejects(service.analysisMembers(user,project.id,{...input,expectedDigest:'f'.repeat(64)}),error=>error.status===409);
  await assert.rejects(service.analysisMembers({id:'stranger'},project.id,input),error=>error.status===404);
 }
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'c1-foreign-project','Foreign fixture',1048576)",[user.id]);
 const other=await store.createProject({userId:user.id,projectId:'c1-foreign-project',engines:['deepseek'],coverageDays:90,product:{brandName:'Other'}});
 await assert.rejects(service.analysis(user,other.id,{selectionRef:full.selection.reference,...full.view}),error=>error.status===404);
 const viewer={id:'analysis-viewer'};const viewerView=await service.analysis(viewer,project.id,{selectionRef:full.selection.reference,...full.view});assert.equal(viewerView.digest,full.digest);
 await assert.rejects(service.selectedExport(viewer,project,{selectionRef:full.selection.reference,view:full.view,expectedDigest:full.digest},{requestFrozen:async()=>assert.fail('Viewer cannot create an export')}),error=>error.status===403);
 const roundView=await service.analysis(user,project.id,{viewId:'V02',metricId:'M-01',dimension:'engine',timeGrain:'round',questionVersion:9,engines:['deepseek','kimi'],from:'2026-10-04',to:'2026-10-04'});
 const pointRows=roundView.rows.filter(row=>row.dimensions.period==='round');assert.equal(pointRows.length,4);assert.equal(roundView.chart.labels.length,2);
 for(const row of pointRows){const member=row.values.current.members;const page=await service.runtimeRead(project,'snapshots',{selectionRef:member.selectionRef,member:member.metric,limit:50});assert.equal(page.total,100);assert.ok(page.items.every(item=>item.roundId===row.dimensions.roundId));}
 for(const view of [full,roundView]){
  const restored=await freezeSelectedGeoAnalysis(store,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest});assert.equal(restored.digest,view.digest);
  const report=freezeGeoAnalysisDocument(restored);assert.equal(report.cover.analysis.digest,view.digest);
  const calls=[];await service.selectedExport(user,project,{selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,formats:['csv','xlsx','docx','pdf','html']},{requestFrozen:async(...args)=>{calls.push(args);return{id:'c1-export'};}});assert.equal(calls[0][1].revision,view.digest);
 }
 const {GeoPlanContext}=await import('../src/geoPlanContext.mjs');const {ProductDocuments}=await import('../src/productStore.mjs');
 const adapter=new GeoPlanContext({documents:new ProductDocuments(database),store,service,authorizeSession:async()=>{},runs:async()=>[]});service.planContexts=adapter;
 const staged=await adapter.stage(user,project.id,{requestKey:'c1-stage',sessionId:'c1-session',mode:'analysis',selectionRef:full.selection.reference,view:full.view,expectedDigest:full.digest,intent:'explain'});
 const request={requestId:'c1-unsent',sessionId:'c1-session',content:[{type:'text',text:'Explain selected matrix.'}],geoPlanContext:{referenceId:staged.referenceId}};
 await adapter.bind(user,{id:project.projectId,userId:project.userId},request);const frozen=await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId});assert.equal(frozen.digest,full.digest);assert.deepEqual(frozen.rows,full.rows);
});

test('same-day round chronology is canonical across authorized pages, exact members, export and frozen native context', options, async () => {
  const { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } = await import('../src/geoAnalysis.mjs');
  await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name)
    VALUES('chronology-group',$1,$2,10,'P2','Chronology fixture')`, [user.id, project.id]);
  const questions = Array.from({ length: 50 }, (_, index) => ({ id: `chronology-q${index}`, text: `Question ${index}` }));
  await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text)
    SELECT q.id,$1,$2,'chronology-group',10,'P2',q.text
    FROM jsonb_to_recordset($3::jsonb) AS q(id text,text text)`, [user.id, project.id, JSON.stringify(questions)]);
  const expected = Array.from({ length: 12 }, (_, index) => `chronology-r${index + 1}`);
  const rounds = [...expected, 'chronology-unknown'].reverse().map(id => {
    const hour = id === 'chronology-unknown' ? null : Number(id.slice('chronology-r'.length));
    return { id, asked_at: hour == null ? null : `2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`, finished_at: `2026-10-05T${String(hour ?? 14).padStart(2, '0')}:00:01Z` };
  });
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,finished_at,created_at,surface)
    SELECT r.id,$1,$2,'weekly','done',10,'{deepseek}','2026-10-05',r.finished_at::timestamptz,r.finished_at::timestamptz,'{"mode":"web"}'
    FROM jsonb_to_recordset($3::jsonb) AS r(id text,finished_at text)`, [user.id, project.id, JSON.stringify(rounds)]);
  const answers = rounds.flatMap(round => questions.map(question => ({ id: `${round.id}-${question.id}`, round_id: round.id, question_id: question.id, asked_at: round.asked_at })));
  await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
    SELECT s.id,$1,$2,s.round_id,s.question_id,'deepseek',s.asked_at::timestamptz,'valid','Chronology original answer','{"mode":"web"}'
    FROM jsonb_to_recordset($3::jsonb) AS s(id text,round_id text,question_id text,asked_at text)`, [user.id, project.id, JSON.stringify(answers)]);
  await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,statements,checks)
    SELECT s.id,$1,$2,'2026-10-05','[]',false,'[]','{"judgementCoverage":{"status":"complete"}}'
    FROM jsonb_to_recordset($3::jsonb) AS s(id text)`, [user.id, project.id, JSON.stringify(answers)]);
  const { readGeoSelection } = await import('../src/geoReadScope.mjs');
  const history = await readGeoSelection(store, project, { questionVersion: 10, engines: ['deepseek'] }, { history: true, historyLimit: 20 });
  const first = await service.analysis(user, project.id, { selectionRef: history.selection.reference, viewId: 'V02', metricId: 'M-01', dimension: 'engine', timeGrain: 'round', limit: 5 });
  const input = { selectionRef: first.selection.reference, view: first.view, expectedDigest: first.digest };
  const full = await freezeSelectedGeoAnalysis(store, project, input);
  const points = full.rows.filter(row => row.dimensions.period === 'round');
  const expectedRounds = [...expected, 'chronology-unknown'];
  assert.deepEqual(points.map(row => row.dimensions.roundId), expectedRounds);
  assert.deepEqual(points.map(row => row.dimensions.roundOrdinal), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.equal(points.at(-1).dimensions.date, null);
  assert.match(full.chart.labels.at(-1), /采样时间未知/);
  const paged = [];
  for (let offset = 0; offset < full.rows.length; offset += 5) {
    const page = await service.analysis(user, project.id, { selectionRef: first.selection.reference, ...first.view, expectedDigest: first.digest, limit: 5, offset });
    paged.push(...page.rows);
  }
  assert.deepEqual(paged.map(row => row.key), full.rows.map(row => row.key));
  for (const point of points) {
    const member = point.values.current.members;
    const members = await service.runtimeRead(project, 'snapshots', { selectionRef: member.selectionRef, member: member.metric, limit: 50 });
    assert.equal(members.total, 50);
    assert.deepEqual(members.items.map(item => item.id).sort(), questions.map(question => `${point.dimensions.roundId}-${question.id}`).sort());
  }
  const document = freezeGeoAnalysisDocument(full);
  assert.deepEqual(document.typedTable.rows.filter(row => row.period === 'round').map(row => JSON.parse(row.dimensions).roundId), expectedRounds);
  const exports = [];
  await service.selectedExport(user, project, { ...input, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { exports.push(args); return { id: 'chronology-export' }; } });
  assert.deepEqual(exports[0][1].typedTable.rows, document.typedTable.rows);
  const { GeoPlanContext } = await import('../src/geoPlanContext.mjs');
  const { ProductDocuments } = await import('../src/productStore.mjs');
  const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => {}, runs: async () => [] });
  service.planContexts = adapter;
  const staged = await adapter.stage(user, project.id, { ...input, requestKey: 'chronology-stage', sessionId: 'chronology-session', mode: 'analysis', intent: 'explain' });
  const request = { requestId: 'chronology-native', sessionId: 'chronology-session', content: [{ type: 'text', text: 'Explain this chronological analysis.' }], geoPlanContext: { referenceId: staged.referenceId } };
  await adapter.bind(user, { id: project.projectId, userId: project.userId }, request);
  const native = await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId });
  assert.deepEqual(native.rows.map(row => row.key), full.rows.map(row => row.key));
  const nativePage = await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 5, offset: 5 });
  assert.deepEqual(nativePage.rows.map(row => row.key), full.rows.slice(5, 10).map(row => row.key));
});

test('quality display metadata shares exact absent/floor cohorts and pool-qualified members with runtime and export', options, async () => {
  const { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } = await import('../src/geoAnalysis.mjs');
  await store.query(`INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name)
    VALUES('quality-g',$1,$2,11,'P4','Risk group · 原始分类')`, [user.id, project.id]);
  const questions = Array.from({ length: 50 }, (_, index) => ({ id: `quality-q${index}`, text: `Risk question ${index}` }));
  await store.query(`INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text)
    SELECT q.id,$1,$2,'quality-g',11,'P4',q.text FROM jsonb_to_recordset($3::jsonb) AS q(id text,text text)`, [user.id, project.id, JSON.stringify(questions)]);
  await store.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface)
    VALUES('quality-r',$1,$2,'baseline','done',11,'{deepseek,kimi}','2026-10-06','{"mode":"web"}')`, [user.id, project.id]);
  const addAnswers = async (batch) => {
    await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
      SELECT 'answer-'||q.id,$1,$2,'quality-r',q.id,'deepseek','2026-10-06','valid','Preserved risk answer','{"mode":"web"}'
      FROM jsonb_to_recordset($3::jsonb) AS q(id text)`, [user.id, project.id, JSON.stringify(batch)]);
    await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,recommended_ours,statements,checks)
      SELECT 'answer-'||q.id,$1,$2,'2026-10-06','[]',false,false,'[]','{"judgementCoverage":{"status":"complete"}}'
      FROM jsonb_to_recordset($3::jsonb) AS q(id text)`, [user.id, project.id, JSON.stringify(batch)]);
  };
  await addAnswers(questions.slice(0, 10));
  const thin = await service.analysis(user, project.id, { viewId: 'V04', metricId: 'M-01', round: 'quality-r', engines: ['deepseek', 'kimi'] });
  assert.deepEqual(thin.chart.cells.map(cell => [cell.engine, cell.state, cell.value]), [['deepseek', 'insufficient', 0], ['kimi', 'no_data', null]]);
  for (const row of thin.rows) {
    const value = row.values.current;
    const page = await service.analysisMembers(user, project.id, { ...value.members.view, selectionRef: value.members.selectionRef, rowKey: value.members.rowKey, columnKey: value.members.columnKey, expectedDigest: thin.digest, limit: 50 });
    assert.equal(page.total, row.dimensions.engine === 'deepseek' ? 10 : 0);
    const cell = thin.chart.cells.find(cell => cell.rowKey === row.key);
    assert.equal(cell.reason, value.reason); assert.deepEqual(cell.members, value.members);
  }
  await addAnswers(questions.slice(10));
  await assert.rejects(service.analysis(user, project.id, { ...thin.view, selectionRef: thin.selection.reference, expectedDigest: thin.digest }), error => error.status === 409);
  const view = await service.analysis(user, project.id, { viewId: 'V05', metricId: 'M-15', round: 'quality-r', engines: ['deepseek', 'kimi'] });
  const full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
  const native = await service.runtimeRead(project, 'analysis', { ...view.view, selectionRef: view.selection.reference, expectedDigest: view.digest });
  assert.deepEqual(native.rows, full.rows); assert.deepEqual(native.chart, full.chart);
  for (const cell of full.chart.cells) {
    assert.equal(cell.groupName, 'Risk group · 原始分类'); assert.equal(cell.setVersion, 11); assert.equal(cell.pool, 'P4');
    const row = full.rows.find(row => row.key === cell.rowKey), value = row.values[cell.columnKey];
    assert.equal(cell.reason, value.reason); assert.equal(cell.unit, value.unit); assert.equal(cell.value, value.value); assert.deepEqual(cell.members, value.members);
    const members = await service.analysisMembers(user, project.id, { ...cell.members.view, selectionRef: cell.members.selectionRef, rowKey: cell.rowKey, columnKey: cell.columnKey, expectedDigest: full.digest, limit: 50 });
    assert.deepEqual(members.items.map(item => item.id).sort(), cell.engine === 'deepseek' ? questions.map(question => `answer-${question.id}`).sort() : []);
  }
  const document = freezeGeoAnalysisDocument(full);
  assert.deepEqual(document.cover.analysis.chart, full.chart);
  assert.ok(document.typedTable.rows.every(row => JSON.parse(row.dimensions).groupName === 'Risk group · 原始分类' && JSON.parse(row.dimensions).pool === 'P4'));
  const requests = [];
  await service.selectedExport(user, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { requests.push(args); return { id: 'quality-export' }; } });
  assert.deepEqual(requests[0][1].typedTable, document.typedTable); assert.equal(requests[0][1].revision, view.digest);
});
