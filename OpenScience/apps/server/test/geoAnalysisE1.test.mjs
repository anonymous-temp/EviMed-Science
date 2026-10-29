import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { computeGeoSelection } from '../src/geoReadScope.mjs';
export function fixture() {
    const questions = [{ id: 'q1', group_id: 'old', set_version: 1, text: 'Original?', original_id: '0007' }, { id: 'q2', group_id: 'old', set_version: 1, text: 'Never sampled?' }, { id: 'q3', group_id: 'new', set_version: 2, text: 'New?' }];
    const rows = [{ snapshotId: 's1', questionId: 'q1', groupId: 'old', roundId: 'r1', engine: 'deepseek', status: 'valid', repeatIndex: 0, citations: [] }, { snapshotId: 's2', questionId: 'q1', groupId: 'old', roundId: 'r1', engine: 'deepseek', status: 'valid', repeatIndex: 1, citations: [] }];
    const selected = { scope: { timeZone: 'Asia/Shanghai' }, selection: { reference: 'gsel_e1', dataRevision: 'r', counts: { snapshots: 2 }, engines: ['deepseek'] }, questions, rows, rounds: [], metricOptions: { engines: ['deepseek'] }, computed: computeGeoSelection(rows, { engines: ['deepseek'] }) };
    const association = { groupId: 'old', claimIds: ['c1', 'c2', 'c3'], valueContext: { findingIds: ['f1'] } };
    const context = { allRows: true, memberItems: new Map(), groups: [{ id: 'old', set_version: 1, name: 'Same', journey_stage: 'Need', journey_stage_no: 1, audience: 'patient', value_context: { findingIds: ['f1'] } }, { id: 'new', set_version: 2, name: 'Same', journey_stage: 'Need', journey_stage_no: 1, audience: 'patient' }], evidence: { articles: [{ id: 'a1', groupId: 'new', currentResultVersionId: 'v2', title: 'Same.md' }], versions: [{ articleId: 'a1', resultVersionId: 'v1', digest: 'a'.repeat(64), path: 'Same.md', association }, { articleId: 'a1', resultVersionId: 'pdf', digest: 'b'.repeat(64), path: 'Same.pdf', association }, { articleId: 'a1', resultVersionId: 'v2', digest: 'c'.repeat(64), association: { groupId: 'new', claimIds: [] } }], claims: [{ id: 'c1', version: 1, status: 'active', verifiedAt: '2026-01-01' }, { id: 'c2', version: 1, status: 'expired' }, { id: 'c3', version: 1, status: 'active', quote: 'Quote', sourceRef: 'missing-source' }, { id: 'unlinked', version: 1, status: 'active' }], publications: [{ id: 'p1', articleId: 'a1', resultVersionId: 'v1', digest: 'a'.repeat(64), url: 'https://example.org/old', status: 'active' }, { id: 'legacy', articleId: 'a1', resultVersionId: null, digest: null, status: 'active' }, { id: 'bad', articleId: 'a1', resultVersionId: 'v1', digest: 'f'.repeat(64), status: 'active' }], value: { version: 3, data: { findings: [{ id: 'f1', statement: 'Finding' }, { id: 'fu', statement: 'Unmapped' }] } }, journey: { version: 1, data: {} } } };
    return { selected, context };
}
test('V10 retains unsampled definitions, exact same-name versions and independent typed units', () => {
    const { selected, context } = fixture(), view = presentGeoAnalysis(selected, { viewId: 'V10' }, context), old = view.rows.find(r => r.dimensions.groupId === 'old'), fresh = view.rows.find(r => r.dimensions.groupId === 'new');
    assert.equal(old.values.questions.value, 2);
    assert.equal(old.values.answeredQuestions.value, 1);
    assert.equal(old.values.answers.value, 2);
    assert.equal(fresh.values.questions.value, 1);
    assert.equal(fresh.values.answers.value, 0);
    assert.equal(old.values.articles.value, 1);
    assert.equal(old.values.resultVersions.value, 2);
    assert.equal(old.values.publications.value, 1);
    assert.equal(fresh.values.publications.value, 0);
    assert.equal(old.values.linkedClaims.value, 3);
    assert.equal(old.values.linkedClaims.reason, 'linked_not_verified');
    assert.equal(old.values.findings.value, 1);
    assert.equal(old.values.questions.unit, 'questions');
    assert.equal(old.values.answeredQuestions.unit, 'distinct_answered_questions');
    assert.equal(old.values.resultVersions.unit, 'result_versions');
    assert.equal(context.memberItems.get(`${old.key}:questions`)[1].questionId, 'q2');
    assert.ok(view.rows.some(r => r.dimensions.kind === 'journey_unmapped'));
    for (const cell of view.chart.cells)
        assert.deepEqual(cell.members, view.rows.find(r => r.key === cell.rowKey).values[cell.columnKey].members);
    assert.deepEqual(freezeGeoAnalysisDocument(view).cover.analysis.rows, view.rows);
});
test('V10 never promotes current heads, unverified/expired claims or missing pins to historical support', () => {
    const { selected, context } = fixture(), view = presentGeoAnalysis(selected, { viewId: 'V10' }, context), unknown = view.rows.find(r => r.dimensions.kind === 'journey_unmapped');
    assert.equal(unknown.values.publications.value, 2);
    assert.equal(unknown.values.linkedClaims.value, 1);
    assert.equal(unknown.values.findings.value, 1);
    assert.ok(view.rows.filter(row => row.values.verifiedClaims.state === 'known').every(row => row.values.verifiedClaims.value === 0));
    assert.ok(view.rows.some(row => row.values.verifiedClaims.state === 'unknown' && row.values.verifiedClaims.value === null));
    const old = view.rows.find(r => r.dimensions.groupId === 'old'), items = context.memberItems.get(`${old.key}:linkedClaims`);
    assert.ok(items.every(c => c.verification === 'linked_not_verified'));
    context.evidence.journey.version = 2;
    assert.notEqual(presentGeoAnalysis(selected, { viewId: 'V10' }, context).digest, view.digest);
});
test('V10 missing context is unknown, known empty is zero, malformed question/group versions remain unmapped', () => {
    const { selected, context } = fixture();
    delete context.evidence;
    let view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.equal(view.rows[0].values.linkedClaims.value, null);
    assert.equal(view.rows[0].values.articles.state, 'unknown');
    context.evidence = { articles: [], versions: [], claims: [], publications: [], value: { version: 0, data: {} } };
    selected.questions[0].set_version = 99;
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.ok(view.rows.some(r => r.dimensions.groupState === 'unmapped'));
    assert.equal(view.rows.find(r => r.dimensions.groupId === 'new').values.articles.value, 0);
});
test('V10 source-backed claim requires exact historical card revision/quote, with no current head fallback', () => {
    const { selected, context } = fixture(), claim = context.evidence.claims[0];
    Object.assign(claim, { cardId: 'card', cardRevision: 1, cardClaimId: 'C1', statement: 'Claim', quote: 'Preserved quote', sourceRef: 'https://doi.org/10.1000/e1' });
    context.evidence.cards = [{ cardId: 'card', revision: 1, current: { revision: 2, withdrawn: false }, at: { claims: [{ claimId: 'C1', claimType: 'direct', claim: 'Claim', supportQuote: 'Preserved quote', sourceIndexes: [1] }], sources: [{ url: 'https://doi.org/10.1000/e1', documentText: 'Read this: Preserved quote.' }] } }];
    let view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.equal(view.rows.find(r => r.dimensions.groupId === 'old').values.verifiedClaims.value, 1);
    const original = view.digest;
    context.evidence.sourceChanges = [{ identifier: 'doi:10.1000/e1', state: 'changed', changes: [{ kind: 'retraction', date: '2026-09-01', recordedAt: '2026-10-20' }] }];
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.equal(view.rows.find(r => r.dimensions.groupId === 'old').values.verifiedClaims.knownSubtotal, 0);
    assert.notEqual(view.digest, original);
    delete context.evidence.sourceChanges;
    context.evidence.cards[0].at.sources[0].documentText = 'Different source text';
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.equal(view.rows.find(r => r.dimensions.groupId === 'old').values.verifiedClaims.knownSubtotal, 0);
});
test('V10 descriptor is closed and native schema keeps exactly the implemented view catalogue', async () => {
    const { normalizeGeoAnalysisView, GEO_ANALYSIS_REGISTRY } = await import('../src/geoAnalysisRegistry.mjs');
    const { readFile } = await import('node:fs/promises');
    const schema = await readFile(new URL('../../../runtime/mcp/evimed-research/geo_platform.py', import.meta.url), 'utf8');
    const line = schema.split('\n').find(line => line.includes('"viewId": {"type": "string", "enum":'));
    const ids = [...line.matchAll(/"(V\d+)"/g)].map(match => match[1]);
    assert.deepEqual(ids.sort(), Object.keys(GEO_ANALYSIS_REGISTRY).sort());
    const descriptor = normalizeGeoAnalysisView({ viewId: 'V10' });
    assert.deepEqual(normalizeGeoAnalysisView(descriptor), descriptor);
    for (const extra of [{ metricId: 'M-01' }, { dimension: 'group' }, { sourceSearch: 'x' }, { categoryMode: 'client_tags' }])
        assert.throws(() => normalizeGeoAnalysisView({ viewId: 'V10', ...extra }));
});

test('V10 excludes explicitly outside-scope claims while keeping genuinely unlinked objects', () => {
    const { selected, context } = fixture();
    selected.questions = selected.questions.filter(question => question.set_version === 1);
    context.evidence.claims.push({ id: 'new-only', status: 'active', version: 2 });
    context.evidence.versions.find(version => version.resultVersionId === 'v2').association.claimIds = ['new-only'];
    const view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    const unmapped = view.rows.find(row => row.dimensions.kind === 'journey_unmapped');
    assert.deepEqual(context.memberItems.get(`${unmapped.key}:linkedClaims`).map(item => item.id), ['unlinked']);
    assert.ok(!JSON.stringify(view).includes('new-only'));
});

test('V10 excludes findings linked only through an unselected group while retaining unlinked findings', () => {
    const { selected, context } = fixture();
    selected.questions = selected.questions.filter(question => question.set_version === 1);
    context.evidence.groupFindingLinks = [{ id: 'new', value_context: { findingIds: ['new-finding'] } }];
    context.evidence.value.data.findings.push({ id: 'new-finding', statement: 'Outside the selected group.' });
    const view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    const unmapped = view.rows.find(row => row.dimensions.kind === 'journey_unmapped');
    assert.deepEqual(context.memberItems.get(`${unmapped.key}:findings`).map(item => item.id), ['fu']);
    assert.ok(!JSON.stringify(view).includes('new-finding'));
});

test('V10 separates unknown verification candidates from verified subtotals and a known empty set', () => {
    const { selected, context } = fixture();
    let view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    let old = view.rows.find(row => row.dimensions.groupId === 'old');
    assert.equal(old.values.verifiedClaims.value, null);
    assert.equal(old.values.verifiedClaims.state, 'unknown');
    assert.equal(old.values.unknownClaims.value, 2);
    assert.equal(old.values.verifiedClaims.knownSubtotal, 0);
    const empty = view.rows.find(row => row.dimensions.groupId === 'new').values.verifiedClaims;
    assert.deepEqual([empty.value, empty.state, empty.reason], [0, 'known', null]);
    const claim = context.evidence.claims[0];
    Object.assign(claim, { cardId: 'card', cardRevision: 1, cardClaimId: 'C1', statement: 'Claim', quote: 'Preserved quote', sourceRef: 'https://doi.org/10.1000/e1' });
    context.evidence.cards = [{ cardId: 'card', revision: 1, current: {}, at: { claims: [{ claimId: 'C1', claimType: 'direct', claim: 'Claim', supportQuote: 'Preserved quote', sourceIndexes: [1] }], sources: [{ url: claim.sourceRef, documentText: 'Preserved quote.' }] } }];
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context); old = view.rows.find(row => row.dimensions.groupId === 'old');
    assert.deepEqual([old.values.verifiedClaims.value, old.values.verifiedClaims.state, old.values.unknownClaims.value], [1, 'partial', 1]);
    delete context.evidence.cards[0].at.sources[0].documentText;
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    assert.equal(view.rows.find(row => row.dimensions.groupId === 'old').values.verifiedClaims.value, null);
    context.evidence.cards[0].at.sources[0].documentText = 'A different preserved source passage.';
    context.evidence.claims.find(item => item.id === 'c3').status = 'expired';
    view = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
    old = view.rows.find(row => row.dimensions.groupId === 'old');
    assert.deepEqual([old.values.verifiedClaims.value, old.values.verifiedClaims.state, old.values.unknownClaims.value], [0, 'known', 0]);
    assert.equal(context.memberItems.get(`${old.key}:linkedClaims`).find(item => item.id === 'c1').reason, 'quote_not_found');
});

test('V10 keeps source-specific current notices and exact identities in members and human export context', () => {
    const { selected, context } = fixture();
    Object.assign(context.evidence.claims[0], { cardId: 'card', cardRevision: 1, cardClaimId: 'C1', statement: 'Claim one', quote: 'First quote', sourceRef: 'https://doi.org/10.1000/first' });
    Object.assign(context.evidence.claims[1], { status: 'active', cardId: 'card', cardRevision: 1, cardClaimId: 'C2', statement: 'Claim two', quote: 'Second quote', sourceRef: 'https://doi.org/10.1000/second' });
    context.evidence.cards = [{ cardId: 'card', revision: 1, current: {}, at: {
        claims: [{ claimId: 'C1', claimType: 'direct', claim: 'Claim one', supportQuote: 'First quote', sourceIndexes: [1] }, { claimId: 'C2', claimType: 'direct', claim: 'Claim two', supportQuote: 'Second quote', sourceIndexes: [2] }],
        sources: [{ url: 'https://doi.org/10.1000/first', documentText: 'First quote.' }, { url: 'https://doi.org/10.1000/second', documentText: 'Second quote.' }],
    } }];
    context.evidence.sourceChanges = [{ identifier: 'doi:10.1000/first', state: 'changed', checkedAt: '2026-10-22T12:00:00Z',
        changes: [{ kind: 'retraction', date: '2026-10-21', recordedAt: '2026-10-22T11:00:00Z' }] }];
    context.evidence.journey.version = 9;
    const view = presentGeoAnalysis(selected, { viewId: 'V10' }, context), old = view.rows.find(row => row.dimensions.groupId === 'old');
    const items = context.memberItems.get(`${old.key}:linkedClaims`), first = items.find(item => item.id === 'c1'), second = items.find(item => item.id === 'c2');
    assert.equal(first.reason, 'source_update_needed');
    assert.equal(first.preservedQuoteVerification.status, 'verified');
    assert.equal(first.sourceChanges[0].changes[0].date, '2026-10-21');
    assert.equal(second.verification, 'verified_preserved_quote');
    assert.deepEqual(second.sourceChanges, []);
    const exported = freezeGeoAnalysisDocument(view);
    // The reader sees each version, the notice's own dates (recorded and checked times in the scope's zone) and the source; the
    // group identities and the record's codes stay in the export record.
    for (const text of ['问题版本：1', '问题版本：2', 'Claim one', '2026-10-21', '2026-10-22 19:00', '2026-10-22 20:00', 'doi:10.1000/first', '旅程上下文版本：9', '撤稿'])
        assert.ok(exported.canonicalMarkdown.includes(text), text);
    for (const code of ['```json', '"sourceChanges"', 'gsel_e1', 'linked_not_verified'])
        assert.ok(!exported.canonicalMarkdown.includes(code), code);
    for (const [name, patch, withdrawn, reason] of [
        ['expired', {validUntil:'2026-01-01',expired:true}, false, 'claim_expired'],
        ['superseded', {status:'superseded'}, false, 'claim_inactive'],
        ['withdrawn card', {}, true, 'card_withdrawn'],
    ]) {
        Object.assign(context.evidence.claims[0], {status:'active',validUntil:null,expired:false}, patch);
        context.evidence.cards[0].current.withdrawn = withdrawn;
        const current = presentGeoAnalysis(selected, { viewId: 'V10' }, context);
        const row = current.rows.find(item => item.dimensions.groupId === 'old');
        const member = context.memberItems.get(`${row.key}:linkedClaims`).find(item => item.id === 'c1');
        assert.equal(member.reason,reason,name);
        assert.equal(member.preservedQuoteVerification?.status,'verified',name);
        assert.equal(member.sourceChanges[0]?.changes[0]?.date,'2026-10-21',name);
        assert.ok(freezeGeoAnalysisDocument(current).canonicalMarkdown.includes('2026-10-21'),name);
    }
});

test('V10 indexes cached source facts once instead of rescanning them for every claim',()=>{
    const {selected,context}=fixture(),size=120;let reads=0;
    const claims=Array.from({length:size},(_,n)=>({id:'indexed-'+n,status:'active',version:1,statement:'Claim '+n,quote:'Preserved '+n,sourceRef:'https://doi.org/10.1000/indexed'+n,cardId:'card-'+n,cardRevision:1,cardClaimId:'C1'}));
    context.evidence.claims=claims;
    context.evidence.articles=[];
    context.evidence.versions=[{articleId:'indexed',resultVersionId:'indexed',association:{groupId:'old',claimIds:claims.map(claim=>claim.id)}}];
    context.evidence.cards=claims.map(claim=>({cardId:claim.cardId,revision:1,current:{},at:{claims:[{claimId:'C1',claimType:'direct',claim:claim.statement,supportQuote:claim.quote,sourceIndexes:[1]}],sources:[{url:claim.sourceRef,documentText:claim.quote}]}}));
    context.evidence.sourceChanges=claims.map((_,n)=>({get identifier(){reads++;return 'doi:10.1000/indexed'+n;},state:'clean',changes:[]}));
    const view=presentGeoAnalysis(selected,{viewId:'V10'},context);
    assert.equal(view.rows.find(row=>row.dimensions.groupId==='old').values.verifiedClaims.value,size);
    assert.ok(reads<size*30,`Cached identifiers read ${reads} times for ${size} claims`);
    let cardReads=0;
    context.evidence.cards=context.evidence.cards.map(card=>({...card,get cardId(){cardReads++;return card.cardId;}}));
    context.evidence.claims=claims.map(claim=>({...claim,cardRevision:2}));
    const missing=presentGeoAnalysis(selected,{viewId:'V10'},context);
    assert.equal(missing.rows.find(row=>row.dimensions.groupId==='old').values.unknownClaims.value,size);
    assert.ok(cardReads<size*30,`Card identifiers read ${cardReads} times for ${size} unavailable revisions`);
});
