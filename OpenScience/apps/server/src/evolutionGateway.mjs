import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {HttpError,readJson,sendJson,sendError} from './security.mjs';
import {evolutionResultEvidence} from './evolutionUsage.mjs';
export const EVOLUTION_GATEWAY_PATH='/internal/evolution/v1';
/** Authenticated execution of a published immutable tool, never client-supplied code.
 * resolveRun reads the active accepted run ledger; admit holds shared heavy-work + budget ownership.
 * @param {{config:any,authenticateWorkload:any,resolveRun:any,runtimeManager:any,controller:any,supply:any,admit:any,onExecution?:any}} dependencies */
export function createEvolutionGatewayHandler({config,authenticateWorkload,resolveRun,runtimeManager,controller,supply,admit,onExecution=async()=>{}}){
  /** @param {any} req @param {any} res @param {((failure:{code:string,status:number})=>void)|null} [onFailure] the server's failure funnel, so a failure here leaves the error record and the metric label every other gateway's does */
  return async(req,res,onFailure=null)=>{
    const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith(EVOLUTION_GATEWAY_PATH+'/'))return false;
    const abort=new AbortController(),disconnected=()=>{if(!res.writableEnded)abort.abort();};req.once('aborted',disconnected);res.once('close',disconnected);
    /** @type {any} */
    let observation=null;
    try{
      if(config.evolutionEnabled!==true||req.method!=='POST'||url.pathname!==EVOLUTION_GATEWAY_PATH+'/execute')throw new HttpError(404,'not_found','Not found.');
      const token=/^Bearer ([^\s]+)$/.exec(String(req.headers.authorization??''))?.[1];if(!token)throw new HttpError(401,'unauthorized','A workload token is required.');
      const principal=await authenticateWorkload(token);if(!principal?.userId||!principal.projectId||!principal.runtimeGeneration)throw new HttpError(401,'unauthorized','The workload is unavailable.');
      const input=await readJson(req,1024*1024),scope=await resolveRun(principal);
      if(!scope?.project||!scope.runId||scope.project.id!==principal.projectId||scope.project.userId!==principal.userId)throw new HttpError(403,'extension_access_denied','The accepted run is unavailable.');
      const pins=runtimeManager.runtimePlatformSkills(scope.project),pin=pins.find(item=>item.id===input.toolId&&item.digest===input.digest&&item.publicationKind==='isolated-tool');
      if(!pin||pin.capabilityIds?.length&&!pin.capabilityIds.includes(scope.capabilityId))throw new HttpError(403,'extension_access_denied','The tool is outside this run scope.');
      const current=await authenticateWorkload(token);if(!current||current.runtimeGeneration!==principal.runtimeGeneration)throw new HttpError(409,'extension_contract_invalid','The runtime generation changed.');
      const identity={callId:randomUUID(),projectId:scope.project.id,userId:principal.userId,runId:scope.runId,toolId:pin.id,revision:pin.revision,digest:pin.digest,
        inputSha256:createHash('sha256').update(canonicalJson(input.args??null)).digest('hex')};
      const result=await admit(scope,()=>supply.executeIsolated({...scope.project,capabilityId:scope.capabilityId},input,async(body,options)=>{
        try { const execution=await controller.execVerify(body,options); if(execution?.joined===true&&execution.executionStarted===true)observation=identity; return execution; }
        catch(error){if(error?.joined===true&&error.executionStarted===true)observation=identity;throw error;}
      },{signal:abort.signal,pins}));
      if(observation)await onExecution({...observation,result:{ok:true},resultEvidence:evolutionResultEvidence(result)});
      if(!res.destroyed)sendJson(res,200,{data:result,tool:{id:pin.id,revision:pin.revision,digest:pin.digest}});
    }catch(error){if(observation)await onExecution({...observation,result:{ok:false,code:error?.code??'extension_contract_invalid'}}).catch(()=>{});
      try{onFailure?.({code:typeof error?.code==='string'?error.code:'evolution_gateway_failed',status:Number.isSafeInteger(error?.status)?error.status:502});}catch{/* recording a failure never changes the answer */}
      if(!res.destroyed){
      const binding=error?.argumentBinding;
      if(error?.code==='extension_contract_invalid'&&error.status===422&&binding?.code==='argument-binding-invalid'&&[binding.expectedParameters,binding.receivedKeys].every(keys=>Array.isArray(keys)&&keys.length<=128&&keys.every(key=>typeof key==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)))){
        // Historical urllib clients expose the HTTP reason but do not print the response body.
        res.statusMessage=`Argument binding: expected (${binding.expectedParameters.join(',')}); received (${binding.receivedKeys.join(',')})`.slice(0,512);
        sendJson(res,422,{code:error.code,message:'Supply a JSON object whose keys match the named function parameters.',argumentBinding:{code:binding.code,expectedParameters:binding.expectedParameters,receivedKeys:binding.receivedKeys}});
      }
      else sendError(res,error);
    }}
    finally{req.removeListener('aborted',disconnected);res.removeListener('close',disconnected);}
    return true;
  };
}
