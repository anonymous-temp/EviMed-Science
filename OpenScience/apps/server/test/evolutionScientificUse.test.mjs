import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionScientificUse} from '../src/evolutionScientificUse.mjs';
import {evolutionMonthlyMetrics} from '../src/evolutionMetrics.mjs';
test('human and genuine autopilot calls count; automated engineering receipts and internal evaluations do not',()=>{
 assert.deepEqual(evolutionScientificUse('research',{automated:false}),{evaluation:false,researcherOwned:true});
 assert.equal(evolutionScientificUse('research',{effectiveRouteReason:'autopilot:data-prospecting'}).evaluation,false);
 assert.equal(evolutionScientificUse('research',{automated:true}).evaluation,true);
 assert.equal(evolutionScientificUse('eval-paper-test',{}).evaluation,true);
 assert.deepEqual(evolutionScientificUse('research',null),{evaluation:false,researcherOwned:false});
 assert.equal(evolutionScientificUse('research',undefined).researcherOwned,false);
 const original={runId:'fixture',track:'M',at:'2026-10-04',supported:true,researcherOwned:true};
 const corrected={...original,...evolutionScientificUse('research',{automated:true})};
 assert.equal(original.researcherOwned,true);
 const result=evolutionMonthlyMetrics({month:'2026-10',now:new Date('2026-11-01'),uses:[corrected]});
 assert.equal(result.byTrack.find(row=>row.track==='M').supportedRealRequests.denominator,0);
});
