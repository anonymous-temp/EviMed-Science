import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { frontmatter, BODY } from "./helpers/handbookFixture.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
test("actual application consumes a reviewed lesson and sends its exact receipt through authenticated dispatch", { skip: !databaseUrl }, async () => {
  const database = await createGeoTestDatabase(databaseUrl, "hbapp");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-handbook-app-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: database.url,
    learningEnabled: true, learningWindow: "", evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    researchMemory: { configured: false, async status() { return { configured: false }; } } });
  try {
    const address = await app.listen(0, "127.0.0.1");
    await app.learningWorker.close();
    const user = await app.store.createUser("handbook-owner", "test-password", "Handbook owner");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "handbook-owner", password: "test-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    const agents = (await (await fetch(`${base}/api/agents`, { headers })).json()).data;
    const selected = agents.find((agent) => agent.id === "statistical-analysis");
    assert.ok(selected, "the actual generated registry loads the new optional-output capability");
    await app.researchSessions.put(project, "source-session", { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
    const source = await app.agentRuns.dispatch(project, { sessionId: "source-session", dispatchId: "source-dispatch", question: "Test source" }, async () => {});
    const learning = app.runtimeManager.learningService;
    const candidate = await learning.recordHandbookCandidate(user.id, { frontmatter, body: BODY, capabilityId: selected.id,
      provenance: { runId: source.id, sourceProjectId: project.id, derivedFrom: "reviewer" } });
    const db = app.store.database;
    const jobRow = await db.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'candidateId'=$2", [user.id, candidate.id]);
    await db.query("UPDATE evimed_product.jobs SET status='running', lease_token='test-lease', lease_expires_at=clock_timestamp()+interval '1 minute' WHERE user_id=$1 AND id=$2", [user.id, jobRow.rows[0].id]);
    const job = await learning.jobs.get(user.id, jobRow.rows[0].id);
    const applied = await app.learningWorker.consolidation.run({ job });
    assert.equal(applied.disposition, "applied");
    assert.equal(applied.verification, "unmeasured");
    const bind = await fetch(`${base}/api/research-sessions/next-session`, { method: "PUT", headers,
      body: JSON.stringify({ mode: "specialist", agentId: selected.id, agentVersion: selected.version }) });
    assert.equal(bind.status, 200);
    app.memorySubstrate.recall = async () => [];
    await app.runtimeManager.start(project);
    let prompt;
    app.runtimeManager.dispatchPrompt = async (_project, _session, input) => { prompt = input; return { accepted: true }; };
    const response = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ sessionId: "next-session", dispatchId: "next-dispatch", text: "Analyze the supplied data and preserve its denominators." }) });
    assert.equal(response.status, 202, await response.text());
    const run = (await app.agentRuns.list(project)).find((item) => item.dispatchId === "next-dispatch");
    assert.equal(run.capabilityHandbooks.length, 1);
    assert.equal(run.capabilityHandbooks[0].contentDigest, candidate.payload.contentDigest);
    assert.match(prompt.system, /Keep denominators tied/);
    assert.match(await readFile(path.join(project.workspaceDir, run.capabilityHandbooks[0].path), "utf8"), /## Workflow/);
    await app.learningWorker.maintain();
    assert.equal((await learning.documents.get(user.id, "method", applied.handbookId)).payload.verification, "unmeasured");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await database.drop();
  }
});
