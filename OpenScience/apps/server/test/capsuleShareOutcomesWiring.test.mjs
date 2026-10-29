// Built, tested and actually wired (the reading `sourceUsesWiring.test.mjs` takes of the composition root): what became of a received pack
// reaches the sharing funnel only if the hook a finished run passes through reads the run, and the ledger of the researcher's reactions
// tells the funnel about a correction. A unit test of the counter cannot see either come loose.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}

test("the run-finish hook hands the run's transcript to the funnel, and not for the platform's own projects", () => {
  assert.match(serverSource, /import \{ createReceivedPackOutcomes \} from "\.\/capsuleShareOutcomes\.mjs";/);
  assert.match(serverSource, /if \(capsuleService\) packOutcomes = createReceivedPackOutcomes\(\{ capsules: capsuleService \}\);/);
  const transcript = serverSource.indexOf("const receipt = await persistRunTranscript(");
  const hook = serverSource.indexOf("await packOutcomes?.afterRun(", transcript);
  assert.ok(transcript > 0 && hook > transcript, "counted after the transcript is written, from the same sessions");
  assert.match(serverSource.slice(hook, hook + 200), /\{ project, run, sessions, skip: internalFor\(project\.userId, project\.id\) \}/);
  // Not inside `recordMethodUse` and its learning guard: the funnel is about sharing, and counts whether or not the loop is turning.
  const learning = serverSource.indexOf("const recordMethodUse = async");
  const recordMethodUse = serverSource.slice(learning, serverSource.indexOf("// Constructed after the runtime exists", learning));
  assert.ok(learning > 0 && !recordMethodUse.includes("packOutcomes"), "so a deployment with the loop off still counts what became of a pack");
});

test("the ledger of the researcher's reactions tells the funnel first, before any other consumer may leave early", () => {
  const recorded = serverSource.indexOf("onRecorded: async event => {");
  assert.ok(recorded > 0);
  const body = serverSource.slice(recorded, recorded + 900);
  const funnel = body.indexOf("packOutcomes?.onEvidence(event)");
  const evolution = body.indexOf('event.trigger === "learning-evidence") return');
  assert.ok(funnel > 0 && evolution > funnel, "the evolution module returns early for the loop's own evidence rows; the funnel is told before that");
});

test("the actual app gives the funnel every reaction the ledger records", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured",
}, async () => {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-pack-outcomes-"));
  const app = createWebApiApp({ evimedWorkloadSigningSecret: randomBytes(32).toString("hex"), dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl });
  const username = `outcomes${randomUUID().slice(0, 8)}`;
  let user;
  try {
    user = await app.store.createUser(username, "test-only-outcomes-password", "Outcomes fixture");
    await app.listen(0, "127.0.0.1");
    assert.ok(app.packOutcomes, "the app builds the funnel beside the capsule service");
    const seen = [];
    const real = app.packOutcomes.onEvidence;
    app.packOutcomes.onEvidence = (/** @type {any} */ event) => { seen.push(event); real(event); };
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const detail = { evidence: "follow-up", verdict: "correction", at: new Date().toISOString() };
    const run = `run_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await app.feedbackEvents.recordLearningEvidence(user.id, { runId: run, projectId: project.id, key: "turn-1", detail });
    assert.equal(seen.length, 1, "told when the reaction was recorded");
    assert.equal(seen[0].trigger, "learning-evidence");
    assert.equal(seen[0].runId, run);
    assert.equal(seen[0].detail.verdict, "correction");
    app.packOutcomes.onEvidence = real;
  } finally {
    if (user) await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
