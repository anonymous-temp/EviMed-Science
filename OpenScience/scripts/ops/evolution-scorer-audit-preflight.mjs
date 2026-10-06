import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest} from '../../evals/paper-gold/evaluator.mjs';
/** Read only preserved control metadata. Never invokes a model, starts a runtime or prints gold values. */
export async function scorerAuditPreflight({evaluationDataDir}){
 const root=await realpath(path.join(evaluationDataDir,'paper-gold','cycles'));
 const cycles=[],eligible=[];
 for(const name of (await readdir(root)).filter(value=>/^[a-zA-Z0-9_-]+$/.test(value)).sort()){
  let frozen,report;
  try{frozen=JSON.parse(await readFile(path.join(root,name,'definition.json'),'utf8'));report=JSON.parse(await readFile(path.join(root,name,'report.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const freezeValid=frozen.hash===digest({definition:frozen.definition,evaluatorCodeHash:frozen.evaluatorCodeHash});
  const complete=report.complete===true&&report.evaluatorHash===frozen.hash;
  const units=[];
  for(const unit of report.units??[]){
   const testCase=frozen.definition?.cases?.find(item=>item.id===unit.caseId),gold=testCase?.gold;
   if(!gold)continue;
   const needsCode=Object.keys(gold.numeric??{}).length>0;
   const evidenceIds=new Set([gold.sourceHash,...(gold.reachableEvidenceIds??[]),...(gold.unreachableEvidenceIds??[]),...(gold.evidenceIds??[]),...(gold.preservedEvidence??[]).flatMap(item=>[item.id,item.sourceHash])].filter(value=>typeof value==='string'&&value));
   const ready=freezeValid&&complete&&Boolean(unit.producerRunId&&unit.producerProjectId)&&(!needsCode||Boolean(gold.deterministicVerification&&unit.verificationProof?.codeHash))&&evidenceIds.size>0;
   const metadata={cycleId:name,caseId:unit.caseId,producerRunId:unit.producerRunId??null,producerProjectId:unit.producerProjectId??null,freezeValid,complete,needsCode,codeProof:!!unit.verificationProof?.codeHash,verificationDescriptor:!!gold.deterministicVerification,citableEvidenceCount:evidenceIds.size,assessorModel:unit.assessmentModel??null,ready};
   units.push(metadata);if(ready)eligible.push(metadata);
  }
  cycles.push({cycleId:name,freezeValid,complete,units});
 }
 return{readOnly:true,paidCalls:0,eligibleUnits:eligible.length,minimumAuditSamples:3,ready:eligible.length>=3,cycles,eligible,
  limitation:'Metadata readiness only. Durable transcript, trace coverage, artifact hashes and independent reviewer identity must still be proved by the live scorer audit.'};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const option=process.argv.slice(2).find(value=>value.startsWith('--evaluation-data-dir='));
 if(!option)throw new Error('Pass --evaluation-data-dir=<preserved-control-directory>.');
 process.stdout.write(JSON.stringify(await scorerAuditPreflight({evaluationDataDir:option.slice('--evaluation-data-dir='.length)}),null,2)+'\n');
}
