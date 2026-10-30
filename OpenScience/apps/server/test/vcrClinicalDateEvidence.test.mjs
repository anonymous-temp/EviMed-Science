import test from 'node:test';
import assert from 'node:assert/strict';
import {clinicalDateInQuote,clinicalIntervalInQuote} from '../src/vcrClinicalDateEvidence.mjs';
import {verifyFactEvidence,evaluateCriterion,UNKNOWN} from '../src/vcrMatching.mjs';

test('dataset year and undated age cannot supply a manufactured birth/event date',()=>{
 for (const year of ['2021','2022','2026']) assert.equal(clinicalDateInQuote('2003-01-01',`Dataset ${year}; patient age 19.`),false);
 assert.equal(clinicalDateInQuote('2026-01-01','In 2026 the event occurred.'),false);
 for(const text of ['On 2026-01-03, MI','2026年1月3日发生','2026/1/3 MI','January 3, 2026 MI','3 January 2026 MI'])assert.equal(clinicalDateInQuote('2026-01-03T00:00:00.000Z',text),true);
 assert.equal(clinicalDateInQuote('2026-01-03','2026-01-04'),false);
 assert.equal(clinicalDateInQuote('2026-02-31','2026-02-31'),false);
});
test('new extracted fact dates are checked against actual owned source spans',()=>{
 const text='Patient age 19; prior MI.';const fact={id:'f',variable:'mi',polarity:'affirmed',extractedBy:'model',surface:'MI',occurredAt:'2003-01-01',provenance:{factSchema:2},source:{documentId:'d',start:0,end:text.length,quote:text}};
 assert.deepEqual(verifyFactEvidence(fact,{documents:{d:{text}}}),{ok:false,reason:'date_not_in_span'});
 assert.equal(verifyFactEvidence({...fact,occurredAt:null},{documents:{d:{text}}}).ok,true);
});
test('age alone cannot establish pregnancy, family history, or calendar time in structured criteria',()=>{
 const ctx={facts:[{id:'age',variable:'age',value:58,unit:'years',polarity:'affirmed',extractedBy:'snapshot'}],asOf:'2026-10-29'};
 for(const variable of ['pregnancy','family_history']){
  const criterion={id:variable,kind:'inclusion',requirement:{op:'present',variable}};
  assert.equal(evaluateCriterion(criterion,ctx).state,UNKNOWN);
 }
 const criterion={id:'women',kind:'exclusion',applicability:{op:'compare',variable:'sex',comparator:'eq',value:'female'},requirement:{op:'absent',variable:'pregnancy'}};
 const male=evaluateCriterion(criterion,{...ctx,facts:[...ctx.facts,{id:'sex',variable:'sex',value:'male',polarity:'affirmed',extractedBy:'snapshot'}]});
 assert.equal(male.applicable,false);
});

test('nested intervals require stated bounds or explicit source-anchored duration arithmetic',()=>{
 const interval={start:'2026-09-09',end:'2026-10-09'};
 assert.equal(clinicalIntervalInQuote(interval,'Currently no docetaxel recorded.',null),false);
 assert.equal(clinicalIntervalInQuote(interval,'On 2026-10-09: no docetaxel in the preceding 30 days.','30 days'),true);
 assert.equal(clinicalIntervalInQuote(interval,'Dataset 2026: no docetaxel in the preceding 30 days.','30 days'),false);
 assert.equal(clinicalIntervalInQuote(interval,'On 2026-10-09: no docetaxel for 20 days.','20 days'),false);
 const text='Currently no docetaxel recorded.';
 const fact={id:'f',variable:'docetaxel',polarity:'negated',extractedBy:'model',surface:'docetaxel',provenance:{factSchema:2},clinical:{schema:1,assertion:'negated',experiencer:'patient',medication:{state:'unknown',absenceScope:'interval'},occurredInterval:interval},source:{documentId:'d',start:0,end:text.length,quote:text}};
 assert.equal(verifyFactEvidence(fact,{documents:{d:{text}},anyPolarity:true}).reason,'date_not_in_span');
});
