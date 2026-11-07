import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { proxyRuntimeUiMux } from '../src/runtimeUiMuxProxy.mjs';
import { NativeUiScope } from '../../../packages/harness-port/src/runtimeUiScope.mjs';

async function fixture(t, terminal) {
  const scope=new NativeUiScope({rootSessionId:'root',workspacePath:'/workspace',provider:'p',model:'m'});
  let release, started;
  const barrier=new Promise(resolve=>release=resolve), entering=new Promise(resolve=>started=resolve);
  const ended=[],kernel=createServer(), wss=new WebSocketServer({server:kernel}),peers=new Set();
  wss.on('connection',peer=>{peers.add(peer);peer.on('message',raw=>{
    const frame=JSON.parse(raw.toString());
    if(frame.type==='open'){
      peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'ready',clientId:'client',host:{home:'/private'}}}));
      if(terminal)peer.send(JSON.stringify(terminal==='end'?{type:'end',streamId:frame.streamId}:{type:'error',streamId:frame.streamId,error:{code:'fixture',message:'Error',details:{}}}));
    }
  });});
  await new Promise(resolve=>kernel.listen(0,'127.0.0.1',resolve));
  const gateway=createServer();
  gateway.on('upgrade',(req,socket,head)=>{void proxyRuntimeUiMux({req,socket,head,runtime:{url:`http://127.0.0.1:${kernel.address().port}`},maxPayload:1024*1024,revalidate:async()=>{},authorize:async()=>{},projectItem:async(e,p,v)=>{started();await barrier;return scope.project(e,p,v);},onStreamClosed:endpoint=>{ended.push(endpoint);scope.closeEvents();},onProjectionDiscarded:()=>scope.closeEvents()});});
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const client=new WebSocket(`ws://127.0.0.1:${gateway.address().port}`);
  t.after(async()=>{release();client.terminate();for(const peer of peers)peer.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>kernel.close(resolve));await new Promise(resolve=>gateway.close(resolve));});
  await once(client,'open');
  client.send(JSON.stringify({type:'open',streamId:'events',endpoint:'$events',payload:{args:{}}}));
  await entering; await delay(20);
  return {client,scope,release,ended};
}

test('normal end followed by carrier close still finishes a queued operation', {timeout:5000}, async t=>{
  const f=await fixture(t,'end');
  const closed=once(f.client,'close');f.client.close();await closed;await delay(20);
  f.release();await delay(20);
  assert.equal(f.ended.length,1,'every admitted operation must close once even when its terminal is queued');
  assert.equal(f.scope.clientId,null,'a discarded ready item must not recreate an event generation');
});

test('cancellation during async ready projection cannot recreate the closed event generation', {timeout:5000}, async t=>{
  const f=await fixture(t,null);
  f.client.send(JSON.stringify({type:'cancel',streamId:'events'}));
  await delay(20);assert.equal(f.ended.length,1);
  f.release();await delay(20);
  assert.equal(f.scope.clientId,null,'a canceled and undelivered ready item must not recreate an event generation');
});


test('closed queued question never becomes answer authority without delivery', {timeout:5000}, async t=>{
  const scope=new NativeUiScope({rootSessionId:'root',workspacePath:'/workspace',provider:'p',model:'m'});
  let release,enter;
  const barrier=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
  const kernel=createServer(),wss=new WebSocketServer({server:kernel}),peers=new Set(),ended=[];
  wss.on('connection',peer=>{peers.add(peer);peer.on('message',raw=>{
    const frame=JSON.parse(raw.toString());
    if(frame.type==='open'){
      peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'ready',clientId:'client',host:{home:'/private'}}}));
      peer.send(JSON.stringify({type:'item',streamId:frame.streamId,value:{type:'waterfall',event:'user-questions/request',eventId:'never-delivered',agentId:'root',request:{wait:{callId:'call'},questions:[{id:'q1',question:'Continue?',options:[{label:'Continue'},{label:'Stop'}]}]}}}));
      peer.send(JSON.stringify({type:'end',streamId:frame.streamId}));
    }
  });});
  await new Promise(resolve=>kernel.listen(0,'127.0.0.1',resolve));
  const gateway=createServer();
  gateway.on('upgrade',(req,socket,head)=>{void proxyRuntimeUiMux({req,socket,head,runtime:{url:`http://127.0.0.1:${kernel.address().port}`},maxPayload:1024*1024,revalidate:async()=>{},authorize:async()=>{},projectItem:async(e,p,v)=>{if(v.type==='waterfall'){enter();await barrier;}return scope.project(e,p,v);},onStreamClosed:endpoint=>{ended.push(endpoint);scope.closeEvents();},onProjectionDiscarded:()=>scope.closeEvents()});});
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const client=new WebSocket(`ws://127.0.0.1:${gateway.address().port}`),delivered=[];
  client.on('message',raw=>delivered.push(JSON.parse(raw.toString())));
  t.after(async()=>{release();client.terminate();for(const peer of peers)peer.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>kernel.close(resolve));await new Promise(resolve=>gateway.close(resolve));});
  await once(client,'open');client.send(JSON.stringify({type:'open',streamId:'events',endpoint:'$events',payload:{args:{}}}));
  await entered;await delay(20);
  const closed=once(client,'close');client.close();await closed;await delay(20);release();await delay(20);
  const allowed=scope.permits('$events/result',{args:{clientId:'client',eventId:'never-delivered',outcome:{kind:'result',value:{answers:[{id:'q1',selected:['Continue']}]}}}});
  assert.equal(delivered.length,1,'only ready, not the question, reached the browser');
  assert.equal(allowed,false,'a question discarded after closure must not authorize an answer');
});

test('a scoped frame reads the skill catalogue and the GoalBar of the conversations it can read, and nothing wider', () => {
  const scope = new NativeUiScope({ rootSessionId: 'root', workspacePath: '/workspace', provider: 'p', model: 'm' });
  scope.setChildren([{ kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' }]);
  const skills = sessionId => ({ args: { request: { sessionId } } });
  assert.equal(scope.permits('skills/list', skills('root')), true);
  assert.equal(scope.permits('skills/list', skills('child')), true, 'a child session the frame can read has its own catalogue');
  assert.equal(scope.permits('skills/list', skills('someone-elses')), false);
  assert.equal(scope.permits('skills/list', { args: { request: { sessionId: 'root', other: 1 } } }), false);
  assert.equal(scope.permits('skills/list', { args: { request: { sessionId: 'root' }, extra: true } }), false);
  assert.equal(scope.permits('skills/list', { args: {} }), false);
  const bar = (op, sessionId = 'root', extra = {}) => ({ v: 'loopx_goalbar_request_v2', op, sessionId, ...extra });
  assert.equal(scope.permits('loopx.goalbar', bar('read')), true);
  assert.equal(scope.permits('loopx.goalbar', bar('watch')), true);
  assert.equal(scope.permits('loopx.goalbar', bar('read', 'child')), true);
  assert.equal(scope.permits('loopx.goalbar', bar('read', 'someone-elses')), false);
  for (const op of ['start', 'pause']) assert.equal(scope.permits('loopx.goalbar', bar(op, 'root', { expected: { goalId: 'g', loopxAgentId: 'a' } })), false, `${op} is a person's turn, not a read`);
  assert.equal(scope.permits('loopx.goalbar', { ...bar('read'), extra: 1 }), false);
  assert.equal(scope.permits('loopx.goalbar', { ...bar('read'), v: 'other' }), false);
  assert.equal(scope.permits('commands/list', skills('root')), false, 'the command catalogue stays denied until its request shape is measured on a live kernel');
  assert.equal(scope.permits('settings/mutate', { args: {} }), false);
  // The answer is projected: no absolute path, no personal skill of the runtime's owner, and the bar answers only for its own session.
  const listed = scope.project('skills/list', skills('root'), { skills: [{ name: 'literature', path: '/home/u/skills/literature/SKILL.md', description: 'd' }, { name: 'personal-mine', path: '/p' }] });
  assert.deepEqual(listed, { forward: true, value: { skills: [{ name: 'literature', description: 'd' }] } });
  assert.equal(scope.project('skills/list', skills('root'), { nope: 1 }).forward, false);
  const answer = { v: 'loopx_goalbar_response_v2', op: 'read', sessionId: 'root', result: { kind: 'absent' } };
  assert.equal(scope.project('loopx.goalbar', bar('read'), answer).forward, true);
  assert.equal(scope.project('loopx.goalbar', bar('read'), { ...answer, sessionId: 'child' }).forward, false);
  assert.ok(scope.access().grants.find(grant => grant.resource.id === 'root').actions.includes('skills/list'));
});
