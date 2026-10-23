// Evaluation-only model-provider proxy; every provider URL is configured server-side, never supplied by a request.
import http from 'node:http';
import {resolveOperatorContainer} from './container_identity.mjs';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import deps from '../../deps-version.json' with {type:'json'};
import { priceListAt } from '../../packages/domain/src/metering.mjs';
import { SharedBudget,processStartedAt } from './shared_budget.mjs';
import {RERANK_REFERENCE,assertRerankProvider,rerankInputBound,readRerankResponse,rerankUsage} from './rerank_budget.mjs';
export async function createBudgetProxy({models,providers,token,capCny=50,ledgerFile,id,operatorBindingsFile=null,fetchImpl=fetch}) {
 const verifyProcess=proof=>{
  if(!proof||!proof.processStart||processStartedAt(proof.processId)!==proof.processStart)throw new Error('Provider process identity changed');
  if(operatorBindingsFile){if(!proof.container)throw new Error('Operator container admission is required');const actual=resolveOperatorContainer(operatorBindingsFile,proof.container.containerId,proof.container.scope,proof.container.namespacePid);if(actual.hostPid!==proof.processId)throw new Error('Operator container process changed');}
 };
 if(!ledgerFile)throw new Error('A durable owned shared-budget ledger is required');
 const priceList=priceListAt(new Date());
 for(const [name,p] of Object.entries(models)){
  if(name===RERANK_REFERENCE.model&&(p.kind!=='rerank'||p.output!==0||p.maxOutput!==0))throw new Error('Rerank kind and zero generated-output bound are required');
  if(p.kind==='rerank'&&name!==RERANK_REFERENCE.model)throw new Error('Unpriced rerank model');
  const canonical=priceList?.model?.[name]??(name===deps.openviking?.embedding?.model?{cacheMiss:priceList.embeddingPerMillion,output:0}:name===RERANK_REFERENCE.model?RERANK_REFERENCE:null);
  if(!canonical||p.input<canonical.cacheMiss||p.output<canonical.output)throw new Error('Unpriced or underpriced model refused by canonical price list');
 }
 for(const target of Object.values(providers))if(target.kind==='rerank')assertRerankProvider(target);
 const budget=new SharedBudget({models,capCny,ledgerFile,id});const wiring={};let armed=false;
 const server=http.createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.headers.authorization!==`Bearer ${token}`)return send(401,{error:'unauthorized'});
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/__eval/status')return send(200,{...budget.status(),nonce:url.searchParams.get('nonce'),wiring,armed});
  const direct=/^\/scope\/(baseline|candidate|openviking|C)\/([a-z0-9-]+)\/(?:(?:compatible-mode|compatible-api)\/)?v1\/(?:chat\/completions|embeddings|reranks)$/.exec(url.pathname);
  if(req.method!=='POST'||(!['/__eval/probe','/__eval/arm','/provider'].includes(url.pathname)&&!direct))return send(404,{error:'route'});
  let reservation=null;let raw='';try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2000000)throw new Error('Request too large');}
   const parsed=JSON.parse(raw);
   const body=direct?{scope:direct[1],provider:direct[2],request:parsed}:parsed;
   if(url.pathname==='/__eval/arm'){
    if(body.budgetId!==budget.id||!['baseline','candidate','openviking'].every(s=>wiring[s]?.providerBoundary&&wiring[s].processStart===processStartedAt(wiring[s].processId)))throw new Error('Live provider wiring incomplete');
    for(const scope of ['baseline','candidate','openviking'])verifyProcess(wiring[scope]);
    armed=true;return send(200,{id:budget.id,armed});
   }
   if(url.pathname==='/__eval/probe'){
    if(!['baseline','candidate','openviking','C'].includes(body.scope)||!Number.isSafeInteger(body.processId))throw new Error('Invalid boundary probe');
    if(operatorBindingsFile&&!body.containerId)throw new Error('Operator container admission cannot be omitted');
    const container=body.containerId?resolveOperatorContainer(operatorBindingsFile,body.containerId,body.scope,body.processId):null;
    const processId=container?.hostPid??body.processId;
    wiring[body.scope]={instrumented:true,container,processId,processStart:processStartedAt(processId),at:Date.now(),budgetId:budget.id};return send(200,{budgetId:budget.id,probe:body.nonce});
   }
   const {provider,scope,request}=body;const target=providers[provider];
   if(!target||!request||!['baseline','candidate','openviking','C','judge'].includes(scope))throw new Error('Unadmitted provider path');
   const model=Object.hasOwn(models,request.model)?models[request.model]:null;if(!model)throw new Error('Unpriced model');
   const embedding=model.kind==='embedding';
   const rerank=model.kind==='rerank';
   if(rerank!==(target.kind==='rerank'))throw new Error('Provider/model kind mismatch');
   if(!embedding&&!rerank&&(!Number.isSafeInteger(request.max_tokens)||request.max_tokens<1||request.max_tokens>model.maxOutput))throw new Error('Explicit bounded output required before provider call');
   const streaming=request.stream===true;
   if(streaming)request.stream_options={include_usage:true};
   if(!embedding&&!rerank&&Object.keys(request).some(k=>!['model','messages','tools','tool_choice','max_tokens','temperature','response_format','thinking','reasoning_effort','stream','stream_options'].includes(k)))throw new Error('Unbounded request field');
   if(!embedding&&!rerank&&request.reasoning_effort!==undefined&&!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(request.reasoning_effort))throw new Error('Invalid reasoning effort');
   if(!embedding&&!rerank&&(!Array.isArray(request.messages)||request.messages.some(m=>typeof m.content!=='string'&&m.content!==null)))throw new Error('Unbounded multimodal input');
   // UTF-8 bytes bound text tokens; per-message/tool overhead is deliberately conservative.
   if(embedding&&!Array.isArray(request.input)&&typeof request.input!=='string'&&!Array.isArray(request.input?.texts))throw new Error('Unbounded embedding input');
   const inputTokens=rerank?rerankInputBound(request):Buffer.byteLength(JSON.stringify(request))+4096*((request.messages?.length??0)+(request.tools?.length??0)+(request.input?.length??request.input?.texts?.length??0)+1);
   const prior=wiring[scope];
   if(scope!=='judge')verifyProcess(prior);
   wiring[scope]={...prior,providerBoundary:true,processId:prior?.processId??process.pid,processStart:prior?.processStart??processStartedAt(process.pid),at:Date.now(),budgetId:budget.id,provider};
   if(!armed)return send(503,{error:'Budget dry probe recorded; no provider request was made. Collectors must verify all paths before arming.'});
   reservation=budget.reserve({scope,model:request.model,inputTokens,maxOutputTokens:embedding||rerank?0:request.max_tokens});
   const key=fs.readFileSync(target.keyFile,'utf8').trim();
   const upstream=await fetchImpl(target.url,{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(request),signal:AbortSignal.timeout(180000)});
   const providerRaw=rerank?await readRerankResponse(upstream):await upstream.text();
   const chunks=streaming?providerRaw.split('\n').filter(l=>l.startsWith('data: ')&&l.slice(6)!=='[DONE]').map(l=>JSON.parse(l.slice(6))):[JSON.parse(providerRaw)];
   const result=chunks.findLast(c=>c.usage);
   if(!upstream.ok||!result?.usage)throw new Error('Provider accounting unavailable; full reservation retained');
   if(result.model&&target.responseModel&&result.model!==target.responseModel)throw new Error('Provider model identity mismatch; reservation retained');
   const usage=rerank?rerankUsage(result):{inputTokens:result.usage.prompt_tokens??result.usage.total_tokens??result.usage.input_tokens,outputTokens:embedding?0:result.usage.completion_tokens};
   budget.settle(reservation,usage);
   const rate=models[request.model],accountedCost=Math.ceil(usage.inputTokens*rate.input+usage.outputTokens*rate.output)/1000000;
   res.writeHead(upstream.status,{'content-type':streaming?'text/event-stream':'application/json','x-evimed-eval-budget-id':budget.id,'x-evimed-eval-accounted-cny':String(accountedCost)});return res.end(providerRaw);
  }catch{ if(reservation&&budget.pending.has(reservation))budget.holdUncertain(reservation);return send(503,{error:'Shared budget admission or provider accounting failed; any reservation is retained'}); }
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:`http://127.0.0.1:${server.address().port}`,budget,wiring,close:()=>new Promise(resolve=>server.close(resolve))};
}
/** Install before importing/starting the isolated control plane. Unadmitted provider calls are refused. */
export async function installBudgetFetch({scope,coordinatorUrl,tokenFile,providerOrigins,providerRoutes={},containerId=null,fetchImpl=globalThis.fetch}) {
 const token=fs.readFileSync(tokenFile,'utf8').trim();
 const wrapped=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url??String(input));
  const provider=providerRoutes[url.origin+url.pathname]??providerOrigins[url.origin];
  const modelPath=/\/(chat\/completions|embeddings|reranks?|responses|messages|text-embedding|text-generation|generation)$/.test(url.pathname);
  if(!modelPath&&!provider)return fetchImpl(input,init);
  if(!provider)throw new Error('Evaluation provider bypass refused');
  const request=JSON.parse(init.body);
  if(request.model==='__eval_boundary_probe__')return fetchImpl(`${coordinatorUrl}/__eval/probe`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({scope,processId:process.pid,containerId,nonce:request.nonce})});
  return fetchImpl(`${coordinatorUrl}/provider`,{method:'POST',signal:init.signal,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({provider,scope,request})});
 };
 const origin=Object.keys(providerOrigins)[0];if(!origin)throw new Error('No provider origin admitted');
 const nonce=randomBytes(16).toString('hex');
 const probe=await wrapped(`${origin}/chat/completions`,{body:JSON.stringify({model:'__eval_boundary_probe__',nonce})});
 const result=await probe.json();if(result.probe!==nonce)throw new Error(`Live provider-boundary proof failed: ${result.error??'nonce mismatch'}`);
 globalThis.fetch=wrapped;
 return wrapped;
}
