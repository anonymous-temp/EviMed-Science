import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinuxDockerEnvironment,validateNativeLinuxPrerequisites,validateOwnedLinuxBridge,createFixedCampaignRelayHandler} from '../extension-saas-acceptance-linux.mjs';
test('native operator explicitly selects default local daemon and refuses inherited remote credentials',()=>{
 assert.deepEqual(nativeLinuxDockerEnvironment({DOCKER_CONTEXT:'default',PATH:'/bin'}),{DOCKER_CONTEXT:'default',PATH:'/bin'});
 for(const env of [{},{DOCKER_CONTEXT:'colima'},{DOCKER_CONTEXT:'default',DOCKER_HOST:'tcp://remote:2375'},{DOCKER_CONTEXT:'default',DOCKER_CERT_PATH:'/key'}])assert.throws(()=>nativeLinuxDockerEnvironment(env));
});
test('native sandbox requires exact AMD64 image and Landlock ABI five',()=>{
 const image='sha256:'+'a'.repeat(64),facts={platform:'linux',hostArchitecture:'x64',daemonArchitecture:'x86_64',imageId:image,imageArchitecture:'amd64',imageOs:'linux',endpoint:'unix:///var/run/docker.sock',landlockAbi:8};
 assert.equal(validateNativeLinuxPrerequisites(facts,image).landlockAbi,8);
 for(const patch of [{hostArchitecture:'arm64'},{daemonArchitecture:'aarch64'},{landlockAbi:0},{endpoint:'tcp://remote:2375'},{imageId:'other'}])assert.throws(()=>validateNativeLinuxPrerequisites({...facts,...patch},image));
});
test('owned bridge requires actual immutable identity and matching host interface',()=>{
 const id='a'.repeat(64),expected={id,name:'owned',rootDigest:'sha256:root'},network={Id:id,Name:'owned',Internal:true,Driver:'bridge',Labels:{'io.evimed.campaign-root':expected.rootDigest},IPAM:{Config:[{Subnet:'172.28.0.0/16',Gateway:'172.28.0.1'}]}},interfaces={['br-'+id.slice(0,12)]:[{family:'IPv4',address:'172.28.0.1',internal:false}]};
 assert.equal(validateOwnedLinuxBridge(network,expected,interfaces).gateway,'172.28.0.1');
 for(const patch of [{Internal:false},{Id:'b'.repeat(64)},{Driver:'host'},{Labels:{}}])assert.throws(()=>validateOwnedLinuxBridge({...network,...patch},expected,interfaces));
 assert.throws(()=>validateOwnedLinuxBridge(network,expected,{}));
});
test('fixed relay refuses unbound target and arbitrary routes without opening upstream',()=>{
 const calls=[],handler=createFixedCampaignRelayHandler({request(){throw new Error('unexpected upstream');}},()=>null),response={once(){return this;},writeHead(code){calls.push(code);},end(){}};
 handler({method:'POST',url:'/internal/model/v1/messages'},response);
 handler({method:'POST',url:'/internal/model/v1/messages?url=http://other'},response);
 handler({method:'CONNECT',url:'host:443'},response);
 assert.deepEqual(calls,[503,403,403]);
});

import {EventEmitter} from 'node:events';
import {bindInspectedNativeLinuxRelay} from '../extension-saas-acceptance-linux.mjs';
function relayHarness(){
 const upstreams=[],timers=[];const module={request(url,options,callback){const request=new EventEmitter();Object.assign(request,{url,options,callback,writes:[],write(chunk){this.writes.push(chunk);},end(){this.ended=true;},destroy(){this.destroyed=true;}});upstreams.push(request);return request;}},clock={setTimeout(callback,ms){const timer={callback,ms};timers.push(timer);return timer;},clearTimeout(timer){timer.cleared=true;}};
 const handler=createFixedCampaignRelayHandler(module,()=> 'http://127.0.0.1:1234',clock);
 function call(route='/internal/model/v1/messages',headers={}){const request=new EventEmitter();Object.assign(request,{method:'POST',url:route,headers});const response=new EventEmitter();Object.assign(response,{headersSent:false,writableEnded:false,writes:[],writeHead(code,outputHeaders){this.code=code;this.headers=outputHeaders;this.headersSent=true;},write(chunk){this.writes.push(chunk);},end(){this.writableEnded=true;this.emit('close');},destroy(){this.destroyed=true;this.emit('close');}});handler(request,response);return{request,response,upstream:upstreams.at(-1)};}
 return{call,upstreams,timers};
}
test('fixed relay forwards all four routes only to pinned target and strips forwarding/host headers',()=>{
 const harness=relayHarness();for(const route of ['/internal/model/v1/messages','/internal/extensions/v1/execute','/internal/extensions/v1/status','/internal/extensions/v1/cancel']){
  const {request,response,upstream}=harness.call(route,{host:'evil',forwarded:'evil','x-forwarded-host':'evil','proxy-authorization':'evil',authorization:'workload','content-type':'application/json'});
  assert.equal(upstream.url.href,'http://127.0.0.1:1234'+route);assert.deepEqual(upstream.options.headers,{authorization:'workload','content-type':'application/json'});
  request.emit('data',Buffer.from('{}'));request.emit('end');assert.equal(upstream.ended,true);assert.equal(Buffer.concat(upstream.writes).toString(),'{}');
  const reply=new EventEmitter();reply.headers={server:'hidden','x-powered-by':'hidden','content-type':'application/json'};reply.statusCode=201;upstream.callback(reply);reply.emit('data',Buffer.from('ok'));reply.emit('end');assert.equal(response.code,201);assert.deepEqual(response.headers,{'content-type':'application/json'});assert.equal(Buffer.concat(response.writes).toString(),'ok');
 }
 assert.ok(harness.timers.every(timer=>timer.ms===120000&&timer.cleared));
});
test('active cap remains held after request end/close until response settles',()=>{
 const harness=relayHarness(),held=[];for(let i=0;i<16;i++){const call=harness.call();call.request.emit('end');call.request.emit('close');held.push(call);}
 assert.equal(harness.call().response.code,403);assert.equal(harness.upstreams.length,16);
 held[0].response.end();harness.call();assert.equal(harness.upstreams.length,17);
 for(const call of held)call.response.end();
});
test('request/response sizes and timeout abort upstream and settle active slot',()=>{
 const harness=relayHarness(),large=harness.call();large.request.emit('data',Buffer.alloc(8*1024*1024+1));assert.equal(large.upstream.destroyed,true);assert.equal(large.response.destroyed,true);
 const output=harness.call(),reply=new EventEmitter();Object.assign(reply,{headers:{},statusCode:200,destroy(){this.destroyed=true;}});output.upstream.callback(reply);reply.emit('data',Buffer.alloc(12*1024*1024+1));assert.equal(reply.destroyed,true);assert.equal(output.response.destroyed,true);
 const timed=harness.call();harness.timers.at(-1).callback();assert.equal(timed.upstream.destroyed,true);assert.equal(timed.response.destroyed,true);
});
function fakeServer(address,closeError){const server=new EventEmitter();Object.assign(server,{listen(port,host,callback){this.binding={port,host};callback();},address(){return address;},closeAllConnections(){this.allClosed=true;},close(callback){this.closeCount=(this.closeCount??0)+1;callback(closeError);}});return server;}
test('owned listener closes on address mismatch and preserves original and cleanup failure',async()=>{
 const bridge={gateway:'172.28.0.1'},server=fakeServer({address:'0.0.0.0',port:1234});await assert.rejects(bindInspectedNativeLinuxRelay(bridge,{createServer:()=>server}),/binding_refused/);assert.equal(server.allClosed,true);assert.equal(server.closeCount,1);
 const failing=fakeServer(null,Object.assign(new Error('close failed'),{code:'EIO'}));await assert.rejects(bindInspectedNativeLinuxRelay(bridge,{createServer:()=>failing}),error=>error instanceof AggregateError&&error.cause.message==='native_linux_relay_binding_refused'&&error.errors[1].code==='EIO');
});
test('target is loopback-only single bind and close joins listener idempotently',async()=>{
 const server=fakeServer({address:'172.28.0.1',port:1234}),relay=await bindInspectedNativeLinuxRelay({gateway:'172.28.0.1'},{createServer:()=>server});assert.deepEqual(server.binding,{port:0,host:'172.28.0.1'});assert.equal(server.maxConnections,16);assert.equal(server.requestTimeout,120000);assert.equal(server.headersTimeout,10000);
 for(const target of ['http://public:42/','http://127.0.0.1:42/path','http://user@127.0.0.1:42/','http://127.0.0.1:42/?url=x'])assert.throws(()=>relay.bindTarget(target));
 relay.bindTarget('http://127.0.0.1:42/');assert.throws(()=>relay.bindTarget('http://127.0.0.1:43/'));await relay.close();await relay.close();assert.equal(server.closeCount,1);
 const second=fakeServer({address:'172.28.0.1',port:42}),unbound=await bindInspectedNativeLinuxRelay({gateway:'172.28.0.1'},{createServer:()=>second});await unbound.close();assert.throws(()=>unbound.bindTarget('http://127.0.0.1:42/'));
});

import {validateOwnedLinuxBridgeKernel} from '../extension-saas-acceptance-linux.mjs';
test('kernel bridge proof accepts assigned no-carrier DOWN bridge omitted by Node but rejects changed identity/type/address',()=>{
 const id='a'.repeat(64),device='br-'+id.slice(0,12),expected={id,name:'owned',rootDigest:'sha256:root'},network={Id:id,Name:'owned',Internal:true,Driver:'bridge',Labels:{'io.evimed.campaign-root':expected.rootDigest},IPAM:{Config:[{Subnet:'192.168.224.0/20',Gateway:'192.168.224.1'}]}};
 const link={ifindex:123,ifname:device,flags:['NO-CARRIER','BROADCAST','MULTICAST','UP'],operstate:'DOWN',linkinfo:{info_kind:'bridge'}},address={ifindex:123,ifname:device,addr_info:[{family:'inet',local:'192.168.224.1',prefixlen:20,scope:'global'}]};
 assert.throws(()=>validateOwnedLinuxBridge(network,expected,{}));assert.equal(validateOwnedLinuxBridgeKernel(network,expected,[link],[address]).addressProof,'iproute2-kernel-json');
 for(const patch of [{ifindex:124},{ifname:'other'},{linkinfo:{info_kind:'dummy'}},{flags:['LOOPBACK','UP']},{flags:[]}])assert.throws(()=>validateOwnedLinuxBridgeKernel(network,expected,[{...link,...patch}],[address]));
 for(const patch of [{ifindex:124},{addr_info:[{family:'inet',local:'192.168.224.2',prefixlen:20,scope:'global'}]},{addr_info:[{family:'inet',local:'192.168.224.1',prefixlen:16,scope:'global'}]}])assert.throws(()=>validateOwnedLinuxBridgeKernel(network,expected,[link],[{...address,...patch}]));
 assert.throws(()=>validateOwnedLinuxBridgeKernel({...network,Internal:false},expected,[link],[address]));assert.throws(()=>validateOwnedLinuxBridgeKernel(network,expected,[],[address]));
});

import {validateNativeRelayListenPort} from '../extension-saas-acceptance-linux.mjs';
test('fixed native operator relay port is bounded and independently bound to exact inspected bridge address',async()=>{
 assert.equal(validateNativeRelayListenPort(),0);assert.equal(validateNativeRelayListenPort(62087),62087);
 for(const port of [null,true,'62087',-1,1023,65536,NaN])assert.throws(()=>validateNativeRelayListenPort(port),/listen_port/);
 const server=fakeServer({address:'172.28.0.1',port:62087}),relay=await bindInspectedNativeLinuxRelay({gateway:'172.28.0.1'},{createServer:()=>server},62087);assert.deepEqual(server.binding,{port:62087,host:'172.28.0.1'});assert.equal(relay.gatewayUrl,'http://172.28.0.1:62087');await relay.close();
 const wrong=fakeServer({address:'172.28.0.1',port:62088});await assert.rejects(bindInspectedNativeLinuxRelay({gateway:'172.28.0.1'},{createServer:()=>wrong},62087),/binding_refused/);assert.equal(wrong.allClosed,true);
});

import http from 'node:http';
test('actual relay ingress records closed path/status/byte counts and excludes all headers and body secrets',async()=>{
 const upstream=http.createServer((_req,res)=>{res.writeHead(200);res.end('ok');});let relay;
 try{await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));relay=await bindInspectedNativeLinuxRelay({gateway:'127.0.0.1'});relay.bindTarget('http://127.0.0.1:'+upstream.address().port+'/');
  const secret='secret-must-not-leak',response=await fetch(relay.gatewayUrl+'/internal/model/v1/messages',{method:'POST',headers:{authorization:secret},body:secret});assert.equal(response.status,200);assert.equal(await response.text(),'ok');await new Promise(resolve=>setTimeout(resolve,10));
  const fact=relay.observations[0];assert.equal(fact.path,'/internal/model/v1/messages');assert.equal(fact.status,200);assert.equal(fact.requestBytes,Buffer.byteLength(secret));assert.equal(fact.responseBytes,2);assert.ok(fact.responseChunks>=1);assert.equal(fact.finished,true);assert.equal(JSON.stringify(relay.observations).includes(secret),false);
  const unknown=await fetch(relay.gatewayUrl+'/not-allowed?token='+secret);assert.equal(unknown.status,403);assert.equal(relay.observations[1].path,'unknown');assert.equal(JSON.stringify(relay.observations).includes(secret),false);
 }finally{await relay?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});
