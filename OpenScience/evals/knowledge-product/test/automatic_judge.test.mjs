import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceFor, judgedObservation } from '../automatic_judge.mjs';
test('medical uses frozen quote-anchored keypoints; general/unanswerable have explicit automatic rubrics',()=>{
 assert.equal(referenceFor({expected:{keyPoints:[{id:'kp',text:'Known'}]}}).keyPoints[0].text,'Known');
 assert.equal(referenceFor({expected:'CNY 100'}).keyPoints[0].text,'CNY 100');
 assert.match(referenceFor({unanswerable:true}).keyPoints[0].text,/absent|not provided/);
});
test('automatic judge produces review rows from collected evidence without operator cell configuration',async()=>{
 const c={id:'g',prompt:'Question',actor:'a',project:'p',expected:'Known',sources:['s']};
 const evidence={caseId:'g',arm:'candidate',repetition:1,run:{id:'r',status:'succeeded'},digest:{reply:'Known'},runtime:{model:'deepseek-flash'}};
 const row=await judgedObservation(c,evidence,{judge:async()=>({ok:true,malformed:false,score:1,points:[{id:'kp1',verdict:'covered',contradicted:false}]})});
 assert.equal(row.score,1);assert.equal(row.evidence.runId,'r');assert.equal(row.caseId,'g');assert.equal(row.repetition,1);
});
