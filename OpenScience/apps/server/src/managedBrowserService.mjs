/** Ephemeral tenant-bound CDP pages. Web content leaves only as bounded pixels and plain state. */
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {HttpError} from './security.mjs';
import {extensionRequestObject} from './extensionAccess.mjs';
import {localBrowserEndpoint} from './localBrowser.mjs';
import {localAddressToward,openRenderEgress} from './webRenderEgress.mjs';
import {createManagedBrowserResolver} from './managedBrowserDns.mjs';
import {validatedWebUrl,assertPublicWebHost} from './webReadNetwork.mjs';
import {edgeProxyFromConfig,openEdgeTunnel} from './edgeProxy.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const IDLE=5*60_000,LIFETIME=60*60_000,FRAME_BYTES=760*1024,MAX_RECORDS=256,MAX_OWNER_MARKERS=64,MAX_QUEUE=8;
const keys=new Set(['Enter','Tab','Shift+Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Control+A','Meta+A']);
const messages={managed_browser_invalid:'The browser request is invalid.',managed_browser_not_found:'The browser page is unavailable.',managed_browser_sequence_conflict:'The browser action sequence has changed.',managed_browser_busy:'Browser capacity is unavailable.',managed_browser_unavailable:'The browser operation could not be confirmed.',managed_browser_action_unknown:'The browser action outcome is unknown; it will not be repeated.'};
function error(code,status=503){return new HttpError(status,code,messages[code]);}
function record(value,fields,required=fields){try{return extensionRequestObject(value,fields,required);}catch{throw error('managed_browser_invalid',400);}}
function identifier(value){if(typeof value!=='string'||!ID.test(value))throw error('managed_browser_invalid',400);return value;}
function trustedScope(value){record(value,['userId','projectId','authSessionHash','frameId']);identifier(value.userId);identifier(value.projectId);if(!/^[A-Za-z0-9_-]{43}$/.test(value.authSessionHash??'')||!/^[A-Za-z0-9_-]{32}$/.test(value.frameId??''))throw error('managed_browser_invalid',400);return Object.freeze({...value});}
function viewport(value){record(value,['width','height']);if(!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<100||value.height<100||value.width>1600||value.height>1200)throw error('managed_browser_invalid',400);return {...value};}
function commandValue(value,current){
 if(!value||typeof value!=='object')throw error('managed_browser_invalid',400);
 const fields={navigate:['type','url'],back:['type'],forward:['type'],reload:['type'],resize:['type','width','height'],click:['type','x','y','button'],scroll:['type','deltaX','deltaY'],key:['type','key'],text:['type','text']};
 // Inspect descriptors before reading the discriminator: getters are not request data.
 record(value,['type',...Object.values(fields).flat().filter(field=>field!=='type')],['type']);
 const expected=fields[value.type];if(!expected)throw error('managed_browser_invalid',400);record(value,expected);
 if(value.type==='navigate'){try{if(typeof value.url!=='string')throw Error();validatedWebUrl(value.url);}catch{throw error('managed_browser_invalid',400);}}
 if(value.type==='resize')viewport({width:value.width,height:value.height});
 if(value.type==='click'&&(!['left','middle','right'].includes(value.button)||![value.x,value.y].every(Number.isFinite)||value.x<0||value.y<0||value.x>=current.width||value.y>=current.height))throw error('managed_browser_invalid',400);
 if(value.type==='scroll'&&![value.deltaX,value.deltaY].every(n=>Number.isFinite(n)&&Math.abs(n)<=2000))throw error('managed_browser_invalid',400);
 if(value.type==='key'&&!keys.has(value.key))throw error('managed_browser_invalid',400);
 if(value.type==='text'&&(typeof value.text!=='string'||Buffer.byteLength(value.text)>4096||value.text.includes('\0')))throw error('managed_browser_invalid',400);
 return structuredClone(value);
}
/** A bounded wait never treats timeout as physical absence; the underlying ownership promise is retained. */
async function within(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('managed_browser_unavailable')),ms);})]);}finally{clearTimeout(timer);}}
const clone=value=>structuredClone(value),signature=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Scope comes only from the authenticated frame boundary, never a browser command body.
 * @param {any} config @param {any} [deps] */
export function createManagedBrowserService(config,deps={}){
 const endpoint=localBrowserEndpoint(config.managedBrowserCdpUrl),edge=edgeProxyFromConfig(config);
 const enabled=config.managedBrowserEnabled===true&&Boolean(endpoint)&&edge?.url.protocol==='https:';
 const now=deps.now??Date.now,resolveImpl=deps.resolveImpl??createManagedBrowserResolver(edge),openEgress=deps.openEgress??openRenderEgress;
 const timeoutMs=deps.timeoutMs??15000,closeTimeoutMs=deps.closeTimeoutMs??5000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000||!Number.isInteger(closeTimeoutMs)||closeTimeoutMs<10||closeTimeoutMs>10000)throw error('managed_browser_invalid',400);
 const maxContexts=config.managedBrowserMaxContexts??4,maxPerUser=config.managedBrowserMaxContextsPerUser??2;
 if(!Number.isSafeInteger(maxContexts)||!Number.isSafeInteger(maxPerUser)||maxContexts<1||maxContexts>16||maxPerUser<1||maxPerUser>maxContexts)throw error('managed_browser_invalid',400);
 const records=new Map(),byKey=new Map(),ownerRevocations=new Map(),ownersClosing=new Set(),projectsClosing=new Set();
 let closed=false,paused=false,timer=null,connecting=null,connection=null,unregisteredOwnerHoldUntil=0;
 const interval=deps.setInterval??setInterval,clearSweepInterval=deps.clearInterval??clearInterval;
 const frameKey=scope=>scope.userId+':'+scope.frameId,projectKey=scope=>scope.userId+':'+scope.projectId;
 const sameScope=(a,b)=>canonicalJson(a)===canonicalJson(b);
 const tupleKey=(scope,sessionId,tabId)=>signature({scope,sessionId,tabId});
 function pruneOwners(){
  const time=now();for(const [userId,owner]of ownerRevocations){
   for(const [key,at]of owner.frames)if(time-at>=LIFETIME)owner.frames.delete(key);
   for(const [key,at]of owner.tuples)if(time-at>=LIFETIME)owner.tuples.delete(key);
   if(owner.expiresAt<=time&&!owner.frames.size&&!owner.tuples.size&&![...records.values()].some(slot=>slot.scope.userId===userId&&!slot.joined))ownerRevocations.delete(userId);
  }
 }
 function ownerState(userId,create=false){
  let owner=ownerRevocations.get(userId);if(owner||!create)return owner;
  if(unregisteredOwnerHoldUntil>now())return null;
  pruneOwners();if(ownerRevocations.size>=MAX_RECORDS)return null;
  owner={frames:new Map(),tuples:new Map(),blockedUntil:0,expiresAt:now()+LIFETIME};ownerRevocations.set(userId,owner);return owner;
 }
 /** Metadata pressure can deny admission, never owned physical cleanup. Owner-wide
  * saturation preserves every recent release without storing unbounded identifiers. */
 function revoke(userId,kind,key){
  const owner=ownerState(userId,true),time=now();
  if(!owner){unregisteredOwnerHoldUntil=Math.max(unregisteredOwnerHoldUntil,time+LIFETIME);return;}
  owner.expiresAt=time+LIFETIME;
  if(owner.blockedUntil>time||(!owner[kind].has(key)&&owner.frames.size+owner.tuples.size>=MAX_OWNER_MARKERS)){
   owner.blockedUntil=time+LIFETIME;owner.frames.clear();owner.tuples.clear();
   for(const slot of records.values())if(slot.scope.userId===userId&&!slot.joined)void closeSlot(slot).catch(()=>{});
   return;
  }
  owner[kind].set(key,time);
 }
 function requireEnabled(){if(closed||paused||!enabled)throw error('managed_browser_unavailable');}
 function slotFor(scope,body){const scoped=trustedScope(scope);identifier(body.id);identifier(body.sessionId);identifier(body.tabId);const slot=records.get(body.id);if(!slot||!sameScope(slot.scope,scoped)||slot.sessionId!==body.sessionId||slot.tabId!==body.tabId)throw error('managed_browser_not_found',404);return slot;}
 function available(scope){const owner=ownerState(scope.userId);return !closed&&!paused&&!ownersClosing.has(scope.userId)&&!projectsClosing.has(projectKey(scope))&&!(owner?.blockedUntil>now())&&!owner?.frames.has(frameKey(scope));}
 async function connect(){
  if(connection?.browser.isConnected?.()!==false&&connection)return connection;
  if(!connecting){connecting=(async()=>{const target=endpoint,host=target.hostname.replace(/^\[|\]$/g,''),address=isIP(host)?host:await(deps.resolveBrowserHost??(async name=>(await dnsLookup(name,{family:4})).address))(host),port=Number(target.port)||(target.protocol==='https:'?443:80);
   const localAddress=await(deps.addressToward??localAddressToward)(address,port),library=await(deps.loadPlaywright??(()=>import('playwright-core')))();
   const authority=address.includes(':')?`[${address}]:${port}`:`${address}:${port}`;
   const browser=await library.chromium.connectOverCDP(target.protocol==='https:'?target.href:`http://${authority}`,{timeout:Math.min(timeoutMs,15000)});
   connection={browser,address,localAddress};browser.on?.('disconnected',()=>{for(const slot of records.values())if(!slot.joined){slot.retired=true;slot.state.error={code:'managed_browser_unavailable',message:messages.managed_browser_unavailable};void closeSlot(slot).catch(()=>{});}connection=null;});return connection;
  })().finally(()=>{connecting=null;});}
  return connecting;
 }
 function checkSlot(slot){
  if(!slot.retired&&(now()-slot.activity>=IDLE||now()-slot.createdAt>=LIFETIME)){slot.retired=true;void closeSlot(slot).catch(()=>{});}
  if(slot.retired||!available(slot.scope))throw error('managed_browser_not_found',404);
 }
 async function state(slot){
  checkSlot(slot);const url=slot.page.url();if(url!=='about:blank'){const checked=validatedWebUrl(url);await assertPublicWebHost(checked.hostname,resolveImpl);checkSlot(slot);slot.state.url=checked.href;}
  else slot.state.url='about:blank';
  // One fixed read-only expression, never caller JavaScript. Bound before CDP serialization;
  // a page can replace String.prototype.slice, but not a primitive string's indexing/length.
  const title=await slot.page.evaluate(()=>{
    const realm=/** @type {any} */(globalThis),value=realm.document?.title;
    if(typeof value!=='string')return'';
    let bounded='';for(let i=0;i<200&&i<value.length;i++)bounded+=value[i];return bounded;
  }),history=await slot.cdp.send('Page.getNavigationHistory');checkSlot(slot);
  slot.state.title=String(title).replace(/\p{Cc}/gu,'').slice(0,200);
  const firstPageIndex=history.entries?.[0]?.url==='about:blank'?1:0;
  slot.state.canGoBack=Number.isSafeInteger(history.currentIndex)&&history.currentIndex>firstPageIndex;
  slot.state.canGoForward=Array.isArray(history.entries)&&Number.isSafeInteger(history.currentIndex)&&history.currentIndex<history.entries.length-1;
  slot.state.viewport={...slot.viewport};return clone(slot.state);
 }
 async function initialize(slot){
  const current=await connect();checkSlot(slot);
  slot.egress=await openEgress({bindAddress:current.localAddress,peerAddress:current.address,resolveImpl,maxBytes:64*1024*1024,maxHosts:32,counts:{requestsRefused:0,byteCaps:0},connectImpl:(options,signal)=>openEdgeTunnel(edge,options.host,options.port,signal)});checkSlot(slot);
  slot.context=await current.browser.newContext({viewport:slot.viewport,deviceScaleFactor:1,acceptDownloads:false,permissions:[],serviceWorkers:'block',proxy:{server:slot.egress.proxyUrl,bypass:'<-loopback>'}});checkSlot(slot);
  await slot.context.route('**/*',async route=>{try{checkSlot(slot);const url=validatedWebUrl(route.request().url());await assertPublicWebHost(url.hostname,resolveImpl);checkSlot(slot);if(slot.egress.capped())throw Error();await route.continue();}catch{await route.abort('blockedbyclient').catch(()=>{});}});
  slot.context.on('page',page=>{if(slot.page&&page!==slot.page){slot.popups++;void page.close().catch(()=>{});if(slot.popups>4)void closeSlot(slot).catch(()=>{});}});
  slot.page=await slot.context.newPage();checkSlot(slot);slot.page.setDefaultTimeout(timeoutMs);slot.page.setDefaultNavigationTimeout(timeoutMs);
  slot.page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});slot.page.on('download',download=>{void download.cancel().catch(()=>{});});
  slot.page.on('close',()=>{if(!slot.retired)void closeSlot(slot).catch(()=>{});});
  slot.cdp=await slot.context.newCDPSession(slot.page);checkSlot(slot);await state(slot);
 }
 async function closeSlot(slot){
  slot.retired=true;slot.state.loading=false;
  slot.state.error??={code:'managed_browser_not_found',message:messages.managed_browser_not_found};
  // Cut egress promptly even if the CDP create/close response remains unknown.
  if(slot.egress&&!slot.egressClosing)slot.egressClosing=Promise.resolve(slot.egress.close());
  if(!slot.closing){slot.closing=(async()=>{
   await slot.creation?.catch(()=>{});
   if(slot.egress&&!slot.egressClosing)slot.egressClosing=Promise.resolve(slot.egress.close());
   if(slot.context)await slot.context.close();
   await slot.egressClosing;slot.joined=true;byKey.delete(slot.key);
  })().catch(()=>{slot.closing=null;throw error('managed_browser_unavailable');});}
  return within(slot.closing,closeTimeoutMs);
 }
 async function terminalFailure(slot,code){slot.state.loading=false;slot.state.error={code,message:messages[code]};await closeSlot(slot).catch(()=>{});return clone(slot.state);}
 async function perform(slot,command){
  checkSlot(slot);slot.state.error=null;
  switch(command.type){
   case'navigate':{const url=validatedWebUrl(command.url);await assertPublicWebHost(url.hostname,resolveImpl);checkSlot(slot);slot.state.loading=true;await slot.page.goto(url.href,{waitUntil:'domcontentloaded',timeout:timeoutMs});break;}
   case'back':slot.state.loading=true;await slot.page.goBack({waitUntil:'domcontentloaded',timeout:timeoutMs});break;
   case'forward':slot.state.loading=true;await slot.page.goForward({waitUntil:'domcontentloaded',timeout:timeoutMs});break;
   case'reload':slot.state.loading=true;await slot.page.reload({waitUntil:'domcontentloaded',timeout:timeoutMs});break;
   case'resize':slot.viewport={width:command.width,height:command.height};await slot.page.setViewportSize(slot.viewport);break;
   case'click':if(command.x>=slot.viewport.width||command.y>=slot.viewport.height)throw error('managed_browser_invalid',400);await slot.page.mouse.click(command.x,command.y,{button:command.button});break;
   case'scroll':await slot.page.mouse.wheel(command.deltaX,command.deltaY);break;
   case'key':await slot.page.keyboard.press(['Control+A','Meta+A'].includes(command.key)?'ControlOrMeta+A':command.key);break;
   case'text':await slot.page.keyboard.insertText(command.text);break;
  }
  slot.state.loading=false;checkSlot(slot);if(slot.egress.capped())throw error('managed_browser_unavailable');return state(slot);
 }
 function enqueue(slot,work){if(slot.pending>=MAX_QUEUE)throw error('managed_browser_busy',429);slot.pending++;const result=slot.tail.then(work);slot.tail=result.catch(()=>{});result.finally(()=>{slot.pending--;}).catch(()=>{});return result;}
 async function sweep(){
  const time=now();await Promise.allSettled([...records.values()].filter(slot=>!slot.joined&&(slot.retired||time-slot.activity>=IDLE||time-slot.createdAt>=LIFETIME)).map(closeSlot));
  for(const [id,slot]of records)if(slot.joined&&time-slot.createdAt>=LIFETIME)records.delete(id);
  pruneOwners();
 }
 function stopSweeper(){if(timer!==null){clearSweepInterval(timer);timer=null;}}
 function start(){
  if(closed||!enabled)return;paused=false;
  if(timer===null){timer=interval(()=>{void sweep();},deps.sweepIntervalMs??30000);timer.unref?.();}
  void sweep();
 }
 function pause(){
  paused=true;stopSweeper();
  // closeSlot retires and cuts egress synchronously before its first awaited join.
  return Promise.all([...records.values()].filter(slot=>!slot.joined).map(closeSlot)).then(()=>{});
 }
 start();
 async function releaseMatching(predicate){const matching=[...records.values()].filter(predicate);for(const slot of matching){revoke(slot.scope.userId,'frames',frameKey(slot.scope));slot.retired=true;}await Promise.all(matching.map(closeSlot));}
 return{
  enabled,start,pause,
  async open(scope,input){
   requireEnabled();const checked=trustedScope(scope);record(input,['sessionId','tabId','viewport']);identifier(input.sessionId);identifier(input.tabId);const size=viewport(input.viewport);
   const knownOwner=ownerState(checked.userId);
   if(!knownOwner&&unregisteredOwnerHoldUntil>now())throw error('managed_browser_busy',429);
   const owner=ownerState(checked.userId,true);if(!owner)throw error('managed_browser_busy',429);
   if(!available(checked))throw error('managed_browser_not_found',404);const key=tupleKey(checked,input.sessionId,input.tabId);if(owner.tuples.has(key))throw error('managed_browser_not_found',404);const existing=byKey.get(key);
   if(existing){checkSlot(existing);await within(existing.creation,timeoutMs);checkSlot(existing);return{id:existing.id,sequence:existing.appliedSequence,state:clone(existing.state)};}
   const active=[...records.values()].filter(slot=>!slot.joined);
   if(records.size>=MAX_RECORDS){for(const retired of [...records.values()].filter(slot=>slot.joined).sort((a,b)=>a.createdAt-b.createdAt)){records.delete(retired.id);if(records.size<MAX_RECORDS)break;}}
   if(active.length>=maxContexts||active.filter(slot=>slot.scope.userId===checked.userId).length>=maxPerUser||records.size>=MAX_RECORDS)throw error('managed_browser_busy',429);
   const slot={id:randomUUID(),key,scope:checked,sessionId:input.sessionId,tabId:input.tabId,viewport:size,sequence:0,appliedSequence:0,popups:0,lastHash:null,lastPromise:null,createdAt:now(),activity:now(),retired:false,joined:false,pending:0,context:null,page:null,cdp:null,egress:null,egressClosing:null,closing:null,creation:null,tail:Promise.resolve(),state:{url:'about:blank',title:'',loading:false,canGoBack:false,canGoForward:false,error:null,viewport:size}};
   records.set(slot.id,slot);byKey.set(key,slot);slot.creation=initialize(slot);slot.creation.catch(()=>{void closeSlot(slot).catch(()=>{});});
   try{await within(slot.creation,timeoutMs);checkSlot(slot);return{id:slot.id,sequence:0,state:clone(slot.state)};}catch{await closeSlot(slot).catch(()=>{});throw error('managed_browser_unavailable');}
  },
  async command(scope,input){
   record(input,['id','sessionId','tabId','sequence','command']);const slot=slotFor(scope,input),command=commandValue(input.command,slot.viewport),hash=signature(command);
   if(!Number.isSafeInteger(input.sequence)||input.sequence<1)throw error('managed_browser_invalid',400);
   if(input.sequence===slot.sequence&&hash===slot.lastHash&&slot.lastPromise)return clone(await slot.lastPromise);
   if(input.sequence!==slot.sequence+1)throw error('managed_browser_sequence_conflict',409);
   checkSlot(slot);if(slot.pending>=MAX_QUEUE)throw error('managed_browser_busy',429);
   // Consume before any awaited validation or external action; timeout/unknown retries replay this promise.
   slot.sequence=input.sequence;slot.lastHash=hash;slot.activity=now();const sequence=input.sequence;
   slot.lastPromise=enqueue(slot,async()=>{try{const observed=await within(perform(slot,command),timeoutMs);slot.appliedSequence=sequence;return{sequence,state:observed};}catch(caught){const code=caught?.code==='web_read_host_forbidden'?'managed_browser_unavailable':'managed_browser_action_unknown';const observed=await terminalFailure(slot,code);slot.appliedSequence=sequence;return{sequence,state:observed};}});
   return clone(await slot.lastPromise);
  },
  async snapshot(scope,input){record(input,['id','sessionId','tabId']);const slot=slotFor(scope,input);if(slot.retired)return{sequence:slot.sequence,state:clone(slot.state),frame:null};return enqueue(slot,async()=>{try{
   const sequence=slot.appliedSequence,current=await within(state(slot),timeoutMs);const bytes=await within(slot.page.screenshot({type:'jpeg',quality:50,fullPage:false,scale:'css',clip:{x:0,y:0,...slot.viewport},timeout:timeoutMs}),timeoutMs);checkSlot(slot);
   if(!Buffer.isBuffer(bytes)||bytes.length>FRAME_BYTES||bytes.length<4||bytes[0]!==255||bytes[1]!==216)throw error('managed_browser_unavailable');
   return{sequence,state:current,frame:{mimeType:'image/jpeg',dataBase64:bytes.toString('base64'),...slot.viewport}};
  }catch{return{sequence:slot.sequence,state:await terminalFailure(slot,'managed_browser_unavailable'),frame:null};}});},
  async closePage(scope,input){
   if(!enabled)return{closed:true};
   record(input,['id','sessionId','tabId'],['sessionId','tabId']);const scoped=trustedScope(scope);identifier(input.sessionId);identifier(input.tabId);
   const key=tupleKey(scoped,input.sessionId,input.tabId),slot=Object.hasOwn(input,'id')?slotFor(scoped,input):byKey.get(key);
   revoke(scoped.userId,'tuples',key);if(slot)await closeSlot(slot);return{closed:true};
  },
  async releaseFrame(userId,frameId){if(!enabled)return;identifier(userId);if(!/^[A-Za-z0-9_-]{32}$/.test(frameId))throw error('managed_browser_invalid',400);revoke(userId,'frames',userId+':'+frameId);await releaseMatching(slot=>slot.scope.userId===userId&&slot.scope.frameId===frameId);},
  async closeOwner(userId){if(!enabled)return;identifier(userId);ownersClosing.add(userId);try{await releaseMatching(slot=>slot.scope.userId===userId);}finally{ownersClosing.delete(userId);}},
  async closeProject(userId,projectId){if(!enabled)return;identifier(userId);identifier(projectId);const key=userId+':'+projectId;projectsClosing.add(key);try{await releaseMatching(slot=>slot.scope.userId===userId&&slot.scope.projectId===projectId);}finally{projectsClosing.delete(key);}},
  sweep,
  async close(){closed=true;paused=true;stopSweeper();await releaseMatching(()=>true);if(connecting)await within(connecting,closeTimeoutMs);if(connection)await within(connection.browser.close(),closeTimeoutMs);connection=null;}
 };
}
