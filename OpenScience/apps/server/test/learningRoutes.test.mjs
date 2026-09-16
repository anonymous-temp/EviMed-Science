import assert from "node:assert/strict";
import test from "node:test";
import { methodView } from "../src/learningRoutes.mjs";

// The view the methods page reads (2026-09-16 review, P2 #15). What a candidate
// lacks has to arrive as codes the page can put in Chinese, line for line with
// the English sentences the log keeps.
const document = (payload) => ({
  id: "method-1", projectId: null, revision: 1, createdAt: "2026-09-16T08:00:00.000Z", updatedAt: "2026-09-16T08:00:00.000Z",
  payload: { frontmatter: { name: "证据分层", description: "先分层" }, body: "## 步骤", contentDigest: "sha256:aaa", ...payload },
});

test("a learned candidate's view says what it still lacks, as sentences and as codes in the same order", () => {
  const view = methodView(document({ status: "candidate", provenance: { origin: "inferred" } }));
  assert.equal(view.status, "candidate");
  assert.ok(view.promotion.missing.length >= 2, "a method with no observations lacks both evidence and an evaluation");
  assert.equal(view.promotion.missingDetails.length, view.promotion.missing.length);
  assert.deepEqual(view.promotion.missingDetails.map((detail) => detail.code), ["trajectories_needed", "no_evaluation"]);
  assert.equal(view.promotion.missingDetails[0].have, 0);
});

test("a method the researcher wrote lacks nothing and says why", () => {
  const view = methodView(document({ status: "approved", provenance: { origin: "explicit" } }));
  assert.deepEqual(view.promotion.missing, []);
  assert.deepEqual(view.promotion.missingDetails, []);
  assert.match(view.promotion.reasons.join(" "), /explicit origin/);
});
