/** Managed pixels behind the pinned native browser chrome; no site HTML, desktop bridge or alternate toolbar. */

/** @param {string} code @returns {any} */
export function managedBrowserError(code) {
  /** @type {Record<string,string>} */ const messages = { managed_browser_action_unknown: '该操作结果尚不确定，不会自动重复。请重新加载页面。', managed_browser_not_found: '页面已过期，请明确重新加载或恢复。', managed_browser_busy: '浏览器暂时繁忙，请稍后重试。', managed_browser_invalid: '浏览器请求无效。', managed_browser_sequence_conflict: '页面操作状态已改变，请重新加载。', managed_browser_unavailable: '托管浏览器暂不可用，可在系统浏览器中打开。' };
  const known = Object.hasOwn(messages, code) ? code : 'managed_browser_unavailable';
  return Object.assign(new Error(messages[known]), { code: known });
}
/** The native browser's public HTTP(S) target shape and address failure vocabulary.
 * @param {string} value @param {string} [origin] @returns {any} */
export function managedBrowserTarget(value, origin) {
  const text = String(value).trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > 16384) return { ok: false, reason: 'invalid' };
  try {
    const url = new URL(/^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(text) ? text : 'https://' + text);
    if (url.username || url.password) return { ok: false, reason: 'credentials' };
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'protocol' };
    if (origin && origin !== 'null' && url.origin === new URL(origin).origin) return { ok: false, reason: 'application-origin' };
    return { ok: true, target: { kind: url.protocol.slice(0, -1), url: url.href, title: url.hostname } };
  } catch { return { ok: false, reason: 'invalid' }; }
}
/** Fixed frame-scoped HTTP only. Neither call payload nor a native tab chooses actor, project or transport.
 * @param {any} frame @param {any} fetcher @returns {any} */
export function createManagedBrowserTransport(frame, fetcher) {
  if (!/^\/__evimed\/f\/[A-Za-z0-9_-]{32}\/$/.test(frame?.prefix ?? '') || typeof fetcher !== 'function') throw managedBrowserError('managed_browser_unavailable');
  /** @type {Record<string,string[]>} */ const fields = { open: ['sessionId','tabId','viewport'], command: ['id','sessionId','tabId','sequence','command'], snapshot: ['id','sessionId','tabId'], close: ['id','sessionId','tabId'] };
  return async (/** @type {string} */ method, /** @type {any} */ body) => {
    const keys = fields[method];
    if (!keys || !body || (method === 'close' && body.id === undefined ? Object.keys(body).sort().join() !== 'sessionId,tabId' : Object.keys(body).sort().join() !== [...keys].sort().join())) throw managedBrowserError('managed_browser_invalid');
    const content = JSON.stringify(body);if (new TextEncoder().encode(content).length > 16384) throw managedBrowserError('managed_browser_invalid');
    const abort = new globalThis.AbortController(), timer = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetcher(frame.prefix + '__evimed_browser/' + method, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'content-type': 'application/json' }, body: content, signal: abort.signal, ...(method === 'close' ? { keepalive: true } : {}) });
      let text;
      if (response.body?.getReader) { const reader=response.body.getReader(),chunks=[];let bytes=0;try { for (;;) { const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>2*1024*1024){await reader.cancel();throw managedBrowserError('managed_browser_unavailable');}chunks.push(next.value); }const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}text=new TextDecoder('utf-8',{fatal:true}).decode(joined); }finally{reader.releaseLock();} }
      else { text = await response.text();if (new TextEncoder().encode(text).length > 2*1024*1024) throw managedBrowserError('managed_browser_unavailable'); }
      let value;try { value = JSON.parse(text); } catch { throw managedBrowserError('managed_browser_unavailable'); }
      if (!response.ok) throw managedBrowserError(value?.code);
      if (!value || !Object.hasOwn(value, 'data')) throw managedBrowserError('managed_browser_unavailable');
      return value.data;
    } finally { clearTimeout(timer); }
  };
}
/** Closed public command vocabulary; keyboard/pointer data cannot select another operation.
 * @param {any} value @returns {any} */
export function managedBrowserCommand(value) {
  /** @type {Record<string,string[]>} */ const fields = {navigate:['type','url'],back:['type'],forward:['type'],reload:['type'],resize:['type','width','height'],click:['type','x','y','button'],scroll:['type','deltaX','deltaY'],key:['type','key'],text:['type','text']};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw managedBrowserError('managed_browser_invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(field => !Object.hasOwn(field,'value'))) throw managedBrowserError('managed_browser_invalid');
  const keys = fields[value.type];if (!keys || Object.keys(value).sort().join() !== [...keys].sort().join()) throw managedBrowserError('managed_browser_invalid');
  const size = (/** @type {number} */ width,/** @type {number} */ height) => Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>=100&&width<=1600&&height>=100&&height<=1200;
  const keyNames=['Enter','Tab','Shift+Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Control+A','Meta+A'];
  if (value.type==='navigate' && !managedBrowserTarget(value.url).ok || value.type==='resize'&&!size(value.width,value.height) || value.type==='click'&&(!['left','middle','right'].includes(value.button)||![value.x,value.y].every(n=>Number.isFinite(n)&&n>=0)) || value.type==='scroll'&&![value.deltaX,value.deltaY].every(n=>Number.isFinite(n)&&Math.abs(n)<=2000) || value.type==='key'&&!keyNames.includes(value.key) || value.type==='text'&&(typeof value.text!=='string'||value.text.includes('\0')||new TextEncoder().encode(value.text).length>4096)) throw managedBrowserError('managed_browser_invalid');
  return {...value};
}
/** One native tab occurrence's navigation model. Only explicit user navigation can open or restore a page.
 * @param {any} options @returns {any} */
export function createManagedBrowserController(options) {
  const { sessionId, request } = options;let tabId = options.tabId;
  let actions = options.actions, sequence = 0, retired = false, closing = false, pending = 0, openAttempted = false;
  /** @type {any} */ let id = null;
  /** @type {any} */ let disposed = null;
  /** @type {any} */ let uncertain = null;
  let tail = Promise.resolve();
  /** @type {Promise<any>|null} */ let snapshotPending = null;
  /** @type {string|null} */ let persisted = null;
  /** @type {any} */ let opening = null;
  let saved = options.initial?.entries?.[options.initial.index];
  /** @type {any} */ let pixel = null;
  /** @type {any} */ let reportedViewport = options.viewport ?? {width:800,height:600};
  /** @type {Set<()=>void>} */ const listeners = new Set();
  /** @type {any} */ let state = { frame: { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false, error: options.available === true ? undefined : { code: -1, description: managedBrowserError('managed_browser_unavailable').message }, sandboxEnabled: undefined }, restoreTarget: saved, addressFailure: undefined, addressRevision: 0 };
  const emit = (/** @type {any} */ next) => { if (JSON.stringify(state) === JSON.stringify(next)) return;state = next;for (const listener of listeners) listener(); };
  const failure = (/** @type {any} */ error) => { const known = managedBrowserError(error?.code);emit({ ...state, frame: { ...state.frame, loading: false, error: { code: -1, description: known.message } } }); };
  const observe = (/** @type {any} */ reply) => {
    const value = reply?.state;if (value?.viewport) reportedViewport = value.viewport;if (!value || typeof value !== 'object') throw managedBrowserError('managed_browser_unavailable');
    const parsed = value.url && value.url !== 'about:blank' ? managedBrowserTarget(value.url) : null;
    const target = value.url === 'about:blank' ? undefined : parsed?.ok ? { ...parsed.target, title: String(value.title || parsed.target.title).slice(0,200) } : state.frame.target;
    retired = Boolean(value.error);
    emit({ ...state, restoreTarget: undefined, frame: { target, address: target ? 'observed' : 'empty', loading: value.loading === true, canGoBack: value.canGoBack === true, canGoForward: value.canGoForward === true, error: value.error ? { code: -1, description: managedBrowserError(value.error.code).message } : undefined, sandboxEnabled: undefined } });
    if (target) {
      saved = target;const checkpoint = { entries: [target], index: 0, request: { target, revision: state.addressRevision }, navigation: { status: 'known', revision: state.addressRevision }, failure: undefined };
      const identity = JSON.stringify(checkpoint);if (identity !== persisted) { persisted = identity;actions?.replace(options.nativeTabId ?? tabId, checkpoint); }
    }
  };
  const scoped = () => ({ ...(id ? { id } : {}), sessionId, tabId });
  const enqueue = (/** @type {()=>Promise<any>} */ work) => {
    if (closing) return Promise.resolve(false);
    if (pending >= 8) { failure(managedBrowserError('managed_browser_busy'));return Promise.resolve(false); }
    pending++;const result = tail.then(work);tail = result.catch(() => {});return result.catch(error => { failure(uncertain ? managedBrowserError('managed_browser_action_unknown') : error);return false; }).finally(() => { pending--; });
  };
  const ensure = async () => {
    if (closing || options.available !== true) throw managedBrowserError('managed_browser_unavailable');
    if (id && !retired) return;
    if (retired) throw managedBrowserError('managed_browser_not_found');
    if (!opening) { openAttempted = true;opening = request('open', { sessionId, tabId, viewport: options.viewport ?? { width: 800, height: 600 } }).then((/** @type {any} */ result) => {
      if (typeof result?.id !== 'string' || !result.id || !Number.isSafeInteger(result.sequence)) throw managedBrowserError('managed_browser_unavailable');
      id = result.id;sequence = result.sequence;observe(result);
    }).finally(() => { opening = null; }); }
    await opening;
  };
  const dispatch = async (/** @type {any} */ command) => {
    if (closing || uncertain) return false;
    command = managedBrowserCommand(command);await ensure();
    const body = { ...scoped(), sequence: sequence + 1, command };
    uncertain = body;
    const reply = await request('command', body);
    if (reply?.sequence !== body.sequence) throw managedBrowserError('managed_browser_sequence_conflict');
    sequence = reply.sequence;uncertain = null;observe(reply);return true;
  };
  const closeRemote = async () => { const result = await request('close', scoped());if (result?.closed !== true) throw managedBrowserError('managed_browser_unavailable'); };
  const recover = async () => {
    // A lost action receipt is queried using its SAME sequence and body, never another external click.
    if (uncertain) {
      const reply = await request('command', uncertain);if (reply?.sequence !== uncertain.sequence) throw managedBrowserError('managed_browser_sequence_conflict');sequence = reply.sequence;uncertain = null;observe(reply);
    }
    if (retired && id) { await closeRemote();id = null;retired = false;tabId = options.rotateTabId ? options.rotateTabId() : tabId; }
  };
  const controller = {
    getSnapshot: () => state,
    subscribe(/** @type {()=>void} */ listener) { listeners.add(listener);return () => { listeners.delete(listener); }; },
    rebind(/** @type {any} */ next) { actions = next; },
    frame: () => pixel,
    navigate(/** @type {string} */ address, /** @type {string} */ origin = options.applicationOrigin) {
      const parsed = managedBrowserTarget(address, origin);
      if (!parsed.ok) { emit({ ...state, addressFailure: parsed.reason, addressRevision: state.addressRevision + 1 });return Promise.resolve(false); }
      emit({ ...state, addressFailure: undefined, restoreTarget: undefined, addressRevision: state.addressRevision + 1, frame: { ...state.frame, target: parsed.target, address: 'requested', loading: true } });
      return enqueue(async () => { await recover();return dispatch({ type: 'navigate', url: parsed.target.url }); });
    },
    command(/** @type {any} */ command,/** @type {any} */ basis) { return enqueue(() => basis && (basis.width !== reportedViewport.width || basis.height !== reportedViewport.height) ? Promise.resolve(false) : dispatch(command)); },
    reload() { return enqueue(async () => { await recover();if (!id && saved) return dispatch({ type: 'navigate', url: saved.url });return dispatch({ type: 'reload' }); }); },
    restore() { return saved ? controller.navigate(saved.url) : Promise.resolve(false); },
    snapshot(/** @type {()=>boolean} */ current = () => true) {
      // A remounted native body shares the one pending observation, not another queued request.
      if (snapshotPending) return snapshotPending;
      snapshotPending = enqueue(async () => {
      if (!current() || !id || retired || uncertain) return false;
      let result;try { result = await request('snapshot', scoped()); }catch(error){retired=true;pixel=null;throw error;}if (!Number.isSafeInteger(result?.sequence) || result.sequence < sequence) throw managedBrowserError('managed_browser_sequence_conflict');observe(result);
      const image = result.frame;
      if (image && (image.mimeType !== 'image/jpeg' || typeof image.dataBase64 !== 'string' || image.dataBase64.length > 1100000 || !image.dataBase64.startsWith('/9j/') || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64) || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 100 || image.width > 1600 || image.height < 100 || image.height > 1200)) throw managedBrowserError('managed_browser_unavailable');
      pixel = image;return true;
    }).finally(() => { snapshotPending = null; });return snapshotPending; },
    dispose() {
      if (!disposed) { closing = true;disposed = tail.then(async () => { await opening;if (id || openAttempted) await closeRemote();listeners.clear();pixel = null; }); }
      return disposed;
    },
  };
  return controller;
}
/** Map a contained screenshot's letterboxed coordinates; padding never dispatches a page click.
 * @param {any} rect @param {any} frame @param {number} clientX @param {number} clientY @returns {any} */
export function managedBrowserPoint(rect, frame, clientX, clientY) {
  const scale = Math.min(rect.width/frame.width, rect.height/frame.height);
  if (!(scale > 0)) return null;
  const x = (clientX-rect.left-(rect.width-frame.width*scale)/2)/scale, y = (clientY-rect.top-(rect.height-frame.height*scale)/2)/scale;
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height ? { x, y } : null;
}
/** Opaque remote occurrence identity; changing a render does not mint a browser context.
 * @param {any} target @returns {string} */
export function managedBrowserOccurrence(target) {
  const bytes = new Uint8Array(16);target.crypto.getRandomValues(bytes);return 'managed:' + Array.from(bytes,(byte)=>byte.toString(16).padStart(2,'0')).join('');
}
/** Only the official committed native viewport is populated; browser pixels cannot execute site markup.
 * @param {any} controller @param {any} target @param {any} request @returns {()=>void} */
export function mountManagedBrowserViewport(controller, target, request) {
  const container = target.document?.getElementById(request.viewportId);
  if (!container) return () => {};
  const image = target.document.createElement('img');image.alt = '托管浏览器页面';image.draggable = false;image.tabIndex = 0;
  Object.assign(image.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block', outlineOffset: '-2px' });
  const surface = target.document.createElement('div');Object.assign(surface.style,{position:'relative',width:'100%',height:'100%'});surface.appendChild(image);container.appendChild(surface);
  const input = target.document.createElement('textarea');input.setAttribute('aria-label','网页文本输入');input.tabIndex = -1;input.autocomplete='off';input.spellcheck=false;Object.assign(input.style,{position:'absolute',width:'1px',height:'1px',opacity:'0',padding:'0',border:'0',resize:'none'});surface.appendChild(input);
  let composing = false, requestedSize = '';
  /** @type {any} */ let committed = null;
  /** @type {any} */ let compositionTimer = null;
  let mounted = true, text = '';
  /** @type {any} */ let timer = null;
  /** @type {any} */ let resize = null;
  /** @type {any} */ let textTimer = null;
  const invoke = (/** @type {any} */ command,/** @type {any} */ basis = undefined) => { void controller.command(command,basis); };
  const size = () => ({ width: Math.min(1600, Math.max(100, Math.round(container.clientWidth || 800))), height: Math.min(1200, Math.max(100, Math.round(container.clientHeight || 600))) });
  const flushText = () => { if (text) { const batch = text;text = '';invoke({ type: 'text', text: batch }); } };
  const poll = async () => {
    if (!mounted || target.document.hidden) { if (mounted) timer = target.setTimeout(poll, 1000);return; }
    await controller.snapshot(() => mounted && !target.document.hidden);
    if (!mounted) return;
    const frame = controller.frame();if (frame) { image.src = 'data:image/jpeg;base64,' + frame.dataBase64;const desired = size(),key = desired.width+'x'+desired.height;if (container.clientWidth>0&&container.clientHeight>0&&(desired.width!==frame.width||desired.height!==frame.height)&&requestedSize!==key) {requestedSize=key;invoke({type:'resize',...desired});} }else image.removeAttribute('src');
    timer = target.setTimeout(poll, 500);
  };
  const click = (/** @type {any} */ event) => { const frame = controller.frame();if (!frame) return;const point = managedBrowserPoint(image.getBoundingClientRect(), frame, event.clientX, event.clientY);if (point) { flushText();const box=surface.getBoundingClientRect();input.style.left=Math.max(0,event.clientX-box.left)+'px';input.style.top=Math.max(0,event.clientY-box.top)+'px';input.focus({preventScroll:true});invoke({ type: 'click', ...point, button: ['left','middle','right'][event.button] ?? 'left' },{width:frame.width,height:frame.height}); } };
  const wheel = (/** @type {any} */ event) => { event.preventDefault();flushText();invoke({ type: 'scroll', deltaX: Math.max(-2000,Math.min(2000,event.deltaX)), deltaY: Math.max(-2000,Math.min(2000,event.deltaY)) }); };
  const key = (/** @type {any} */ event) => {
    if (event.isComposing) return;
    const special = ['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'];
    const named = event.key === 'Tab' && event.shiftKey ? 'Shift+Tab' : event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey) ? event.metaKey ? 'Meta+A' : 'Control+A' : event.key;
    if (special.includes(event.key) || ['Shift+Tab','Control+A','Meta+A'].includes(named)) { event.preventDefault();flushText();invoke({ type: 'key', key: named }); }

  };
  const entered = (/** @type {any} */ event) => { if (composing || event.isComposing) return;const value=input.value;input.value='';if(committed!==null&&event.data===committed){committed=null;return;}committed=null;if(value){text+=String(value).slice(0,1000);if(new TextEncoder().encode(text).length>4096){text='';return;}target.clearTimeout(textTimer);textTimer=target.setTimeout(flushText,50);} };
  const compositionEnd = (/** @type {any} */ event) => { composing=false;const value=input.value||event.data||'';input.value='';if(value){text+=String(value).slice(0,1000);flushText();committed=event.data;target.clearTimeout(compositionTimer);compositionTimer=target.setTimeout(()=>{committed=null;},0);} };
  const paste = (/** @type {any} */ event) => { event.preventDefault();const content = event.clipboardData?.getData('text/plain') ?? '';if (content && new TextEncoder().encode(content).length <= 4096) { flushText();invoke({ type: 'text', text: content }); } };
  image.addEventListener('click',click);image.addEventListener('auxclick',click);image.addEventListener('contextmenu',(/** @type {any} */ event)=>event.preventDefault());image.addEventListener('wheel',wheel,{passive:false});image.addEventListener('focus',()=>input.focus({preventScroll:true}));input.addEventListener('keydown',key);input.addEventListener('input',entered);input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',compositionEnd);input.addEventListener('paste',paste);
  if (typeof target.ResizeObserver === 'function') { resize = new target.ResizeObserver(() => { const next = size();if (next.width && next.height && controller.frame()) invoke({ type: 'resize', ...next }); });resize.observe(container); }
  void poll();
  return () => { mounted = false;target.clearTimeout(timer);target.clearTimeout(textTimer);target.clearTimeout(compositionTimer);text = '';resize?.disconnect();surface.remove(); };
}
/** Native BrowserInjected face, scoped by Session and the native logical Tab lifetime.
 * @param {any} options @returns {any} */
export function createManagedBrowserScope(options) {
  /** @type {Map<string,any>} */ const tabs = new Map();let actions = options.actions;
  const reconcile = () => { for(const [nativeId,held]of tabs)if(!options.isTabOpen(nativeId)){tabs.delete(nativeId);held.hide?.();held.signal?.removeEventListener('abort',held.abort);void held.controller.dispose().catch(options.report);actions?.forget(nativeId);} };
  const unsubscribeTabs = options.subscribeTabs?.(reconcile);
  const remote = options.request;
  const get = (/** @type {string} */ id) => tabs.get(id)?.controller;
  const face = {
    keyedHooks: { browserState: get },
    mount(/** @type {any} */ request) {
      if (request.signal.aborted) return () => {};
      let held = tabs.get(request.tabId);
      if (!held) {
        const token = managedBrowserOccurrence(options.target);
        const controller = createManagedBrowserController({ sessionId: options.sessionId, tabId: token, nativeTabId: request.tabId, request: remote, rotateTabId: () => managedBrowserOccurrence(options.target), actions, initial: request.initial, applicationOrigin: request.applicationOrigin, available: options.available });
        held = { controller, signal: null, abort: null, hide: null };tabs.set(request.tabId, held);
      }
      held.hide?.();
      if (held.signal !== request.signal) {
        held.signal?.removeEventListener('abort',held.abort);held.signal = request.signal;
        held.abort = () => { held.hide?.();held.hide = null;if (!options.isTabOpen(request.tabId)) { tabs.delete(request.tabId);void held.controller.dispose().catch(options.report);actions?.forget(request.tabId); } };
        request.signal.addEventListener('abort',held.abort,{once:true});
      }
      const hide = mountManagedBrowserViewport(held.controller,options.target,request);held.hide = hide;
      if (!held.started) { held.started = true;if (request.initialUrl) void held.controller.navigate(request.initialUrl,request.applicationOrigin); }
      return () => { hide();if (held.hide === hide) held.hide = null; };
    },
    rebind(/** @type {any} */ next) { actions = next;for (const held of tabs.values()) held.controller.rebind(next); },
    loadUrl(/** @type {string} */ id,/** @type {string} */ value) { void get(id)?.navigate(value); },
    restore(/** @type {string} */ id) { void get(id)?.restore(); },
    goBack(/** @type {string} */ id) { void get(id)?.command({type:'back'}); },
    goForward(/** @type {string} */ id) { void get(id)?.command({type:'forward'}); },
    reload(/** @type {string} */ id) { void get(id)?.reload(); },
    setSandbox() {},
    async dispose() { unsubscribeTabs?.();const pending=[];for (const held of tabs.values()) { held.hide?.();held.signal?.removeEventListener('abort',held.abort);pending.push(held.controller.dispose()); }tabs.clear();await Promise.all(pending); },
  };
  return face;
}
/** @param {any} ctx @param {any} config @param {any} target @param {any} require @param {any} kit */
export function apply(ctx, config, target, require, kit) {
  if (!kit.ours || !kit.frame.managedBrowser) return;
  const frame = kit.frame, browserKey = kit.vocabulary.nativeBrowserKey;
  /** @type {Map<string,any>} */const scopes = new Map();
  const available = frame.managedBrowser.available && frame.prefix && typeof target.fetch === 'function';
  const request = available ? createManagedBrowserTransport(frame,target.fetch.bind(target)) : async()=>{throw managedBrowserError('managed_browser_unavailable');};
  kit.withServices(['sidebarRight'], (/** @type {any} */ scope) => {
    const tabs = scope.sidebarRight.openTabs;
    const inject = (/** @type {string} */ sessionId,/** @type {any} */ actions) => {
      let held = scopes.get(sessionId);if (!held) { held = createManagedBrowserScope({sessionId,actions,request,target,available:Boolean(available),subscribeTabs:(/** @type {()=>void} */ listener)=>tabs.subscribe(listener),isTabOpen:(/** @type {string} */ id)=>(tabs?.getSnapshot() ?? []).some((/** @type {any} */ tab)=>tab.sessionId===sessionId&&tab.tabId===id),report:(/** @type {any} */ error)=>target.console?.warn?.('[evimed-browser] close unconfirmed',error?.code)});scopes.set(sessionId,held); }else held.rebind(actions);return held;
    };
    scope.effect(() => {
      /** @type {any[]} */ const disposers=[];for (const slot of ['sidebar.right.pane.tab','sidebar.right.pane.tab.title']) {
        /** @type {any} */ let own=null;
        /** @type {any} */ let native=null;
        const refresh=()=>kit.guarded('managed native browser',()=>{const next=scope.slots.entries(slot).find((/** @type {any} */ entry)=>entry.options.key===browserKey&&(entry.options.priority??0)===0);if(next===native)return;const previous=own;own=null;native=next;previous?.();if(next)own=kit.occupy({slot,key:browserKey,priority:-1,inherit:next,...(slot.endsWith('.title')?{}:{inject})},next.component);});
        disposers.push(scope.slots.subscribe(slot,refresh));refresh();disposers.push(()=>own?.());
      }
      return async()=>{for(const dispose of disposers.reverse())dispose();await Promise.all([...scopes.values()].map(value=>value.dispose()));scopes.clear();};
    });
  });
}
export const BODY=Object.freeze({name:'managedbrowser',inject:['slots'],parts:Object.freeze([managedBrowserError,managedBrowserTarget,createManagedBrowserTransport,managedBrowserCommand,createManagedBrowserController,managedBrowserPoint,managedBrowserOccurrence,mountManagedBrowserViewport,createManagedBrowserScope,apply])});
