// The method record's scientific axis against the real product store (N14).
//
// What the unit tests cannot say: the lookup of the methods a result version is linked to is a jsonb containment, the
// entries and the scope are written as telemetry (no history row) or with a revision, and a rollback by digest must find
// the exact body in the real revision history. These run the real `ProductDocuments` and assert the same properties.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { METHOD_SKILL_SCHEMA, mountedMethodDigest, parseSkillFrontmatter } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LearningService, learnedMethodId } from "../src/learningService.mjs";
import { MethodFeedbackService } from "../src/methodFeedback.mjs";
import { ProductDocuments } from "../src/productStore.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hex = (character, length = 64) => character.repeat(length);
const version = (n) => `rv_${String(n).padStart(64, "0")}`;
let database; let documents; let learning;
const owners = [];
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  documents = new ProductDocuments(database);
  learning = new LearningService({ documents, resolveBaselineDigest: async () => `sha256:${hex("c")}` });
});
after(async () => { if (database) { await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [owners]); await database.close(); } });

const skill = (workflow) => [
  "---", 'name: "recount-pooled-studies"', 'description: "Recount the studies behind a pooled estimate against the evidence matrix before printing it."',
  'whenToUse: "When a report prints a pooled effect estimate from several studies."', "metadata:", '  role: "functional"',
  '  applies_when: "A pooled estimate is printed."', '  not_when: "The estimate is a single trial\'s own result."', '  derived_from: "run:run-1"', `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "",
  ["## Purpose", "Keep the pool in step.", "", "## When to Use", "When a pool is printed.", "", "## Inputs", "The matrix.", "", "## Workflow", workflow, "",
    "## Verification", "- Counted.", "", "## Constraints", "- Never print a pool of one study.", "", "## Output", "The report."].join("\n"), "",
].join("\n");

async function setup() {
  const owner = `method_feedback_${randomUUID()}`; owners.push(owner);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Method feedback test','development')", [owner]);
  return owner;
}

test("Postgres keeps the scope and the learnt-from versions, finds the method by a version's identity, and records entries once without a history row", options, async () => {
  const owner = await setup();
  const parsed = parseSkillFrontmatter(skill("1. Count the studies."));
  const created = await learning.createCandidate(owner, { frontmatter: parsed.frontmatter, body: parsed.body,
    provenance: { origin: "inferred", runId: "run-1", results: [{ role: "original", versionId: version(1), digest: hex("a") }, { role: "successor", versionId: version(2), digest: hex("b") }] },
    scope: { applicability: "A pooled estimate is printed.", counterexamples: ["Fewer than three studies."] } });
  assert.equal(created.payload.status, "approved");
  assert.deepEqual(created.payload.scope.counterexamples, ["Fewer than three studies."]);
  assert.deepEqual((await learning.methodsLinkedTo(owner, version(2))).map((row) => row.id), [created.id]);
  assert.deepEqual(await learning.methodsLinkedTo(owner, version(3)), []);

  const run = { id: "run-9", sessionId: "s9", status: "succeeded", effectiveAgentId: "meta-analysis",
    methodsInvoked: [{ name: "recount-pooled-studies", digest: mountedMethodDigest(created.payload, sha) }] };
  const service = new MethodFeedbackService({ learning, runs: { list: async () => [run] } });
  const event = { id: `feedback:result-corrected:${randomUUID()}`, trigger: "result-corrected", runId: "run-9", occurredAt: "2026-10-05T00:00:00.000Z", detail: {
    kind: "analytic", original: { versionId: version(7), digest: hex("a"), path: "report.md" }, successor: { versionId: version(8), digest: hex("b"), path: "x/report.md" },
    originalRunId: "run-9", effects: {}, anchor: {}, successorOrigin: "system_generated", adoption: "not_recorded" } };
  const before = await learning.getMethod(owner, created.id);
  const savedBefore = (await documents.history(owner, "method", created.id, { limit: 20 })).length;
  const joined = await service.fromCorrection({ id: "p", userId: owner }, event);
  assert.deepEqual(joined.recorded.map((item) => item.added), [true]);
  assert.deepEqual((await service.fromCorrection({ id: "p", userId: owner }, event)).recorded.map((item) => item.added), [false]);
  const after = await learning.getMethod(owner, created.id);
  assert.equal(after.payload.scientific.entries.length, 1);
  assert.deepEqual(await learning.methodsLinkedTo(owner, version(7)).then((rows) => rows.map((row) => row.id)), [created.id], "used for it, by the entry");
  // Telemetry: the revision moved so a stale writer conflicts, and no history row was written for the entry.
  assert.ok(after.revision > before.revision);
  assert.equal((await documents.history(owner, "method", created.id, { limit: 20 })).length, savedBefore);
  assert.deepEqual((await learning.history(owner, created.id)).map((item) => item.version), [1]);
});

test("Postgres returns a method to the exact earlier body by digest, keeping the scope that body declared and the link that says why", options, async () => {
  const owner = await setup();
  const first = parseSkillFrontmatter(skill("1. Count the studies."));
  const created = await learning.createCandidate(owner, { frontmatter: first.frontmatter, body: first.body, provenance: { origin: "inferred", runId: "run-1" },
    scope: { applicability: "A pooled estimate is printed.", counterexamples: ["One."] } });
  const second = parseSkillFrontmatter(skill("1. Count the studies.\n2. Drop any study with a missing variance."));
  const amended = await learning.amendMethod(owner, created.id, { expectedRevision: created.revision, frontmatter: second.frontmatter, body: second.body,
    provenance: { origin: "inferred", runId: "run-2" }, scope: { applicability: "A pooled estimate is printed.", counterexamples: ["One.", "Two."] } });
  const approved = await learning.approve(owner, created.id, { expectedRevision: amended.revision });
  assert.notEqual(approved.payload.contentDigest, created.payload.contentDigest);
  const id = learnedMethodId("recount-pooled-studies");
  assert.equal(id, created.id);

  const run = (n) => ({ id: `run-${n}`, sessionId: `s${n}`, status: "succeeded", effectiveAgentId: "meta-analysis",
    methodsInvoked: [{ name: "recount-pooled-studies", digest: mountedMethodDigest(approved.payload, sha) }] });
  const runs = [1, 2, 3, 4].map(run);
  const service = new MethodFeedbackService({ learning, runs: { list: async () => runs } });
  const acted = [];
  for (const n of [1, 2, 3, 4]) {
    const joined = await service.fromReplay({ project: { id: "p", userId: owner }, original: { versionId: version(n), digest: hex("a"), producer: { runId: `run-${n}` } },
      replayId: `replay-${n}`, output: { versionId: version(100 + n) }, comparison: { environment: { status: "same" }, numbers: { status: "changed" } } });
    acted.push(joined.recorded[0].acted ?? null);
  }
  assert.deepEqual(acted, [null, null, null, "rollback"]);
  const returned = await learning.getMethod(owner, id);
  assert.equal(returned.payload.contentDigest, created.payload.contentDigest);
  assert.equal(returned.payload.status, "approved");
  assert.deepEqual(returned.payload.scope.counterexamples, ["One."], "the scope of the body it was returned to");
  assert.equal(returned.payload.links.at(-1).type, "rolled_back_for_regression");
  assert.equal(returned.payload.scientific.entries.filter((entry) => entry.digest === approved.payload.contentDigest).length, 4, "what happened under the body it left stays");
  // Undoing it is one click: the newer body is a revision the ledger still holds.
  const undone = await learning.rollback(owner, id, { expectedRevision: returned.revision, targetDigest: approved.payload.contentDigest });
  assert.equal(undone.payload.contentDigest, approved.payload.contentDigest);
});
