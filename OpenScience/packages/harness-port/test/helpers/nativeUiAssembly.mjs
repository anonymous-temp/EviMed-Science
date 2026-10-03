/** Actual pinned client SlotRegistry/renderer, loaded through its public module factory. Bindings/data are synthetic. */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import * as cordis from '@deepseek-ai/cordis';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
const require=createRequire(import.meta.url),webRequire=createRequire(new URL('../../../../apps/web/package.json',import.meta.url));
/** @param {any} dom @returns {Promise<any>} */
export async function nativeUiAssembly(dom) {
 const React=webRequire('react');
 const source=await fs.readFile(path.join(path.dirname(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json')),'lib/client.js'),'utf8');
 /** @type {any} *//** @type {any} */ let definition;
 dom.window.__ModuleLoader__={load:(/** @type {any} */ value)=>{definition=value;}};
 vm.runInNewContext(source,{window:dom.window,console,document:dom.window.document,queueMicrotask:globalThis.queueMicrotask,setTimeout,clearTimeout});
 if(!definition||typeof definition.factory!=='function')throw new Error('Native published factory unavailable');
 const native=definition.factory((/** @type {string} */ id)=>id==='@deepseek-ai/cordis'?cordis:id==='@deepseek-ai/dsh-client-ui-slots'?slots:webRequire(id));
 const ctx=new cordis.Context();native.apply(ctx);
 return{ctx,React,source};
}
/** The actual published browser factory registers its own key/body/title; only store state and icon presentation are synthetic.
 * @param {any} ctx @param {any} React @param {any} dom @returns {Promise<any>} */
export async function installNativeBrowser(ctx,React,dom) {
 const source=await fs.readFile(path.join(path.dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-browser/package.json')),'lib/client.js'),'utf8');
/** @type {any} */ let definition;
 dom.window.__ModuleLoader__={load:(/** @type {any} */ value)=>{definition=value;}};vm.runInNewContext(source,{window:dom.window,document:dom.window.document,console,globalThis:dom.window});
 const noIcon=()=>null,primitives=new Proxy({Tooltip:(/** @type {any} */ props)=>props.children,Button:(/** @type {any} */ props)=>React.createElement('button',props,props.children),SHIELD_OUTLINE_PATH:'',ICON_REGULAR_STROKE:1},{get:(object,key)=>Object.hasOwn(object,key)?(/** @type {any} */(object))[key]:noIcon});
 const store={defineStore:(/** @type {any} */ spec)=>({spec,create:()=>{let state=spec.init();const listeners=new Set();return{getSnapshot:()=>state,subscribe:(/** @type {()=>void} */ fn)=>{listeners.add(fn);return()=>listeners.delete(fn);},actions:Object.fromEntries(Object.entries(spec.actions).map(([name,action])=>[name,(/** @type {any[]} */ ...args)=>{const next=globalThis.structuredClone(state);(/** @type {any} */(action))(next,...args);state=next;for(const fn of listeners)fn();}]))};}})};
 if(!definition||typeof definition.factory!=='function')throw new Error('Native published factory unavailable');
 const native=definition.factory((/** @type {string} */ id)=>id==='@deepseek-ai/dsh-client-ui-primitives'?primitives:id==='@deepseek-ai/dsh-client-store'?store:webRequire(id));native.apply(ctx);return{native,source};
}
