import {defineTool,registerTool,configSchema,registerExtensionConfiguration} from '@evimed/harness-port';
import fs from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import {constants} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {sendWithFreshWorkloadToken} from '../../src/workloadRequest.mjs';
import {describeOperationParam,normalizeSkillOperation,renderOperationSummary} from '@evimed/domain';
import {COWORK_OPERATIONS,toolParameters} from './operations.mjs';

const Schema=await configSchema();
export const name='evimed-cowork-bridge';
export const inject=['tools','agents'];
export const Config=Schema.object({projectionFile:Schema.string().default(''),gatewayUrl:Schema.string().default(''),tokenFile:Schema.string().default(''),generationTokenFile:Schema.string().default('')});
const fail=()=>new Error('extension_access_denied');
/** Platform files are bounded regular bytes, never a workspace resource lookup. @param {string} target @param {number} limit */
async function fixedFile(target,limit){const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw fail();const bytes=Buffer.alloc(limit+1),read=await handle.read(bytes,0,bytes.length,0);if(read.bytesRead>limit||read.bytesRead!==stat.size)throw fail();return bytes.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}}

/** Registry context is factual correlation only. The hosted gateway independently checks current native session/tool authority.
 * @param {any} ctx @param {any} call @param {string} toolName @param {any} definition @param {string} runtimeGeneration */
export function nativeCoworkInvocation(ctx,call,toolName,definition,runtimeGeneration){
  const sessionId=call?.sessionId??call?.agent?.session?.header?.id;
  const agent=call?.agent??ctx.agents.get(call?.agentId);
  if(!sessionId||!agent||agent.id!==sessionId||agent.session?.header?.id!==sessionId||ctx.agents.get(sessionId)!==agent||ctx.tools.get(toolName,agent)!==definition
    ||call.nested===true||call.parent!=null
    ||call.name!==toolName||typeof call.callId!=='string'||typeof call.rootCallId!=='string'||!(call.signal instanceof AbortSignal)
    ||typeof runtimeGeneration!=='string'||!runtimeGeneration)throw fail();
  return{sessionId,callId:call.callId,rootCallId:call.rootCallId,agentId:agent.id,toolName,runtimeGeneration};
}

/** Keep the actual native call pending through durable execution and joined cancellation.
 * @param {any} config @param {any} invocation @param {any} request @param {AbortSignal} signal @param {typeof fetch} [transport] */
export async function callCoworkGateway(config,invocation,request,signal,transport=fetch){
  const url=new URL(config.gatewayUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/internal/extensions/v1')throw fail();
  const lifetime=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const submission={descriptorId:config.descriptorId,idempotencyKey:invocation.callId,request};
  if(typeof config.descriptorId!=='string'||!config.descriptorId)throw fail();
  const readToken=async()=>(await fixedFile(config.tokenFile,8192)).trim();
  const send=async(operation,body,currentSignal)=>{
    const token=await readToken();if(!token)throw fail();
    // A token the control plane replaced while the request was in flight is asked once more with the one the file holds now.
    const response=await sendWithFreshWorkloadToken({token,readToken,send:current=>transport(`${url.href}/${operation}`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${current}`,'content-type':'application/json','x-evimed-extension-invocation':JSON.stringify(invocation)},body:JSON.stringify(body),signal:currentSignal})});
    if(!response.ok||!response.body)throw fail();const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>12*1024*1024+16384){await response.body.cancel().catch(()=>{});throw fail();}chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());
  };
  let jobId=null;
  try{
    lifetime.throwIfAborted();const accepted=await send('execute',submission,lifetime);jobId=accepted.jobId;if(typeof jobId!=='string')throw fail();
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){lifetime.throwIfAborted();const job=await send('status',{jobId},lifetime);
      if(job.status==='succeeded')return job.result?.data??job.result;
      if(['failed','canceled'].includes(job.status))throw fail();await pause(100,undefined,{signal:lifetime});}
    throw new Error('extension_execution_timeout');
  }catch(error){
    if(jobId){const cleanupSignal=AbortSignal.timeout(45000);await send('cancel',{jobId},cleanupSignal);
      while(!cleanupSignal.aborted){const job=await send('status',{jobId},cleanupSignal);if(['succeeded','failed','canceled'].includes(job.status))break;await pause(100,undefined,{signal:cleanupSignal});}
      cleanupSignal.throwIfAborted();}
    throw error;
  }
}

/** Read through the domain's own reader, so a field it would drop is not in the help either. */
const OPERATIONS=new Map(COWORK_OPERATIONS.map(raw=>normalizeSkillOperation(raw)).filter(operation=>operation!==null).map(operation=>[operation.name,operation]));
/** The keys a request may carry are the operation schema's own top-level names: one list, so a key cannot be accepted here and absent from the help. @param {string} operation */
const requestKeys=operation=>[...new Set(OPERATIONS.get(operation).params.map(param=>String(param.name).split('.')[0]))];
/** @param {Record<string,any>} args @param {string} operation */
function boundedRequest(args,operation){
  const keys=requestKeys(operation);
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.getPrototypeOf(args)!==Object.prototype
    ||Reflect.ownKeys(args).some(key=>typeof key!=='string'||!keys.includes(key))
    ||Object.values(Object.getOwnPropertyDescriptors(args)).some(field=>!Object.hasOwn(field,'value')||!field.enumerable))throw new Error('extension_contract_invalid');
  const id=operation==='doc_read'?args.resourceId:args.targetId;
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))throw new Error('extension_contract_invalid');
  return{operation,...args};
}
/** The tool as the model meets it: its description and every parameter's help are written from the operation schema, never typed beside it. @param {string} operation */
const toolHelp=operation=>({description:renderOperationSummary(OPERATIONS.get(operation),{locale:'zh',maxChars:480}),
  parameters:toolParameters(OPERATIONS.get(operation),param=>describeOperationParam(param,'zh'))});
/** Platform-only injection: gateway independently authorizes the actual calling agent and opaque resources. No vendor module or secret lives here.
 * @param {(input:{request:Record<string,any>,call:any})=>Promise<any>} callGateway */
export function coworkToolSpecs(callGateway){
  return[
    {name:'doc_read',...toolHelp('doc_read'),timeoutMs:30000,concurrencySafe:true,
      execute:async(args,call)=>callGateway({request:boundedRequest(args,'doc_read'),call})},
    {name:'doc_write',...toolHelp('doc_write'),timeoutMs:30000,concurrencySafe:false,
      execute:async(args,call)=>callGateway({request:boundedRequest(args,'doc_write'),call})},
  ];
}
/** @param {any} ctx @param {(input:{request:Record<string,any>,call:any})=>Promise<any>} callGateway */
export async function registerCoworkTools(ctx,callGateway){
  const disposers=[];for(const spec of coworkToolSpecs(callGateway))disposers.push(registerTool(ctx,await defineTool(spec)));
  return()=>{for(const dispose of disposers.reverse())dispose();};
}

/** Only the selected immutable projection enables this trusted platform bridge. No vendor plugin code is mounted.
 * @param {any} ctx @param {any} config */
export async function apply(ctx,config){
  let projection={plugins:[],personal:{reference:null,pins:[]}};
  if(config.projectionFile){if(config.projectionFile!=='/opt/evimed/extensions/projection.json')throw fail();projection=JSON.parse(await fixedFile(config.projectionFile,1024*1024));}
  const external=projection.plugins.filter(plugin=>plugin.compatibility!=='legacy-citation-v1');
  if(external.length>1||external.some(plugin=>plugin.executionClass!=='isolated-tool'||plugin.coordinate?.kind!=='github'||plugin.coordinate.repository!=='Jesse-njx/dsh-cowork'||!plugin.settings||Object.keys(plugin.settings).length!==0||!Array.isArray(plugin.connectionRefs)||plugin.connectionRefs.length!==0))throw fail();
  const definitions=new Map(),selected=external[0];
  if(selected?.enabled){for(const spec of coworkToolSpecs(async({request,call})=>{
    const raw=(await fixedFile(config.generationTokenFile,8192)).trim(),parts=raw.split('.');if(parts.length!==3)throw fail();
    const generation=JSON.parse(Buffer.from(parts[1],'base64url').toString()).jti;
    const invocation=nativeCoworkInvocation(ctx,call,request.operation,definitions.get(request.operation),generation);
    return{ok:true,data:await callCoworkGateway({...config,descriptorId:selected.extensionId},invocation,request,call.signal)};
  })){const definition=await defineTool(spec);definitions.set(spec.name,definition);registerTool(ctx,definition);}}
  await registerExtensionConfiguration(ctx,{plugins:projection.plugins,definitions});
}
