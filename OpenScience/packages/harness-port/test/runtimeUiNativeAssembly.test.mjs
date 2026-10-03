/** Real client assembly regression for declaration ownership, scope propagation and native browser key. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {SlotCore} from '@deepseek-ai/dsh-client-ui-slots';
import {nativeUiAssembly} from './helpers/nativeUiAssembly.mjs';
const require=createRequire(new URL('../../../apps/web/package.json',import.meta.url));
test('actual pinned SlotCore refuses duplicate child declarations retained by a native entry',()=>{
 /** @type {any} */ const core=new SlotCore();core.register({name:'root',children:{'conversation.composer.bar':{kind:'single',scope:'session-maybe'}}},()=>null);
 core.register({name:'conversation.composer.bar',children:{'conversation.input.attachments':{kind:'single',scope:'session-maybe'}}},()=>null);
 assert.throws(()=>core.register({name:'conversation.composer.bar',priority:-1,children:{'conversation.input.attachments':{kind:'single',scope:'session-maybe'}}},()=>null),/already declared/);
});
test('actual public client renderer boots its registry and scope contracts',async()=>{
 const moduleId='js'+'dom',{JSDOM}=require(moduleId),dom=new JSDOM('<div id="root"></div>');const {ctx}=await nativeUiAssembly(dom);assert.equal(typeof ctx.slots.register,'function');assert.equal(typeof ctx.slots.installScope,'function');await ctx.fiber.dispose();dom.window.close();
});

test('real renderer preserves the native bar sole ownership and publishes native attachment callbacks to upload',async t=>{
 const moduleId='js'+'dom',{JSDOM}=require(moduleId),dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'});
 const {ctx,React}=await nativeUiAssembly(dom);const {apply}=await import('../src/runtimeUiComposer.mjs'),{createFrameKit}=await import('../src/runtimeUiKit.mjs'),{FRAME_VOCABULARY}=await import('../src/runtimeUiFrame.mjs');
 const current=/** @type {any} */(globalThis),old=Object.fromEntries(['window','document','IS_REACT_ACT_ENVIRONMENT'].map(name=>[name,Object.getOwnPropertyDescriptor(current,name)]));current.window=dom.window;current.document=dom.window.document;current.IS_REACT_ACT_ENVIRONMENT=true;
 const source=(/** @type {any} */ value)=>({getSnapshot:()=>value,subscribe:()=>()=>{}});const binding={key:'actual-session',ctx,hooks:{},keyedHooks:{},props:{sessionId:'actual-session'}};
 ctx.slots.provideRoot({props:{}});ctx.slots.installScope('session',{current:source(binding),bindingSource:()=>source(binding),renderArea:(/** @type {any} */ _binding,/** @type {any} */ props)=>props.children});ctx.slots.installLocale({...source({revision:0}),bind:()=>(/** @type {string} */ key)=>key==='input.upload'?'上传附件':key});
 const h=React.createElement;
/** @type {any[]} */ const received=[];const owner={attachments:[],canAcceptDrop:true,onAddFiles:(/** @type {any} */ files)=>received.push(files),uploads:{},onRemoveAttachment:()=>{},onRetryFile:()=>{}};
 function NativeBar(/** @type {any} */ props){assert.equal(props.nativeInjected,true);return h('div',null,h('textarea',{defaultValue:'Native typed draft'}),props.renderSlot('conversation.input.attachments',owner),props.renderSlot('conversation.input.left',{}));}
 function NativeAttachments(/** @type {any} */ props){assert.equal(typeof props.t,'function');return h('span',{'data-native-rail':true},'native rail');}
 ctx.slots.register({name:'root',children:{'conversation.composer.bar':{kind:'single',scope:'session-maybe'}}},(/** @type {any} */ props)=>h(props.SessionProvider,null,props.renderSlot('conversation.composer.bar',{})));
 ctx.slots.register({name:'conversation.composer.bar',inject:()=>({nativeInjected:true}),children:{'conversation.input.attachments':{kind:'single',scope:'session-maybe'},'conversation.input.left':{kind:'list',scope:'session'}}},NativeBar);
 ctx.slots.register({name:'conversation.input.attachments',locale:'conversation'},NativeAttachments);
 const kit=createFrameKit(ctx,{__EVIMED_FRAME__:{version:1}},()=>React,FRAME_VOCABULARY);apply(ctx,{},null,null,kit);
 assert.equal(ctx.slots.entries('conversation.composer.bar').length,1,'The original native parent is never shadowed/redeclared');
 /** @type {any} */ let unmount;t.after(async()=>{await React.act(async()=>unmount?.());await ctx.fiber.dispose();dom.window.close();for(const[name,descriptor]of Object.entries(old)){if(descriptor)Object.defineProperty(current,name,descriptor);else delete current[name];}});
 await React.act(async()=>{unmount=ctx.uiRenderer.mount(dom.window.document.getElementById('root'));});const button=dom.window.document.querySelector('.evimed-composer-upload');assert(button);assert.equal(button.disabled,false);
 const input=dom.window.document.querySelector('input[type=file]'),file=new dom.window.File(['fixture'],'资料.csv');Object.defineProperty(input,'files',{configurable:true,value:[file]});await React.act(async()=>{button.click();input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(received.length,1);assert.equal(received[0][0],file);assert.equal(dom.window.document.querySelector('textarea').value,'Native typed draft');assert(dom.window.document.querySelector('[data-native-rail]'));
});

test('actual pinned browser factory entries are taken over under their published key and native chrome uses managed state',async t=>{
 const moduleId='js'+'dom',{JSDOM}=require(moduleId),dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'});const {ctx,React}=await nativeUiAssembly(dom),{installNativeBrowser}=await import('./helpers/nativeUiAssembly.mjs'),{apply}=await import('../src/runtimeUiManagedBrowser.mjs'),{createFrameKit}=await import('../src/runtimeUiKit.mjs'),{FRAME_VOCABULARY}=await import('../src/runtimeUiFrame.mjs'),{RUNTIME_UI_NATIVE_BROWSER_KEY}=await import('../src/runtimeUiSlots.mjs');
 const current=/** @type {any} */(globalThis),old=Object.fromEntries(['window','document','IS_REACT_ACT_ENVIRONMENT'].map(name=>[name,Object.getOwnPropertyDescriptor(current,name)]));current.window=dom.window;current.document=dom.window.document;current.IS_REACT_ACT_ENVIRONMENT=true;
 const source=(/** @type {any} */ value)=>({getSnapshot:()=>value,subscribe:()=>()=>{}}),translate=(/** @type {string} */ key)=>key;
 const signal=new globalThis.AbortController(),tab={id:'native-tab',title:'Native',signal:signal.signal,navigation:{params:{url:'https://example.org/'}},actions:{bindCommands:()=>()=>{},openTab:()=>{}}};
 const binding={key:'actual-browser-session',ctx,hooks:{},keyedHooks:{},props:{sessionId:'actual-browser-session',useTabInfo:()=>({tab})}};
 ctx.slots.provideRoot({props:{}});ctx.slots.installScope('session',{current:source(binding),bindingSource:()=>source(binding),renderArea:(/** @type {any} */ _binding,/** @type {any} */ props)=>props.children});ctx.slots.installLocale({...source({revision:0}),bind:()=>translate});
 ctx.provide('locale',{bind:()=>translate,register:()=>()=>{}});ctx.provide('sidebarRight',{openTabs:source([{sessionId:binding.key,tabId:tab.id}])});ctx.provide('sidebarRightTabs',{register:()=>()=>{}});
 const h=React.createElement;ctx.slots.register({name:'root',children:{'sidebar.right.pane.tab':{kind:'keyed',scope:'session'},'sidebar.right.pane.tab.title':{kind:'keyed',scope:'session'}}},(/** @type {any} */ props)=>h(props.SessionProvider,null,props.renderSlot('sidebar.right.pane.tab.title',{}, {entryKey:actualKey}),props.renderSlot('sidebar.right.pane.tab',{}, {entryKey:actualKey})));
 const {source:nativeSource}=await installNativeBrowser(ctx,React,dom);const native=ctx.slots.entries('sidebar.right.pane.tab')[0],actualKey=native.options.key;
 assert.equal(actualKey,RUNTIME_UI_NATIVE_BROWSER_KEY,'Actual factory registration is independent of the adapter constant');assert.notEqual(actualKey,'browser');assert(nativeSource.includes('const BROWSER_ID ='));
 const title=ctx.slots.entries('sidebar.right.pane.tab.title')[0];
/** @type {any[]} */ const calls=[];
/** @type {Promise<void>|null} */
 let snapshotGate=null;let history=['https://example.org/'],index=0,sequence=0;
 dom.window.fetch=async(/** @type {any} */ url,/** @type {any} */ options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(url.endsWith('/snapshot')&&snapshotGate)await snapshotGate;if(url.endsWith('/command')){sequence=body.sequence;if(body.command.type==='navigate'){history=history.slice(0,index+1);history.push(body.command.url);index++;}else if(body.command.type==='back')index=Math.max(0,index-1);else if(body.command.type==='forward')index=Math.min(history.length-1,index+1);}const state={url:history[index],title:'Managed observed',viewport:{width:800,height:600},canGoBack:index>0,canGoForward:index<history.length-1};const response=url.endsWith('/open')?{id:'opaque',sequence:0,state:{url:'about:blank',viewport:body.viewport}}:url.endsWith('/close')?{closed:true}:url.endsWith('/snapshot')?{sequence,state,frame:null}:{sequence:body.sequence,state};return{ok:true,text:async()=>JSON.stringify({data:response})};};
 const target=Object.assign(dom.window,{__EVIMED_FRAME__:{version:1,frameId:'a'.repeat(32),prefix:'/__evimed/f/'+'a'.repeat(32)+'/',managedBrowser:{provider:'managed',available:true}}});const kit=createFrameKit(ctx,target,()=>React,FRAME_VOCABULARY);apply(ctx,{},target,null,kit);await new Promise(resolve=>setTimeout(resolve,0));
 const active=ctx.slots.entriesOfSlot('sidebar.right.pane.tab')[0];assert.equal(active.component,native.component);assert.equal(active.store,native.store);assert.equal(active.locale,native.locale);assert.notEqual(active.inject,native.inject);assert.equal(ctx.slots.entriesOfSlot('sidebar.right.pane.tab.title')[0].store,title.store);
 /** @type {any} */ let unmount;t.after(async()=>{await React.act(async()=>unmount?.());await ctx.fiber.dispose();dom.window.close();for(const[name,descriptor]of Object.entries(old)){if(descriptor)Object.defineProperty(current,name,descriptor);else delete current[name];}});
 await React.act(async()=>{unmount=ctx.uiRenderer.mount(dom.window.document.getElementById('root'));await new Promise(resolve=>setTimeout(resolve,15));});assert(calls.some(call=>call.url.endsWith('/open')));assert(calls.some(call=>call.url.endsWith('/command')));assert.equal(dom.window.document.querySelector('[aria-label="sandbox.disable"]'),null);assert.equal(dom.window.document.querySelector('iframe'),null);assert(dom.window.document.body.textContent.includes('Managed observed'));
 const face=active.inject(binding.key,{replace:()=>{},forget:()=>{}});await React.act(async()=>{face.loadUrl(tab.id,'https://example.org/?second');await new Promise(resolve=>setTimeout(resolve,5));});
 const back=dom.window.document.querySelector('[aria-label="back"]'),forward=dom.window.document.querySelector('[aria-label="forward"]'),reload=dom.window.document.querySelector('[aria-label="reload"]');assert.equal(back.disabled,false);const controller=face.keyedHooks.browserState(tab.id),beforePolls=calls.filter(call=>call.url.endsWith('/snapshot')).length;
/** @type {any} */
 let releasePoll;snapshotGate=new Promise(resolve=>{releasePoll=resolve;});const polls=Array.from({length:12},()=>controller.snapshot());await new Promise(resolve=>setTimeout(resolve,0));await React.act(async()=>{back.click();releasePoll();await Promise.all(polls);await new Promise(resolve=>setTimeout(resolve,5));});snapshotGate=null;assert.equal(calls.filter(call=>call.url.endsWith('/snapshot')).length,beforePolls+1);assert(calls.some(call=>call.body.command?.type==='back'));assert.equal(forward.disabled,false);await React.act(async()=>{forward.click();await new Promise(resolve=>setTimeout(resolve,5));reload.click();await new Promise(resolve=>setTimeout(resolve,5));});assert(calls.some(call=>call.body.command?.type==='forward'));assert(calls.some(call=>call.body.command?.type==='reload'));

});
