import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket,{WebSocketServer} from 'ws';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { GeoNativeFramePolicy } from '../src/geoNativeFramePolicy.mjs';
import { createRuntimeUiServer } from '../src/runtimeUiServer.mjs';
import { issueRuntimeUiFrame } from '../src/runtimeUiFrames.mjs';
import { PluginService } from '../src/pluginService.mjs';
import { HttpError } from '../src/security.mjs';
import { createNativeInputFixture } from './helpers/geoNativeInputFixture.mjs';
const origin='https://science.example:8443';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL&&'Disposable PostgreSQL required',timeout:10000};
async function fixture(t,{projectItem=null,preparePrompt=null}={}){
  const f=await createNativeInputFixture(t),dir=await mkdtemp(path.join(os.tmpdir(),'input-transport-'));
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
    resolveDelegatedFrame:async(actor,delegation)=>f.authority.resolve(actor,{kind:'geo',geoProjectId:f.geo.id,sessionId:'root'},{claims:delegation}),
    createDelegatedPolicy:async identity=>new GeoNativeFramePolicy({...identity,authority:f.authority,config:f.config,runtimeManager:manager,nativeInputs:f.journal})});
  const address=await ui.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}${frame.prefix.slice(0,-1)}`;
  t.after(async()=>{for(const client of clients)client.terminate();for(const peer of peers)peer.terminate();await ui.close();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>upstream.close(resolve));await rm(dir,{recursive:true,force:true});});
  const connect=async()=>{const ws=new WebSocket(base.replace('http','ws')+'/api/remote.mux',{headers:{Cookie:cookie,Origin:origin}});clients.add(ws);const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});return{ws,messages};};
  const post=(id,request=f.request(id))=>fetch(base+'/api/session/prompt',{method:'POST',headers:{cookie,Origin:origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:`rpc-${id}`,method:'session/prompt',payload:{args:{request}}})});
  return {...f,manager,upstream,wss,peers,connect,post};
}
async function eventually(check){for(let i=0;i<50;i++){if(await check())return;await delay(10);}assert.fail('Expected transport outcome within 500ms');}

for (const field of ['nativeOperation','questionProof']) test(`client ${field} cannot replace prompt provenance on HTTP or MUX`,options,async t=>{
  const f=await fixture(t,{preparePrompt:async(_project,request)=>{request.content.push({type:'text',text:'Unpreviewed content.'});}});
  let sends=0;
  f.upstream.on('request',(req,res)=>{sends++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:'rpc-spoof-http',result:{ok:true,value:{accepted:true}}}));});
  const request=f.request('spoof-http');request[field]={content:structuredClone(request.content)};
  const response=await f.post(request.requestId,request);await response.text();
  assert.equal(response.status,409);assert.equal(sends,0);
  assert.equal(await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId),null);
  const c=await f.connect(),peer=[...f.peers][0];peer.on('message',()=>{sends++;});
  const mux=f.request('spoof-mux');mux[field]={content:structuredClone(mux.content)};
  c.ws.send(JSON.stringify({type:'open',streamId:'spoof',endpoint:'session/prompt',payload:{args:{request:mux}}}));
  await eventually(()=>c.messages.some(item=>item.type==='error'));
  assert.equal(sends,0);
  assert.equal(await f.journal.receipt(f.project,f.policy.namespace.id,'root',mux.requestId),null);
});

test('reserved fields cannot turn changed content into an exact retry or overwrite a prior receipt',options,async t=>{
  const f=await fixture(t),request=f.request('spoof-retry');
  await f.prepare(request);const original=await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId);
  const changed=structuredClone(request);changed.content=[{type:'text',text:'Different statement.'}];
  changed.nativeOperation={content:request.content};changed.questionProof={callId:'fake',questions:[],answers:[]};
  await assert.rejects(f.prepare(changed),{code:'geo_native_input_conflict'});
  delete changed.nativeOperation;delete changed.questionProof;
  await assert.rejects(f.prepare(changed),{code:'geo_native_input_conflict'});
  assert.deepEqual(await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId),original);
});

test('real HTTP callback records accepted before a later projection failure and clears pool1 plugin fence',options,async t=>{
  const f=await fixture(t);f.upstream.on('request',(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{accepted:true}}}));});});
  const original=f.manager.proxy.bind(f.manager);
  f.manager.proxy=(req,res,project,suffix,options)=>original(req,res,project,suffix,{...options,transformResponse:async()=>{throw new HttpError(403,'projection-fixture','fixture');}});
  await f.post('http-accepted').catch(()=>{});
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root','http-accepted');assert.equal(row.payload.state,'accepted');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
});
test('raw MUX split accepted item/end settles through occupied response projection queue on pool1',options,async t=>{
  let release,entered;const occupied=new Promise(resolve=>{release=resolve;}),projectionEntered=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{projectItem:async(endpoint,project)=>{if(endpoint==='session/list'){entered();await occupied;}return project();}});
  const c=await f.connect(),peer=[...f.peers][0];
  peer.on('message',raw=>{const frame=JSON.parse(raw);if(frame.endpoint==='session/list')peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{items:[{sessionId:'root',running:false}]}}));
    if(frame.endpoint==='session/prompt'){peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{accepted:true}}));setTimeout(()=>peer.send(JSON.stringify({type:'end',streamId:frame.streamId})),15);}});
  c.ws.send(JSON.stringify({type:'open',streamId:'occupied',endpoint:'session/list',payload:{args:{_request:{}}}}));await projectionEntered;
  c.ws.send(JSON.stringify({type:'open',streamId:'prompt',endpoint:'session/prompt',payload:{args:{request:f.request('mux-accepted')}}}));
  try{
    await delay(50);
    const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root','mux-accepted');assert.equal(row?.payload.state,'accepted');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
    assert.equal(c.messages.length,0,'the occupied projection has not completed');
  }finally{release();}
  await eventually(()=>c.messages.some(item=>item.streamId==='prompt'&&item.type==='end'));
});
test('raw MUX end-only remains unknown and preserves plugin admission on pool1',options,async t=>{
  const f=await fixture(t),c=await f.connect(),peer=[...f.peers][0];
  peer.on('message',raw=>{const frame=JSON.parse(raw);if(frame.endpoint==='session/prompt')peer.send(JSON.stringify({type:'end',streamId:frame.streamId}));});
  c.ws.send(JSON.stringify({type:'open',streamId:'unknown',endpoint:'session/prompt',payload:{args:{request:f.request('mux-unknown')}}}));
  await eventually(()=>c.messages.some(item=>item.type==='end'));
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root','mux-unknown');assert.equal(row.payload.state,'unknown');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,1);
});
test('HTTP body observation persists acceptance when browser output is already destroyed',options,async t=>{
  const f=await fixture(t);f.upstream.on('request',(req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{accepted:true}}}));});});
  const original=f.manager.proxy.bind(f.manager);
  f.manager.proxy=(req,res,project,suffix,options)=>original(req,res,project,suffix,{...options,observeResponse:async response=>{res.destroy();await options.observeResponse(response);}});
  await f.post('http-disconnected').catch(()=>{});
  await eventually(async()=> (await f.journal.receipt(f.project,f.policy.namespace.id,'root','http-disconnected'))?.payload.state==='accepted');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
});
test('raw MUX accepted item remains accepted after carrier loss before end',options,async t=>{
  const f=await fixture(t),c=await f.connect(),peer=[...f.peers][0];
  peer.on('message',raw=>{const frame=JSON.parse(raw);if(frame.endpoint==='session/prompt'){peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{accepted:true}}));setTimeout(()=>peer.close(),10);}});
  c.ws.send(JSON.stringify({type:'open',streamId:'lost-end',endpoint:'session/prompt',payload:{args:{request:f.request('mux-disconnected')}}}));
  await eventually(async()=> (await f.journal.receipt(f.project,f.policy.namespace.id,'root','mux-disconnected'))?.payload.state==='accepted');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
});
test('actual continued-answer RPC uses sequenced native question proof and records its authenticated actor',options,async t=>{
  const {readFile}=await import('node:fs/promises'),recorded=JSON.parse(await readFile(new URL('./fixtures/dsh/native-question-reply.json',import.meta.url),'utf8'));
  const f=await fixture(t),c=await f.connect(),peer=[...f.peers][0];
  peer.on('message',raw=>{const frame=JSON.parse(raw);
    if(frame.endpoint==='session/projections')peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{kind:'sequenced',asOfSeq:10,values:{userQuestions:{active:[{callId:recorded.callId,state:'continued',questions:recorded.questions}]}}}}));
    if(frame.endpoint==='userQuestions/answer'){assert.deepEqual(frame.payload.args.answer.answers,recorded.answers);peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:true}));peer.send(JSON.stringify({type:'end',streamId:frame.streamId}));}
  });
  c.ws.send(JSON.stringify({type:'open',streamId:'questions',endpoint:'session/projections',payload:{args:{request:{sessionId:'root'}}}}));
  await eventually(()=>c.messages.some(item=>item.streamId==='questions'));
  c.ws.send(JSON.stringify({type:'open',streamId:'answer',endpoint:'userQuestions/answer',payload:{args:{agentId:'root',callId:recorded.callId,answer:{answers:recorded.answers}}}}));
  await eventually(()=>c.messages.some(item=>item.streamId==='answer'&&item.type==='end'));
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root',`reply:${recorded.callId}`);
  assert.equal(row.payload.state,'accepted');assert.equal(row.payload.actor.id,'editor');assert.equal(row.payload.candidate.reconcilable,true);
});
