import {errorCodeMessage} from '@evimed/domain';
import {HttpError,readBody} from './security.mjs';

const METHODS = Object.freeze({open:['sessionId','tabId','viewport'],command:['id','sessionId','tabId','sequence','command'],snapshot:['id','sessionId','tabId'],close:['id','sessionId','tabId']});
/** Frame identity is authenticated by the caller. Nothing in JSON can select another tenant or a transport. */
export async function handleManagedBrowserRequest({req,res,pathname,scope,service,authorizeSession,revalidate}) {
  const match=/^\/__evimed_browser\/(open|command|snapshot|close)$/.exec(pathname);
  if(!pathname.startsWith('/__evimed_browser'))return false;
  if(!match||req.method!=='POST')throw new HttpError(404,'managed_browser_not_found','The browser operation is unavailable.');
  if(String(req.headers['content-type']??'').split(';')[0].trim().toLowerCase()!=='application/json')throw new HttpError(400,'managed_browser_invalid','JSON is required.');
  let body;
  try{body=JSON.parse((await readBody(req,16384)).toString('utf8'));}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'managed_browser_invalid','The browser request is invalid.');}
  const method=match[1],keys=METHODS[method];
  const required=method==='close'?keys.filter(key=>key!=='id'):keys;
  if(!body||typeof body!=='object'||Array.isArray(body)||required.some(key=>!Object.hasOwn(body,key))
    ||Object.keys(body).some(key=>!keys.includes(key))||typeof body.sessionId!=='string'||!body.sessionId||body.sessionId.length>128)throw new HttpError(400,'managed_browser_invalid','The browser request is invalid.');
  await authorizeSession(body.sessionId);
  await revalidate();
  if(!service)throw new HttpError(503,'managed_browser_unavailable','The managed browser is unavailable.');
  const result=await service[method==='close'?'closePage':method](scope,body);
  try{await revalidate();}catch(error){await service.releaseFrame(scope.userId,scope.frameId);throw error;}
  const response=result?.state?.error ? {...result,state:{...result.state,error:{code:result.state.error.code,message:errorCodeMessage(result.state.error.code)}}} : result;
  const payload=Buffer.from(JSON.stringify({data:response??true}));
  if(payload.length>2*1024*1024)throw new HttpError(502,'managed_browser_unavailable','The browser response exceeded its limit.');
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':String(payload.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  res.end(payload);return true;
}
