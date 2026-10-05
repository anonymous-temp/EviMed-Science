import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {createEvolutionCandidateEvaluator} from '../src/evolutionCandidateEvaluator.mjs';
test('control-only immutable assessment receipts distinguish execution failure from numerical mismatch without targets',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'evaluation-receipt-'));
 try{
 const root=path.join(dataDir,'paper-gold/candidate-cases');await mkdir(root,{recursive:true});
 await writeFile(path.join(root,'method.json'),JSON.stringify({methodId:'method',frozen:true,cases:[{id:'opaque-case',kind:'workflow-smoke',hidden:true,independentQa:{passed:true},sourceHash:'a'.repeat(64),input:{privateInput:1234567},numeric:{value:{value:9876543,absoluteTolerance:0}}}]}));
 let failed=false;const candidate={id:'candidate',methodId:'method',toolKind:'workflow',entrypoint:'scripts/method.py:method',files:{'scripts/method.py':'def method(specification): return {}'},lineage:{developmentRuns:['development-run']}};
 const evaluator=createEvolutionCandidateEvaluator({config:{dataDir,evaluationDataDir:dataDir},controller:{execVerify:async()=>failed?{ok:false,joined:true,executionStarted:true,output:'Candidate execution failed.'}:{ok:true,joined:true,executionStarted:true,output:'{"value":0}'}}});
 await evaluator.evaluate(candidate);failed=true;await evaluator.evaluate(candidate);
 const directory=path.join(dataDir,'paper-gold/candidate-evaluations'),names=await readdir(directory);assert.equal(names.length,2);
 const receipts=[];for(const name of names){const raw=await readFile(path.join(directory,name),'utf8'),receipt=JSON.parse(raw);assert.equal(name,createHash('sha256').update(canonicalJson(receipt)).digest('hex')+'.json');assert.equal((await stat(path.join(directory,name))).mode&0o222,0);assert.equal(raw.includes('9876543'),false);assert.equal(raw.includes('1234567'),false);assert.ok(receipt.executionEvidence.every(item=>/^sha256:[a-f0-9]{64}$/.test(item.outputDigest)));receipts.push(receipt);}
 assert.ok(receipts.some(receipt=>receipt.assessments.every(item=>item.reason==='outside_reference_tolerance')));assert.ok(receipts.some(receipt=>receipt.assessments.every(item=>item.reason==='candidate_execution_failed')));
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
