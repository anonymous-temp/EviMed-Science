import assert from 'node:assert/strict';
import {test} from 'node:test';
import { runtimeEnvironment } from '../src/dshProfilePatch.mjs';
const input={presetSkillsDir:'',capabilitiesDir:'',capabilitySkillsDir:'',capsuleMethodsDir:'',capsuleGatewayUrl:'',workloadTokenFile:'',bundleVersion:'',flags:{},limits:{}};
test('per-project fixed configuration reaches the preset environment',()=>{
  const env=runtimeEnvironment({...input,pluginConfig:{revision:7,enabled:false,settings:{timeoutMs:4000}}});
  assert.equal(env.EVIMED_CITE_ENABLED,'0');assert.equal(env.EVIMED_CITE_TIMEOUT_MS,'4000');assert.equal(env.EVIMED_CITE_CONFIG_REVISION,'7');
  assert.throws(()=>runtimeEnvironment({...input,pluginConfig:{revision:7,enabled:true,settings:{timeoutMs:100}}}));
});
