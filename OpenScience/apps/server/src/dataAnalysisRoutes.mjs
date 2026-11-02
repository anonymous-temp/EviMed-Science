/** Bearer-only API: no cookie fallback, no subject impersonation and no caller-selected project. */
import { HttpError, readJson, readBody, sendJson, attachmentDisposition } from './security.mjs';
import { isPlatformAccount } from './platformAccount.mjs';
import { dataAnalysisOpenApi } from './dataAnalysisOpenApi.mjs';
import { recordDataAnalysisRefusal } from './dataAnalysisMetrics.mjs';
export const DATA_ANALYSIS_PATH='/api/data-analysis/v1';
/** @param {{config:any,apiKeys:any,store:any,service:any,mutation:(operation:()=>Promise<any>)=>Promise<any>}} dependencies */
export function createDataAnalysisRoutes({config,apiKeys,store,service,mutation}) {
  const windows=new Map();
  // Input handling holds a request body, a decoded copy and the bytes being preserved in memory, whatever key sent it:
  // the rate limit above is per key and a key costs nothing to mint, so the bound here is per account and for the server.
  const inFlight=new Map();let inFlightTotal=0;
  /** @param {string} userId @returns {()=>void} the release, called once when the input has been handled */
  const claimInput=userId=>{
    if((inFlight.get(userId)??0)>=(config.dataAnalysisMaxInputsInFlightPerAccount??2)){recordDataAnalysisRefusal('input_account');throw new HttpError(429,'analysis_input_busy','This account is already sending inputs. Retry when one has finished.');}
    if(inFlightTotal>=(config.dataAnalysisMaxInputsInFlight??6)){recordDataAnalysisRefusal('input_server');throw new HttpError(429,'analysis_input_busy','The service is receiving as many inputs as it can hold. Retry shortly.');}
    inFlight.set(userId,(inFlight.get(userId)??0)+1);inFlightTotal++;
    let released=false;
    return()=>{if(released)return;released=true;inFlightTotal--;const left=(inFlight.get(userId)??1)-1;if(left>0)inFlight.set(userId,left);else inFlight.delete(userId);};
  };
  return async function dataAnalysisRoutes(req,res){
    const url=new URL(req.url??'/','http://analysis.local');
    if(url.pathname!==DATA_ANALYSIS_PATH&&!url.pathname.startsWith(`${DATA_ANALYSIS_PATH}/`))return false;
    if(!config.dataAnalysisApiEnabled)throw new HttpError(503,'analysis_api_disabled','The data-analysis API is not enabled.');
    if(!service||!apiKeys)throw new HttpError(503,'product_state_unavailable','The data-analysis API requires durable storage.');
    if(req.method==='GET'&&url.pathname===`${DATA_ANALYSIS_PATH}/openapi.json`){sendJson(res,200,dataAnalysisOpenApi());return true;}
    if(req.headers['x-subject']!==undefined)throw new HttpError(400,'analysis_subject_unsupported','X-Subject is not supported by this API.');
    const token=/^Bearer ([^\s]+)$/.exec(String(req.headers.authorization??''))?.[1];
    const identity=await apiKeys.resolve(token),user=await store.userById(identity.userId);
    if(!user||isPlatformAccount(user))throw new HttpError(401,'agent_key_invalid','The API key is not valid.');
    const mutating=req.method!=='GET';
    if(!identity.scopes.includes(mutating?'analysis.write':'analysis.read'))throw new HttpError(403,'analysis_scope_forbidden','The API key does not grant this operation.');
    const now=Date.now();for(const [key,value] of windows)if(value.until<=now)windows.delete(key);
    if(windows.size>=10000&&!windows.has(identity.keyId))throw new HttpError(503,'analysis_api_busy','The data-analysis API is busy.');
    const window=windows.get(identity.keyId)??{until:now+60000,count:0};windows.set(identity.keyId,window);
    if(++window.count>120)throw new HttpError(429,'analysis_rate_limited','Too many analysis operations.');
    const parts=url.pathname.slice(DATA_ANALYSIS_PATH.length).split('/').filter(Boolean);
    const operation=async()=>{
      if(parts.length===1&&parts[0]==='analyses'&&req.method==='POST'){
        if(identity.projectId)throw new HttpError(403,'analysis_project_scope','A project-bound key cannot create an analysis.');
        sendJson(res,201,{data:await service.create(user,await readJson(req,config.maxJsonBytes))});return;
      }
      if(parts[0]!=='analyses'||!parts[1])throw new HttpError(404,'not_found','Route not found.');
      if(parts.length===2&&req.method==='DELETE'){sendJson(res,200,{data:await service.remove(user,parts[1],identity.projectId)});return;}
      const analysis=await service.get(user,parts[1]);
      if(identity.projectId&&identity.projectId!==analysis.projectId)throw new HttpError(403,'analysis_project_scope','The analysis is outside this key project.');
      if(parts.length===2&&req.method==='GET'){sendJson(res,200,{data:analysis});return;}
      if(parts.length===3&&parts[2]==='inputs'&&req.method==='POST'){
        const type=String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        const release=claimInput(user.id);
        try{
          const input=type==='application/octet-stream'
            ? await service.rawInput(user,analysis.id,url.searchParams.get('filename'),await readBody(req,config.dataAnalysisMaxInputBytes))
            : await service.input(user,analysis.id,await readJson(req,Math.ceil(config.dataAnalysisMaxInputBytes/3)*4+4096));
          sendJson(res,201,{data:input});return;
        }finally{release();}
      }
      if(parts.length===3&&parts[2]==='turns'&&req.method==='POST'){sendJson(res,202,{data:await service.turn(user,analysis.id,await readJson(req,config.maxJsonBytes))});return;}
      if((parts.length===4||parts.length===5&&parts[4]==='results')&&parts[2]==='turns'&&req.method==='GET'){sendJson(res,200,{data:await service.result(user,analysis.id,parts[3])});return;}
      if(parts.length===5&&parts[2]==='turns'&&parts[4]==='cancel'&&req.method==='POST'){sendJson(res,200,{data:await service.cancel(user,analysis.id,parts[3])});return;}
      if(parts.length===4&&parts[2]==='artifacts'&&req.method==='GET'){
        const {artifact,buffer}=await service.artifact(user,analysis.id,parts[3]);
        res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':attachmentDisposition(artifact.filename),'content-length':buffer.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','etag':`"${artifact.sha256}"`});res.end(buffer);return;
      }
      throw new HttpError(404,'not_found','Route not found.');
    };
    // Result reads may freeze completed files and clear a reservation. They use the same maintenance admission.
    await mutation(operation);return true;
  };
}
