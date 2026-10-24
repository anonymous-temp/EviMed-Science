// Frozen knowledge-pages key-point judge, routed exclusively through the same live aggregate coordinator.
import fs from 'node:fs/promises';
import {personalRetrievalProof} from './personal_context.mjs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLiveBudgetWiring } from './shared_budget.mjs';
import { validateCollectedEvidence } from './evidence.mjs';
import { summarize } from './scorer.mjs';
export function referenceFor(c){
 if(c.unanswerable)return {keyPoints:[{id:'kp1',text:'State explicitly that the requested detail is absent or not provided in the supplied sources; do not invent the answer.',support:[]}]};
 if(c.expected?.keyPoints)return c.expected;
 return {keyPoints:[{id:'kp1',text:String(c.expected),support:[]}]};
}
export function memoryReferenceFor(c){
 return {keyPoints:(c.memorySeeds??[]).flatMap(seed=>(seed.answerValues??seed.requiredValues).map((value,index)=>({id:`${seed.id}-${index}`,text:`Apply the user's saved working preference: ${value}.`,support:[]})))};
}
export async function judgedObservation(c,e,{judge,filename=`${e.arm}-${c.id}-${e.repetition}.json`}){
 const result=await judge({question:c.prompt,reference:referenceFor(c),answer:e.digest?.reply??'',caseId:c.id});
 if(!result.ok||result.malformed||!Number.isFinite(result.score))throw new Error('Frozen key-point judge produced no valid judgement');
 const answer=e.digest?.reply??'';
 const memoryProvenance=c.memorySeeds?.length?personalRetrievalProof(c,e):[];
 const substrate=c.evaluation?.substrate;
 const knowledgeScore=substrate==='memory'?null:result.score;
 let memoryResult=substrate==='memory'?result:null;
 if(substrate==='combined'){
  memoryResult=await judge({question:c.prompt,reference:memoryReferenceFor(c),answer,caseId:c.id,component:'personal-memory'});
  if(!memoryResult.ok||memoryResult.malformed||!Number.isFinite(memoryResult.score))throw Error('Personal memory semantic judge produced no valid judgement');
 }
 const score=memoryResult?(knowledgeScore===null?memoryResult.score:Math.min(knowledgeScore,memoryResult.score)):result.score;
 const citedSources=c.sources.filter(id=>answer.includes(id)||(e.sourceMap?.[id]&&answer.includes(e.sourceMap[id]))||(e.originalFiles?.[id]&&answer.includes(path.basename(e.originalFiles[id]))));
 return {caseId:c.id,arm:e.arm,repetition:e.repetition,prompt:c.prompt,actor:c.actor,project:c.project,score,components:{knowledge:knowledgeScore,memory:memoryResult?.score??null},memoryProvenance,citedSources,staleSources:[],abstained:c.unanswerable?result.score===1:false,violations:[],evidence:{runId:e.run.id,transcript:filename,provider:e.runtime.model},judge:{method:'unchanged knowledge-pages key-point judge',points:result.points,tokens:result.tokens??null,cost:result.cost??null},memoryJudge:memoryResult?{method:'same key-point semantic judge on authored personal criterion',points:memoryResult.points,tokens:memoryResult.tokens??null,cost:memoryResult.cost??null}:null,citationReview:{method:c.evaluation?.substrate==='memory'?'native user-context provenance; source-document citations not applicable':'literal original ID/file-name attribution only',resolved:citedSources.length,unresolved:c.evaluation?.substrate!=='memory'&&!c.unanswerable&&citedSources.length===0}};
}
export function coordinatorJudgeClient(sharedBudget,{model='deepseek-flash',provider='deepseek'}={}){
 return {async chat(input){
  await verifyLiveBudgetWiring(sharedBudget);
  const token=(await fs.readFile(sharedBudget.tokenFile,'utf8')).trim();
  const request={model,messages:input.messages,max_tokens:input.maxTokens??700,stream:false,temperature:0,thinking:{type:'disabled'},response_format:{type:'json_object'}};
  const response=await fetch(`${new URL(sharedBudget.coordinatorUrl).origin}/provider`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({scope:'judge',provider,request}),signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`Shared budget judge admission/accounting failed: HTTP ${response.status}`);
  const result=await response.json(),u=result.usage;
  if(!u||!Number.isSafeInteger(u.prompt_tokens)||!Number.isSafeInteger(u.completion_tokens))throw new Error('Judge provider usage identity missing');
  if(response.headers.get('x-evimed-eval-accounted-cny')===null||response.headers.get('x-evimed-eval-budget-id')!==sharedBudget.sharedBudgetId||!Number.isFinite(Number(response.headers.get('x-evimed-eval-accounted-cny'))))throw new Error('Judge aggregate budget settlement identity missing');
  return {message:result.choices?.[0]?.message??{},usage:{promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens},cost:Number(response.headers.get('x-evimed-eval-accounted-cny')),wire:{request,response:result}};
 }};
}
export const SEMANTIC_SEED_JUDGE=Object.freeze({model:'deepseek-v4-pro',provider:'deepseek-pro',protocol:'chat-completions',maximumResponses:2});
export async function createSemanticJudge(sharedBudget){
 return boundedSemanticJudge(coordinatorJudgeClient(sharedBudget,SEMANTIC_SEED_JUDGE));
}
export async function boundedSemanticJudge(llm){
 const {judgeAnswer}=await import('../knowledge-pages/lib/judge.mjs');
 return async ({question,reference,answer,caseId,component})=>{
  const raw=[];const wrapped={chat:async request=>{
   if(raw.length>=2)throw Object.assign(Error('Semantic judge response bound exceeded'),{code:'semantic_response_bound'});
   const attempt={request,state:'pending',response:null,cost:null};raw.push(attempt);
   try{const response=await llm.chat(request);attempt.response=response;attempt.cost=Number.isFinite(response.cost)?response.cost:null;attempt.state='response-received';if(attempt.cost===null)throw Error('Semantic judge accounted cost unknown');return response;}
   catch(error){attempt.state=attempt.response?'response-received-accounting-unknown':'unknown-no-response';attempt.error={name:error.name,message:error.message};throw error;}
  }};
  let result;
  try{
   do{
    result=await judgeAnswer({llm:wrapped,model:SEMANTIC_SEED_JUDGE.model,question:{question,reference},answer,label:'judge',meta:{caseId,component}});
    if(result.ok&&!result.malformed)break;
   }while(raw.length<2);
  }catch(error){if(error.code!=='semantic_response_bound'){error.semanticRaw=raw;throw error;}result={ok:false,malformed:true,points:[],score:null};}
  return {...result,cost:raw.reduce((n,r)=>n+(r.response.cost??0),0),tokens:{prompt:raw.reduce((n,r)=>n+(r.response.usage?.promptTokens??0),0),completion:raw.reduce((n,r)=>n+(r.response.usage?.completionTokens??0),0),calls:raw.length},raw,model:SEMANTIC_SEED_JUDGE.model,provider:SEMANTIC_SEED_JUDGE.provider};
 };
}
export async function reviewDirectory(out,{benchmark,sharedBudget,model='deepseek-flash'}){
 const {judgeAnswer}=await import('../knowledge-pages/lib/judge.mjs');
 const {JUDGE_SYSTEM}=await import('../knowledge-pages/lib/prompts.mjs');
 const benchmarkSha256=createHash('sha256').update(JSON.stringify(benchmark)).digest('hex'),judgePromptSha256=createHash('sha256').update(JUDGE_SYSTEM).digest('hex');
 const execution=JSON.parse(await fs.readFile(path.join(out,'execution.json'),'utf8'));
 if(execution.benchmarkSha256!==benchmarkSha256)throw new Error('Frozen benchmark identity differs from collected execution');
 const llm=coordinatorJudgeClient(sharedBudget,{model});
 const judge=({question,reference,answer,caseId})=>judgeAnswer({llm,model,question:{question,reference},answer,label:'judge',meta:{caseId}});
 const sanityPath=path.join(out,'judge-sanity.json');
 let sanity;try{sanity=JSON.parse(await fs.readFile(sanityPath,'utf8'));}catch{
  const samples=['general','medical'].map(s=>benchmark.cases.find(c=>c.stratum===s&&!c.unanswerable));const rows=[];
  for(const c of samples){const reference=referenceFor(c);rows.push({caseId:c.id,reference:await judge({question:c.prompt,reference,answer:reference.keyPoints.map(p=>p.text).join('\n'),caseId:c.id}),empty:await judge({question:c.prompt,reference,answer:'',caseId:c.id})});}
  sanity={method:'unchanged knowledge-pages key-point judge',benchmarkSha256,judgePromptSha256,model,budgetId:sharedBudget.sharedBudgetId,rows,ok:rows.every(r=>r.reference.ok&&!r.reference.malformed&&r.reference.score>=0.9&&r.empty.ok&&!r.empty.malformed&&r.empty.score<=0.1)};
  await fs.writeFile(sanityPath,JSON.stringify(sanity,null,2));
 }
 if(sanity.benchmarkSha256!==benchmarkSha256||sanity.judgePromptSha256!==judgePromptSha256||sanity.model!==model||sanity.budgetId!==sharedBudget.sharedBudgetId||!sanity.ok)throw new Error('Automatic judge sanity/model/budget identity failed');
 const observations=path.join(out,'reviewed-observations.jsonl');let rows=[];
 try{rows=(await fs.readFile(observations,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
 const seen=new Set(rows.map(r=>r.evidence.runId)),complete=new Set(rows.map(r=>`${r.caseId}:${r.arm}:${r.repetition}`));
 const failures=[];
 for(const filename of (await fs.readdir(out)).sort()){
  if(!/^(baseline|candidate)-.+-[123]\.json$/.test(filename))continue;
  const e=JSON.parse(await fs.readFile(path.join(out,filename),'utf8')),c=benchmark.cases.find(c=>c.id===e.caseId&&c.stratum!=='lifecycle');
  if(!c||complete.has(`${c.id}:${e.arm}:${e.repetition}`))continue;
  try{const failure=JSON.parse(await fs.readFile(path.join(out,filename.replace('.json','.failure.json')),'utf8'));failures.push({...failure,status:'inconclusive'});continue;}catch(error){if(error.code!=='ENOENT')throw error;}
  const provisional={caseId:c.id,prompt:c.prompt,actor:c.actor,project:c.project,arm:e.arm,repetition:e.repetition,evidence:{runId:e.run?.id,provider:e.runtime?.model}};
  try{validateCollectedEvidence(c,provisional,e,seen);}catch(error){failures.push({caseId:c.id,arm:e.arm,repetition:e.repetition,status:'inconclusive',reason:error.message});continue;}
  let row;try{row=await judgedObservation(c,e,{judge,filename});}catch(error){if(/budget|identity|auth/i.test(error.message))throw error;failures.push({caseId:c.id,arm:e.arm,repetition:e.repetition,status:'inconclusive',reason:error.message});continue;}
  await fs.appendFile(observations,JSON.stringify(row)+'\n');rows.push(row);complete.add(`${c.id}:${e.arm}:${e.repetition}`);
 }
 await fs.writeFile(path.join(out,'automatic-review-inconclusive.json'),JSON.stringify(failures,null,2));
 const lifecycleRows=[];
 for(const file of await fs.readdir(out)){const m=/^(baseline|candidate)-lifecycle-([123])\.json$/.exec(file);if(!m)continue;const measured=JSON.parse(await fs.readFile(path.join(out,file),'utf8'));if(measured.qualityEligible!==true)continue;for(const r of measured.rows)lifecycleRows.push({caseId:r.caseId,arm:m[1],repetition:Number(m[2]),score:r.status==='pass'?1:0,violations:r.status==='fail'?[r.error??'Lifecycle violation']:[]});}
 const summary=summarize(benchmark,[...rows,...lifecycleRows]);summary.judgeSanity=sanity;summary.citationReview={unresolvedRows:rows.filter(r=>r.citationReview.unresolved).length,method:'literal original identifiers only; not a claim of complete quotation verification'};
 await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));return {observations:rows.length,inconclusive:failures.length,verdict:summary.verdict};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [out,configFile]=process.argv.slice(2);if(!out||!configFile)throw new Error('Usage: node automatic_judge.mjs <results-directory> <private-collector-config>');
 const config=JSON.parse(await fs.readFile(configFile,'utf8')),benchmark=JSON.parse(await fs.readFile(new URL('./cases.json',import.meta.url),'utf8'));
 console.log(JSON.stringify(await reviewDirectory(out,{benchmark,sharedBudget:config.sharedBudget})));
}
