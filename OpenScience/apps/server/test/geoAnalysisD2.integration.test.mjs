import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, opts = { skip: !url && 'Disposable local PostgreSQL required' }, user = { id: 'd2-owner' };
const complete = { schemaVersion: 1, capability: 'linked_list', complete: true }, link = { url: 'https://www.news.example/page?x=1', domain: 'wrong.example', marker: '[1]', position: 12 };
let isolated, database, store, measure, service, project;
before(async () => {
    if (!url)
        return;
    isolated = await createGeoTestDatabase(url, 'geod2');
    database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
    store = new GeoStore({ database });
    measure = new GeoMeasureStore(database);
    await measure.ready();
    await store.ready();
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'D2','development'),('d2-reader','Reader','development')", [user.id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d2-control','D2',1048576)", [user.id]);
    project = await store.createProject({ userId: user.id, projectId: 'd2-control', engines: ['deepseek', 'kimi'], coverageDays: 90, product: { brandName: 'Alpha' } });
    service = new GeoService({ store, config: { geoEnabled: true, geoAudience: 'all' } });
    await store.addMember({ geoId: project.id, userId: 'd2-reader', role: 'viewer', invitedBy: user.id });
    for (const version of [1, 2]) {
        await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES($1,$2,$3,$4,'P2','Same')", [`d2-g${version}`, user.id, project.id, version]);
        await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured,original_id) VALUES($1,$2,$3,$4,$5,'P2',$6,true,$7)", [`d2-q${version}`, user.id, project.id, `d2-g${version}`, version, `Original unjudged question ${version}?`, `00${version}`]);
    }
    await store.query("INSERT INTO evimed_geo.sources(id,user_id,geo_project_id,domain,name,kind,layer) VALUES('d2-source',$1,$2,'news.example','News','news','owned')", [user.id, project.id]);
    for (const n of [1, 2, 3, 4]) {
        const version = n === 4 ? 2 : 1, engine = n === 4 ? 'kimi' : 'deepseek';
        await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'baseline','done',$4,$5::text[],$6,'{\"mode\":\"web\"}')", [`d2-r${n}`, user.id, project.id, version, [engine], `2026-10-0${n}`]);
        await measure.insertSnapshot({ id: `d2-s${n}`, userId: user.id, geoProjectId: project.id, roundId: `d2-r${n}`, questionId: `d2-q${version}`, engine, askedAt: new Date(`2026-10-0${n}T00:00:00Z`), status: n === 2 ? 'refusal' : 'valid', answerText: `Original answer ${n}`, answerSha256: null, citations: n === 1 || n === 4 ? [link] : [], surface: { mode: 'web', ...(n === 3 ? { citationObservation: complete } : {}) }, screenshotSha256: null, latencyMs: null, warnings: [], probeJobId: null });
    }
});
after(async () => { await database?.close(); await isolated?.drop(); });
test('D2 actual insert/select preserves versioned completeness; member actions, reader isolation, frozen pages and five export requests keep exact selected identity', opts, async () => {
    const selected = await readGeoSelection(store, project, { from: '2026-10-01', to: '2026-10-04' });
    assert.deepEqual(selected.rows.find(row => row.snapshotId === 'd2-s3').surface.citationObservation, complete);
    const view = await service.analysis(user, project.id, { selectionRef: selected.selection.reference, viewId: 'V22' }), full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    const before = full.rows.find(row => row.dimensions.roundId === 'd2-r1' && row.dimensions.questionId === 'd2-q1'), unknown = full.rows.find(row => row.dimensions.roundId === 'd2-r2' && row.dimensions.questionId === 'd2-q1'), gone = full.rows.find(row => row.dimensions.roundId === 'd2-r3' && row.dimensions.questionId === 'd2-q1');
    assert.equal(before.values.observation.value, 'present');
    assert.equal(unknown.values.observation.value, null);
    assert.equal(gone.values.transition.value, 'no_longer_observed');
    assert.deepEqual(gone.dimensions.citationCompleteness, [{ snapshotId: 'd2-s3', declaration: complete }]);
    const members = await service.analysisMembers(user, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: gone.key, columnKey: 'transition' });
    assert.deepEqual(members.items.map(item => item.snapshotId), ['d2-s1', 'd2-s3']);
    assert.equal(members.items[0].question.text, 'Original unjudged question 1?');
    assert.equal(members.items[0].judgment, null);
    assert.deepEqual(members.items[0].source.pages[0].preservedCitations, [link]);
    assert.deepEqual(members.items[1].answer.surface.citationObservation, complete);
    for (const row of full.rows)
        for (const column of full.columns) {
            const memberPage = await service.analysisMembers({ id: 'd2-reader' }, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: row.key, columnKey: column.key });
            assert.equal(memberPage.total, row.values[column.key].members.total);
        }
    await assert.rejects(service.analysisMembers(user, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: 'outside', columnKey: 'observation' }), error => error.status === 404);
    await assert.rejects(service.analysis(user, project.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: '0'.repeat(64) }), error => error.status === 409);
    await assert.rejects(service.analysis({ id: 'outsider' }, project.id, { selectionRef: view.selection.reference, ...view.view }), error => error.status === 404);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d2-other','Other',1048576)", [user.id]);
    const other = await store.createProject({ userId: user.id, projectId: 'd2-other', engines: ['deepseek'], coverageDays: 90, product: {} });
    await assert.rejects(service.analysis(user, other.id, { selectionRef: view.selection.reference, ...view.view }), error => error.status === 404);
    const groups = await service.analysis(user, project.id, { selectionRef: view.selection.reference, viewId: 'V19', sourceFacet: 'group', sourceLevel: 'page' });
    assert.equal(groups.rows.length, 2);
    assert.deepEqual(groups.rows.map(row => row.dimensions.setVersion).sort(), [1, 2]);
    const requests = [];
    await service.selectedExport(user, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { requests.push(args); return { id: 'export' }; } });
    assert.equal(requests[0][1].typedTable.rows.length, full.rows.length);
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => { }, runs: async () => [] });
    service.planContexts = adapter;
    const staged = await adapter.stage(user, project.id, { requestKey: 'd2-history', sessionId: 'd2-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'explain' });
    assert.ok(staged.draft);
    await assert.rejects(service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId }), error => error.status === 404);
    const request = { requestId: 'd2-request', sessionId: 'd2-session', content: [{ type: 'text', text: 'Explain selected history.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await adapter.prepare(user, { id: project.projectId, userId: user.id }, request);
    await adapter.bind(user, { id: project.projectId, userId: user.id }, request);
    assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 50 })).rows, full.rows);
    const adapterGroup = await adapter.stage(user, project.id, { requestKey: 'd2-group', sessionId: 'd2-session', mode: 'analysis', selectionRef: groups.selection.reference, view: groups.view, expectedDigest: groups.digest, intent: 'explain' });
    assert.ok(adapterGroup.draft);
    if (process.env.GEO_D2_RECEIPTS_DIR) {
        await mkdir(process.env.GEO_D2_RECEIPTS_DIR, { recursive: true });
        for (const [name, analysis] of [['v22', full], ['v19', await freezeSelectedGeoAnalysis(store, project, { selectionRef: groups.selection.reference, view: groups.view, expectedDigest: groups.digest })]])
            await writeFile(`${process.env.GEO_D2_RECEIPTS_DIR}/document-${name}.json`, JSON.stringify({ ...freezeGeoAnalysisDocument(analysis), version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: analysis.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
    }
    await store.query("UPDATE evimed_geo.snapshots SET surface='{\"mode\":\"web\"}' WHERE id='d2-s3'");
    await assert.rejects(service.analysis(user, project.id, { selectionRef: view.selection.reference, ...view.view }), error => error.status === 409);
    assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 50 })).rows, full.rows);
});
test('V19 bounded chart remainder is a distinct-answer union retained in real paged frozen/native data', opts, async () => {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d2-wide-control','Wide',1048576)", [user.id]);
    const wide = await store.createProject({ userId: user.id, projectId: 'd2-wide-control', engines: ['deepseek'], coverageDays: 90, product: {} });
    await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('d2-wide-g',$1,$2,1,'P2','Wide')", [user.id, wide.id]);
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES('d2-wide-q',$1,$2,'d2-wide-g',1,'P2','Wide original?',true)", [user.id, wide.id]);
    await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES('d2-wide-r',$1,$2,'baseline','done',1,'{deepseek}','2026-10-01','{\"mode\":\"web\"}')", [user.id, wide.id]);
    const links = Array.from({ length: 70 }, (_, n) => ({ url: `https://news.example/page?n=${n}&padding=${'x'.repeat(1800)}` }));
    await measure.insertSnapshot({ id: 'd2-wide-s', userId: user.id, geoProjectId: wide.id, roundId: 'd2-wide-r', questionId: 'd2-wide-q', engine: 'deepseek', askedAt: new Date('2026-10-01T00:00:00Z'), status: 'valid', answerText: 'Wide answer', answerSha256: null, citations: links, surface: { mode: 'web' }, screenshotSha256: null, latencyMs: null, warnings: [], probeJobId: null });
    const view = await service.analysis(user, wide.id, { round: 'd2-wide-r', viewId: 'V19', sourceFacet: 'engine', sourceLevel: 'page', topN: 1 }), full = await freezeSelectedGeoAnalysis(store, wide, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    assert.equal(full.rows.length, 70);
    assert.equal(full.chart.cells.length, 2);
    const remainder = full.chart.cells.at(-1);
    assert.equal(remainder.value, 1);
    assert.equal(remainder.members.total, 1);
    assert.equal(full.rows.slice(1).reduce((sum, row) => sum + row.values.answers.value, 0), 69);
    const page = await service.analysisMembers(user, wide.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: remainder.rowKey, columnKey: remainder.columnKey });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].source.pages.length, 69);
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => { }, runs: async () => [] });
    service.planContexts = adapter;
    const staged = await adapter.stage(user, wide.id, { requestKey: 'd2-wide', sessionId: 'd2-wide-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'explain' }), request = { requestId: 'd2-wide-request', sessionId: 'd2-wide-session', content: [{ type: 'text', text: 'Explain sources.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await adapter.prepare(user, { id: wide.projectId, userId: user.id }, request);
    await adapter.bind(user, { id: wide.projectId, userId: user.id }, request);
    const native = await service.runtimeRead(wide, 'analysis', { planContextRef: staged.referenceId, limit: 50 });
    assert.ok(native.frozenPages.pages.length > 0);
    assert.deepEqual(native.chart, full.chart);
    const rows = [];
    for (let offset = 0; offset < 70; offset += 50)
        rows.push(...(await service.runtimeRead(wide, 'analysis', { planContextRef: staged.referenceId, offset, limit: 50 })).rows);
    assert.deepEqual(rows, full.rows);
    if (process.env.GEO_D2_RECEIPTS_DIR)
        await writeFile(`${process.env.GEO_D2_RECEIPTS_DIR}/native-remainder.json`, JSON.stringify({ fullRows: 70, pagedNative: true, pages: native.frozenPages.pages.length, chartCells: native.chart.cells.length, remainder: remainder.value, simpleSum: 69, digest: full.digest }, null, 2));
});
test('V22 eligible repeat status controls stored presence and absence without losing valid positives or raw links', opts, async () => {
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'d2-status-control','Status history',1048576)", [user.id]);
    const statusProject = await store.createProject({ userId: user.id, projectId: 'd2-status-control', engines: ['deepseek'], coverageDays: 90, product: {} });
    await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name) VALUES('d2-status-g',$1,$2,1,'P2','Status')", [user.id, statusProject.id]);
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured) VALUES('d2-status-q',$1,$2,'d2-status-g',1,'P2','Status original question?',true)", [user.id, statusProject.id]);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const roundId = `d2-status-r${n}`, at = `2026-10-${10 + n}T00:00:00Z`;
        await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) VALUES($1,$2,$3,'baseline','done',1,'{deepseek}',$4,'{\"mode\":\"web\"}')", [roundId, user.id, statusProject.id, at.slice(0, 10)]);
        const statuses = [3, 7, 8].includes(n) ? ['refusal', 'valid'] : [n === 1 ? 'refusal' : n === 2 ? 'failed' : 'valid'];
        for (const [repeatIndex, status] of statuses.entries()) {
            const id = `d2-status-s${n}-${status}`, jobId = `${id}-job`;
            await store.query("INSERT INTO evimed_geo.probe_jobs(id,user_id,geo_project_id,round_id,question_id,engine,repeat_index,status) VALUES($1,$2,$3,$4,'d2-status-q','deepseek',$5,'done')", [jobId, user.id, statusProject.id, roundId, repeatIndex]);
            await measure.insertSnapshot({ id, userId: user.id, geoProjectId: statusProject.id, roundId, questionId: 'd2-status-q', engine: 'deepseek', askedAt: new Date(at), status, answerText: `Original ${status} result`, answerSha256: null, citations: [4, 6, 8].includes(n) || n === 3 && status === 'valid' ? [] : [link], surface: { mode: 'web', citationObservation: complete }, screenshotSha256: null, latencyMs: null, warnings: [], probeJobId: jobId });
        }
    }
    const view = await service.analysis(user, statusProject.id, { from: '2026-10-11', to: '2026-10-18', viewId: 'V22' });
    const full = await freezeSelectedGeoAnalysis(store, statusProject, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    assert.deepEqual(full.rows.map(row => [row.dimensions.roundId, row.values.observation.value, row.values.transition.value]), [
        ['d2-status-r1', null, null], ['d2-status-r2', null, null], ['d2-status-r3', null, null],
        ['d2-status-r4', 'absent', 'absent'], ['d2-status-r5', 'present', 'new_appearance'], ['d2-status-r6', 'absent', 'no_longer_observed'],
        ['d2-status-r7', 'present', 'new_appearance'], ['d2-status-r8', null, null],
    ]);
    for (const row of full.rows.slice(0, 3)) {
        assert.equal(row.values.observation.reason, 'answer_not_returned');
        assert.equal(row.values.observation.state, 'unknown');
        const members = await service.analysisMembers(user, statusProject.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: row.key, columnKey: 'observation' });
        assert.ok(members.items.some(item => item.status !== 'valid'));
        for (const item of members.items) {
            assert.deepEqual(item.answer.citations, item.snapshotId === 'd2-status-s3-valid' ? [] : [link], 'the raw URL provenance remains available even when status makes history unknown');
            assert.deepEqual(item.answer.surface.citationObservation, complete);
        }
        if (row.dimensions.roundId === 'd2-status-r3') assert.deepEqual(members.items.map(item => item.repeatIndex).sort(), [0, 1]);
    }
    const firstAbsent = full.rows[3], laterAbsent = full.rows[5];
    for (const [row, ids] of [[firstAbsent, ['d2-status-s4-valid']], [laterAbsent, ['d2-status-s5-valid', 'd2-status-s6-valid']]]) {
        const members = await service.analysisMembers(user, statusProject.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: row.key, columnKey: 'transition' });
        assert.deepEqual(members.items.map(item => item.snapshotId), ids);
    }
    const sources = await service.analysis(user, statusProject.id, { selectionRef: view.selection.reference, viewId: 'V19' });
    assert.equal(sources.rows[0].values.answers.value, 5, 'V19 retains D1 eligible refused citations independently of V22 history');
    const mixedPositive = await service.analysisMembers(user, statusProject.id, { selectionRef: view.selection.reference, ...view.view, expectedDigest: view.digest, rowKey: full.rows[6].key, columnKey: 'observation' });
    assert.ok(mixedPositive.items.some(item => item.status === 'valid' && item.source.pages[0].preservedCitations.some(citation => citation.url === link.url)), 'a valid linked repeat remains a known positive even beside a refused repeat');
    assert.equal(full.rows[7].values.observation.reason, 'answer_not_returned', 'a mixed empty batch cannot establish absence despite complete declarations');
    const document = freezeGeoAnalysisDocument(full);
    assert.deepEqual(document.typedTable.rows.slice(0, 3).map(row => [row.observation, row.observation_state, row.observation_reason, row.transition]), [[null, 'unknown', 'answer_not_returned', null], [null, 'unknown', 'answer_not_returned', null], [null, 'unknown', 'answer_not_returned', null]]);
    const requests = [];
    await service.selectedExport(user, statusProject, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { requests.push(args); return { id: 'd2-status-export' }; } });
    assert.deepEqual(requests[0][1].typedTable.rows, document.typedTable.rows);
    const adapter = new GeoPlanContext({ documents: new ProductDocuments(database), store, service, authorizeSession: async () => {}, runs: async () => [] });
    service.planContexts = adapter;
    const staged = await adapter.stage(user, statusProject.id, { requestKey: 'd2-status-history', sessionId: 'd2-status-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'explain' });
    const request = { requestId: 'd2-status-request', sessionId: 'd2-status-session', content: [{ type: 'text', text: 'Explain status-qualified citation history.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await adapter.prepare(user, { id: statusProject.projectId, userId: user.id }, request);
    await adapter.bind(user, { id: statusProject.projectId, userId: user.id }, request);
    const native = await service.runtimeRead(statusProject, 'analysis', { planContextRef: staged.referenceId, limit: 50 });
    assert.deepEqual(native.rows, full.rows);
    assert.deepEqual(native.chart.cells.slice(0, 3).map(cell => [cell.value, cell.state, cell.reason]), [[null, 'unknown', 'answer_not_returned'], [null, 'unknown', 'answer_not_returned'], [null, 'unknown', 'answer_not_returned']]);
    if (process.env.GEO_D2_RECEIPTS_DIR) await writeFile(`${process.env.GEO_D2_RECEIPTS_DIR}/document-v22.json`, JSON.stringify({ ...document, version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: full.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
});
