// Review S1: a pooling of ADAS-cog points never reaches treatment.diseaseModifying.fraction. The refusal comes before the store is read, so the
// binding is checked with a store that must not be touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindVcrEffectPrior } from "../src/vcrEffectPriorBinding.mjs";

test("effectFrom target disease_modifying_fraction is refused by name and reads nothing", async () => {
  const store = { result: async () => assert.fail("the store was read"), one: async () => assert.fail("the store was read") };
  const scenario = { treatment: { effectFrom: { input: "result:res_pool1@2", target: "disease_modifying_fraction" } } };
  await assert.rejects(bindVcrEffectPrior({ store, studyId: "std_1", scenario, inputs: [{ kind: "result", id: "result:res_pool1@2" }] }),
    (/** @type {any} */ error) => error.issues?.[0]?.code === "effect_prior_target_scale" && error.issues[0].field === "scenario.treatment.effectFrom.target");
});
