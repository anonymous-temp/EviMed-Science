// Deleting a project keeps its methods, their revisions and its pending
// learning jobs (audit 2026-09-26, L-G1 and L-G11).
//
// On 2026-09-23 `pre-submission-freeze-check` disappeared from production with
// every one of its revisions: it was filed under the project it was learnt in,
// and `documents(user_id, project_id) → projects ON DELETE CASCADE` took it
// when that project was deleted. The lessons queued from the project's runs
// went the same way, and the audit line saying who deleted it was written into
// the deleted project's own directory. This file deletes a project through the
// real route, on a real database, and counts what is left.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA } from "@evimed/domain";

import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { LEARNING_PROJECT_ID } from "../src/internalProjects.mjs";
import { learningLedgerCounts, learningSummary } from "../src/learningMetrics.mjs";
import { LearningService } from "../src/learningService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { TRANSCRIPT_DIR_NAME, transcriptPath } from "../src/runTranscripts.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 90_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const BODY = [
  "## Purpose", "Freeze the package before it is submitted.", "",
  "## When to Use", "Before a delivery is submitted.", "",
  "## Inputs", "The package.", "",
  "## Workflow", "1. Freeze it.", "",
  "## Verification", "- Nothing changed after the freeze.", "",
  "## Constraints", "- Never edit a frozen file.", "",
  "## Output", "A frozen package.",
].join("\n");

/** @param {string} name */
const frontmatter = (name) => ({
  name,
  description: "Freezes a package before it is submitted so nothing changes between the check and the delivery.",
  whenToUse: "Before a delivery is submitted.",
  metadata: { role: "functional", applies_when: "A package is about to be submitted.", not_when: "Nothing is being delivered.",
    derived_from: "run:run_paper", evimed_schema: METHOD_SKILL_SCHEMA },
});

test("deleting a project keeps its methods, their revisions and its pending learning jobs", options, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-lessons-"));
  // The loop's worker is off so it cannot claim the lessons this test counts;
  // what keeps them is the deletion route, which does not depend on it.
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl, learningEnabled: false });
  const username = `lessons${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-lessons-password", "Lessons fixture");
    const address = await app.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "test-only-lessons-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: "paper", name: "论文" }) })).status, 200);

    const database = app.store.database;
    const documents = new ProductDocuments(database);
    const jobs = new ProductJobs(database);
    const learning = new LearningService({ documents });

    // A method learnt in the project, the way the loop writes one now: a
    // second body and a counter write after it.
    const learnt = await learning.createCandidate(user.id, { projectId: "paper", frontmatter: frontmatter("pre-submission-freeze-check"),
      body: BODY, provenance: { origin: "inferred", runId: "run_paper" } });
    const amended = await learning.amendMethod(user.id, learnt.id, { expectedRevision: learnt.revision,
      frontmatter: frontmatter("pre-submission-freeze-check"), body: `${BODY}\n\nFreeze the matrix too.` });
    await learning.recordEligible(user.id, amended.id);
    assert.equal(learnt.projectId, null, "written at account level");

    // And one filed the way the loop wrote them before 2026-09-27, under its
    // project, with a counter saved as a revision.
    const legacyId = "method:learned:legacy-freeze";
    const legacyPayload = { ...learnt.payload, frontmatter: frontmatter("legacy-freeze"), provenance: { origin: "inferred", runId: "run_old" } };
    delete legacyPayload.bodyVersion;
    delete legacyPayload.bodyUpdatedAt;
    const legacy = await documents.put(user.id, "method", legacyId, legacyPayload, { expectedRevision: 0, projectId: "paper" });
    await documents.put(user.id, "method", legacyId, { ...legacyPayload, learning: { ...legacyPayload.learning, counts: { ...legacyPayload.learning.counts, eligible: 1 } } },
      { expectedRevision: legacy.revision, projectId: "paper" });
    // The migration, as a restarted process runs it. Its body-version fill is
    // once per deployment; forgetting that it ran is how this test sees it.
    await database.query("DELETE FROM evimed_product.schema_migrations WHERE name='2026-09-27-account-level-methods-v1'");
    const restarted = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
    try { await migrateProductStore(restarted); } finally { await restarted.close(); }
    const moved = await documents.get(user.id, "method", legacyId);
    assert.equal(moved.projectId, null, "the migration files it under the account");
    assert.equal(moved.payload.provenance.sourceProjectId, "paper");
    assert.equal(moved.payload.bodyVersion, 1, "two saved revisions, one body");
    assert.equal(moved.revision, 2, "and moving it is not a revision of it");

    // Lessons waiting on the project's runs, and one that already ran.
    const project = await app.store.requireProject(await app.store.userById(user.id), "paper");
    await mkdir(path.join(project.metaDir, TRANSCRIPT_DIR_NAME), { recursive: true });
    await writeFile(transcriptPath(project, "run_paper"), '{"schemaVersion":1,"runId":"run_paper"}\n');
    const waiting = await jobs.enqueue(user.id, "distill", { runId: "run_paper", trigger: "delivered" },
      { idempotencyKey: "distill:run_paper:delivered", projectId: "paper" });
    const pass = await jobs.enqueue(user.id, "consolidate", { action: "sleep", date: "2026-09-27T00:00:00.000Z" },
      { idempotencyKey: "consolidate:sleep:test", projectId: "paper" });

    const revisionsBefore = await database.query(`SELECT id, count(*)::integer AS n FROM evimed_product.revisions
      WHERE user_id=$1 AND kind='method' GROUP BY id ORDER BY id`, [user.id]);

    const deletion = await fetch(`${base}/api/projects/paper`, { method: "DELETE", headers, body: JSON.stringify({ confirm: "paper" }) });
    assert.equal(deletion.status, 200);
    assert.equal((await database.query("SELECT 1 FROM evimed_control.projects WHERE user_id=$1 AND id='paper'", [user.id])).rowCount, 0,
      "the project is gone");

    // The methods, and every revision of them.
    for (const id of [learnt.id, legacyId]) {
      const row = await documents.get(user.id, "method", id);
      assert.ok(row, `${id} outlived its project`);
      assert.equal(row.projectId, null);
      assert.equal(row.payload.provenance.sourceProjectId, "paper");
    }
    const revisionsAfter = await database.query(`SELECT id, count(*)::integer AS n FROM evimed_product.revisions
      WHERE user_id=$1 AND kind='method' GROUP BY id ORDER BY id`, [user.id]);
    assert.deepEqual(revisionsAfter.rows, revisionsBefore.rows, "not one revision was lost");
    assert.equal((await learning.history(user.id, learnt.id)).length, 2, "and the history still lists both bodies");

    // The lessons, in the learning project, naming where they came from.
    for (const job of [waiting, pass]) {
      const row = (await database.query("SELECT project_id, status, payload FROM evimed_product.jobs WHERE id=$1", [job.id])).rows[0];
      assert.ok(row, `${job.id} outlived the project`);
      assert.equal(row.project_id, LEARNING_PROJECT_ID);
      assert.equal(row.status, "queued");
      assert.equal(row.payload.sourceProjectId, "paper");
    }
    const learningProject = await app.store.requireProject(await app.store.userById(user.id), LEARNING_PROJECT_ID);
    assert.equal(await readFile(transcriptPath(learningProject, "run_paper"), "utf8"), '{"schemaVersion":1,"runId":"run_paper"}\n',
      "the waiting lesson's transcript is where the worker will read it");

    // The loop's own counts read the same rows (learningMetrics.mjs, L-G5):
    // the SQL is checked against the real schema here, not only a double.
    const summary = await learningSummary(database, user.id);
    assert.deepEqual(summary.methods, { candidate: 1, approved: 1, retired: 0 }, "one effective, one amended and waiting to be re-admitted");
    assert.deepEqual(summary.lessons.byTrigger, { delivered: 1 });
    const everyone = await learningLedgerCounts(database);
    assert.ok(everyone.methods.approved + everyone.methods.candidate >= 2);
    // The usage summary narrowed to the loop's own purpose, which the
    // account page subtracts from the open calls it states (L-G9).
    const usage = new UsageLedger(database);
    assert.equal((await usage.summary(user.id, { since: new Date(0), purposes: ["learning"] })).totalCalls, 0);
    await assert.rejects(usage.summary(user.id, { purposes: ["not-a-purpose"] }), { code: "usage_payload_invalid" });

    // Who deleted what, and when, in a ledger that outlives the project.
    const security = await readFile(path.join(dataDir, ".openscience", "security.jsonl"), "utf8");
    const line = security.split("\n").filter(Boolean).map((text) => JSON.parse(text)).find((record) => record.action === "project.delete");
    assert.ok(line, "the deletion is in the global security ledger");
    assert.equal(line.userId, user.id);
    assert.equal(line.status, "completed");
    assert.match(line.detail, /project=paper learning_jobs_moved=2 lesson_inputs_kept=1/);
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
