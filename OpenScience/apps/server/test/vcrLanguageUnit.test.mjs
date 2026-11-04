import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeVcrLanguageUnit } from '../src/vcrLanguageUnit.mjs';

const unit = () => ({ studyId:'s1',userId:'u1',subjectKey:'p1',candidateTrialId:'t1',criterionKey:'k',axis:'requirement',
  recordHash:'f'.repeat(64),criterionHash:'a'.repeat(64),expectedJudgmentId:null,evaluatorVersion:'v1',promptVersion:'p1',model:'deepseek-flash',thinking:'disabled',outputLimit:2000,
  documents:[{id:'d1',sourceId:'src1',sourceHash:'b'.repeat(64),projectionHash:null,projectionId:null},{id:'d2',sourceId:'src2',sourceHash:'c'.repeat(64),projectionHash:'d'.repeat(64),projectionId:'prj2'}] });
test('frozen unit hash binds source, subject, answer, model and policy without embedding text', () => {
  const a=unit(), frozen=freezeVcrLanguageUnit(a);
  assert.equal(freezeVcrLanguageUnit({...a,documents:[...a.documents].reverse()}).unitHash,frozen.unitHash);
  for(const patch of [{subjectKey:'p2'},{expectedJudgmentId:'j1'},{promptVersion:'p2'},{thinking:'enabled'},{axis:'applicability'},
    {documents:[{...a.documents[0],sourceHash:'e'.repeat(64)},a.documents[1]]}]) assert.notEqual(freezeVcrLanguageUnit({...a,...patch}).unitHash,frozen.unitHash);
  assert.throws(()=>freezeVcrLanguageUnit({...a,documents:[a.documents[0],a.documents[0]]}),/Invalid frozen source/);
  assert.throws(()=>freezeVcrLanguageUnit({...a,expectedJudgmentId:undefined}),/Invalid frozen/);
});
