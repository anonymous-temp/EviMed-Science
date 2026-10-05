import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRuntimeLaunchPlan} from '../src/runtimeManager.mjs';
const config={runtimeSandboxMode:'docker',runtimeTransport:'unix',runtimeContainerImage:'runtime:test',runtimeNetworkMode:'research-internal',evolutionEvaluationNetwork:'evaluation-isolated',evolutionEnabled:true};
const project=id=>({id,userId:'alice',workspaceDir:'/srv/users/alice/workspace',runtimeDir:'/srv/users/alice/runtime'});
test('evaluation network is scoped to enabled internal evolution launches and actual Docker arguments',()=>{
 for(const id of ['eval-paper-unit','evolution-eval-unit','evimed-evolution']){
  const plan=buildRuntimeLaunchPlan(config,project(id),49152);
  assert.equal(plan.networkMode,'evaluation-isolated');
  assert.equal(plan.args[plan.args.indexOf('--network')+1],'evaluation-isolated');
 }
 for(const [settings,id] of [[config,'ordinary-paper'],[{...config,evolutionEnabled:false},'eval-paper-unit'],[{...config,evolutionEvaluationNetwork:''},'eval-paper-unit']]){
  const plan=buildRuntimeLaunchPlan(settings,project(id),49152);
  assert.equal(plan.networkMode,'research-internal');
  assert.equal(plan.args[plan.args.indexOf('--network')+1],'research-internal');
 }
});
test('evaluation network selection cannot bypass existing host-network prohibition',()=>{
 assert.throws(()=>buildRuntimeLaunchPlan({...config,evolutionEvaluationNetwork:'host'},project('eval-paper-unit'),49152),error=>error.code==='runtime_network_forbidden');
});
