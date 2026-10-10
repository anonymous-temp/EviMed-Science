/** Real client assembly regression for declaration ownership, scope propagation and native browser key. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {SlotCore} from '@deepseek-ai/dsh-client-ui-slots';
import {nativeUiAssembly} from './helpers/nativeUiAssembly.mjs';
import {modelDirectory,nativeSeat} from './helpers/nativeModelSeat.mjs';
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

// The researcher's thinking-intensity seat, on the pinned client's own slot registry and renderer. The kernel's model seat is registered the way
// the pinned client registers it (helpers/nativeModelSeat.mjs: priority 0, `locale: 'model'`, an `inject` that hands the session's model
// directory), and the product's body takes it over. A researcher reads 「思考强度」 and a Chinese level, never a model id or an English
// effort name; a click sends the selection the kernel's own picker sends for the same level; an operator keeps the kernel's own seat.
const ENGLISH_ON_THE_SEAT = /deepseek|provider|\b(?:off|low|high|max|effort|reasoning)\b/i;

/**
 * @param {import('node:test').TestContext} t
 * @param {{ operator?: boolean, directory?: ReturnType<typeof modelDirectory>, locked?: boolean, seatAfterBody?: boolean, face?: string }} [options]
 */
async function mountModelSeat(t, { operator = false, directory = modelDirectory(), locked = false, seatAfterBody = false, face = 'directory' } = {}) {
  const moduleId = 'js' + 'dom', { JSDOM } = require(moduleId), dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.invalid' });
  const { ctx, React } = await nativeUiAssembly(dom);
  const { apply } = await import('../src/runtimeUiComposer.mjs'), { createFrameKit } = await import('../src/runtimeUiKit.mjs'), { FRAME_VOCABULARY } = await import('../src/runtimeUiFrame.mjs');
  const current = /** @type {any} */ (globalThis), old = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [name, Object.getOwnPropertyDescriptor(current, name)]));
  current.window = dom.window; current.document = dom.window.document; current.IS_REACT_ACT_ENVIRONMENT = true;
  const source = (/** @type {any} */ value) => ({ getSnapshot: () => value, subscribe: () => () => {} });
  const binding = { key: directory.sessionId, ctx, hooks: {}, keyedHooks: {}, props: { sessionId: directory.sessionId } };
  ctx.slots.provideRoot({ props: {} });
  ctx.slots.installScope('session', { current: source(binding), bindingSource: () => source(binding), renderArea: (/** @type {any} */ _binding, /** @type {any} */ props) => props.children });
  ctx.slots.installLocale({ ...source({ revision: 0 }), bind: () => (/** @type {string} */ key) => key });
  const h = React.createElement;
  ctx.slots.register({ name: 'root', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } },
    (/** @type {any} */ props) => h(props.SessionProvider, null, props.renderSlot('conversation.composer.bar', {})));
  // `ui-conversation` declares the seat in the composer bar's children table and renders it with the owner's `locked`.
  ctx.slots.register({ name: 'conversation.composer.bar', children: { 'conversation.input.model': { kind: 'single', scope: 'session' } } },
    (/** @type {any} */ props) => h('div', null, h('textarea', { defaultValue: 'a draft' }), props.renderSlot('conversation.input.model', { locked })));
  const seat = nativeSeat(React, directory, face);
  const registerSeat = () => ctx.slots.register(seat.options, seat.component);
  if (!seatAfterBody) registerSeat();
  const target = Object.assign(dom.window, { __EVIMED_FRAME__: { version: 1, frameId: 'c'.repeat(32), operator } });
  const kit = createFrameKit(ctx, target, () => React, FRAME_VOCABULARY);
  apply(ctx, {}, target, undefined, kit);
  if (seatAfterBody) registerSeat();
  /** @type {any} */ let unmount;
  t.after(async () => {
    await React.act(async () => unmount?.());
    await ctx.fiber.dispose();
    dom.window.close();
    for (const [name, descriptor] of Object.entries(old)) { if (descriptor) Object.defineProperty(current, name, descriptor); else delete current[name]; }
  });
  await React.act(async () => { unmount = ctx.uiRenderer.mount(dom.window.document.getElementById('root')); });
  const doc = dom.window.document;
  /** @returns {any} */
  const trigger = () => doc.querySelector('button[aria-haspopup="menu"]');
  const rows = () => /** @type {any[]} */ ([...doc.querySelectorAll('[role="menuitemradio"]')]);
  return {
    ctx, dom, doc, directory, seat,
    trigger,
    rows,
    menu: () => doc.querySelector('[role="menu"]'),
    /** The seat's own text and accessible names: everything a researcher can read or hear from it. */
    surface() {
      const root = trigger()?.parentElement;
      if (!root) return '';
      return [root.textContent, ...[root, ...root.querySelectorAll('*')].flatMap((/** @type {any} */ node) => [node.getAttribute('aria-label'), node.getAttribute('title')])]
        .filter(Boolean).join('\n');
    },
    act: (/** @type {() => any} */ run) => React.act(async () => { await run(); }),
    key: (/** @type {any} */ node, /** @type {string} */ key) => React.act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); }),
  };
}

test('a researcher reads 「思考强度」 and the level in Chinese: no model id, no provider, no English effort name', async t => {
  const m = await mountModelSeat(t);
  // The text, not the node: a failed assertion that prints a DOM node walks the whole window.
  assert.equal(m.doc.querySelector('[data-native-model-seat]')?.textContent ?? null, null, 'the kernel\'s own seat is not drawn for a researcher');
  assert.equal(m.seat.rendered.length, 0, 'and its component never ran');
  assert.ok(m.trigger(), 'the control takes the seat');
  assert.equal(m.trigger().textContent, '思考强度：高', 'the session has no choice of its own, so the product default (high) is what it reads');
  assert.doesNotMatch(m.surface(), ENGLISH_ON_THE_SEAT);
  assert.match(m.trigger().getAttribute('aria-label'), /^思考强度/);
  assert.deepEqual(m.seat.asked, ['actual-session'], 'it is injected for the session by the kernel\'s own registration, which it inherits');
  assert.equal(m.menu(), null, 'closed until asked');
});

test('the levels the kernel advertises and the product has words for are offered, and the level in use is checked', async t => {
  const m = await mountModelSeat(t);
  await m.act(() => m.trigger().click());
  assert.ok(m.menu(), 'the menu opens');
  assert.equal(m.menu().getAttribute('aria-label'), '思考强度');
  assert.deepEqual(m.rows().map(row => row.textContent), ['关闭', '低', '高', '最高']);
  assert.deepEqual(m.rows().map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true', 'false']);
  assert.doesNotMatch(m.surface(), ENGLISH_ON_THE_SEAT);
  assert.ok(m.directory.loads() >= 1, 'opening asks the kernel to refresh its catalogue, as its own picker does');
  assert.equal(m.directory.wire.length, 0, 'and looking is not choosing');
  await m.act(() => m.trigger().click());
  assert.equal(m.menu(), null, 'the trigger closes it again');
});

for (const [id, label] of [['off', '关闭'], ['low', '低'], ['max', '最高']]) {
  test(`choosing 「${label}」 sends the selection the kernel's own picker sends for ${id}, and the level reads ${label} afterwards`, async t => {
    const m = await mountModelSeat(t);
    await m.act(() => m.trigger().click());
    await m.act(() => m.rows().find(row => row.textContent === label).click());
    assert.deepEqual(m.directory.selections, [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: id }],
      'the certified provider and model, with the level and nothing else');
    assert.deepEqual(m.directory.wire, [{ sessionId: 'actual-session', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: id }],
      'the request session.selectModel sends -- the shape the proxy admits');
    assert.equal(m.menu(), null, 'a settled choice closes the menu');
    assert.equal(m.trigger().textContent, `思考强度：${label}`);
    assert.equal(m.doc.activeElement, m.trigger(), 'and the keyboard is back on the control');
  });
}

test('the level a session keeps is the one it reads, and choosing it again sends nothing', async t => {
  const m = await mountModelSeat(t, { directory: modelDirectory({ effort: 'low' }) });
  assert.equal(m.trigger().textContent, '思考强度：低', 'the stored choice wins over the product default');
  await m.act(() => m.trigger().click());
  assert.deepEqual(m.rows().map(row => row.getAttribute('aria-checked')), ['false', 'true', 'false', 'false']);
  await m.act(() => m.rows().find(row => row.textContent === '低').click());
  assert.equal(m.directory.wire.length, 0);
  assert.equal(m.menu(), null);
});

test('a choice in flight reads as chosen but cannot be chosen over, and a rejected one says so plainly and keeps the level', async t => {
  /** @type {(value: any) => void} */ let answer = () => {};
  const m = await mountModelSeat(t, { directory: modelDirectory({ outcome: () => new Promise(resolve => { answer = resolve; }) }) });
  await m.act(() => m.trigger().click());
  await m.act(() => m.rows().find(row => row.textContent === '最高').click());
  assert.equal(m.trigger().textContent, '思考强度：最高', 'what was asked for, while the kernel answers');
  assert.equal(m.trigger().getAttribute('aria-busy'), 'true');
  assert.ok(m.rows().every(row => row.disabled), 'one request at a time');
  await m.act(() => answer({ ok: false, error: { code: 'session/writer-held', message: 'in use by another DSH' } }));
  assert.ok(m.menu(), 'a rejected choice leaves the menu open');
  assert.match(m.surface(), /没能切换，请再试一次/);
  assert.equal(m.doc.querySelector('[role="alert"]')?.textContent, '没能切换，请再试一次');
  assert.doesNotMatch(m.surface(), /writer-held|session\/|DSH|code/i, 'and never the kernel\'s code or message');
  assert.equal(m.trigger().textContent, '思考强度：高', 'the level the session has is unchanged');
  assert.deepEqual(m.rows().map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true', 'false']);
  assert.ok(m.rows().every(row => !row.disabled), 'and it can be tried again');
});

test('the keyboard opens the menu on the level in use, moves between levels, and Escape closes it back onto the control', async t => {
  const m = await mountModelSeat(t);
  m.trigger().focus();
  await m.key(m.trigger(), 'ArrowDown');
  assert.ok(m.menu(), 'ArrowDown opens it');
  assert.equal(m.doc.activeElement?.textContent, '高', 'on the level in use');
  await m.key(m.doc.activeElement, 'ArrowDown');
  assert.equal(m.doc.activeElement?.textContent, '最高');
  await m.key(m.doc.activeElement, 'ArrowDown');
  assert.equal(m.doc.activeElement?.textContent, '关闭', 'it wraps');
  await m.key(m.doc.activeElement, 'ArrowUp');
  assert.equal(m.doc.activeElement?.textContent, '最高');
  // A listener above the control stands for the composer's stop shortcut: Escape closes the menu and goes no further.
  let reachedTheComposer = false;
  m.doc.body.addEventListener('keydown', () => { reachedTheComposer = true; });
  await m.key(m.doc.activeElement, 'Escape');
  assert.equal(m.menu(), null, 'Escape closes it');
  assert.equal(m.doc.activeElement, m.trigger());
  assert.equal(reachedTheComposer, false, 'and is not also the composer\'s stop shortcut');
  assert.equal(m.directory.wire.length, 0);
});

test('a row that closed under the pointer is not highlighted when the menu opens again, and Home and End are left alone while it is closed', async t => {
  const m = await mountModelSeat(t);
  await m.act(() => m.trigger().click());
  const low = () => m.rows().find(row => row.textContent === '低');
  await m.act(() => low().dispatchEvent(new m.dom.window.MouseEvent('mouseover', { bubbles: true })));
  assert.match(low().getAttribute('style') ?? '', /interactive-bg-hover/, 'under the pointer it is highlighted');
  await m.act(() => low().click());
  assert.equal(m.menu(), null);
  await m.act(() => m.trigger().click());
  assert.doesNotMatch(low().getAttribute('style') ?? '', /interactive-bg-hover/, 'the pointer went with the old row');
  await m.act(() => m.trigger().click());
  assert.equal(m.menu(), null);
  m.trigger().focus();
  const home = new m.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
  await m.act(() => m.trigger().dispatchEvent(home));
  assert.equal(home.defaultPrevented, false, 'a key the closed control does not use keeps doing what it did');
  assert.equal(m.menu(), null);
});

test('a press outside the control closes the menu', async t => {
  const m = await mountModelSeat(t);
  await m.act(() => m.trigger().click());
  assert.ok(m.menu());
  await m.act(() => m.doc.querySelector('textarea').dispatchEvent(new m.dom.window.Event('pointerdown', { bubbles: true })));
  assert.equal(m.menu(), null);
});

test('a locked composer leaves the control drawn and inert', async t => {
  const m = await mountModelSeat(t, { locked: true });
  assert.equal(m.trigger().disabled, true);
  await m.act(() => m.trigger().click());
  assert.equal(m.menu(), null);
});

test('a level the product has no word for is not offered, and one the model does not advertise is not invented', async t => {
  const m = await mountModelSeat(t, { directory: modelDirectory({ efforts: [{ id: 'off', name: 'Off' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] }) });
  await m.act(() => m.trigger().click());
  assert.deepEqual(m.rows().map(row => row.textContent), ['关闭', '高']);
  assert.doesNotMatch(m.surface(), /medium/i);
});

test('a model that advertises no reasoning levels has no control, and the kernel\'s seat does not come back', async t => {
  const m = await mountModelSeat(t, { directory: modelDirectory({ efforts: null }) });
  assert.equal(m.trigger(), null);
  assert.equal(m.doc.querySelector('[data-native-model-seat]')?.textContent ?? null, null);
  assert.ok(m.doc.querySelector('textarea'), 'the composer itself is drawn either way');
});

test('the control takes the seat whether the kernel registers its own before the body starts or after', async t => {
  const m = await mountModelSeat(t, { seatAfterBody: true });
  assert.equal(m.trigger()?.textContent, '思考强度：高');
  assert.equal(m.doc.querySelector('[data-native-model-seat]')?.textContent ?? null, null);
  assert.equal(m.ctx.slots.entries('conversation.input.model').length, 2, 'the kernel\'s entry is still registered under it, never replaced');
});

test('an operator keeps the kernel\'s own seat, name and level included', async t => {
  const m = await mountModelSeat(t, { operator: true });
  assert.equal(m.doc.querySelector('[data-native-model-seat]')?.textContent ?? null, 'deepseek-flash High', 'the picker an operator has always had');
  assert.equal(m.trigger(), null, 'and no second control beside it');
  assert.doesNotMatch(m.doc.body.textContent ?? '', /思考强度/);
  assert.equal(m.ctx.slots.entries('conversation.input.model').length, 1, 'the body registered nothing into the seat');
});

test('a face the body does not recognise draws the kernel\'s own seat in its place, so the researcher keeps a picker', async t => {
  const m = await mountModelSeat(t, { face: 'models' });
  assert.equal(m.doc.querySelector('[data-native-model-seat]')?.textContent ?? null, 'deepseek-flash High', 'the kernel reads the face it injected');
  assert.equal(m.trigger(), null, 'and the control, which does not, draws nothing beside it');
  assert.ok(m.seat.rendered.length > 0);
});
