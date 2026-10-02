import { HttpError, readJson, sendJson } from './security.mjs';
import { extensionIdentifier, extensionRequestObject } from './extensionAccess.mjs';

/** Authenticated metadata API. No arbitrary native manager/controller route is forwarded. @param {{store:any,service:any,maxJsonBytes:number}} dependencies */
export function createExtensionRoutes({store,service,maxJsonBytes}) {
  return async(req,res)=>{
    const url=new URL(req.url??'/','http://evimed.local');
    const personal=/^\/api\/extensions\/(catalogue|installations|jobs|connections)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    const project=/^\/api\/projects\/([^/]+)\/extensions(?:\/(revisions))?$/.exec(url.pathname);
    if(!personal&&!project)return false;
    const {user}=await store.ensureSessionUser(req,res,{allowDevAuth:false});await store.assertCsrf(req,url.pathname);
    if(!service)throw new HttpError(503,'product_state_unavailable','Extension metadata storage is unavailable.');
    const body=()=>readJson(req,maxJsonBytes);
    const decode=value=>{try{return extensionIdentifier(decodeURIComponent(value));}catch{throw new HttpError(400,'extension_contract_invalid','Invalid extension path.');}};
    const reply=(value,status=200)=>{res.setHeader('Cache-Control','no-store');sendJson(res,status,{data:value});return true;};
    const paging=()=>({...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),
      ...(url.searchParams.has('beforeRevision')?{beforeRevision:Number(url.searchParams.get('beforeRevision'))}:{})});
    if(project) {
      const id=decode(project[1]);
      if(!project[2]&&req.method==='GET')return reply(await service.project(user,id));
      if(!project[2]&&req.method==='PUT')return reply(await service.saveProject(user,id,await body()));
      if(project[2]==='revisions'&&req.method==='GET')return reply(await service.projectHistory(user,id,paging()));
    } else {
      const [,area,rawId,action]=personal,id=rawId?decode(rawId):null;
      if(area==='catalogue'&&!id&&!action&&req.method==='GET')return reply(await service.catalogue({query:url.searchParams.get('query')??''}));
      if(area==='connections'&&!id&&!action&&req.method==='GET')return reply(await service.connections(user,extensionRequestObject(Object.fromEntries(url.searchParams),['catalogueId','projectId'])));
      if(area==='installations') {
        if(!id&&req.method==='GET')return reply(await service.list(user,{cursor:url.searchParams.get('cursor')??null}));
        if(!id&&req.method==='POST')return reply(await service.install(user,await body()),201);
        if(id&&!action&&req.method==='GET')return reply(await service.get(user,id));
        if(id&&!action&&req.method==='DELETE')return reply(await service.remove(user,id,await body()));
        if(id&&action==='revisions'&&req.method==='GET')return reply(await service.history(user,id,paging()));
        if(id&&action==='retry'&&req.method==='POST')return reply(await service.retry(user,id,await body()));
        if(id&&action==='update'&&req.method==='POST')return reply(await service.update(user,id,await body()));
      }
      if(area==='jobs'&&id) {
        if(!action&&req.method==='GET')return reply(await service.getJob(user,id));
        if(action==='cancel'&&req.method==='POST'){extensionRequestObject(await body(),[]);return reply(await service.cancelJob(user,id));}
      }
    }
    throw new HttpError(404,'not_found','Extension route not found.');
  };
}
