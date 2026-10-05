import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionResultEvidence, evolutionCompletedResult } from '../src/evolutionUsage.mjs';
test('actual structured results carry no private output, and success flags alone cannot prove support',()=>{
  const result=evolutionResultEvidence({result:{netBenefit:0.1625},privateRows:['patient-private']});
  assert.equal(result.substantive,true);assert.match(result.sha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(evolutionResultEvidence({ok:true,status:'done',exitCode:0}).substantive,false);
  assert.equal(evolutionResultEvidence({status:'not_supported',result:{n:10}}).explicitlyUnsupported,true);
  assert.equal(evolutionResultEvidence({status:'refused',result:{n:10}}).explicitlyUnsupported,true);
  assert.equal(evolutionResultEvidence({status:'refused',result:{n:10}}).substantive,false);
  assert.equal(evolutionResultEvidence({stdout:'{"netBenefit":0.1625}'}).substantive,true);
});
test('complete substantive tool result is supported independently of verification labels',()=>{
  const use={result:{ok:true},resultEvidence:evolutionResultEvidence({netBenefit:0.1625})};
  const transcript={header:{completeness:'complete'},messages:[{role:'assistant',parts:[{type:'text',text:'The tool produced the prespecified calculation.'}]}]};
  assert.equal(evolutionCompletedResult(use,{status:'succeeded',verification:'unverified'},transcript).supported,true);
  assert.equal(evolutionCompletedResult(use,{status:'failed'},transcript).supported,false);
  assert.equal(evolutionCompletedResult({...use,resultEvidence:null},{status:'succeeded'},transcript).supported,null);
  assert.equal(evolutionCompletedResult(use,{status:'succeeded'},null).supported,null);
  assert.equal(evolutionCompletedResult(use,{status:'succeeded'},{header:{completeness:'complete'},messages:[]}).supported,false);
});
