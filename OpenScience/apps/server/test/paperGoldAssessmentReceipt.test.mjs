import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {preservePaperGoldAssessment,readPaperGoldAssessment} from '../src/paperGoldEvaluator.mjs';
import {digest,scoreUnit} from '../../../evals/paper-gold/evaluator.mjs';
test('actual assessment roundtrip binds frozen producer evidence and projects away transport credentials',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paper-stage-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const binding={cycleId:'v4',frozenHash:'frozen',producerRunId:'actualrun',observedHash:'actualtranscript-and-pinnedreport',checkNames:['question_aligned']};
 const result={value:{checks:{question_aligned:false},evidenceIds:['author'],gaps:['extraction'],reasons:{question_aligned:'Population is not substantiated by the supplied source. '+ 'x'.repeat(4500)}},model:'qwen',modelReported:true,requestId:'provider-receipt',headers:{authorization:'secret'},credential:'secret'};
 const saved=await preservePaperGoldAssessment({directory,binding,result});assert.deepEqual(await readPaperGoldAssessment({directory,binding}),saved);assert.equal(JSON.stringify(saved).includes('secret'),false);assert.equal(saved.response.value.reasons.question_aligned,result.value.reasons.question_aligned);assert.ok(saved.response.value.reasons.question_aligned.length>4000);
 assert.equal(await readPaperGoldAssessment({directory,binding:{...binding,observedHash:'differentreport'}}),null);
 await assert.rejects(()=>preservePaperGoldAssessment({directory,binding,result:{...result,value:{...result.value,checks:{question_aligned:true}}}}),/already differs/);
 const file=path.join(directory,`${digest(binding)}.json`);const altered=JSON.parse(await fs.readFile(file,'utf8'));altered.response.value.checks.question_aligned=true;await fs.writeFile(file,JSON.stringify(altered));await assert.rejects(()=>readPaperGoldAssessment({directory,binding}),/integrity/);
});
test('missing reasons stay unknown and scored unit retains receipt identity without control reasoning text',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paper-reason-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const saved=await preservePaperGoldAssessment({directory,binding:{checkNames:['question_aligned']},result:{value:{checks:{question_aligned:true},evidenceIds:['author']},model:'qwen',modelReported:true}});assert.equal(saved.response.value.reasons.question_aligned,null);
 const unit=await scoreUnit({id:'run',checks:{question_aligned:true},assessmentReceiptHash:saved.hash,assessmentEvidenceIds:['author'],assessmentReasoningStatus:'unknown'},{type:'question',inputAvailable:false,stageChecks:{question:['question_aligned']},applicableStages:['question']});assert.equal(unit.assessmentReceiptHash,saved.hash);assert.deepEqual(unit.assessmentEvidenceIds,['author']);assert.equal(unit.assessmentReasoningStatus,'unknown');
});
