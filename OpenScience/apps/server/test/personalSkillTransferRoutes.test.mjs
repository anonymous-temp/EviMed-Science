import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPersonalSkillTransferRoutes } from '../src/personalSkillTransferRoutes.mjs';
import { HttpError, sendError } from '../src/security.mjs';

test('transfer HTTP actions retain authenticated account context and bounded explicit data selection',async t=>{
  const user={id:'alice',accountCreatedAt:'captured-epoch'},calls=[];
  const service={upload:async(actor,bytes,format)=>{calls.push({actor,bytes:bytes.toString(),format});return{reference:'transfer:fixture',sourceSkills:[{sourceId:'skill:a',title:'A',revision:1}]};},
    preview:async(actor,input)=>{calls.push({actor,input});return{nativeValidation:'pending',skills:[],activation:false};},
    confirm:async(actor,input)=>{calls.push({actor,input});return{status:'in-progress',mappings:[],activation:false};}};
  const store={ensureSessionUser:async req=>{if(req.headers.authorization!=='fixture-owner')throw new HttpError(401,'unauthorized','No session');return{user};},
    assertCsrf:async req=>{if(req.headers['x-csrf-token']!=='fixture-csrf')throw new HttpError(403,'csrf_invalid','No CSRF');}};
  const handler=createPersonalSkillTransferRoutes({store,service,skills:{},artifacts:{},maxJsonBytes:65536});
  const server=createServer((req,res)=>{void handler(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>sendError(res,error));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address(),base=`http://127.0.0.1:${address.port}`;
  const headers={authorization:'fixture-owner','x-csrf-token':'fixture-csrf'};
  const upload=await fetch(base+'/api/skills/transfers/uploads?format=account',{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:'authored fixture'});
  assert.equal(upload.status,200);assert.equal((await upload.json()).data.sourceSkills[0].sourceId,'skill:a');assert.equal(calls[0].actor,user);
  const request={reference:'transfer:fixture',sourceSkillIds:['skill:a']};
  const preview=await fetch(base+'/api/skills/transfers/preview',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(request)});
  assert.equal((await preview.json()).data.nativeValidation,'pending');assert.deepEqual(calls[1].input,request);
  assert.equal((await fetch(base+'/api/skills/transfers/confirm',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(base+'/api/skills/transfers/uploads?format=runtime',{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:'no'})).status,400);
  assert.equal(calls.length,2);
});
