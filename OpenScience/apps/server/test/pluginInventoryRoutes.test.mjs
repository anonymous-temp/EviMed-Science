import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { HttpError } from '../src/security.mjs';
import { createPluginInventoryRoutes } from '../src/pluginInventoryRoutes.mjs';
const pins=JSON.parse(readFileSync(new URL('../../../deps-version.json',import.meta.url),'utf8')).dsh;
function fixture(config={runtimeAnnotationEnabled:true,runtimeMermaidEnabled:false}) {
  const user={id:'owned-user',accountCreatedAt:'captured-epoch'},project={id:'owned-project',userId:user.id},calls=[];
  const store={ensureSessionUser:async(_req,_res,options)=>{assert.equal(options.allowDevAuth,false);return{user};},assertCsrf:async()=>calls.push('csrf'),requireProject:async(actual,id)=>{assert.equal(actual,user);if(id!==project.id)throw new HttpError(404,'project_not_found','missing');return project;}};
  const pluginService={list:async(actual,current)=>{assert.equal(actual,user);assert.equal(current,project);return{plugins:[{id:'dsh-cite',binaryVersion:pins.citeVersion,desired:{enabled:true},effective:null,phase:'pending',settingsSchema:{}}]};}};
  return{store,pluginService,user,project,calls,handler:createPluginInventoryRoutes({store,pluginService,config})};
}
async function request(f,url='/api/projects/owned-project/plugin-inventory',method='GET') {
  const req=Readable.from([]);req.url=url;req.method=method;req.headers={};let data;const headers={};
  const res={setHeader:(key,value)=>{headers[key]=value;},writeHead:status=>{res.status=status;},end:bytes=>{data=JSON.parse(String(bytes));}};
  const handled=await f.handler(req,res);return{handled,status:res.status,data,headers};
}
test('fixed inventory is pinned/configured metadata and never labels declarations runtime-ready',async()=>{
  const f=fixture(),result=await request(f);assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(result.data.data.projectId,f.project.id);
  assert.deepEqual(result.data.data.items,[
    {id:'dsh-cite',version:pins.citeVersion,kind:'tool',management:'project',configuredEnabled:true,configurationPhase:'pending',observation:'unknown'},
    {id:'dsh-annotation',version:pins.annotationVersion,kind:'client',management:'deployment',configuredEnabled:true,configurationPhase:'configured',observation:'unknown'},
    {id:'dsh-mermaid',version:pins.mermaidVersion,kind:'client',management:'deployment',configuredEnabled:false,configurationPhase:'disabled',observation:'unknown'},
  ]);assert.equal(JSON.stringify(result.data).includes('runtime-ready'),false);assert.equal(f.calls.length,1);
});
test('missing deployment switches remain unknown and optional citation503 cannot hide client configuration',async()=>{
  const f=fixture({});f.pluginService.list=async()=>{throw new HttpError(503,'product_state_unavailable','fixture');};const result=await request(f);
  assert.equal(result.data.data.items[0].configurationPhase,'unavailable');assert.equal(result.data.data.items[1].configuredEnabled,null);assert.equal(result.data.data.items[2].configurationPhase,'unknown');
});
test('authenticated captured actor/current project and closed read-only routes reject caller flags',async()=>{
  const f=fixture();await assert.rejects(request(f,'/api/projects/foreign/plugin-inventory'),{status:404});await assert.rejects(request(f,'/api/projects/owned-project/plugin-inventory?enabled=true'),{status:400});await assert.rejects(request(f,undefined,'POST'),{status:404});
  f.store.ensureSessionUser=async()=>{throw new HttpError(401,'unauthorized','fixture');};await assert.rejects(request(f),{status:401});
});
test('citation authorization failures cannot become a successful inventory response',async()=>{const f=fixture();f.pluginService.list=async()=>{throw new HttpError(404,'project_not_found','retired project');};await assert.rejects(request(f),{status:404});});
test('verified citation configuration does not certify source health or expose deployment secrets',async()=>{
  const f=fixture({runtimeAnnotationEnabled:true,runtimeMermaidEnabled:true,providerKey:'must-not-forward',runtimeToken:'must-not-forward'});
  f.pluginService.list=async()=>({plugins:[{id:'dsh-cite',phase:'effective',desired:{enabled:true},effective:{enabled:true},error:'/private/must-not-forward'}]});const result=await request(f);
  assert.equal(result.data.data.items[0].configurationPhase,'effective');assert.equal(result.data.data.items[0].observation,'unknown');assert.equal(JSON.stringify(result.data).includes('must-not-forward'),false);
});
