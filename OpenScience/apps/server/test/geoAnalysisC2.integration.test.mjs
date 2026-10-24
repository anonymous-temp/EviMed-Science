import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { brandRegistry, registryKey } from '../src/geoParse.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, opts = { skip: !url && 'Postgres URL is not configured' };
let isolated, database, store, service, project;
const user = { id: 'c2-owner' }, product = { brandName: 'Ours' }, competitors = [{ id: 'fixed-rival', brandName: 'Rival', aliases: ['Alias'] }], basis = { product, competitors, owned: { domains: [], urls: [] } };
before(async () => {
    if (!url)
        return;
    isolated = await createGeoTestDatabase(url, 'geoc2');
    database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
    store = new GeoStore({ database });
    const measure = new GeoMeasureStore(database);
    await measure.ready();
    await store.ready();
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'C2','development'),('c2-viewer','Viewer','development')", [user.id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'c2-project','C2',1048576)", [user.id]);
    project = await store.createProject({ userId: user.id, projectId: 'c2-project', engines: ['deepseek'], coverageDays: 90, product, competitors });
    await store.query('UPDATE evimed_geo.projects SET competitors=$2::jsonb WHERE id=$1', [project.id, JSON.stringify(competitors)]);
    project = await store.getProject(user.id, project.id);
    service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
    await store.addMember({ geoId: project.id, userId: 'c2-viewer', role: 'viewer', invitedBy: user.id });
    await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('g',$1,$2,1,'P2','Fixed')", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) SELECT 'q'||n,$1,$2,'g',1,'P2','Question '||n,true FROM generate_series(1,50)n", [user.id, project.id]);
    for (const [round, date] of [['old', '2026-10-01'], ['now', '2026-10-02']]) {
        await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface,ref) VALUES($1,$2,$3,'baseline','done',1,'{deepseek}',$4::date,$5::jsonb,$6::jsonb)", [round, user.id, project.id, date, JSON.stringify({ mode: 'web', measurementContract: { samplingMode: 'legacy_recurring', repeats: 1, metricIds: ['M-01', 'M-16', 'M-17'], sourceBasis: 'answers' } }), JSON.stringify({ evaluationBasis: basis })]);
        await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) SELECT $1||'-'||n,$2,$3,$1,'q'||n,'deepseek',$4::date,'valid','Exact original answer '||n,'{\"mode\":\"web\"}' FROM generate_series(1,50)n", [round, user.id, project.id, date]);
        await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,registry_key,parser_version) SELECT $1||'-'||n,$2,$3,$4::date,jsonb_build_array(jsonb_build_object('name','Ours','ours',true,'count',CASE WHEN $1='now' AND n<=10 THEN 1 ELSE 0 END),jsonb_build_object('name','Rival','competitor',true,'count',CASE WHEN n<=20 THEN 1 ELSE 0 END)),$1='now' AND n<=10,'{\"judgementCoverage\":{\"status\":\"complete\"}}',$5,'geo-parser-test' FROM generate_series(1,50)n", [round, user.id, project.id, date, registryKey(brandRegistry(product, competitors), basis.owned)]);
    }
});
after(async () => { await database?.close(); await isolated?.drop(); });
test('C2 exact two-period members, frozen native context, read/export roles and actual export fixtures', opts, async () => {
    const { GeoPlanContext } = await import('../src/geoPlanContext.mjs'), { ProductDocuments } = await import('../src/productStore.mjs');
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => { }, runs: async () => [] });
    service.planContexts = adapter;
    for (const descriptor of [{ viewId: 'V03', metricId: 'M-01', dimension: 'engine' }, { viewId: 'V08', metricId: 'M-16', timeGrain: 'round' }, { viewId: 'V08', metricId: 'M-17', timeGrain: 'day' }]) {
        const input = { ...descriptor, from: '2026-10-02', to: '2026-10-02', compareFrom: '2026-10-01', compareTo: '2026-10-01' }, view = await service.analysis(user, project.id, input), full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
        assert.equal(full.digest, view.digest);
        assert.ok(full.rows.length);
        if (descriptor.viewId === 'V03') {
            const row = full.rows[0];
            assert.equal(row.values.delta.value, 20);
            for (const period of ['current', 'previous']) {
                const member = row.values[period].members;
                const pages = await Promise.all([0, 20, 40].map(offset => service.analysisMembers(user, project.id, { selectionRef: member.selectionRef, ...member.view, rowKey: member.rowKey, columnKey: member.columnKey, expectedDigest: member.expectedDigest, limit: 20, offset })));
                assert.deepEqual(pages.flatMap(page => page.items.map(item => item.snapshotId)).sort(), Array.from({ length: 50 }, (_, n) => `${period === 'current' ? 'now' : 'old'}-${n + 1}`).sort());
            }
        }
        else {
            const row = full.rows.find(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'selected');
            assert.equal(row.values.current.metric.denominator, descriptor.metricId === 'M-17' ? 30 : 50);
            assert.equal(row.values.current.metric.numerator, 20);
            assert.ok(full.rows.filter(row => row.dimensions.period !== 'selected').every(row => row.dimensions.date === '2026-10-02'));
        }
        const member = full.rows.find(row => row.values.current.members)?.values.current.members;
        await assert.rejects(service.analysisMembers(user, project.id, { selectionRef: member.selectionRef, ...member.view, rowKey: member.rowKey, columnKey: member.columnKey, expectedDigest: 'f'.repeat(64) }), error => error.status === 409);
        assert.equal((await service.analysis({ id: 'c2-viewer' }, project.id, { selectionRef: view.selection.reference, ...view.view })).digest, view.digest);
        await assert.rejects(service.selectedExport({ id: 'c2-viewer' }, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest }, { requestFrozen: async () => assert.fail() }), error => error.status === 403);
        await assert.rejects(service.analysis({ id: 'stranger' }, project.id, input), error => error.status === 404);
        const calls = [];
        await service.selectedExport(user, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { calls.push(args); return { id: 'c2' }; } });
        assert.equal(calls[0][1].revision, view.digest);
        const key = `${descriptor.viewId}-${descriptor.metricId}`, staged = await adapter.stage(user, project.id, { requestKey: key, sessionId: 'c2-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'explain' }), request = { requestId: key, sessionId: 'c2-session', content: [{ type: 'text', text: 'Explain selected observations.' }], geoPlanContext: { referenceId: staged.referenceId } };
        await adapter.bind(user, { id: project.projectId, userId: project.userId }, request);
        assert.equal(request.geoPlanContext, undefined);
        assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId })).rows, full.rows);
        if (process.env.GEO_C2_RECEIPTS_DIR) {
            const directory = `${process.env.GEO_C2_RECEIPTS_DIR}/${key}`;
            await mkdir(directory, { recursive: true });
            await writeFile(`${directory}/document.json`, JSON.stringify({ ...freezeGeoAnalysisDocument(full), version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: view.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
        }
    }
});
