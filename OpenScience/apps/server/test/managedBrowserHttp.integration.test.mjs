/** Real HTTP login/frame boundary and disposable CDP; kernel inventory and public site transport are controlled fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {createWebApiApp} from '../src/server.mjs';
import {createManagedBrowserService} from '../src/managedBrowserService.mjs';
import {openRenderEgress} from '../src/webRenderEgress.mjs';

const executable=process.env.OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME;
test('signed native frames reach real isolated pages and logout physically joins their contexts',{
 skip:!executable&&'An explicit disposable Chromium executable is required; missing is not pass',timeout:90000,
},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-browser-http-cdp-')));
 let browser,service,app,observer;
 const site=http.createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>isolated</title><p>Public fixture page</p>'));
 site.listen(0,'127.0.0.1');await once(site,'listening');
 const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');
 const cdpPort=free.address().port;await new Promise(resolve=>free.close(resolve));
 try{
  browser=await chromium.launchPersistentContext(path.join(root,'browser'),{executablePath:executable,headless:true,
   args:['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+cdpPort],
   env:{PATH:process.env.PATH,HOME:root,LANG:'en_US.UTF-8'},acceptDownloads:false});
  observer=await browser.browser().newBrowserCDPSession();
  const contextCount=async()=>(await observer.send('Target.getBrowserContexts')).browserContextIds.length;
  const baseline=await contextCount();
  const uiOrigin='http://127.0.0.1:18443',config={dataDir:path.join(root,'data'),port:0,host:'127.0.0.1',
   devAuth:false,authMode:'local',selfRegistrationEnabled:true,runtimeMode:'mock',runtimeUiProxyEnabled:true,
   runtimeUiPublicOrigin:uiOrigin,publicUrl:'http://127.0.0.1:18787',managedBrowserEnabled:true,
   managedBrowserCdpUrl:`http://127.0.0.1:${cdpPort}`,edgeProxyUrl:'https://93.184.216.34',edgeProxyCredentials:'controlled:fixture',
   modelGatewaySigningSecret:'synthetic-disposable-http-frame-signing-key',learningEnabled:false,autopilotEnabled:false};
  service=createManagedBrowserService(config,{resolveImpl:async()=>[{address:'93.184.216.34',family:4}],
   openEgress:options=>openRenderEgress({...options,connectImpl:({host,port})=>{
    assert.equal(host,'93.184.216.34');assert.equal(port,80);
    return net.connect({host:'127.0.0.1',port:site.address().port});
   }})});
  app=createWebApiApp({...config,managedBrowserService:service});
  const address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`,ui=`http://127.0.0.1:${app.runtimeUi.address().port}`;
  const register=async username=>{
   const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username,password:'Disposable local managed browser fixture!'})});
   assert.equal(response.status,201);const data=(await response.json()).data;
   return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:data.csrfToken,user:data.user};
  };
  app.runtimeManager.callKernel=async(_runtime,_project,method)=>{assert.equal(method,'session/list');return{items:[{sessionId:'native'}]};};
  const frameFor=async actor=>{
   const project=await app.store.requireProject(await app.store.userById(actor.user.id),'default');app.runtimeManager.runtimes.set(app.runtimeManager.key(project),{modelGatewayTokenJti:'synthetic-native-'+actor.user.id});
   const response=await fetch(base+'/api/runtime-ui/frames',{method:'POST',headers:{cookie:actor.cookie,
    'x-open-science-csrf':actor.csrf,'content-type':'application/json'},body:JSON.stringify({projectId:'default'})});
   assert.equal(response.status,201);const data=(await response.json()).data;
   return {prefix:new URL(data.frameUrl).pathname,cookie:response.headers.get('set-cookie').split(';')[0]};
  };
  const request=(actor,frame,method,body)=>fetch(ui+frame.prefix+'__evimed_browser/'+method,{method:'POST',
   headers:{Origin:uiOrigin,cookie:actor.cookie+'; '+frame.cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  const alice=await register('managed-alice'),bob=await register('managed-bob');
  const af=await frameFor(alice),bf=await frameFor(bob),openBody={sessionId:'native',tabId:'first',viewport:{width:640,height:480}};
  let response=await request(alice,af,'open',openBody);assert.equal(response.status,200);
  const a=(await response.json()).data;
  response=await request(bob,bf,'open',openBody);assert.equal(response.status,200);const b=(await response.json()).data;
  assert.equal(await contextCount(),baseline+2);
  response=await request(alice,af,'command',{id:a.id,sessionId:'native',tabId:'first',sequence:1,
   command:{type:'navigate',url:'http://public.example.org/'}});
  assert.equal(response.status,200);assert.equal((await response.json()).data.state.title,'isolated');
  response=await request(bob,bf,'snapshot',{id:a.id,sessionId:'native',tabId:'first'});
  assert.equal(response.status,404);assert.equal((await response.json()).code,'managed_browser_not_found');
  response=await request(alice,af,'snapshot',{id:a.id,sessionId:'native',tabId:'first'});
  assert.equal(response.status,200);const image=(await response.json()).data.frame;
  assert.equal(image.mimeType,'image/jpeg');assert.equal(image.width,640);assert.equal(image.height,480);
  const logout=await fetch(base+'/api/auth/logout',{method:'POST',headers:{cookie:alice.cookie,'x-open-science-csrf':alice.csrf}});
  assert.equal(logout.status,200);assert.equal(await contextCount(),baseline+1);
  response=await request(alice,af,'snapshot',{id:a.id,sessionId:'native',tabId:'first'});assert.equal(response.status,401);
  response=await request(bob,bf,'snapshot',{id:b.id,sessionId:'native',tabId:'first'});assert.equal(response.status,200);
  // Lost-open receipt: close with the exact tab tuple still joins Bob's context.
  response=await request(bob,bf,'close',{sessionId:'native',tabId:'first'});assert.equal(response.status,200);
  assert.equal((await response.json()).data.closed,true);assert.equal(await contextCount(),baseline);
  response=await request(bob,bf,'open',openBody);assert.equal(response.status,404);
 }finally{
  app?.runtimeManager.runtimes.clear();await app?.close();await service?.close();await observer?.detach();await browser?.close();
  await new Promise(resolve=>site.close(resolve));await fs.rm(root,{recursive:true,force:true});
 }
});
