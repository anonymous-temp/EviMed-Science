import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationTextView, calibrationNumericBond } from '../src/paperGoldCalibration.mjs';
test('primary XML text derivative decodes entities and separates blocks deterministically', () => {
  assert.equal(calibrationTextView('<p>Effect <italic>1.30</italic> &amp; risk &#x2264; 0.05</p><p>N=1,000</p>'), 'Effect 1.30 & risk ≤ 0.05\n\nN=1,000');
});
test('gold quotes require exact preserved text and an equivalent numeric literal', () => {
  const source='Effect 1.30; N=1,000; variance 1e-3.';
  assert.equal(calibrationNumericBond(source,{quote:'Effect 1.30',value:1.3,absoluteTolerance:0}),true);
  assert.equal(calibrationNumericBond(source,{quote:'N=1,000',value:1000,absoluteTolerance:0}),true);
  assert.equal(calibrationNumericBond(source,{quote:'variance 1e-3.',value:.001,absoluteTolerance:0}),true);
  assert.equal(calibrationNumericBond(source,{quote:'Effect 1.3',value:1.3,absoluteTolerance:0}),true);
  assert.equal(calibrationNumericBond(source,{quote:'Effect 1.31',value:1.31,absoluteTolerance:0}),false);
  assert.equal(calibrationNumericBond(source,{quote:'Effect 1.30',value:1.31,absoluteTolerance:0}),false);
});
test('cached drafts repair whitespace by unique exact character sequences and never approximate punctuation or facts', async()=>{
 const {repairCalibrationDraft}=await import('../src/paperGoldCalibration.mjs');
 const source='Reported HR = 1.30; 95% CI = 1.1–1.5.';
 const original={numeric:{hr:{value:'1.3',absoluteTolerance:'0',quote:'Reported HR=1.30;95% CI=1.1–1.5.'}}};
 const repaired=repairCalibrationDraft(source,original);
 assert.equal(repaired.draft.numeric.hr.value,1.3);assert.equal(repaired.draft.numeric.hr.quote,source);
 assert.equal(calibrationNumericBond(source,repaired.draft.numeric.hr),true);
 assert.equal(original.numeric.hr.value,'1.3');
 const wrong=repairCalibrationDraft(source,{numeric:{hr:{value:1.3,absoluteTolerance:0,quote:'Reported HR=1.30;95% CI=1.1-1.5.'}}});
 assert.equal(wrong.repairs.length,0);
});

test('exact primary quotes preserve mathematical Unicode minus signs without silently changing sign or units', () => {
  const source = 'The coefficient was −0.125; the sensitivity estimate was −1.2e−3.';
  assert.equal(calibrationNumericBond(source, { quote: 'The coefficient was −0.125', value: -0.125, absoluteTolerance: 0 }), true);
  assert.equal(calibrationNumericBond(source, { quote: 'The coefficient was −0.125', value: 0.125, absoluteTolerance: 0 }), false);
  assert.equal(calibrationNumericBond(source, { quote: 'the sensitivity estimate was −1.2e−3', value: -0.0012, absoluteTolerance: 0 }), true);
  assert.equal(calibrationNumericBond(source, { quote: 'The coefficient was -0.125', value: -0.125, absoluteTolerance: 0 }), false);
  assert.equal(calibrationNumericBond('The proportion was 25%.', { quote: 'The proportion was 25%.', value: 0.25, absoluteTolerance: 0 }), false);
});

test('spaced mathematical minus retains negative sign without rewriting primary quotes or converting units', () => {
 const source = 'The effect was − 0.125; sensitivity −1.2e− 3; proportion 25%.';
 const quote = 'The effect was − 0.125';
 const row = {quote,value:-0.125,absoluteTolerance:0};
 assert.equal(calibrationNumericBond(source,row),true);
 assert.deepEqual(row,{quote,value:-0.125,absoluteTolerance:0});
 assert.equal(calibrationNumericBond(source,{...row,value:0.125}),false);
 assert.equal(calibrationNumericBond(source,{...row,quote:'The effect was −0.125'}),false);
 assert.equal(calibrationNumericBond(source,{quote:'sensitivity −1.2e− 3',value:-0.0012,absoluteTolerance:0}),true);
 assert.equal(calibrationNumericBond('Effect – 0.125',{...row,quote:'Effect – 0.125'}),false);
 assert.equal(calibrationNumericBond(source,{quote:'proportion 25%',value:0.25,absoluteTolerance:0}),false);
});

test('targeted repair identifies four variants and nested gold without editing the retained draft', async () => {
 const {calibrationDraftContractIssues}=await import('../src/paperGoldCalibration.mjs');
 const draft={variants:['a','b','c','d'],numeric:{ror:{value:{drug:1},absoluteTolerance:0,quote:'source'}}};
 const before=structuredClone(draft);
 const issues=calibrationDraftContractIssues(draft);
 assert.equal(issues.length,2);assert.match(issues[0],/THREE/);assert.deepEqual(draft,before);
 assert.deepEqual(calibrationDraftContractIssues({variants:['a','b','c'],numeric:{'analysis.ror':{value:1,absoluteTolerance:0,quote:'source'}}}),[]);
});

test('replacement selection retains old manifest and refuses cross-track or unknown identities', async () => {
 const {selectCalibrationCandidates}=await import('../src/paperGoldCalibration.mjs');
 const original={cases:[{id:'old',track:'meta'},{id:'kept',track:'meta'},{id:'mr',track:'mr'}]};
 const replacements={cases:[{id:'new',track:'meta',replacesId:'old',hiddenHash:'primary-bytes-hash'}]};
 const before=structuredClone(original);
 const selected=selectCalibrationCandidates(original,replacements,'meta','new');
 assert.deepEqual(selected.records.map(r=>r.id),['kept','mr','new']);assert.equal(selected.replacement.hiddenHash,'primary-bytes-hash');assert.deepEqual(original,before);
 assert.throws(()=>selectCalibrationCandidates(original,replacements,'mr','new'),/same-track/);
 assert.throws(()=>selectCalibrationCandidates(original,replacements,'meta','unknown'),/same-track/);
 assert.deepEqual(selectCalibrationCandidates(original,null,'meta',null).records,original.cases);
});

test('a model availability claim or public data URL cannot supply verified analysis inputs to a corpus unit',async()=>{
 const {constrainCalibrationInputs}=await import('../src/paperGoldCalibration.mjs');
 const draft={inputAvailable:true,inputLimitations:[],dataUrl:'https://public.example/supplement.xls',variants:['a','b','c']};
 const constrained=constrainCalibrationInputs(draft);
 assert.equal(constrained.inputAvailable,false);assert.equal(constrained.inputAvailabilityBasis,'evaluation_withheld_no_bound_verified_input');
 assert.match(constrained.inputLimitations[0],/no global unavailability is asserted/);assert.equal(draft.inputAvailable,true);
 const {scoreUnit}=await import('../../../evals/paper-gold/evaluator.mjs');
 const scored=await scoreUnit({exposureTier:'unexposed',checks:{q:true,m:true,c:true,w:true}}, {...constrained,type:'research',numeric:{},applicableStages:['question','method','certainty','writing'],stageChecks:{question:['q'],method:['m'],certainty:['c'],writing:['w']}});
 assert.equal(scored.applicableStagesValid,true);assert.equal(scored.allStagesValid,false);assert.equal(scored.fullResearchReproductionValid,false);
});
