import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGeoSelection } from '../src/geoReadScope.mjs';
import { compareGeoMetricCohorts } from '../src/geoComparison.mjs';
import { presentGeoAnalysis } from '../src/geoAnalysis.mjs';
import { brandRegistry, registryKey } from '../src/geoParse.mjs';
const product = { brandName: 'Ours' }, competitors = [{ id: 'saved-rival', brandName: 'Rival', aliases: ['R alias'] }, { id: 'generic-only', genericName: 'Generic' }];
function cohort(prefix, proportion = 0) {
    const options = { engines: ['deepseek'], samplingMode: 'web', competitors: ['Rival'], owned: {} };
    const rows = Array.from({ length: 50 }, (_, n) => ({ snapshotId: `${prefix}-${n}`, questionId: `q${n}`, engine: 'deepseek', roundId: prefix, roundKind: 'baseline', repeatIndex: 0, status: 'valid', pool: 'P2', groupId: 'g', askedAt: `2026-10-0${prefix === 'old' ? 1 : 2}T00:00:00Z`, surface: { mode: 'web' }, citations: [], facts: { registryKey: registryKey(brandRegistry(product, competitors), {}), parserVersion: 'p1', judgedAt: '2026-10-01', brands: [{ name: 'Ours', ours: true, count: n < proportion ? 1 : 0 }, { name: 'Rival', competitor: true, count: n < 10 ? 1 : 0 }], statements: [], checks: { judgementCoverage: { status: 'complete' } } } }));
    return { scope: { timeZone: 'Asia/Shanghai' }, selection: { reference: `gsel_${prefix}`, methodVersion: 'v1', dataRevision: prefix, counts: {}, engines: ['deepseek'], comparability: { samplingContracts: [null], methodVersions: ['v1'] } }, rows, computed: computeGeoSelection(rows, options), metricOptions: options, rounds: [{ id: prefix, kind: 'baseline', set_version: 1, ref: { evaluationBasis: { product, competitors, owned: {} } } }], questions: [], comparison: null };
}
function compared(current, previous, mode = 'common') { const cells = compareGeoMetricCohorts(current, previous, { mode, commonCount: 50 }); current.comparison = { mode, cells, currentSelection: current.selection, previousSelection: previous.selection, excluded: { current: 2, previous: 3 } }; Object.defineProperty(current.comparison, 'cohorts', { value: { current, previous }, enumerable: false }); return current; }
const context = () => ({ allRows: true, product, competitors, memberItems: new Map() });
test('V03 ranks comparable zero-to-twenty by percentage points with two exact period members', () => {
    const current = compared(cohort('now', 10), cohort('old', 0)), ctx = context();
    const view = presentGeoAnalysis(current, { viewId: 'V03', metricId: 'M-01', dimension: 'engine' }, ctx), row = view.rows[0];
    assert.equal(row.values.previous.value, 0);
    assert.equal(row.values.current.value, 20);
    assert.equal(row.values.delta.value, 20);
    assert.equal(row.values.delta.unit, 'percentage_points');
    assert.equal(row.values.rank.value, 1);
    assert.equal(row.values.previous.members.total, 50);
    assert.ok(ctx.memberItems.get(`${row.key}:previous`).every(item => item.snapshotId.startsWith('old-')));
    assert.ok(ctx.memberItems.get(`${row.key}:current`).every(item => item.snapshotId.startsWith('now-')));
    assert.equal(row.values.currentEligible.value, 50);
    assert.equal(row.values.currentExcluded.value, 2);
});
test('V03 preserves unranked missing comparison and changed method, membership, modes, and M19 ingredient basis', () => {
    const none = presentGeoAnalysis(cohort('now'), { viewId: 'V03', metricId: 'M-01' }, context());
    assert.ok(none.rows.length);
    assert.equal(none.rows[0].values.delta.value, null);
    assert.ok(none.availability.reasons.includes('comparison_not_selected'));
    for (const change of ['method', 'members', 'mode', 'pool', 'contract', 'm19']) {
        const a = cohort('now', 10), b = cohort('old');
        if(change==='pool')for(const row of b.rows)row.pool='P3';
        if(change==='contract')b.selection.comparability.samplingContracts=[{samplingMode:'one_shot',repeats:1,metricIds:['M-01']}];
        if (change === 'method')
            b.selection.methodVersion = 'v2';
        if (change === 'members')
            b.rows[0].questionId = 'changed';
        if (change === 'mode')
            b.rows[0].surface.mode = 'inclusion';
        if (change === 'm19')
            for (const row of b.rows)
                row.facts.checks.judgementCoverage.status = 'partial';
        b.computed = computeGeoSelection(b.rows, b.metricOptions);
        const view = presentGeoAnalysis(compared(a, b), { viewId: 'V03', metricId: change === 'm19' ? 'M-19' : 'M-01', dimension: 'project' }, context());
        assert.ok(view.rows.length, change);
        assert.equal(view.rows[0].values.delta.value, null, change);
        assert.equal(view.rows[0].values.rank.value, null, change);
        assert.ok(view.rows[0].values.delta.reason, change);
    }
});
test('V08 fixed registry retains pool denominators, aliases, generic separation and unknown legacy history', () => {
    const input = cohort('now', 10);
    input.rounds.push(...cohort('other', 0).rounds);
    input.rows.push(...cohort('other', 0).rows.slice(0, 25).map(row => ({ ...row, snapshotId: `P3-${row.snapshotId}`, questionId: `P3-${row.questionId}`, pool: 'P3', facts: { ...row.facts, brands: [{ name: 'R alias', competitor: true, count: 1 }, { name: 'Rival', competitor: true, count: 1 }] } })));
    input.computed = computeGeoSelection(input.rows, input.metricOptions);
    const view = presentGeoAnalysis(input, { viewId: 'V08' }, context());
    const rivals = view.rows.filter(row => row.dimensions.entityKey === 'saved-rival' && row.dimensions.period === 'selected');
    assert.equal(rivals.length, 2);
    assert.deepEqual(rivals.map(row => row.values.current.metric.denominator).sort((a, b) => a - b), [25, 50]);
    assert.deepEqual(rivals.map(row => row.values.current.metric.numerator).sort((a, b) => a - b), [10, 25]);
    assert.equal(view.rows.filter(row => row.dimensions.entityKey === 'generic-only').every(row => row.metricId === null), true);
    const legacy = cohort('old');
    for (const row of legacy.rows)
        delete row.facts.registryKey;
    legacy.computed = computeGeoSelection(legacy.rows, legacy.metricOptions);
    const unknown = presentGeoAnalysis(legacy, { viewId: 'V08' }, context()).rows.find(row => row.dimensions.entityKey === 'saved-rival');
    assert.equal(unknown.values.current.value, null);
    assert.equal(unknown.values.current.state, 'unknown');
    assert.equal(unknown.values.unknown.value, 50);
});
test('V08 M17 requires exact recorded share agreement and reports relative selected-set mentions', () => {
    const input = cohort('now', 10);
    assert.ok(presentGeoAnalysis(input, { viewId: 'V08', metricId: 'M-17' }, context()).rows.every(row => row.values.current.value === null));
    input.rounds[0].surface = { measurementContract: { metricIds: ['M-17'] } };
    const view = presentGeoAnalysis(input, { viewId: 'V08', metricId: 'M-17' }, context());
    assert.match(view.definition.countingRule, /所选回答.*声量份额/);
    assert.ok(view.rows.find(row => row.dimensions.entityKey === 'saved-rival').values.current.value !== null);
});
test('V08 pairs own readings on each rival exact eligible cohort when the saved registry expands', () => {
    const input = cohort('now', 10), old = cohort('old', 0);
    old.rounds[0].ref.evaluationBasis = { product, competitors: [], owned: {} };
    for (const row of old.rows)
        row.facts.registryKey = registryKey(brandRegistry(product, []), {});
    input.rows.push(...old.rows);
    input.rounds.push(...old.rounds);
    input.computed = computeGeoSelection(input.rows, input.metricOptions);
    const view = presentGeoAnalysis(input, { viewId: 'V08' }, context()), own = view.rows.find(row => row.dimensions.own && row.dimensions.period === 'selected'), rival = view.rows.find(row => row.dimensions.entityKey === 'saved-rival' && row.dimensions.period === 'selected');
    assert.equal(own.values.current.metric.denominator, 100);
    assert.equal(own.values.current.value, 10);
    assert.equal(rival.values.current.metric.denominator, 50);
    assert.equal(rival.values.pairedOwn.metric.denominator, 50);
    assert.equal(rival.values.pairedOwn.value, 20);
    assert.equal(rival.values.unknown.value, 50);
});
test('V08 preserves one-sample zero as insufficient, legacy positive observations, and exact version dependencies', () => {
    const input = cohort('now', 0);
    input.rows = input.rows.slice(30, 31);
    input.computed = computeGeoSelection(input.rows, input.metricOptions);
    const view = presentGeoAnalysis(input, { viewId: 'V08' }, context()), rival = view.rows.find(row => row.dimensions.entityKey === 'saved-rival');
    assert.equal(rival.values.current.value, 0);
    assert.equal(rival.values.current.state, 'insufficient');
    assert.equal(rival.values.current.metric.numerator, 0);
    assert.equal(rival.values.current.metric.denominator, 1);
    const first = view.digest;
    input.rows[0].facts.parserVersion = 'changed-parser';
    assert.notEqual(presentGeoAnalysis(input, { viewId: 'V08' }, context()).digest, first);
    const legacy = cohort('old', 0);
    delete legacy.rounds[0].ref;
    const oldView = presentGeoAnalysis(legacy, { viewId: 'V08' }, context()), oldRival = oldView.rows.find(row => row.dimensions.entityKey === 'saved-rival');
    assert.equal(oldRival.values.current.value, null);
    assert.equal(oldRival.values.mentioned.value, 10);
    assert.equal(oldRival.values.unknown.value, 50);
});
test('V08 fixed aliases remain identifiable through saved keys after a registered display-name change', () => {
    const input = cohort('now', 10), ctx = context();
    ctx.competitors = [{ ...competitors[0], brandName: 'Renamed' }, competitors[1]];
    const view = presentGeoAnalysis(input, { viewId: 'V08' }, ctx), row = view.rows.find(row => row.dimensions.entityKey === 'saved-rival');
    assert.equal(row.values.current.metric.numerator, 10);
    assert.equal(row.values.current.metric.denominator, 50);
    assert.equal(row.dimensions.temporalBasis, 'recorded');
    assert.equal(row.dimensions.entityName, 'Renamed');
    assert.throws(() => presentGeoAnalysis(input, { viewId: 'V08', entityKey: 'answer-discovered-name' }, ctx));
});

test('V03 unchanged zero stays a ranked zero difference and M19 rejects changed ingredient members',()=>{
 const a=cohort('now',0),b=cohort('old',0),zero=presentGeoAnalysis(compared(a,b),{viewId:'V03',metricId:'M-01'},context()).rows[0];assert.equal(zero.values.delta.value,0);assert.equal(zero.values.rank.value,1);
 const current=cohort('now',10),previous=cohort('old',10);for(const input of [current,previous]){for(const row of input.rows)row.facts.statements=[{text:'Retained statement',verdict:'correct'}];input.computed=computeGeoSelection(input.rows,input.metricOptions);}previous.rows[0].facts.statements[0].verdict='unknown';previous.computed=computeGeoSelection(previous.rows,previous.metricOptions);
 const gvi=presentGeoAnalysis(compared(current,previous),{viewId:'V03',metricId:'M-19',dimension:'project'},context()).rows[0];assert.equal(gvi.values.delta.value,null);assert.equal(gvi.values.rank.value,null);assert.equal(gvi.values.delta.reason,'comparison_basis_changed');
});
