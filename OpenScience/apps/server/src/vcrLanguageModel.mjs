// Unwired metered model-call adapter for a candidate language unit. The caller
// holds its study/source fence until handoff resolves. No job is registered.
import { callModelForControlPlane } from './modelGateway.mjs';
import { startVcrLanguageTransport } from './vcrLanguageTransport.mjs';

/** Complete, bounded model input; caller must have reauthorized each document. */
export function buildVcrLanguageBody({unit,criteria,documents}) {
  const sourceContext=criteria.map(criterion=>({kind:criterion.kind,sourceText:criterion.sourceText,requirement:criterion.requirement,applicability:criterion.applicability}));
  const content=JSON.stringify({question:{key:unit.criterionKey,axis:unit.axis,criteria:sourceContext},
    documents:documents.map(doc=>({documentId:doc.documentId,text:doc.text}))});
  if(Buffer.byteLength(content,'utf8')>512*1024)throw new TypeError('Language context exceeds the complete-input bound.');
  const body={model:unit.model,thinking:{type:'disabled'},temperature:0,max_tokens:unit.outputLimit,response_format:{type:'json_object'},
    messages:[{role:'system',content:'Evaluate the exact criterion and axis against the supplied records. Return JSON with state satisfied, not_satisfied or unknown, and evidence as exact documentId, start, end and quote. UTF-16 offsets. Missing evidence is unknown; do not invent facts.'},{role:'user',content}]};
  return body;
}

/** @param {{config:any,usageLedger:any,transport?:typeof startVcrLanguageTransport,handoffTimeoutMs?:number}} deps
 * @param {{unit:any,jobId:string,projectId:string,criteria:any[],documents:any[],signal?:AbortSignal,runLimit:number}} input */
export function startMeteredVcrLanguageCall({ config, usageLedger, transport = startVcrLanguageTransport, handoffTimeoutMs = 30000 }, { unit, jobId, projectId, criteria, documents, signal, runLimit }) {
  if (!usageLedger || config.deepseekProviderEnabled === false || typeof config.deepseekApiKey !== 'string' || !config.deepseekApiKey || !Number.isFinite(runLimit) || runLimit <= 0 || unit.model !== 'deepseek-flash' || unit.thinking !== 'disabled'
    || !Array.isArray(criteria) || !criteria.length || !Array.isArray(documents) || documents.length !== unit.documents.length
    || config.deepseekBaseUrl !== 'https://api.deepseek.com') throw new TypeError('A bounded metered Flash call and exact provider origin are required.');
  const body=buildVcrLanguageBody({unit,criteria,documents});
  if (!Number.isSafeInteger(handoffTimeoutMs) || handoffTimeoutMs < 1 || handoffTimeoutMs > 300000) throw new TypeError('Invalid handoff timeout.');
  const abortController=new AbortController();
  const relayAbort=()=>abortController.abort();
  signal?.addEventListener('abort',relayAbort,{once:true});
  if(signal?.aborted)relayAbort();
  const timeout=setTimeout(relayAbort,handoffTimeoutMs);timeout.unref?.();
  /** @type {()=>void} */ let resolveHandoff=()=>{};
  /** @type {(reason:unknown)=>void} */ let rejectHandoff=()=>{};
  /** @type {Promise<void>} */
  const handoff=new Promise((resolve,reject)=>{resolveHandoff=resolve;rejectHandoff=reject;});
  handoff.catch(()=>{});
  abortController.signal.addEventListener('abort',()=>rejectHandoff(new Error('Language model handoff canceled or timed out.')),{once:true});
  if(abortController.signal.aborted)rejectHandoff(new Error('Language model handoff canceled or timed out.'));
  const fetchImpl=async (endpoint, options)=>{
    if(String(endpoint)!=='https://api.deepseek.com/chat/completions'||typeof options.body!=='string')throw new TypeError('Unexpected provider transport.');
    const running=transport({apiKey:config.deepseekApiKey,encodedBody:options.body,signal:options.signal});
    running.handoff.then(()=>{clearTimeout(timeout);resolveHandoff();},rejectHandoff);
    const answer=await running.response;
    return new Response(answer.body,{status:answer.status,headers:{'content-type':'application/json'}});
  };
  const result=callModelForControlPlane({config,usageLedger,fetchImpl},{userId:unit.userId,projectId,runId:jobId,purpose:'vcr',body,signal:abortController.signal,limits:{run:runLimit}});
  result.catch(rejectHandoff);
  result.finally(()=>{clearTimeout(timeout);signal?.removeEventListener('abort',relayAbort);}).catch(()=>{});
  return {handoff,result};
}
