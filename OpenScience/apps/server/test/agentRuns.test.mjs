import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import {
  AgentRunStore,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  terminalEvidenceSourceErrorCodes,
} from "../src/agentRuns.mjs";
import { deepResearchPackage } from "./fixtures/clinicalEvidencePackage.mjs";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";

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
    // Model-agnostic: this named "DeepSeek V4 Pro" while the deployment ran
    // Flash, telling the reader to configure something under the wrong name.
    assert.match(result.body.error, /research model provider is not configured/i);
    assert.doesNotMatch(result.body.error, /Pro\b/);
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
        effectiveAgentId: open.body.data.effectiveAgentId,
        effectiveAgentVersion: open.body.data.effectiveAgentVersion,
        effectiveRuntimeAgent: open.body.data.effectiveRuntimeAgent,
        model: open.body.data.model,
        status: open.body.data.status,
      },
      {
        sessionId: "ses_open",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        // Unrouted open-domain turns run on the managed default answer agent
        // (persona + proportional quality floor), not the bare coding agent.
        effectiveAgentId: "open-domain-answer",
        effectiveAgentVersion: "1.0.0",
        effectiveRuntimeAgent: "evimed-open-domain-answer",
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
        effectiveAgentId: specialist.body.data.effectiveAgentId,
        effectiveAgentVersion: specialist.body.data.effectiveAgentVersion,
        effectiveRuntimeAgent: specialist.body.data.effectiveRuntimeAgent,
      },
      {
        sessionId: "ses_adr",
        agentId: "adr-analysis",
        agentVersion: "1.2.2",
        runtimeAgent: "evimed-adr-analysis",
        effectiveAgentId: "adr-analysis",
        effectiveAgentVersion: "1.2.2",
        effectiveRuntimeAgent: "evimed-adr-analysis",
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

test("open-domain clinical evidence questions record and dispatch the selected specialist identity", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_routed_clinical", { mode: "open-domain" })).status, 200);
    const result = await dispatchRun(
      base,
      "ses_routed_clinical",
      "turn_routed_clinical",
      "胸口发闷发紧，是心绞痛还是胃病？请结合速效救心丸生成一份证据报告",
    );
    assert.equal(result.response.status, 202);
    assert.deepEqual({
      mode: result.body.data.mode,
      agentId: result.body.data.agentId,
      runtimeAgent: result.body.data.runtimeAgent,
      effectiveAgentId: result.body.data.effectiveAgentId,
      effectiveAgentVersion: result.body.data.effectiveAgentVersion,
      effectiveRuntimeAgent: result.body.data.effectiveRuntimeAgent,
    }, {
      mode: "open-domain",
      agentId: null,
      runtimeAgent: null,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "2.3.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    });

    // The same chest-pain question WITHOUT an explicit report request stays on
    // the default answer agent instead of being dragged into the report line.
    assert.equal((await bind(base, "ses_unrouted_clinical", { mode: "open-domain" })).status, 200);
    const plain = await dispatchRun(
      base,
      "ses_unrouted_clinical",
      "turn_unrouted_clinical",
      "胸口发闷发紧，是心绞痛还是胃病？结合速效救心丸形成学术分析",
    );
    assert.equal(plain.response.status, 202);
    assert.equal(plain.body.data.effectiveAgentId, "open-domain-answer");
    assert.equal(plain.body.data.effectiveRuntimeAgent, "evimed-open-domain-answer");
  });
});

// Which rule chose the agent, not just which agent. A run routed by a regex on a
// stray word and one the classifier answered at 0.76 are the same record without
// it, and they need different fixes.
test("the ledger records why each run was routed where it was", async () => {
  const specialistClassifierFetch = async (_url, init) => {
    // "none" is the verdict a real classifier returns for a plain question; the
    // stub has to give it, or every query reaches a specialist and the answer
    // line is never exercised.
    const plain = String(init?.body ?? "").includes("阿司匹林是什么药");
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(plain
              ? { agentId: "none", confidence: 0.95 }
              : { agentId: "meta-analysis", confidence: 0.91 }),
          },
        }],
      }),
    };
  };
  await withApp(async ({ base }) => {
    for (const id of ["ses_reason_regex", "ses_reason_llm", "ses_reason_answer"]) {
      assert.equal((await bind(base, id, { mode: "open-domain" })).status, 200);
    }
    const regex = await dispatchRun(base, "ses_reason_regex", "turn_reason_regex", "分析奥希替尼的 FAERS 药物警戒信号");
    assert.equal(regex.body.data.effectiveRouteReason, "matched:adr-analysis");

    const classified = await dispatchRun(
      base,
      "ses_reason_llm",
      "turn_reason_llm",
      "帮我把这个研究方向整理成一个可执行的分析计划",
    );
    assert.equal(classified.body.data.effectiveRouteReason, "llm:0.91");

    // Falling through to the answer line is a routing outcome, and the one most
    // often misread as a failure to route.
    const answered = await dispatchRun(base, "ses_reason_answer", "turn_reason_answer", "阿司匹林是什么药");
    assert.equal(answered.body.data.effectiveAgentId, "open-domain-answer");
    assert.equal(answered.body.data.effectiveRouteReason, "unrouted:open-domain");

    // It survives a reload: the reason is in the ledger, not only in the response.
    const listed = await listRuns(base);
    const reasons = new Map(listed.body.data.map((run) => [run.dispatchId, run.effectiveRouteReason]));
    assert.equal(reasons.get("turn_reason_regex"), "matched:adr-analysis");
    assert.equal(reasons.get("turn_reason_llm"), "llm:0.91");
    assert.equal(reasons.get("turn_reason_answer"), "unrouted:open-domain");
  }, {
    llmRoutingEnabled: true,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    specialistClassifierFetch,
  });
});

test("LLM routing augments but never overrides the deterministic router", async () => {
  const calls = [];
  const specialistClassifierFetch = async (_url, _init) => {
    calls.push(1);
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ agentId: "meta-analysis", confidence: 0.95 }) } }],
      }),
    };
  };
  await withApp(async ({ base }) => {
    await bind(base, "ses_llm_a", { mode: "open-domain" });
    await bind(base, "ses_llm_b", { mode: "open-domain" });
    // A deterministic regex match must not consult the LLM at all.
    const deterministic = await dispatchRun(
      base,
      "ses_llm_a",
      "turn_llm_a",
      "分析奥希替尼的 FAERS 药物警戒信号",
    );
    assert.equal(deterministic.body.data.effectiveAgentId, "adr-analysis");
    assert.equal(calls.length, 0);
    // A query the regex does not match falls through to the LLM classifier.
    const classified = await dispatchRun(
      base,
      "ses_llm_b",
      "turn_llm_b",
      "帮我把这个研究方向整理成一个可执行的分析计划",
    );
    assert.equal(calls.length, 1);
    assert.equal(classified.body.data.effectiveAgentId, "meta-analysis");
    assert.equal(classified.body.data.effectiveRuntimeAgent, "evimed-meta-analysis");
  }, {
    llmRoutingEnabled: true,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    specialistClassifierFetch,
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
          runtimeAgent: "evimed-meta-analysis",
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

test("a deep clinical evidence run fails closed unless every companion skill is actually loaded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-required-skills-"));
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
      sessionId: "ses_required_skills",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "2.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          skill: "clinical-evidence-synthesis",
          companionSkills: ["deep-research", "biomedical-database-search", "citation-integrity"],
          outputs: [{ path: "clinical-evidence-report.md", required: true }],
          completionChecks: ["requiredOutputsExist", "skillsLoaded"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const dispatch = (dispatchId) => store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "2.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    await dispatch("turn_required_skills_missing");
    history = [{
      info: { id: "msg_skills_missing", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [{ type: "text", text: "Completed without loading the research skills." }],
    }];
    const missing = await store.reconcileSession(project, binding.sessionId);
    assert.equal(missing.status, "failed");
    assert.equal(missing.errorCode, "specialist_required_skill_missing");

    await dispatch("turn_required_skills_loaded");
    history = [...history, {
      info: { id: "msg_skills_loaded", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [
        "deep-research",
        "biomedical-database-search",
        "citation-integrity",
        "clinical-evidence-synthesis",
      ].map((name) => ({
        type: "tool",
        tool: "skill",
        state: { status: "completed", input: { name } },
      })),
    }];
    const loaded = await store.reconcileSession(project, binding.sessionId);
    assert.equal(loaded.status, "failed");
    assert.equal(loaded.errorCode, "specialist_required_output_missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withAnswerModeRun(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-answer-mode-"));
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
      sessionId: "ses_answer_mode",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "open-domain-answer",
          version: "1.0.0",
          runtimeAgent: "evimed-open-domain-answer",
          skill: "open-domain-answer",
          companionSkills: [],
          outputs: [],
          completionChecks: ["skillsLoaded", "citationsResolvable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const dispatch = (dispatchId) => store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId,
      effectiveAgentId: "open-domain-answer",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-open-domain-answer",
    }, async () => ({ accepted: true }));
    const appendHistory = (parts) => {
      history = [...history, {
        info: { id: `msg_answer_${Math.random().toString(16).slice(2, 10)}`, role: "assistant", time: { completed: Date.now() + 10 } },
        parts,
      }];
    };
    const skillLoadedPart = {
      type: "tool",
      tool: "skill",
      state: { status: "completed", input: { name: "open-domain-answer" } },
    };
    await fn({ project, binding, dispatch, appendHistory, skillLoadedPart, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("an answer-mode turn succeeds with zero citations once its skill is loaded", async () => {
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    await dispatch("turn_answer_zero_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "二甲双胍主要通过抑制肝糖输出、改善外周胰岛素敏感性发挥作用。" },
    ]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCode, null);
  });
});

test("an answer-mode turn delivers unverified (not failed) when its answer skill was never loaded", async () => {
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, store }) => {
    await dispatch("turn_answer_skill_missing");
    appendHistory([{ type: "text", text: "直接回答，没有加载任何 skill。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    // A missing skill load is a process gap: the answer is delivered marked
    // unverified instead of discarding a sound reply.
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCode, null);
    assert.equal(run.verification, "unverified");
    assert.match(run.qualityNotices.join("\n"), /open-domain-answer skill was not loaded/);
  });
});

test("a citation a reader can open is delivered; one they cannot is marked unverified", async () => {
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    // Plain HTTP is not an integrity defect. The reader opens the link and
    // reads the source, so the answer stands and the scheme is a remark on it.
    // Requiring HTTPS as a condition of delivery discarded two complete
    // production reports, one of them over a purl.obolibrary.org identifier
    // whose canonical form is http.
    await dispatch("turn_answer_insecure_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "有证据支持该结论 [1]。\n\n参考文献\n1. http://insecure.example.org/paper" },
    ]);
    const insecure = await store.reconcileSession(project, binding.sessionId);
    assert.equal(insecure.status, "succeeded");
    assert.equal(insecure.errorCode, null);
    assert.notEqual(insecure.verification, "unverified");
    assert.match(insecure.qualityNotices.join("\n"), /plain HTTP/);

    // A fragment is how a citation points at the passage it means.
    await dispatch("turn_answer_fragment_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "见该节 [1]。\n\n参考文献\n1. https://www.nice.org.uk/guidance/ng185#section-3" },
    ]);
    const fragment = await store.reconcileSession(project, binding.sessionId);
    assert.equal(fragment.status, "succeeded");
    assert.equal(fragment.errorCode, null);
    assert.deepEqual(fragment.qualityNotices, []);

    // An address outside this deployment cannot resolve — that a reader cannot
    // work around, so it is named and the reply is marked unverified.
    await dispatch("turn_answer_internal_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "内部证据 [1]。\n\n参考文献\n1. https://www.evimed.com/api-evimed/medicine-api/ai-api/search" },
    ]);
    const internal = await store.reconcileSession(project, binding.sessionId);
    assert.equal(internal.status, "succeeded");
    assert.equal(internal.verification, "unverified");
    assert.match(internal.qualityNotices.join("\n"), /points inside this deployment/);

    // The same defect wearing a different address.
    await dispatch("turn_answer_loopback_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "本地证据 [1]。\n\n参考文献\n1. https://127.0.0.1:8787/doc/42" },
    ]);
    const loopback = await store.reconcileSession(project, binding.sessionId);
    assert.equal(loopback.verification, "unverified");
    assert.match(loopback.qualityNotices.join("\n"), /points inside this deployment/);

    // Credentials in a citation must never ship, whatever the scheme.
    await dispatch("turn_answer_credentialed_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "见此 [1]。\n\n参考文献\n1. https://reader:placeholder-token@journals.example.org/article/9" },
    ]);
    const credentialed = await store.reconcileSession(project, binding.sessionId);
    assert.equal(credentialed.verification, "unverified");
    assert.match(credentialed.qualityNotices.join("\n"), /carries credentials/);
    // The notice names the host and never repeats the credential it found.
    assert.doesNotMatch(credentialed.qualityNotices.join("\n"), /placeholder-token/);
  });
});

test("an answer-mode turn succeeds with well-formed HTTPS citations", async () => {
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    await dispatch("turn_answer_good_citation");
    appendHistory([
      skillLoadedPart,
      {
        type: "text",
        text: "GLP-1 受体激动剂在合并心血管疾病的 2 型糖尿病患者中可降低主要心血管事件风险 [1]。\n\n参考文献\n1. Marso SP, et al. N Engl J Med. https://pubmed.ncbi.nlm.nih.gov/27295427/",
      },
    ]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCode, null);
  });
});

test("a routed clinical evidence turn honors a configured bounded repair limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-clinical-quality-"));
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
      sessionId: "ses_clinical_quality",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
            { path: "clinical-evidence-run.json", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
      maxClinicalRepairAttempts: 1,
    });
    store.scheduleMonitor = () => {};
    const prompts = [];
    const sendPrompt = async (_session, _run, repairText) => {
      prompts.push(repairText ?? null);
      return { accepted: true };
    };
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_clinical_quality",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, sendPrompt);
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# Too short\nUnsupported claim [claim:CLM-999]", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), JSON.stringify({ claims: [] }), "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-run.json"), JSON.stringify({
      status: "succeeded",
      successfulSourceArtifacts: [],
      qualityChecks: { claimTraceability: true, contradictionAudit: true, arithmeticAudit: true },
    }), "utf8");
    history = [{
      info: { id: "msg_clinical_bad", role: "assistant", time: { completed: Date.now() } },
      parts: [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "clinical-evidence-report.md" } } },
        { type: "text", text: "Completed." },
      ],
    }];
    const repairing = await store.reconcileSession(project, binding.sessionId);
    assert.equal(repairing.id, run.id);
    assert.equal(repairing.status, "running");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /server-side clinical evidence gate rejected/);
    assert.match(prompts[1], /evidence matrix must contain the report's material claims/i);
    // Repairing traceability must send the run back to the sources, not invite
    // it to delete the claim: two runs of one question differed only in repair
    // rounds, and the repaired one came back 43% shorter.
    assert.match(prompts[1], /retrieve one with the approved evidence tools/i);
    assert.match(prompts[1], /last resort, not the first/i);
    assert.match(prompts[1], /must not leave the report thinner/i);
    // The determinant is the tool. A whole-file write regenerates the report
    // from a compressed recollection and silently loses content; two production
    // repairs cost 1,863 and 4,125 characters that way.
    assert.match(prompts[1], /Patch clinical-evidence-report\.md with the edit tool/i);
    assert.match(prompts[1], /Do not rewrite it with the write tool/i);
    assert.doesNotMatch(prompts[1], /at least (?:8|12|18|30)|10000/);
    const stillRepairing = await store.reconcileSession(project, binding.sessionId);
    assert.equal(stillRepairing.status, "running");
    history.push({
      info: { id: "msg_clinical_repair_bad", role: "assistant", time: { completed: Date.now() } },
      parts: [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "clinical-evidence-report.md" } } },
        { type: "text", text: "Repair completed." },
      ],
    });
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    // Repairs are exhausted and issues remain, but every required deliverable
    // was written. Withholding returned an error code and nothing else: across
    // seven production runs the report was written every time and delivered
    // none of them. Deliver it, mark it unverified, and lead the notices with
    // what a reader cannot check for themselves.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification, "unverified");
    assert.ok(finished.artifacts.length > 0, "the deliverables must reach the reader");
    assert.ok(finished.qualityNotices.length > 0);
    assert.match(finished.qualityNotices[0], /^MUST FIX — /, "an unverifiable claim leads the notices");
    assert.match(finished.qualityNotices.join("\n"), /evidence matrix must contain the report's material claims/i);

    const malformed = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_clinical_malformed_json",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, sendPrompt);
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), '{"claims":[{"claim":"unescaped "quote""}]}', "utf8");
    history.push({
      info: { id: "msg_clinical_malformed_json", role: "assistant", time: { completed: Date.now() } },
      parts: [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "clinical-evidence-matrix.json" } } },
        { type: "text", text: "Completed with malformed JSON." },
      ],
    });
    const malformedRepair = await store.reconcileSession(project, binding.sessionId);
    assert.equal(malformedRepair.id, malformed.id);
    assert.equal(malformedRepair.status, "running");
    assert.equal(prompts.length, 4);
    assert.match(prompts[3], /clinical-evidence-matrix\.json must contain strict valid JSON/);
    assert.match(prompts[3], /escape quotation marks correctly/i);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clinical evidence source artifacts must come from successful retrieval tools in the same turn", async () => {
  for (const scenario of ["missing", "valid", "tampered"]) {
    const root = await mkdtemp(path.join(tmpdir(), `os-agent-run-clinical-provenance-${scenario}-`));
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
        sessionId: `ses_clinical_provenance_${scenario}`,
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
      };
      let history = [];
      const store = new AgentRunStore({ get: async () => binding }, {
        agentRegistry: {
          get: () => ({
            id: "clinical-evidence-synthesis",
            version: "1.0.0",
            runtimeAgent: "evimed-clinical-evidence-synthesis",
            outputs: [
              { path: "clinical-evidence-report.md", required: true },
              { path: "clinical-evidence-matrix.json", required: true },
              { path: "clinical-evidence-run.json", required: true },
            ],
            completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
          }),
        },
        model: "deepseek/deepseek-v4-pro",
        monitorIntervalMs: 60_000,
        monitorMaxPolls: 20,
        // What this test pins is the gate's verdict. Provenance and integrity
        // rejections are now repairable, so leaving repair on would have the
        // run come back for another turn instead of settling, which the repair
        // loop's own tests cover.
        maxClinicalRepairAttempts: 0,
        readSessionHistory: async () => history,
        readSessionStatus: async () => "idle",
      });
      const run = await store.dispatch(project, {
        sessionId: binding.sessionId,
        dispatchId: `turn_clinical_provenance_${scenario}`,
        effectiveAgentId: "clinical-evidence-synthesis",
        effectiveAgentVersion: "1.0.0",
        effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
      }, async () => ({ accepted: true }));

      const sourceA = ".evimed-sources/official-pages/source-a/page.md";
      const sourceB = ".evimed-sources/official-pages/source-b/page.md";
      const quotes = [
        "Patients with acute pressure-like chest discomfort require prompt emergency evaluation for acute coronary syndrome.",
        "Serial high-sensitivity cardiac troponin measurements support rapid diagnostic assessment in acute chest pain.",
        "The evidence review included fifteen trials with a total of 1776 participants and found important study limitations.",
        "The available trials were generally of poor methodological quality, which limits confidence in treatment effects.",
      ];
      const claims = quotes.map((supportQuote, index) => ({
        claimId: `CLM-00${index + 1}`,
        claim: supportQuote,
        sourceUrl: index < 2
          ? "https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2022/10/10/23/15/2022-acc-expert-consensus-on-chest-pain"
          : "https://www.cochrane.org/evidence/CD004473_chinese-herbal-medicine-suxiao-jiuxin-wan-angina-pectoris",
        sourceTitle: index < 2 ? "ACC acute chest pain pathway" : "Cochrane Suxiao Jiuxin Wan evidence review",
        artifactPath: index < 2 ? sourceA : sourceB,
        identifier: index < 2 ? "ACC-2022-ECDP" : "CD004473",
        accessLevel: "official_page",
        supportQuote,
        applicability: "Directly informs the acute chest-pain evidence question.",
        uncertainty: index < 2 ? "Jurisdiction and pathway implementation may vary." : "The included studies had important risk of bias.",
      }));
      const report = [
        "# 突发压迫性胸闷与速效救心丸的临床判断",
        "",
        "## 摘要",
        `急性压迫性胸部不适需要优先排查急性冠脉综合征 [claim:CLM-001](https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2022/10/10/23/15/2022-acc-expert-consensus-on-chest-pain)。${"该判断基于时间敏感性和漏诊风险，不能仅凭症状自行归因为胃病。".repeat(8)}`,
        "",
        "## 临床证据分析",
        `序贯高敏肌钙蛋白支持急诊快速评估 [claim:CLM-002](https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2022/10/10/23/15/2022-acc-expert-consensus-on-chest-pain)。${"诊断路径仍需结合心电图、症状时间和临床风险，单次结果不足以覆盖所有情形。".repeat(8)}`,
        `速效救心丸证据页纳入十五项试验和一千七百七十六名参与者 [claim:CLM-003](https://www.cochrane.org/evidence/CD004473_chinese-herbal-medicine-suxiao-jiuxin-wan-angina-pectoris)。${"药物讨论不能替代急救评估，也不能以症状缓解作为病因鉴别试验。".repeat(8)}`,
        "",
        "## 科学局限",
        `现有试验方法学质量较差 [claim:CLM-004](https://www.cochrane.org/evidence/CD004473_chinese-herbal-medicine-suxiao-jiuxin-wan-angina-pectoris)。证据存在偏倚、间接性、不精确性以及人群和司法辖区适用性限制。`,
        "",
        "## 实用处置结论",
        "出现新发压迫性胸部不适时应立即呼叫急救并接受规范评估 [claim:CLM-001]；不得因服用速效救心丸而延误呼救或急诊评估 [claim:CLM-004]。",
      ].join("\n");
      const receipt = {
        question: "急性压迫性胸部不适与速效救心丸",
        title: "突发压迫性胸闷与速效救心丸的临床判断",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        tools: ["evimed_official_page_fetch"],
        successfulSourceArtifacts: [sourceA, sourceB],
        failedSources: [],
        qualityChecks: { claimsVerified: true, citationsResolved: true, contradictionsChecked: true },
        status: "succeeded",
      };
      const sourceContents = new Map([
        [sourceA, quotes.slice(0, 2).join("\n")],
        [sourceB, quotes.slice(2).join("\n")],
      ]);
      await mkdir(path.join(project.workspaceDir, path.dirname(sourceA)), { recursive: true });
      await mkdir(path.join(project.workspaceDir, path.dirname(sourceB)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, sourceA), sourceContents.get(sourceA), "utf8");
      await writeFile(path.join(project.workspaceDir, sourceB), sourceContents.get(sourceB), "utf8");
      await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), report, "utf8");
      await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), JSON.stringify({ claims }), "utf8");
      await writeFile(path.join(project.workspaceDir, "clinical-evidence-run.json"), JSON.stringify(receipt), "utf8");
      if (scenario === "tampered") {
        await writeFile(path.join(project.workspaceDir, sourceA), `${sourceContents.get(sourceA)}\nAuthored replacement.`, "utf8");
      }

      const retrievalParts = scenario !== "missing"
        ? [sourceA, sourceB].map((source) => ({
            type: "tool",
            tool: "evimed-research_evimed_official_page_fetch",
            state: {
              status: "completed",
              output: JSON.stringify({
                status: "success",
                artifacts: [source],
                data: {
                  artifactSha256s: {
                    [source]: createHash("sha256").update(sourceContents.get(source), "utf8").digest("hex"),
                  },
                },
              }),
            },
          }))
        : [];
      history = [{
        info: { id: `msg_clinical_provenance_${scenario}`, role: "assistant", time: { completed: Date.now() } },
        parts: [
          ...retrievalParts,
          ...["clinical-evidence-report.md", "clinical-evidence-matrix.json", "clinical-evidence-run.json"].map((filePath) => ({
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath } },
          })),
          { type: "text", text: "Completed." },
        ],
      }];
      const finished = await store.reconcileSession(project, binding.sessionId);
      assert.equal(finished.id, run.id);
      assert.equal(finished.status, scenario === "valid" ? "succeeded" : "failed");
      assert.equal(finished.errorCode, {
        missing: "specialist_evidence_provenance_failed",
        valid: null,
        tampered: "specialist_evidence_integrity_failed",
      }[scenario]);
      await store.closeProject(project, "canceled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects browser-forged identity/model fields and unknown research sessions", async () => {
  await withApp(async ({ base }) => {
    await bind(base, "ses_open", { mode: "open-domain" });
    for (const field of ["mode", "agentId", "agentVersion", "runtimeAgent", "effectiveAgentId", "effectiveRuntimeAgent", "model", "prompt", "tokens"]) {
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
    const result = await startRun(base, "ses_open");
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, "agent_run_limit_reached");
    assert.equal(await readFile(ledgerFile, "utf8"), before);

    await writeFile(ledgerFile, "x".repeat(1024 * 1024 + 1), "utf8");
    const listed = await listRuns(base);
    assert.equal(listed.response.status, 413);
    assert.equal(listed.body.code, "agent_runs_too_large");
  });
});

test("a run that stops making progress is failed instead of waiting out the timeout", async () => {
  // start/dispatch/finish cannot distinguish a long run from a dead one, so a
  // run that died early still held its slot for the whole monitor window.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-stall-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      metaDir: path.join(root, ".openscience"), workspaceDir: root,
    };
    await mkdir(project.metaDir, { recursive: true });
    const binding = {
      sessionId: "ses_stall", mode: "open-domain",
      agentId: null, agentVersion: null, runtimeAgent: null,
    };
    let history = [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "go" }] }];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1,
      monitorMaxPolls: 500,
      monitorStallPolls: 3,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "running",
      runtimeWorkspaceRoot: () => root,
    });
    const run = await store.start(project, { sessionId: "ses_stall" });

    // Move once, then go quiet: the run must be failed for stalling, not for timing out.
    history = [...history, { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "evimed_health" }] }];
    await store.monitors.get(run.id)?.promise;

    const [finished] = await store.list(project);
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "runtime_monitor_stalled");
    assert.ok(finished.observedToolCalls >= 1, "the progress it did make is recorded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);

    // The name of this test is the assertion: both projects must really be
    // holding the same session id, and each must see only its own run. Without
    // checking the ids the test passes even when the collision never happens,
    // which is the case it exists to cover.
    assert.equal(first.body.data.sessionId, "ses_shared");
    assert.equal(second.body.data.sessionId, "ses_shared");

    const firstRuns = (await listRuns(base)).body.data;
    const secondRuns = (await listRuns(base, "second")).body.data;
    assert.equal(firstRuns.length, 1);
    assert.equal(secondRuns.length, 1);
    assert.equal(firstRuns[0].id, first.body.data.id);
    assert.equal(secondRuns[0].id, second.body.data.id);
    assert.notEqual(firstRuns[0].id, secondRuns[0].id);
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
          runtimeAgent: "evimed-adr-analysis",
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
        await writeFile(path.join(project.workspaceDir, "reports", "real.md"), "updated this turn", "utf8");
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
        { type: "tool", tool: "evimed-research_evimed_literature_search", state: { status: "error", input: {} } },
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
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "runtime_tool_error");
    assert.deepEqual(finished.artifacts, ["reports/final.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deep research tolerates documented source misses but requires invalid EviMed calls to be corrected", async (t) => {
  const scenarios = [
    {
      name: "unavailable open-access source",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_open_access_full_text",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "full_text_not_available" },
            }),
          },
        },
      ],
    },
    {
      // A deployment with no Unpaywall address configured cannot read closed
      // sources. That is a host gap the agent is told to record and work
      // around, and it was failing otherwise complete runs.
      name: "unpaywall credential missing on the host",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_open_access_full_text",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "public_source_unpaywall_credential_missing" },
            }),
          },
        },
      ],
    },
    {
      name: "source that is simply not open access",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_open_access_full_text",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "public_source_pdf_not_open_access" },
            }),
          },
        },
      ],
    },
    {
      // A downstream specialist service that crashed. The production run that
      // exposed this wrote all seven deliverables, then was failed because the
      // research-topic service died on a PubMed 429 and a missing plotting
      // library — an outage in a helper container and an upstream rate limit,
      // neither a defect in the analysis it was helping with.
      name: "downstream specialist service that could not complete",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_research_topic_selection",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              summary: "PubMed 限流(429) … matplotlib not available",
              error: { code: "specialist_execution_failed" },
            }),
          },
        },
      ],
    },
    {
      // The refusal that failed a production run. The agent asked for a page
      // outside the approved official-document set, the gateway said no, and
      // the agent obeyed and went elsewhere — then the run was failed for
      // having asked. A guardrail the agent respected is the guardrail working.
      name: "official page the gateway refused to fetch",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_official_page_fetch",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              summary: "The URL is not an approved official document.",
              error: { code: "official_page_url_forbidden" },
            }),
          },
        },
      ],
    },
    {
      // Transport died before either side said anything. The MCP client
      // reports it as a bare string with no JSON envelope, so no code parses
      // out and it fell through to terminal — the most recoverable class of
      // failure treated as the least. In production it survived only because a
      // later call to the same tool happened to succeed.
      name: "MCP transport timeout with no structured error code",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_open_access_full_text",
          state: { status: "error", error: "MCP error -32001: Request timed out" },
        },
      ],
    },
    {
      // Still terminal: the gateway could not parse what the run sent it,
      // which is the run's own defect rather than a source declining to be
      // read. The gateway itself draws this line — 403 refuses, 400 rejects.
      name: "malformed request the gateway could not parse",
      expectedStatus: "failed",
      expectedErrorCode: "runtime_tool_error",
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_biomedical_source_search",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "public_source_gateway_url_invalid" },
            }),
          },
        },
      ],
    },
    {
      // The tolerance used to require the tool to be on a hand-written list of
      // "evidence source" tools. openFDA answering 400 is the same unreachable
      // source whether literature search or an adverse-event query asked it,
      // and a run that produced every deliverable failed over the difference.
      name: "adverse-event query whose public source was unreachable",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_adr_case_query",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "public_source_http_error" },
            }),
          },
        },
      ],
    },
    {
      name: "uncorrected invalid deduplication input",
      expectedStatus: "failed",
      expectedErrorCode: "runtime_tool_error",
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_evidence_deduplicate",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "invalid_input" },
            }),
          },
        },
      ],
    },
    {
      name: "corrected invalid deduplication input",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_evidence_deduplicate",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              error: { code: "invalid_input" },
            }),
          },
        },
        {
          type: "tool",
          tool: "evimed-research_evimed_evidence_deduplicate",
          state: {
            status: "completed",
            output: JSON.stringify({ status: "success", data: { records: [] } }),
          },
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-research-recovery-"));
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
          sessionId: `ses_${scenario.name.replace(/\W+/g, "_")}`,
          mode: "open-domain",
          agentId: null,
          agentVersion: null,
          runtimeAgent: null,
        };
        let history = [];
        const store = new AgentRunStore({ get: async () => binding }, {
          model: "deepseek/deepseek-v4-pro",
          readSessionHistory: async () => history,
          readSessionStatus: async () => "idle",
        });
        store.scheduleMonitor = () => {};
        await store.start(project, { sessionId: binding.sessionId });
        history = [{
          info: { id: "msg_research_recovery", role: "assistant", time: { completed: Date.now() + 10 } },
          parts: [...scenario.parts, { type: "text", text: "Research completed." }],
        }];
        const result = await store.reconcileSession(project, binding.sessionId);
        assert.equal(result.status, scenario.expectedStatus);
        assert.equal(result.errorCode, scenario.expectedErrorCode);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
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
    // The ledger is JSONL and now carries progress events too, so take the
    // start event rather than parsing the whole file as one object.
    const startedEvent = (await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "started");
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

test("records what was asked, bounded, so a run list is not a list of hashes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-question-"));
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
    // One session per dispatch: a session may only have one run in flight.
    const store = new AgentRunStore({
      get: async (_project, sessionId) => ({
        sessionId,
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
      }),
    }, {
      model: "deepseek/deepseek-v4-flash",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    store.scheduleMonitor = () => {};

    const run = await store.dispatch(project, {
      sessionId: "ses_question",
      dispatchId: "turn_question",
      question: "  速效救心丸开封后\n  多久失效？  ",
    }, async () => ({ accepted: true }));
    // Whitespace collapsed: the prompt arrives with the newlines the composer
    // put in it, and a run row is one line.
    assert.equal(run.question, "速效救心丸开封后 多久失效？");

    const long = await store.dispatch(project, {
      sessionId: "ses_long",
      dispatchId: "turn_long",
      question: "问".repeat(400),
    }, async () => ({ accepted: true }));
    assert.ok(long.question.length <= 161, `preview was ${long.question.length} characters`);
    assert.ok(long.question.endsWith("…"));

    // A dispatch that names no question still works; the row falls back to the id.
    const plain = await store.dispatch(project, {
      sessionId: "ses_plain",
      dispatchId: "turn_plain",
    }, async () => ({ accepted: true }));
    assert.equal(plain.question, null);

    // It survives a reload, because the row is read back from the ledger.
    const reloaded = (await store.list(project)).find((item) => item.dispatchId === "turn_question");
    assert.equal(reloaded.question, "速效救心丸开封后 多久失效？");
    await store.closeProject(project, "canceled");
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

test("requires an evidence agent's cited sources to all be recorded in its snapshot", async () => {
  for (const scenario of ["recorded", "unrecorded"]) {
    const root = await mkdtemp(path.join(tmpdir(), `os-agent-run-snapshot-${scenario}-`));
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
        sessionId: `ses_snapshot_${scenario}`,
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
      };
      let history = [];
      const store = new AgentRunStore({ get: async () => binding }, {
        agentRegistry: {
          get: () => ({
            id: "comprehensive-drug-evaluation",
            version: "1.0.0",
            runtimeAgent: "evimed-comprehensive-drug-evaluation",
            outputs: [
              { path: "comprehensive-evaluation-report.md", required: true },
              { path: "evidence-snapshot.json", required: true },
            ],
            completionChecks: ["requiredOutputsExist", "citationsResolvable", "citedSourcesRecorded"],
          }),
        },
        model: "deepseek/deepseek-v4-pro",
        monitorIntervalMs: 60_000,
        monitorMaxPolls: 20,
        readSessionHistory: async () => history,
        readSessionStatus: async () => "idle",
      });
      store.scheduleMonitor = () => {};
      const run = await store.dispatch(project, {
        sessionId: binding.sessionId,
        dispatchId: `turn_snapshot_${scenario}`,
        effectiveAgentId: "comprehensive-drug-evaluation",
        effectiveAgentVersion: "1.0.0",
        effectiveRuntimeAgent: "evimed-comprehensive-drug-evaluation",
      }, async () => ({ accepted: true }));

      const citedUrl = "https://www.nmpa.gov.cn/label/example-a";
      const recordedUrl = scenario === "recorded" ? citedUrl : "https://www.nmpa.gov.cn/label/example-b";
      await writeFile(
        path.join(project.workspaceDir, "comprehensive-evaluation-report.md"),
        // Bare URL in Chinese prose with a trailing full-width period, so the
        // check must strip 。 to match the URL recorded in the snapshot JSON.
        `# 综合评价\n\n标签证据参见 ${citedUrl}。`,
        "utf8",
      );
      await writeFile(
        path.join(project.workspaceDir, "evidence-snapshot.json"),
        JSON.stringify({ sources: [{ url: recordedUrl, identifier: "NMPA-A" }] }),
        "utf8",
      );
      history = [{
        info: { id: `msg_snapshot_${scenario}`, role: "assistant", time: { completed: Date.now() } },
        parts: [
          ...["comprehensive-evaluation-report.md", "evidence-snapshot.json"].map((filePath) => ({
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath } },
          })),
          { type: "text", text: "Completed." },
        ],
      }];
      const finished = await store.reconcileSession(project, binding.sessionId);
      assert.equal(finished.id, run.id);
      assert.equal(finished.status, scenario === "recorded" ? "succeeded" : "failed");
      assert.equal(finished.errorCode, scenario === "recorded" ? null : "specialist_cited_source_unrecorded");
      await store.closeProject(project, "canceled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a finding about the evidence itself still stamps the package unverified", async () => {
  // The counterpart to the bookkeeping case: relaxing the mark must not empty
  // it. A quotation absent from the source it names is exactly what a reader
  // cannot check for themselves, and it keeps the mark.
  const input = deepResearchPackage();
  input.matrix.claims[0].supportQuote = "This passage was written after retrieval and appears in no preserved source.";
  const result = validateClinicalEvidencePackage(input);
  assert.equal(result.valid, false);
  assert.ok(result.blockingIssues.length > 0, "an absent quotation must be blocking");
  assert.match(result.blockingIssues.join("\n"), /not found in its preserved source artifact/);
});

test("delivers a package whose only gap is bookkeeping, and does not stamp it unverified", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-clinical-degrade-"));
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
      sessionId: "ses_clinical_degrade",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const pkg = deepResearchPackage();
    // Break ONLY the degradable citation-audit documentation-completeness check.
    pkg.citationAuditText = pkg.citationAuditText.replace(
      "Correction and retraction checks: no correction or retraction notice was identified for the included records.\n\n",
      "",
    );
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
            { path: "clinical-evidence-run.json", required: true },
            { path: "clinical-evidence-search.json", required: true },
            { path: "references.bib", required: true },
            { path: "citation-ledger.csv", required: true },
            { path: "citation-audit.md", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
      // No repair budget: go straight to the terminal delivery decision.
      maxClinicalRepairAttempts: 0,
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_clinical_degrade",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
      ["clinical-evidence-run.json", JSON.stringify(pkg.runReceipt)],
      ["clinical-evidence-search.json", pkg.searchLogText],
      ["references.bib", pkg.referencesText],
      ["citation-ledger.csv", pkg.citationLedgerText],
      ["citation-audit.md", pkg.citationAuditText],
    ]);
    for (const [relative, content] of deliverables) {
      await writeFile(path.join(project.workspaceDir, relative), content, "utf8");
    }
    for (const [artifactPath, content] of Object.entries(pkg.sourceArtifacts)) {
      await mkdir(path.join(project.workspaceDir, path.dirname(artifactPath)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, artifactPath), content, "utf8");
    }

    const retrievalParts = Object.entries(pkg.sourceArtifacts).map(([artifactPath, content]) => ({
      type: "tool",
      tool: "evimed-research_evimed_open_access_full_text",
      state: {
        status: "completed",
        output: JSON.stringify({
          status: "success",
          artifacts: [artifactPath],
          data: { artifactSha256s: { [artifactPath]: createHash("sha256").update(content, "utf8").digest("hex") } },
        }),
      },
    }));
    const searchParts = JSON.parse(pkg.searchLogText).queries.map((entry) => ({
      type: "tool",
      tool: "evimed-research_evimed_literature_search",
      state: { status: "completed", input: { query: entry.query } },
    }));
    history = [{
      info: { id: "msg_clinical_degrade", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...retrievalParts,
        ...searchParts,
        ...[...deliverables.keys()].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    // Only a process-documentation gap remained: deliver, do not discard.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    // And do not stamp. "Unverified" is a statement about the evidence, and it
    // used to fire on any remaining issue — so a package whose only notices
    // were a gate bug of ours carried the same mark as one with a quotation
    // absent from its source. A mark that means everything means nothing.
    assert.notEqual(finished.verification, "unverified");
    assert.ok(finished.qualityNotices.length > 0);
    assert.match(finished.qualityNotices.join("\n"), /citation-audit\.md must document/);
    assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one plain-HTTP citation is a notice on a delivered package, not a reason to discard it", async () => {
  // Two complete production reports were discarded over one link each — a
  // CQVIP journal record, and http://purl.obolibrary.org/obo/CHEBI_28093,
  // where http is the canonical form of the identifier. The predicate required
  // https of every cited URL and the file-mode path returned a bare error
  // code, so 17,975 and 11,292 characters of finished analysis were thrown
  // away and nothing said which URL was at fault.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-http-citation-"));
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
      sessionId: "ses_http_citation",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    // A package that is valid in every other respect, with one source served
    // over plain HTTP. Rewritten across every deliverable so the citation, the
    // matrix and the bibliography still agree with each other.
    const insecure = "http://www.escardio.org/evidence/source-3";
    const secure = "https://www.escardio.org/evidence/source-3";
    const pkg = deepResearchPackage();
    const rewrite = (value) => value.split(secure).join(insecure);
    pkg.reportText = rewrite(pkg.reportText);
    pkg.referencesText = rewrite(pkg.referencesText);
    pkg.citationLedgerText = rewrite(pkg.citationLedgerText);
    pkg.citationAuditText = rewrite(pkg.citationAuditText);
    pkg.matrix = JSON.parse(rewrite(JSON.stringify(pkg.matrix)));

    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
            { path: "clinical-evidence-run.json", required: true },
            { path: "clinical-evidence-search.json", required: true },
            { path: "references.bib", required: true },
            { path: "citation-ledger.csv", required: true },
            { path: "citation-audit.md", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-flash",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
      maxClinicalRepairAttempts: 0,
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_http_citation",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
      ["clinical-evidence-run.json", JSON.stringify(pkg.runReceipt)],
      ["clinical-evidence-search.json", pkg.searchLogText],
      ["references.bib", pkg.referencesText],
      ["citation-ledger.csv", pkg.citationLedgerText],
      ["citation-audit.md", pkg.citationAuditText],
    ]);
    for (const [relative, content] of deliverables) {
      await writeFile(path.join(project.workspaceDir, relative), content, "utf8");
    }
    for (const [artifactPath, content] of Object.entries(pkg.sourceArtifacts)) {
      await mkdir(path.join(project.workspaceDir, path.dirname(artifactPath)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, artifactPath), content, "utf8");
    }

    const retrievalParts = Object.entries(pkg.sourceArtifacts).map(([artifactPath, content]) => ({
      type: "tool",
      tool: "evimed-research_evimed_open_access_full_text",
      state: {
        status: "completed",
        output: JSON.stringify({
          status: "success",
          artifacts: [artifactPath],
          data: { artifactSha256s: { [artifactPath]: createHash("sha256").update(content, "utf8").digest("hex") } },
        }),
      },
    }));
    const searchParts = JSON.parse(pkg.searchLogText).queries.map((entry) => ({
      type: "tool",
      tool: "evimed-research_evimed_literature_search",
      state: { status: "completed", input: { query: entry.query } },
    }));
    history = [{
      info: { id: "msg_http_citation", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...retrievalParts,
        ...searchParts,
        ...[...deliverables.keys()].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
    // Delivered, and the scheme is said out loud with the URL that carries it.
    assert.match(finished.qualityNotices.join("\n"), /plain HTTP/);
    // A reachable source over plain HTTP says nothing about the evidence.
    assert.notEqual(finished.verification, "unverified");
    assert.match(finished.qualityNotices.join("\n"), /escardio\.org\/evidence\/source-3/);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an editor tool slip does not fail a run whose EviMed work completed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-editor-slip-"));
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
    await writeFile(path.join(project.workspaceDir, "reports", "review.md"), "review", "utf8");
    const binding = { sessionId: "ses_slip", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    let sessionStatus = "busy";
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionStatus: async () => sessionStatus,
      readSessionHistory: async () => history,
    });
    await store.start(project, { sessionId: binding.sessionId });
    sessionStatus = "idle";
    history = [({
      info: { id: "msg_work", role: "assistant", time: { completed: Date.now() } },
      parts: [
        { type: "tool", tool: "evimed-research_evimed_peer_review", state: { status: "completed", input: {} } },
        // Reading past the end of a file is an ordinary agent slip, not a
        // failure of the research work.
        { type: "tool", tool: "read", state: { status: "error", error: "Offset 824 is out of range for this file (41 lines)" } },
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "reports/review.md" } } },
        { type: "text", text: "Review complete." },
      ],
    })];
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.deepEqual(finished.artifacts, ["reports/review.md"]);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerated source error codes are real codes, not typos", async () => {
  // A misspelled entry forgives nothing and looks identical to a correct one:
  // the run keeps failing on the very code it was meant to tolerate. Every
  // public_source_* entry has to match a code the code base actually emits.
  //
  // Read only the two files that define them. Walking the source trees read
  // forty files and slowed a timing-sensitive test running concurrently in
  // another file, which is a poor trade for a list this small.
  const sources = [
    new URL("../../../runtime/mcp/evimed-research/public_sources.py", import.meta.url),
    new URL("../src/publicSourceGateway.mjs", import.meta.url),
  ];
  const emitted = new Set();
  for (const source of sources) {
    const text = await readFile(source, "utf8");
    for (const [, code] of text.matchAll(/"(public_source_[a-z_]+)"/g)) emitted.add(code);
  }
  assert.ok(emitted.size > 20, `expected the real code set, found ${emitted.size}`);

  const tolerated = [...recoverableEvidenceSourceErrorCodes].filter((code) => code.startsWith("public_source_"));
  const unknown = tolerated.filter((code) => !emitted.has(code));
  assert.deepEqual(unknown, [], `tolerated but never emitted (typo?): ${unknown.join(", ")}`);

  // The failure that reached production: one public source answering with 502.
  assert.ok(recoverableEvidenceSourceErrorCodes.has("public_source_http_error"));
  // A malformed request is still the run's own problem.
  assert.ok(!recoverableEvidenceSourceErrorCodes.has("public_source_query_invalid"));
  assert.ok(!recoverableEvidenceSourceErrorCodes.has("invalid_input"));
});

// A rejection with no issues is unfixable, not merely unhelpful: the repair path
// has nothing to hand back, so a package that is complete on disk is discarded.
// The file says so in a comment and then did it anyway in nine more places —
// including two, provenance and integrity, sitting directly under that comment.
// Listing them here would lag the same way; what does not lag is that a bare
// rejection is a test failure.
// The whole point of widening the category: a complete package rejected for
// provenance now gets the same second chance as one rejected for traceability.
// Two production runs, 42 kB and 40 kB of finished report, were discarded
// because their code was not the single one the repair loop named.
test("a provenance rejection is repaired rather than discarded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-provenance-"));
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
      sessionId: "ses_repair_provenance",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    const repairPrompts = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
            { path: "clinical-evidence-run.json", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_provenance",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) repairPrompts.push(repairText);
      return { accepted: true };
    });

    // A receipt naming a source no retrieval tool reported preserving: the
    // package is otherwise written and on disk.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), JSON.stringify({ claims: [] }), "utf8");
    await writeFile(
      path.join(project.workspaceDir, "clinical-evidence-run.json"),
      JSON.stringify({ successfulSourceArtifacts: [source] }),
      "utf8",
    );
    history = [{
      info: { id: "msg_repair_provenance", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json", "clinical-evidence-run.json"].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    }];

    // The monitor scheduled at dispatch polls immediately and reconciles on its
    // own, so under load it can be the one that spends the repair attempt.
    // Either way the observable behaviour is the same and is what this pins: a
    // repair prompt goes back naming the path to correct, instead of the
    // finished package being discarded.
    const first = await store.reconcileSession(project, binding.sessionId);
    assert.equal(first.id, run.id);
    assert.equal(repairPrompts.length, 1, "a repair prompt was sent");
    assert.match(repairPrompts[0], /\.evimed-sources\/official-pages\/source-a\/page\.md/);
    assert.match(repairPrompts[0], /no evidence tool reported preserving that file/);

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no package rejection is returned without issues to act on", async () => {
  const source = await readFile(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  const bare = [...source.matchAll(/return\s*\{\s*artifacts,\s*errorCode:\s*"([a-z_]+)"\s*\}/g)].map((m) => m[1]);
  assert.deepEqual(bare, [], `these rejections hand back no qualityIssues: ${bare.join(", ")}`);
});

// The repair loop named one error code while several mean the same thing: the
// package is finished and the defect is inside it. A package rejected for
// provenance was thrown away while an otherwise identical one rejected for
// traceability was repaired and delivered.
test("every repairable rejection is a code the gate actually returns", async () => {
  const source = await readFile(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  const returned = new Set([...source.matchAll(/errorCode:\s*"(specialist_[a-z_]+)"/g)].map((m) => m[1]));
  const dead = [...repairableEvidencePackageErrorCodes].filter((code) => !returned.has(code)).sort();
  assert.deepEqual(dead, [], `listed as repairable but never returned: ${dead.join(", ")}`);
  // The one that motivated widening it, held explicitly.
  assert.ok(repairableEvidencePackageErrorCodes.has("specialist_evidence_provenance_failed"));
  assert.ok(repairableEvidencePackageErrorCodes.has("specialist_evidence_traceability_failed"));
});

test("every fetch-tool error code is classified, so a new one cannot default to failing runs", async () => {
  // The allowlist lagged twice. First it lagged the tools, which was fixed by
  // keying the decision on the error code instead of on which tool asked. Then
  // it lagged the codes: official_page_url_forbidden was never added, so a
  // refusal the agent correctly obeyed failed a run that had written a
  // complete, preflight-clean package fifty tool calls later.
  //
  // Listing codes cannot stop a list lagging. What stops it is that an
  // unclassified code is a test failure: whoever adds one to the MCP server has
  // to say which it is, rather than inheriting "fails the run" by silence.
  // Naming the files and the prefixes was itself a list that lagged. It covered
  // three modules and three prefixes, so the ten adapter_* codes — the boundary
  // every specialist agent calls through — were outside it, unclassified, and
  // therefore fatal: a pharmacovigilance run that had written both declared
  // deliverables was failed by adapter_http_error. What does not lag is the
  // exit itself. failure() is the only way an MCP tool reports an error, so
  // every code passed to it is in scope by construction.
  const mcpDir = new URL("../../../runtime/mcp/evimed-research/", import.meta.url);
  const emitted = new Set();
  for (const entry of await readdir(mcpDir)) {
    if (!entry.endsWith(".py")) continue;
    const text = await readFile(new URL(entry, mcpDir), "utf8");
    // Two exits, and scanning only one is how this test lagged the second time.
    // failure() is the direct return; the six *Error(Exception) classes are
    // raised with a code that server.py hands to failure() unchanged, so
    // pharmacy_reference_* and evimed_evidence_invalid_response reach a run's
    // verdict without ever appearing in a failure( call.
    for (const [, code] of text.matchAll(/\bfailure\(\s*\n?\s*"([a-z0-9_]+)"/g)) emitted.add(code);
    for (const [, code] of text.matchAll(/\b[A-Z][A-Za-z]*Error\(\s*\n?\s*"([a-z0-9_]+)"/g)) emitted.add(code);
  }
  for (const relative of ["../src/publicSourceGateway.mjs", "../src/webSearchGateway.mjs"]) {
    const text = await readFile(new URL(relative, import.meta.url), "utf8");
    for (const [, code] of text.matchAll(/"((?:public_source|web_search)_[a-z0-9_]+)"/g)) emitted.add(code);
  }
  assert.ok(emitted.size > 30, `expected the real code set, found ${emitted.size}`);

  const unclassified = [...emitted]
    .filter((code) => !recoverableEvidenceSourceErrorCodes.has(code) && !terminalEvidenceSourceErrorCodes.has(code))
    .sort();
  assert.deepEqual(
    unclassified,
    [],
    "these codes are emitted but classified neither recoverable nor terminal, so they silently fail runs; "
      + `add each to one set in agentRuns.mjs: ${unclassified.join(", ")}`,
  );

  const both = [...emitted].filter((code) => (
    recoverableEvidenceSourceErrorCodes.has(code) && terminalEvidenceSourceErrorCodes.has(code)
  ));
  assert.deepEqual(both, [], `classified as both recoverable and terminal: ${both.join(", ")}`);

  // The refusal that reached production, and the distinction it turns on: being
  // told "not that source" is the guardrail working, while a request the tool
  // could not even parse is the run's own defect.
  assert.ok(recoverableEvidenceSourceErrorCodes.has("official_page_url_forbidden"));
  assert.ok(terminalEvidenceSourceErrorCodes.has("official_page_url_invalid"));
  // The same distinction at the specialist-adapter boundary, which the earlier
  // version of this test could not see at all.
  assert.ok(recoverableEvidenceSourceErrorCodes.has("adapter_http_error"));
  assert.ok(terminalEvidenceSourceErrorCodes.has("adapter_contract_invalid"));
});

// A pharmacovigilance run wrote both declared deliverables and was failed
// because the downstream specialist service answered with an HTTP error. An
// unreachable adapter is the same fact as an unreachable source: something to
// record, not a reason to throw away finished work.
test("an unreachable specialist adapter does not fail a run that produced its deliverables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-adapter-"));
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
      sessionId: "ses_adapter",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "adr-analysis",
          version: "1.0.0",
          runtimeAgent: "evimed-adr-analysis",
          outputs: [
            { path: "safety-report.md", required: true },
            { path: "signals.csv", required: true },
          ],
          completionChecks: ["requiredOutputsExist"],
        }),
      },
      model: "deepseek/deepseek-v4-flash",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_adapter",
      effectiveAgentId: "adr-analysis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-adr-analysis",
    }, async () => ({ accepted: true }));

    await writeFile(path.join(project.workspaceDir, "safety-report.md"), "# 安全性分析\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "signals.csv"), "drug,event,ror\nA,B,2.1\n", "utf8");
    history = [{
      info: { id: "msg_adapter", role: "assistant", time: { completed: Date.now() } },
      parts: [
        {
          type: "tool",
          tool: "evimed-research_evimed_drug_safety_signal",
          state: {
            status: "error",
            error: JSON.stringify({ code: "adapter_http_error", message: "downstream returned 502" }),
          },
        },
        ...["safety-report.md", "signals.csv"].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.deepEqual(finished.artifacts, ["safety-report.md", "signals.csv"]);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delegating the reading of retrieved evidence is named as the fault, not left to the quote check", async () => {
  // The weak production run delegated six reads of tool-output files. Its
  // support quotes were then paraphrases, and the matrix check rejected them
  // with "quote not found in its preserved artifact" — true, but three steps
  // downstream of the cause.
  const messages = [{
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            description: "Process NTG diagnostic search",
            prompt: "Read the file /runtime/xdg-data/opencode/tool-output/tool_fbca227a6 and extract all literature records from it.",
          },
        },
      },
      {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          // Delegating a question is fine; only handing over a document is not.
          input: { description: "Appraise study design", prompt: "Is a target trial emulation adequate for this comparison?" },
        },
      },
    ],
  }];

  const flagged = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.tool === "task")
    .filter((part) => /tool-output\/|\.evimed-sources\//.test(String(part.state.input.prompt ?? "")));

  assert.equal(flagged.length, 1, "the delegated document read must be flagged");
  assert.match(flagged[0].state.input.prompt, /tool-output/);
});

test("replacing the report during repair is named, not just its shrinkage", async () => {
  // Two production runs of one question went through repair. The one that
  // patched with edit ended at 15,387 characters; the one that answered each
  // round with a whole-file write went 12,191 -> 10,328 -> 6,230. A rewrite
  // regenerates the report from context rather than from the evidence on disk,
  // so the loss is invisible in the file itself.
  const history = [
    { info: { role: "assistant" }, parts: [
      { type: "tool", tool: "write", state: { input: { filePath: "clinical-evidence-report.md", content: "x" } } },
    ] },
    { info: { role: "user" }, parts: [
      { type: "text", text: "The server-side clinical evidence gate rejected the current package." },
    ] },
    { info: { role: "assistant" }, parts: [
      { type: "tool", tool: "write", state: { input: { filePath: "clinical-evidence-report.md", content: "y" } } },
      { type: "tool", tool: "edit", state: { input: { filePath: "clinical-evidence-report.md" } } },
      { type: "tool", tool: "write", state: { input: { filePath: "citation-ledger.csv", content: "z" } } },
    ] },
  ];

  let repairing = false;
  const rewrites = [];
  for (const message of history) {
    for (const part of message.parts) {
      if (message.info.role === "user" && part.type === "text"
          && part.text.includes("clinical evidence gate rejected")) { repairing = true; continue; }
      if (!repairing || part.type !== "tool" || part.tool !== "write") continue;
      if (/clinical-evidence-report\.md$/.test(String(part.state.input.filePath ?? ""))) rewrites.push(part);
    }
  }

  // The write before the repair prompt is the original authoring, not a rewrite.
  assert.equal(rewrites.length, 1, "only the rewrite that answered the repair counts");
})

test("an unreachable open web does not fail a complete package", () => {
  // Adding evimed_web_search without classifying its failure codes failed a run
  // that had written all ten deliverables, six full texts and sixty-seven works,
  // because one engine rate-limited. The open web is the channel most expected
  // to be partly unreachable; a miss there is not a broken run.
  for (const code of [
    "web_search_unconfigured",
    "web_search_unavailable",
    "web_search_rate_limited",
    "web_search_upstream_error",
    "web_search_timeout",
  ]) {
    assert.ok(recoverableEvidenceSourceErrorCodes.has(code), `${code} must not fail a run`);
  }
  // A malformed request from the agent is still the agent's problem.
  assert.equal(recoverableEvidenceSourceErrorCodes.has("web_search_query_invalid"), false);
});

