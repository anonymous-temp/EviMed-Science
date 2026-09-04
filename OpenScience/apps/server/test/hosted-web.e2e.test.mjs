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

/**
 * Reads the first frame of the control plane's own run stream.
 *
 * It reads our stream rather than a kernel's, because a browser cannot reach a
 * kernel any more. What it proves is unchanged and is the part that only fails
 * in a real deployment: an SSE response survives whatever proxy is in front of
 * it.
 */
async function readFirstSseEvent(base, runId, headers) {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, { headers, signal: abort.signal });
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

// The run monitor polls on its own interval and the delivery gate runs after
// it, so a terminal state is a few polls away rather than immediate. Waiting
// two seconds was enough while the kernel finished its work inside the prompt
// call; it does not any more, and a wait tuned to the old timing reads as a
// hang rather than as a slow test.
async function waitForRun(base, runId, headers) {
  const deadlineMs = Number(process.env.OPEN_SCIENCE_E2E_RUN_TIMEOUT_MS ?? 30_000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const listed = await jsonFetch(`${base}/api/agent-runs`, { headers });
    const run = listed.json.data.find((item) => item.id === runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent run ${runId} did not reach a terminal state within ${deadlineMs}ms.`);
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
    // The control plane's own surface. A caller that is handed anything naming a
    // kernel is a caller that can reach one.
    assert.match(runtime.json.data, /\/api\/runtime$/);
    assert.ok(!/opencode|dsh/.test(runtime.json.data));

    const session = await jsonFetch(`${runtime.json.data}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    assert.match(session.json.data.id, /^web_mock_/);

    const specialistBinding = await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(session.json.data.id)}`, {
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
        sessionId: session.json.data.id,
        dispatchId: "turn_specialist_first",
        text: "Create a short analysis artifact.",
      }),
    });
    assert.equal(firstRun.res.status, 202);
    assert.equal(firstRun.json.data.agentId, "adr-analysis");
    assert.equal(firstRun.json.data.agentVersion, adrAgent.version);

    // One session runs one turn at a time. The kernel accepts a prompt and then
    // works, so a second dispatch has to wait for the first to settle — which is
    // also what a client does.
    const firstTerminal = await waitForRun(base, firstRun.json.data.id, scoped);
    const secondRun = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId: session.json.data.id,
        dispatchId: "turn_specialist_follow_up",
        text: "Now explain the strongest signal.",
      }),
    });
    assert.equal(secondRun.res.status, 202);
    const secondTerminal = await waitForRun(base, secondRun.json.data.id, scoped);
    assert.equal(firstTerminal.status, "failed");
    assert.equal(firstTerminal.errorCode, "specialist_required_output_missing");
    assert.equal(secondTerminal.status, "failed");
    assert.equal(secondTerminal.errorCode, "specialist_required_output_missing");

    // Specialty identity is pinned in the ledger, not in a per-turn field on a
    // kernel message. There is one composition now, so a message carries no
    // agent name to pin — what identifies the work is which capability the run
    // was dispatched as, which is a control-plane fact and always was.
    assert.deepEqual(
      [firstTerminal.effectiveRuntimeAgent, secondTerminal.effectiveRuntimeAgent],
      ["evimed-adr-analysis", "evimed-adr-analysis"],
    );

    const openSession = await jsonFetch(`${runtime.json.data}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: "{}",
    });
    await jsonFetch(`${base}/api/research-sessions/${encodeURIComponent(openSession.json.data.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({ mode: "open-domain" }),
    });
    const openRun = await jsonFetch(`${base}/api/agent-runs/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scoped },
      body: JSON.stringify({
        sessionId: openSession.json.data.id,
        dispatchId: "turn_open_domain",
        text: "Explore an unconstrained research question.",
      }),
    });
    assert.equal(openRun.res.status, 202);
    // The live stream is ours, and a tab that attaches to a finished run still
    // gets its state rather than an empty stream that never speaks again.
    const streamed = await readFirstSseEvent(base, openRun.json.data.id, scoped);
    assert.match(streamed, /run\/state/);
    assert.equal((await waitForRun(base, openRun.json.data.id, scoped)).status, "succeeded");
    // The transcript is read through the control plane, in the control plane's
    // vocabulary; the identity of the line the run was dispatched on is a ledger
    // fact, because there is one composition and a message names no agent.
    const openTranscript = await jsonFetch(
      `${base}/api/runtime/sessions/${encodeURIComponent(openSession.json.data.id)}/transcript`,
      { headers: scoped },
    );
    assert.ok(openTranscript.json.data.messages.some((message) => message.role === "user"));
    const openLedgerRun = (await jsonFetch(`${base}/api/agent-runs`, { headers: scoped }))
      .json.data.find((run) => run.id === openRun.json.data.id);
    assert.equal(openLedgerRun.effectiveRuntimeAgent, "evimed-open-domain-answer");
    const runs = await jsonFetch(`${base}/api/agent-runs`, { headers: scoped });
    // Counted by what dispatched them rather than by total. A session the
    // kernel already had -- which is what the runtime's own browser application
    // leaves behind -- is adopted into the ledger, so the total is whatever the
    // runtime happened to be carrying and says nothing. What this test is about
    // is the three runs the control plane dispatched.
    const dispatched = runs.json.data.filter((run) => run.effectiveRouteReason !== "adopted:runtime-ui");
    const adoptedRuns = runs.json.data.filter((run) => run.effectiveRouteReason === "adopted:runtime-ui");
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched.filter((run) => run.mode === "specialist").length, 2);
    assert.equal(dispatched.filter((run) => run.mode === "open-domain").length, 1);
    // An adopted run declares no deliverable contract, so no layer of the gate
    // ran on it. It has to say so, or ungated work reads as work that passed.
    assert.ok(adoptedRuns.every((run) => run.verification === "unchecked"), "an adopted run must not read as gated");
    assert.ok(adoptedRuns.every((run) => run.mode === "open-domain" && run.effectiveRuntimeAgent === null));
    assert.equal(dispatched.filter((run) => run.mode === "specialist").every((run) => run.status === "failed"), true);
    assert.equal(dispatched.find((run) => run.mode === "open-domain").status, "succeeded");

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
