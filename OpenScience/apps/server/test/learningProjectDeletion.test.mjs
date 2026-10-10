// 2026-10-10 review M-10/M-11 (owner ruling): deleting a project retires the learned methods whose provenance is only that
// project, and a method that a lesson from another project also shaped keeps standing.
//
// A method is the account's, not the project's, and it used to outlive every project it came from. What the ruling needs the
// record to say is every project a lesson came from, not the first alone: `sourceProjectId` stays where the method was first
// learnt, and `sourceProjectIds` is the list.
import assert from "node:assert/strict";
import test from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { LearningService, methodSourceProjects } from "../src/learningService.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const BODY = [
  "## Purpose", "Do a thing.", "",
  "## When to Use", "When the thing is needed.", "",
  "## Inputs", "A frozen input.", "",
  "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "",
  "## Constraints", "- Never do the other thing.", "",
  "## Output", "The thing.",
].join("\n");

/** @param {string} name */
const frontmatter = (name) => ({
  name,
  description: "Does the thing when the thing is needed, using only the frozen input it is given.",
  whenToUse: "When the thing is needed.",
  metadata: {
    role: "functional", applies_when: "The thing is needed.", not_when: "The other thing is needed.",
    derived_from: "run:run_1", evimed_schema: METHOD_SKILL_SCHEMA,
  },
});

function fixture() {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, jobs: null, now: () => new Date("2026-10-10T00:00:00.000Z") });
  /** @param {string} name @param {string} projectId @param {string} [runId] */
  const learnIn = (name, projectId, runId = `run_${name}`) => learning.createCandidate("u1", {
    projectId, frontmatter: frontmatter(name), body: BODY, provenance: { origin: "inferred", runId },
  });
  return { documents, learning, learnIn };
}

test("a method names every project a lesson came from, and the first stays where it was learnt", async () => {
  const { learning, learnIn } = fixture();
  const created = await learnIn("do-the-thing", "p_one");
  assert.deepEqual(methodSourceProjects(created.payload.provenance), ["p_one"]);
  assert.equal(created.payload.provenance.sourceProjectId, "p_one");

  const amended = await learning.amendMethod("u1", created.id, {
    expectedRevision: created.revision, frontmatter: frontmatter("do-the-thing"), body: `${BODY}\n\nA second lesson.`,
    provenance: { origin: "inferred", runId: "run_later", sourceProjectId: "p_two" },
  });
  assert.equal(amended.payload.provenance.sourceProjectId, "p_one", "where it was first learnt does not move");
  assert.deepEqual(methodSourceProjects(amended.payload.provenance), ["p_one", "p_two"]);

  // The same project again adds nothing, and a lesson that names no project leaves the list as it was.
  const again = await learning.amendMethod("u1", amended.id, {
    expectedRevision: amended.revision, frontmatter: frontmatter("do-the-thing"), body: `${BODY}\n\nA third lesson.`,
    provenance: { origin: "inferred", runId: "run_third", sourceProjectId: "p_two" },
  });
  assert.deepEqual(methodSourceProjects(again.payload.provenance), ["p_one", "p_two"]);
});

test("deleting a project retires the methods learnt only there, with a reason, and no other", async () => {
  const { documents, learning, learnIn } = fixture();
  const only = await learnIn("only-in-one", "p_one");
  const alsoElsewhere = await learnIn("shaped-by-two", "p_one");
  await learning.amendMethod("u1", alsoElsewhere.id, {
    expectedRevision: alsoElsewhere.revision, frontmatter: frontmatter("shaped-by-two"), body: `${BODY}\n\nLearnt again elsewhere.`,
    provenance: { origin: "inferred", runId: "run_elsewhere", sourceProjectId: "p_two" },
  });
  const otherProject = await learnIn("only-in-two", "p_two");
  // A method written before the list existed names the first project only, which is all it can say.
  const legacy = await learnIn("written-before-the-list", "p_one");
  const legacyRow = await documents.get("u1", "method", legacy.id);
  const { sourceProjectIds: _dropped, ...oldProvenance } = legacyRow.payload.provenance;
  await documents.put("u1", "method", legacy.id, { ...legacyRow.payload, provenance: oldProvenance }, { expectedRevision: legacyRow.revision });
  const alreadyStopped = await learnIn("already-stopped", "p_one");
  await learning.retire("u1", alreadyStopped.id, { expectedRevision: alreadyStopped.revision, reason: "你自己停用了它。" });
  // Another account's method of the same project is not touched.
  await learning.createCandidate("u2", { projectId: "p_one", frontmatter: frontmatter("someone-elses"), body: BODY, provenance: { origin: "inferred", runId: "run_u2" } });

  const result = await learning.retireProjectMethods("u1", "p_one");
  assert.deepEqual(result.retired.sort(), [only.id, legacy.id].sort());
  assert.equal(result.kept, 1, "the method a lesson from another project also shaped");

  const status = async (/** @type {string} */ id, userId = "u1") => (await documents.get(userId, "method", id)).payload;
  assert.equal((await status(only.id)).status, "retired");
  assert.equal((await status(only.id)).statusReason, "它只是从已删除的项目里学到的，已停用。");
  assert.equal((await status(legacy.id)).status, "retired");
  assert.notEqual((await status(alsoElsewhere.id)).status, "retired", "learnt in two projects, it is not only this one's");
  assert.equal((await status(otherProject.id)).status, "approved");
  assert.equal((await status(alreadyStopped.id)).statusReason, "你自己停用了它。", "a method the researcher stopped keeps their reason");
  assert.equal((await status(learnedId("someone-elses"), "u2")).status, "approved");

  // Idempotent: a second deletion finds nothing left to stop.
  assert.deepEqual((await learning.retireProjectMethods("u1", "p_one")).retired, []);
});

/** @param {string} name */
const learnedId = (name) => `method:learned:${name}`;

test("a method that changed between the read and the write is read again, and still retired", async () => {
  const { documents, learning, learnIn } = fixture();
  const method = await learnIn("busy-method", "p_one");
  // The first write meets a revision that moved: the double reports it as the store does.
  let interfered = false;
  const put = documents.put.bind(documents);
  documents.put = async (userId, kind, id, payload, options) => {
    if (!interfered && payload.status === "retired") {
      interfered = true;
      const current = await documents.get(userId, kind, id);
      await put(userId, kind, id, { ...current.payload, learning: { ...current.payload.learning, touched: true } }, { expectedRevision: current.revision, telemetry: true });
    }
    return put(userId, kind, id, payload, options);
  };
  const result = await learning.retireProjectMethods("u1", "p_one");
  assert.deepEqual(result.retired, [method.id]);
  assert.equal((await documents.get("u1", "method", method.id)).payload.status, "retired");
});
