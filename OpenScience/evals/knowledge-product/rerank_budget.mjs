// Eval-only reference rate; the product meter does not price reranking.
// Verified 2026-10-23: https://help.aliyun.com/en/model-studio/qwen3-rerank
// Beijing text input CNY 0.5 / million tokens, no generated output. This is a conservative estimate, not an invoice.
export const RERANK_REFERENCE=Object.freeze({model:'qwen3-rerank',cacheMiss:0.5,output:0,region:'cn-beijing'});
const MAX_TEXT_BYTES=32768;
const MAX_INSTRUCTION_BYTES=8192;
const MAX_DOCUMENTS=100;
const MAX_RESPONSE_BYTES=262144;

export function assertRerankProvider(target) {
 const url=new URL(target.url);
 const beijing=url.hostname==='dashscope.aliyuncs.com'||/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname);
 if(target.kind!=='rerank'||url.protocol!=='https:'||!beijing||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/compatible-api/v1/reranks')throw new Error('Rerank endpoint must use the admitted Beijing region and compatible API');
 if(target.responseModel!==RERANK_REFERENCE.model)throw new Error('Rerank response model identity is required');
}

/** No tokenizer estimate may count a query only once: billing repeats it for every document.
 * UTF-8 bytes bound text tokens, with instruction bytes and overhead repeated conservatively as well.
 * https://help.aliyun.com/en/model-studio/text-rerank-api */
export function rerankInputBound(request) {
 const allowed=new Set(['model','query','documents','top_n','instruct','return_documents']);
 if(Object.keys(request).some(k=>!allowed.has(k)))throw new Error('Unbounded rerank field');
 const textBytes=(s,limit)=>{if(typeof s!=='string'||!s.trim()||Buffer.byteLength(s)>limit)throw new Error('Rerank requires bounded nonempty text');return Buffer.byteLength(s);};
 const query=textBytes(request.query,MAX_TEXT_BYTES);
 const docs=request.documents;
 if(!Array.isArray(docs)||docs.length<1||docs.length>MAX_DOCUMENTS)throw new Error('Invalid rerank document count');
 if(!Number.isSafeInteger(request.top_n)||request.top_n<1||request.top_n>docs.length)throw new Error('Invalid rerank output count');
 if(request.return_documents!==undefined&&request.return_documents!==false)throw new Error('Rerank original-document echo is not admitted');
 const instruction=request.instruct===undefined?0:textBytes(request.instruct,MAX_INSTRUCTION_BYTES);
 return (query+instruction+4096)*docs.length+docs.reduce((n,d)=>n+textBytes(d,MAX_TEXT_BYTES),0)+4096;
}

export async function readRerankResponse(response) {
 const chunks=[];let bytes=0;
 if(!response.body)throw new Error('Missing rerank response');
 for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>MAX_RESPONSE_BYTES)throw new Error('Rerank response exceeds finite output bound');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks).toString('utf8');
}

export function rerankUsage(result) {
 const tokens=result?.usage?.total_tokens;
 // The compatible API may omit model. Endpoint + configured/requested model are pinned before dispatch;
 // absence is not independently echoed provider identity. Never synthesize a returned model.
 if((result?.model!==undefined&&result.model!==RERANK_REFERENCE.model)||result?.code||!Number.isSafeInteger(tokens)||tokens<=0)throw new Error('Rerank identity/accounting unavailable; reservation retained');
 return {inputTokens:tokens,outputTokens:0};
}
