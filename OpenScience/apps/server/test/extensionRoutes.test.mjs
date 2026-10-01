import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createExtensionRoutes} from '../src/extensionRoutes.mjs';
import {HttpError,sendError} from '../src/security.mjs';

test('extension routes bind authenticated principals, enforce CSRF and reject malformed paths',async t=>{
  const calls=[];
  const store={ensureSessionUser:async req=>{if(req.headers.cookie!=='session=a')throw new HttpError(401,'unauthorized','Login required.');return{user:{id:'a'}};},
    assertCsrf:async req=>{if(req.method!=='GET'&&req.headers['x-open-science-csrf']!=='csrf')throw new HttpError(403,'csrf_required','CSRF required.');}};
  const service={catalogue:async()=>({items:[]}),install:async(user,body)=>{calls.push({actor:user.id,body});return{installation:{id:'owned',effective:false},job:{id:'job'}};},
    get:async(user,id)=>{if(user.id!=='a'||id!=='owned')throw new HttpError(404,'not_found','Not found.');return{id,effective:false};},
    project:async(user,id)=>{calls.push({actor:user.id,project:id});return{selections:[]};},
    history:async(user,id,paging)=>{calls.push({actor:user.id,id,paging});return{items:[]};},
    cancelJob:async()=>{calls.push({cancel:true});return{status:'queued'};}};
  const route=createExtensionRoutes({store,service,maxJsonBytes:8192});
  const server=createServer((req,res)=>route(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>sendError(res,error)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,headers={cookie:'session=a','x-open-science-csrf':'csrf','content-type':'application/json'};
  assert.equal((await fetch(base+'/api/extensions/catalogue')).status,401);
  assert.equal((await fetch(base+'/api/extensions/installations',{method:'POST',headers:{cookie:'session=a'},body:'{}'})).status,403);
  const created=await fetch(base+'/api/extensions/installations',{method:'POST',headers,body:'{}'});assert.equal(created.status,201);
  assert.equal(calls[0].actor,'a');assert.equal((await fetch(base+'/api/extensions/installations/foreign',{headers})).status,404);
  assert.equal((await fetch(base+'/api/projects/p%2fother/extensions',{headers})).status,400);
  assert.equal((await fetch(base+'/api/projects/p1/extensions',{headers})).status,200);
  assert.equal((await fetch(base+'/api/extensions/jobs/job/execute',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(base+'/api/extensions/installations/owned/revisions?limit=2&beforeRevision=5',{headers})).status,200);
  assert.deepEqual(calls.at(-1).paging,{limit:2,beforeRevision:5});
  assert.equal((await fetch(base+'/api/extensions/jobs/job/cancel',{method:'POST',headers,body:'{"settled":true,"leaseToken":"forged"}'})).status,400);
  assert.equal(calls.some(call=>call.cancel),false);
});
