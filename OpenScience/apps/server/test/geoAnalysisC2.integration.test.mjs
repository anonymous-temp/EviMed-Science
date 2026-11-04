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
        await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version) SELECT $1||'-'||n,$2,$3,$4::date,jsonb_build_array(jsonb_build_object('name','Ours','ours',true,'count',CASE WHEN $1='now' AND n<=10 THEN 1 ELSE 0 END),jsonb_build_object('name','Rival','competitor',true,'count',CASE WHEN n<=20 THEN 1 ELSE 0 END)),$1='now' AND n<=10,'{\"judgementCoverage\":{\"status\":\"complete\"}}','{\"rubricVersion\":\"fixture-v1\"}',$5,'geo-parser-test' FROM generate_series(1,50)n", [round, user.id, project.id, date, registryKey(brandRegistry(product, competitors), basis.owned)]);
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

async function addReviewRound({ id, date, evaluationBasis = basis, refusals = 0, ownPositive = 10, rivalPositive = 20 }) {
    await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface,ref) VALUES($1,$2,$3,'baseline','done',1,'{deepseek}',$4::date,$5::jsonb,$6::jsonb)", [id, user.id, project.id, date, JSON.stringify({ mode: 'web', measurementContract: { samplingMode: 'legacy_recurring', repeats: 1, metricIds: ['M-01', 'M-16', 'M-17'], sourceBasis: 'answers' } }), JSON.stringify({ evaluationBasis })]);
    await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) SELECT $1||'-'||n,$2,$3,$1,'q'||n,'deepseek',$4::date,CASE WHEN n>50 THEN 'refusal' ELSE 'valid' END,CASE WHEN n>50 THEN 'Refused' ELSE 'Retained answer '||n END,'{\"mode\":\"web\"}' FROM generate_series(1,$5::integer)n", [id, user.id, project.id, date, 50 + refusals]);
    await store.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version) SELECT $1||'-'||n,$2,$3,$4::date,jsonb_build_array(jsonb_build_object('name','Ours','ours',true,'count',CASE WHEN n<=$5 THEN 1 ELSE 0 END)) || CASE WHEN $6::boolean THEN jsonb_build_array(jsonb_build_object('name','Rival','competitor',true,'count',CASE WHEN n<=$7 THEN 1 ELSE 0 END)) ELSE '[]'::jsonb END,n<=$5,'{\"judgementCoverage\":{\"status\":\"complete\"}}','{\"rubricVersion\":\"fixture-v1\"}',$8,'geo-parse-2' FROM generate_series(1,50)n", [id, user.id, project.id, date, ownPositive, evaluationBasis.competitors.length > 0, rivalPositive, registryKey(brandRegistry(evaluationBasis.product, evaluationBasis.competitors), evaluationBasis.owned)]);
}
async function freezeReviewSelection(full, receiptName) {
    const { GeoPlanContext } = await import('../src/geoPlanContext.mjs'), { ProductDocuments } = await import('../src/productStore.mjs');
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => {}, runs: async () => [] });
    service.planContexts = adapter;
    const staged = await adapter.stage(user, project.id, { requestKey: receiptName, sessionId: 'review-session', mode: 'analysis', selectionRef: full.selection.reference, view: full.view, expectedDigest: full.digest, intent: 'compare' });
    await adapter.bind(user, { id: project.projectId, userId: project.userId }, { requestId: receiptName, sessionId: 'review-session', content: [{ type: 'text', text: 'Explain the exact registered competitor comparison.' }], geoPlanContext: { referenceId: staged.referenceId } });
    const native = await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId });
    assert.deepEqual(native.rows, full.rows);
    assert.deepEqual(native.chart, full.chart);
    const report = freezeGeoAnalysisDocument(full);
    assert.deepEqual(report.cover.analysis.rows, full.rows);
    assert.deepEqual(report.cover.analysis.chart, full.chart);
    if (process.env.GEO_C2_REVIEW_RECEIPTS_DIR) {
        const directory = `${process.env.GEO_C2_REVIEW_RECEIPTS_DIR}/${receiptName}`;
        await mkdir(directory, { recursive: true });
        await writeFile(`${directory}/document.json`, JSON.stringify({ ...report, version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: full.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
    }
}

test('C2 review F1 includes frozen-registry refusals in actual M16 members, export and native input', opts, async () => {
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) SELECT 'q'||n,$1,$2,'g',1,'P2','Question '||n,true FROM generate_series(51,100)n", [user.id, project.id]);
    await addReviewRound({ id: 'refusal', date: '2026-10-03', refusals: 50 });
    const { readGeoSelection } = await import('../src/geoReadScope.mjs');
    const input = { round: 'refusal', viewId: 'V08', metricId: 'M-16', timeGrain: 'round' }, selected = await readGeoSelection(store, project, { round: 'refusal' });
    const domain = selected.computed.cells.find(cell => cell.metricId === 'M-16' && cell.scope === 'pool' && cell.pool === 'P2' && cell.rival === 'Rival');
    assert.equal(domain.numerator, 20);
    assert.equal(domain.denominator, 100);
    const full = await freezeSelectedGeoAnalysis(store, project, input), rival = full.rows.find(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'selected');
    assert.equal(rival.values.current.value, domain.value);
    assert.equal(rival.values.current.metric.denominator, 100);
    assert.equal(rival.values.eligible.value, 100);
    assert.equal(rival.values.unknown.value, 0);
    for (const columnKey of ['current', 'pairedOwn']) {
        const member = rival.values[columnKey].members;
        const pages = await Promise.all([0, 20, 40, 60, 80].map(offset => service.analysisMembers(user, project.id, { selectionRef: member.selectionRef, ...member.view, rowKey: member.rowKey, columnKey, expectedDigest: member.expectedDigest, limit: 20, offset })));
        const items = pages.flatMap(page => page.items);
        assert.deepEqual(items.map(item => item.snapshotId).sort(), Array.from({ length: 100 }, (_, index) => `refusal-${index + 1}`).sort());
        assert.equal(items.filter(item => item.status === 'refusal').length, 50);
    }
    await freezeReviewSelection(full, 'V08-refusal');
});

test('C2 review F2 actual registry expansion charts and members use the exact paired own cohort', opts, async () => {
    await addReviewRound({ id: 'own-only', date: '2026-10-04', evaluationBasis: { product, competitors: [], owned: basis.owned }, ownPositive: 50 });
    await addReviewRound({ id: 'expanded', date: '2026-10-05' });
    const full = await freezeSelectedGeoAnalysis(store, project, { from: '2026-10-04', to: '2026-10-05', viewId: 'V08', metricId: 'M-16', timeGrain: 'day' });
    const rival = full.rows.find(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'selected');
    assert.equal(full.rows.find(row => row.dimensions.own && row.dimensions.period === 'selected').values.current.value, 60);
    assert.equal(rival.values.current.value, 40);
    assert.equal(rival.values.pairedOwn.value, 20);
    assert.deepEqual(full.chart.cells.map(cell => [cell.rowKey, cell.columnKey, cell.value]), [[rival.key, 'pairedOwn', 20], [rival.key, 'current', 40]]);
    const ownSeries = full.chart.series.find(series => series.own), rivalSeries = full.chart.series.find(series => !series.own);
    assert.equal(ownSeries.comparisonKey, rivalSeries.comparisonKey);
    assert.deepEqual(ownSeries.values, [null, 20]);
    assert.deepEqual(rivalSeries.values, [null, 40]);
    for (const cell of full.chart.cells) {
        const member = cell.members;
        const page = await service.analysisMembers(user, project.id, { selectionRef: member.selectionRef, ...member.view, rowKey: member.rowKey, columnKey: member.columnKey, expectedDigest: member.expectedDigest, limit: 50 });
        assert.deepEqual(page.items.map(item => item.snapshotId).sort(), Array.from({ length: 50 }, (_, index) => `expanded-${index + 1}`).sort());
    }
    await freezeReviewSelection(full, 'V08-registry-expansion');
});

test('C2 sampling surfaces fence comparison and trend while preserving observations', opts, async () => {
    const { readGeoSelection } = await import('../src/geoReadScope.mjs');
    const base = { mode: 'web', deep: false, newChat: true, city: 'Beijing' };
    const range = { from: '2026-10-02', to: '2026-10-02', compareFrom: '2026-10-01', compareTo: '2026-10-01' };
    const observe = async () => {
        const selection = await readGeoSelection(store, project, range);
        const view = await service.analysis(user, project.id, { ...range, viewId: 'V03', metricId: 'M-01', dimension: 'engine' });
        const trend = await service.analysis(user, project.id, { viewId: 'V08', metricId: 'M-16', timeGrain: 'round', from: '2026-10-01', to: '2026-10-02' });
        return { selection, view, trend };
    };
    try {
        await store.query("UPDATE evimed_geo.snapshots SET surface=$1::jsonb WHERE round_id IN ('old','now')", [JSON.stringify(base)]);
        let result = await observe();
        assert.equal(result.view.rows[0].values.delta.value, 20);
        assert.equal(result.view.rows[0].values.rank.value, 1);
        assert.equal(result.trend.rows.find(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'round').dimensions.trendComparable, true);
        for (const [field, value] of [['deep', true], ['newChat', false], ['city', 'Shanghai']]) {
            await store.query("UPDATE evimed_geo.snapshots SET surface=$1::jsonb WHERE round_id='now'", [JSON.stringify({ ...base, [field]: value })]);
            result = await observe();
            const row = result.view.rows.find(row => row.dimensions.engine === 'deepseek');
            assert.deepEqual([row.values.previous.value, row.values.current.value], [0, 20], `${field}: preserve observed values`);
            assert.deepEqual([row.values.delta.value, row.values.rank.value], [null, null], `${field}: no comparison or ranking`);
            assert.equal(result.selection.comparison.comparable, false);
            assert.equal(result.selection.comparison.commonQuestionEngineModes, 0);
            const points = result.trend.rows.filter(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'round');
            assert.deepEqual(points.map(point => point.values.current.value), [40, 40]);
            assert.ok(points.every(point => point.dimensions.trendComparable === false));
            assert.ok(result.trend.chart.series.every(series => series.values.every(value => value === null)));
        }
        await store.query("UPDATE evimed_geo.snapshots SET surface=$1::jsonb WHERE round_id='now'", [JSON.stringify({ ...base, transport: 'other', responseDigest: 'not-a-sampling-field' })]);
        result = await observe();
        assert.equal(result.view.rows[0].values.delta.value, 20, 'transport metadata does not change sampling');
        assert.equal(result.view.rows[0].values.rank.value, 1);
        assert.equal(result.trend.rows.find(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'round').dimensions.trendComparable, true);
        const { geoMetricInputCoverage } = await import('../src/geoComparison.mjs');
        const oneRound = () => readGeoSelection(store, project, { round: 'now' });
        const beforeMetadata = await oneRound();
        const metricOf = selected => selected.computed.cells.find(cell => cell.metricId === 'M-01' && cell.scope === 'engine' && cell.engine === 'deepseek' && !cell.variant && !cell.rival);
        const coverageBefore = geoMetricInputCoverage(beforeMetadata, metricOf(beforeMetadata), 1);
        assert.ok(coverageBefore);
        await store.query("UPDATE evimed_geo.snapshots SET surface=surface || '{\"transport\":\"different-within-round\"}'::jsonb WHERE id='now-1'");
        const afterMetadata = await oneRound();
        assert.equal(afterMetadata.selection.coverage, beforeMetadata.selection.coverage);
        assert.equal(geoMetricInputCoverage(afterMetadata, metricOf(afterMetadata), 1), coverageBefore);
        await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
          SELECT 'now-q1-extra',user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text, surface || '{"deep":true}'::jsonb FROM evimed_geo.snapshots WHERE id='now-1'`);
        await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version)
          SELECT 'now-q1-extra',user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version FROM evimed_geo.facts WHERE snapshot_id='now-1'`);
        result = await observe();
        assert.equal(result.selection.comparison.currentSelection.counts.snapshots, 50, 'same question with an unmatched surface is not mixed into the common cohort');
        const saved = await readGeoSelection(store, project, { selectionRef: result.selection.comparison.currentSelection.reference });
        assert.equal(saved.rows.length, 50); assert.ok(saved.rows.every(row => row.snapshotId !== 'now-q1-extra'));
        const empty = await readGeoSelection(store, project, { round: 'now' }, { subset: { snapshotIds: [], eligibleOnly: true } });
        assert.equal(empty.rows.length, 0, 'an empty explicit snapshot subset cannot become the whole project');
        const emptyReplay = await readGeoSelection(store, project, { selectionRef: empty.selection.reference });
        assert.equal(emptyReplay.rows.length, 0);
        const foreign = await readGeoSelection(store, project, { round: 'now' }, { subset: { snapshotIds: ['not-a-project-snapshot'], eligibleOnly: true } });
        assert.equal(foreign.rows.length, 0);
        const legacy = await readGeoSelection(store, project, { round: 'now' }, { subset: { keys: [JSON.stringify(['q1','deepseek','web'])], eligibleOnly: true } });
        const replay = await readGeoSelection(store, project, { selectionRef: legacy.selection.reference });
        assert.deepEqual(replay.rows.map(row => row.snapshotId).sort(), legacy.rows.map(row => row.snapshotId).sort(), 'old mode-only subset stays readable without broadening');
        await store.query("DELETE FROM evimed_geo.facts WHERE snapshot_id='now-q1-extra'");
        await store.query("DELETE FROM evimed_geo.snapshots WHERE id='now-q1-extra'");
        await store.query("UPDATE evimed_geo.facts SET mentions_ours=false, brands=jsonb_set(brands,'{0,count}','0') WHERE snapshot_id LIKE 'now-%'");
        result = await observe();
        assert.equal(result.view.rows[0].values.delta.value, 0, 'equal observations remain a comparable zero');
        assert.equal(result.view.rows[0].values.rank.value, 1);
    } finally {
        await store.query("UPDATE evimed_geo.snapshots SET surface='{\"mode\":\"web\"}'::jsonb WHERE round_id IN ('old','now')");
        await store.query("UPDATE evimed_geo.facts SET mentions_ours=(substring(snapshot_id from '([0-9]+)$')::int<=10), brands=jsonb_set(brands,'{0,count}',to_jsonb(CASE WHEN substring(snapshot_id from '([0-9]+)$')::int<=10 THEN 1 ELSE 0 END)) WHERE snapshot_id LIKE 'now-%'");
    }
});

test('C2 engines can use different stable sampling surfaces', opts, async () => {
    const scope = { from: '2026-10-02', to: '2026-10-02', compareFrom: '2026-10-01', compareTo: '2026-10-01' };
    try {
        await store.query("UPDATE evimed_geo.rounds SET engines='{deepseek,kimi}' WHERE id IN ('old','now')");
        await store.query("UPDATE evimed_geo.snapshots SET surface='{\"mode\":\"web\",\"deep\":false,\"newChat\":true,\"city\":\"Beijing\"}' WHERE round_id IN ('old','now')");
        await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
          SELECT id||'-kimi',user_id,geo_project_id,round_id,question_id,'kimi',asked_at,status,answer_text,'{"mode":"web","deep":true,"newChat":false,"city":"Shanghai"}'::jsonb
          FROM evimed_geo.snapshots WHERE round_id IN ('old','now') AND engine='deepseek'`);
        await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version)
          SELECT snapshot_id||'-kimi',user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version
          FROM evimed_geo.facts WHERE snapshot_id ~ '^(old|now)-[0-9]+$'`);
        let view = await service.analysis(user, project.id, { ...scope, viewId: 'V03', metricId: 'M-01', dimension: 'engine' });
        assert.deepEqual(view.rows.map(row => [row.dimensions.engine, row.values.delta.value]).sort(), [['deepseek',20],['kimi',20]]);
        let trend = await service.analysis(user, project.id, { viewId: 'V08', metricId: 'M-16', timeGrain: 'round', from: '2026-10-01', to: '2026-10-02' });
        assert.ok(trend.rows.filter(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'round').every(row => row.dimensions.trendComparable === true));
        await store.query("UPDATE evimed_geo.snapshots SET surface=jsonb_set(surface,'{deep}','false'::jsonb) WHERE round_id='now' AND engine='kimi'");
        view = await service.analysis(user, project.id, { ...scope, viewId: 'V03', metricId: 'M-01', dimension: 'engine' });
        const kimi = view.rows.find(row => row.dimensions.engine === 'kimi');
        assert.deepEqual([kimi.values.previous.value, kimi.values.current.value, kimi.values.delta.value, kimi.values.rank.value], [0,20,null,null]);
        for (const period of ['previous', 'current']) {
            const member = kimi.values[period].members;
            const page = await service.analysisMembers(user, project.id, { selectionRef: member.selectionRef, ...member.view,
                rowKey: member.rowKey, columnKey: member.columnKey, expectedDigest: member.expectedDigest, limit: 50, offset: 0 });
            assert.equal(page.items.length, 50);
            assert.ok(page.items.every(item => item.engine === 'kimi'), `${period}: members use that period's observations`);
        }
        assert.equal(view.rows.find(row => row.dimensions.engine === 'deepseek').values.delta.value, 20);
        trend = await service.analysis(user, project.id, { viewId: 'V08', metricId: 'M-16', timeGrain: 'round', from: '2026-10-01', to: '2026-10-02' });
        assert.ok(trend.rows.filter(row => row.dimensions.entityKey === 'fixed-rival' && row.dimensions.period === 'round').every(row => row.dimensions.trendComparable === false));
    } finally {
        await store.query("DELETE FROM evimed_geo.facts WHERE snapshot_id LIKE '%-kimi'");
        await store.query("DELETE FROM evimed_geo.snapshots WHERE id LIKE '%-kimi'");
        await store.query("UPDATE evimed_geo.rounds SET engines='{deepseek}' WHERE id IN ('old','now')");
        await store.query("UPDATE evimed_geo.snapshots SET surface='{\"mode\":\"web\"}' WHERE round_id IN ('old','now')");
    }
});

test('C2 retains unmatched group observations and member provenance beside a comparable group', opts, async () => {
    const scope = { from: '2026-10-02', to: '2026-10-02', compareFrom: '2026-10-01', compareTo: '2026-10-01' };
    try {
        await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('other-group',$1,$2,1,'P2','Other')", [user.id, project.id]);
        await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) SELECT 'other-q'||n,$1,$2,'other-group',1,'P2','Other '||n,true FROM generate_series(1,40)n", [user.id, project.id]);
        for (const [round, date] of [['old','2026-10-01'],['now','2026-10-02']]) {
            await store.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface)
              SELECT $1||'-other-'||n,$2,$3,$1,'other-q'||n,'deepseek',$4::date,'valid','Other answer','{"mode":"web","deep":false}'::jsonb FROM generate_series(1,40)n`, [round,user.id,project.id,date]);
            await store.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,judged_at,brands,mentions_ours,checks,judge_extract,registry_key,parser_version)
              SELECT $1||'-other-'||n,$2,$3,$4::date,jsonb_build_array(jsonb_build_object('name','Ours','ours',true,'count',CASE WHEN $1='now' AND n<=20 THEN 1 ELSE 0 END)),
                $1='now' AND n<=20,'{"judgementCoverage":{"status":"complete"}}','{"rubricVersion":"fixture-v1"}',$5,'geo-parser-test' FROM generate_series(1,40)n`, [round,user.id,project.id,date,registryKey(brandRegistry(product,competitors),basis.owned)]);
        }
        await store.query("UPDATE evimed_geo.snapshots SET surface=jsonb_set(surface,'{deep}','true'::jsonb) WHERE round_id='now' AND question_id LIKE 'other-q%'");
        const view = await service.analysis(user, project.id, { ...scope, viewId:'V03', metricId:'M-01', dimension:'group' });
        const comparable = view.rows.find(row => row.dimensions.groupId === 'g');
        const unmatched = view.rows.find(row => row.dimensions.groupId === 'other-group');
        assert.equal(comparable.values.delta.value, 20);
        assert.deepEqual([unmatched.values.previous.value, unmatched.values.current.value, unmatched.values.delta.value, unmatched.values.rank.value], [0,50,null,null]);
        for (const period of ['previous','current']) {
            const member = unmatched.values[period].members;
            const page = await service.analysisMembers(user,project.id,{selectionRef:member.selectionRef,...member.view,rowKey:member.rowKey,columnKey:member.columnKey,expectedDigest:member.expectedDigest,limit:50,offset:0});
            assert.equal(page.items.length,40);
            assert.ok(page.items.every(item => item.questionId.startsWith('other-q')));
        }
    } finally {
        await store.query("DELETE FROM evimed_geo.facts WHERE snapshot_id LIKE '%-other-%'");
        await store.query("DELETE FROM evimed_geo.snapshots WHERE id LIKE '%-other-%'");
        await store.query("DELETE FROM evimed_geo.questions WHERE group_id='other-group'");
        await store.query("DELETE FROM evimed_geo.question_groups WHERE id='other-group'");
    }
});
