import test from "node:test";
import assert from "node:assert/strict";
import { createModuleEvolutionPolicies, validateModuleEvolutionPolicy } from "../src/moduleEvolutionPolicies.mjs";
import { geoInterventionIdentity } from "../src/geoMeasureStore.mjs";

test("policy reader rejects undeclared executable fields and falls back on unreadable revisions", async () => {
  assert.equal(validateModuleEvolutionPolicy("frontier", { code: "run()" }), false);
  const policies = createModuleEvolutionPolicies({ readPolicy: async () => ({ revisionId: "r1", policy: { selectionThreshold: 72 } }) });
  assert.deepEqual((await policies.resolve("frontier", { selectionThreshold: 82 })).policy, { selectionThreshold: 72 });
  const broken = createModuleEvolutionPolicies({ readPolicy: async () => { throw new Error("offline"); } });
  assert.equal((await broken.resolve("frontier", { selectionThreshold: 82 })).policy.selectionThreshold, 82);
  assert.equal(validateModuleEvolutionPolicy("geo", { supplements: [{ capabilityId: "vcr-analysis", text: "x" }] }), false);
});

// The comparison that read this identity (`geoPolicyComparison`) left with the experiment engine; the identity is still written into every round.
test("an unknown assistant version is an explicit stratum, and every placement and channel of a round is in its identity", () => {
  const unknown = geoInterventionIdentity({}, ["assistant"]);
  assert.equal(unknown.engines[0].observedVersion, "unknown");
  assert.deepEqual([unknown.placements, unknown.channels], [[], []]);
  const known = geoInterventionIdentity({ intervention: { engineVersions: { assistant: "build-1" }, questionSetVersion: 1, contentRevision: "new", sourceRevision: "evidence-1", placements: ["concurrent"], channels: ["new-channel"] } }, ["assistant"]);
  assert.deepEqual(known.engines, [{ engine: "assistant", observedVersion: "build-1" }]);
  assert.deepEqual([known.questionSetVersion, known.contentRevision, known.sourceRevision, known.placements, known.channels], [1, "new", "evidence-1", ["concurrent"], ["new-channel"]]);
});
