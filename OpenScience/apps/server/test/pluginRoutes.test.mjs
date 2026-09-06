import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createPluginRoutes} from '../src/pluginRoutes.mjs';
import {validatePluginConfig} from '../src/pluginService.mjs';
import {HttpError,sendError} from '../src/security.mjs';

test('plugin routes require session, CSRF and owned project; reject unsupported binaries and settings',async t=>{
  const calls=[];const owner={id:'owner'};
  const service={get:async(user,project)=>{calls.push(['get',user.id,project.id]);return{desired:{revision:0}};},
    save:async(user,project,input)=>{const config=validatePluginConfig(input);calls.push(['save',user.id,project.id]);return{desired:{revision:1,...config}};},
    history:async()=>({items:[]}),rollback:async()=>({phase:'pending'}),retry:async()=>({phase:'pending'})};
  const store={ensureSessionUser:async req=>{if(req.headers.cookie!=='fixture=active')throw new HttpError(401,'unauthorized','Login required.');return{user:owner};},
    assertCsrf:async req=>{if(req.method!=='GET'&&req.headers['x-open-science-csrf']!=='csrf')throw new HttpError(403,'csrf_required','CSRF required.');},
    requireProject:async(_owner,id)=>{if(id!=='owned')throw new HttpError(404,'project_not_found','Project unavailable.');return{id,userId:owner.id};}};
  const route=createPluginRoutes({store,service,maxJsonBytes:8192});
  const server=createServer((req,res)=>{route(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>sendError(res,error));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/projects`;
  const headers={cookie:'fixture=active','x-open-science-csrf':'csrf','content-type':'application/json'};
  assert.equal((await fetch(`${base}/owned/plugins`)).status,401);
  assert.equal((await fetch(`${base}/other/plugins`,{headers})).status,404);
  for(const id of ['dsh-browse','dsh-python','other'])assert.equal((await fetch(`${base}/owned/plugins/${id}`,{headers})).status,404);
  const body=JSON.stringify({expectedRevision:0,enabled:true,settings:{timeoutMs:4000}});
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers:{cookie:headers.cookie},body})).status,403);
  assert.equal(calls.length,0);
  const list=await fetch(`${base}/owned/plugins`,{headers});assert.equal(list.status,200);assert.equal((await list.json()).data.plugins.length,1);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers,body})).status,200);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite`,{method:'PUT',headers,body:JSON.stringify({...JSON.parse(body),userId:'other'})})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite/retry`,{method:'POST',headers,body:'{"token":"override"}'})).status,400);
  assert.equal((await fetch(`${base}/owned/plugins/dsh-cite/retry`,{method:'POST',headers,body:'{}'})).status,200);
  assert.deepEqual(calls,[['get','owner','owned'],['save','owner','owned']]);
});
