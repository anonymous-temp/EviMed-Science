// What the researcher did after a run, read from the real feedback ledger back into a method's counters (2026-10-24).
//
// `methodAppliedOutcomes.test.mjs` reads rows of the shape the evidence writer produces; this holds the two together through the real table:
// the rows `FeedbackEvents.recordLearningEvidence` writes (its cleaning, its one-row-per-reaction identity, its closed vocabulary) are the rows
// `settleUser` pages through by trigger, with the digest the writer names (the revision's content digest) and the one a run's receipt holds.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { METHOD_SKILL_SCHEMA, mountedMethodDigest } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FeedbackEvents } from "../src/feedbackEvents.mjs";
import { LearningService } from "../src/learningService.mjs";
import { createMethodAppliedOutcomes } from "../src/methodAppliedOutcomes.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 30_000 };
const owner = `applied_${randomUUID().replaceAll("-", "")}`;
const stranger = `applied_${randomUUID().replaceAll("-", "")}`;
const PROJECT = "applied_project";
const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text, "utf8").digest("hex");
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const BODY = ["## Purpose", "Do a thing.", "", "## When to Use", "When it is needed.", "", "## Inputs", "A frozen input.", "", "## Workflow", "1. Do it.", "",
  "## Verification", "- It was done.", "", "## Constraints", "- Never do the other thing.", "", "## Output", "The thing."].join("\n");
/** @type {any} */ let database;
/** @type {FeedbackEvents} */ let feedback;

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await database.migrate();
  await migrateProductStore(database);
  for (const id of [owner, stranger]) await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Applied outcomes','development')", [id]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Applied',1048576)", [owner, PROJECT]);
  feedback = new FeedbackEvents({ database });
});

after(async () => {
  if (!url) return;
  await database.query("DELETE FROM evimed_control.projects WHERE user_id = $1", [owner]).catch(() => {});
  await database.query("DELETE FROM evimed_control.users WHERE id = ANY($1)", [[owner, stranger]]).catch(() => {});
  await database.close?.();
});

test("the reactions the evidence writer filed are what the counters read, once each, for this account only", options, async () => {
  const documents = productDocumentsDouble();
  const learning = new LearningService({ documents, now: () => new Date("2026-10-20T00:00:00.000Z") });
  const method = await learning.createCandidate(owner, {
    projectId: PROJECT, body: BODY, provenance: { origin: "inferred", runId: "run_0" },
    frontmatter: { name: "grade-first", description: "Does grade-first when it is needed.", whenToUse: "When grade-first is needed.",
      metadata: { role: "functional", applies_when: "Needed.", not_when: "Not needed.", derived_from: "run:run_0", evimed_schema: METHOD_SKILL_SCHEMA } },
  });
  const opened = mountedMethodDigest(method.payload, sha256);
  const runs = ["run_corrected", "run_silent", "run_accepted", "run_used", "run_unreacted"].map((id) => ({ id, status: "succeeded", methodsInvoked: [{ name: "grade-first", digest: opened }] }));
  const at = (/** @type {number} */ minutes) => new Date(Date.UTC(2026, 9, 23, 11, minutes)).toISOString();
  const record = (/** @type {string} */ runId, /** @type {Record<string, any>} */ detail, key = "k") =>
    feedback.recordLearningEvidence(owner, { runId, key, projectId: PROJECT, detail: { at: at(0), scope: "conversation", sessionId: "ses_1", ...detail } });
  // The writer names the digest of the revision the run opened: its content digest, which is the method's own while its body stands.
  await record("run_corrected", { evidence: "follow-up", verdict: "correction", rule: "每节只写三行", quote: "不对，每节只要三行", concerns: [{ id: method.id, digest: method.payload.contentDigest }], at: at(5) }, "req_1");
  await record("run_silent", { evidence: "silent", at: at(10) }, "settled");
  await record("run_accepted", { evidence: "follow-up", verdict: "accept", at: at(12) }, "req_2");
  await record("run_used", { evidence: "used", at: at(13) }, "used");
  // A reaction of another account to a run of the same id is never read here.
  await feedback.recordLearningEvidence(stranger, { runId: "run_unreacted", key: "x", projectId: null, detail: { evidence: "steer", quote: "再短一点", at: at(1), scope: "conversation", sessionId: "ses_9" } });

  const settle = createMethodAppliedOutcomes({
    learning, feedback, now: () => NOW,
    resolveProject: async (_userId, projectId) => ({ id: projectId, userId: owner }),
    runsOf: async () => runs,
  });
  const result = await settle.settleUser(owner);
  // The run nobody reacted to but settled in silence is unknown: neither clean nor corrected.
  assert.deepEqual(result, { runs: 4, corrected: 1, clean: 2, unattributed: 0, stale: 0, failed: 0 });
  const counts = (await learning.getMethod(owner, method.id)).payload.learning.counts;
  assert.deepEqual([counts.appliedCorrected, counts.appliedClean], [1, 2], "the acceptance and the file taken");
  // The same window again counts nothing twice, and the stranger's account settles nothing of the owner's runs.
  assert.deepEqual(await settle.settleUser(owner), { runs: 4, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 });
  assert.deepEqual(await settle.settleUser(stranger), { runs: 0, corrected: 0, clean: 0, unattributed: 0, stale: 0, failed: 0 });
});
