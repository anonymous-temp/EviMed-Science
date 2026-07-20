import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { AgentRunStore } from "../src/agentRuns.mjs";

async function withApp(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-agent-runs-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: true, ...overrides });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ base, dataDir });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("real OpenCode dispatch fails explicitly when the managed DeepSeek provider is disabled", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-agent-runs-provider-disabled-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "opencode",
    deepseekProviderEnabled: false,
    devAuth: true,
  });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await bind(base, "ses_provider_missing", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_provider_missing");
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "model_provider_not_configured");
    assert.match(result.body.error, /DeepSeek V4 Pro/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const projectHeaders = (projectId = "default", json = false) => ({
  "X-Open-Science-Project": projectId,
  ...(json ? { "Content-Type": "application/json" } : {}),
});

async function bind(base, sessionId, body, projectId = "default") {
  return fetch(`${base}/api/research-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: projectHeaders(projectId, true),
    body: JSON.stringify(body),
  });
}

async function startRun(base, sessionId, projectId = "default", extra = {}) {
  const response = await fetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST",
    headers: projectHeaders(projectId, true),
    body: JSON.stringify({
      sessionId,
      dispatchId: `turn_${sessionId}_${Math.random().toString(16).slice(2, 10)}`,
      text: "research this question",
      ...extra,
    }),
  });
  return { response, body: await response.json() };
}

async function finishRun(base, runId, body, projectId = "default", method = "PATCH") {
  const response = await fetch(`${base}/api/agent-runs/${encodeURIComponent(runId)}`, {
    method,
    headers: projectHeaders(projectId, true),
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function listRuns(base, projectId = "default") {
  const response = await fetch(`${base}/api/agent-runs`, {
    headers: projectHeaders(projectId),
  });
  return { response, body: await response.json() };
}

async function dispatchRun(base, sessionId, dispatchId, text = "research this question", projectId = "default") {
  const response = await fetch(`${base}/api/agent-runs/dispatch`, {
    method: "POST",
    headers: projectHeaders(projectId, true),
    body: JSON.stringify({ sessionId, dispatchId, text }),
  });
  return { response, body: await response.json() };
}

test("required research memory fails dispatch closed when Memos is unavailable", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_memory_required", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_memory_required");
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "memory_required_unavailable");
    const runs = await listRuns(base);
    assert.equal(runs.body.data[0].status, "failed");
    assert.equal(runs.body.data[0].errorCode, "memory_required_unavailable");
  }, { requireMemos: true });
});

test("required research memory records a terminal failure when configured Memos goes offline", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_memory_offline", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_memory_offline");
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "memory_unavailable");
    const runs = await listRuns(base);
    assert.equal(runs.body.data[0].status, "failed");
    assert.equal(runs.body.data[0].errorCode, "memory_unavailable");
  }, {
    requireMemos: true,
    memosUrl: "http://127.0.0.1:5230",
    memosAccessToken: "test-memos-token",
    memosFetch: async () => { throw new TypeError("offline"); },
  });
});

test("starts immutable open-domain and specialist run identities from research-session bindings", async () => {
  await withApp(async ({ base, dataDir }) => {
    assert.equal((await bind(base, "ses_open", { mode: "open-domain" })).status, 200);
    assert.equal((await bind(base, "ses_adr", {
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.2",
    })).status, 200);

    const open = await startRun(base, "ses_open");
    const specialist = await startRun(base, "ses_adr");
    assert.equal(open.response.status, 202);
    assert.equal(specialist.response.status, 202);
    assert.deepEqual(
      {
        sessionId: open.body.data.sessionId,
        mode: open.body.data.mode,
        agentId: open.body.data.agentId,
        agentVersion: open.body.data.agentVersion,
        runtimeAgent: open.body.data.runtimeAgent,
        model: open.body.data.model,
        status: open.body.data.status,
      },
      {
        sessionId: "ses_open",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        model: "deepseek/deepseek-v4-pro",
        status: "running",
      },
    );
    assert.deepEqual(
      {
        sessionId: specialist.body.data.sessionId,
        agentId: specialist.body.data.agentId,
        agentVersion: specialist.body.data.agentVersion,
        runtimeAgent: specialist.body.data.runtimeAgent,
      },
      {
        sessionId: "ses_adr",
        agentId: "adr-analysis",
        agentVersion: "1.2.2",
        runtimeAgent: "evimed-adr-analysis",
      },
    );
    assert.match(open.body.data.id, /^run_[a-f0-9]{32}$/);
    assert.equal(open.body.data.createdAt, open.body.data.startedAt);
    assert.equal(open.body.data.finishedAt, null);
    assert.equal(open.body.data.durationMs, null);
    assert.equal(open.body.data.errorCode, null);
    assert.deepEqual(open.body.data.artifacts, []);

    const ledger = await readFile(
      path.join(dataDir, "users", "dev", "projects", "default", ".openscience", "runs.jsonl"),
      "utf8",
    );
    const events = ledger.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal((await stat(
      path.join(dataDir, "users", "dev", "projects", "default", ".openscience", "runs.jsonl"),
    )).mode & 0o077, 0);
    assert.deepEqual(events.map((event) => event.event), ["started", "dispatch", "started", "dispatch"]);
    assert.equal(ledger.includes("prompt"), false);
    assert.equal(ledger.includes("content"), false);
    assert.equal(ledger.includes("token"), false);
  });
});

test("canceling a runtime session records the active AgentRun as canceled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-session-abort-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_abort",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const finished = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
      onRunFinished: async (finishedProject, run) => {
        finished.push({ projectId: finishedProject.id, runId: run.id, status: run.status });
      },
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    const canceled = await store.cancelSession(project, binding.sessionId);
    assert.equal(canceled.id, started.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.errorCode, "runtime_canceled");
    assert.equal(await store.cancelSession(project, binding.sessionId), null);
    assert.deepEqual(finished, [{ projectId: "project-1", runId: started.id, status: "canceled" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a specialist turn cannot succeed without every declared required output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-required-output-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_required_output",
      mode: "specialist",
      agentId: "meta-analysis",
      agentVersion: "1.0.0",
      runtimeAgent: "evimed-meta-analysis",
    };
    let reads = 0;
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "meta-analysis",
          version: "1.0.0",
          outputs: [
            { path: "meta-analysis-report.md", required: true },
            { path: "meta-analysis-run.json", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 20,
      readSessionHistory: async () => {
        reads += 1;
        if (reads === 1) return [];
        return [{
          info: { id: "msg_meta_early", role: "assistant", time: { completed: Date.now() } },
          parts: [{ type: "text", text: "The managed job is still running." }],
        }];
      },
    });

    await store.start(project, { sessionId: binding.sessionId });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await store.list(project))[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const run = (await store.list(project))[0];
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "specialist_required_output_missing");
    assert.deepEqual(run.artifacts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects browser-forged identity/model fields and unknown research sessions", async () => {
  await withApp(async ({ base }) => {
    await bind(base, "ses_open", { mode: "open-domain" });
    for (const field of ["mode", "agentId", "agentVersion", "runtimeAgent", "model", "prompt", "tokens"]) {
      const attempt = await startRun(base, "ses_open", "default", { [field]: "forged" });
      assert.equal(attempt.response.status, 400, field);
      assert.equal(attempt.body.code, "invalid_agent_run", field);
    }
    const missing = await startRun(base, "ses_missing");
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, "research_session_not_found");
  });
});

test("rejects every browser terminal-state mutation", async () => {
  await withApp(async ({ base }) => {
    await bind(base, "ses_open", { mode: "open-domain" });
    const started = await startRun(base, "ses_open");
    const startOnly = await fetch(`${base}/api/agent-runs`, {
      method: "POST",
      headers: projectHeaders("default", true),
      body: JSON.stringify({ sessionId: "ses_open" }),
    });
    assert.equal(startOnly.status, 404);
    for (const method of ["PATCH", "PUT"]) {
      const attempt = await finishRun(base, started.body.data.id, {
        status: "succeeded",
        artifacts: ["forged.md"],
      }, "default", method);
      assert.equal(attempt.response.status, 404);
      assert.equal(attempt.body.code, "not_found");
    }
  });
});

test("enforces bounded run count and ledger bytes without partial mutation", async () => {
  await withApp(async ({ base, dataDir }) => {
    await bind(base, "ses_open", { mode: "open-domain" });
    const ledgerDir = path.join(
      dataDir,
      "users",
      "dev",
      "projects",
      "default",
      ".openscience",
    );
    const ledgerFile = path.join(ledgerDir, "runs.jsonl");
    await mkdir(ledgerDir, { recursive: true });
    const timestamp = "2026-07-16T00:00:00.000Z";
    const events = Array.from({ length: 1000 }, (_, index) => ({
      event: "started",
      id: `run_${String(index).padStart(4, "0")}`,
      sessionId: `ses_${String(index).padStart(4, "0")}`,
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
      model: "deepseek/deepseek-v4-pro",
      createdAt: timestamp,
      startedAt: timestamp,
    }));
    await writeFile(ledgerFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const before = await readFile(ledgerFile, "utf8");
    let result = await startRun(base, "ses_open");
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, "agent_run_limit_reached");
    assert.equal(await readFile(ledgerFile, "utf8"), before);

    await writeFile(ledgerFile, "x".repeat(1024 * 1024 + 1), "utf8");
    const listed = await listRuns(base);
    assert.equal(listed.response.status, 413);
    assert.equal(listed.body.code, "agent_runs_too_large");
  });
});

test("keeps identical session and run ids project-scoped", async () => {
  await withApp(async ({ base }) => {
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "second", name: "Second" }),
    });
    assert.equal(created.status, 200);
    await bind(base, "ses_shared", { mode: "open-domain" });
    await bind(base, "ses_shared", { mode: "open-domain" }, "second");
    const first = await startRun(base, "ses_shared");
    const second = await startRun(base, "ses_shared", "second");

    assert.equal((await listRuns(base)).body.data.length, 1);
    assert.equal((await listRuns(base, "second")).body.data.length, 1);
  });
});

test("refuses a symlinked run ledger", async () => {
  await withApp(async ({ base, dataDir }) => {
    await bind(base, "ses_open", { mode: "open-domain" });
    const ledgerDir = path.join(
      dataDir,
      "users",
      "dev",
      "projects",
      "default",
      ".openscience",
    );
    await mkdir(ledgerDir, { recursive: true });
    const outside = path.join(dataDir, "outside-runs.jsonl");
    await writeFile(outside, "", "utf8");
    await symlink(outside, path.join(ledgerDir, "runs.jsonl"));
    const result = await startRun(base, "ses_open");
    assert.equal(result.response.status, 403);
    assert.equal(result.body.code, "path_forbidden");
  });
});

test("server monitor owns terminal state and records only existing structured artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-monitor-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, "reports"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.workspaceDir, "reports", "real.md"), "real", "utf8");
    const binding = {
      sessionId: "ses_monitored",
      mode: "specialist",
      agentId: "adr-analysis",
      agentVersion: "1.2.2",
      runtimeAgent: "evimed-adr-analysis",
    };
    let reads = 0;
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "adr-analysis",
          version: "1.2.2",
          outputs: [{ path: "reports/real.md", required: true }],
          completionChecks: ["requiredOutputsExist"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 20,
      readSessionHistory: async () => {
        reads += 1;
        if (reads === 1) return [];
        return [{
          info: { id: "msg_monitored", role: "assistant", time: { completed: Date.now() } },
          parts: [
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "reports/real.md" } } },
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "reports/missing.md" } } },
            { type: "text", text: "done" },
          ],
        }];
      },
    });

    const started = await store.start(project, { sessionId: binding.sessionId });
    assert.equal(started.status, "running");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const run = (await store.list(project))[0];
      if (run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const finished = (await store.list(project))[0];
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.artifacts, ["reports/real.md"]);
    assert.equal((await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8")).includes("missing.md"), false);

    await store.start(project, { sessionId: binding.sessionId });
    assert.equal((await store.list(project)).length, 2);
    await store.closeProject(project, "canceled");
    assert.equal((await store.list(project))[0].status, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed tool step cannot finish a busy multi-step run and artifacts are collected across the whole turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-multistep-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, "reports"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.workspaceDir, "reports", "final.md"), "final", "utf8");
    const binding = {
      sessionId: "ses_multistep",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    let sessionStatus = "busy";
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => history,
      readSessionStatus: async () => sessionStatus,
    });

    const started = await store.start(project, { sessionId: binding.sessionId });
    history = [{
      info: { id: "msg_tool_step", role: "assistant", time: { completed: Date.now() } },
      parts: [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "reports/final.md" } } },
        { type: "tool", tool: "search", state: { status: "error", input: {} } },
      ],
    }];
    const whileBusy = await store.reconcileSession(project, binding.sessionId);
    assert.equal(whileBusy.status, "running");
    assert.equal((await store.list(project))[0].finishedAt, null);

    history.push({
      info: { id: "msg_final_answer", role: "assistant", time: { completed: Date.now() + 1 } },
      parts: [{ type: "text", text: "Research completed." }],
    });
    sessionStatus = "idle";
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, started.id);
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.artifacts, ["reports/final.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one running run per session is enforced and workspace files cannot forge meta ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-single-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, ".evimed"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed", "runs.jsonl"), "forged\n", "utf8");
    const binding = { sessionId: "ses_one", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    await store.start(project, { sessionId: binding.sessionId });
    await assert.rejects(
      () => store.start(project, { sessionId: binding.sessionId }),
      (error) => error?.code === "agent_run_active",
    );
    assert.equal((await store.list(project)).length, 1);
    const recovered = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 20,
      readSessionHistory: async () => [{
        info: { id: "msg_recovered", role: "assistant", time: { completed: Date.now() } },
        parts: [{ type: "text", text: "recovered" }],
      }],
    });
    await recovered.recover(project);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await recovered.list(project))[0].status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal((await recovered.list(project))[0].status, "succeeded");
    await recovered.start(project, { sessionId: binding.sessionId });
    assert.equal((await recovered.list(project)).length, 2);
    await recovered.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maps runtime-visible absolute artifacts to the host workspace and rejects unsafe files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-runtime-path-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, "reports"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.workspaceDir, "reports", "real.md"), "real", "utf8");
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(project.workspaceDir, "reports", "linked.md"));
    const binding = {
      sessionId: "ses_runtime_paths",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let reads = 0;
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 20,
      runtimeWorkspaceRoot: async () => "/workspace",
      readSessionHistory: async () => {
        reads += 1;
        if (reads === 1) return [];
        return [{
          info: { id: "msg_new", role: "assistant", time: { completed: Date.now() } },
          parts: [
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/workspace/reports/real.md" } } },
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/workspace/reports/missing.md" } } },
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/workspace/reports/linked.md" } } },
            { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/workspace/../outside.md" } } },
          ],
        }];
      },
    });

    await store.start(project, { sessionId: binding.sessionId });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await store.list(project))[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const run = (await store.list(project))[0];
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.artifacts, ["reports/real.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails baseline history closed and uses a persisted message cursor instead of old assistant history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-cursor-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_cursor",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const oldAssistant = {
      info: { id: "msg_old", role: "assistant", time: { completed: Date.now() - 1000 } },
      parts: [{ type: "text", text: "old answer" }],
    };
    let baselineFails = true;
    let history = [oldAssistant];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 100,
      readSessionHistory: async () => {
        if (baselineFails) throw new Error("transient history outage");
        return history;
      },
    });

    await assert.rejects(
      () => store.start(project, { sessionId: binding.sessionId }),
      (error) => error?.code === "runtime_history_unavailable",
    );
    assert.deepEqual(await store.list(project), []);

    baselineFails = false;
    const started = await store.start(project, { sessionId: binding.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await store.list(project))[0].status, "running");
    const startedEvent = JSON.parse((await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8")).trim());
    assert.equal(startedEvent.baselineCursor, "msg_old");

    history = [
      oldAssistant,
      {
        info: { id: "msg_new", role: "assistant", time: { completed: Date.now() } },
        parts: [{ type: "text", text: "new answer" }],
      },
    ];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await store.list(project))[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal((await store.list(project))[0].status, "succeeded");
    assert.equal((await store.list(project))[0].id, started.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomically reserves one dispatch and rejects a different active turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-dispatch-conflict-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_dispatch",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    let release;
    let promptCalls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_first",
    }, async () => {
      promptCalls += 1;
      await gate;
      return { accepted: true };
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await store.list(project)).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await assert.rejects(
      () => store.dispatch(project, {
        sessionId: binding.sessionId,
        dispatchId: "turn_second",
      }, async () => ({ accepted: true })),
      (error) => error?.code === "agent_run_active",
    );
    const duplicate = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_first",
    }, async () => {
      promptCalls += 1;
      return { accepted: true };
    });
    assert.equal(duplicate.dispatchId, "turn_first");
    assert.equal(promptCalls, 1);
    release();
    const accepted = await first;
    assert.equal(accepted.dispatchStatus, "accepted");
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent identical dispatch ids elect exactly one prompt sender", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-dispatch-owner-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_same_dispatch",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let baselineCalls = 0;
    let releaseBaselines;
    const baselineBarrier = new Promise((resolve) => { releaseBaselines = resolve; });
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => {
        baselineCalls += 1;
        if (baselineCalls === 2) releaseBaselines();
        await baselineBarrier;
        return [];
      },
    });
    let senderCalls = 0;
    let releaseSender;
    const senderBarrier = new Promise((resolve) => { releaseSender = resolve; });
    const sender = async () => {
      senderCalls += 1;
      await senderBarrier;
      return { accepted: true };
    };

    const concurrent = Promise.all([
      store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_same" }, sender),
      store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_same" }, sender),
    ]);
    for (let attempt = 0; attempt < 50 && senderCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(senderCalls, 1);
    releaseSender();
    const [first, second] = await concurrent;
    assert.equal(first.id, second.id);
    assert.equal(senderCalls, 1);
    assert.equal((await store.list(project)).length, 1);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery converts an orphaned dispatching run to unknown and never replays it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-dispatch-restart-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_restart_dispatch",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const beforeRestart = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
    });
    const orphaned = await beforeRestart.createRun(project, binding, {
      baselineCursor: null,
      dispatchId: "turn_restart",
    });
    assert.equal(orphaned.dispatchStatus, "dispatching");

    const recovered = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    await recovered.recover(project);
    const [unknown] = await recovered.list(project);
    assert.equal(unknown.dispatchStatus, "unknown");
    let senderCalls = 0;
    const repeated = await recovered.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_restart",
    }, async () => {
      senderCalls += 1;
      return { accepted: true };
    });
    assert.equal(repeated.dispatchStatus, "unknown");
    assert.equal(senderCalls, 0);
    await recovered.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a definitively rejected prompt terminally fails its reserved run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-dispatch-rejected-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_rejected",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
    });
    await assert.rejects(
      () => store.dispatch(project, {
        sessionId: binding.sessionId,
        dispatchId: "turn_rejected",
      }, async () => ({ accepted: false })),
      (error) => error?.code === "runtime_prompt_rejected",
    );
    const [run] = await store.list(project);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "runtime_prompt_rejected");
    assert.equal(run.dispatchStatus, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hosted dispatch survives a lost browser response and an idempotent repeat never resends the prompt", async () => {
  await withApp(async ({ base }) => {
    const createdResponse = await fetch(`${base}/api/opencode/default/session`, {
      method: "POST",
      headers: projectHeaders("default", true),
      body: "{}",
    });
    const session = await createdResponse.json();
    assert.equal(createdResponse.status, 200);
    assert.equal((await bind(base, session.id, { mode: "open-domain" })).status, 200);
    const dispatchId = "turn_lost_response";
    const target = new URL("/api/agent-runs/dispatch", base);
    await new Promise((resolve, reject) => {
      const req = httpRequest(target, {
        method: "POST",
        headers: {
          ...projectHeaders("default", true),
          "Content-Length": Buffer.byteLength(JSON.stringify({ sessionId: session.id, dispatchId, text: "only once" })),
        },
      }, (res) => {
        res.destroy();
        resolve();
      });
      req.once("error", reject);
      req.end(JSON.stringify({ sessionId: session.id, dispatchId, text: "only once" }));
    });

    const repeated = await dispatchRun(base, session.id, dispatchId, "only once");
    assert.ok([200, 202].includes(repeated.response.status));
    assert.equal(repeated.body.data.dispatchId, dispatchId);
    const historyResponse = await fetch(
      `${base}/api/opencode/default/session/${encodeURIComponent(session.id)}/message`,
      { headers: projectHeaders() },
    );
    const history = await historyResponse.json();
    assert.equal(history.filter((message) => message?.info?.role === "user").length, 1);
  });
});
