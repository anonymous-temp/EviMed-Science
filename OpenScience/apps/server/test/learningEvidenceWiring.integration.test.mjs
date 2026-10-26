// The doors a person's reaction to a run comes in by, on the real application (2026-10-25): a message that reaches a conversation through the control
// plane's own dispatch (the page's dispatch route, a messaging channel's question) is read like a turn adopted from the kernel page, and a delivered file
// the owner opens through the files routes is a use of its run. What each door does with the evidence is `learningEvidence.test.mjs`'s; what only the
// composition answers is that the doors are connected, attended turns only, once, and never in front of the answer.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { noProfile } from "./helpers/residentProfileDouble.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";

/** @param {() => boolean} done @param {number} [ms] */
async function until(done, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return done();
}

test("the dispatch route and a channel's question read the person's message once, attended turns only; the files routes note a delivered file's use", { skip: !databaseUrl, timeout: 60_000 }, async () => {
  const database = await createGeoTestDatabase(databaseUrl, "evwire");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "evimed-evidence-wiring-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl: database.url,
    learningEnabled: true, learningWindow: "", evimedWorkloadSigningSecret: randomBytes(32).toString("hex"), modelGatewaySigningSecret: randomBytes(32).toString("hex"),
    memorySettings: { configured: false, async status() { return { configured: false }; } } });
  try {
    const address = await app.listen(0, "127.0.0.1");
    await app.learningWorker.close();
    const user = await app.store.createUser("evidence-owner", "test-password", "Evidence owner");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "evidence-owner", password: "test-password" }) });
    assert.equal(login.status, 200);
    const auth = await login.json();
    const headers = { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
    const agents = (await (await fetch(`${base}/api/agents`, { headers })).json()).data;
    const selected = agents.find((agent) => agent.id === "statistical-analysis");
    assert.ok(selected);
    for (const session of ["ses_page", "ses_page_auto", "ses_channel"]) await app.researchSessions.put(project, session, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
    app.residentProfiles.forDispatch = noProfile;
    await app.runtimeManager.start(project);
    app.runtimeManager.dispatchPrompt = async () => ({ accepted: true });

    const evidence = app.learningWorker.evidence;
    /** @type {any[]} */ const read = [];
    /** @type {any[]} */ const opened = [];
    evidence.onNewTurn = async (_project, turn) => { read.push(turn); return { recorded: false, reason: "stubbed" }; };
    evidence.noteFileUse = async (_project, file) => { opened.push(file.path); return { recorded: false, reason: "stubbed" }; };

    // The page's own dispatch: read once, with the dispatch named, beside the dispatch and never in front of it.
    const dispatch = (body) => fetch(`${base}/api/agent-runs/dispatch`, { method: "POST", headers, body: JSON.stringify(body) });
    const first = await dispatch({ sessionId: "ses_page", dispatchId: "dsp_page_1", text: "以后周报都按这个来" });
    assert.equal(first.status, 202, await first.text());
    assert.ok(await until(() => read.length === 1), "the message was read");
    assert.deepEqual(read[0], { sessionId: "ses_page", text: "以后周报都按这个来", requestId: "dsp_page_1", dispatchId: "dsp_page_1" });
    // A replay of the same dispatch is the run that exists: not read again.
    const replay = await dispatch({ sessionId: "ses_page", dispatchId: "dsp_page_1", text: "以后周报都按这个来" });
    assert.equal(replay.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(read.length, 1, "a replay is not a second reaction");
    // A harness's dispatch is no person's reply.
    const automated = await dispatch({ sessionId: "ses_page_auto", dispatchId: "dsp_auto_1", text: "再测一次", automated: true });
    assert.equal(automated.status, 202, await automated.text());
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(read.length, 1, "an automated dispatch is never read");

    // A question that arrived through a messaging channel is a person's, and is read through the same door; a module's own dispatch is not.
    const owner = await app.store.userById(user.id);
    await app.im.service.dispatchRun({ user: owner, project, sessionId: "ses_channel", dispatchId: "im-event-1", text: "把刚才的做法存下来" });
    assert.ok(await until(() => read.length === 2), "the channel's question was read");
    assert.deepEqual(read[1], { sessionId: "ses_channel", text: "把刚才的做法存下来", requestId: "im-event-1", dispatchId: "im-event-1" });

    // A delivered file opened through the files routes: preview and download of the workspace; not the base directory, not a refused or missing file.
    await mkdir(path.join(project.workspaceDir, "report"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, "report", "weekly.md"), "# weekly\n");
    await mkdir(path.join(project.baseDir, "report"), { recursive: true });
    await writeFile(path.join(project.baseDir, "report", "base.md"), "# base\n");
    assert.equal((await fetch(`${base}/api/files/preview/report/weekly.md`, { headers })).status, 200);
    assert.ok(await until(() => opened.length === 1));
    assert.equal((await fetch(`${base}/api/files/download/report/weekly.md`, { headers })).status, 200);
    assert.ok(await until(() => opened.length === 2));
    assert.deepEqual(opened, ["report/weekly.md", "report/weekly.md"]);
    assert.equal((await fetch(`${base}/api/files/preview/report/base.md?root=base`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/files/preview/report/missing.md`, { headers })).status, 404);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(opened.length, 2, "the base directory holds no run's deliveries and a missing file was not opened");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await database.drop();
  }
});
