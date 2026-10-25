import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGeoFinanceAnalysis } from '../src/geoAnalysisFinance.mjs';
import { geoLedgerBalances } from '../src/geoDistributionMoney.mjs';

const selected = {scope:{timeZone:'Asia/Shanghai'},selection:{reference:'current',memberDigest:'current-digest'},questions:[{id:'q',group_id:'g',set_version:2}],rows:[],computed:{cells:[]}};
const entries = [['01','budget_set',500,null],['02','reserve',100,'order'],['03','settle',80,'order'],['04','release',20,'order'],['05','refund',10,'order']]
  .map(([id,kind,amountCny,orderId])=>({id,kind,amountCny,orderId,createdAt:`2026-10-${String(Number(id)+1).padStart(2,'0')}T00:00:00.000Z`}));
const timeline=geoLedgerBalances(entries);
const finance={ledger:{items:timeline.entries,opening:timeline.opening,summary:{budgetCny:9000},currency:'CNY'},orders:[{id:'order',articleId:'a',articleResultVersionId:'v1',articleDigest:'a'.repeat(64)}],versions:[{articleId:'a',resultVersionId:'v1',digest:'a'.repeat(64),association:{groupId:'g'}}]};
const context={groups:[{id:'g',name:'Selected group',set_version:2}],execution:{finance}};

test('ledger amounts keep every financial kind separate and historical balances ignore today’s budget',()=>{
 const result=buildGeoFinanceAnalysis(selected,{viewId:'V25'},context);
 assert.equal(result.rows.length,5);
 const refund=result.rows.find(row=>row.dimensions.ledgerKind==='refund');
 assert.equal(refund.values.amountCny.value,10);assert.equal(refund.values.reservedCny.value,0);
 assert.equal(refund.values.settledCny.value,80);assert.equal(refund.values.refundedCny.value,10);
 assert.equal(refund.values.spentCny.value,70);assert.equal(refund.values.availableCny.value,430);assert.equal(refund.values.budgetCny.value,500);
 assert.deepEqual(result.memberItems.get(refund.key+':amountCny').map(item=>item.objectId),['05']);
 assert.equal(result.contextualBasis[0].currentSummary.budgetCny,9000);
 assert.equal(refund.dimensions.objects[0].associationQuestionVersion,null);
});

test('date bounds retain the full prefix, while group views separate budget and unattributed costs',()=>{
 const scope={...selected,scope:{...selected.scope,from:'2026-10-05',to:'2026-10-06'}};
 const result=buildGeoFinanceAnalysis(scope,{viewId:'V25'},context);
 assert.equal(result.rows.length,2);assert.equal(result.contextualBasis[0].opening.reservedCny,20);assert.equal(result.contextualBasis[0].opening.settledCny,80);
 const unknown={...entries[1],id:'unknown',orderId:'missing',balance:timeline.entries[1].balance};
 const unknownContext={...context,execution:{finance:{...finance,ledger:{...finance.ledger,items:[...finance.ledger.items,unknown]}}}};
 const grouped=buildGeoFinanceAnalysis(selected,{viewId:'V25',financeFacet:'group'},unknownContext);
 const group=grouped.rows.find(row=>row.dimensions.groupId==='g');
 assert.equal(group.values.reserveCny.value,100);assert.equal(group.values.settleCny.value,80);assert.equal(group.values.releaseCny.value,20);assert.equal(group.values.refundCny.value,10);
 assert.equal(grouped.rows.find(row=>row.dimensions.attribution==='global_budget').values.budgetCny.value,500);
 assert.equal(grouped.rows.find(row=>row.dimensions.attribution==='unassigned').values.reserveCny.value,100);
 assert.equal(group.values.budgetCny.value,null);assert.equal(grouped.availability.status,'partial');
});

test('foreign or changed version identities cannot borrow group attribution, recharge cannot become project spend',()=>{
 const rows=[...finance.ledger.items,{id:'recharge',kind:'recharge',orderId:null,amountCny:1000,createdAt:'2026-10-06'}];
 const changed={...context,execution:{finance:{...finance,ledger:{...finance.ledger,items:rows},versions:[{...finance.versions[0],digest:'b'.repeat(64)}]}}};
 const result=buildGeoFinanceAnalysis(selected,{viewId:'V25',financeFacet:'group'},changed);
 assert.equal(result.rows.some(row=>row.dimensions.groupId==='g'),false);
 assert.equal(result.rows.some(row=>row.dimensions.objects.some(item=>item.objectId==='recharge')),false);
 assert.equal(result.rows.find(row=>row.dimensions.attribution==='unassigned').values.settleCny.value,80);
});

const frozenCell={metricId:'M-01',scope:'project',pool:null,value:25,numerator:1,denominator:4,status:'ok',memberReference:'old-selection',memberDigest:'old-members',memberCount:4};
const target={tier:'2',metricId:'M-01',pool:'all',baseline:20,target:60,budgetCny:1200,placements:null,horizonWeeks:8,dataType:'forecast'};
const plan={version:1,scopeKey:'old-scope',basisDigest:'old-basis',readingsKind:'frozen_basis',freshness:{stale:true,reasons:['selection_changed']},basis:{selection:{reference:'old-selection'},scope:{questionVersion:1},groups:[{id:'g',setVersion:1}],targets:{version:2,rows:[target]},readings:{baseline:null,selected:{cells:[frozenCell]}},priceReferences:[{currency:'CNY',price:80}]},assumptions:['Cost is estimated'],tiers:[{tier:'2',budgetRange:[1000,1400]}]};

test('frozen target, written baseline and historical measured baseline stay separate from current cells',()=>{
 const current={...selected,computed:{cells:[{...frozenCell,value:75,numerator:3,memberReference:undefined,memberDigest:undefined}]}};
 const result=buildGeoFinanceAnalysis(current,{viewId:'V26',strategyVersion:1,targetVersion:2},{execution:{finance:{plan}}});
 const row=result.rows[0];
 assert.equal(row.values.frozenBaseline.value,25);assert.equal(row.values.recordedBaseline.value,20);assert.equal(row.values.current.value,75);assert.equal(row.values.target.value,60);
 assert.equal(row.values.budgetCny.unit,'CNY');assert.equal(row.values.placements.value,null);assert.equal(row.values.placements.state,'unknown');
 const frozen=result.memberItems.get(row.key+':frozenBaseline')[0];assert.equal(frozen.memberReference,'old-selection');assert.equal(frozen.memberDigest,'old-members');
 assert.equal(result.contextualBasis[0].basisDigest,'old-basis');assert.deepEqual(result.contextualBasis[0].costAssumptions,['Cost is estimated']);
 assert.equal(result.contextualBasis[0].currentSelection.reference,'current');
});

test('missing historical readings never borrow current values, and absent plans stay unavailable',()=>{
 const result=buildGeoFinanceAnalysis({...selected,computed:{cells:[{...frozenCell,value:99}]}},{viewId:'V26'},{execution:{finance:{plan:{...plan,basis:{...plan.basis,readings:{selected:{cells:[]}}}}}}});
 assert.equal(result.rows[0].values.frozenBaseline.value,null);assert.equal(result.rows[0].values.current.value,99);
 assert.equal(result.availability.status,'partial');
 const missing=buildGeoFinanceAnalysis(selected,{viewId:'V26'},{execution:{finance:{plan:null}}});assert.equal(missing.rows.length,0);assert.equal(missing.availability.status,'unavailable');
 assert.throws(()=>buildGeoFinanceAnalysis(selected,{viewId:'V26',targetVersion:99},{execution:{finance:{plan}}}),error=>error.status===409);
});

test('complete populations are bounded before any partial aggregation',()=>{
 assert.throws(()=>buildGeoFinanceAnalysis(selected,{viewId:'V25'},{execution:{finance:{...finance,ledger:{items:Array.from({length:20001},(_,n)=>({...entries[0],id:String(n)}))}}}}),error=>error.status===422);
});

test('every group amount kind uses the authoritative two-decimal CNY precision',()=>{
 for(const [kind,column] of [['reserve','reserveCny'],['release','releaseCny'],['settle','settleCny'],['refund','refundCny']]){
  const items=[0.1,0.2].map((amountCny,index)=>({...entries[1],id:`${kind}-${index}`,kind,amountCny}));
  const grouped=buildGeoFinanceAnalysis(selected,{viewId:'V25',financeFacet:'group'},{...context,execution:{finance:{...finance,ledger:{...finance.ledger,items}}}});
  assert.equal(grouped.rows[0].values[column].value,0.3,kind);
  assert.equal(grouped.chart.cells.find(cell=>cell.columnKey===column).value,0.3,kind);
  assert.deepEqual(grouped.memberItems.get(`${grouped.rows[0].key}:${column}`).map(item=>item.amountCny),[0.1,0.2]);
 }
});

test('historical paid pins survive observation changes, while only established explicit mismatches exclude them',()=>{
 const historic={...selected,questions:[{id:'new-q',group_id:'new-g',set_version:3}],scope:{...selected.scope,round:'new-round'}};
 const association={groupId:'g',questionVersion:1,pool:'P2',clientTags:['client-old']};
 const historicalContext={groups:[],execution:{finance:{...finance,versions:[{...finance.versions[0],association}]}}};
 const all=buildGeoFinanceAnalysis(historic,{viewId:'V25'},historicalContext);
 assert.equal(all.rows.length,5);assert.ok(all.rows.some(row=>row.dimensions.groupId==='g'));
 const old=all.rows.find(row=>row.dimensions.groupId==='g');assert.equal(old.dimensions.groupContext,'historical_association_current_metadata_unavailable');assert.match(old.label,/历史关联问题群/);
 for(const scope of [{groupIds:['new-g']},{questionVersion:3},{pools:['P3']},{clientTags:['client-new']}]){
  const result=buildGeoFinanceAnalysis({...historic,scope:{...historic.scope,...scope}},{viewId:'V25'},historicalContext);
  assert.deepEqual(result.rows.map(row=>row.dimensions.ledgerKind),['budget_set']);
 }
 const unknown={...historicalContext,execution:{finance:{...historicalContext.execution.finance,versions:[{...finance.versions[0],association:{groupId:'g'}}]}}};
 const retained=buildGeoFinanceAnalysis({...historic,scope:{...historic.scope,pools:['P3'],clientTags:['unrecorded'],questionVersion:3}},{viewId:'V25'},unknown);
 assert.equal(retained.rows.length,5);assert.ok(retained.rows.some(row=>row.dimensions.businessScopeState==='unknown'));
 const malformed={...unknown,execution:{finance:{...unknown.execution.finance,versions:[{...finance.versions[0],association:{groupId:'g',questionVersion:'1',pool:'invalid',clientTags:[42]}}]}}};
 assert.equal(buildGeoFinanceAnalysis({...historic,scope:{...historic.scope,pools:['P3'],clientTags:['unrecorded'],questionVersion:3}},{viewId:'V25'},malformed).rows.length,5,'malformed historical fields cannot establish an outside association');
});

test('ledger labels use the selected business day across positive, UTC and negative timezone midnight boundaries',()=>{
 for(const [timeZone,before,start,end,next] of [
  ['Asia/Shanghai','2026-10-01T15:59:59.999Z','2026-10-01T16:00:00.000Z','2026-10-02T15:59:59.999Z','2026-10-02T16:00:00.000Z'],
  ['UTC','2026-10-01T23:59:59.999Z','2026-10-02T00:00:00.000Z','2026-10-02T23:59:59.999Z','2026-10-03T00:00:00.000Z'],
  ['America/Los_Angeles','2026-10-02T06:59:59.999Z','2026-10-02T07:00:00.000Z','2026-10-03T06:59:59.999Z','2026-10-03T07:00:00.000Z'],
 ]){
  const zonedTimeline=geoLedgerBalances([
   {id:'budget',orderId:null,kind:'budget_set',amountCny:100,createdAt:'2026-09-30T00:00:00.000Z'},
   ...[[before,'reserve',0.1],[start,'reserve',0.2],[end,'settle',0.1],[next,'refund',0.1]].map(([createdAt,kind,amountCny],index)=>({id:String(index),orderId:'order',kind,amountCny,createdAt})),
  ]);
  const result=buildGeoFinanceAnalysis({...selected,scope:{timeZone,from:'2026-10-02',to:'2026-10-02'}},{viewId:'V25'},{...context,execution:{finance:{...finance,ledger:{...finance.ledger,items:zonedTimeline.entries,opening:zonedTimeline.opening}}}});
  assert.equal(result.rows.length,2,timeZone);assert.equal(result.contextualBasis[0].opening.reservedCny,0.1);assert.equal(result.contextualBasis[0].opening.budgetCny,100);
  assert.ok(result.rows.every(row=>row.label.startsWith('2026-10-02 · ')),timeZone);assert.ok(result.chart.cells.every(cell=>cell.label.startsWith('2026-10-02 · ')),timeZone);
  assert.deepEqual(result.rows.map(row=>row.dimensions.date),[start,end]);
  assert.deepEqual(result.rows.flatMap(row=>result.memberItems.get(row.key+':amountCny').map(item=>item.createdAt)),[start,end]);
 }
});
