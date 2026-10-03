import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {createManagedBrowserService} from '../src/managedBrowserService.mjs';
const scope={userId:'alice',projectId:'project',authSessionHash:'a'.repeat(43),frameId:'f'.repeat(32)};
const request={sessionId:'native-session',tabId:'tab-one',viewport:{width:900,height:600}};
const config={managedBrowserEnabled:true,managedBrowserCdpUrl:'http://fixture-browser:9222',edgeProxyUrl:'https://93.184.216.34',edgeProxyCredentials:'controlled:fixture'};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(options={}){
 const contexts=[],proxyOptions=[],egresses=[];let clock=1000;
  const browser={isConnected:()=>true,on:()=>{},close:async()=>{},newContext:async settings=>{
  options.creating?.resolve();
  if(options.launch)await options.launch.promise;
  const context=new EventEmitter();context.settings=settings;context.closed=false;context.close=async()=>{if(options.closeFailure)throw new Error('sensitive-cdp-endpoint');context.closed=true;};
  context.route=async(_pattern,handler)=>{context.routeHandler=handler;};
  const page=new EventEmitter();let url='about:blank',position=0;const history=['about:blank'];page.url=()=>url;page.evaluate=async fn=>vm.runInNewContext('String.prototype.slice=()=>{throw Error("page override")};('+fn.toString()+')()',{document:{title:options.title??'<untrusted> source'}});page.setDefaultTimeout=()=>{};page.setDefaultNavigationTimeout=()=>{};
  page.actions=[];page.goto=async target=>{page.actions.push(['navigate',target]);url=target;history.splice(position+1);history.push(url);position++;};page.goBack=async()=>{position=Math.max(0,position-1);url=history[position];};page.goForward=async()=>{position=Math.min(history.length-1,position+1);url=history[position];};page.reload=async()=>{};
  page.setViewportSize=async value=>page.actions.push(['resize',value]);page.mouse={click:async(...args)=>{page.actions.push(['click',...args]);if(options.action)await options.action.promise;},wheel:async(...args)=>page.actions.push(['scroll',...args])};page.keyboard={press:async value=>page.actions.push(['key',value]),insertText:async value=>page.actions.push(['text',value])};
  page.screenshot=async()=>{options.shotStarted?.resolve();if(options.shot)await options.shot.promise;return options.oversize?Buffer.alloc(1024*1024):Buffer.from([255,216,255,217]);};page.mainFrame=()=>page;page.close=async()=>{page.closed=true;};
  context.newPage=async()=>{context.emit('page',page);return page;};context.newCDPSession=async()=>({send:async name=>{assert.equal(name,'Page.getNavigationHistory');return{currentIndex:position,entries:history.map(u=>({url:u}))};},detach:async()=>{}});
  contexts.push(context);context.page=page;return context;
 }};
 const service=createManagedBrowserService({...config,managedBrowserMaxContexts:2,managedBrowserMaxContextsPerUser:1,...options.config},{loadPlaywright:async()=>({chromium:{connectOverCDP:async()=>browser}}),resolveBrowserHost:async()=> '127.0.0.1',addressToward:async()=> '127.0.0.1',resolveImpl:async host=>[{address:host==='rebind.example.org'?'10.0.0.1':'93.184.216.34',family:4}],openEgress:async value=>{proxyOptions.push(value);const own={closed:false,proxyUrl:'http://127.0.0.1:9999',capped:()=>false,close:async()=>{own.closed=true;}};egresses.push(own);return own;},now:()=>clock,timeoutMs:options.timeoutMs??500,closeTimeoutMs:50,sweepIntervalMs:100000});
 return{service,contexts,proxyOptions,egresses,setClock:value=>{clock=value;}};
}

test('closed scope+session/tab isolates every tenant dimension and uses fresh download-free contexts',async t=>{
 const f=fixture();t.after(()=>f.service.close());const opened=await f.service.open(scope,request);assert.equal(opened.sequence,0);assert.equal(opened.state.url,'about:blank');
 assert.equal((await f.service.open(scope,request)).id,opened.id);assert.equal(f.contexts.length,1);
 for(const [field,value]of Object.entries({userId:'bob',projectId:'other',authSessionHash:'b'.repeat(43),frameId:'g'.repeat(32)}))await assert.rejects(f.service.snapshot({...scope,[field]:value},{id:opened.id,sessionId:request.sessionId,tabId:request.tabId}),{code:'managed_browser_not_found'});
 for(const [field,value]of [['sessionId','foreign'],['tabId','foreign']])await assert.rejects(f.service.snapshot(scope,{id:opened.id,sessionId:request.sessionId,tabId:request.tabId,[field]:value}),{code:'managed_browser_not_found'});
 assert.equal(f.contexts[0].settings.acceptDownloads,false);assert.deepEqual(f.contexts[0].settings.permissions,[]);assert.equal(f.contexts[0].settings.serviceWorkers,'block');assert.equal(f.contexts[0].settings.proxy.bypass,'<-loopback>');
 assert.equal(f.proxyOptions[0].peerAddress,'127.0.0.1');
});
test('reserves capacity before pending creation and closes/revokes a late context without releasing capacity early',async()=>{
 const launch=defer(),creating=defer(),f=fixture({launch,creating});const pending=f.service.open(scope,request);await assert.rejects(f.service.open(scope,{...request,tabId:'second'}),{code:'managed_browser_busy'});await creating.promise;
 const closing=f.service.releaseFrame(scope.userId,scope.frameId);launch.resolve();await assert.rejects(pending);await closing;assert.equal(f.contexts[0].closed,true);
 await assert.rejects(f.service.open(scope,request),{code:'managed_browser_not_found'});await f.service.close();
});
test('consumes a sequence once, replays the same ACK and refuses altered or older commands',async t=>{
 const f=fixture();t.after(()=>f.service.close());const opened=await f.service.open(scope,request),body={id:opened.id,sessionId:request.sessionId,tabId:request.tabId,sequence:1,command:{type:'navigate',url:'https://public.example.org/'}};
 const ack=await f.service.command(scope,body);assert.equal(ack.sequence,1);assert.equal(ack.state.url,'https://public.example.org/');assert.deepEqual(await f.service.command(scope,body),ack);assert.equal(f.contexts[0].page.actions.length,1);
 await assert.rejects(f.service.command(scope,{...body,command:{type:'text',text:'never repeated'}}),{code:'managed_browser_sequence_conflict'});
 await f.service.command(scope,{...body,sequence:2,command:{type:'key',key:'Enter'}});await assert.rejects(f.service.command(scope,body),{code:'managed_browser_sequence_conflict'});
});
test('private URLs/redirect requests and arbitrary commands are refused without leaking endpoints or text',async t=>{
 const f=fixture();t.after(()=>f.service.close());const opened=await f.service.open(scope,request),base={id:opened.id,sessionId:request.sessionId,tabId:request.tabId,sequence:1};
 for(const command of [{type:'evaluate',script:'never'}, {type:'navigate',url:'http://127.0.0.1/secret'}, {type:'click',x:901,y:0,button:'left'}, {type:'resize',width:1601,height:1200}])await assert.rejects(f.service.command(scope,{...base,command}),{code:'managed_browser_invalid'});
 let aborted=0,continued=0;await f.contexts[0].routeHandler({request:()=>({url:()=> 'http://169.254.169.254/'}),abort:async()=>aborted++,continue:async()=>continued++});assert.equal(aborted,1);assert.equal(continued,0);
 await f.contexts[0].routeHandler({request:()=>({url:()=> 'https://public.example.org/'}),abort:async()=>aborted++,continue:async()=>continued++});assert.equal(continued,1);assert.equal(aborted,1);
 const denied=await f.service.command(scope,{...base,command:{type:'navigate',url:'https://rebind.example.org/'}});assert.equal(denied.state.error.code,'managed_browser_unavailable');assert.equal(f.contexts[0].page.actions.length,0);
});
test('timeout consumes click and retries return the same unknown outcome, with joined physical cleanup',async()=>{
 const action=defer(),f=fixture({action,timeoutMs:30});const opened=await f.service.open(scope,request),body={id:opened.id,sessionId:request.sessionId,tabId:request.tabId,sequence:1,command:{type:'click',x:1,y:1,button:'left'}};
 const pending=f.service.command(scope,body);const result=await pending;assert.equal(result.state.error.code,'managed_browser_action_unknown');assert.deepEqual(await f.service.command(scope,body),result);assert.equal(f.contexts[0].page.actions.length,1);assert.equal(f.contexts[0].closed,true);action.resolve();await f.service.close();
});
test('rejected context close retains capacity and only a later successful owned close can join',async()=>{
 const options={closeFailure:true},f=fixture(options);const opened=await f.service.open(scope,request);
 await assert.rejects(f.service.closePage(scope,{id:opened.id,sessionId:request.sessionId,tabId:request.tabId}),{code:'managed_browser_unavailable'});
 await assert.rejects(f.service.open(scope,{...request,tabId:'other'}),{code:'managed_browser_busy'});
 options.closeFailure=false;await f.service.closePage(scope,{id:opened.id,sessionId:request.sessionId,tabId:request.tabId});assert.equal(f.contexts[0].closed,true);await f.service.close();
});
test('bounded JPEG snapshot never returns HTML and passive polling cannot extend idle lifetime',async()=>{
 const f=fixture();const opened=await f.service.open(scope,request),body={id:opened.id,sessionId:request.sessionId,tabId:request.tabId};const shot=await f.service.snapshot(scope,body);assert.equal(shot.frame.mimeType,'image/jpeg');assert.equal(Object.hasOwn(shot,'html'),false);
 f.setClock(301001);await f.service.sweep();assert.equal(f.contexts[0].closed,true);assert.equal((await f.service.snapshot(scope,body)).state.error.code,'managed_browser_not_found');await f.service.close();
 const big=fixture({oversize:true});const next=await big.service.open(scope,request);const result=await big.service.snapshot(scope,{...body,id:next.id});assert.equal(result.frame,null);assert.equal(result.state.error.code,'managed_browser_unavailable');await big.service.close();
});

test('global two-context capacity is shared while closeProject/closeOwner revoke only matching owned handles',async()=>{
 const f=fixture(),bob={...scope,userId:'bob',authSessionHash:'b'.repeat(43),frameId:'b'.repeat(32)},charlie={...scope,userId:'charlie',authSessionHash:'c'.repeat(43),frameId:'c'.repeat(32)};
 const a=await f.service.open(scope,request),b=await f.service.open(bob,request);await assert.rejects(f.service.open(charlie,request),{code:'managed_browser_busy'});
 await f.service.closeProject(scope.userId,scope.projectId);assert.equal(f.contexts[0].closed,true);assert.equal(f.contexts[1].closed,false);assert.equal((await f.service.snapshot(bob,{id:b.id,sessionId:request.sessionId,tabId:request.tabId})).frame.mimeType,'image/jpeg');
 await assert.rejects(f.service.open(scope,request),{code:'managed_browser_not_found'});await f.service.open(charlie,request);await f.service.closeOwner(bob.userId);assert.equal(f.contexts[1].closed,true);
 assert.equal((await f.service.snapshot(scope,{id:a.id,sessionId:request.sessionId,tabId:request.tabId})).frame,null);await f.service.close();
});
test('closed records reject getters/extra authority, enforce hard lifetime, and return cloned ACK state',async()=>{
 const f=fixture();const opened=await f.service.open(scope,request);let read=false;const command={type:'text',text:'controlled-private-text'};Object.defineProperty(command,'evaluate',{enumerable:true,get(){read=true;return'never';}});
 const base={id:opened.id,sessionId:request.sessionId,tabId:request.tabId,sequence:1};await assert.rejects(f.service.command(scope,{...base,command}),{code:'managed_browser_invalid'});assert.equal(read,false);
 const body={...base,command:{type:'text',text:'controlled-private-text'}},ack=await f.service.command(scope,body);ack.state.title='mutated response';assert.notEqual((await f.service.command(scope,body)).state.title,'mutated response');
 for(let index=1;index<=14;index++){f.setClock(1000+index*240000);await f.service.command(scope,{...base,sequence:index+1,command:{type:'key',key:'Tab'}});}
 f.setClock(3601001);await f.service.sweep();assert.equal(f.contexts[0].closed,true);await f.service.close();
});
test('managed mode never becomes enabled without both deployed CDP and HTTPS Tokyo credentials',async()=>{
 for(const value of [{...config,managedBrowserEnabled:false},{...config,managedBrowserCdpUrl:''},{...config,edgeProxyCredentials:''},{...config,edgeProxyUrl:'http://93.184.216.34'}]){const service=createManagedBrowserService(value);assert.equal(service.enabled,false);await assert.rejects(service.open(scope,request),{code:'managed_browser_unavailable'});await service.close();}
});

test('a pending screenshot reports its observed sequence, never an action reserved behind it',async()=>{
 const shot=defer(),shotStarted=defer(),f=fixture({shot,shotStarted});const opened=await f.service.open(scope,request),body={id:opened.id,sessionId:request.sessionId,tabId:request.tabId};
 const pending=f.service.snapshot(scope,body);await shotStarted.promise;const resize=f.service.command(scope,{...body,sequence:1,command:{type:'resize',width:600,height:400}});shot.resolve();const frame=await pending;assert.equal(frame.sequence,0);assert.equal(frame.frame.width,900);assert.equal((await resize).sequence,1);assert.equal((await f.service.snapshot(scope,body)).frame.width,600);await f.service.close();
});
test('unexpected popup pages and downloads close within their owned context',async()=>{
 const f=fixture();await f.service.open(scope,request);const popup={close:async()=>{popup.closed=true;}},download={cancel:async()=>{download.canceled=true;}};
 f.contexts[0].emit('page',popup);f.contexts[0].page.emit('download',download);await Promise.resolve();assert.equal(popup.closed,true);assert.equal(download.canceled,true);await f.service.close();
});

test('login binding uses the existing base64url fingerprint grammar, never a second hex hash',async()=>{
 const f=fixture();await assert.rejects(f.service.open({...scope,authSessionHash:'a'.repeat(64)},request),{code:'managed_browser_invalid'});await f.service.open(scope,request);assert.equal(f.contexts.length,1);await f.service.close();
});

test('fixed internal title read bounds primitive bytes before serialization despite page prototype overrides',async()=>{
 for(const title of ['x'.repeat(100000),{toString:()=>{throw new Error('not a primitive');}}]){const f=fixture({title});const opened=await f.service.open(scope,request);assert(opened.state.title.length<=200);assert.equal(opened.state.title,typeof title==='string'?'x'.repeat(200):'');await f.service.close();}
});

test('tab-occurrence close without an id revokes and joins late context creation or lost open responses',async()=>{
 const launch=defer(),creating=defer(),f=fixture({launch,creating});const opening=f.service.open(scope,request);await creating.promise;
 const closing=f.service.closePage(scope,{sessionId:request.sessionId,tabId:request.tabId});launch.resolve();await assert.rejects(opening);await closing;assert.equal(f.contexts[0].closed,true);await assert.rejects(f.service.open(scope,request),{code:'managed_browser_not_found'});
 const next=await f.service.open(scope,{...request,tabId:'fresh-occurrence'});assert(next.id);await f.service.closePage(scope,{sessionId:request.sessionId,tabId:'fresh-occurrence'});assert.equal(f.contexts[1].closed,true);await f.service.close();
});
test('unknown open can be cancelled before any record exists without enabling a late same-tuple request',async()=>{
 const f=fixture();await f.service.closePage(scope,{sessionId:request.sessionId,tabId:request.tabId});await assert.rejects(f.service.open(scope,request),{code:'managed_browser_not_found'});assert.equal(f.contexts.length,0);await f.service.close();
});
test('server-only multi-tab quotas allow a second scoped tab and reject overflow or malformed caps',async()=>{
 const f=fixture({config:{managedBrowserMaxContexts:4,managedBrowserMaxContextsPerUser:2}});await f.service.open(scope,request);await f.service.open(scope,{...request,tabId:'second'});assert.equal(f.contexts.length,2);assert.notEqual(f.contexts[0],f.contexts[1]);await assert.rejects(f.service.open(scope,{...request,tabId:'third'}),{code:'managed_browser_busy'});await f.service.close();
 for(const caps of [{managedBrowserMaxContexts:17},{managedBrowserMaxContexts:2,managedBrowserMaxContextsPerUser:3},{managedBrowserMaxContexts:1.5}])assert.throws(()=>createManagedBrowserService({...config,...caps}),{code:'managed_browser_invalid'});
 const noFallback=createManagedBrowserService({...config,managedBrowserCdpUrl:'',webRenderCdpUrl:'http://frontier-browser:9222'});assert.equal(noFallback.enabled,false);await noFallback.close();
});

test('one owner saturating frame revocations cannot veto another owner physical close or new admission',async()=>{
 const f=fixture(),bob={...scope,userId:'bob',authSessionHash:'b'.repeat(43),frameId:'b'.repeat(32)};
 await f.service.open(scope,request);const b=await f.service.open(bob,request);
 try{
  for(let i=0;i<600;i++)await f.service.releaseFrame('alice',String(i).padStart(32,'x'));
  assert.equal(f.contexts[1].closed,false);assert.equal(f.egresses[1].closed,false);
  await f.service.releaseFrame('bob',bob.frameId);assert.equal(f.contexts[1].closed,true);assert.equal(f.egresses[1].closed,true);
  await f.service.closeOwner('alice');assert.equal(f.contexts[0].closed,true);assert.equal(f.egresses[0].closed,true);
  await assert.rejects(f.service.open(scope,{...request,tabId:'after-saturation'}),{code:'managed_browser_not_found'});
  const fresh={...bob,frameId:'c'.repeat(32)};await f.service.open(fresh,request);await f.service.closeProject('bob',fresh.projectId);assert.equal(f.contexts[2].closed,true);assert.equal(f.egresses[2].closed,true);
  assert.equal((await f.service.snapshot(bob,{id:b.id,sessionId:request.sessionId,tabId:request.tabId})).frame,null);
 }finally{await f.service.close();}
});
test('tuple saturation remains owner-scoped, preserves pre-open refusal and never blocks exact tuple cleanup',async()=>{
 const f=fixture(),bob={...scope,userId:'bob',authSessionHash:'b'.repeat(43),frameId:'b'.repeat(32)};
 await f.service.open(scope,request);const b=await f.service.open(bob,request);
 try{
  for(let i=0;i<600;i++)await f.service.closePage(scope,{sessionId:'native-session',tabId:'never-opened-'+i});
  await f.service.closePage(bob,{sessionId:request.sessionId,tabId:request.tabId});assert.equal(f.contexts[1].closed,true);assert.equal(f.egresses[1].closed,true);
  await f.service.closeProject('alice',scope.projectId);assert.equal(f.contexts[0].closed,true);assert.equal(f.egresses[0].closed,true);
  await assert.rejects(f.service.open(scope,{...request,tabId:'never-opened-599'}),{code:'managed_browser_not_found'});
  await assert.rejects(f.service.open(bob,request),{code:'managed_browser_not_found'});await f.service.closePage(bob,{id:b.id,sessionId:request.sessionId,tabId:request.tabId});
 }finally{await f.service.close();}
});
test('disabled service lifecycle is a no-op even after arbitrary frame and tuple releases',async()=>{
 const f=fixture({config:{managedBrowserEnabled:false}});
 for(let i=0;i<600;i++){await f.service.releaseFrame('alice',String(i).padStart(32,'x'));await f.service.closePage(scope,{sessionId:request.sessionId,tabId:'never-'+i});}
 await f.service.releaseFrame('bob','b'.repeat(32));await f.service.closeOwner('alice');await f.service.closeProject('bob','project');assert.equal(f.contexts.length,0);assert.equal(f.egresses.length,0);await f.service.close();
});

test('global owner-record pressure cannot veto registered cleanup and retains unknown-owner pre-open denial',async()=>{
 const f=fixture(),bob={...scope,userId:'bob',authSessionHash:'b'.repeat(43),frameId:'b'.repeat(32)};const b=await f.service.open(bob,request);
 try{
  for(let i=0;i<255;i++)await f.service.releaseFrame('owner-'+i,String(i).padStart(32,'x'));
  await f.service.releaseFrame('overflow-owner','z'.repeat(32));
  await f.service.closePage(bob,{id:b.id,sessionId:request.sessionId,tabId:request.tabId});assert.equal(f.contexts[0].closed,true);assert.equal(f.egresses[0].closed,true);
  const overflow={...scope,userId:'overflow-owner',frameId:'z'.repeat(32)};await assert.rejects(f.service.open(overflow,request),{code:'managed_browser_busy'});
  const next=await f.service.open({...bob,frameId:'c'.repeat(32)},request);assert(next.id);await f.service.closeOwner('bob');assert.equal(f.contexts[1].closed,true);assert.equal(f.egresses[1].closed,true);
 }finally{await f.service.close();}
});

test('approved select-all aliases normalize to the execution-platform modifier without widening keys',async()=>{
 const f=fixture();const opened=await f.service.open(scope,request),base={id:opened.id,sessionId:request.sessionId,tabId:request.tabId};
 await f.service.command(scope,{...base,sequence:1,command:{type:'key',key:'Meta+A'}});await f.service.command(scope,{...base,sequence:2,command:{type:'key',key:'Control+A'}});
 assert.deepEqual(f.contexts[0].page.actions,[['key','ControlOrMeta+A'],['key','ControlOrMeta+A']]);await assert.rejects(f.service.command(scope,{...base,sequence:3,command:{type:'key',key:'ControlOrMeta+A'}}),{code:'managed_browser_invalid'});await f.service.close();
});

test('unknown-owner hold cannot be bypassed by a second release after registry slots expire',async()=>{
 const f=fixture();for(let i=0;i<256;i++)await f.service.releaseFrame('seed-owner-'+i,String(i).padStart(32,'x'));
 f.setClock(2000);await f.service.releaseFrame('alice',scope.frameId);
 f.setClock(3601001);await f.service.sweep();await f.service.releaseFrame('alice','z'.repeat(32));
 await assert.rejects(f.service.open(scope,request),{code:'managed_browser_busy'});assert.equal(f.contexts.length,0);assert.equal(f.egresses.length,0);await f.service.close();
});

test('disabled lifecycle creates no recurring timer and start cannot enable an unavailable deployment',async()=>{
 let intervals=0;const service=createManagedBrowserService({...config,managedBrowserEnabled:false},{setInterval:()=>{intervals++;return{unref(){}};},clearInterval:()=>{}});
 try{assert.equal(intervals,0);assert.equal(typeof service.start,'function');assert.equal(typeof service.pause,'function');service.start();service.start();await service.pause();assert.equal(intervals,0);await assert.rejects(service.open(scope,request),{code:'managed_browser_unavailable'});}finally{await service.close();}
});
test('maintenance pause synchronously stops sweeper and admission, cuts egress, and joins delayed creation before restart',async()=>{
 const launch=defer(),creating=defer(),f=fixture({launch,creating});const opening=f.service.open(scope,request);await creating.promise;
 try{
  const paused=f.service.pause();assert.equal(f.egresses[0].closed,true);await assert.rejects(f.service.open({...scope,userId:'bob'},request),{code:'managed_browser_unavailable'});
  launch.resolve();await assert.rejects(opening);await paused;assert.equal(f.contexts[0].closed,true);
  f.service.start();f.service.start();await f.service.open(scope,{...request,tabId:'after-maintenance'});assert.equal(f.contexts.length,2);
  await f.service.pause();assert.equal(f.contexts[1].closed,true);await f.service.close();f.service.start();await assert.rejects(f.service.open(scope,{...request,tabId:'after-close'}),{code:'managed_browser_unavailable'});
 }finally{launch.resolve();await f.service.close();}
});
test('maintenance timer start is idempotent and pause stops it synchronously even when physical close rejects',async()=>{
 let intervals=0,clears=0;const options={closeFailure:true};const f=fixture(options);
 await f.service.close();
 const service=createManagedBrowserService(config,{setInterval:()=>{intervals++;return{unref(){}};},clearInterval:()=>{clears++;}});
 try{assert.equal(intervals,1);service.start();assert.equal(intervals,1);const paused=service.pause();assert.equal(clears,1);await paused;await service.pause();assert.equal(clears,1);service.start();assert.equal(intervals,2);}finally{await service.close();}
 const failing=fixture(options);await failing.service.open(scope,request);const paused=failing.service.pause();assert.equal(failing.egresses[0].closed,true);await assert.rejects(paused,{code:'managed_browser_unavailable'});
 await assert.rejects(failing.service.open(scope,{...request,tabId:'blocked'}),{code:'managed_browser_unavailable'});options.closeFailure=false;await failing.service.pause();assert.equal(failing.contexts[0].closed,true);await failing.service.close();
});


test('history operations wait for commit while new navigation and reload keep their document readiness contract',async t=>{
 const f=fixture();t.after(()=>f.service.close());const opened=await f.service.open(scope,request),page=f.contexts[0].page,base={id:opened.id,sessionId:request.sessionId,tabId:request.tabId};const waits=[];
 for(const method of ['goto','goBack','goForward','reload']){const original=page[method];page[method]=async(...args)=>{waits.push({method,options:args.at(-1)});return original(...args);};}
 for(const [index,command]of [{type:'navigate',url:'https://public.example.org/first'},{type:'navigate',url:'https://public.example.org/second'},{type:'back'},{type:'forward'},{type:'reload'}].entries())assert.equal((await f.service.command(scope,{...base,sequence:index+1,command})).state.error,null);
 assert.deepEqual(waits.map(value=>[value.method,value.options.waitUntil,value.options.timeout]),[['goto','domcontentloaded',500],['goto','domcontentloaded',500],['goBack','commit',500],['goForward','commit',500],['reload','domcontentloaded',500]]);
});
