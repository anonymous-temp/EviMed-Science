import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionMonthlyObservations} from '../src/evolutionMonthlyObservations.mjs';
test('cross-month costs retain authorizing policy, unresolved spend stays unknown and no future gain enters past month',()=>{
 const mission={id:'m',month:'2026-10',policyVersion:1,epoch:'epoch',completed:true,completedAt:'2026-12-04',confirmedPromotions:1,newSupportedFamilies:1,regressions:0};
 const rows=evolutionMonthlyObservations([mission],[{mission_id:'m',month:'2026-10',cost:3,incomplete:0},{mission_id:'m',month:'2026-11',cost:5,incomplete:1},{mission_id:'m',month:'2026-12',cost:7,incomplete:0}],'2026-12');
 assert.equal(rows.length,2);assert.equal(rows[0].researchCostCny,3);assert.equal(rows[1].researchCostCny,null);assert.equal(rows[1].policyVersion,1);assert.equal(rows[1].confirmedPromotions,0);assert.equal(rows[1].regressions,0);
});
test('dated regression verdicts and actual completion gain cannot leak into another month',()=>{
 const rows=evolutionMonthlyObservations([{id:'m',month:'2026-10',completed:true,completedAt:'2026-11-04',confirmedPromotions:1,regressions:1,regressionObservations:[{at:'2026-10-02',regressed:true}],auditReceiptId:'audit',developmentGain:0.2,auditGain:0.1,overfitGap:0.1}],[{mission_id:'m',month:'2026-10',cost:2},{mission_id:'m',month:'2026-11',cost:3}],'2026-12');
 assert.equal(rows[0].regressions,1);assert.equal(rows[0].confirmedPromotions,0);assert.equal(rows[0].auditReceiptId,null);assert.equal(rows[1].confirmedPromotions,1);assert.equal(rows[1].regressions,0);assert.equal(rows[1].auditReceiptId,'audit');
});
