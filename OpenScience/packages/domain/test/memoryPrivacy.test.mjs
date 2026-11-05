import assert from "node:assert/strict";
import test from "node:test";
import { CAPSULE_FACT_KINDS, privateByDefault } from "../index.mjs";

test("people privacy derives from native and persisted capsule kinds, never the owner's sensitive flag", () => {
  for (const record of [{nativeType:"people"},{kind:"person"},{factKind:"person"},{payload:{factKind:"person"}}]) assert.equal(privateByDefault(record),true);
  for (const record of [null,undefined,"person",{}, {kind:"note"},{nativeType:"notes"},{kind:"profile",sensitive:true}]) assert.equal(privateByDefault(record),false);
  assert.ok(CAPSULE_FACT_KINDS.includes("person")); assert.ok(CAPSULE_FACT_KINDS.includes("note"));
});

test('unclassified native notes retain privacy across generic restatement and explicit imported origin claims',()=>{
  assert.equal(privateByDefault({nativeType:'notes',kind:'note',origin:'explicit',sourcePrivacy:{schemaVersion:1,classification:'unclassified'}}),true);
  assert.equal(privateByDefault({nativeType:'preferences',kind:'preference',sourcePrivacy:{schemaVersion:1,classification:'private'},value:'Review constraints before acting.'}),true);
});

test('original private or unknown evidence cannot be made public by generic body text or share consent for another purpose',async()=>{
  const api=await import('../src/memoryPrivacy.mjs');assert.equal(typeof api.sourceAllowsEgress,'function');
  const original={sourcePrivacy:{schemaVersion:1,classification:'private'},content:'Patient refused blood for religious reasons.'},generic={sourcePrivacy:{schemaVersion:1,classification:'ordinary'},content:'Check requirements.',originalSources:[original]};
  assert.equal(api.sourceAllowsEgress(generic,{purpose:'method'}),false);
  assert.equal(api.sourceAllowsEgress(generic,{purpose:'share',contentDigest:'a'.repeat(64),consentDigest:'a'.repeat(64)}),true);
  assert.equal(api.sourceAllowsEgress(generic,{purpose:'global-method',contentDigest:'a'.repeat(64),consentDigest:'a'.repeat(64)}),false);
  assert.equal(api.sourceAllowsEgress({nativeType:'notes'},{purpose:'external-api'}),false);
  assert.equal(api.sourceAllowsEgress({sourcePrivacy:{schemaVersion:1,classification:'ordinary'}},{purpose:'method'}),true);
});
