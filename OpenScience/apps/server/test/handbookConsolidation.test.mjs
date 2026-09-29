import assert from "node:assert/strict";
import test from "node:test";
import { MethodConsolidation } from "../src/methodConsolidation.mjs";

test("optimize consumes the owner-scoped handbook instead of successfully leaving it on a shelf", async () => {
  let consumed = null;
  const handbookConsolidation = { async run(request) { consumed = request; return { action: "optimize", disposition: "applied", verification: "unmeasured" }; } };
  const consolidation = new MethodConsolidation({ learning: {}, dispatch: async () => {}, readResult: async () => {}, handbookConsolidation });
  const job = { id: "job", userId: "alice", payload: { action: "optimize", capabilityId: "geo-content", candidateId: "candidate", candidateDigest: "digest" } };
  const result = await consolidation.run({ job });
  assert.equal(result.disposition, "applied");
  assert.deepEqual(consumed, { job });
  assert.equal(result.verification, "unmeasured");
});
