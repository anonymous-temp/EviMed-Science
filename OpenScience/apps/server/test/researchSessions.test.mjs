import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";

async function withApp(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-research-sessions-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ app, base, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function putBinding(base, sessionId, body, projectId = "default") {
  return fetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Open-Science-Project": projectId,
    },
    body: JSON.stringify(body),
  });
}

async function listBindings(base, projectId = "default") {
  const response = await fetch(`${base}/api/research-sessions`, {
    headers: { "X-Open-Science-Project": projectId },
  });
  return { response, body: await response.json() };
}

test("persists specialist identity derived from the current registry", async () => {
  await withApp(async ({ base, dataDir }) => {
    const response = await putBinding(base, "ses_adr", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.1",
    });
    assert.equal(response.status, 200);
    const binding = (await response.json()).data;
    assert.deepEqual(
      {
        sessionId: binding.sessionId,
        mode: binding.mode,
        agentId: binding.agentId,
        agentVersion: binding.agentVersion,
        runtimeAgent: binding.runtimeAgent,
      },
      {
        sessionId: "ses_adr",
        mode: "specialist",
        agentId: "adr-analysis",
        agentVersion: "1.2.1",
        runtimeAgent: "evimed-adr-analysis",
      },
    );
    assert.match(binding.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(binding.updatedAt, binding.createdAt);

    const stored = JSON.parse(
      await readFile(
        path.join(dataDir, "users", "dev", "projects", "default", ".openscience", "research-sessions.json"),
        "utf8",
      ),
    );
    assert.deepEqual(stored.sessions, [binding]);

    const listed = await listBindings(base);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.data, [binding]);
  });
});

test("persists open-domain sessions without an agent pin", async () => {
  await withApp(async ({ base }) => {
    const response = await putBinding(base, "ses_open", { mode: "open-domain" });
    assert.equal(response.status, 200);
    const binding = (await response.json()).data;
    assert.deepEqual(
      {
        sessionId: binding.sessionId,
        mode: binding.mode,
        agentId: binding.agentId,
        agentVersion: binding.agentVersion,
        runtimeAgent: binding.runtimeAgent,
      },
      {
        sessionId: "ses_open",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
      },
    );
  });
});

test("treats an exact binding PUT as idempotent but rejects every identity change", async () => {
  await withApp(async ({ base, dataDir }) => {
    const originalResponse = await putBinding(base, "ses_immutable", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.1",
    });
    assert.equal(originalResponse.status, 200);
    const original = (await originalResponse.json()).data;

    const repeatedResponse = await putBinding(base, "ses_immutable", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.1",
    });
    assert.equal(repeatedResponse.status, 200);
    const repeated = (await repeatedResponse.json()).data;
    assert.equal(repeated.createdAt, original.createdAt);
    assert.equal(repeated.runtimeAgent, original.runtimeAgent);

    const stateFile = path.join(
      dataDir,
      "users",
      "dev",
      "projects",
      "default",
      ".openscience",
      "research-sessions.json",
    );
    for (const body of [
      { mode: "open-domain" },
      { mode: "specialist", agentId: "off-label-analysis", agentVersion: "1.1.0" },
      { mode: "specialist", agentId: "adr-analysis", agentVersion: "0.9.0" },
    ]) {
      const before = await readFile(stateFile, "utf8");
      const response = await putBinding(base, "ses_immutable", body);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "research_session_identity_conflict");
      assert.equal(await readFile(stateFile, "utf8"), before);
    }
  });
});

test("rejects unknown agents, stale versions, injected runtime identities, and invalid session ids", async () => {
  await withApp(async ({ base }) => {
    const cases = [
      ["ses_unknown", { mode: "specialist", agentId: "missing-agent", agentVersion: "1.0.0" }, 404, "agent_not_found"],
      ["ses_stale", { mode: "specialist", agentId: "adr-analysis", agentVersion: "0.9.0" }, 409, "agent_version_mismatch"],
      ["ses_injected", { mode: "specialist", agentId: "adr-analysis", agentVersion: "1.2.1", runtimeAgent: "build" }, 400, "invalid_research_session"],
      ["../escape", { mode: "open-domain" }, 400, "invalid_id"],
    ];
    for (const [sessionId, body, status, code] of cases) {
      const response = await putBinding(base, sessionId, body);
      assert.equal(response.status, status);
      assert.equal((await response.json()).code, code);
    }
  });
});

test("keeps identical OpenCode session ids isolated by selected project", async () => {
  await withApp(async ({ base }) => {
    let response = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "second", name: "Second" }),
    });
    assert.equal(response.status, 200);

    response = await putBinding(base, "ses_shared", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.1",
    });
    assert.equal(response.status, 200);
    response = await putBinding(base, "ses_shared", { mode: "open-domain" }, "second");
    assert.equal(response.status, 200);

    const first = await listBindings(base);
    const second = await listBindings(base, "second");
    assert.equal(first.body.data[0].runtimeAgent, "evimed-adr-analysis");
    assert.equal(second.body.data[0].runtimeAgent, null);
  });
});

test("refuses to follow a symlinked research-session state file", async () => {
  await withApp(async ({ base, dataDir }) => {
    await listBindings(base);
    const metaDir = path.join(dataDir, "users", "dev", "projects", "default", ".openscience");
    const outside = path.join(dataDir, "outside.json");
    await writeFile(outside, JSON.stringify({ sessions: [] }), "utf8");
    await symlink(outside, path.join(metaDir, "research-sessions.json"));

    const response = await putBinding(base, "ses_link", { mode: "open-domain" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "path_forbidden");
  });
});

test("enforces a bounded project record count without mutating full state", async () => {
  await withApp(async ({ base, dataDir }) => {
    await listBindings(base);
    const stateFile = path.join(
      dataDir,
      "users",
      "dev",
      "projects",
      "default",
      ".openscience",
      "research-sessions.json",
    );
    const timestamp = "2026-07-16T00:00:00.000Z";
    const sessions = Array.from({ length: 1000 }, (_, index) => ({
      sessionId: `ses_${String(index).padStart(4, "0")}`,
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    await writeFile(stateFile, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, "utf8");
    const before = await readFile(stateFile, "utf8");

    const response = await putBinding(base, "ses_over_limit", { mode: "open-domain" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "research_session_limit_reached");
    assert.equal(await readFile(stateFile, "utf8"), before);

    const existing = await putBinding(base, "ses_0000", { mode: "open-domain" });
    assert.equal(existing.status, 200);
  });
});

test("rejects oversized and corrupt state before unbounded parsing", async () => {
  await withApp(async ({ base, dataDir }) => {
    await listBindings(base);
    const stateFile = path.join(
      dataDir,
      "users",
      "dev",
      "projects",
      "default",
      ".openscience",
      "research-sessions.json",
    );

    await writeFile(stateFile, "x".repeat(1024 * 1024 + 1), "utf8");
    let listed = await listBindings(base);
    assert.equal(listed.response.status, 413);
    assert.equal(listed.body.code, "research_sessions_too_large");

    await writeFile(stateFile, "{", "utf8");
    listed = await listBindings(base);
    assert.equal(listed.response.status, 500);
    assert.equal(listed.body.code, "research_sessions_corrupt");
  });
});
