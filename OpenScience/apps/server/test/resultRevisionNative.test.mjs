import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.mjs";
import { InMemoryStore } from "../src/store.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";
import { createRuntimeUiServer } from "../src/runtimeUiServer.mjs";
import { issueRuntimeUiFrame } from "../src/runtimeUiFrames.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { createResultReuseRoutes } from "../src/resultReuseRoutes.mjs";
import { HttpError } from "../src/security.mjs";

const UI_ORIGIN = "https://science.example:8443";
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-native-revision-"));
  const config = loadConfig({ dataDir, devAuth: true, runtimeMode: "mock", runtimeUiProxyEnabled: true,
    publicUrl: "https://science.example", runtimeUiPublicOrigin: UI_ORIGIN });
  const store = new InMemoryStore(config); const user = await store.devUser();
  let loginCookie;
  const session = await store.createSession(user, { headers: {}, socket: {} }, {
    getHeader() {}, setHeader(_name, value) { loginCookie = String(value).split(";")[0]; },
  });
  config.devAuth = false; // Exercise ordinary authenticated CSRF behavior.
  const project = await store.requireProject(user, "default");
  await mkdir(project.workspaceDir, { recursive: true }); await mkdir(project.metaDir, { recursive: true });
  const frame = issueRuntimeUiFrame({ config, req: { headers: { cookie: loginCookie } }, user, session, project });
  const cookie = `${loginCookie}; ${frame.cookie.split(";")[0]}`;
  const records = new Map(); let revoked = false;
  const documents = {
    async get(owner, kind, id) { return structuredClone(records.get(JSON.stringify([owner, kind, id])) ?? null); },
    async put(owner, kind, id, payload, options) {
      const key = JSON.stringify([owner, kind, id]); const prior = records.get(key);
      if ((prior?.revision ?? 0) !== options.expectedRevision) throw new HttpError(409, "product_revision_conflict", "changed");
      const row = { id, projectId: options.projectId, revision: (prior?.revision ?? 0) + 1, payload: structuredClone(payload) };
      records.set(key, row); return structuredClone(row);
    },
  };
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => {
      if (revoked || actor !== user.id) throw new HttpError(403, "result_project_forbidden", "Result access revoked.");
      return store.requireProject(user, id);
    },
  });
  const revisions = new ResultRevisionService({ results, documents, config });
  const capture = async (filename, content, mimeType) => {
    await writeFile(path.join(project.workspaceDir, filename), content);
    const captured = await results.captureFile({ userId: user.id, project, relativePath: filename,
      producer: { kind: "deliverable", runId: "run", sessionId: "session" }, expectedDigest: sha(content) });
    return mimeType ? { ...captured, mimeType } : captured;
  };
  const received = []; const peers = new Set(); const upstream = createServer(); const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", peer => {
    peers.add(peer); peer.on("close", () => peers.delete(peer));
    peer.on("message", raw => {
      const value = JSON.parse(raw.toString()); received.push(value);
      if (value.type === "open") peer.send(JSON.stringify({ type: "item", streamId: value.streamId, value: { accepted: true } }));
    });
  });
  const socketPath = path.join(dataDir, "native.sock"); await new Promise(resolve => upstream.listen(socketPath, resolve));
  const manager = new RuntimeManager(config);
  manager.start = async () => ({ url: "http://kernel.local", socketPath, cookie: "kernel_auth=fixture" });
  manager.proxy = async (req, res) => {
    received.push(JSON.parse(req.__openScienceProxyBody.toString())); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  };
  const ui = createRuntimeUiServer({ config, store, runtimeManager: manager,
    bindResultRevision: (actor, current, request) => revisions.bind(actor.id, current, request) });
  const address = await ui.listen(0, "127.0.0.1"); const origin = `http://127.0.0.1:${address.port}`;
  const reuseRoutes = createResultReuseRoutes({ store, revisions, exporter: null });
  const shell = createServer(async (req, res) => {
    try { if (!await reuseRoutes(req, res)) { res.writeHead(404); res.end(); } }
    catch (error) { res.writeHead(error.status ?? 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: error.code, error: error.message })); }
  });
  await new Promise(resolve => shell.listen(0, "127.0.0.1", resolve));
  const shellBase = `http://127.0.0.1:${shell.address().port}`;
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.terminate(); for (const peer of peers) peer.terminate();
    await ui.close(); await new Promise(resolve => shell.close(resolve));
    wss.close(); await new Promise(resolve => upstream.close(resolve)); await rm(dataDir, { recursive: true, force: true });
  });
  const stage = async (version, selectedText, kind = "text", override = {}) => {
    const response = await fetch(`${shellBase}/api/results/${version.versionId}/revisions`, { method: "POST",
      headers: { cookie: loginCookie, "Content-Type": "application/json", "x-open-science-csrf": session.csrfToken },
      body: JSON.stringify({ projectId: project.id, digest: version.digest, requestId: `stage-${Math.random().toString().slice(2)}`, sessionId: "session",
        anchor: { kind, elementId: `${kind}-1`, selectedText, ...override } }) });
    return { response, body: await response.json() };
  };
  const prompt = (reference, instruction = "Clarify the supported conclusion.", requestId = "prompt") => ({ sessionId: "session", requestId,
    content: [{ type: "text", text: `${reference.draft}${instruction}` }], evimedResultRevision: { referenceId: reference.referenceId } });
  const sendHttp = async request => fetch(`${origin}${frame.prefix}api/session/prompt`, { method: "POST",
    headers: { cookie, origin: UI_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", method: "session/prompt", payload: { args: { request } } }) });
  const connect = async () => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}${frame.prefix}api/remote.mux`, { headers: { cookie, origin: UI_ORIGIN } }); clients.add(ws);
    const messages = []; const waits = [];
    ws.on("message", raw => { const value = JSON.parse(raw.toString()); const waiter = waits.shift(); if (waiter) waiter(value); else messages.push(value); });
    await once(ws, "open");
    return { send(value) { ws.send(JSON.stringify(value)); }, next() { return messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waits.push(resolve)); } };
  };
  return { user, project, store, results, revisions, capture, received, stage, prompt, sendHttp, connect, shellBase, loginCookie, revoke() { revoked = true; } };
}

for (const wire of ["http", "mux"]) {
  test(`native ${wire} forwards the frozen selected version and strips the revision envelope`, { timeout: 10000 }, async t => {
    const f = await fixture(t); const selected = await f.capture("report.md", "Original supported finding.");
    const staged = await f.stage(selected, "Original supported finding."); assert.equal(staged.response.status, 201);
    const reference = staged.body.data;
    await writeFile(path.join(f.project.workspaceDir, "report.md"), "Later changed report.");
    const request = f.prompt(reference);
    if (wire === "http") assert.equal((await f.sendHttp(request)).status, 200);
    else { const client = await f.connect(); client.send({ type: "open", streamId: "revision", endpoint: "session/prompt", payload: { args: { request } } }); assert.equal((await client.next()).type, "item"); }
    const forwarded = f.received[0].payload.args.request;
    assert.equal(forwarded.evimedResultRevision, undefined);
    assert.equal(forwarded.content.length, 2);
    const context = JSON.parse(/<evimed_result_selection>\n([\s\S]*?)\n<\/evimed_result_selection>/.exec(forwarded.content[1].text)[1]);
    assert.equal(context.versionId, selected.versionId); assert.equal(context.digest, selected.digest);
    assert.equal(await readFile(path.join(f.project.workspaceDir, context.inputPath), "utf8"), "Original supported finding.");
    assert.equal(await readFile(path.join(f.project.workspaceDir, "report.md"), "utf8"), "Later changed report.");
  });
  test(`native ${wire} refuses a replaced draft, revoked access and repeated reference with a different request`, { timeout: 10000 }, async t => {
    const f = await fixture(t); const selected = await f.capture("report.md", "Original finding.");
    const reference = (await f.stage(selected, "Original finding.")).body.data;
    const send = async (request, id) => {
      if (wire === "http") return (await f.sendHttp(request)).status;
      const client = await f.connect(); client.send({ type: "open", streamId: id, endpoint: "session/prompt", payload: { args: { request } } });
      return (await client.next()).type;
    };
    const replaced = f.prompt(reference); replaced.content[0].text = "Different subject.";
    assert.equal(await send(replaced, "replaced"), wire === "http" ? 409 : "error"); assert.equal(f.received.length, 0);
    assert.equal(await send(f.prompt(reference), "accepted"), wire === "http" ? 200 : "item");
    assert.equal(await send(f.prompt(reference, "Clarify the supported conclusion.", "other-request"), "reused"), wire === "http" ? 409 : "error"); assert.equal(f.received.length, 1);
    f.revoke(); assert.equal(await send(f.prompt(reference), "revoked"), wire === "http" ? 403 : "error"); assert.equal(f.received.length, 1);
  });
}

test("staging requires authenticated project access and CSRF, with bounded table/figure targets", { timeout: 10000 }, async t => {
  const f = await fixture(t); const selected = await f.capture("report.md", "| Study | Effect |\n| --- | --- |\n| A | 0.8 |\n");
  const input = { projectId: f.project.id, digest: selected.digest, requestId: "stage-one", sessionId: "session", anchor: { kind: "table-cell", elementId: "td-1", selectedText: "0.8", row: 2, column: 1 } };
  const post = headers => fetch(`${f.shellBase}/api/results/${selected.versionId}/revisions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input) });
  assert.equal((await post({})).status, 401); assert.equal((await post({ cookie: f.loginCookie })).status, 403);
  const cell = await f.stage(selected, "0.8", "table-cell", { row: 2, column: 1 }); assert.equal(cell.response.status, 201);
  assert.equal((await f.stage(selected, "0.8", "table-cell", { row: -1, column: 1 })).response.status, 400);
  assert.equal((await f.stage(selected, "missing", "text")).response.status, 409);
  assert.equal((await f.stage(selected, "region", "pdf-region", { page: 1 })).response.status, 400);
});

test("rendered paragraph/cell hints and a figure retain their exact source version without claiming quote verification", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const paragraph = await f.capture("report.md", "The **supported conclusion** follows [the source](https://example.test).");
  const rendered = await f.stage(paragraph, "The supported conclusion follows the source.", "rendered-element", { elementKind: "text" });
  assert.equal(rendered.response.status, 201);
  const request = f.prompt(rendered.body.data, "State the limitation clearly.");
  assert.equal((await f.sendHttp(request)).status, 200);
  assert.match(f.received[0].payload.args.request.content[1].text, /rendered_selection_unverified/);
  const figure = await f.capture("forest.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8\/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
  const image = await f.stage(figure, "forest.png", "figure"); assert.equal(image.response.status, 201);
  assert.equal((await f.stage(figure, "some-other-figure.png", "figure")).response.status, 400);
});
