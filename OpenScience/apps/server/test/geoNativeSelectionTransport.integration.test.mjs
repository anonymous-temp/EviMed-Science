import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { GeoNativeFramePolicy } from '../src/geoNativeFramePolicy.mjs';
import { createRuntimeUiServer } from '../src/runtimeUiServer.mjs';
import { issueRuntimeUiFrame } from '../src/runtimeUiFrames.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { createNativeSelectionFixture } from './helpers/geoNativeSelectionFixture.mjs';
import { nativeInputCandidate } from '../src/geoNativeInputs.mjs';
const origin='https://science.example:8443';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required',timeout:10000};
async function fixture(t,{projectItem=null,preparePrompt=null}={}){
  const f=await createNativeSelectionFixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'input-transport-'));
  const upstream=createServer(),wss=new WebSocketServer({server:upstream}),peers=new Set(),clients=new Set();
  wss.on('connection',peer=>{peers.add(peer);peer.on('close',()=>peers.delete(peer));});
  const socketPath=path.join(dir,'kernel.sock');await new Promise(resolve=>upstream.listen(socketPath,resolve));
  const manager=new RuntimeManager(f.config);manager.pluginService=new PluginService(f.db);
  manager.start=async()=>({url:'http://kernel.local',socketPath,cookie:'native-fixture-only'});
  manager.runtimeGeneration=()=> 'generation';manager.subagentCatalogue=async()=>[];
  if(projectItem){const proxyUpgrade=manager.proxyUpgrade.bind(manager);manager.proxyUpgrade=(req,socket,head,project,suffix,policy)=>proxyUpgrade(req,socket,head,project,suffix,{...policy,
    projectItem:(endpoint,payload,value,context)=>projectItem(endpoint,()=>policy.projectItem(endpoint,payload,value,context))});}
  let loginCookie;const user=f.users.editor;
  const session=await f.accounts.createSession(user,{headers:{},socket:{}},{getHeader(){},setHeader(_key,value){loginCookie=String(value).split(';')[0];}});
  const claims=await f.claims(user),frame=issueRuntimeUiFrame({config:f.config,req:{headers:{cookie:loginCookie}},user,session,project:f.project,delegation:claims.delegation});
  const cookie=`${loginCookie}; ${frame.cookie.split(';')[0]}`;
  const ui=createRuntimeUiServer({config:f.config,store:f.accounts,runtimeManager:manager,
    ...(preparePrompt ? {preparePrompt} : {}),
    prepareSelections:async(user,project,request)=>{assert.ok(!f.db.transactionScope());await f.selections.prepare(user,project,request);},
    bindGeoPlan:(user,project,request)=>f.contexts.bind(user,project,request),
    bindResultRevision:(user,project,request)=>f.selections.bindResult(user,project,request),
    resolveDelegatedFrame:async(actor,delegation)=>f.authority.resolve(actor,{kind:'geo',geoProjectId:f.geo.id,sessionId:'root'},{claims:delegation}),
    createDelegatedPolicy:async identity=>new GeoNativeFramePolicy({...identity,authority:f.authority,config:f.config,runtimeManager:manager,nativeInputs:f.journal})});
  const address=await ui.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}${frame.prefix.slice(0,-1)}`;
  t.after(async()=>{for(const client of clients)client.terminate();for(const peer of peers)peer.terminate();await ui.close();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  const connect=async()=>{const ws=new WebSocket(base.replace('http','ws')+'/api/remote.mux',{headers:{Cookie:cookie,Origin:origin}});clients.add(ws);const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return{ws,messages};};
  const post=(id,request=f.request(id))=>fetch(base+'/api/session/prompt',{method:'POST',headers:{cookie,Origin:origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:`rpc-${id}`,method:'session/prompt',payload:{args:{request}}})});
  return {...f,manager,upstream,wss,peers,connect,post};
}
// The outcome is whichever frame the stream ends with. Waited for as an event, bounded well inside the test's timeout: a fixed
// 500 ms poll failed on a loaded machine while the same stream ended correctly a moment later.
function outcome({ws,messages},match,ms=5000){
  if(messages.some(match))return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);ws.off('message',listener);ws.off('close',closed);};
    const listener=()=>{if(messages.some(match)){done();resolve();}};
    const closed=()=>{done();reject(new assert.AssertionError({message:'The transport closed before its outcome'}));};
    const timer=setTimeout(()=>{done();reject(new assert.AssertionError({message:`Expected transport outcome within ${ms}ms`}));},ms);
    ws.on('message',listener);ws.on('close',closed);
  });
}


for(const transport of ['http','mux'])for(const mode of ['implicit','modify-existing'])test(`${transport} prepares ${mode} before pool1 admission and forwards its exact frozen candidate`,options,async t=>{
  const f=await fixture(t),request=f.request(`${transport}-${mode}`);
  if(mode==='modify-existing'){
    const id=`gpc_${'e'.repeat(64)}`;
    await f.documents.put('owner','geo-plan-context',id,{geoId:f.geo.id,actorId:'editor',sessionId:'root',state:'staged',mode:'content',
      fingerprint:'transport-modify',basisDigest:'basis',basis:{scope:{}},actions:[{work:{mode:'modify_existing',resultVersionId:f.version.versionId,digest:f.version.digest,articleId:f.articleId}}],draft:''},{projectId:f.project.id,expectedRevision:0});
    request.geoPlanContext={referenceId:id};
  }
  let sent=null;
  if(transport==='http'){
    f.upstream.on('request',(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks));sent=body.payload.args.request;
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{accepted:true}}}));
    });});
    const response=await f.post(request.requestId,request);assert.equal(response.status,200);await response.text();
  }else{
    const c=await f.connect(),peer=[...f.peers][0];
    peer.on('message',raw=>{const frame=JSON.parse(raw);if(frame.endpoint==='session/prompt'){
      sent=frame.payload.args.request;peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{accepted:true}}));peer.send(JSON.stringify({type:'end',streamId:frame.streamId}));
    }});
    c.ws.send(JSON.stringify({type:'open',streamId:'prompt',endpoint:'session/prompt',payload:{args:{request}}}));
    await outcome(c,item=>item.type==='end'||item.type==='error');
    assert.equal(c.messages.find(item=>item.type==='error'),undefined);
  }
  assert.ok(sent);
  const receipt=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  assert.equal(receipt.payload.state,'accepted');assert.equal(receipt.payload.actor.id,'editor');
  assert.equal(receipt.payload.native.originalParts,1);
  assert.equal(receipt.payload.candidate.forwardedRequestDigest,nativeInputCandidate(sent).forwardedRequestDigest);
  assert.equal(sent.content.length,mode==='implicit'?2:3);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
});
