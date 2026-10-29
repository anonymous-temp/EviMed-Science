import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGeoSelection } from '../src/geoReadScope.mjs';
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
function fixture() {
  const engines = ['deepseek', 'kimi'];
  const rows = ['g1', 'g2'].flatMap((groupId, g) => engines.flatMap((engine, e) => Array.from({ length: 50 }, (_, n) => ({ snapshotId: `${groupId}-${engine}-${n}`, questionId: `${groupId}-q${n}`, engine, roundId: 'r1', roundKind: 'baseline', repeatIndex: 0, status: 'valid', pool: 'P2', groupId, isControl: false, askedAt: '2026-10-01T00:00:00Z', citations: [], facts: { brands: g === e ? [] : [{ name: 'Ours', ours: true, count: 1 }], statements: [], judgeExtract: { genericMentions: [{ name: 'Generic', count: g === e ? 1 : 0, ours: true }] }, checks: { judgementCoverage: { status: 'complete' } } } }))));
  const metricOptions = { engines, samplingMode: 'web' };
  return { scope: { timeZone: 'Asia/Shanghai' }, selection: { reference: 'gsel_v05', dataRevision: 'one', methodVersion: 'test', roundIds: ['r1'], engines, counts: {} }, rows, questions: [], rounds: [{ id: 'r1', kind: 'baseline', set_version: 1 }], metricOptions, computed: computeGeoSelection(rows, metricOptions), comparison: null };
}
const context = () => ({ allRows: true, groups: [{ id: 'g1', set_version: 1, name: 'Same' }, { id: 'g2', set_version: 1, name: 'Same' }], product: { brandName: 'Ours', genericName: 'Generic' }, memberItems: new Map() });
test('V05 computes exact engine cells for distinct same-named groups', () => {
  const ctx = context(), view = presentGeoAnalysis(fixture(), { viewId: 'V05', metricId: 'M-01', dimension: 'group' }, ctx);
  assert.equal(view.rows.length, 4);
  assert.equal(new Set(view.rows.map(row => row.key)).size, 4);
  assert.deepEqual(view.rows.map(row => row.values.current.value).sort((a, b) => a - b), [0, 0, 100, 100]);
  for (const row of view.rows) {
    const cell = row.values.current;
    assert.equal(cell.metric.denominator, 50);
    assert.equal(cell.members.total, 50);
    assert.equal(cell.members.selectionRef, 'gsel_v05');
    assert.equal(cell.members.expectedDigest, view.digest);
    assert.ok(ctx.memberItems.get(`${row.key}:current`).every(item => item.id.startsWith(`${row.dimensions.groupId}-${row.dimensions.engine}-`)));
  }
  assert.equal(freezeGeoAnalysisDocument(view).cover.analysis.digest, view.digest);
});
test('V04 domain engine cells keep independent denominators, generic observations stay separate', () => {
  const input = fixture();
  input.rows = input.rows.filter(row => row.engine === 'deepseek' || row.groupId === 'g1');
  input.computed = computeGeoSelection(input.rows, input.metricOptions);
  const view = presentGeoAnalysis(input, { viewId: 'V04', metricId: 'M-01' }, context());
  assert.deepEqual(view.rows.map(row => row.values.current.metric.denominator).sort((a, b) => a - b), [50, 100]);
  const generic = presentGeoAnalysis(input, { viewId: 'V04', entityKind: 'generic', entityKey: 'Generic' }, context());
  assert.ok(generic.rows.every(row => row.metricId === null));
  assert.deepEqual(generic.rows.map(row => row.values.mentioned.value).sort((a, b) => a - b), [0, 50]);
  assert.ok(generic.rows.every(row => row.values.eligible.value + row.values.unknown.value === row.values.observed.value));
  assert.throws(() => presentGeoAnalysis(input, { viewId: 'V04', entityKind: 'generic', entityKey: 'Foreign' }, context()));
});
test('round points retain same-day round identity and unknown sampling times', () => {
  const input = fixture();
  input.rows.push(...input.rows.map(row => ({ ...row, snapshotId: `r2-${row.snapshotId}`, roundId: 'r2', askedAt: null })));
  input.rounds.push({ id: 'r2', kind: 'weekly', set_version: 1 });
  input.selection.roundIds.push('r2');
  input.computed = computeGeoSelection(input.rows, input.metricOptions);
  const view = presentGeoAnalysis(input, { viewId: 'V02', metricId: 'M-01', dimension: 'engine', timeGrain: 'round' }, context());
  const points = view.rows.filter(row => row.dimensions.period === 'round');
  assert.equal(points.length, 4);
  assert.equal(view.chart.labels.length, 2);
  assert.equal(new Set(view.chart.labels).size, 2);
  for (const row of points) {
    assert.equal(row.values.current.members.metric.observationRound, row.dimensions.roundId);
    assert.equal(row.values.current.members.total, 100);
    if (row.dimensions.roundId === 'r2')
      assert.equal(row.dimensions.date, null);
  }
});
test('preserved generic aliases remain independent of brand counts and historical identity stays unknown', () => {
  const input = fixture();
  for (const row of input.rows)
    row.facts.judgeExtract.genericMentions = row.engine === 'deepseek' ? [{ name: 'Ours', ours: true, count: 1, matchedNames: ['generic'], productAttributed: false }] : [];
  const view = presentGeoAnalysis(input, { viewId: 'V04', entityKind: 'generic', entityKey: 'Generic' }, context());
  assert.equal(view.rows.find(row => row.dimensions.engine === 'deepseek').values.mentioned.value, 100);
  assert.equal(view.rows.find(row => row.dimensions.engine === 'kimi').values.unknown.value, 100);
  assert.equal(view.rows.find(row => row.dimensions.engine === 'kimi').values.eligible.value, 0);
  const ctx = context();
  ctx.product.genericName = 'Renamed';
  const historical = presentGeoAnalysis(input, { viewId: 'V04', entityKind: 'generic', entityKey: 'Renamed' }, ctx);
  assert.ok(historical.rows.every(row => row.values.unknown.value === 100 && row.values.mentioned.value === 0));
  assert.ok(historical.rows.every(row => row.label.includes('当前配置通用名：Renamed')));
  assert.match(historical.definition.countingRule, /当前配置通用名：Renamed/);
  const report = freezeGeoAnalysisDocument(historical);
  assert.match(report.canonicalMarkdown, /当前名称不代表历史登记/);
  assert.ok(report.typedTable.rows.every(row => row.label.includes('当前配置通用名：Renamed')));

});
test('full chart/export retain rows beyond page 200 and wide typed tables become tidy without dropping columns', () => {
  const input = fixture(), template = input.rows[0];
  input.selection.engines=["deepseek"];
  input.metricOptions.engines=["deepseek"];
  input.rows = Array.from({ length: 250 }, (_, index) => ({ ...template, snapshotId: `wide-${index}`, questionId: `wide-${index}`, groupId: `group-${index}`, engine: 'deepseek' }));
  input.computed = computeGeoSelection(input.rows, input.metricOptions);
  const a = presentGeoAnalysis(input, { viewId: 'V05', metricId: 'M-01' }, { ...context(), limit: 20, allRows: false });
  const b = presentGeoAnalysis(input, { viewId: 'V05', metricId: 'M-01' }, { ...context(), offset: 200, limit: 20, allRows: false });
  const full = presentGeoAnalysis(input, { viewId: 'V05', metricId: 'M-01' }, context());
  assert.equal(full.rows.length, 250);
  assert.equal(a.chart.cells.length, 250);
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, full.digest);
  assert.equal(b.rows.length, 20);
  assert.equal(freezeGeoAnalysisDocument(full).typedTable.rows.length, 250);
  const columns = Array.from({ length: 45 }, (_, index) => ({ key: `column-${index}`, label: `Column ${index}`, type: 'number' }));
  const row = { ...full.rows[0], values: Object.fromEntries(columns.map((column, index) => [column.key, { value: index === 0 ? 0 : null, state: index === 0 ? 'known' : 'unknown', metric: null, members: null }])) };
  const wide = freezeGeoAnalysisDocument({ ...full, columns, rows: [row], page: { total: 1, shown: 1, nextOffset: null } });
  assert.ok(wide.typedTable.columns.length <= 40);
  assert.equal(wide.typedTable.rows.length, 45);
  assert.equal(wide.typedTable.rows[0].value, 0);
  assert.equal(wide.typedTable.rows[44].column_label, 'Column 44');
  assert.equal(wide.typedTable.rows[44].state, '未知');
  assert.equal(wide.typedTable.rows[44].value, null);
});

test('missing platforms stay absent and partial clinical judgment never erases independent generic observations',()=>{
 const input=fixture();input.rows=input.rows.filter(row=>row.engine==='deepseek');for(const row of input.rows){row.facts.checks.judgementCoverage.status='partial';row.facts.judgeExtract.genericMentions=[{name:'Ours',ours:true,count:1,matchedNames:['generic']}];}input.computed=computeGeoSelection(input.rows,input.metricOptions);
 const view=presentGeoAnalysis(input,{viewId:'V04',metricId:'M-01'},context());const absent=view.rows.find(row=>row.dimensions.engine==='kimi');assert.equal(absent.values.current.value,null);assert.equal(absent.values.current.state,'no_data');assert.equal(absent.values.current.members.total,0);
 const generic=presentGeoAnalysis(input,{viewId:'V04',entityKind:'generic',entityKey:'Generic'},context());assert.equal(generic.rows.find(row=>row.dimensions.engine==='deepseek').values.mentioned.value,100);
});

test('platform metric switch delegates standard and derived metrics to the exact one-engine domain computation',()=>{
 for(const metricId of ['M-01S','M-08S','M-09S','M-13','M-14','M-15','M-19','M-20']){
  const view=presentGeoAnalysis(fixture(),{viewId:'V04',metricId},context());assert.ok(view.rows.length>=2,metricId);assert.equal(new Set(view.rows.map(row=>row.key)).size,view.rows.length);assert.ok(view.rows.every(row=>row.values.current.metric.metricId===metricId));
 }
});

test('historical same-named groups retain their actual question-set version in each intersection',()=>{
 const input=fixture();input.rounds.push({id:'r2',set_version:2,kind:'weekly'});input.selection.roundIds.push('r2');input.questions=[];
 for(const row of input.rows){if(row.groupId==='g2')row.roundId='r2';input.questions.push({id:row.questionId,set_version:row.groupId==='g2'?2:1});}input.computed=computeGeoSelection(input.rows,input.metricOptions);
 const ctx=context();ctx.groups[1].set_version=2;const view=presentGeoAnalysis(input,{viewId:'V05',metricId:'M-01'},ctx);
 assert.equal(view.rows.length,4);for(const row of view.rows)assert.equal(row.dimensions.setVersion,row.dimensions.groupId==='g2'?2:1);
});

test('round charts order same-day rounds by observed time rather than newest-first storage or lexical round labels',()=>{
 const input=fixture(),base=input.rows;input.rounds=Array.from({length:12},(_,index)=>({id:`r${index+1}`,kind:'weekly',set_version:1})).reverse();input.selection.roundIds=input.rounds.map(round=>round.id);
 input.rows=input.rounds.flatMap(round=>base.map(row=>({...row,snapshotId:`${round.id}-${row.snapshotId}`,roundId:round.id,askedAt:`2026-10-01T${String(Number(round.id.slice(1))).padStart(2,'0')}:00:00Z`})));
 input.computed=computeGeoSelection(input.rows,input.metricOptions);const view=presentGeoAnalysis(input,{viewId:'V02',metricId:'M-01',timeGrain:'round'},context());
 assert.equal(view.chart.labels.length,12);assert.match(view.chart.labels[1],/第 2 轮/);assert.match(view.chart.labels[9],/第 10 轮/);const points=view.rows.filter(row=>row.dimensions.period==='round');for(const row of points)assert.equal(row.dimensions.roundOrdinal,Number(row.dimensions.roundId.slice(1)));
 const expected=Array.from({length:12},(_,index)=>`r${index+1}`);
 assert.deepEqual([...new Set(points.map(row=>row.dimensions.roundId))],expected);
 assert.deepEqual(points.map(row=>[row.dimensions.roundId,row.dimensions.engine]),expected.flatMap(round=>['deepseek','kimi'].map(engine=>[round,engine])));
 const pages=[];for(let offset=0;offset<view.page.total;offset+=5){const page=presentGeoAnalysis(input,view.view,{...context(),allRows:false,limit:5,offset});assert.equal(page.digest,view.digest);pages.push(...page.rows);}
 assert.deepEqual(pages.map(row=>row.key),view.rows.map(row=>row.key));
 const exported=freezeGeoAnalysisDocument(view);
 // The typed rows keep the chart's round order under the reader's words; the record keeps the exact round of each.
 assert.deepEqual(exported.typedTable.rows.filter(row=>row.period==='轮次').map(row=>row.label),points.map(row=>row.label));
 assert.deepEqual(exported.cover.analysis.rows.filter(row=>row.dimensions.period==='round').map(row=>row.dimensions.roundId),points.map(row=>row.dimensions.roundId));

});

test('chart display metadata preserves exact row state, reason, group/version/pool and member identity',()=>{
 for(const metricId of ['M-01','M-06','M-15']){
  const input=fixture();input.rows=input.rows.filter(row=>row.groupId==='g1'&&row.engine==='deepseek');if(metricId==='M-01')input.rows=input.rows.slice(0,10);if(metricId==='M-15')for(const row of input.rows)row.pool='P4';input.computed=computeGeoSelection(input.rows,input.metricOptions);
  const ctx=context();ctx.groups[0].name='Risk group · 原始分类';const view=presentGeoAnalysis(input,{viewId:metricId==='M-15'?'V05':'V04',metricId},ctx);
  for(const cell of view.chart.cells){
   const row=view.rows.find(row=>row.key===cell.rowKey),value=row.values[cell.columnKey];
   assert.equal(cell.value,value.value);assert.equal(cell.state,value.state);assert.equal(cell.reason,value.reason??null);assert.equal(cell.unit,value.unit);assert.equal(cell.groupName,row.dimensions.groupName);
   assert.deepEqual(cell.members,value.members);assert.equal(cell.members.expectedDigest,view.digest);
   if(metricId==='M-15'){assert.equal(cell.groupName,'Risk group · 原始分类');assert.equal(cell.setVersion,1);assert.equal(cell.pool,'P4');}
  }
  const report=freezeGeoAnalysisDocument(view);assert.equal(report.cover.analysis.digest,view.digest);assert.deepEqual(report.cover.analysis.chart,view.chart);
  const source=view.rows.find(row=>row.dimensions.engine==='deepseek').values.current;
  if(metricId==='M-01'){assert.equal(source.value,0);assert.equal(source.state,'insufficient');assert.equal(source.members.total,10);}
  if(metricId==='M-06'){assert.equal(source.state,'unjudged');assert.equal(source.reason,'not_adjudicated');}
 }
});
