// What 循证进化 does to an ordinary prompt, with the module on: nothing. A published tool reaches a conversation
// through the runtime's own catalogue; no word in the question routes to it, the tool list is not read on the way
// to a dispatch, and no tool card is added to the memory file the root conversation never receives.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
test("an unrouted prompt that names an installed tool is routed by the classifier alone and never reads the tool list", { skip: !databaseUrl }, async () => {
  const database = await createGeoTestDatabase(databaseUrl, "evoprompt");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-evolution-prompt-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: database.url,
    evolutionEnabled: true, operatorUsers: "evolution-operator", evimedWorkloadSigningSecret: randomBytes(32).toString("hex"),
    researchMemory: { configured: false, async status() { return { configured: false }; } } });
  try {
    assert.ok(app.evolution, "the module is composed");
    const address = await app.listen(0, "127.0.0.1");
    const user = await app.store.createUser("evolution-researcher", "test-password", "Researcher");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "evolution-researcher", password: "test-password" }) });
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    let toolListReads = 0;
    app.evolution.service.tools = async () => { toolListReads += 1; throw new Error("the tool list is not part of a prompt"); };
    app.memorySubstrate.recall = async () => [];
    await app.runtimeManager.start(project);
    const sent = [];
    app.runtimeManager.dispatchPrompt = async (_project, _session, input) => { sent.push(input); return { accepted: true }; };
    const bound = await fetch(`${base}/api/research-sessions/ordinary-session`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) });
    assert.equal(bound.status, 200);
    const response = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ sessionId: "ordinary-session", dispatchId: "ordinary-dispatch", text: "使用 tool-cohort 算一下这组数据的净获益" }) });
    assert.equal(response.status, 202, await response.text());
    const run = (await app.agentRuns.list(project)).find((item) => item.dispatchId === "ordinary-dispatch");
    assert.equal(toolListReads, 0);
    assert.ok(!String(run.effectiveRouteReason).startsWith("installed-tool:"));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(String(sent[0].memoryContext ?? ""), /Platform tools explicitly requested/);
    // The same words with a tool list that reads fine: the id and the verb still decide nothing.
    app.evolution.service.tools = async () => { toolListReads += 1; return [{ id: "tool-cohort", payload: { status: "active", validationLevel: "V2", toolKind: "calculation", capabilityIds: ["statistical-analysis"] } }]; };
    await fetch(`${base}/api/research-sessions/second-session`, { method: "PUT", headers, body: JSON.stringify({ mode: "open-domain" }) });
    const second = await fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ sessionId: "second-session", dispatchId: "second-dispatch", text: "Use tool-cohort on this data" }) });
    assert.equal(second.status, 202, await second.text());
    const next = (await app.agentRuns.list(project)).find((item) => item.dispatchId === "second-dispatch");
    assert.equal(toolListReads, 0);
    assert.ok(!String(next.effectiveRouteReason).startsWith("installed-tool:"));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await database.drop();
  }
});
