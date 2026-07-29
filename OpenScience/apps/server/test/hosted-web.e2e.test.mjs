import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

async function withHostedApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-web-e2e-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "mock",
    devAuth: false,
    bootstrapUser: "alice",
    bootstrapPassword: "correct horse battery staple",
    maxProjectBytes: 1024 * 1024,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ base });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function jsonFetch(url, options = {}, expectOk = true) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  if (expectOk && !res.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  }
  return { res, json };
}

async function command(base, name, args, headers, expectOk = true) {
  return jsonFetch(
    `${base}/api/commands/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(args ?? {}),
    },
    expectOk,
  );
}

async function readFirstSseEvent(url, headers) {
  const abort = new AbortController();
  const res = await fetch(`${url}/event`, { headers, signal: abort.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    return new TextDecoder().decode(value);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
}

async function waitForRun(base, runId, headers) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const listed = await jsonFetch(`${base}/api/agent-runs`, { headers });
    const run = listed.json.data.find((item) => item.id === runId);
    if (run?.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Agent run ${runId} did not reach a terminal state.`);
}

test("mock hosted contract pins specialty identity but cannot certify specialist completion", async () => {
  await withHostedApp(async ({ base }) => {
    const anonymous = await fetch(`${base}/api/me`);
    assert.equal(anonymous.status, 401);

    const login = await jsonFetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "correct horse battery staple",
      }),
    });
    const cookie = login.res.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie.startsWith("os_session="));
    const csrfToken = login.json.data.csrfToken;
    assert.match(csrfToken, /^csrf_/);

    const auth = { Cookie: cookie, "X-Open-Science-CSRF": csrfToken };
    const project = await jsonFetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ id: "paper1", name: "Paper 1" }),
    });
    assert.deepEqual(project.json.data, { id: "paper1", name: "Paper 1" });
    const scoped = { ...auth, "X-Open-Science-Project": "paper1" };
    const agents = await jsonFetch(`${base}/api/agents`, { headers: scoped });
    const adrAgent = agents.json.data.find((agent) => agent.id === "adr-analysis");
    assert.equal(adrAgent.runtimeAgent, "evimed-adr-analysis");

    const upload = await jsonFetch(`${base}/api/files/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        filename: "input.txt",
        encoding: "base64",
        data: Buffer.from("uploaded data").toString("base64"),
      }),
    });
    assert.equal(upload.json.data.path, "input.txt");

    const uploaded = await command(base, "read_artifact", { path: "input.txt" }, scoped);
    assert.equal(uploaded.json.data.encoding, "utf8");
    assert.equal(uploaded.json.data.data, "uploaded data");

    const runtime = await command(base, "start_runtime", {}, scoped);
    assert.match(runtime.json.data, /\/api\/opencode\/paper1$/);

    const sse = await readFirstSseEvent(runtime.json.data, scoped);
    assert.match(sse, /server\.connected/);

    const session = await jsonFetch(`${runtime.json.data}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    assert.match(session.json.id, /^web_mock_/);

    const specialistBinding = await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(session.json.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        mode: "specialist",
        agentId: adrAgent.id,
        agentVersion: adrAgent.version,
      }),
    });
    assert.equal(specialistBinding.json.data.runtimeAgent, "evimed-adr-analysis");

    const firstRun = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId: session.json.id,
        dispatchId: "turn_specialist_first",
        text: "Create a short analysis artifact.",
      }),
    });
    assert.equal(firstRun.res.status, 202);
    assert.equal(firstRun.json.data.agentId, "adr-analysis");
    assert.equal(firstRun.json.data.agentVersion, adrAgent.version);

    const secondRun = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId: session.json.id,
        dispatchId: "turn_specialist_follow_up",
        text: "Now explain the strongest signal.",
      }),
    });
    assert.equal(secondRun.res.status, 202);
    const firstTerminal = await waitForRun(base, firstRun.json.data.id, scoped);
    const secondTerminal = await waitForRun(base, secondRun.json.data.id, scoped);
    assert.equal(firstTerminal.status, "failed");
    assert.equal(firstTerminal.errorCode, "specialist_required_output_missing");
    assert.equal(secondTerminal.status, "failed");
    assert.equal(secondTerminal.errorCode, "specialist_required_output_missing");
    const specialistMessages = await jsonFetch(
      `${runtime.json.data}/session/${encodeURIComponent(session.json.id)}/message`,
      { headers: scoped },
    );
    assert.deepEqual(
      specialistMessages.json.filter((message) => message.info.role === "user").map((message) => message.info.agent),
      ["evimed-adr-analysis", "evimed-adr-analysis"],
    );

    const openSession = await jsonFetch(`${runtime.json.data}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(openSession.json.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({ mode: "open-domain" }),
    });
    const openRun = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId: openSession.json.id,
        dispatchId: "turn_open_domain",
        text: "Explore an unconstrained research question.",
      }),
    });
    assert.equal(openRun.res.status, 202);
    assert.equal((await waitForRun(base, openRun.json.data.id, scoped)).status, "succeeded");
    const openMessages = await jsonFetch(
      `${runtime.json.data}/session/${encodeURIComponent(openSession.json.id)}/message`,
      { headers: scoped },
    );
    assert.equal(openMessages.json.find((message) => message.info.role === "user").info.agent, "evimed-open-domain-answer");
    const runs = await jsonFetch(`${base}/api/agent-runs`, { headers: scoped });
    assert.equal(runs.json.data.length, 3);
    assert.equal(runs.json.data.filter((run) => run.mode === "specialist").length, 2);
    assert.equal(runs.json.data.filter((run) => run.mode === "open-domain").length, 1);
    assert.equal(runs.json.data.filter((run) => run.mode === "specialist").every((run) => run.status === "failed"), true);
    assert.equal(runs.json.data.find((run) => run.mode === "open-domain").status, "succeeded");

    const artifact = await command(base, "read_artifact", { path: "mock-agent-artifact.md" }, scoped);
    assert.equal(artifact.json.data.encoding, "utf8");
    assert.match(artifact.json.data.data, /Generated by the hosted mock runtime/);

    const preview = await command(base, "preview_url", { path: "mock-agent-artifact.md" }, scoped);
    const previewed = await fetch(preview.json.data, { headers: auth });
    assert.equal(previewed.status, 200);
    assert.match(await previewed.text(), /Mock agent artifact/);

    const runtimeLogs = await jsonFetch(`${base}/api/logs/runtime?limit=20`, { headers: scoped });
    assert.ok(runtimeLogs.json.data.some((row) => row.event === "started" && row.kind === "mock"));
  });
});
