import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupChangeEvents, GROUP_CHANGE_POLICY } from '../src/geoGroupChanges.mjs';
import { GEO_MEASUREMENT_METHOD_VERSION } from '@evimed/domain';
const row = (snapshotId, n) => ({snapshotId,questionId:`q${n}`,groupId:'g',pool:'P2',engine:'deepseek',repeatIndex:0,surface:{mode:'web'},status:'valid',facts:{mentionsOurs:true}});
function selection(id, value) {
 const rows=Array.from({length:20},(_,n)=>row(`${id}-${n}`,n));
 const cell={metricId:'M-01',scope:'group',groupId:'g',pool:'P2',engine:null,arm:null,variant:null,rival:null,status:'ok',value,numerator:value/5,denominator:20,unit:'percent'};
 return {rows,computed:{cells:[cell],balance:{rows,deduped:rows}},metricOptions:{samplingMode:'recurring'},rounds:[{id,set_version:1,ref:{balance:{engines:['deepseek']}},engines:['deepseek'],finished_at:'2026-10-25T01:00:00Z'}],questions:[],selection:{reference:`ref-${id}`,dataRevision:id,methodVersion:GEO_MEASUREMENT_METHOD_VERSION,engines:['deepseek'],counts:{},comparability:{methodVersions:[GEO_MEASUREMENT_METHOD_VERSION],questionVersions:[1],samplingContracts:[{samplingMode:'recurring',repeats:1,sourceBasis:'answers',reportPresentation:'summary',engines:['deepseek'],metricIds:['M-01']}],modes:['web'],samplingModes:['recurring']}}};
}
test('group policy screens existing comparable group rates and preserves exact sides',()=>{
 const previous=selection('a',20),current=selection('b',40);
 const pair={previous,current,commonKeys:previous.rows.map(r=>JSON.stringify([r.questionId,r.engine,'web']))};
 const result=groupChangeEvents(pair);
 assert.equal(result.events.length,1);
 const event=result.events[0];
 assert.equal(event.kind,'group_changed');assert.equal(event.basis.cells[0].delta,20);
 assert.equal(event.basis.sides.before.targets.length,20);assert.equal(event.basis.sides.after.targets.length,20);
 assert.equal(GROUP_CHANGE_POLICY.noiseMeasured,false);
 assert.equal(groupChangeEvents({...pair,current:selection('b',25)}).events.length,0);
 const unknown=selection('b',40);unknown.selection.comparability.methodVersions=[null];
 assert.equal(groupChangeEvents({...pair,current:unknown}).events.length,0);
 const changed=selection('b',40);changed.rows[0].questionId='changed';
 assert.equal(groupChangeEvents({...pair,current:changed}).events.length,0);
});

test('strict rounded screen excludes both boundary signs and preserves narrow immutable identity',()=>{
 const previous=selection('a',40);
 const result=value=>groupChangeEvents({previous,current:selection('b',value),commonKeys:['common']});
 for(const value of [35,45])assert.equal(result(value).events.length,0);
 for(const value of [34.99,45.01])assert.equal(result(value).events.length,1);
 const original=result(60).events[0];const renamed=selection('b',60);
 renamed.questions=[{group_id:'g',group_name:'Changed label'}];renamed.selection.dataRevision='unrelated revision';
 renamed.rounds[0].finished_at='2026-10-26T00:00:00Z';
 assert.equal(groupChangeEvents({previous,current:renamed,commonKeys:['common']}).events[0].eventVersion,original.eventVersion);
 const noContracts=selection('b',60);noContracts.selection.comparability.samplingContracts=[null];
 assert.equal(groupChangeEvents({previous,current:noContracts,commonKeys:['common']}).events.length,0);
 const missingEngine=selection('b',60);missingEngine.rounds[0].ref.balance.engines=[];
 assert.equal(groupChangeEvents({previous,current:missingEngine,commonKeys:['common']}).events.length,0);
 assert.equal(groupChangeEvents({previous,current:selection('b',60),commonKeys:[]}).events.length,0);
});

test('a valid measurement agreement is enforced for metrics, actual engines and complete repeated samples',()=>{
 const make=()=>({previous:selection('a',20),current:selection('b',40),commonKeys:['common']});
 for(const change of [contract=>delete contract.reportPresentation,contract=>contract.sourceBasis='invalid',contract=>contract.metricIds=['M-06'],contract=>contract.engines=['kimi'],contract=>contract.repeats=20]){
  const pair=make();for(const selected of [pair.previous,pair.current])change(selected.selection.comparability.samplingContracts[0]);
  assert.equal(groupChangeEvents(pair).events.length,0);
 }
 const missing=make();missing.current.rows[0].repeatIndex=1;assert.equal(groupChangeEvents(missing).events.length,0);
 const complete=make();for(const selected of [complete.previous,complete.current]){
  selected.selection.comparability.samplingContracts[0].repeats=2;selected.rows.push(...selected.rows.map(row=>({...row,snapshotId:row.snapshotId+'-repeat',repeatIndex:1})));
 }
 assert.equal(groupChangeEvents(complete).events.length,1);
});
