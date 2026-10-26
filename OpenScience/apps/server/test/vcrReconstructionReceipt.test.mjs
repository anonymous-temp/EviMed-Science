import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {VcrJobs,VCR_RECONSTRUCTION_REFERENCE} from '../src/vcrJobs.mjs';
const hash='a'.repeat(64);
test('reconstruction listing and binding share verifier-origin keyless proof without relaxing curve/table verification',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-receipt-'));await fs.chmod(root,0o700);
 try{
  const bytes='time,status\n2,1\n';const location='derived/study/job/reconstructed-ipd.csv';await fs.mkdir(path.dirname(path.join(root,location)),{recursive:true});await fs.writeFile(path.join(root,location),bytes);
  const table={name:'reconstructed-ipd',location,sha256:createHash('sha256').update(bytes).digest('hex')};
  let receipt={signed:false,hashVerified:true,outputHash:hash};
  const result={id:'result',executionId:'execution',version:1,tables:[table]};
  const producer={scenario:{},inputs:[],checkpoint:{curveReceiptId:'curve',curveImageHash:'image',curvePointsHash:'points',curvePrincipal:'owner'}};
  const store={result:async(study,id)=>study==='study'&&id==='result'?result:null,one:async sql=>sql.includes('.executions')?{method:'evidence.reconstruct_km',receipt,output_hash:hash,job_id:'job'}:producer,
   rows:async()=>[{id:'result',execution_id:'execution',version:1,tables:[table],curve_origin:'upload',execution_receipt:receipt,execution_output_hash:hash}]};
  const jobs=new VcrJobs({store,config:{vcrDataPlaneDir:root}});let curveHash='image';
  jobs.curveVerifier=async()=>({detail:{curveImageHash:curveHash,curvePointsHash:'points'}});
  assert.equal((await jobs.reconstructionResults('study')).length,1);
  assert.equal((await jobs.prepareReconstruction('study',VCR_RECONSTRUCTION_REFERENCE.kind,{},'result')).reconstructionResultId,'result');
  for(const proof of [{signed:false,outputHash:hash},{signed:false,hashVerified:true,outputHash:'b'.repeat(64)},{signed:true,outputHash:'b'.repeat(64)},{signed:true,ok:false}]){
   receipt=proof;assert.equal((await jobs.reconstructionResults('study')).length,0);await assert.rejects(jobs.prepareReconstruction('study',VCR_RECONSTRUCTION_REFERENCE.kind,{},'result'),{code:'vcr_curve_provenance_unavailable'});
  }
  receipt={signed:false,hashVerified:true,outputHash:hash};curveHash='changed';await assert.rejects(jobs.prepareReconstruction('study',VCR_RECONSTRUCTION_REFERENCE.kind,{},'result'),{code:'vcr_curve_provenance_unavailable'});
  curveHash='image';await fs.writeFile(path.join(root,location),'changed');await assert.rejects(jobs.prepareReconstruction('study',VCR_RECONSTRUCTION_REFERENCE.kind,{},'result'),{code:'vcr_derived_table_missing'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
