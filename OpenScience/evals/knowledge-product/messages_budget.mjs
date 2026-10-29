import {createUsageTail,parseMessagesReceipt} from '../../apps/server/src/usageMetering.mjs';
const refuse=()=>{throw new Error('eval_messages_request_invalid');};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const fields=(v,keys)=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))refuse();};
const toolName=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))refuse();};
const text=v=>{if(typeof v!=='string'||Buffer.byteLength(v)>1500000)refuse();};
function blocks(value,nested=false){
 if(typeof value==='string'){text(value);return;}
 if(!Array.isArray(value)||value.length>2048)refuse();
 for(const b of value){
  if(!object(b))refuse();
  if(b.type==='text'){fields(b,['type','text','cache_control']);text(b.text);}
  else if(!nested&&b.type==='thinking'){fields(b,['type','thinking','signature']);text(b.thinking);if(b.signature!==undefined)text(b.signature);}
  else if(!nested&&b.type==='tool_use'){fields(b,['type','id','name','input']);text(b.id);toolName(b.name);if(!object(b.input))refuse();}
  else if(!nested&&b.type==='tool_result'){fields(b,['type','tool_use_id','content','is_error']);text(b.tool_use_id);blocks(b.content,true);if(b.is_error!==undefined&&typeof b.is_error!=='boolean')refuse();}
  else refuse();
  if(b.cache_control!==undefined){fields(b.cache_control,['type']);if(b.cache_control.type!=='ephemeral')refuse();}
 }
}
export function admitMessages(request,target){
 const endpoint=new URL(target.url);
 if(target.protocol!=='messages'||endpoint.pathname!=='/anthropic/v1/messages'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||!['https:','http:'].includes(endpoint.protocol))refuse();
 fields(request,['model','messages','system','max_tokens','stream','temperature','top_p','top_k','stop_sequences','tools','tool_choice','thinking','output_config','metadata']);
 if(!Number.isSafeInteger(request.max_tokens)||request.max_tokens<1||request.max_tokens>32768)refuse();
 if(request.stream!==undefined&&typeof request.stream!=='boolean')refuse();
 if(!Array.isArray(request.messages)||request.messages.length<1||request.messages.length>2048)refuse();
 for(const m of request.messages){fields(m,['role','content']);if(!['user','assistant'].includes(m.role))refuse();blocks(m.content);}
 if(request.system!==undefined)blocks(request.system,true);
 if(request.tools!==undefined){if(!Array.isArray(request.tools)||request.tools.length>256)refuse();for(const t of request.tools){fields(t,['name','description','input_schema','cache_control','defer_loading']);toolName(t.name);if(t.defer_loading!==undefined&&typeof t.defer_loading!=='boolean')refuse();if(t.description!==undefined)text(t.description);if(!object(t.input_schema))refuse();if(t.cache_control!==undefined){fields(t.cache_control,['type']);if(t.cache_control.type!=='ephemeral')refuse();}}}
 for(const key of ['temperature','top_p','top_k'])if(request[key]!==undefined&&(typeof request[key]!=='number'||!Number.isFinite(request[key])))refuse();
 if(request.stop_sequences!==undefined){if(!Array.isArray(request.stop_sequences)||request.stop_sequences.length>16)refuse();request.stop_sequences.forEach(v=>{if(typeof v!=='string'||v.length>256)refuse();});}
 if(request.thinking!==undefined){fields(request.thinking,['type','budget_tokens']);if(!['enabled','disabled','adaptive'].includes(request.thinking.type))refuse();if(request.thinking.budget_tokens!==undefined&&(!Number.isSafeInteger(request.thinking.budget_tokens)||request.thinking.budget_tokens<1||request.thinking.budget_tokens>32768))refuse();}
 if(request.output_config!==undefined){fields(request.output_config,['effort','format']);if(request.output_config.effort!==undefined&&!['low','medium','high','max'].includes(request.output_config.effort))refuse();if(request.output_config.format!==undefined){fields(request.output_config.format,['type','schema']);if(request.output_config.format.type!=='json_schema'||!object(request.output_config.format.schema))refuse();}}
 if(request.tool_choice!==undefined){fields(request.tool_choice,['type','name','disable_parallel_tool_use']);if(!['auto','any','tool','none'].includes(request.tool_choice.type))refuse();if(request.tool_choice.name!==undefined)toolName(request.tool_choice.name);if(request.tool_choice.disable_parallel_tool_use!==undefined&&typeof request.tool_choice.disable_parallel_tool_use!=='boolean')refuse();}
 if(request.metadata!==undefined){fields(request.metadata,['user_id']);if(request.metadata.user_id!==undefined)text(request.metadata.user_id);}
 return request;
}
export function messagesReceipt(raw,{stream,model}){
 const tail=createUsageTail(16384,{stream,protocol:'messages'});tail.observe(raw);
 const events=stream?raw.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5))):[JSON.parse(raw)];
 if(stream&&(!events.some(e=>e.type==='message_start'&&Number.isSafeInteger(e.message?.usage?.input_tokens))||!events.some(e=>e.type==='message_delta'&&Number.isSafeInteger(e.usage?.output_tokens))))throw new Error('eval_messages_usage_missing');
 if(events.some(e=>e.type==='error')||stream&&!tail.finished())throw new Error('eval_messages_receipt_incomplete');
 const identities=events.map(e=>e.type==='message_start'?e.message?.model:e.type==='message'?e.model:null).filter(Boolean);
 if(identities.length!==1||identities[0]!==model)throw new Error('eval_messages_model_mismatch');
 const receipt=parseMessagesReceipt(raw);if(!receipt.usage)throw new Error('eval_messages_usage_missing');
 return {inputTokens:receipt.usage.promptTokens,outputTokens:receipt.usage.completionTokens};
}
