import assert from 'node:assert/strict';
import test from 'node:test';
import {createComposerUploadStore} from '../src/runtimeUiComposer.mjs';

test('native owner receives original ordered files and retains upload/removal/retry authority',()=>{
 const store=createComposerUploadStore('session-a');
/** @type {any[]} */const batches=[];const files=[{name:'证据.pdf'},{name:'结果.csv'}];
 const owner={canAcceptDrop:true,onAddFiles:(/** @type {any} */ batch)=>batches.push(batch),uploads:{id:{status:'uploading'}},onRetryFile:()=>{},onRemoveAttachment:()=>{}};
 store.publish(owner);const selection=store.open();assert.equal(store.deliver(selection,files),true);assert.equal(batches[0],files);assert.equal(store.getSnapshot(),owner);
});
test('file dialog results cannot move to a different session, unmounted owner or locked intake',()=>{
 const a=createComposerUploadStore('a'),b=createComposerUploadStore('b');let added=0;const owner={canAcceptDrop:true,onAddFiles:()=>added++};a.publish(owner);b.publish(owner);const picked=a.open();
 assert.equal(b.deliver(picked,[{}]),false);a.publish({...owner,canAcceptDrop:false});assert.equal(a.deliver(picked,[{}]),false);a.clear(owner);assert.equal(a.open(),null);
 a.publish(owner);const next=a.open();a.clear(owner);assert.equal(a.deliver(next,[{}]),false);assert.equal(added,0);
});
test('cancel and empty selection preserve draft/attachments without native side effects',()=>{
 const store=createComposerUploadStore('a');let called=0;store.publish({canAcceptDrop:true,onAddFiles:()=>called++});assert.equal(store.deliver(store.open(),[]),false);assert.equal(store.deliver(null,[{}]),false);assert.equal(called,0);
});

test('public single-slot wrapper preserves native injection/children and the attachment presentation',async t=>{
 const {createRequire}=await import('node:module'),webRequire=createRequire(new URL('../../../apps/web/package.json',import.meta.url));
 const {JSDOM}=webRequire('jsdom'),React=webRequire('react'),{createRoot}=webRequire('react-dom/client');
 const {apply}=await import('../src/runtimeUiComposer.mjs'),{createFrameKit}=await import('../src/runtimeUiKit.mjs'),{FRAME_VOCABULARY}=await import('../src/runtimeUiFrame.mjs');
 const dom=new JSDOM('<div id="root"></div>',{url:'https://example.invalid'});
/** @type {any} */const globals=globalThis;const old=Object.fromEntries(['window','document','IS_REACT_ACT_ENVIRONMENT'].map(name=>[name,Object.getOwnPropertyDescriptor(globals,name)]));globals.window=dom.window;globals.document=dom.window.document;globals.IS_REACT_ACT_ENVIRONMENT=true;
 /** @type {any[]} */const entries=[];
/** @type {Map<string,Set<()=>void>>} */const observers=new Map();
/** @type {any[]} */const disposers=[];
/** @type {any[]} */const batches=[];
 const notify=(/** @type {string} */ name)=>{for(const listener of observers.get(name)??[])listener();};
 const slots={entries:(/** @type {string} */ name)=>entries.filter(e=>e.options.name===name),subscribe:(/** @type {string} */ name,/** @type {()=>void} */ fn)=>{if(!observers.has(name))observers.set(name,new Set());observers.get(name)?.add(fn);return()=>observers.get(name)?.delete(fn);},inject:(/** @type {string} */ _name,/** @type {() => any} */ setup)=>setup(),register:(/** @type {any} */ options,/** @type {any} */ component)=>{const entry={options,component,...Object.fromEntries(['inject','children','store','locale'].filter(k=>options[k]!==undefined).map(k=>[k,options[k]]))};entries.push(entry);notify(options.name);return()=>{entries.splice(entries.indexOf(entry),1);notify(options.name);};}};
 const nativeOwner={attachments:[{id:'document',kind:'file'}],uploads:{document:{status:'uploading'}},canAcceptDrop:true,onAddFiles:(/** @type {any} */ files)=>batches.push(files),onRetryFile:()=>{},onRemoveAttachment:()=>{}};
 let session='a';
 const render=(/** @type {string} */ name,/** @type {any} */ owner)=>{const entry=slots.entries(name).sort((a,b)=>(a.options.priority??0)-(b.options.priority??0))[0];return entry?React.createElement(entry.component,{sessionId:session,...entry.inject?.(session),...owner,renderSlot:render,t:()=> '上传附件'}):null;};
 function NativeAttachments(/** @type {any} */ props){assert.equal(props.uploads,nativeOwner.uploads);assert.equal(props.onRetryFile,nativeOwner.onRetryFile);assert.equal(props.onRemoveAttachment,nativeOwner.onRemoveAttachment);return React.createElement('span',{'data-native-attachments':true},'native uploading/retry/remove');}
 function NativeBar(/** @type {any} */ props){assert.equal(props.nativeMarker,'preserved');assert(props.childrenContract);return React.createElement('div',null,React.createElement('textarea',{defaultValue:'Typed native question.'}),React.createElement('button',{'data-native-plus':true},'native tools/skills'),props.renderSlot('conversation.input.attachments',nativeOwner),props.renderSlot('conversation.input.left',{}));}
 slots.register({name:'conversation.composer.bar',priority:0,inject:()=>({nativeMarker:'preserved',childrenContract:true}),children:{'conversation.input.attachments':{},'conversation.input.left':{}}},NativeBar);slots.register({name:'conversation.input.attachments',priority:0},NativeAttachments);
 const ctx={slots,effect:(/** @type {() => any} */ setup)=>{const dispose=setup();disposers.push(dispose);return dispose;}},target={__EVIMED_FRAME__:{version:1}};const kit=createFrameKit(ctx,target,()=>React,FRAME_VOCABULARY);apply(ctx,{},target,null,kit);
 const wrapped=slots.entries('conversation.composer.bar').find(e=>e.options.priority===-1);assert.equal(wrapped?.inject,entries.find(e=>e.component===NativeBar)?.inject);assert.equal(wrapped?.children,entries.find(e=>e.component===NativeBar)?.children);
 const root=createRoot(dom.window.document.getElementById('root'));
 t.after(async()=>{await React.act(async()=>root.unmount());for(const dispose of disposers.reverse())dispose?.();dom.window.close();for(const [name,descriptor]of Object.entries(old)){if(descriptor)Object.defineProperty(globals,name,descriptor);else delete globals[name];}});
 await React.act(async()=>root.render(render('conversation.composer.bar',{})));
 const button=dom.window.document.querySelector('.evimed-composer-upload'),input=dom.window.document.querySelector('input[type=file]'),question=dom.window.document.querySelector('textarea');assert(button&&!button.disabled);assert.equal(question.value,'Typed native question.');assert(dom.window.document.querySelector('[data-native-plus]'));assert(dom.window.document.querySelector('[data-native-attachments]'));
 const file=new dom.window.File(['public fixture'],'证据.csv',{type:'text/csv'});Object.defineProperty(input,'files',{configurable:true,value:[file]});
 await React.act(async()=>{button.click();input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(batches.length,1);assert.equal(batches[0][0],file);assert.equal(question.value,'Typed native question.');
 await React.act(async()=>button.click());session='b';await React.act(async()=>root.render(render('conversation.composer.bar',{})));await React.act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})));assert.equal(batches.length,1,'An already open picker cannot attach to the later session');
 nativeOwner.canAcceptDrop=false;await React.act(async()=>root.render(render('conversation.composer.bar',{})));assert.equal(button.disabled,true);assert.equal(question.value,'Typed native question.');
});

test('absent public slot observation leaves the complete native composer as fallback',async()=>{
 const {apply}=await import('../src/runtimeUiComposer.mjs');let registered=0;
 apply({slots:{entries:()=>[]}}, {}, {}, null, {ours:true,react:{createContext:()=>({})},h:()=>{},occupy:()=>registered++});assert.equal(registered,0);
});
