import assert from 'node:assert/strict';
import test from 'node:test';
import {buildGeoExecutionAnalysis} from '../src/geoAnalysisExecution.mjs';
const selected={rows:[{snapshotId:'selected',questionId:'question',roundId:'round',engine:'deepseek',askedAt:'2026-10-01'}],selection:{reference:'gsel_exact'}};
const error=(id,extra={})=>({id,user_id:'owner',geo_project_id:'geo',fingerprint:id,engine:'deepseek',question_id:'question',first_snapshot_id:'selected',last_snapshot_id:'selected',error_type:'number',severity:'S1',statement:'Preserved error',status:'open',judgment_state:'active',...extra});
const context=rows=>({execution:{errors:rows}});
test('V13 counts complete distinct error objects rather than occurrences or the first page',()=>{
 const rows=Array.from({length:620},(_,i)=>error('e'+i,{error_type:i===619?'dropped_condition':'number',judgment_history:[{kind:'business_reopened',snapshotId:'selected'},{kind:'new_wrong_occurrence',snapshotId:'selected'}]}));
 const view=buildGeoExecutionAnalysis(selected,{viewId:'V13',errorFacet:'type',errorView:'active'},context(rows));
 assert.equal(view.rows.reduce((sum,row)=>sum+row.values.total.value,0),620);
 const rare=view.rows.find(row=>row.dimensions.category==='dropped_condition');assert.equal(rare.values.engine_deepseek.value,1);
 assert.deepEqual(view.memberItems.get(rare.key+':engine_deepseek').map(item=>item.id),['e619']);
 assert.ok(view.rows.every(row=>row.values.total.unit==='error_records'));
});
test('V13 distinguishes withdrawn judgment history from active closed business state and preserves unknown categories',()=>{
 const rows=[error('open'),error('closed',{status:'closed'}),error('withdrawn',{judgment_state:'withdrawn'}),error('unknown',{engine:null,severity:null,error_type:null})];
 const active=buildGeoExecutionAnalysis(selected,{viewId:'V13',errorFacet:'severity',errorView:'active'},context(rows));
 assert.equal(active.rows.reduce((sum,row)=>sum+row.values.total.value,0),3);
 assert.equal(active.rows.reduce((sum,row)=>sum+row.values.unresolved.value,0),2);
 const unknown=active.rows.find(row=>row.dimensions.category==='unknown');assert.equal(unknown.values.engine_unknown.value,1);
 const history=buildGeoExecutionAnalysis(selected,{viewId:'V13',errorFacet:'type',errorView:'withdrawn'},context(rows));
 assert.equal(history.rows[0].values.total.value,1);assert.equal(history.memberItems.get(history.rows[0].key+':total')[0].id,'withdrawn');
});
test('V13 member navigation uses an admitted answer and preserves exact error revision and current condition basis',()=>{
 const raw=error('exact',{first_snapshot_id:'outside',last_snapshot_id:'selected',question_id:'outside-question',error_revision:'saved-revision',claim_id:'claim',claim_version:3,applicability:{population:'Adults',elements:{dose:0},inLabel:false}});
 const view=buildGeoExecutionAnalysis(selected,{viewId:'V13'},context([raw])),item=view.memberItems.get(view.rows[0].key+':total')[0];
 assert.equal(item.snapshotId,'selected');assert.equal(item.questionId,'question');assert.equal(item.recordQuestionId,'outside-question');
 assert.equal(item.errorRevision,'saved-revision');assert.equal(item.claimVersion,null);assert.equal(item.applicability,null);assert.equal(item.originalErrorAssessment,null);assert.equal(item.currentClaim.version,3);assert.deepEqual(item.currentClaim.applicability,raw.applicability);
 assert.equal(item.temporalBasis,'current_error_state_for_selected_answer_links');
});
test('V13 empty and out-of-selection objects never manufacture errors or percentages',()=>{
 const view=buildGeoExecutionAnalysis(selected,{viewId:'V13'},context([error('foreign',{first_snapshot_id:'outside',last_snapshot_id:'outside'})]));
 assert.equal(view.rows.length,0);assert.equal(view.availability.status,'empty');
 assert.ok(view.columns.every(column=>column.unit==='error_records'));
});

test('V13 missing handling state remains unknown rather than being counted as unresolved',()=>{
 const view=buildGeoExecutionAnalysis(selected,{viewId:'V13'},context([error('missing-state',{status:null})])),row=view.rows[0];
 assert.equal(row.values.total.value,1);assert.equal(row.values.unresolved.value,0);assert.equal(row.values.closed.value,0);assert.equal(row.values.statusUnknown.value,1);
});
