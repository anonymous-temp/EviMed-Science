import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrExecutionReceiptVerified } from '../src/vcrEngineClient.mjs';
import { readVcrModelDesignResult } from '../src/vcrModelDesign.mjs';
const hash='a'.repeat(64);
test('model reuse accepts verifier-origin keyless receipts and legacy signed proof, never a raw hash or failed proof',async()=>{
 const result={id:'r',executionId:'e',version:1};
 const verified={method:'model.survival_fit',receipt:{signed:false,hashVerified:true,outputHash:hash},output_hash:hash};
 for(const execution of [verified,{...verified,receipt:{signed:true}}]){
  assert.equal(vcrExecutionReceiptVerified(execution),true);
  assert.equal(await readVcrModelDesignResult({result:async()=>result,one:async()=>execution},'study','r'),result);
 }
 for(const execution of [{...verified,receipt:{signed:false,outputHash:hash}},{...verified,output_hash:'b'.repeat(64)},{...verified,receipt:{signed:true,outputHash:'b'.repeat(64)}},{...verified,receipt:{signed:true,ok:false}},{...verified,receipt:{signed:true,signatureVerified:false}},{...verified,receipt:{signed:false,hashVerified:true,outputHash:'forged'}},{...verified,method:'design.analytic'}]){
  await assert.rejects(readVcrModelDesignResult({result:async()=>result,one:async()=>execution},'study','r'),{code:'vcr_model_not_applicable'});
 }
});
