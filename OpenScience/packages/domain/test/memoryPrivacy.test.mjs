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
