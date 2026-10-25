import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { EvidenceZoneService, readEvidenceCardRevisions } from '../src/evidenceZoneService.mjs';
import { createSourceChanges, readStoredSourceChanges } from '../src/sourceChanges.mjs';
import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { readGeoSelection } from '../src/geoReadScope.mjs';
import { freezeSelectedGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, opts = { skip: !url && 'Disposable local Postgres required' }, user = { id: 'e1-owner' };
let isolated, database, store, service, project, documents, changes, selectionRef;
before(async () => {
    if (!url)
        return;
    isolated = await createGeoTestDatabase(url, 'geoe1');
    database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
    store = new GeoStore({ database });
    await store.ready();
    await new GeoMeasureStore(database).ready();
    documents = new ProductDocuments(database);
    await new EvidenceZoneService({ database }).ready();
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'E1','development'),('e1-viewer','Viewer','development')", [user.id]);
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'e1-control','E1',1048576)", [user.id]);
    project = await store.createProject({ userId: user.id, projectId: 'e1-control', engines: ['deepseek'], coverageDays: 90, product: { brandName: 'Alpha' } });
    service = new GeoService({ store, documents, config: { geoEnabled: true, geoAudience: 'all' } });
    await store.addMember({ geoId: project.id, userId: 'e1-viewer', role: 'viewer', invitedBy: user.id });
    await store.query("INSERT INTO evimed_geo.question_groups(id,user_id,geo_project_id,set_version,pool,name,journey_stage,journey_stage_no,audience,value_context) SELECT 'e1-g'||n,$1,$2,n,'P2','Same','Need',1,'patient','{\"findingIds\":[\"finding\"]}' FROM generate_series(1,2)n", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.questions(id,user_id,geo_project_id,group_id,set_version,pool,text,is_measured,original_id) SELECT 'e1-q'||n,$1,$2,'e1-g'||least(n,2),least(n,2),'P2','Original?',true,'0007' FROM generate_series(1,3)n", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,sample_date,surface) SELECT 'e1-r'||n,$1,$2,'baseline','done',n,'{deepseek}','2026-10-01','{\"mode\":\"web\"}' FROM generate_series(1,2)n", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) VALUES('e1-s',$1,$2,'e1-r1','e1-q1','deepseek','2026-10-01','valid','Original answer','{\"mode\":\"web\"}')", [user.id, project.id]);
    // The version-2 round heard one answer: a round that heard none is in no default selection (2026-10-25), and e1-q3 stays unsampled.
    await store.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text,surface) VALUES('e1-s2',$1,$2,'e1-r2','e1-q2','deepseek','2026-10-01','valid','Second version answer','{\"mode\":\"web\"}')", [user.id, project.id]);
    await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state) VALUES('e1-zone',$1,'Evidence','draft')", [user.id]);
    await store.query("UPDATE evimed_geo.projects SET product_zone_id='e1-zone' WHERE id=$1", [project.id]);
    project.productZoneId = 'e1-zone';
    const sources = [{ title: 'Original source', url: 'https://doi.org/10.1000/e1', excerpt: 'Preserved quotation.', fetchedSha256: 'a'.repeat(64) }], claims = [{ claimId: 'C1', claimType: 'direct', claim: 'Claim', sourceIndexes: [1], supportQuote: 'Preserved quotation.' }];
    await database.query("INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,state,sources,claims,revision) VALUES('e1-card','e1-zone',$1,'Card','academic','draft',$2::jsonb,$3::jsonb,2)", [user.id, JSON.stringify(sources), JSON.stringify(claims)]);
    await database.query("INSERT INTO evimed_frontier.evidence_card_revisions(card_id,revision,snapshot) VALUES('e1-card',1,$1::jsonb)", [JSON.stringify({ id: 'e1-card', revision: 1, claims, sources })]);
    await store.query("INSERT INTO evimed_geo.claims(id,user_id,geo_project_id,claim_key,version,statement,quote,source_ref,status,card_id,card_claim_id,card_revision,verified_at) VALUES('e1-claim',$1,$2,'claim',1,'Claim','Preserved quotation.','https://doi.org/10.1000/e1','active','e1-card','C1',1,'2026-01-01')", [user.id, project.id]);
    await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,group_id,title,current_result_version_id) VALUES('e1-article',$1,$2,'e1-g2','Same','new')", [user.id, project.id]);
    for (const [result, group, digest] of [['old', 'e1-g1', 'a'], ['pdf', 'e1-g1', 'b'], ['new', 'e1-g2', 'c']])
        await store.query("INSERT INTO evimed_geo.article_versions(geo_project_id,article_id,user_id,result_version_id,digest,path,association) VALUES($1,'e1-article',$2,$3,$4,$5,$6::jsonb)", [project.id, user.id, result, digest.repeat(64), `Same.${result}`, JSON.stringify({ groupId: group, claimIds: ['e1-claim'] })]);
    await store.query("INSERT INTO evimed_geo.owned_links(id,user_id,geo_project_id,url,url_key,platform,title,published_at,article_id,group_id,article_result_version_id,article_digest) VALUES('e1-pub',$1,$2,'https://example.org/old','example.org/old','other','Old','2026-09-01','e1-article','e1-g2','old',$3)", [user.id, project.id, 'a'.repeat(64)]);
    await store.writeValue(user.id, project.id, { findings: [{ id: 'finding', statement: 'Explicit finding' }] });
    selectionRef = (await readGeoSelection(store, project, {}, { history: true })).selection.reference;
    changes = createSourceChanges({ documents, ownerUserId: PLATFORM_PUBLISHER_USER_ID });
});
after(async () => { await database?.close(); await isolated?.drop(); });
test('V10 exact cards, immutable associations, unsampled questions, complete members, exports and frozen native pages', opts, async () => {
    const view = await service.analysis(user, project.id, { viewId: 'V10', selectionRef }), old = view.rows.find(r => r.dimensions.groupId === 'e1-g1'), fresh = view.rows.find(r => r.dimensions.groupId === 'e1-g2');
    assert.equal(old.values.verifiedClaims.value, 1);
    assert.equal(old.values.questions.value, 1);
    assert.equal(fresh.values.questions.value, 2);
    assert.equal(fresh.values.answers.value, 1);
    assert.equal(fresh.values.answeredQuestions.value, 1, 'one of the version-2 questions is still unsampled');
    assert.equal(old.values.articles.value, 1);
    assert.equal(old.values.resultVersions.value, 2);
    assert.equal(old.values.publications.value, 1);
    assert.equal(fresh.values.publications.value, 0);
    assert.equal((await service.analysis({ id: 'e1-viewer' }, project.id, { selectionRef: view.selection.reference, viewId: 'V10' })).digest, view.digest);
    await assert.rejects(service.analysis({ id: 'stranger' }, project.id, { viewId: 'V10', selectionRef }), e => e.status === 404);
    const member = await service.analysisMembers(user, project.id, { ...view.view, selectionRef: view.selection.reference, rowKey: old.key, columnKey: 'answers', expectedDigest: view.digest });
    assert.equal(member.items[0].answer.answer_text, 'Original answer');
    assert.deepEqual(await readEvidenceCardRevisions(store, { userId: 'stranger', productZoneId: 'e1-zone' }, [{ cardId: 'e1-card', revision: 1 }]), []);
    assert.deepEqual(await readEvidenceCardRevisions(store, project, [{ cardId: 'e1-card', revision: 99 }]), []);
    const full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest });
    const adapter = new GeoPlanContext({ documents, store, service, authorizeSession: async () => { }, runs: async () => [] });
    service.planContexts = adapter;
    const staged = await adapter.stage(user, project.id, { requestKey: 'e1-native', sessionId: 'e1-session', mode: 'analysis', selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, intent: 'next_steps', focus: { rowKey: old.key, columnKey: 'questions' } });
    const request = { requestId: 'e1-request', sessionId: 'e1-session', content: [{ type: 'text', text: 'Explain.' }], geoPlanContext: { referenceId: staged.referenceId } };
    await adapter.prepare(user, { id: project.projectId, userId: user.id }, request);
    await adapter.bind(user, { id: project.projectId, userId: user.id }, request);
    assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 50 })).rows, full.rows);
    const calls = [];
    await service.selectedExport(user, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest, formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, { requestFrozen: async (...args) => { calls.push(args); return { id: 'e1-export' }; } });
    assert.deepEqual(calls[0][1].cover.analysis.rows, full.rows);
    if (process.env.GEO_E1_RECEIPTS_DIR) {
        await mkdir(process.env.GEO_E1_RECEIPTS_DIR, { recursive: true });
        await writeFile(`${process.env.GEO_E1_RECEIPTS_DIR}/document-V10.json`, JSON.stringify({ ...freezeGeoAnalysisDocument(full), version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: full.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
    }
    await changes.record('10.1000/e1', { kind: 'retraction', date: '2026-09-01', noticeIdentifier: '10.1000/notice' }, { assertedBy: 'operator' });
    const changed = await service.analysis(user, project.id, { selectionRef: view.selection.reference, viewId: 'V10' });
    assert.equal(changed.rows.find(r => r.dimensions.groupId === 'e1-g1').values.verifiedClaims.value, 0);
    await assert.rejects(service.analysisMembers(user, project.id, { ...view.view, selectionRef: view.selection.reference, rowKey: old.key, columnKey: 'verifiedClaims', expectedDigest: view.digest }), e => e.status === 409);
    assert.deepEqual((await service.runtimeRead(project, 'analysis', { planContextRef: staged.referenceId, limit: 50 })).rows, full.rows);
    const cached = await readStoredSourceChanges(store, PLATFORM_PUBLISHER_USER_ID, ['10.1000/e1', '10.1000/other']);
    assert.equal(cached.get('doi:10.1000/e1').state, 'changed');
    assert.equal(cached.get('doi:10.1000/other').state, 'unknown');
    await assert.rejects(readStoredSourceChanges(store, PLATFORM_PUBLISHER_USER_ID, Array.from({ length: 501 }, (_, n) => `10.1000/${n}`)));
});
test('V10 reads more than 2000 articles, retains different IDs with identical titles, paginates exact members and exports full context', opts, async () => {
    await store.query("INSERT INTO evimed_geo.articles(id,user_id,geo_project_id,group_id,title) SELECT 'e1-many-'||n,$1,$2,'e1-g1','Same.md' FROM generate_series(1,2001)n", [user.id, project.id]);
    const view = await service.analysis(user, project.id, { viewId: 'V10', selectionRef }), old = view.rows.find(r => r.dimensions.groupId === 'e1-g1');
    assert.equal(old.values.articles.value, 2002);
    const items = [];
    for (let offset = 0; offset < old.values.articles.members.total; offset += 50) {
        const page = await service.analysisMembers(user, project.id, { selectionRef: view.selection.reference, viewId: 'V10', rowKey: old.key, columnKey: 'articles', expectedDigest: view.digest, offset, limit: 50 });
        items.push(...page.items);
    }
    assert.equal(new Set(items.map(i => i.id)).size, 2002);
    assert.ok(items.some(i => i.id === 'e1-many-2001'));
    const full = await freezeSelectedGeoAnalysis(store, project, { selectionRef: view.selection.reference, view: view.view, expectedDigest: view.digest }), doc = freezeGeoAnalysisDocument(full);
    const adapter=service.planContexts;
    const staged=await adapter.stage(user,project.id,{requestKey:'e1-wide-native',sessionId:'e1-wide-session',mode:'analysis',selectionRef:view.selection.reference,view:view.view,expectedDigest:view.digest,intent:'explain'});
    const request={requestId:'e1-wide-request',sessionId:'e1-wide-session',content:[{type:'text',text:'Explain.'}],geoPlanContext:{referenceId:staged.referenceId}};await adapter.prepare(user,{id:project.projectId,userId:user.id},request);await adapter.bind(user,{id:project.projectId,userId:user.id},request);
    assert.deepEqual((await service.runtimeRead(project,'analysis',{planContextRef:staged.referenceId,limit:50})).rows,full.rows);

    // The reader's table counts every kept article; their identities (no title rides in the row) stay in the export record.
    const number = full.rows.findIndex(r => r.dimensions.groupId === 'e1-g1') + 1, typed = doc.typedTable.rows;
    const text = [typed.find(r => r.row_number === number)?.dimensions ?? '', ...typed.filter(r => r.context_parent === String(number)).map(r => r.dimensions ?? '')].join('');
    assert.equal(typed.find(r => r.row_number === number).articles, 2002);
    assert.ok(!text.includes('e1-many-') && !doc.canonicalMarkdown.includes('e1-many-'));
    assert.ok(doc.typedTable.columns.length <= 40);
    assert.ok(JSON.stringify(doc.cover.analysis).includes('e1-many-2001'));
    assert.ok(!doc.canonicalMarkdown.includes('"objects"'));
    if (process.env.GEO_E1_RECEIPTS_DIR)
        await writeFile(`${process.env.GEO_E1_RECEIPTS_DIR}/document-V10-wide.json`, JSON.stringify({ ...doc, version: 1, rendererVersion: 'pandoc-chromium-v1', sourceDigest: full.digest, sourceType: 'typed-table', formats: ['csv', 'xlsx', 'docx', 'pdf', 'html'] }, null, 2));
});
