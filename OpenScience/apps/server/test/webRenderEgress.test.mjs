import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {once} from 'node:events';
import {openRenderEgress} from '../src/webRenderEgress.mjs';
test('async connected pinned tunnels carry bytes without waiting for an already-emitted connect event', {timeout:5000},async t=>{
 const server=net.createServer(socket=>socket.pipe(socket));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const calls=[],egress=await openRenderEgress({bindAddress:'127.0.0.1',peerAddress:'127.0.0.1',resolveImpl:async()=>[{address:'93.184.216.34',family:4}],maxBytes:4096,maxHosts:4,counts:{requestsRefused:0,byteCaps:0},connectImpl:async({host,port})=>{calls.push({host,port});const socket=net.connect({host:'127.0.0.1',port:server.address().port});await once(socket,'connect');return socket;}});t.after(()=>egress.close());
 const proxy=new URL(egress.proxyUrl),client=net.connect({host:proxy.hostname,port:Number(proxy.port)});t.after(()=>client.destroy());await once(client,'connect');client.write('CONNECT public.example.org:443 HTTP/1.1\r\nHost: public.example.org\r\n\r\n');
 const [answer]=await once(client,'data');assert.match(answer.toString(),/200 Connection Established/);client.write('end-to-end-TLS-placeholder');const [echo]=await once(client,'data');assert.equal(echo.toString(),'end-to-end-TLS-placeholder');assert.deepEqual(calls,[{host:'93.184.216.34',port:443}]);
});
test('close aborts and joins a pending asynchronous upstream without leaving a late socket', {timeout:5000},async t=>{
 let began,aborted=false;const started=new Promise(resolve=>{began=resolve;});
 const egress=await openRenderEgress({bindAddress:'127.0.0.1',peerAddress:'127.0.0.1',resolveImpl:async()=>[{address:'93.184.216.34',family:4}],maxBytes:4096,maxHosts:4,counts:{requestsRefused:0,byteCaps:0},connectImpl:async(_options,signal)=>{began();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('controlled abort'));},{once:true}));}});t.after(()=>egress.close());
 const proxy=new URL(egress.proxyUrl),client=net.connect({host:proxy.hostname,port:Number(proxy.port)});client.on('error',()=>{});t.after(()=>client.destroy());await once(client,'connect');client.write('CONNECT public.example.org:443 HTTP/1.1\r\nHost: public.example.org\r\n\r\n');await started;await egress.close();assert.equal(aborted,true);
});
