import assert from 'node:assert/strict';import test from 'node:test';
import {managedBrowserTarget,createManagedBrowserTransport,createManagedBrowserController} from '../src/runtimeUiManagedBrowser.mjs';
const target={kind:'https',url:'https://example.org/',title:'example.org'};
test('managed transport uses only fixed same-origin routes and closed scoped payloads',async()=>{
 /** @type {any[]} */const calls=[];const request=createManagedBrowserTransport({prefix:'/__evimed/f/'+'a'.repeat(32)+'/'},async(/** @type {any} */ url,/** @type {any} */ options)=>{calls.push({url,options});return{ok:true,text:async()=>JSON.stringify({data:{id:'opaque',sequence:0,state:{}}})};});
 await request('open',{sessionId:'a',tabId:'t',viewport:{width:800,height:600}});assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].url,'/__evimed/f/'+'a'.repeat(32)+'/__evimed_browser/open');assert.equal(calls[0].options.method,'POST');await assert.rejects(request('unknown',{}));
 assert.throws(()=>createManagedBrowserTransport({prefix:'https://private.invalid/'},()=>{}));
});
test('native address failures reject unsafe schemes, credentials and application origin',()=>{
 assert.equal(managedBrowserTarget('example.org','https://app.invalid').target.url,target.url);const credential=new URL('https://example.org');credential.username='synthetic-user';credential.password='fixture-only';for(const text of ['javascript:alert(1)',credential.href,'https://app.invalid/'])assert.equal(managedBrowserTarget(text,'https://app.invalid').ok,false);
});
test('commands serialize exact sequences and an uncertain external action is never assigned another sequence',async()=>{
 /** @type {any[]} */const sent=[];let fail=false;const c=createManagedBrowserController({sessionId:'s',tabId:'t',available:true,request:async(/** @type {string} */ method,/** @type {any} */ body)=>{sent.push({method,body});if(method==='open')return{id:'owned',sequence:0,state:{url:'about:blank',title:'',viewport:body.viewport}};if(fail)throw Error('lost receipt');return{sequence:body.sequence,state:{url:target.url,title:'observed',viewport:{width:800,height:600}}};},actions:{replace:()=>{}}});
 await c.navigate(target.url);await Promise.all([c.command({type:'click',x:10,y:20,button:'left'}),c.command({type:'text',text:'中文'})]);assert.deepEqual(sent.filter(x=>x.method==='command').map(x=>x.body.sequence),[1,2,3]);
 fail=true;await c.command({type:'click',x:12,y:30,button:'left'});await c.command({type:'key',key:'Enter'});assert.equal(sent.filter(x=>x.method==='command').length,4);assert(c.getSnapshot().frame.error);assert.equal(c.getSnapshot().frame.sandboxEnabled,undefined);
});
test('saved navigation stays idle, configured unavailable never falls back, close joins captured identity',async()=>{
 /** @type {any[]} */const requests=[];const c=createManagedBrowserController({sessionId:'s',tabId:'same',available:false,initial:{entries:[target],index:0},actions:{replace:()=>{}},request:async(/** @type {string} */ method,/** @type {any} */ body)=>{requests.push({method,body});return{};}});assert.equal(c.getSnapshot().restoreTarget.url,target.url);await c.navigate(target.url);assert.equal(requests.length,0);assert(c.getSnapshot().frame.error);
 const active=createManagedBrowserController({sessionId:'other',tabId:'same',available:true,actions:{replace:()=>{}},request:async(/** @type {string} */ method,/** @type {any} */ body)=>{requests.push({method,body});return method==='close'?{closed:true}:method==='open'?{id:'captured',sequence:0,state:{url:'about:blank'}}:{sequence:body.sequence,state:{url:target.url}};}});await active.navigate(target.url);await active.dispose();const last=requests.at(-1);assert.equal(last.method,'close');assert.equal(last.body.id,'captured');assert.equal(last.body.sessionId,'other');
});

test('letterbox mapping and closed commands refuse padding, authority fields and oversize input',async()=>{
 const {managedBrowserPoint,managedBrowserCommand}=await import('../src/runtimeUiManagedBrowser.mjs');
 assert.deepEqual(managedBrowserPoint({width:1000,height:1000,left:0,top:0},{width:1000,height:500},250,375),{x:250,y:125});assert.equal(managedBrowserPoint({width:1000,height:1000,left:0,top:0},{width:1000,height:500},10,10),null);
 for(const value of [{type:'click',x:1,y:1,button:'left',userId:'borrowed'},{type:'key',key:'arbitrary-private-method'},{type:'text',text:'字'.repeat(2000)},{type:'resize',width:9999,height:100}])assert.throws(()=>managedBrowserCommand(value));
 let read=false;assert.throws(()=>managedBrowserCommand({get type(){read=true;return'back';}}));assert.equal(read,false);
});
test('unknown open teardown uses scoped id-optional close and never opens an extra blank page',async()=>{
 /** @type {any[]} */const calls=[];const c=createManagedBrowserController({sessionId:'owner',tabId:'occurrence',available:true,actions:{},request:async(/** @type {string} */ method,/** @type {any} */ body)=>{calls.push({method,body});if(method==='open')throw Error('response lost');return{closed:true};}});await c.navigate(target.url);await c.dispose();assert.deepEqual(calls.map(x=>x.method),['open','close']);assert.deepEqual(calls[1].body,{sessionId:'owner',tabId:'occurrence'});
});
test('expired polling does not reopen and explicit reload retires old tuple before new occurrence',async()=>{
 /** @type {any[]} */const calls=[];let expired=false;
 const c=createManagedBrowserController({sessionId:'s',tabId:'old',rotateTabId:()=> 'new',available:true,actions:{},request:async(/** @type {string} */ method,/** @type {any} */ body)=>{calls.push({method,body});if(method==='open')return{id:body.tabId,sequence:0,state:{url:'about:blank'}};if(method==='snapshot'&&expired)throw Object.assign(Error(),{code:'managed_browser_not_found'});return method==='close'?{closed:true}:{sequence:body.sequence,state:{url:target.url}};}});
 await c.navigate(target.url);expired=true;await c.snapshot();await c.snapshot();assert.equal(calls.filter(x=>x.method==='open').length,1);await c.reload();assert.equal(calls.filter(x=>x.method==='open').length,2);assert.equal(calls.filter(x=>x.method==='close')[0].body.tabId,'old');assert.equal(calls.filter(x=>x.method==='open')[1].body.tabId,'new');
});

test('native tab hide stops pixels only; late openTabs removal closes exact session/occurrence',async()=>{
 const {createManagedBrowserScope}=await import('../src/runtimeUiManagedBrowser.mjs'),{createRequire}=await import('node:module'),require=createRequire(new URL('../../../apps/web/package.json',import.meta.url)),{JSDOM}=require('js'+'dom');const dom=new JSDOM('<div id="owned"></div>');
 /** @type {any[]} */const calls=[];let present=true;
/** @type {any} */let changed=()=>{};
/** @type {any[]} */const errors=[];
 const targetWindow=dom.window;Object.defineProperty(targetWindow.document,'hidden',{value:false});Object.defineProperty(targetWindow,'crypto',{value:{getRandomValues:(/** @type {Uint8Array} */ bytes)=>bytes.fill(7)}});targetWindow.setTimeout=()=>1;targetWindow.clearTimeout=()=>{};
 const scope=createManagedBrowserScope({sessionId:'a',available:true,target:targetWindow,actions:{replace:()=>{},forget:()=>{}},subscribeTabs:(/** @type {()=>void} */ listener)=>{changed=listener;return()=>{};},isTabOpen:()=>present,report:(/** @type {any} */ error)=>errors.push(error),request:async(/** @type {string} */ method,/** @type {any} */ body)=>{calls.push({method,body});if(method==='open')return{id:'captured',sequence:0,state:{url:'about:blank'}};if(method==='close')return{closed:true};return{sequence:body.sequence,state:{url:target.url}};}});
 const abort=new globalThis.AbortController(),hide=scope.mount({tabId:'native',signal:abort.signal,viewportId:'owned',applicationOrigin:'https://app.invalid',initialUrl:target.url});await new Promise(resolve=>setTimeout(resolve,10));const identity=calls.find(x=>x.method==='open').body.tabId;
 hide();assert.equal(calls.filter(x=>x.method==='close').length,0);abort.abort();assert.equal(calls.filter(x=>x.method==='close').length,0);present=false;changed();await new Promise(resolve=>setTimeout(resolve,10));const close=calls.find(x=>x.method==='close');assert.equal(close.body.tabId,identity);assert.equal(close.body.sessionId,'a');assert.equal(close.body.id,'captured');assert.equal(errors.length,0);await scope.dispose();dom.window.close();
});
test('native body/title registrations retain exact store/locale/children and defer public sidebar readiness',async()=>{
 const {apply}=await import('../src/runtimeUiManagedBrowser.mjs');
/** @type {any[]} */const registrations=[];const body={options:{key:'@deepseek-ai/dsh-client-ui-sidebar-browser',priority:0},component:()=>{},store:{owned:'native'},locale:'browser',children:{native:true}},title={options:{key:'@deepseek-ai/dsh-client-ui-sidebar-browser',priority:0},component:()=>{},store:body.store};
/** @type {any} */ let ready=()=>{};
 const scope={sidebarRight:{openTabs:{subscribe:()=>()=>{},getSnapshot:()=>[]}},slots:{entries:(/** @type {string} */ name)=>[name.endsWith('.title')?title:body],subscribe:()=>()=>{}},effect:(/** @type {()=>any} */ setup)=>setup()};
 const kit={ours:true,vocabulary:{nativeBrowserKey:'@deepseek-ai/dsh-client-ui-sidebar-browser'},frame:{prefix:'/__evimed/f/'+'a'.repeat(32)+'/',managedBrowser:{provider:'managed',available:false}},withServices:(/** @type {string[]} */ names,/** @type {any} */ fn)=>{assert.deepEqual(names,['sidebarRight']);ready=fn;},guarded:(/** @type {string} */ _name,/** @type {()=>any} */ fn)=>fn(),occupy:(/** @type {any} */ spec,/** @type {any} */ component)=>{registrations.push({spec,component});return()=>{};}};
 apply({}, {}, {}, null, kit);assert.equal(registrations.length,0);ready(scope);assert.equal(registrations.length,2);assert.equal(registrations[0].component,body.component);assert.equal(registrations[0].spec.inherit,body);assert.equal(registrations[1].component,title.component);assert.equal(registrations[1].spec.inherit.store,body.store);const face=registrations[0].spec.inject('session',{replace:()=>{}});assert.equal(typeof face.mount,'function');assert.equal(typeof face.keyedHooks.browserState,'function');assert.equal(face.setSandbox(false),undefined);
});

test('an observed real about:blank clears the displayed old address while preserving the saved restore target independently',async()=>{
 let blank=false;const c=createManagedBrowserController({sessionId:'s',tabId:'t',available:true,actions:{},request:async(/** @type {string} */ method,/** @type {any} */ body)=>method==='open'?{id:'owned',sequence:0,state:{url:'about:blank'}}:{sequence:body.sequence??1,state:{url:blank?'about:blank':target.url,title:'Observed',viewport:{width:800,height:600}}}});await c.navigate(target.url);assert.equal(c.getSnapshot().frame.target.url,target.url);blank=true;await c.command({type:'back'});assert.equal(c.getSnapshot().frame.target,undefined);assert.equal(c.getSnapshot().frame.address,'empty');
});
