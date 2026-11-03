import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDataAnalysisDispatchLock } from '../src/dataAnalysisAdmission.mjs';
import { buildRuntimeLaunchPlan } from '../src/runtimeManager.mjs';
import { AgentBayRuntimeProvider } from '../src/agentbay/runtimeProvider.mjs';

function fixture(maximum=2){
  const clients=[];const locked=new Set();
  class Client extends EventEmitter {
    async connect(){}
    async query(sql,args){
      if(sql.includes('pg_try_advisory')){const key=args.join(':');if(locked.has(key))return {rows:[{locked:false}]};locked.add(key);this.key=key;return {rows:[{locked:true}]};}
      if(this.ended)throw new Error('closed');return {rows:[]};
    }
    async end(){this.ended=true;if(this.key)locked.delete(this.key);}
  }
  return {clients,admit:createDataAnalysisDispatchLock({dataAnalysisMaxDispatches:maximum},{clientFactory:()=>{const client=new Client();clients.push(client);return client;}})};
}
test('admission uses bounded dedicated connections and releases capacity on every exit',async()=>{
  const {clients,admit}=fixture(1);let release,entered;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const first=admit('a','t1',async guard=>{await guard();entered();await held;return 'done';});await started;
  await assert.rejects(admit('a','t2',async()=>{}),{code:'analysis_dispatch_capacity'});assert.equal(clients.length,1);
  release();assert.equal(await first,'done');assert(clients[0].ended);
  await assert.rejects(admit('a','t2',async()=>{throw new Error('failure');}),{code:'analysis_dispatch_admission_unavailable'});assert(clients[1].ended);
  assert.equal(await admit('a','t3',async()=>true),true);
});
test('a lost dedicated connection fences later reservation and prompt admission',async()=>{
  const {clients,admit}=fixture();
  await assert.rejects(admit('a','t',async guard=>{clients[0].emit('error',new Error('lost'));await assert.rejects(guard(),{code:'analysis_dispatch_lock_lost'});}),{code:'analysis_dispatch_lock_lost'});
  assert(clients[0].ended);
});
test('Docker and AgentBay analysis runtimes disable LoopX without changing ordinary projects',()=>{
  const config={runtimeSandboxMode:'docker',runtimeContainerBin:'docker',runtimeContainerImage:'evimed-runtime-dsh:test',runtimeTransport:'unix',runtimeNetworkMode:'none',loopxEnabled:true};
  const project={id:'ordinary',userId:'alice',workspaceDir:'/srv/workspace',runtimeDir:'/srv/runtime'};
  assert(buildRuntimeLaunchPlan(config,project,49152).args.includes('EVIMED_LOOPX_ENABLED=1'));
  const analysis={...project,id:`da-${'a'.repeat(40)}`};
  assert(buildRuntimeLaunchPlan(config,analysis,49152).args.includes('EVIMED_LOOPX_ENABLED=0'));
  const provider=new AgentBayRuntimeProvider({config},{client:null}),plan={gateways:{}};
  assert.equal(provider.kernelEnvironment(project,plan).EVIMED_LOOPX_ENABLED,'1');
  assert.equal(provider.kernelEnvironment(analysis,plan).EVIMED_LOOPX_ENABLED,'0');
});
