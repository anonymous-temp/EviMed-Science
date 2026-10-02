/** Real disposable CDP Chromium; public DNS/transport are controlled local stand-ins, never a Tokyo claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {createManagedBrowserService} from '../src/managedBrowserService.mjs';
import {openRenderEgress} from '../src/webRenderEgress.mjs';
const executable=process.env.OPEN_SCIENCE_MANAGED_BROWSER_TEST_CHROME;
test('actual isolated CDP contexts enforce cookie/tenant boundaries, bounded pixels and joined owner/frame cleanup', {skip:!executable&&'An explicit owned local Chromium executable is required; absence is not pass',timeout:60000},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'evimed-managed-browser-cdp-')));let launched,service,observer;
 const site=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>empty</title><input autofocus id="value"><script>document.title=document.cookie||"empty";document.querySelector("input").addEventListener("keydown",e=>{if(e.key==="Enter"){document.cookie="scope="+e.target.value;document.title=document.cookie;}})</script>');});
 const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const cdpPort=free.address().port;await new Promise(resolve=>free.close(resolve));site.listen(0,'127.0.0.1');await once(site,'listening');const sitePort=site.address().port;
 try{
  launched=await chromium.launchPersistentContext(root,{executablePath:executable,headless:true,args:['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+cdpPort],env:{PATH:process.env.PATH,HOME:root,LANG:'en_US.UTF-8'},acceptDownloads:false});
  observer=await launched.browser().newBrowserCDPSession();
  const initial=(await observer.send('Target.getBrowserContexts')).browserContextIds.length;
  service=createManagedBrowserService({managedBrowserEnabled:true,managedBrowserCdpUrl:`http://127.0.0.1:${cdpPort}`,edgeProxyUrl:'https://93.184.216.34',edgeProxyCredentials:'controlled:fixture'},{resolveImpl:async()=>[{address:'93.184.216.34',family:4}],openEgress:options=>openRenderEgress({...options,connectImpl:({host,port})=>{assert.equal(host,'93.184.216.34');assert.equal(port,80);return net.connect({host:'127.0.0.1',port:sitePort});}})});
  const alice={userId:'alice',projectId:'p',authSessionHash:'a'.repeat(43),frameId:'a'.repeat(32)},bob={userId:'bob',projectId:'p',authSessionHash:'b'.repeat(43),frameId:'b'.repeat(32)},input={sessionId:'native',tabId:'tab',viewport:{width:640,height:480}};
  const a=await service.open(alice,input),b=await service.open(bob,input);assert.equal((await observer.send('Target.getBrowserContexts')).browserContextIds.length,initial+2);
  const body=(id,sequence,command)=>({id,sessionId:'native',tabId:'tab',sequence,command});
  const firstPage=await service.command(alice,body(a.id,1,{type:'navigate',url:'http://public.example.org/'}));assert.equal(firstPage.state.error,null);assert.equal(firstPage.state.canGoBack,false,'initial about:blank is not user navigation history');
  await service.command(alice,body(a.id,2,{type:'click',x:50,y:16,button:'left'}));
  await service.command(alice,body(a.id,3,{type:'text',text:'alice-only'}));await service.command(alice,body(a.id,4,{type:'key',key:'Enter'}));
  let observed=null;const deadline=Date.now()+5000;
  while(Date.now()<deadline){observed=await service.snapshot(alice,{id:a.id,sessionId:'native',tabId:'tab'});if(observed.state.title==='scope=alice-only')break;await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(observed?.state.title,'scope=alice-only');
  await service.command(alice,body(a.id,5,{type:'key',key:'Meta+A'}));await service.command(alice,body(a.id,6,{type:'text',text:'updated-alice'}));await service.command(alice,body(a.id,7,{type:'key',key:'Enter'}));
  assert.equal((await service.snapshot(alice,{id:a.id,sessionId:'native',tabId:'tab'})).state.title,'scope=updated-alice');
  const bobPage=await service.command(bob,body(b.id,1,{type:'navigate',url:'http://public.example.org/'}));assert.equal(bobPage.state.title,'empty');
  const nextPage=await service.command(bob,body(b.id,2,{type:'navigate',url:'http://public.example.org/second'}));assert.equal(nextPage.state.canGoBack,true);
  const back=await service.command(bob,body(b.id,3,{type:'back'}));assert.equal(back.state.url,'http://public.example.org/');assert.equal(back.state.canGoBack,false);assert.equal(back.state.canGoForward,true);
  const forward=await service.command(bob,body(b.id,4,{type:'forward'}));assert.equal(forward.state.url,'http://public.example.org/second');assert.equal(forward.state.canGoForward,false);
  const second=await service.open(alice,{...input,tabId:'second-occurrence'});
  const secondPage=await service.command(alice,{...body(second.id,1,{type:'navigate',url:'http://public.example.org/'}),tabId:'second-occurrence'});assert.equal(secondPage.state.title,'empty');
  assert.equal((await observer.send('Target.getBrowserContexts')).browserContextIds.length,initial+3);
  await assert.rejects(service.snapshot(bob,{id:a.id,sessionId:'native',tabId:'tab'}),{code:'managed_browser_not_found'});
  const picture=await service.snapshot(alice,{id:a.id,sessionId:'native',tabId:'tab'});assert.equal(picture.frame.mimeType,'image/jpeg');assert.equal(picture.frame.width,640);assert.equal(picture.frame.height,480);assert(JSON.stringify(picture).length<=1024*1024);assert.equal(Object.hasOwn(picture,'html'),false);
  await service.releaseFrame('alice',alice.frameId);assert.equal((await observer.send('Target.getBrowserContexts')).browserContextIds.length,initial+1);
  assert.equal((await service.snapshot(bob,{id:b.id,sessionId:'native',tabId:'tab'})).state.title,'empty');
  await service.closeOwner('bob');assert.equal((await observer.send('Target.getBrowserContexts')).browserContextIds.length,initial);
  console.log(JSON.stringify({scope:'actual-local-cdp-with-controlled-public-dns-and-transport',browserContextsJoined:true,crossCookies:false,qualified:false}));
 }finally{
  await service?.close();await observer?.detach();await launched?.close();await new Promise(resolve=>site.close(resolve));await fs.rm(root,{recursive:true,force:true});
 }
});
