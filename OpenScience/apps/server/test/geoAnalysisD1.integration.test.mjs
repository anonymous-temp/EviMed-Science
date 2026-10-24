import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, opts = { skip: !url && 'Disposable local Postgres required' };
const user = { id: 'd1-owner' }, citations = Array.from({ length: 251 }, (_, n) => ({ url: `https://news.example/s?id=${n + 1}`, domain: 'news.example' }));
let isolated, database, store, service, project, selectionRef;
before(async () => {
    if (!url)
        return;
    isolated = await createGeoTestDatabase(url, 'geod1');
    database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
    store = new GeoStore({ database });
    await new GeoMeasureStore(database).ready();
    await store.ready();
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'D1','development'),('d1-viewer','Viewer','development')", [user.id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d1-control','D1',1048576)", [user.id]);
    project = await store.createProject({ userId: user.id, projectId: 'd1-control', engines: ['deepseek'], coverageDays: 90, product: { brandName: 'Alpha' } });
    service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
    await store.addMember({ geoId: project.id, userId: 'd1-viewer', role: 'viewer', invitedBy: user.id });
    await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('d1-g',$1,$2,1,'P2','Group')", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured,original_id) VALUES('d1-q',$1,$2,'d1-g',1,'P2','Original question?',true,'001')", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.sources(id,user_id,geo_project_id,domain,name,kind,layer) VALUES('d1-source',$1,$2,'news.example','News','news','owned')", [user.id, project.id]);
    for (const id of ['d1-refused', 'd1-linkless'])
        await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES($1,$2,$3,'d1-g',1,'P2','Other question?',true)", [id, user.id, project.id]);
    for (const round of ['d1-r1', 'd1-r2'])
        await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'baseline','done',1,'{deepseek}','2026-10-01','{\"mode\":\"web\"}')", [round, user.id, project.id]);
    for (const [id, round, links, askedAt, status] of [['d1-a', 'd1-r1', citations, '2026-10-01', 'valid'], ['d1-b', 'd1-r2', [citations[250], { url: 'http://www.news.example/s?id=251#alias', domain: 'news.example' }, { url: 'https://unknown.example/a', domain: 'unknown.example' }], null, 'valid'], ['d1-refused', 'd1-r1', [], '2026-10-01', 'refusal'], ['d1-linkless', 'd1-r1', [{ domain: 'hidden.example' }], '2026-10-01', 'valid']]) {
        await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations) VALUES($1,$2,$3,$4,$5,'deepseek',$6,$7,$8,'{\"mode\":\"web\"}',$9::jsonb)", [id, user.id, project.id, round, ['d1-refused', 'd1-linkless'].includes(id) ? id : 'd1-q', askedAt, status, `Original answer ${id}`, JSON.stringify(links)]);
        await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,mentions_ours,failure_mode,statements,checks) VALUES($1,$2,$3,'2026-10-02',true,'wrong_ours','[{\"text\":\"Preserved partial\",\"verdict\":\"wrong\"}]','{\"judgementCoverage\":{\"status\":\"partial\"}}')", [id, user.id, project.id]);
    }
    selectionRef = (await readGeoSelection(store, project, {}, { history: true })).selection.reference;
});
after(async () => { await database?.close(); await isolated?.drop(); });
test('D1 actual selected sources, exact paginated members, current catalogue context and five export contract', opts, async () => {
    const view = await service.analysis(user, project.id, { selectionRef, viewId: 'V18', sourceLevel: 'page', limit: 50 }), full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    assert.equal(full.rows.length, 252);
    assert.equal(full.rows[0].dimensions.sourceKey, 'news.example/s?id=251');
    assert.equal(full.rows[0].values.answers.value, 2);
    assert.equal(full.rows[0].values.unknownTime.value, 1);
    const domain = await service.analysis(user, project.id, { selectionRef: view.selection.reference, viewId: 'V18' }), news = domain.rows.find(row => row.dimensions.domain === 'news.example'), ref = news.values.pages.members;
    const all = [];
    for (let offset = 0; offset < ref.total; offset += 50) {
        const page = await service.analysisMembers(user, project.id, { selectionRef: ref.selectionRef, ...ref.view, rowKey: ref.rowKey, columnKey: ref.columnKey, expectedDigest: ref.expectedDigest, offset, limit: 50 });
        all.push(...page.items);
    }
    assert.equal(all.length, 251);
    assert.equal(new Set(all.map(item => item.source.sourceKey)).size, 251);
    assert.ok(all.every(item => item.citingAnswers.every(answer => answer.answer.answer_text.startsWith('Original answer') && answer.question.text === 'Original question?' && answer.judgment)));
    assert.equal((await service.source(user, project.id, 'd1-source', { selectionRef: view.selection.reference })).pages.length, 251);
    const list = await service.sources(user, project.id, { selectionRef: view.selection.reference });
    assert.equal(list.summary.urls.filter(page => page.domain === 'news.example').length, 251);
    assert.equal((await service.analysis({ id: 'd1-viewer' }, project.id, { selectionRef: view.selection.reference, ...view.view })).digest, view.digest);
    await assert.rejects(service.analysis({ id: 'stranger' }, project.id, { viewId: 'V18' }), error => error.status === 404);
    await assert.rejects(service.analysisMembers(user, project.id, { selectionRef: ref.selectionRef, ...ref.view, rowKey: 'outside', columnKey: ref.columnKey, expectedDigest: ref.expectedDigest }), error => error.status === 404);
    await assert.rejects(service.analysis(user, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: 'f'.repeat(64) }), error => error.status === 409);
    const {createGeoRoutes}=await import('../src/geoRoutes.mjs');
    const routes=createGeoRoutes({store:{ensureSessionUser:async()=>({user}),assertCsrf:async()=>{}},service,config:{geoEnabled:true,geoAudience:'all'},maxJsonBytes:65536});
    const response={body:'',writeHead(){},end(value){this.body=String(value);}};
    await routes({method:'GET',headers:{},url:`/api/geo/projects/${project.id}/analysis?selectionRef=${view.selection.reference}&viewId=V18&sourceLevel=page&sourceType=news&sourceRelationship=wrong&sourceSearch=id%3D251&topN=15`},response);
    const http=JSON.parse(response.body).data;assert.equal(http.rows.length,1);assert.equal(http.rows[0].values.answers.value,2);assert.equal(http.view.topN,15);assert.equal(http.view.sourceSearch,'id=251');
    const calls = [];
    await service.selectedExport(user, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { calls.push(args); return { id: 'd1-export' }; } });
    assert.equal(calls[0][1].typedTable.rows.length, 252);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d1-other-control','Other',1048576)", [user.id]);
    const other = await store.createProject({ userId: user.id, projectId: 'd1-other-control', engines: ['deepseek'], coverageDays: 90, product: { brandName: 'Other' } });
    await assert.rejects(service.analysis(user, other.id, { selectionRef: view.selection.reference, viewId: 'V18' }), error => error.status === 404);
    await assert.rejects(service.selectedExport({ id: 'd1-viewer' }, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest }, { requestFrozen: async () => assert.fail() }), error => error.status === 403);
    if (process.env.GEO_D1_RECEIPTS_DIR) {
        await mkdir(process.env.GEO_D1_RECEIPTS_DIR, { recursive: true });
        await writeFile(`${process.env.GEO_D1_RECEIPTS_DIR}/document.json`, JSON.stringify({ ...freezeGeoAnalysisDocument(full), version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: view.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
    }
});
test('D1 frozen native rows retain exact member identity, immutable values and selected source filters', opts, async () => {
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => { }, runs: async () => [] });
    service.planContexts = adapter;
    const view = await service.analysis(user, project.id, { selectionRef, viewId: 'V18', sourceLevel: 'page', sourceRelationship: 'wrong' }), full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    const staged = await adapter.stage(user, project.id, { requestKey: 'd1-sources', sessionId: 'd1-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'explain' });
    assert.ok(staged.draft);
    await assert.rejects(service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId }), error => error.status === 404);
    const request = { requestId: 'd1-request', sessionId: 'd1-session', content: [{ type: 'text', text: 'Explain selected sources.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await adapter.prepare(user, { id: project.projectId, userId: user.id }, request);
    await adapter.bind(user, { id: project.projectId, userId: user.id }, request);
    const native = [];
    for (let offset = 0; offset < full.rows.length; offset += 50)
        native.push(...(await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, offset, limit: 50 })).rows);
    assert.deepEqual(native, full.rows);
    await store.query("UPDATE evimed_geo.sources SET kind='academic' WHERE id='d1-source'");
    await assert.rejects(service.analysis(user, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest }), error => error.status === 409);
    await store.query("UPDATE evimed_geo.snapshots SET answer_text='Changed' WHERE id='d1-a'");
    assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 50 })).rows, full.rows.slice(0, 50));
    await assert.rejects(service.analysis(user, project.id, { selectionRef: view.selection.reference, ...view.view }), error => error.status === 409);
});

test('D1 catalogue source 2001 keeps exact type, identity, detail action and revision invalidation',opts,async()=>{
 await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d1-catalogue-control','Catalogue',1048576)",[user.id]);
 const catalogueProject=await store.createProject({userId:user.id,projectId:'d1-catalogue-control',engines:['deepseek'],coverageDays:90,product:{brandName:'Alpha'}});
 await store.query("INSERT INTO evimed_geo.sources(id,user_id,geo_project_id,domain,name,kind) SELECT 'd1-cat-'||n::text,$1,$2,'d'||lpad(n::text,4,'0')||'.example','Source '||n::text,'news' FROM generate_series(1,2001) AS n",[user.id,catalogueProject.id]);
 await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('d1-cat-g',$1,$2,1,'P2','Catalogue')",[user.id,catalogueProject.id]);
 await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES('d1-cat-q',$1,$2,'d1-cat-g',1,'P2','Question?',true)",[user.id,catalogueProject.id]);
 await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('d1-cat-r',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01','{\"mode\":\"web\"}')",[user.id,catalogueProject.id]);
 const links=[{url:'https://www.d2001.example/page',domain:'www.d2001.example'},{url:'https://child.d2001.example/page',domain:'child.d2001.example'}];
 await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface,citations) VALUES('d1-cat-a',$1,$2,'d1-cat-r','d1-cat-q','deepseek','2026-10-01','valid','Original catalogue answer','{\"mode\":\"web\"}',$3::jsonb)",[user.id,catalogueProject.id,JSON.stringify(links)]);
 const view=await service.analysis(user,catalogueProject.id,{round:'d1-cat-r',viewId:'V18',sourceLevel:'page'}),tail=view.rows.find(row=>row.dimensions.domain==='d2001.example');
 assert.equal(tail.dimensions.sourceType,'news');assert.equal(tail.dimensions.sourceId,'d1-cat-2001');
 assert.equal(view.rows.find(row=>row.dimensions.domain==='child.d2001.example').dimensions.sourceType,'unknown','a parent catalogue domain must not absorb a different subdomain');
 const exact={selectionRef:view.selection.reference,viewId:'V18',sourceLevel:'page'};
 const filtered=await service.analysis(user,catalogueProject.id,{...exact,sourceType:'news'});assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].dimensions.sourceId,'d1-cat-2001');
 assert.equal((await service.source(user,catalogueProject.id,tail.dimensions.sourceId,{selectionRef:view.selection.reference})).pages[0].url,'https://www.d2001.example/page');
 assert.equal((await store.listSources(catalogueProject.id)).length,2000,'existing catalogue list callers keep their bounded behaviour');
 await store.query("UPDATE evimed_geo.sources SET kind='academic',name='Updated source' WHERE id='d1-cat-2001'");
 await assert.rejects(service.analysis(user,catalogueProject.id,{...exact,expectedDigest:view.digest}),error=>error.status===409);
 const renamed=await service.analysis(user,catalogueProject.id,{...exact,sourceType:'academic',sourceSearch:'Updated source'});assert.equal(renamed.rows.length,1);assert.equal(renamed.rows[0].dimensions.sourceId,'d1-cat-2001');
 await assert.rejects(service.analysis(user,project.id,{...exact}),error=>error.status===404);
 if(process.env.GEO_D1_RECEIPTS_DIR)await writeFile(`${process.env.GEO_D1_RECEIPTS_DIR}/catalogue-2001.json`,JSON.stringify({before:view,after:renamed},null,2));
});
