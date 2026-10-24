import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGeoAnalysisView, presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';

const cell = (value, status = 'ok') => ({metricId:'M-01S',scope:'project',engine:null,pool:null,groupId:null,arm:null,variant:null,rival:null,value,status,numerator:value === 0 ? 0 : 1,denominator:2,members:{selectionRef:'gsel_current',metric:{metricId:'M-01S',scope:'project'},total:2,exact:true}});
const selected = () => ({scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_current',dataRevision:'data1',methodVersion:'method1',counts:{snapshots:2}},rows:[],questions:[],rounds:[],computed:{cells:[cell(0)]},comparison:null});
test('the registry refuses unsupported views, arbitrary filters and metrics', () => {
  assert.equal(normalizeGeoAnalysisView({viewId:'V03'}).metricId,'M-01');
  assert.equal(normalizeGeoAnalysisView({viewId:'V08'}).metricId,'M-16');
  assert.equal(normalizeGeoAnalysisView({viewId:'V09'}).metricId,null);
  assert.throws(() => normalizeGeoAnalysisView({viewId:'V08',metricId:'M-19'}));
  assert.throws(() => normalizeGeoAnalysisView({viewId:'V01',sql:'SELECT 1'}));
  assert.throws(() => normalizeGeoAnalysisView({viewId:'V02',metricId:'account_score'}));
});
test('zero remains known, unknown remains null; current, previous and target remain separate', () => {
  const input=selected(); input.computed.cells.push({...cell(null,'insufficient'),metricId:'M-06'});
  const view=presentGeoAnalysis(input,{viewId:'V01'},{targets:{version:1,rows:[{tier:'standard',metricId:'M-01S',pool:'all',target:65}]},tier:'standard'});
  const row=view.rows.find(row=>row.metricId==='M-01S');
  assert.equal(row.values.current.value,0); assert.equal(row.values.current.state,'known');
  assert.equal(row.values.previous.value,null); assert.equal(row.values.target.value,65);
  assert.equal(view.rows.find(row=>row.metricId==='M-06').values.current.state,'insufficient');
  assert.equal(row.values.current.members.selectionRef,input.selection.reference);
});
test('digest excludes read time and paging but includes full data and contextual revisions', () => {
  const input=selected();
  const a=presentGeoAnalysis(input,{viewId:'V01'},{readAt:'2026-10-01',limit:1});
  const b=presentGeoAnalysis(input,{viewId:'V01'},{readAt:'2026-10-02',offset:1});
  assert.equal(a.digest,b.digest); assert.equal(b.page.total,a.page.total);
  assert.notEqual(a.digest,presentGeoAnalysis({...input,selection:{...input.selection,dataRevision:'data2'}},{viewId:'V01'}).digest);
  assert.notEqual(a.digest,presentGeoAnalysis(input,{viewId:'V01'},{targets:{version:2,rows:[]}}).digest);
});
test('frozen export includes every row, exact metadata and typed null states', () => {
  const view=presentGeoAnalysis(selected(),{viewId:'V01'});
  const frozen=freezeGeoAnalysisDocument(view);
  assert.equal(frozen.typedTable.rows.length,view.rows.length);
  assert.equal(frozen.cover.analysis.digest,view.digest);
  assert.equal(frozen.typedTable.rows[0].current,0);
  assert.equal(frozen.typedTable.rows[0].previous,null);
  assert.equal(frozen.typedTable.rows[0].previous_state,'no_data');
});

test('same-named groups retain distinct chart identities and numeric readings',async()=>{
  const {computeGeoSelection}=await import('../src/geoReadScope.mjs');
  const rows=['g1','g2'].flatMap((groupId,index)=>Array.from({length:50},(_,number)=>({snapshotId:groupId+number,questionId:groupId+number,engine:'deepseek',roundKind:'baseline',roundId:'r1',status:'valid',pool:'P2',groupId,isControl:false,citations:[],askedAt:'2026-10-01T00:00:00Z',facts:{brands:index?[{name:'Ours',ours:true,count:1}]:[],statements:[],checks:{judgementCoverage:{status:'complete'}}}})));
  const metricOptions={engines:['deepseek'],samplingMode:'web'};
  const input={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_same',methodVersion:'same',roundIds:['r1'],counts:{}},computed:computeGeoSelection(rows,metricOptions),rounds:[{id:'r1',set_version:1}],rows,metricOptions};
  const view=presentGeoAnalysis(input,{viewId:'V02',metricId:'M-01',dimension:'group'},{groups:[{id:'g1',name:'Same group name'},{id:'g2',name:'Same group name'}]});
  assert.equal(view.chart.series.length,2);
  assert.equal(new Set(view.chart.series.map(series=>series.key)).size,2);
  assert.deepEqual(view.chart.series.map(series=>series.values[0]).sort((a,b)=>a-b),[0,100]);
  assert.equal(view.rows.filter(row=>row.dimensions.period==='day').length,2);
});

test('deterministic reports retain metric scale, numeric states, missing reasons and member units',()=>{
  const input=selected();
  input.computed.cells=[{...cell(null,'not_measurable'),metricId:'M-08',scope:'engine',engine:'baidu',reason:'citations_without_links',numerator:null,denominator:50,members:{...cell(0).members,unit:'answers'}}];
  const view=presentGeoAnalysis(input,{viewId:'V01',dimension:'engine',metricId:'M-08'});
  const frozen=freezeGeoAnalysisDocument(view);
  assert.equal(frozen.typedTable.rows[0].current_reason,'citations_without_links');
  assert.equal(frozen.typedTable.rows[0].metric_unit,'percent');
  assert.match(frozen.canonicalMarkdown,/引用不可测/);
  assert.match(frozen.canonicalMarkdown,/citations_without_links/);
  assert.match(frozen.canonicalMarkdown,/percent/);
  assert.match(frozen.canonicalMarkdown,/answers/);
  assert.match(frozen.canonicalMarkdown,/unknown/);
  for(const [metricId,value,unit,expected] of [['M-01S',0,'percent','0%'],['M-19',12.5,'index','12.5'],['M-07',0,'count','0']]) {
    input.computed.cells=[{...cell(value),metricId}];
    const report=freezeGeoAnalysisDocument(presentGeoAnalysis(input,{viewId:'V01',metricId}));
    assert.equal(report.typedTable.rows[0].metric_unit,unit);
    assert.ok(report.canonicalMarkdown.includes(unit));
    assert.ok(report.canonicalMarkdown.includes(expected));
  }
});
