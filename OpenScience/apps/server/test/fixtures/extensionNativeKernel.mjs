import fs from 'node:fs/promises';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {normalizeTranscript} from '/fixture/platform/server/dshRuntimeAdapter.mjs';
import {browserSessionCookie,generateBrowserSessionSecret} from '/fixture/platform/server/dshBrowserAuth.mjs';
const home='/tmp/home',profile=home+'/profiles/proof';await fs.mkdir(profile,{recursive:true});await fs.mkdir('/tmp/workspace',{recursive:true});
const secret=generateBrowserSessionSecret();await fs.writeFile(home+'/.credentials.yaml',JSON.stringify({version:1,records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}},refs:{EVIMED_WORKLOAD_TOKEN:'fixture-only'}}),{mode:0o600});
await fs.writeFile(profile+'/package.json',JSON.stringify({name:'evimed-native-bridge-fixture',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));await fs.writeFile(profile+'/cordis.yml','[]\n');
const projection=JSON.parse(await fs.readFile('/opt/evimed/extensions/projection.json','utf8')),legacy=projection.plugins[0],external=projection.plugins[1];
await fs.writeFile('/tmp/workload','fixture-only');await fs.writeFile('/tmp/generation',`fixture.${Buffer.from(JSON.stringify({jti:'actual-native-fixture'})).toString('base64url')}.fixture`);
await fs.writeFile(profile+'/cordis.patch.yml',`
- id: session-log-deepseek
  disabled: true
- id: hmr
  disabled: true
- id: plugin-manager
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-deepseek
  config:
    baseURL: http://127.0.0.1:19092
    apiKeyEnv: EVIMED_WORKLOAD_TOKEN
    models:
      - id: deepseek-flash
        contextWindow: 65536
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
- id: skill-filesystem
  disabled: true
- id: preset-standard
  disabled: true
- id: preset-minimal
  disabled: true
- id: preset-ptc
  disabled: true
- id: preset-cordis
  disabled: true
- id: agent-preset-registry
  config:
    default: evimed-universal
- insert:
    - id: evimed-plugin-probe
      name: /fixture/platform/probe.mjs
    - id: preset-proof
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: evimed-universal
        plugins:
          - id: citation
            name: /fixture/platform/citation.mjs
            config:
              enabled: ${legacy.enabled}
              revision: ${legacy.configRevision}
              timeoutMs: ${legacy.settings.timeoutMs}
          - id: cowork
            name: /fixture/platform/cowork.mjs
            config:
              projectionFile: /opt/evimed/extensions/projection.json
              gatewayUrl: http://127.0.0.1:19092/internal/extensions/v1
              tokenFile: /tmp/workload
              generationTokenFile: /tmp/generation
`);
let modelCalls=0,gatewayCalls=0,release;const gatewayReached=new Promise(resolve=>{release=resolve;});let allowResult=false;
const mock=http.createServer(async(req,res)=>{
  let bytes='';for await(const part of req)bytes+=part;const body=JSON.parse(bytes||'{}');
  if(req.url.startsWith('/internal/extensions/v1/')){
    const invocation=JSON.parse(req.headers['x-evimed-extension-invocation']);assert.equal(invocation.toolName,'doc_read');assert.equal(invocation.sessionId,'native-owned-session');assert.equal(invocation.callId,'native_owned_call');
    gatewayCalls++;res.setHeader('content-type','application/json');
    if(req.url.endsWith('/execute')){assert.deepEqual(body,{descriptorId:external.extensionId,idempotencyKey:'native_owned_call',request:{operation:'doc_read',resourceId:'public_fixture'}});release();res.end(JSON.stringify({jobId:'native-job'}));}
    else res.end(JSON.stringify({jobId:'native-job',status:allowResult?'succeeded':'running',result:allowResult?{data:{text:'公开原文 fixture transport'}}:null}));return;
  }
  modelCalls++;res.writeHead(200,{'content-type':'text/event-stream'});
  const first=modelCalls===1;
  const start={type:first?'tool_use':'text',...(first?{id:'native_owned_call',name:'doc_read',input:{}}:{text:''})};
  const events=[['message_start',{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',content:[],model:'deepseek-flash',stop_reason:null,usage:{input_tokens:1,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:start}],['content_block_delta',{type:'content_block_delta',index:0,delta:first?{type:'input_json_delta',partial_json:JSON.stringify({resourceId:'public_fixture'})}:{type:'text_delta',text:'Fixture complete.'}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:first?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}}],['message_stop',{type:'message_stop'}]];
  for(const[event,data]of events)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);res.end();
});await new Promise(resolve=>mock.listen(19092,'127.0.0.1',resolve));
const child=spawn(process.execPath,['/opt/sdk/node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','proof','--host','127.0.0.1','--port','19091','--no-open'],{cwd:'/tmp/workspace',env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NARB_DISABLE_NATIVE_CACHE:'1'},stdio:['ignore','pipe','pipe']});let diagnostics='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-16000);});
const call=async(method,args)=>{const response=await fetch('http://127.0.0.1:19091/api/'+method,{method:'POST',headers:{cookie:browserSessionCookie({secret,authority:'127.0.0.1:19091'}),'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'proof',method,payload:{args}}),signal:AbortSignal.timeout(5000)});const body=await response.json();if(!body.result?.ok)throw new Error(JSON.stringify(body.result?.error));return body.result.value;};
const page=async()=>{const list=await call('session/list',{_request:{}});const head=list.items.find(item=>item.sessionId==='native-owned-session');return {list,history:await call('session/page',{request:{address:{kind:'session',sessionId:'native-owned-session'},throughSeq:head.projections.asOfSeq,maxMessages:30}})};};
try{
  let ready=false;for(let i=0;i<120;i++){try{await call('session/list',{_request:{}});ready=true;break;}catch{ /* The bounded startup poll retries before reporting retained diagnostics. */ }if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}
  if(!ready)throw new Error('native_fixture_not_ready '+diagnostics.replace(/token=[^\s]+/g,'token=[fixture-redacted]'));
  const proof=await call('evimedPlugins/verifyExtensions',{});assert.deepEqual(proof.tools,external.enabled?['doc_read','doc_write']:[]);assert.equal(proof.citation.timeoutMs,legacy.settings.timeoutMs);assert.equal(proof.inventory.length,2);assert.equal(modelCalls,0);
  await call('session/create',{request:{sessionId:'native-owned-session',cwd:'/tmp/workspace',agentPreset:'evimed-universal'}});
  const facts=await call('evimedPlugins/extensionInvocationFacts',{request:{sessionId:'native-owned-session'}});assert.deepEqual(facts.tools,proof.tools);assert.equal(facts.agentId,'native-owned-session');assert.equal(facts.running,false);assert.equal(facts.origin,'root');
  if(external.enabled){await call('session/selectModel',{request:{sessionId:'native-owned-session',provider:'deepseek-official',model:'deepseek-flash'}});await call('session/prompt',{request:{sessionId:'native-owned-session',requestId:'native-prompt',mode:'queue',content:[{type:'text',text:'Read the public fixture.'}]}});
    await Promise.race([gatewayReached,new Promise((_,reject)=>setTimeout(async()=>{const observed=await page().catch(error=>({error:error.message}));reject(new Error('gateway_not_reached '+JSON.stringify({modelCalls,gatewayCalls,page:observed,diagnostics:diagnostics.replace(/token=[^\s]+/g,'token=[fixture-redacted]')})));},12000))]);assert.equal((await call('evimedPlugins/status',{})).busy,true);await assert.rejects(call('evimedPlugins/verifyExtensions',{}));
    const liveFacts=await call('evimedPlugins/extensionInvocationFacts',{request:{sessionId:'native-owned-session'}});assert.equal(liveFacts.running,true);assert.equal(liveFacts.origin,'root');
    const pendingPage=await page(),normalized=normalizeTranscript('native-owned-session',pendingPage.history.records);
    const tool=normalized.messages.find(message=>message.parts.some(part=>part.type==='tool'&&part.callId==='native_owned_call'));
    const user=normalized.messages.find(message=>message.role==='user'&&message.sourceRequestId==='native-prompt');
    assert(user&&tool);assert.equal(user.turnStartSeq,tool.turnStartSeq);assert(user.seq<=tool.seq);assert.equal(tool.parts[0].status,'pending');assert.deepEqual(tool.parts[0].input,{resourceId:'public_fixture'});allowResult=true;
    for(let i=0;i<120;i++){if(!(await call('evimedPlugins/status',{})).busy)break;await new Promise(resolve=>setTimeout(resolve,100));}
    const transcript=await page();assert(JSON.stringify(transcript).includes('公开原文'));
  }
  console.log(JSON.stringify({kernel:'0.1.7-rc.2',uid:process.getuid(),readOnlyProjection:true,nativeTools:proof.tools,citation:proof.citation,gatewayCalls,modelCalls,qualification:'actual native registry/config/tool pending transport controls; synthetic local gateway/model responses; no SaaS/vendor-model qualification'}));
}finally{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('close',()=>{clearTimeout(timer);resolve();});});await new Promise(resolve=>mock.close(resolve));}
