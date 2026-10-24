import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
const citation=(url)=>({url,domain:new URL(url).hostname,title:url});
const observation=(snapshotId,citations,extra={})=>({snapshotId,questionId:'q',engine:'deepseek',pool:'P2',roundId:'r1',status:'valid',askedAt:'2026-10-01T00:00:00Z',citations,mentionsOurs:true,failureMode:'wrong_ours',facts:{checks:{judgementCoverage:{status:'partial'}}},...extra});
export function sourceFixture(){
 const rows=[observation('a',Array.from({length:251},(_,n)=>citation(`https://news.example/s?id=${n+1}`))),observation('b',[citation('https://news.example/s?id=251'),citation('http://www.news.example/s?id=251#alias'),citation('https://journal.example/a')],{roundId:'r2',askedAt:null}),observation('refused',[],{status:'refusal'}),observation('linkless',[{domain:'hidden.example'}]),observation('failed',[citation('https://failed.example/a')],{status:'failed'})];
 return {scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_sources',dataRevision:'data',methodVersion:'method',counts:{snapshots:5},timeCoverage:{unknownTime:1}},rows,computed:{balance:{deduped:rows},cells:[]},questions:[],rounds:[{id:'r1',kind:'baseline'},{id:'r2',kind:'weekly'}],comparison:null};
}
const context=()=>({sources:[{id:'news',domain:'news.example',kind:'news',name:'News'},{id:'journal',domain:'journal.example',kind:'medical',name:'Journal'}],allRows:true,memberItems:new Map()});
test('V17 distinct answer union overlaps types and retains full page/pair universe from partial observations',()=>{
 const ctx=context(),view=presentGeoAnalysis(sourceFixture(),{viewId:'V17'},ctx);
 const news=view.rows.find(row=>row.dimensions.sourceType==='news'),medical=view.rows.find(row=>row.dimensions.sourceType==='medical');
 assert.equal(news.values.answers.value,2);assert.equal(news.values.pairs.value,252);assert.equal(news.values.pages.value,251);assert.equal(medical.values.answers.value,1);
 assert.equal(news.values.coverage.value,100);assert.equal(medical.values.coverage.value,50,'type coverage is not a composition');
 assert.equal(ctx.memberItems.get(`${news.key}:pages`).length,251);
 assert.equal(view.definition.knownTimeAnswers,1);assert.equal(view.definition.unknownTimeAnswers,1);
 assert.equal(view.definition.refusedAnswers,1);assert.equal(view.definition.linklessAnswers,1);
 assert.equal(news.values.answers.members.total,2);assert.match(view.definition.countingRule,/partial/i);
});
test('V18 all actual URLs rank before paging, preserve query-distinct pages and original aliases',()=>{
 const selected=sourceFixture(),ctx=context(),full=presentGeoAnalysis(selected,{viewId:'V18',sourceLevel:'page'},ctx);
 assert.equal(full.page.total,252);assert.equal(full.rows[0].dimensions.sourceKey,'news.example/s?id=251');assert.equal(full.rows[0].values.answers.value,2);
 assert.deepEqual(full.rows[0].dimensions.originalUrls,['http://www.news.example/s?id=251#alias','https://news.example/s?id=251']);
 const paged=presentGeoAnalysis(selected,{viewId:'V18',sourceLevel:'page'},{...context(),allRows:false,limit:50,offset:250});
 assert.equal(paged.rows.length,2);assert.equal(paged.digest,full.digest);assert.ok(full.rows.some(row=>row.dimensions.sourceKey==='news.example/s?id=1'));
 const frozen=freezeGeoAnalysisDocument(full);assert.equal(frozen.typedTable.rows.length,252);assert.match(frozen.canonicalMarkdown,/s\?id=251/);
});
test('V18 numeric buckets retain exact answer/source contexts, selected actual history and top-N complete remainder',()=>{
 const ctx=context(),view=presentGeoAnalysis(sourceFixture(),{viewId:'V18',topN:1},ctx),news=view.rows.find(row=>row.dimensions.domain==='news.example');
 assert.equal(news.values.answers.value,2);assert.equal(news.values.pages.value,251);assert.equal(news.values.wrong.value,2);assert.equal(news.values.unknownTime.value,1);
 assert.deepEqual(news.dimensions.history.map(row=>[row.roundId,row.citedAnswers]),[['r1',1],['r2',1]]);
 const items=ctx.memberItems.get(`${news.key}:answers`);assert.equal(items[0].source.pages.length,251);assert.equal(items[0].judgment.checks.judgementCoverage.status,'partial');
 assert.equal(view.chart.cells.at(-1).label,'其余来源');assert.equal(view.chart.cells.at(-1).value,1);assert.equal(view.chart.denominator,253);assert.equal(view.chart.cells.reduce((sum,cell)=>sum+cell.value,0),253);
 assert.equal(view.chart.cells.at(-1).members.total,1);assert.match(view.definition.denominatorRule,/co-occurrence/i);
});
test('actual type/search/relationship filters apply before all aggregates and unknown type remains',()=>{
 const input=sourceFixture();input.rows.push(observation('unknown',[citation('https://unknown.example/a')],{failureMode:null,mentionsOurs:false}));
 const unknown=presentGeoAnalysis(input,{viewId:'V17',sourceType:'unknown'},context());assert.equal(unknown.rows.length,1);assert.equal(unknown.rows[0].values.answers.value,1);
 const searched=presentGeoAnalysis(input,{viewId:'V18',sourceSearch:'id=251',sourceRelationship:'wrong'},context());assert.equal(searched.rows.length,1);assert.equal(searched.rows[0].values.pages.value,1);assert.equal(searched.chart.denominator,2);
 const filtered=presentGeoAnalysis(input,{viewId:'V17',sourceType:'medical',sourceRelationship:'mentions'},context());assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].values.answers.value,1);
 assert.notEqual(filtered.digest,unknown.digest);
});
