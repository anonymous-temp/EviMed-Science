import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
import { computeGeoSelection } from '../src/geoReadScope.mjs';
const cite = url => ({url,domain:new URL(url).hostname});
function fixture() {
 const rows=['g1','g2'].flatMap((groupId,g)=>Array.from({length:50},(_,n)=>({snapshotId:`${groupId}-${n}`,questionId:`${groupId}-q${n}`,groupId,pool:'P2',engine:'deepseek',roundId:`r${g+1}`,repeatIndex:0,status:'valid',askedAt:'2026-10-01T00:00:00Z',surface:{mode:'web'},citations:n<25?[cite('https://shared.example/a?x=1')]:[],facts:{retrievalTriggered:n<25,brands:[{name:'Alpha',ours:true,count:n<10?1:0}],statements:[],checks:{judgementCoverage:{status:'complete'}}}})));
 const metricOptions={engines:['deepseek'],samplingMode:'web',owned:{urls:['https://shared.example/a?x=2']}};
 return {scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_d3',dataRevision:'r',methodVersion:'test',engines:['deepseek'],counts:{snapshots:100}},questions:rows.map(row=>({id:row.questionId,group_id:row.groupId,set_version:row.groupId==='g1'?1:2,text:'Original?',original_id:'001'})),rounds:[{id:'r1',set_version:1},{id:'r2',set_version:2}],rows,metricOptions,computed:computeGeoSelection(rows,metricOptions),comparison:null};
}
const ctx=()=>({allRows:true,memberItems:new Map(),groups:[{id:'g1',set_version:1,name:'Same'},{id:'g2',set_version:2,name:'Same'}],sourceAnnotations:[{url:'https://shared.example/a?x=1',relation:'other',origin:'page',reference:{id:'ann',revision:2},basis:'user_annotation',reviewedAt:'2026-10-24T00:00:00Z'}],opportunityLinks:{articles:[{id:'article-old',groupId:'g1',setVersion:1,resultVersionId:'001',claimIds:['claim1']}],claims:[{id:'claim1',version:1,status:'active',verifiedAt:null}],publications:[]}});
test('V20 keeps all five confirmed relationships, exact annotation revision and no brand prerequisite',()=>{
 const selected=fixture();selected.rows.forEach(row=>row.mentionsOurs=false);
 const context=ctx(),view=presentGeoAnalysis(selected,{viewId:'V20'},context);
 assert.equal(view.rows.length,5);
 const other=view.rows.find(row=>row.dimensions.relationship==='other');
 assert.equal(other.values.answers.value,50);assert.equal(other.values.pairs.value,50);
 assert.equal(view.rows.find(row=>row.dimensions.relationship==='own').values.answers.value,0);
 assert.equal(context.memberItems.get(`${other.key}:pairs`)[0].source.pages[0].annotations[0].reference.revision,2);
 assert.ok(view.contextualBasis.some(b=>b.kind==='source_annotations'&&b.temporalBasis==='current_context'));
 const changed=ctx();changed.sourceAnnotations[0].reference.revision=3;
 assert.notEqual(presentGeoAnalysis(selected,{viewId:'V20'},changed).digest,view.digest);
 assert.deepEqual(freezeGeoAnalysisDocument(view).cover.analysis.rows,view.rows);
});
test('V21 exact version/group coordinates use existing M01 and selectable M08S, separate eligible denominators and actual sample bubbles',()=>{
 const selected=fixture(),context=ctx(),view=presentGeoAnalysis(selected,{viewId:'V21',ownedMetricId:'M-08S'},context);
 assert.equal(view.rows.length,2);assert.deepEqual(view.rows.map(r=>r.dimensions.setVersion).sort(),[1,2]);
 const first=view.rows.find(row=>row.dimensions.groupId==='g1');
 assert.equal(first.values.mention.value,20);assert.equal(first.values.owned.value,50,'registered metric normalizes the query but the annotation remains other');
 assert.equal(first.values.mention.metric.metricId,'M-01');assert.equal(first.values.owned.metric.metricId,'M-08S');
 assert.equal(first.values.sample.value,50);assert.equal(first.values.mention.denominator,50);assert.equal(first.values.owned.denominator,50);
 assert.equal(first.dimensions.ownershipBasis,'registered_metric');assert.equal(first.dimensions.gaps.content.items[0].resultVersionId,'001');
 assert.equal(view.rows.find(row=>row.dimensions.groupId==='g2').dimensions.gaps.content.items.length,0);
 assert.equal(view.chart.cells.find(cell=>cell.rowKey===first.key).sampleSize,50);
 assert.equal(context.memberItems.get(`${first.key}:mention`).length,50);
 const document=freezeGeoAnalysisDocument(view);assert.match(document.canonicalMarkdown,/M-08S/);assert.ok(document.typedTable.columns.length<=40);
});
test('V21 M08 uses retrieval eligibility while X keeps valid answer eligibility; no registered own sources leaves Y null',()=>{
 const selected=fixture(),view=presentGeoAnalysis(selected,{viewId:'V21',ownedMetricId:'M-08'},ctx());
 const first=view.rows[0];assert.equal(first.values.mention.denominator,50);assert.equal(first.values.owned.denominator,25);
 selected.metricOptions.owned={};
 const absent=presentGeoAnalysis(selected,{viewId:'V21'},ctx());
 assert.ok(absent.rows.every(row=>row.values.owned.value===null&&row.values.owned.reason==='owned_not_registered'&&row.dimensions.configureAction));
 assert.ok(absent.chart.cells.every(cell=>cell.y===null));assert.equal(absent.rows[0].values.sample.value,50);
});
test('V21 descriptor remains admissible across read, members, freeze and native normalizations',async()=>{
 const {normalizeGeoAnalysisView}=await import('../src/geoAnalysisRegistry.mjs');
 const descriptor=normalizeGeoAnalysisView({viewId:'V21',ownedMetricId:'M-08S'});
 assert.deepEqual(normalizeGeoAnalysisView(descriptor),descriptor);
});
test('D3 human exports retain every measured cell, both denominators and current annotation basis without raw JSON labels',()=>{
 for(const descriptor of [{viewId:'V20'},{viewId:'V21',ownedMetricId:'M-08S'}]){
  const view=presentGeoAnalysis(fixture(),descriptor,ctx()),document=freezeGeoAnalysisDocument(view);
  assert.ok(!document.canonicalMarkdown.includes('"gaps"'));assert.ok(!document.canonicalMarkdown.includes('"recordIndex"'));
  assert.match(document.canonicalMarkdown,/当前.*注释/);
  if(descriptor.viewId==='V21'){assert.match(document.canonicalMarkdown,/M-01/);assert.match(document.canonicalMarkdown,/M-08S/);assert.match(document.canonicalMarkdown,/合资格分母/);}
 }
});
test('publication context requires exact cited URL and retains its pinned article/result identity',()=>{
 const selected=fixture(),context=ctx();context.opportunityLinks.publications=[{id:'matched',url:'https://shared.example/a?x=1',articleId:'article-old',resultVersionId:'old-pin'},{id:'not-cited',url:'https://shared.example/a?x=9',articleId:'article-old',resultVersionId:'001'}];
 const view=presentGeoAnalysis(selected,{viewId:'V21'},context),row=view.rows.find(row=>row.dimensions.groupId==='g1');
 assert.deepEqual(row.dimensions.gaps.source.publications.map(item=>item.id),['matched']);assert.equal(row.dimensions.gaps.source.publications[0].resultVersionId,'old-pin');assert.equal(row.dimensions.gaps.source.publications[0].versionState,'different_from_current_article');
});
test('D3 export splits oversized exact context into bounded typed continuation rows without losing bytes or duplicating numeric cells',()=>{
 const selected=fixture(),context=ctx(),urls=Array.from({length:1001},(_,n)=>`https://shared.example/s?id=${n}`);
 selected.rows[0].citations=urls.map(cite);context.sourceAnnotations=urls.map(url=>({url,relation:'own',origin:'domain',reference:{id:'domain-annotation',revision:1},basis:'user_annotation'}));
 const view=presentGeoAnalysis(selected,{viewId:'V20'},context),document=freezeGeoAnalysisDocument(view),own=view.rows.find(row=>row.dimensions.relationship==='own');
 assert.ok(document.typedTable.rows.length>view.rows.length);assert.ok(document.typedTable.columns.length<=40);
 for(const row of document.typedTable.rows)for(const value of Object.values(row))if(typeof value==='string')assert.ok(value.length<=32767);
 const parts=document.typedTable.rows.filter(row=>row.context_parent===own.key&&row.context_field==='dimensions').sort((a,b)=>Number(a.context_part.split('/')[0])-Number(b.context_part.split('/')[0]));
 assert.deepEqual(JSON.parse(parts.map(row=>row.dimensions).join('')),own.dimensions);
 assert.equal(document.typedTable.rows.filter(row=>row.key===own.key).length,1);assert.equal(document.typedTable.rows.find(row=>row.key===own.key).answers,own.values.answers.value);
});
test('V20 source filters constrain relationship annotations as well as every aggregate',()=>{
 const selected=fixture(),context=ctx();selected.rows[0].citations.push(cite('https://shared.example/a?x=2'));
 context.sourceAnnotations.push({url:'https://shared.example/a?x=2',relation:'own',origin:'page',reference:{id:'outside-filter',revision:1},basis:'user_annotation'});
 const view=presentGeoAnalysis(selected,{viewId:'V20',sourceSearch:'x=1'},context),own=view.rows.find(row=>row.dimensions.relationship==='own');
 assert.equal(own.values.pairs.value,0);assert.deepEqual(own.dimensions.annotationContext.pages,[]);
});
