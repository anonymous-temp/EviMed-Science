import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCollectedEvidence, retrievalProof } from '../evidence.mjs';
const c={id:'g',prompt:'What?',actor:'a',project:'p',unanswerable:false};
const r={caseId:'g',prompt:'What?',actor:'a',project:'p',arm:'candidate',repetition:2,evidence:{runId:'r2',provider:'deepseek-flash'}};
const e={...r,run:{id:'r2',status:'succeeded'},runtime:{model:'deepseek-flash'},knowledgeInventory:{ready:true,sources:1},retrieval:[{name:'kb_search',status:'completed',output:{hits:[{sourceId:'src_x',text:'Evidence passage'}]}}]};
test('review binds exact repetition and rejects a run reused as independent evidence',()=>{
 assert.equal(validateCollectedEvidence(c,r,e,new Set()),true);
 assert.throws(()=>validateCollectedEvidence(c,r,{...e,repetition:1},new Set()),/identity/);
 assert.throws(()=>validateCollectedEvidence(c,r,e,new Set(['r2'])),/reused/);
});
test('failed, empty and unready retrieval cannot qualify as a genuine answerable run',()=>{
 for(const retrieval of [[{name:'kb_search',status:'error',output:{hits:[{text:'x'}]}}],[{name:'kb_search',status:'completed',output:{hits:[]}}]])assert.throws(()=>retrievalProof(c,{...e,retrieval}),/retrieval/);
 assert.equal(retrievalProof({...c,unanswerable:true},{...e,retrieval:[{name:'kb_search',status:'completed',output:{hits:[]}}]}),true);
 assert.throws(()=>retrievalProof({...c,unanswerable:true},{...e,knowledgeInventory:{ready:false,sources:0},retrieval:[{name:'kb_search',status:'completed',output:{hits:[]}}]}),/inventory/);
});
