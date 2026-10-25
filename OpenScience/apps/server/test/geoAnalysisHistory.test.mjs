import assert from 'node:assert/strict';
import test from 'node:test';
import {validateGeoMeasurementContract,geoMetricMembers} from '@evimed/domain';
import {computeGeoSelection,geoRoundReadings} from '../src/geoReadScope.mjs';
import {buildGeoHistoryAnalysis} from '../src/geoAnalysisHistory.mjs';

const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'selection',roundIds:['r1','r2']},questions:[{id:'q',group_id:'g',set_version:1}],rounds:[],rows:[
 {snapshotId:'s1',roundId:'r1',questionId:'q',groupId:'g',engine:'deepseek',askedAt:'2026-10-01T00:00:00Z'},
 {snapshotId:'s2',roundId:'r2',questionId:'q',groupId:'g',engine:'deepseek',askedAt:'2026-10-03T00:00:00Z'}]};
const error={id:'error',fingerprint:'fp',statement:'Preserved misstatement',status:'open',judgment_state:'active',engine:'deepseek',first_snapshot_id:'s1',last_snapshot_id:'s2',judgment_history:[{kind:'business_reopened',snapshotId:'s2',previousClosedSnapshotId:'closed',changedAt:'2026-10-04T00:00:00Z'}]};
const signal=(id,extra={})=>({id,revision:1,kind:'error_observed',title:'Recorded issue',basisDigest:id,basis:{errorId:'error',snapshotId:'s1',groupId:'g',questionVersion:1,engine:'deepseek',occurrence:{kind:'first'}},observedAt:'2026-10-01T00:00:00Z',detectedAt:'2026-10-02T00:00:00Z',attempts:[],...extra});
const context=history=>({execution:{history:{errors:[error],signals:[],publication:{articles:[],versions:[],publications:[],orders:[],events:[]},questionSets:[],rounds:[],publicationHistory:[],...history}}});
const objects=view=>view.rows.flatMap(row=>row.dimensions.objects);

test('V15 preserves observed recurrence separately from a completed correction task and current issue',()=>{
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V15'},context({signals:[signal('signal',{attempts:[{contextRef:'ctx',runId:'run',submitted:true,status:'succeeded',executionState:'completed',finishedAt:'2026-10-02T00:00:00Z',createdAt:'2026-10-01T02:00:00Z'}]})]}));
 assert.equal(view.rows.length,1);const row=view.rows[0];assert.equal(row.values.observations.value,2);assert.equal(row.values.recurrences.value,1);assert.equal(row.values.tasks.value,1);
 assert.equal(row.dimensions.currentStatus,'open');assert.equal(objects(view).find(item=>item.kind==='business_reopened').at,'2026-10-03T00:00:00.000Z');
 assert.equal(objects(view).find(item=>item.kind==='task_attempt').executionState,'completed');assert.equal(row.values.closedObservations.value,0);
});
test('a withdrawn judgment with no new sample is a judgment event, not measured correction',()=>{
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V15'},context({errors:[{...error,last_snapshot_id:'s1',judgment_state:'withdrawn',judgment_history:[{kind:'assessment_correction',snapshotId:'s1',changedAt:'2026-10-02T00:00:00Z'}]}]}));
 assert.equal(view.rows[0].values.observations.value,1);assert.equal(view.rows[0].values.judgments.value,1);assert.equal(view.rows[0].values.closedObservations.value,0);
});
test('retained first and last snapshots never invent missing middle occurrence history',()=>{
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V15'},context({errors:[{...error,judgment_history:[]}]}));
 assert.equal(view.rows[0].values.observations.value,2);assert.equal(view.rows[0].values.recurrences.value,0);
 assert.ok(view.availability.reasons.includes('error_history_is_retained_observations'));
});
test('source observation time and detection time stay independent; unknown business time stays undated',()=>{
 const source=signal('source',{kind:'source_changed',observedAt:null,basis:{notice:{id:'notice',kind:'retraction'},groupIds:['g'],targets:[{type:'claim',id:'claim',version:1}]}});
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},context({errors:[],signals:[source]}));
 const item=objects(view)[0];assert.equal(item.at,null);assert.equal(item.detectedAt,'2026-10-02T00:00:00Z');assert.equal(view.chart.timeline.undated,1);assert.equal(view.chart.timeline.events.length,0);
});
test('recorded revisions and exact publication receipts survive later content and publication heads',()=>{
 const publication={articles:[{id:'a',title:'Article',currentResultVersionId:'new'}],versions:[{articleId:'a',resultVersionId:'old',digest:'digest',association:{groupId:'g'},createdAt:'2026-10-01T00:00:00Z'}],publications:[{id:'link',articleId:'a',articleResultVersionId:'new',articleDigest:'new',publishedAt:'2026-10-05T00:00:00Z'}],orders:[],events:[]};
 const receipt={id:'receipt:1',linkId:'link',articleId:'a',resultVersionId:'old',digest:'digest',publishedAt:'2026-10-02T00:00:00Z',recordedAt:'2026-10-03T00:00:00Z',revision:1,basis:'user_reported_update'};
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},context({errors:[],publication,publicationHistory:[receipt]}));
 const record=objects(view).find(item=>item.kind==='publication_update');assert.equal(record.resultVersionId,'old');assert.equal(record.at,'2026-10-02T00:00:00.000Z');assert.equal(record.recordedAt,receipt.recordedAt);
});
test('foreign group signals and wrong engine observations never borrow selected scope',()=>{
 const view=buildGeoHistoryAnalysis({...selected,scope:{...selected.scope,engines:['deepseek']}},{viewId:'V27'},context({errors:[],signals:[signal('other',{basis:{groupId:'other',questionVersion:1}}),signal('engine',{basis:{snapshotId:'other-answer',engine:'kimi',groupId:'g',questionVersion:1}})]}));
 assert.equal(view.rows.length,0);
});
test('immutable group-change events expose actual before and after cohorts without live replacement',()=>{
 const event=signal('group',{kind:'group_changed',basis:{group:{id:'g',questionVersion:1},previous:{id:'old'},current:{id:'r2'},policy:{causal:false,noiseMeasured:false},sides:{before:{selectionRef:'gone'},after:{selectionRef:'current'}}},cohorts:{before:[{snapshotId:'old-answer',questionId:'q',preservedAnswer:{text:'Original old'}}],after:[{snapshotId:'s2',questionId:'q',preservedAnswer:{text:'Original new'}}]}});
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},context({errors:[],signals:[event,event]}));
 assert.equal(objects(view).filter(item=>item.unit==='business_events').length,1);assert.deepEqual(objects(view).filter(item=>item.unit==='history_answer_refs').map(item=>item.preservedAnswer.text),['Original old','Original new']);assert.equal(view.chart.timeline.total,1);
});
test('mode changes use actual completed rounds and their exact predecessor, never a nearest sample',()=>{
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},context({errors:[],rounds:[{id:'r1',finished_at:'2026-10-01T00:00:00Z',surface:{mode:'web'}},{id:'r2',finished_at:'2026-10-03T00:00:00Z',surface:{mode:'raw'}}]}));
 const item=objects(view).find(item=>item.kind==='sampling_mode_changed');assert.equal(item.previousRoundId,'r1');assert.equal(item.roundId,'r2');assert.equal(item.at,'2026-10-03T00:00:00.000Z');
});

test('an engine-filtered selection never relabels a broader preserved group comparison as its own change',()=>{
 const event=signal('group',{kind:'group_changed',basis:{group:{id:'g',questionVersion:1},methods:{before:{engines:['deepseek','kimi']},after:{engines:['deepseek','kimi']}}},cohorts:{before:[{questionId:'q',engine:'deepseek'}],after:[{questionId:'q',engine:'deepseek'}]}});
 const scope={...selected,scope:{...selected.scope,engines:['deepseek']}};
 assert.equal(buildGeoHistoryAnalysis(scope,{viewId:'V27'},context({errors:[],signals:[event]})).rows.length,0);
 event.basis.methods.before.engines=['deepseek'];event.basis.methods.after.engines=['deepseek'];
 assert.equal(buildGeoHistoryAnalysis(scope,{viewId:'V27'},context({errors:[],signals:[event]})).rows.length,1);
});

test('context digests bind real database timestamps rather than the empty Date object shape',()=>{
 const before=context({errors:[],questionSets:[{version:1,created_at:new Date('2026-10-01T00:00:00Z')}]});
 const after=context({errors:[],questionSets:[{version:1,created_at:new Date('2026-10-02T00:00:00Z')}]});
 assert.notEqual(buildGeoHistoryAnalysis(selected,{viewId:'V27'},before).contextualBasis[0].digest,buildGeoHistoryAnalysis(selected,{viewId:'V27'},after).contextualBasis[0].digest);
});

test('a selected middle closure remains visible when the first and latest wrong answers are outside the selection',()=>{
 const historical={...error,first_snapshot_id:'outside-first',last_snapshot_id:'outside-last',closed_snapshot_id:null,judgment_history:[{kind:'business_closed',snapshotId:'s1',changedAt:'2026-10-02T00:00:00Z'}]};
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V15'},context({errors:[historical]}));
 assert.equal(view.rows.length,1);assert.equal(view.rows[0].values.observations.value,0);assert.equal(view.rows[0].values.closedObservations.value,1);assert.equal(view.rows[0].dimensions.currentStatus,'open');
});

test('completed web rounds preserve real single-to-recurring sampling contract changes',()=>{
 const contract=(samplingMode,repeats)=>validateGeoMeasurementContract({samplingMode,repeats,engines:['deepseek'],metricIds:['M-01'],reportPresentation:'summary',sourceBasis:'answers'});
 const before=contract('one_shot',1),after=contract('recurring',3);
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V27'},context({errors:[],rounds:[{id:'r1',finished_at:'2026-10-01T00:00:00Z',surface:{mode:'web',measurementContract:before}},{id:'r2',finished_at:'2026-10-03T00:00:00Z',surface:{mode:'web',measurementContract:after}}]}));
 const event=objects(view).find(item=>item.kind==='sampling_mode_changed');assert.ok(event);assert.equal(event.contractChanged,true);assert.equal(event.surfaceChanged,false);assert.deepEqual(event.beforeContract,before);assert.deepEqual(event.afterContract,after);assert.equal(event.timeBasis,'completed_round_contract_observation');
});

test('V27 M-20 interval and exact members cover the same unbalanced asks as its denominator',()=>{
 const make=(questionId,engine,askedAt)=>({snapshotId:questionId+'-'+engine,questionId,engine,roundId:'r',roundKind:'baseline',repeatIndex:0,status:'valid',pool:'P2',groupId:'g',isControl:false,askedAt,surface:{mode:'web'},citations:[],facts:{brands:[],statements:[],checks:{judgementCoverage:{status:'complete'}}}});
 const rows=Array.from({length:50},(_,n)=>['deepseek','kimi'].map(engine=>make('q'+n,engine,'2026-10-01T00:00:00Z'))).flat();
 rows.push(make('unpaired','deepseek','2026-10-05T00:00:00Z'));
 const metricOptions={engines:['deepseek','kimi'],samplingMode:'recurring'};
 const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_m20',roundIds:['r'],engines:metricOptions.engines},questions:[],rows,rounds:[{id:'r',set_version:1}],metricOptions,computed:computeGeoSelection(rows,metricOptions)};
 const result=buildGeoHistoryAnalysis(selected,{viewId:'V27',metricId:'M-20'},{execution:{history:{}}});
 const computed=geoRoundReadings(selected,'r'),cell=computed.cells.find(c=>c.scope==='project'&&c.metricId==='M-20'&&!c.variant);
 const expected=geoMetricMembers(computed.balance.deduped,cell,metricOptions).rows.map(row=>row.snapshotId).sort();
 const actual=result.rows[0].dimensions.objects.map(row=>row.snapshotId).sort();
 assert.deepEqual(actual,expected);
 assert.equal(result.chart.trend[0].at,'2026-10-05T00:00:00.000Z');
});

test('unknown-time wrong occurrence remains an undated observation, never a dated judgment change',()=>{
 const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'unknown-observation',roundIds:['r']},questions:[{id:'q',group_id:'g',set_version:1}],rounds:[],rows:[{snapshotId:'first',questionId:'q',groupId:'g',roundId:'r',engine:'deepseek',askedAt:'2026-10-01T00:00:00Z'},{snapshotId:'unknown',questionId:'q',groupId:'g',roundId:'r',engine:'deepseek',askedAt:null}]};
 const error={id:'issue',first_snapshot_id:'first',last_snapshot_id:'first',status:'open',judgment_state:'active',judgment_history:[{kind:'wrong_occurrence_time_unknown',snapshotId:'unknown',recordedAt:'2026-10-04T00:00:00Z'}]};
 const row=buildGeoHistoryAnalysis(selected,{viewId:'V15'},{execution:{history:{errors:[error],signals:[]}}}).rows[0];
 assert.equal(row.values.observations.value,2);
 assert.equal(row.values.judgments.value,0);
 assert.equal(row.dimensions.objects.find(item=>item.snapshotId==='unknown').at,null);
});

test('administrative and unrecognized receipts remain separate from measured observations and scientific judgment changes',()=>{
 const receipts=[{kind:'legacy_identity_promoted',proofSnapshotIds:['s1']},{kind:'future_record',recordedAt:'2026-10-02T00:00:00Z'}];
 const view=buildGeoHistoryAnalysis(selected,{viewId:'V15'},context({errors:[{...error,judgment_history:receipts}]}));
 assert.equal(view.rows[0].values.judgments.value,0);assert.equal(view.rows[0].values.observations.value,2);assert.equal(view.rows[0].values.records.value,2);
 assert.deepEqual(objects(view).filter(item=>item.kind==='historical_record').map(item=>item.receipt),receipts);
 assert.equal(objects(view).find(item=>item.receipt?.kind==='legacy_identity_promoted').at,null);
});

test('V27 numbers its round readings oldest first, whatever order the selection holds its rounds in',()=>{
 const make=(round,n,askedAt)=>({snapshotId:`${round}-${n}`,questionId:'q'+n,engine:'deepseek',roundId:round,roundKind:'baseline',repeatIndex:0,status:'valid',pool:'P2',groupId:'g',isControl:false,askedAt,surface:{mode:'web'},citations:[],facts:{brands:[],statements:[],checks:{judgementCoverage:{status:'complete'}}}});
 const rows=[...Array.from({length:3},(_,n)=>make('older',n,'2026-10-01T00:00:00Z')),...Array.from({length:3},(_,n)=>make('newer',n,'2026-10-08T00:00:00Z'))];
 const metricOptions={engines:['deepseek'],samplingMode:'recurring'};
 // The selection reads its rounds newest first (finished_at DESC).
 const rounds=[{id:'newer',set_version:1,finished_at:'2026-10-08T03:00:00Z'},{id:'older',set_version:1,finished_at:'2026-10-01T03:00:00Z'}];
 const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_order',roundIds:['newer','older'],engines:['deepseek']},questions:[],rows,rounds,metricOptions,computed:computeGeoSelection(rows,metricOptions)};
 const readings=buildGeoHistoryAnalysis(selected,{viewId:'V27'},{execution:{history:{}}}).rows.filter(row=>row.dimensions.kind==='history_reading');
 assert.deepEqual(readings.map(row=>[row.label,row.dimensions.roundId]),[['采样第 1 轮','older'],['采样第 2 轮','newer']]);
});
