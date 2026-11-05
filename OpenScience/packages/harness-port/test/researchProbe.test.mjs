import test from 'node:test'
import assert from 'node:assert/strict'
import { registerResearchConfiguration, verifyResearchAgent } from '../src/pluginProbe.mjs'

test('research proof checks actual definitions and disposal', async () => {
  let dispose = () => {}
  const ctx = { effect(/** @type {()=>()=>void} */ fn) { dispose = fn() }, tools: { get(/** @type {string} */ name) { return definitions.get(/** @type {string} */ name) } } }
  const definitions = new Map(['describe', 'start', 'read', 'cancel', 'report'].map(action => [`virtual_trial_${action}`, {}]))
  verifyResearchAgent({ tools: { get() {} } }, {}, [])
  await registerResearchConfiguration(ctx, { extensionId: 'virtual-trial', definitions })
  verifyResearchAgent(ctx, {}, ['virtual-trial'])
  assert.throws(() => verifyResearchAgent(ctx, {}, []), /extension_probe_registrations_invalid/)
  const original = definitions.get('virtual_trial_start')
  assert.ok(original)
  definitions.set('virtual_trial_start', {})
  assert.throws(() => verifyResearchAgent(ctx, {}, ['virtual-trial']), /extension_probe_registrations_invalid/)
  definitions.set('virtual_trial_start', original)
  dispose()
  assert.throws(() => verifyResearchAgent(ctx, {}, ['virtual-trial']), /extension_probe_registrations_invalid/)
  await assert.rejects(registerResearchConfiguration(ctx, { extensionId: 'unapproved', definitions }), /extension_probe_config_invalid/)
})

test('research proof covers zero, one, four and suite selections and detects tools leaked from disabled bundles',async()=>{
  const {RESEARCH_NATIVE_BUNDLES}=await import('@evimed/domain');
  for(const count of [0,1,4,5]){
    /** @type {(()=>void)[]} */const disposers=[];
    /** @type {Map<string,any>} */const definitions=new Map();
    const ctx={effect(/** @type {()=>()=>void} */fn){disposers.push(fn())},tools:{get(/** @type {string} */name){return definitions.get(name)}}};
    const selected=Object.entries(RESEARCH_NATIVE_BUNDLES).slice(0,count);
    try{
      for(const [id,spec]of selected){
        const own=new Map(spec.tools.map((/** @type {string} */name)=>[name,{}]));
        for(const [name,value]of own)definitions.set(name,value);
        await registerResearchConfiguration(ctx,{extensionId:id,definitions:own});
      }
      verifyResearchAgent(ctx,{},selected.map(([id])=>id));
      if(count<5){
        const disabled=Object.values(RESEARCH_NATIVE_BUNDLES)[count].tools[0];
        definitions.set(disabled,{});
        assert.throws(()=>verifyResearchAgent(ctx,{},selected.map(([id])=>id)),/extension_probe_registrations_invalid/);
      }
    }finally{for(const dispose of disposers.reverse())dispose()}
  }
});
