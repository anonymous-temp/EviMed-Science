import assert from 'node:assert/strict';
import test from 'node:test';
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../src/geoAnalysis.mjs';
const item=(quote,state,conditionQuote=null)=>({quote,entity:'Alpha',state,conditionQuote,claimRefs:[],explicitPosition:null,positionQuote:null});
const row=(id,items,coverage='complete',extra={})=>({snapshotId:id,questionId:'q',roundId:'r',engine:'deepseek',status:'valid',facts:{judgedAt:'2026-10-01',judgeExtract:{recommendationExpressions:{schemaVersion:1,rubric:'geo-recommendation-expression-v1',coverage,items}},checks:{judgementCoverage:{status:'complete'}}},assessmentFacts:{assessmentVersion:'v-'+id,registryKey:'registry',questionVersion:2},...extra});
const selected=rows=>({rows,questions:[{id:'q',set_version:2}],rounds:[{id:'r',set_version:2}],computed:{cells:[]},scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel',methodVersion:'m',engines:['deepseek'],counts:{}}});
test('V09 exclusive expression distribution differs from overlapping distinct-answer counts and keeps exact conditions',()=>{
 const input=selected([row('one',[item('Alpha recommended.','recommended'),item('If adult Alpha recommended.','conditional','If adult'),item('If older Alpha recommended.','conditional','If older')]),row('two',[item('Options Alpha.','mention_only')])]);
 const members=new Map(),view=presentGeoAnalysis(input,{viewId:'V09'},{allRows:true,memberItems:members});
 const conditional=view.rows.find(r=>r.dimensions.category==='conditional'&&r.dimensions.kind==='distribution');
 assert.equal(conditional.values.expressions.value,2);assert.equal(conditional.values.answers.value,1);
 const expressions=view.rows.filter(r=>r.dimensions.kind==='expression');assert.equal(expressions.length,4);
 assert.notEqual(expressions[1].key,expressions[2].key);
 const ref=conditional.values.expressions.members,items=members.get(`${ref.rowKey}:${ref.columnKey}`);
 assert.equal(items.length,2);assert.equal(items[0].assessmentVersion,'v-one');assert.equal(items[0].questionVersion,2);assert.equal(items[0].registryKey,'registry');
 assert.equal(freezeGeoAnalysisDocument(view).typedTable.rows.length,view.rows.length);
});
test('V09 legacy positive passages remain unknown; partial and unjudged preserved extracts are visible without certifying absence',()=>{
 const input=selected([row('partial',[item('Alpha.','mention_only')],'partial',{facts:null,assessmentFacts:{assessmentVersion:'partial-v',judgeExtract:{recommendationExpressions:{schemaVersion:1,rubric:'geo-recommendation-expression-v1',coverage:'partial',items:[item('Alpha.','mention_only')]}}}}),row('legacy',[], 'complete',{facts:{judgedAt:'2026-10-01',judgeExtract:{recommendations:[{text:'Alpha recommended.',entities:['Alpha']}]}}}),row('none',[]),row('refused',[],'complete',{status:'refusal'})]);
 const view=presentGeoAnalysis(input,{viewId:'V09'},{allRows:true});
 assert.equal(view.rows.find(r=>r.dimensions.category==='recommended').values.expressions.value,null);
 assert.equal(view.rows.find(r=>r.dimensions.category==='no_mention').values.answers.value,1);
 assert.equal(view.rows.find(r=>r.dimensions.category==='incomplete').values.answers.value,1);
 assert.equal(view.rows.find(r=>r.dimensions.category==='refused').values.answers.value,1);
 assert.ok(view.rows.some(r=>r.dimensions.legacy&&r.dimensions.category==='unknown'));
 assert.equal(view.availability.status,'partial');
});

 test('V09 keeps legacy string recommendations visible without inventing entity or semantic classification',()=>{
 const input=selected([row('legacy-text',[], 'complete',{facts:{judgeExtract:{recommendations:['Previously preserved positive passage.']}}})]);
 const view=presentGeoAnalysis(input,{viewId:'V09'},{allRows:true});
 const expression=view.rows.find(r=>r.dimensions.kind==='expression');
 assert.equal(expression.dimensions.quote,'Previously preserved positive passage.');
 assert.equal(expression.dimensions.entity,null);assert.equal(expression.dimensions.category,'unknown');
 assert.equal(expression.dimensions.assessmentVersion,'v-legacy-text');
 });

test('V09 missing immutable provenance is a payload digest, never a manufactured assessment version',()=>{const view=presentGeoAnalysis(selected([row('old',[], 'complete',{assessmentFacts:null,facts:{judgeExtract:{recommendations:['Old passage']}}})]),{viewId:'V09'},{allRows:true});const expression=view.rows.find(r=>r.dimensions.kind==='expression');assert.equal(expression.dimensions.assessmentVersion,null);assert.match(expression.dimensions.assessmentPayloadDigest,/^[a-f0-9]{64}$/);});
