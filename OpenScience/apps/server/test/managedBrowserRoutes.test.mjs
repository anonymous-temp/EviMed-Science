import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {handleManagedBrowserRequest} from '../src/managedBrowserRoutes.mjs';
function fixture(body,changes={}){
 const events=[],scope={userId:'actor',projectId:'project',authSessionHash:'login',frameId:'frame'},req=Readable.from([Buffer.from(JSON.stringify(body))]);
 req.method='POST';req.headers={'content-type':'application/json'};
 let output;
 const res={writeHead:(status,headers)=>events.push({status,headers}),end:bytes=>{output=JSON.parse(bytes.toString());}};
 const service={releaseFrame:async()=>{events.push('release-frame');},open:async(actual,value)=>{assert.equal(actual,scope);events.push('open');return{id:'owned-browser',sessionId:value.sessionId};}};
 return {req,res,pathname:'/__evimed_browser/open',scope,service,authorizeOpenSession:async id=>{assert.equal(id,'native-session');events.push('authorize');},revalidate:async()=>{events.push('revalidate');},...changes,events,result:()=>output};
}
test('browser requests keep trusted frame scope, revalidate around work and never cache page data',async()=>{
 const f=fixture({sessionId:'native-session',tabId:'tab',viewport:{width:800,height:600}});
 assert.equal(await handleManagedBrowserRequest(f),true);assert.deepEqual(f.events.slice(0,4),['authorize','revalidate','open','revalidate']);
 assert.equal(f.events[4].headers['Cache-Control'],'private, no-store');assert.equal(f.result().data.id,'owned-browser');
});
test('forged authority, methods, oversized input and authentication failures cannot dispatch browser work',async()=>{
 const valid={sessionId:'native-session',tabId:'tab',viewport:{width:800,height:600}};
 for(const body of [{...valid,userId:'other'},{...valid,endpoint:'http://internal'},[valid]]){const f=fixture(body);await assert.rejects(handleManagedBrowserRequest(f),{code:'managed_browser_invalid'});assert.equal(f.events.length,0);}
 const unknown=fixture(valid,{pathname:'/__evimed_browser/evaluate'});await assert.rejects(handleManagedBrowserRequest(unknown),{code:'managed_browser_not_found'});
 const wrong=fixture(valid);wrong.req.method='GET';await assert.rejects(handleManagedBrowserRequest(wrong),{code:'managed_browser_not_found'});
 const unauthorized=fixture(valid,{authorizeOpenSession:async()=>{throw new Error('revoked');}});await assert.rejects(handleManagedBrowserRequest(unauthorized),/revoked/);assert.equal(unauthorized.events.length,0);
 const large=fixture({...valid,tabId:'x'.repeat(20000)});await assert.rejects(handleManagedBrowserRequest(large));assert.equal(large.events.length,0);
});
test('revocation during remote work prevents response disclosure',async()=>{
 let calls=0;const f=fixture({sessionId:'native-session',tabId:'tab',viewport:{width:800,height:600}},{revalidate:async()=>{if(++calls===2)throw new Error('revoked');}});
 await assert.rejects(handleManagedBrowserRequest(f),/revoked/);assert.equal(f.result(),undefined);assert(f.events.includes('release-frame'));
});
test('an uncertain open can be closed by its exact tab tuple without an id receipt',async()=>{
 const f=fixture({sessionId:'native-session',tabId:'tab'},{pathname:'/__evimed_browser/close'});
 f.service.closePage=async(scope,body)=>{assert.equal(scope,f.scope);assert.deepEqual(body,{sessionId:'native-session',tabId:'tab'});return{closed:true};};
 await handleManagedBrowserRequest(f);assert.equal(f.result().data.closed,true);
 const broad=fixture({sessionId:'native-session'},{pathname:'/__evimed_browser/close'});
 await assert.rejects(handleManagedBrowserRequest(broad),{code:'managed_browser_invalid'});
});

test('open fails closed without current native authorization while opaque actions and id-less cleanup do not requery inventory',async()=>{
 const missing=fixture({sessionId:'native-session',tabId:'tab',viewport:{width:800,height:600}},{authorizeOpenSession:null});await assert.rejects(handleManagedBrowserRequest(missing),{code:'managed_browser_unavailable'});assert.equal(missing.events.length,0);
 for(const method of ['command','snapshot','close']){const body={sessionId:'native-session',tabId:'tab',...(method!=='close'?{id:'owned'}:{}),...(method==='command'?{sequence:1,command:{type:'back'}}:{})};const f=fixture(body,{pathname:'/__evimed_browser/'+method,authorizeOpenSession:async()=>{throw Error('Inventory must not be queried for an owned slot');}});f.service[method==='close'?'closePage':method]=async actual=>{assert.equal(actual,f.scope);return method==='close'?{closed:true}:{state:{url:'about:blank'}};};await handleManagedBrowserRequest(f);assert.equal(f.events.includes('authorize'),false);}
});

test('specialist visibility still guards actions while scoped cleanup bypasses both session guards',async()=>{
 const blocked=fixture({id:'owned',sessionId:'native-session',tabId:'tab'},{pathname:'/__evimed_browser/snapshot',authorizeSession:async()=>{throw Error('Private specialist session');}});await assert.rejects(handleManagedBrowserRequest(blocked),/Private specialist session/);assert.equal(blocked.events.length,0);
 const cleanup=fixture({sessionId:'native-session',tabId:'tab'},{pathname:'/__evimed_browser/close',authorizeSession:async()=>{throw Error('Session no longer visible');},authorizeOpenSession:async()=>{throw Error('Session gone');}});cleanup.service.closePage=async()=>({closed:true});await handleManagedBrowserRequest(cleanup);assert.equal(cleanup.result().data.closed,true);
});
