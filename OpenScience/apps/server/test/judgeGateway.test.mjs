import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';
import {createJudgeGatewayHandler} from '../src/judgeGateway.mjs';import {issueEngineModelToken} from '../src/modelGatewayEngineTokens.mjs';
const secret='test-only-model-gateway-signing-secret-32-bytes';
const token=()=>issueEngineModelToken({secret,userId:'user',projectId:'project',kind:'peer-review',jobId:'peer-review-20261006-test',runId:'run',ttlSeconds:300,limits:{runLimit:1}}).token;
async function fixture(t){let call;const server=createServer(createJudgeGatewayHandler({config:{engineModelGatewayEnabled:true,modelGatewaySigningSecret:secret},judgeService:{judge:async(...args)=>{call=args;return{outcome:'settled',value:{ok:true},confidence:1,answers:{private:'raw'}};}}}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return{url:`http://127.0.0.1:${server.address().port}`,call:()=>call};}
test('gateway accepts a matching engine JWT and fixes ownership and spend limits',async t=>{const f=await fixture(t),response=await fetch(f.url,{method:'POST',headers:{authorization:`Bearer ${token()}`},body:JSON.stringify({site:'J8',input:{manuscript:'x',criteria:[]}})});assert.equal(response.status,200);assert.equal((await response.json()).answers,undefined);assert.equal(f.call()[2].userId,'user');assert.equal(f.call()[2].limits.run,1);});
test('gateway rejects runtime-shaped tokens, wrong sites and caller policy overrides',async t=>{const f=await fixture(t);for(const body of [{site:'J2',input:{}},{site:'toString',input:{}},{site:'__proto__',input:{}},{site:'J8',input:{},purpose:'kernel'}])assert.equal((await fetch(f.url,{method:'POST',headers:{authorization:`Bearer ${token()}`},body:JSON.stringify(body)})).status,400);assert.equal((await fetch(f.url,{method:'POST',headers:{authorization:'Bearer runtime-token'},body:'{}'})).status,401);assert.equal(f.call(),undefined);});
test('study type site accepts authentic research-topic job and refuses meta job',async t=>{const f=await fixture(t);for(const [kind,status] of [['research-topic-selection',200],['meta-analysis',400],['peer-review',400]]){const jwt=issueEngineModelToken({secret,userId:'user',projectId:'project',kind,jobId:'engine-job-test-20261006',ttlSeconds:300}).token;const response=await fetch(f.url,{method:'POST',headers:{authorization:`Bearer ${jwt}`},body:JSON.stringify({site:'J19',input:{title:'Trial'}})});assert.equal(response.status,status);}});
test('comparison uses same verified engine scope and closed site/input envelope',async t=>{let comparison;const server=createServer(createJudgeGatewayHandler({config:{engineModelGatewayEnabled:true,modelGatewaySigningSecret:secret},judgeService:{compareEngine:async(input,context)=>{comparison={input,context};return{outcome:'settled',code:'judge_comparison_recorded',value:null};}}}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));const url=`http://127.0.0.1:${server.address().port}`;const input={receipt:'a'.repeat(32),value:{items:[{id:'a',decision:'pass'}]}};const result=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token()}`},body:JSON.stringify({site:'comparison',input})});assert.equal(result.status,200);assert.deepEqual(comparison.input,input);assert.equal(comparison.context.engineAuthenticated,true);assert.equal(comparison.context.taskId,'peer-review-20261006-test');});

test('live runtime token admits only J18 and revocation immediately removes access', async t => {
  let active = true, calls = 0, context;
  const server = createServer(createJudgeGatewayHandler({
    config:{engineModelGatewayEnabled:true,modelGatewaySigningSecret:secret},
    runtimeManager:{assertActiveModelGatewayToken(value){if (!active || value !== 'test-runtime') throw Error('revoked');return {userId:'runtime-owner',projectId:'runtime-project',runId:'bounded-run',runLimit:.2};}},
    judgeService:{judge:async(site,input,scope)=>{calls++;context=scope;return {outcome:'settled',value:{relation:'same_trial'}};}}
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=site=>fetch(url,{method:'POST',headers:{authorization:'Bearer test-runtime'},body:JSON.stringify({site,input:{left:{title:'a'},right:{title:'b'}}})});
  assert.equal((await post('J18')).status,200);
  assert.equal(context.engineAuthenticated,false);
  assert.equal(context.projectId,'runtime-project');assert.equal(context.runId,'bounded-run');assert.equal(context.limits.run,.2);
  for (const site of ['J8','J9','J2','comparison']) assert.equal((await post(site)).status,400);
  assert.equal(calls,1);active=false;assert.equal((await post('J18')).status,401);assert.equal(calls,1);
});

test('runtime J18 follows judge policy independently of the engine gateway lever', async t => {
  let calls = 0;
  const server = createServer(createJudgeGatewayHandler({
    config:{engineModelGatewayEnabled:false,modelGatewaySigningSecret:secret},
    runtimeManager:{assertActiveModelGatewayToken(value){if (value !== 'test-runtime') throw Error('invalid');return {userId:'user',projectId:'project'};}},
    judgeService:{judge:async()=>{calls++;return {outcome:'fallback',code:'judge_uncalibrated',value:null};}}
  }));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const post=(jwt,site)=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${jwt}`},body:JSON.stringify({site,input:{}})});
  assert.equal((await post('test-runtime','J18')).status,200);
  assert.equal((await post(token(),'J8')).status,503);
  assert.equal(calls,1);
});
