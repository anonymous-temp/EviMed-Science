import assert from "node:assert/strict";
import test from "node:test";
import { methodView } from "../src/learningRoutes.mjs";

// The view the memory page reads. Since 2026-09-20 a learned method takes
// effect the night it is learned, so the row says what it does and since when
// rather than what it is still waiting for — the page used to print 「还差：成功
// 用到它的任务还不够…」 under every method, describing a gate that under stock
// configuration never opened.
const document = (payload) => ({
  id: "method-1", projectId: null, revision: 1, createdAt: "2026-09-16T08:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z",
  payload: { frontmatter: { name: "证据分层", description: "先分层" }, body: "## 步骤", contentDigest: "sha256:aaa", ...payload },
});

test("a learned method's view lacks nothing, and carries what its row says about itself", () => {
  const view = methodView(document({
    status: "approved", statusChangedAt: "2026-09-16T08:00:00.000Z", provenance: { origin: "inferred" },
    learning: {
      digest: "sha256:aaa", counts: { eligible: 0, loaded: 3, invoked: 0, succeeded: 3, validated: 0, read: 0 },
      observations: [
        { runId: "r1", family: "f1", outcome: "accepted", at: "2026-09-16T08:00:00.000Z" },
        { runId: "r2", family: "f2", outcome: "accepted", at: "2026-09-16T09:00:00.000Z" },
        { runId: "r3", family: "f3", outcome: "accepted", at: "2026-09-16T10:00:00.000Z" },
      ],
      relations: [], evaluations: [], level: 0, lastReadAt: null,
    },
  }));
  assert.equal(view.status, "approved");
  assert.deepEqual(view.promotion.missing, []);
  assert.deepEqual(view.promotion.missingDetails, []);
  assert.equal(view.statusChangedAt, "2026-09-16T08:00:00.000Z", "what 「新」 and 「…起生效」 are read from");
  assert.equal(view.trajectories, 3, "the checkable half of 「从你的 3 次研究学到」");
});

test("a conflict is the one thing a view still reports as missing", () => {
  const view = methodView(document({
    status: "candidate", provenance: { origin: "inferred" },
    learning: {
      digest: "sha256:aaa", counts: { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 },
      observations: [],
      relations: [{ type: "conflicts_with", target: "另一条方法", evidence: "相反要求", proposedBy: "consolidate:job_1" }],
      evaluations: [], level: 0, lastReadAt: null,
    },
  }));
  assert.deepEqual(view.promotion.missingDetails.map((detail) => detail.code), ["conflicts"]);
  assert.equal(view.trajectories, 0);
});

test("a method the researcher wrote lacks nothing and says why", () => {
  const view = methodView(document({ status: "approved", provenance: { origin: "explicit" } }));
  assert.deepEqual(view.promotion.missing, []);
  assert.deepEqual(view.promotion.missingDetails, []);
  assert.match(view.promotion.reasons.join(" "), /explicit origin/);
});
