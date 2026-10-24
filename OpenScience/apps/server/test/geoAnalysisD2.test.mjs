import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGeoAnalysis, normalizeGeoAnalysisView, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
const link = { url: 'https://www.news.example/page?x=1', domain: 'wrong.example', marker: '[1]', position: 12 };
const complete = { mode: 'web', citationObservation: { schemaVersion: 1, capability: 'linked_list', complete: true } };
function fixture() {
    const rows = [
        { snapshotId: 'a', questionId: 'q1', groupId: 'g1', roundId: 'r1', engine: 'deepseek', status: 'valid', surface: { mode: 'web' }, citations: [link], facts: null },
        { snapshotId: 'b', questionId: 'q1', groupId: 'g1', roundId: 'r2', engine: 'deepseek', status: 'failed', surface: { mode: 'web' }, citations: [] },
        { snapshotId: 'c', questionId: 'q1', groupId: 'g1', roundId: 'r3', engine: 'deepseek', status: 'valid', surface: complete, citations: [], facts: null },
        { snapshotId: 'd', questionId: 'q2', groupId: 'g2', roundId: 'r4', engine: 'kimi', status: 'valid', surface: complete, citations: [link], facts: { checks: { judgementCoverage: { status: 'partial' } } } },
    ];
    for (const row of rows)
        row.askedAt = `2026-10-0${row.roundId.slice(1)}T00:00:00Z`;
    return { scope: { timeZone: 'Asia/Shanghai' }, selection: { reference: 'gsel_d2', dataRevision: 'd2', methodVersion: 'm' }, rows, computed: { balance: { deduped: rows } }, questions: [{ id: 'q1', group_id: 'g1', set_version: 1, text: 'Original unjudged?' }, { id: 'q2', group_id: 'g2', set_version: 2, text: 'Other?' }], rounds: [1, 2, 3, 4].map(n => ({ id: `r${n}`, set_version: n === 4 ? 2 : 1, started_at: `2026-10-0${n}T00:00:00Z` })), comparison: null };
}
const context = () => ({ allRows: true, memberItems: new Map(), sources: [{ id: 'source', domain: 'news.example', kind: 'news' }], groups: [{ id: 'g1', set_version: 1, name: 'Same' }, { id: 'g2', set_version: 2, name: 'Same' }] });
test('D2 descriptors close source facet and level combinations', () => {
    assert.equal(normalizeGeoAnalysisView({ viewId: 'V19' }).sourceFacet, 'engine');
    assert.equal(normalizeGeoAnalysisView({ viewId: 'V22' }).sourceLevel, 'page');
    for (const input of [{ viewId: 'V18', sourceFacet: 'engine' }, { viewId: 'V19', sourceFacet: 'label' }, { viewId: 'V22', sourceLevel: 'domain' }, { viewId: 'V22', sourceFacet: 'group' }])
        assert.throws(() => normalizeGeoAnalysisView(input));
});
test('V19 source cross facets separate same group names across versions and preserve unjudged source citations', () => {
    const selected = fixture(), ctx = context();
    selected.rows.push({ ...selected.rows[0], snapshotId: 'unmapped', questionId: null, groupId: 'missing' });
    const groups = presentGeoAnalysis(selected, { viewId: 'V19', sourceFacet: 'group', sourceLevel: 'page' }, ctx);
    assert.deepEqual(groups.rows.map(row => [row.dimensions.setVersion, row.dimensions.groupId]).sort(), [[1, 'g1'], [1, 'missing'], [2, 'g2']].sort());
    assert.ok(groups.rows.some(row => row.dimensions.groupState === 'unmapped'));
    const first = groups.rows.find(row => row.dimensions.groupId === 'g1'), member = ctx.memberItems.get(`${first.key}:answers`)[0];
    assert.equal(member.judgment, null);
    assert.equal(member.question.text, 'Original unjudged?');
    assert.deepEqual(member.source.pages[0].preservedCitations, [link]);
    const engines = presentGeoAnalysis(selected, { viewId: 'V19', sourceFacet: 'engine', sourceType: 'news', sourceSearch: '?x=1' }, context());
    assert.equal(engines.rows.length, 2);
    assert.equal(engines.rows.find(row => row.dimensions.engine === 'deepseek').values.answers.value, 2);
    assert.equal(presentGeoAnalysis(selected, { viewId: 'V19', sourceType: 'medical' }, context()).rows.length, 0);
});
test('V22 preserved citation, failed/linkless interval and complete comparable absence remain distinct', () => {
    const selected = fixture(), ctx = context(), view = presentGeoAnalysis(selected, { viewId: 'V22' }, ctx), cohort = view.rows.filter(row => row.dimensions.questionId === 'q1');
    assert.deepEqual(cohort.map(row => [row.dimensions.roundId, row.values.observation.value, row.values.transition.value]), [['r1', 'present', 'first_observed_in_scope'], ['r2', null, null], ['r3', 'absent', 'no_longer_observed'], ['r4', null, null]]);
    assert.equal(cohort[1].values.observation.state, 'unknown');
    for (const row of view.rows)
        for (const [key, cell] of Object.entries(row.values))
            assert.equal(cell.members.total, ctx.memberItems.get(`${row.key}:${key}`).length);
    assert.equal(cohort[2].values.transition.members.total, 2, 'exact old/new observation actions');
    const doc = freezeGeoAnalysisDocument(view);
    assert.equal(doc.typedTable.rows.length, view.rows.length);
    assert.match(doc.canonicalMarkdown, /所选范围内首次/);
    selected.rows[1] = { ...selected.rows[1], status: 'valid', citations: [{ domain: 'news.example' }], surface: complete };
    assert.equal(presentGeoAnalysis(selected, { viewId: 'V22' }, context()).rows.find(row => row.dimensions.roundId === 'r2' && row.dimensions.questionId === 'q1').values.observation.value, null);
});
test('V22 new appearance requires earlier comparable observed absence; legacy empty and changed mode/version/question stay unknown', () => {
    const selected = fixture();
    selected.rows[0].citations = [];
    selected.rows[0].surface = complete;
    selected.rows[1] = { ...selected.rows[1], status: 'valid', citations: [link], surface: complete };
    let view = presentGeoAnalysis(selected, { viewId: 'V22' }, context());
    assert.equal(view.rows.find(row => row.dimensions.roundId === 'r2' && row.dimensions.questionId === 'q1').values.transition.value, 'new_appearance');
    selected.rows[0].surface = { mode: 'web' };
    view = presentGeoAnalysis(selected, { viewId: 'V22' }, context());
    assert.equal(view.rows.find(row => row.dimensions.roundId === 'r2' && row.dimensions.questionId === 'q1').values.transition.value, 'first_observed_in_scope');
    selected.rows[0].surface = complete;
    selected.rows[1].surface = { ...complete, mode: 'inclusion' };
    view = presentGeoAnalysis(selected, { viewId: 'V22' }, context());
    assert.ok(!view.rows.some(row => row.values.transition.value === 'new_appearance'));
    assert.ok(view.rows.every(row => row.dimensions.firstObservedBasis === 'selected_scope'));
});
test('V22 only a complete schema-v1 producer declaration admits absence; unknown timestamps and changed question versions cannot produce transitions',()=>{
 for(const declaration of [undefined,{}, {capability:'linked_list',complete:true},{schemaVersion:2,capability:'linked_list',complete:true},{schemaVersion:1,capability:'linked_list',complete:false},{schemaVersion:1,capability:'retrieval',complete:true}]){
  const selected=fixture();selected.rows[2].surface={mode:'web',citationObservation:declaration};
  const view=presentGeoAnalysis(selected,{viewId:'V22'},context()),row=view.rows.find(row=>row.dimensions.questionId==='q1'&&row.dimensions.roundId==='r3');
  assert.equal(row.values.observation.value,null);assert.equal(row.values.observation.reason,'citation_completeness_unknown');
 }
 const unknownTime=fixture();unknownTime.rows[2].askedAt=null;
 const point=presentGeoAnalysis(unknownTime,{viewId:'V22'},context()).rows.find(row=>row.dimensions.roundId==='r3'&&row.dimensions.questionId==='q1');assert.equal(point.values.observation.value,'absent');assert.equal(point.values.transition.value,null);assert.equal(point.values.transition.reason,'sampling_time_unknown');
 const changed=fixture();changed.rows[2].questionId='q2';changed.rows[2].groupId='g2';
 assert.ok(!presentGeoAnalysis(changed,{viewId:'V22'},context()).rows.some(row=>row.values.transition.value==='no_longer_observed'));
});
test('D2 complete universes are bounded before output expansion, and page/facet rows remain complete before pagination',()=>{
 const selected=fixture(),ctx=context();selected.rows[0].citations=Array.from({length:20001},(_,n)=>({url:`https://news.example/p?n=${n}`}));
 assert.throws(()=>presentGeoAnalysis(selected,{viewId:'V19',sourceLevel:'page'},ctx),error=>error.status===422);
 const history=fixture();history.rows[0].citations=Array.from({length:2501},(_,n)=>({url:`https://news.example/p?n=${n}`}));
 assert.throws(()=>presentGeoAnalysis(history,{viewId:'V22'},context()),error=>error.status===422);
 const small=fixture();small.rows[0].citations=Array.from({length:101},(_,n)=>({url:`https://news.example/p?n=${n}`}));
 for(const viewId of ['V19','V22']){const full=presentGeoAnalysis(small,{viewId},context()),page=presentGeoAnalysis(small,{viewId},{...context(),allRows:false,offset:100,limit:50});assert.equal(page.digest,full.digest);assert.equal(page.page.total,full.rows.length);assert.deepEqual(page.rows,full.rows.slice(100,150));}
});
test('V22 admitted 20,000-page one-round upper bound indexes raw citation lists before history expansion',async()=>{
 const {buildGeoSourceAnalysis}=await import('../src/geoAnalysisSources.mjs');const count=20000;let urlReads=0;
 const selected=fixture();selected.rows=selected.rows.slice(0,1);selected.computed.balance.deduped=selected.rows;selected.rounds=selected.rounds.slice(0,1);
 selected.rows[0].citations=Array.from({length:count},(_,n)=>({get url(){urlReads++;return `https://news.example/p?n=${n}`;}}));
 const started=performance.now(),built=buildGeoSourceAnalysis(selected,{viewId:'V22',sourceLevel:'page',sourceRelationship:'all',topN:15},context());
 assert.equal(built.rows.length,count);assert.ok(urlReads<count*12,`raw URL reads ${urlReads} must remain linear, not rescan each list per page`);
 assert.ok(built.rows.every(row=>row.values.observation.value==='present'));assert.equal(built.chart.cells.length,15);
 console.log(JSON.stringify({fixture:'V22-20k-pages-one-round',rows:count,rawUrlReads:urlReads,elapsedMs:Math.round(performance.now()-started),endHeapMiB:Math.round(process.memoryUsage().heapUsed/1024/1024)}));
});
test('V22 only valid linked repeats supply presence while non-valid URL provenance stays drillable', () => {
    for (const status of ['refusal', 'failed', 'error', 'suspect']) for (const declaration of [false, true]) for (const mixed of ['none', 'valid_empty', 'valid_linked']) {
        const selected = fixture();
        selected.rows = [
            { ...selected.rows[0], status, surface: declaration ? complete : { mode: 'web' }, repeatIndex: 0 },
            { ...selected.rows[2], snapshotId: 'absent', roundId: 'r2', askedAt: '2026-10-02T00:00:00Z' },
            { ...selected.rows[0], snapshotId: 'positive', roundId: 'r3', askedAt: '2026-10-03T00:00:00Z', surface: complete },
        ];
        if (mixed !== 'none') selected.rows.push({ ...selected.rows[0], snapshotId: 'valid-repeat', repeatIndex: 1, status: 'valid', surface: complete, citations: mixed === 'valid_linked' ? [link] : [] });
        selected.computed.balance.deduped = selected.rows;
        selected.rounds = selected.rounds.slice(0, 3);
        const ctx = context(), view = presentGeoAnalysis(selected, { viewId: 'V22' }, ctx);
        const [first, absent, positive] = view.rows, hasValidPositive = mixed === 'valid_linked';
        const detail = `${status}, declared ${declaration}, mixed ${mixed}`;
        assert.equal(first.values.observation.value, hasValidPositive ? 'present' : null, detail);
        assert.equal(first.values.observation.state, hasValidPositive ? 'known' : 'unknown', detail);
        assert.equal(first.values.observation.reason, hasValidPositive ? null : 'answer_not_returned', detail);
        assert.equal(first.values.transition.value, hasValidPositive ? 'first_observed_in_scope' : null, detail);
        assert.equal(first.dimensions.firstObserved, hasValidPositive ? '2026-10-01T00:00:00Z' : '2026-10-03T00:00:00Z');
        assert.equal(absent.values.observation.value, 'absent');
        assert.equal(absent.values.transition.value, hasValidPositive ? 'no_longer_observed' : 'absent');
        assert.equal(absent.dimensions.previousRoundId, hasValidPositive ? 'r1' : null);
        assert.deepEqual(ctx.memberItems.get(`${absent.key}:transition`).map(item => item.snapshotId), hasValidPositive ? ['a', 'valid-repeat', 'absent'] : ['absent']);
        assert.equal(positive.values.observation.value, 'present');
        assert.equal(positive.values.transition.value, 'new_appearance');
        assert.deepEqual(ctx.memberItems.get(`${positive.key}:transition`).map(item => item.snapshotId), ['absent', 'positive']);
        assert.equal(view.chart.cells[0].value, hasValidPositive ? 1 : null);
        const frozen = freezeGeoAnalysisDocument(view);
        assert.equal(frozen.cover.analysis.rows[0].values.observation.value, hasValidPositive ? 'present' : null);
        assert.equal(frozen.typedTable.rows[0].observation, hasValidPositive ? 'present' : null);
        assert.equal(frozen.typedTable.rows[0].observation_state, hasValidPositive ? 'known' : 'unknown');
        assert.match(frozen.canonicalMarkdown, /有效重复中的引用仍可观察/);
        assert.match(frozen.canonicalMarkdown, /未引用须所有相关重复均有效且引用列表完整/);
        if (status === 'refusal') {
            assert.deepEqual(ctx.memberItems.get(`${first.key}:observation`)[0].source.pages[0].preservedCitations, [link]);
            const sources = presentGeoAnalysis(selected, { viewId: 'V19' }, context());
            assert.equal(sources.rows[0].values.answers.value, hasValidPositive ? 3 : 2, 'V19 keeps admitted refused citation provenance');
        }
    }
});
