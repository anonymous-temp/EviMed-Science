// Genuine setup probes: inspect native tool results, never the model's asserted verdict.
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectRetrieval } from './evidence.mjs';
import { verifyBoundCollector } from './shared_budget.mjs';
export const transcriptFile=(scope,runId)=>path.join(scope.projectDir??path.dirname(scope.workspace),'.openscience','transcripts',`${runId}.jsonl`);
export async function readTranscript(scope,runId,{timeoutMs=15000}={}){
 const deadline=Date.now()+timeoutMs;let last;
 do{try{return await fs.readFile(transcriptFile(scope,runId),'utf8');}catch(error){last=error;await new Promise(r=>setTimeout(r,250));}}while(Date.now()<deadline);
 throw last;
}
export function returnedFacts(value){
 if(!value||typeof value!=='object')return '';
 const own=['text','content','abstract','value','summary','sourceId','uri'].map(k=>typeof value[k]==='string'?value[k]:'').join('\n');
 return own+'\n'+['hits','files','documents','matches','items','memories','results'].flatMap(k=>Array.isArray(value[k])?value[k].map(returnedFacts):[]).join('\n')+(value.result?returnedFacts(value.result):'');
}
export async function runNativeToolProbe(api,scope,tool,input,{timeoutMs=180000}={}){
 if(!api.evalBudget)throw new Error('Native runtime probe requires verified shared budget wiring');
 await verifyBoundCollector(api.base,api.evalBudget.scope,api.evalBudget.config);
 const prior=api.project;api.project=scope.id;
 const call=async(method,url,body)=>{await verifyBoundCollector(api.base,api.evalBudget.scope,api.evalBudget.config);const r=await api.call(method,url,body);if(r.status>=400)throw new Error(`Native probe HTTP ${r.status} ${r.json?.code??''}`);return r;};
 const sessionId=`native_probe_${Date.now()}_${Math.random().toString(16).slice(2,10)}`;
 try{
  await call('PUT',`/api/research-sessions/${sessionId}`,{mode:'open-domain'});
  const prompt=`Evaluation infrastructure probe: call the existing ${tool} tool with exactly this JSON input: ${JSON.stringify(input)}. Do not substitute a shell search or invent a tool result. Reply briefly after the real tool returns.`;
  let run=(await call('POST','/api/agent-runs/dispatch',{sessionId,dispatchId:sessionId,automated:true,text:prompt})).json.data;
  const deadline=Date.now()+timeoutMs;
  while(['queued','running','planned','dispatching','starting','waiting'].includes(run.status)){
   if(Date.now()>deadline){await api.call('POST',`/api/agent-runs/${run.id}/cancel`,{});throw new Error('Native runtime tool probe timed out');}
   await new Promise(r=>setTimeout(r,500));const listed=(await call('GET','/api/agent-runs')).json.data;run=(Array.isArray(listed)?listed:listed.items??listed.runs??[]).find(r=>r.id===run.id)??run;
  }
  const transcript=await readTranscript(scope,run.id),tools=collectRetrieval(transcript.split('\n').filter(Boolean).map(JSON.parse));
  const matched=tools.find(t=>t.name===tool&&Object.entries(input).every(([key,value])=>{let actual=t.input;if(typeof actual==='string')try{actual=JSON.parse(actual);}catch{return false;}return JSON.stringify(actual?.[key])===JSON.stringify(value);}));
  if(!matched)throw new Error('Native runtime did not execute the required exact tool probe');
  return {runId:run.id,runStatus:run.status,tool:matched,transcript,engine:true,runtime:true};
 }finally{api.project=prior;}
}
