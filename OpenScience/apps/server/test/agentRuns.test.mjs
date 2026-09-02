import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import {
  AgentRunStore,
  artifactCandidatesForTest,
  clinicalEvidenceRepairPromptForTest,
  delegatedDocumentReadsForTest,
  loadedOrInjectedSkillsForTest,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  runPhaseHistory,
  terminalEvidenceSourceErrorCodes,
} from "../src/agentRuns.mjs";
import { workspaceLayout } from "@evimed/domain";
import { deepResearchPackage, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";
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

test("real kernel dispatch fails explicitly when the managed DeepSeek provider is disabled", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "os-agent-runs-provider-disabled-"));
  const app = createWebApiApp({
    dataDir,
    port: 0,
    runtimeMode: "kernel",
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
    // Progress events are timing-dependent — the fake kernel now records a real
    // session log, so a monitor poll between the two dispatches legitimately
    // observes one. What this test is about is run identity and the absence of
    // prompt content, so it asserts the identity events in order and that no
    // event outside the known vocabulary appears.
    const identity = events.filter((event) => event.event === "started" || event.event === "dispatch");
    assert.deepEqual(identity.map((event) => event.event), ["started", "dispatch", "started", "dispatch"]);
    for (const event of events) {
      assert.ok(["started", "dispatch", "progress", "notice", "finished"].includes(event.event), `unknown ledger event ${event.event}`);
    }
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
      effectiveAgentVersion: "2.9.0",
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
    // The classifier answers first now, so its confidence is the reason on a
    // route it made; the regex reason appears only where it acted as the net.
    const regex = await dispatchRun(base, "ses_reason_regex", "turn_reason_regex", "分析奥希替尼的 FAERS 药物警戒信号");
    assert.equal(regex.body.data.effectiveRouteReason, "llm:0.91");

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
    assert.equal(reasons.get("turn_reason_regex"), "llm:0.91");
    assert.equal(reasons.get("turn_reason_llm"), "llm:0.91");
    assert.equal(reasons.get("turn_reason_answer"), "unrouted:open-domain");
  }, {
    llmRoutingEnabled: true,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    specialistClassifierFetch,
  });
});

test("the classifier decides and the regex is the net under it", async () => {
  // The old order was regex-first, and a rule that matched ended the decision.
  // Six real requests for a clinical evidence review went elsewhere because
  // they mentioned meta-analyses, adverse reactions or a dataset — the
  // classifier was never asked. Now the model decides; the regex may only add a
  // route the model declined to make.
  const calls = [];
  const specialistClassifierFetch = async (_url, init) => {
    calls.push(String(init?.body ?? ""));
    // A brief that discusses published meta-analyses is a literature appraisal,
    // and the classifier is the one able to tell that from a request to run a
    // new meta-analysis. It answers "none" for the second query below.
    const declines = calls.at(-1).includes("奥希替尼");
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify(declines
              ? { agentId: "none", confidence: 0.9 }
              : { agentId: "meta-analysis", confidence: 0.95 }),
          },
        }],
      }),
    };
  };
  await withApp(async ({ base }) => {
    for (const id of ["ses_llm_a", "ses_llm_b"]) await bind(base, id, { mode: "open-domain" });

    // The classifier is consulted even where a regex rule would have matched.
    const netted = await dispatchRun(base, "ses_llm_a", "turn_llm_a", "分析奥希替尼的 FAERS 药物警戒信号");
    assert.equal(calls.length, 1, "the model was asked first");
    // Having declined, the safety net still delivers the specialty route.
    assert.equal(netted.body.data.effectiveAgentId, "adr-analysis");
    assert.equal(netted.body.data.effectiveRouteReason, "matched:adr-analysis");

    const classified = await dispatchRun(
      base,
      "ses_llm_b",
      "turn_llm_b",
      "帮我把这个研究方向整理成一个可执行的分析计划",
    );
    assert.equal(calls.length, 2);
    assert.equal(classified.body.data.effectiveAgentId, "meta-analysis");
    assert.equal(classified.body.data.effectiveRouteReason, "llm:0.95");
  }, {
    llmRoutingEnabled: true,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    specialistClassifierFetch,
  });
});

test("naming the package outranks the classifier, because it is an instruction", async () => {
  let asked = 0;
  const specialistClassifierFetch = async () => {
    asked += 1;
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ agentId: "meta-analysis", confidence: 0.99 }) } }],
      }),
    };
  };
  await withApp(async ({ base }) => {
    await bind(base, "ses_named", { mode: "open-domain" });
    const named = await dispatchRun(
      base,
      "ses_named",
      "turn_named",
      "请按 adr-analysis 出一份分析报告",
    );
    assert.equal(named.body.data.effectiveAgentId, "adr-analysis");
    assert.equal(named.body.data.effectiveRouteReason, "matched:named:adr-analysis");
    assert.equal(asked, 0, "an explicit name needs no classification");
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
    /** Browser-facing frames, in the order they were published. */
    const frames = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      onRunProjection: (_project, _run, type, data) => frames.push({ type, data }),
      onRunStateChanged: (_project, run) => frames.push({ type: "run/state", data: { state: run.status } }),
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
    await fn({ project, binding, dispatch, appendHistory, skillLoadedPart, store, frames });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("every fact the durable finish path reads, the live one reads too", async () => {
  // Three asymmetries were found by hand in one day, all the same shape: a fact
  // the receipt carries, read by `finishFromDurableRecord` and not by the path
  // that runs every time — the digest verification, the not-accepted verdict,
  // and the acceptance notices. Each silently changed the ledger depending on
  // whether the container happened to outlive the run.
  //
  // A fourth would be found the same way, by a person reading two functions
  // side by side, unless something asserts the property. Reading the source is
  // crude and it is exactly what the last three needed.
  const source = await readFile(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  const durableStart = source.indexOf("async finishFromDurableRecord(");
  const durableEnd = source.indexOf("async finishInternal(", durableStart);
  assert.ok(durableStart > 0 && durableEnd > durableStart, "could not locate finishFromDurableRecord");
  const durable = source.slice(durableStart, durableEnd);
  const receiptRead = source.indexOf("const finalReceipt = await readDeliveryReceipt(project);");
  assert.ok(receiptRead > 0, "the live path no longer reads the receipt at all");
  const liveStart = source.lastIndexOf("async reconcileSession(", receiptRead);
  const liveEnd = source.indexOf("/** Append what is observably happening", receiptRead);
  assert.ok(liveStart > 0 && liveEnd > receiptRead, "could not bound the live path");
  const live = source.slice(liveStart, liveEnd);

  for (const [fact, marker] of [
    ["receipt digests", "verifiedReceiptArtifacts"],
    ["acceptance notices", "entry.notices"],
    ["nothing accepted", "specialist_deliverable_not_accepted"],
    ["the run-state projection", "readRunStateProjection"],
  ]) {
    assert.ok(durable.includes(marker), `the durable path stopped reading ${fact} (${marker})`);
    assert.ok(live.includes(marker), `the live path does not read ${fact} (${marker}) — the durable path does, and they must agree`);
  }
});

test("the notices a package was accepted with reach the ledger on both paths", async () => {
  // `finishFromDurableRecord` has carried `receipt.entries[].notices` since it
  // was written. The live path never opened the receipt, so the advisory
  // findings the gate recorded at acceptance were reported only when the
  // container had already died: a package accepted with twenty-five advisory
  // notes reached the ledger with zero. Third asymmetry of this shape today —
  // a fact carried on the rare path and dropped on the ordinary one.
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    const body = "# graded and unchanged\n";
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), body, "utf8");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_notices",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{
          path: "deliverables/d1/clinical-evidence-report.md",
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: Buffer.byteLength(body),
        }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 4,
        notices: ["资料与方法声明了 GRADE，但结果与讨论中没有一处用它给出评级", "重复的一条"],
      }],
    }, null, 2), "utf8");

    await dispatch("turn_accepted_notices");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", (run.qualityNotices ?? []).join(" | "));
    assert.ok(
      (run.qualityNotices ?? []).some((line) => /GRADE/.test(String(line))),
      `the acceptance notices must travel: ${JSON.stringify(run.qualityNotices)}`,
    );
    // Deduplicated: a notice already admitted while the run was alive is the
    // same notice, and reporting it twice is the noise this whole area is about.
    const repeated = (run.qualityNotices ?? []).filter((line) => String(line) === "重复的一条");
    assert.equal(repeated.length, 1, "one notice, once");
  });
});

test("a deliverable no gate accepted is not a success, receipt or no receipt", async () => {
  // RQ-03 spent all seven attempts and its last submission was still two
  // required issues short. It wrote 「部分交付」 in its own summary and produced
  // no receipt — and the ledger recorded `succeeded` with 16 artifacts. The
  // digest check above cannot see this: there is nothing to compare against.
  // An absent durable record read as nothing to check rather than as nothing
  // accepted.
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    await mkdir(path.join(project.workspaceDir, ".evimed-run"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_unaccepted",
      plan: { revision: 1, items: [{ id: "d1", status: "submitted", attempts: 7 }] },
      budget: { steps: 57, tokens: 1, children: 1, limits: {} },
      evidence: { total: 0, byStatus: {} },
      gateRuns: [],
      subagents: [],
      qualityNotices: [],
      degraded: [],
    }, null, 2), "utf8");

    await dispatch("turn_never_accepted");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "failed", "seven rejections is not a success");
    assert.equal(run.errorCode, "specialist_deliverable_not_accepted");
    assert.ok(
      (run.qualityNotices ?? []).some((line) => /没有一件通过契约校验/.test(String(line))),
      "the verdict must say why",
    );
  });
});

test("an accepted deliverable and an answer-line turn are both still successes", async () => {
  // Two negative controls in one, because the rule above must not fire on a run
  // that passed, nor on one that never planned a deliverable at all — the
  // answer line plans none and produces no projection.
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    await mkdir(path.join(project.workspaceDir, ".evimed-run"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_accepted",
      plan: { revision: 1, items: [{ id: "d1", status: "accepted", attempts: 4 }] },
      budget: { steps: 30, tokens: 1, children: 1, limits: {} },
      evidence: { total: 0, byStatus: {} },
      gateRuns: [],
      subagents: [],
      qualityNotices: [],
      degraded: [],
    }, null, 2), "utf8");
    await dispatch("turn_accepted_item");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const passed = await store.reconcileSession(project, binding.sessionId);
    assert.equal(passed.status, "succeeded", (passed.qualityNotices ?? []).join(" | "));
  });

  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    await dispatch("turn_answer_only");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const answered = await store.reconcileSession(project, binding.sessionId);
    assert.equal(answered.status, "succeeded", "an answer-line turn plans no deliverable and must be unaffected");
  });
});

test("a run whose files drifted from its receipt does not ship, container alive or not", async () => {
  // The digest check was written for the container-gone path and only reached
  // there. With the container alive, reconciliation finished from the transcript
  // and never opened the receipt — so a run that kept editing after its package
  // was accepted was recorded `succeeded` with 16 artifacts while six of its
  // eight files differed from the digests they were accepted under. Nothing had
  // graded the bytes that shipped.
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store }) => {
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), "# edited after grading\n", "utf8");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_live",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{ path: "deliverables/d1/clinical-evidence-report.md", sha256: "0".repeat(64), bytes: 1 }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 6,
        notices: [],
      }],
    }, null, 2), "utf8");

    await dispatch("turn_receipt_drift");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "failed", "a package no gate has seen must not ship");
    assert.equal(run.errorCode, "specialist_receipt_digest_mismatch");
    assert.deepEqual(run.artifacts, []);
    assert.ok(
      (run.qualityNotices ?? []).some((line) => /digest the file no longer matches/.test(String(line))),
      "the verdict must say which file drifted",
    );
  });
});

test("a receipt whose digests still match does not block an ordinary success", async () => {
  // Negative control: the check must bite only on drift. Without it this pair
  // would pass with the verification stubbed out entirely.
  await withAnswerModeRun(async ({ project, binding, dispatch, appendHistory, skillLoadedPart, store, frames }) => {
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    const body = "# graded and unchanged\n";
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), body, "utf8");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_live_ok",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{
          path: "deliverables/d1/clinical-evidence-report.md",
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: Buffer.byteLength(body),
        }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 6,
        notices: [],
      }],
    }, null, 2), "utf8");

    await dispatch("turn_receipt_intact");
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", (run.qualityNotices ?? []).join(" | "));
    assert.equal(run.errorCode, null);

    // The path that runs every time publishes the receipt too, and before the
    // terminal state. This run writes no `.evimed-run/state.json` at all —
    // guarding the publish on a readable projection meant the receipt reached
    // the browser only when the container had also written one.
    const deliverable = frames.find((frame) => frame.type === "deliverable/update");
    assert.ok(deliverable, `no deliverable/update on the live path: ${JSON.stringify(frames)}`);
    assert.equal(deliverable.data.id, "d1");
    assert.equal(deliverable.data.status, "accepted");
    assert.equal(deliverable.data.receipt?.attempt, 6);
    assert.ok(
      frames.indexOf(deliverable) < frames.findIndex((frame) => frame.type === "run/state" && frame.data.state === "succeeded"),
      "a settled run closes its own stream, so a frame after the terminal state reaches nobody",
    );
  });
});

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
        tools: ["official_page_fetch"],
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

/** A run fixture whose root history and run-side projection are both scriptable. */
async function delegatingRunFixture(t, { stallPolls = 3 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = {
    id: "project-1", userId: "user-1", rootDir: root,
    metaDir: path.join(root, ".openscience"), workspaceDir: root,
  };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(path.join(root, ".evimed-run"), { recursive: true });
  const frames = [];
  const store = new AgentRunStore({ get: async () => ({ sessionId: "ses_deleg", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }) }, {
    model: "deepseek/deepseek-v4-pro",
    monitorIntervalMs: 1,
    monitorMaxPolls: 40,
    monitorStallPolls: stallPolls,
    // The root session never moves again after this: it delegated and is waiting.
    readSessionHistory: async () => [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "go" }] }],
    readSessionStatus: async () => "running",
    runtimeWorkspaceRoot: () => root,
    onRunProjection: (_project, _run, type, data) => frames.push({ type, data }),
  });
  const writeProjection = (value) => writeFile(path.join(root, ".evimed-run", "state.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return { root, project, store, frames, writeProjection };
}

test("a run whose subagents are working is not judged stalled because its root session went quiet", async (t) => {
  // The stall threshold reads the root session's message and tool-call counts,
  // and a delegated stretch is exactly when those stop moving on purpose: the
  // orchestrator hands work to children and waits. Before the run's own
  // projection was read, that was indistinguishable from a run that had died,
  // and the real clinical questions — the ones that delegate most — were the
  // ones most likely to be killed by it.
  const { project, store, writeProjection } = await delegatingRunFixture(t);
  let evidence = 1;
  await writeProjection({ evidence: { total: evidence, byStatus: { ready: evidence } }, budget: { children: 2 } });
  const run = await store.start(project, { sessionId: "ses_deleg" });

  // Children keep ingesting evidence while the root says nothing at all.
  const ticking = setInterval(() => {
    evidence += 1;
    void writeProjection({ evidence: { total: evidence, byStatus: { ready: evidence } }, budget: { children: 2 } });
  }, 2);
  await store.monitors.get(run.id)?.promise;
  clearInterval(ticking);

  const [finished] = await store.list(project);
  assert.notEqual(finished.errorCode, "runtime_monitor_stalled", "a delegating run was killed by the stall threshold");
  assert.equal(finished.errorCode, "runtime_monitor_timeout", "it should run out the window, not be judged dead");
});

test("a run-side projection that will not parse is a named notice, never evidence of a stall", async (t) => {
  // §14 rule 18. Counting an unreadable file as "did not move" would mean the
  // fix for stall misjudgement introduced a fresh source of it.
  const { project, store, writeProjection } = await delegatingRunFixture(t, { stallPolls: 2 });
  await writeProjection("{ this is not json");
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await store.monitors.get(run.id)?.promise;

  const [finished] = await store.list(project);
  assert.notEqual(finished.errorCode, "runtime_monitor_stalled", "an unreadable projection fed the stall counter");
  assert.ok(
    (finished.qualityNotices ?? []).some((line) => /state\.json/.test(line)),
    `the unreadable projection was never said out loud: ${JSON.stringify(finished.qualityNotices ?? [])}`,
  );
  // Said once, not once per poll: the monitor woke many times over the same file.
  assert.equal((finished.qualityNotices ?? []).filter((line) => /state\.json/.test(line)).length, 1);
});

test("projection frames are sent when the projection changes and not on every poll", async (t) => {
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0 });
  await writeProjection({ evidence: { total: 1, byStatus: { ready: 1 } }, budget: { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } } });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const afterFirst = frames.length;
  assert.ok(afterFirst >= 2, `the first read must send both frames, got ${JSON.stringify(frames)}`);
  assert.deepEqual(frames.filter((frame) => frame.type === "evidence/update")[0].data, { total: 1, byStatus: { ready: 1 } });
  assert.deepEqual(frames.filter((frame) => frame.type === "budget/update")[0].data, { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } });

  // Many more polls over an unchanged file must add nothing.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(frames.length, afterFirst, "an unchanged projection was republished");

  // Only what changed goes out again.
  await writeProjection({ evidence: { total: 2, byStatus: { ready: 2 } }, budget: { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const added = frames.slice(afterFirst);
  assert.ok(added.length >= 1, "a changed projection was not published");
  assert.ok(added.every((frame) => frame.type === "evidence/update"), `the budget was unchanged and must not be resent: ${JSON.stringify(added)}`);
  store.monitors.get(run.id)?.cancel();
});

test("a deliverable's verdict reaches the browser while the run is still repairing", async (t) => {
  // The stream has declared `deliverable/update` since it was written, the
  // browser has had the listener, the fold case and the `deliverables` array
  // since then, and nothing anywhere sent one — so the panel that shows why a
  // package was sent back was empty on every run that ever produced one.
  //
  // Published on the monitor's existing cycle, from the run's own plan index,
  // and debounced per deliverable: the index is rewritten whenever any item
  // moves, so digesting the whole list would resend every item every time one
  // of them was graded.
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0 });
  const plan = (items) => ({ plan: { revision: 1, items }, evidence: { total: 0, byStatus: {} }, budget: {} });
  await writeProjection(plan([
    { id: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "证据综述", status: "submitted", childSessionId: "child-1", attempts: 1, lastIssues: [] },
    { id: "d2", contractKind: "research-brief", capability: "research-brief", title: "简报", status: "planned", childSessionId: null, attempts: 0, lastIssues: [] },
  ]));
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const first = frames.filter((frame) => frame.type === "deliverable/update");
  assert.equal(first.length, 2, `both planned deliverables must be published once: ${JSON.stringify(first)}`);
  assert.deepEqual(first[0].data, {
    id: "d1",
    contractKind: "clinical-evidence-report",
    capability: "clinical-evidence-synthesis",
    title: "证据综述",
    status: "submitted",
    childSessionId: "child-1",
    issues: [],
  });
  assert.equal(first[1].data.childSessionId, null, "an undelegated item names no child rather than a made-up one");

  // Many more polls over an unchanged plan must add nothing.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(frames.filter((frame) => frame.type === "deliverable/update").length, 2, "an unchanged plan was republished");

  // Only the item that moved goes out again, and it carries the gate's own
  // issue list — which is exactly what the repair loop sends back to the run.
  await writeProjection(plan([
    {
      id: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "证据综述",
      status: "rejected", childSessionId: "child-1", attempts: 1,
      lastIssues: [
        { code: "claim_unquoted", message: "第 3 条结论没有逐字引用支撑", severity: "required", path: "clinical-evidence-report.md", line: 42 },
        { code: "section_share", message: "背景章节占比偏高", severity: "made-up-severity" },
      ],
    },
    { id: "d2", contractKind: "research-brief", capability: "research-brief", title: "简报", status: "planned", childSessionId: null, attempts: 0, lastIssues: [] },
  ]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const after = frames.filter((frame) => frame.type === "deliverable/update").slice(2);
  assert.equal(after.length, 1, `only the deliverable that moved must be resent: ${JSON.stringify(after)}`);
  assert.equal(after[0].data.status, "rejected");
  assert.deepEqual(after[0].data.issues, [
    { code: "claim_unquoted", message: "第 3 条结论没有逐字引用支撑", severity: "required", path: "clinical-evidence-report.md", line: 42 },
    // A severity the browser has no label for is shown as advisory rather than
    // dropped: losing the sentence is worse than mislabelling its urgency.
    { code: "section_share", message: "背景章节占比偏高", severity: "advisory" },
  ]);
  store.monitors.get(run.id)?.cancel();
});

test("a deliverable a run wrote under an unknown contract kind is published without a label it cannot render", async (t) => {
  // The plan index is a file the container wrote, so its contract kind is
  // input. A kind `@evimed/domain` does not know travels as an empty string —
  // the browser then says 契约种类未知 rather than printing an identifier at a
  // Chinese-reading researcher.
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0 });
  await writeProjection({
    plan: { revision: 1, items: [{ id: "d1", contractKind: "not-a-contract-kind", status: "not-a-status", capability: "x", title: "" }] },
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const published = frames.filter((frame) => frame.type === "deliverable/update");
  assert.equal(published.length, 1);
  assert.equal(published[0].data.contractKind, "");
  assert.equal(published[0].data.status, "planned", "a status outside PLAN_ITEM_STATES must not travel as one");
  assert.equal(published[0].data.title, "d1", "a titleless item falls back to its id rather than rendering blank");
  store.monitors.get(run.id)?.cancel();
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
    history = [...history, { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "health" }] }];
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
    // The browser asks the control plane for a session; it never asks a kernel.
    const createdResponse = await fetch(`${base}/api/runtime/sessions`, {
      method: "POST",
      headers: projectHeaders("default", true),
      body: "{}",
    });
    const session = (await createdResponse.json()).data;
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
      `${base}/api/runtime/sessions/${encodeURIComponent(session.id)}/transcript`,
      { headers: projectHeaders() },
    );
    const transcript = (await historyResponse.json()).data;
    assert.equal(transcript.messages.filter((message) => message.role === "user").length, 1);
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
            { path: "question-coverage.json", required: true },
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
      ["question-coverage.json", pkg.questionCoverageText],
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
            { path: "question-coverage.json", required: true },
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
      ["question-coverage.json", pkg.questionCoverageText],
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

// The repair budget is for repairing content. On 2026-08-26 one JSON syntax
// error in clinical-evidence-matrix.json came back as 24 content findings — a
// wall of symptoms with a single cause — and the package burned its rounds on
// a typo. A rejection whose whole issue list is one structural fact (the
// deliverable did not parse, a required file is absent) is now charged against
// a separate finite allowance, and this pins both halves: the exemption, and
// that a structural cause repeating unchanged still terminates.
test("a structural rejection does not spend the content repair budget, and still terminates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-structural-"));
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
      sessionId: "ses_repair_structural",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    // The dispatch-scheduled monitor reconciles on its own, and this test counts
    // repair rounds, so a background reconcile would be a second charge nobody
    // asked for. It is shut down below; until it is, the session reads busy and
    // the history is empty, so its in-flight poll can do nothing.
    let sessionStatus = "busy";
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
      // One content round, one structural round: the smallest budget that can
      // tell the two apart, and small enough that a third rejection has to end
      // the run rather than the test waiting on an allowance.
      maxClinicalRepairAttempts: 1,
      maxClinicalStructuralRepairAttempts: 1,
      readSessionHistory: async () => history,
      readSessionStatus: async () => sessionStatus,
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_structural",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) repairPrompts.push(repairText);
      return { accepted: true };
    });
    const monitor = store.monitors.get(run.id);
    monitor?.cancel();
    // Awaited, not just cancelled: cancellation takes effect at the end of the
    // poll already in flight, so only the settled promise proves no further
    // reconcile can land in the middle of the rounds counted below.
    await monitor?.promise;
    assert.equal(repairPrompts.length, 0, "the monitor sent nothing before it was stopped");
    sessionStatus = "idle";

    // A complete package on disk whose matrix does not parse. Nothing else is
    // wrong with it, and the run cannot be told anything else until it parses.
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), '{"claims": [', "utf8");
    await writeFile(
      path.join(project.workspaceDir, "clinical-evidence-run.json"),
      JSON.stringify({ successfulSourceArtifacts: [] }),
      "utf8",
    );
    const finishedTurn = (id) => ({
      info: { id, role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json", "clinical-evidence-run.json"].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    });

    history = [finishedTurn("msg_structural_1")];
    const first = await store.reconcileSession(project, binding.sessionId);
    assert.equal(first.id, run.id);
    assert.equal(first.status, "running");
    assert.equal(repairPrompts.length, 1, "the first structural rejection is repaired");
    // Verdict and issue text unchanged: the round is billed elsewhere, nothing
    // about what the run is told is softened.
    assert.match(repairPrompts[0], /clinical-evidence-matrix\.json must contain strict valid JSON/);
    assert.equal(
      store.clinicalRepairAttempts.get(run.id) ?? 0,
      0,
      "a structural round leaves the content repair budget untouched",
    );
    assert.equal(store.clinicalStructuralRepairAttempts.get(run.id), 1);

    // The same structural cause, unchanged. The allowance is spent, so this one
    // is charged to the ordinary budget exactly as it was before.
    history = [...history, finishedTurn("msg_structural_2")];
    const second = await store.reconcileSession(project, binding.sessionId);
    assert.equal(second.status, "running");
    assert.equal(repairPrompts.length, 2, "the allowance is finite, not a second budget");
    assert.equal(store.clinicalRepairAttempts.get(run.id), 1, "the second structural round is charged normally");
    assert.equal(store.clinicalStructuralRepairAttempts.get(run.id), 1, "the allowance does not refill");

    // Both budgets are gone: the run must end, not loop.
    history = [...history, finishedTurn("msg_structural_3")];
    const third = await store.reconcileSession(project, binding.sessionId);
    assert.equal(repairPrompts.length, 2, "a structural cause that repeats unchanged terminates");
    assert.equal(third.status, "failed");
    assert.equal(third.errorCode, "specialist_evidence_traceability_failed");

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The exemption is for a rejection that is *only* the structural fact. A check
// that already had something else to say about the same package makes the
// rejection two facts, and two facts are an ordinary repair round — otherwise
// the allowance would quietly pay for content findings that happened to arrive
// beside a parse error. `requiredSpecialistArtifacts` is the one place that can
// add to an issue list after the return site marked it, so it is the one place
// that takes the mark back; without that line this test's package would be
// billed to the structural allowance.
test("a structural rejection carrying an advisory as well is charged as an ordinary repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-structural-advisory-"));
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
      sessionId: "ses_repair_structural_advisory",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    let history = [];
    let sessionStatus = "busy";
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
          // citationsResolvable runs before the matrix is parsed and files its
          // findings as advisories, which is how a second fact reaches a
          // structural rejection at all.
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      maxClinicalStructuralRepairAttempts: 1,
      readSessionHistory: async () => history,
      readSessionStatus: async () => sessionStatus,
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_structural_advisory",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) repairPrompts.push(repairText);
      return { accepted: true };
    });
    const monitor = store.monitors.get(run.id);
    monitor?.cancel();
    await monitor?.promise;
    sessionStatus = "idle";

    // The same unparseable matrix as the structural case, plus one plain-HTTP
    // citation: reachable, so the claim stands and the gate only advises.
    await writeFile(
      path.join(project.workspaceDir, "clinical-evidence-report.md"),
      "# 报告\n\n正文，见 http://example.org/a 。\n",
      "utf8",
    );
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), '{"claims": [', "utf8");
    await writeFile(
      path.join(project.workspaceDir, "clinical-evidence-run.json"),
      JSON.stringify({ successfulSourceArtifacts: [] }),
      "utf8",
    );
    history = [{
      info: { id: "msg_structural_advisory_1", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json", "clinical-evidence-run.json"].map((filePath) => ({
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath } },
        })),
        { type: "text", text: "Completed." },
      ],
    }];

    const first = await store.reconcileSession(project, binding.sessionId);
    assert.equal(first.status, "running");
    assert.equal(repairPrompts.length, 1, "it is still repaired; only the billing is in question");
    // Both facts are in front of the run, unchanged in wording.
    assert.match(repairPrompts[0], /clinical-evidence-matrix\.json must contain strict valid JSON/);
    assert.match(repairPrompts[0], /served over plain HTTP/);
    assert.equal(
      store.clinicalRepairAttempts.get(run.id),
      1,
      "a rejection that is not attributable to the structural cause alone spends the content budget",
    );
    assert.equal(
      store.clinicalStructuralRepairAttempts.get(run.id) ?? 0,
      0,
      "and leaves the structural allowance untouched",
    );

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The stall guard exists to end a run that died. It counted a failed read as
// evidence of a stall, so a run working normally through a spell of 502s from
// its runtime was closed as runtime_monitor_stalled, with nothing recording
// that any read had failed. Unknown has to be its own answer.
// Progress is a live gauge, not history: only the latest observation of a run
// says anything. Appending every one put 7,800 progress rows in the ledger
// across 31 runs and left it 114 bytes under its one-megabyte limit, at which
// point no further run could start — the rows that cannot be dropped
// (started/dispatch/finished) were crowded out by rows that can.
test("repeated progress observations do not grow the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-ledger-growth-"));
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
    const binding = { sessionId: "ses_growth", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 5,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "busy",
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_growth",
    }, async () => ({ accepted: true }));

    const ledger = path.join(project.metaDir, "runs.jsonl");
    const sizes = [];
    for (let i = 1; i <= 40; i += 1) {
      history = Array.from({ length: i }, (_, n) => ({
        info: { id: `msg_${n}`, role: "assistant", time: { completed: Date.now() } },
        parts: [{ type: "text", text: "working" }],
      }));
      assert.equal(await store.recordProgress(project, run), true, `observation ${i} recorded`);
      sizes.push((await readFile(ledger, "utf8")).length);
    }
    // Forty observations, one row. The file does not stay byte-identical — the
    // observation counts widen from 1 to 40 — but it must not grow with the
    // number of observations, which is what filled it in production.
    assert.ok(
      sizes.at(-1) - sizes[0] < 20,
      `the ledger grew ${sizes.at(-1) - sizes[0]} bytes over forty observations`,
    );
    const rows = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.event === "progress" && row.id === run.id).length, 1);
    // And the rows that cannot be dropped are all still there.
    assert.equal(rows.filter((row) => row.event === "started").length, 1);
    assert.equal(rows.at(-1).messages, 40, "the surviving observation is the latest one");

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a progress read that fails is not counted as a run standing still", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-unreadable-"));
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
    const binding = { sessionId: "ses_unreadable", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      // Dispatch reads history too; only the progress poll must fail here.
      readSessionHistory: async (_project, _sessionId, { wake } = {}) => {
        if (wake === false) throw Object.assign(new Error("unavailable"), { code: "runtime_history_unavailable" });
        return [];
      },
      readSessionStatus: async () => "busy",
    });
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_unreadable",
    }, async () => ({ accepted: true }));

    // Unreadable is null — neither "moved" nor "did not move".
    const verdict = await store.recordProgress(project, run);
    assert.equal(verdict, null, "an unreadable history must not be reported as no progress");
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
  // The delivery gate names its own defects through clinicalEvidencePackageErrorCode
  // rather than as a literal here, so the classification table is the second
  // place a code is returned from. A code listed as repairable and present in
  // neither is dead, which is what this test exists to catch.
  // A missing deliverable that earns a code of its own is the third place, and
  // the reason it has one is exactly this set: the generic missing-output code
  // is discarded, so a deliverable that can be written from the finished package
  // is mapped to a repairable code instead.
  const missing = /const missingOutputErrorCodes = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  assert.ok(missing, "the missing-deliverable code table moved");
  for (const [, code] of missing[1].matchAll(/:\s*"(specialist_[a-z_]+)"/g)) returned.add(code);
  const gate = await readFile(new URL("../../../packages/domain/src/clinicalEvidence.mjs", import.meta.url), "utf8");
  const table = /const clinicalEvidenceIssueCodes = Object\.freeze\(\[([\s\S]*?)\n\]\);/.exec(gate);
  assert.ok(table, "the gate's error-code table moved");
  for (const [, code] of table[1].matchAll(/code:\s*"([a-z_-]+)"/g)) returned.add(code);
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
  for (const relative of ["../src/publicSourceGateway.mjs", "../src/webSearchGateway.mjs", "../src/geoProbeGateway.mjs"]) {
    const text = await readFile(new URL(relative, import.meta.url), "utf8");
    for (const [, code] of text.matchAll(/"((?:public_source|web_search|geo_probe)_[a-z0-9_]+)"/g)) emitted.add(code);
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
  // Adding web_search without classifying its failure codes failed a run
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


test("a package missing only the coverage ledger is repaired, not discarded", async () => {
  // Every package delivered before this deliverable existed is in exactly this
  // state: the report, the matrix, the search log and every citation artifact
  // are on disk, and the one file absent is the account of the brief's
  // questions — which is written from the others. The generic
  // specialist_required_output_missing is not repairable, so a code of its own
  // is what keeps the finished analysis out of the bin.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-coverage-missing-"));
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
      sessionId: "ses_coverage_missing",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const pkg = deepResearchPackage();
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
            { path: "question-coverage.json", required: true },
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
      dispatchId: "turn_coverage_missing",
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
      info: { id: "msg_coverage_missing", role: "assistant", time: { completed: Date.now() } },
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
    assert.equal(finished.errorCode, "specialist_question_coverage_missing");
    assert.ok(
      repairableEvidencePackageErrorCodes.has(finished.errorCode),
      "a package whose only absent file is the coverage ledger must go back for repair, not be thrown away",
    );
    // And it must hand back what to write, since the repair path has nothing to
    // pass on without it.
    assert.match(finished.qualityNotices.join("\n"), /question-coverage\.json is not in the workspace/);
    assert.match(finished.qualityNotices.join("\n"), /one entry per atomic sub-question/);
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the brief reaches the gate and the workspace, and never the run ledger", async () => {
  // The brief is what the coverage check compares the run's account against,
  // and it is several thousand characters. runs.jsonl has a byte ceiling that a
  // burst of progress events has already burst once, at 1048462 of 1048576, and
  // the run after it could not start — so the ledger keeps the 160-character
  // preview it always kept, and the brief itself lives in memory on the store.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-brief-"));
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
      sessionId: "ses_brief",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
    });
    const brief = researchBrief().replace(
      "## 交付",
      `## 检索范围\n\n${"以 PubMed、Europe PMC 为检索来源，记录检索式与命中数。".repeat(60)}检索截止于本次派发当日。\n\n## 交付`,
    );
    assert.ok(brief.length > 1600, "the fixture brief must be long enough to make the point");
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_brief",
      question: brief,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    // The ledger carries the preview and only the preview.
    const ledger = await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert.ok(run.question.length <= 161, `the ledger question must stay a preview: ${run.question.length}`);
    assert.ok(!ledger.includes("检索截止于本次派发当日"), "the brief body must not be written to runs.jsonl");
    assert.ok(ledger.length < brief.length, "the whole ledger must be smaller than one brief");

    // The gate's copy is the whole brief, held in memory on the store.
    assert.equal(store.dispatchedBriefs.get(run.id), brief);

    // The run's copy is on disk, byte-identical and read-only.
    const copyPath = path.join(project.workspaceDir, ".evimed-brief", "research-brief.md");
    assert.equal(await readFile(copyPath, "utf8"), brief);
    assert.equal((await stat(copyPath)).mode & 0o222, 0, "the run's copy must not be writable");

    // A terminal run releases it; a restart is the same state, and the gate is
    // told so rather than falling back to the copy the run can edit.
    await store.cancelSession(project, binding.sessionId);
    assert.equal(store.dispatchedBriefs.has(run.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- the semantic coverage judge in the delivery path ------------------------

/** A fake DeepSeek that answers with a verdict built from the excerpt it was
 *  actually sent: the first answered ledger entry, one of that entry's own
 *  declared lines, and a span copied verbatim out of that line. Nothing is
 *  hardcoded, so the test fails if the payload contract changes. */
function coverageJudgeFetchStub(calls) {
  return async (_url, init) => {
    calls.push(init);
    const payload = JSON.parse(JSON.parse(init.body).messages[1].content);
    const entry = payload.ledgerEntries.find(
      (item) => item.status === "answered" && item.declaredReportLines.length > 0,
    );
    const line = payload.reportExcerpt.find((item) => item.line === entry.declaredReportLines[0]);
    const verdicts = [{
      entryId: entry.entryId,
      kind: "answer-not-responsive",
      reportLine: line.line,
      quote: line.text.trim().slice(0, 24),
      why: "该行给出的是另一人群的数据，不是这一子问所问的那一层。",
    }];
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdicts }) } }] }),
    };
  };
}

/** Deliver the shared fixture package through the store and return the terminal
 *  run, with whatever coverage judge the caller supplies.
 *
 *  `finished` is the delivery decision as reconcileSession returned it.
 *  `delivered` is what a later reader of /api/agent-runs sees, after every
 *  coverage judgement still in flight at delivery time has landed.
 *  `forgetBrief` drops the server's in-memory copy of the brief before the gate
 *  runs, which is exactly the state a restart leaves a run in.
 *  @param {string} label @param {Record<string, any>} options */
async function deliverClinicalPackage(label, {
  coverageJudge = null,
  mutate = null,
  forgetBrief = false,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `os-agent-run-${label}-`));
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
    sessionId: `ses_${label}`,
    mode: "open-domain",
    agentId: null,
    agentVersion: null,
    runtimeAgent: null,
  };
  const pkg = deepResearchPackage();
  mutate?.(pkg);
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
          { path: "question-coverage.json", required: true },
        ],
        completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
      }),
    },
    coverageJudge,
    model: "deepseek/deepseek-v4-pro",
    monitorIntervalMs: 60_000,
    monitorMaxPolls: 20,
    readSessionHistory: async () => history,
    readSessionStatus: async () => "idle",
    maxClinicalRepairAttempts: 0,
  });
  store.scheduleMonitor = () => {};
  const run = await store.dispatch(project, {
    sessionId: binding.sessionId,
    dispatchId: `turn_${label}`,
    question: pkg.briefText,
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
    ["question-coverage.json", pkg.questionCoverageText],
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
    info: { id: `msg_${label}`, role: "assistant", time: { completed: Date.now() } },
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
  if (forgetBrief) store.dispatchedBriefs.delete(run.id);
  const finished = await store.reconcileSession(project, binding.sessionId);
  assert.equal(finished.id, run.id);
  // The judgement is no longer awaited by the delivery decision, so read the
  // run again once it has landed — this is the reader's view, not the gate's.
  await store.settleCoverageJudgements();
  const delivered = (await store.list(project)).find((item) => item.id === run.id);
  await store.closeProject(project, "canceled");
  await rm(root, { recursive: true, force: true });
  return { finished, delivered, store, runId: run.id };
}

test("a semantic coverage verdict rides on a delivered package as a notice, and never withholds it", async () => {
  const { CoverageJudge } = await import("../src/coverageJudge.mjs");
  const calls = [];
  const coverageJudge = new CoverageJudge({
    coverageJudgeEnabled: true,
    deepseekProviderEnabled: true,
    deepseekApiKey: "sk-test",
    deepseekBaseUrl: "https://api.deepseek.com",
    deepseekModel: "deepseek-v4-pro",
    production: false,
  }, { fetchImpl: coverageJudgeFetchStub(calls) });

  const { finished, delivered, store, runId } = await deliverClinicalPackage("judge", { coverageJudge });
  assert.equal(calls.length, 1, "one finished run, one model call");
  // The judgement is a notice about meaning; it cannot fail a package.
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.errorCode, null);
  assert.notEqual(finished.verification, "unverified");
  // It reaches the reader through the run ledger, which is what /api/agent-runs
  // serves, rather than through the terminal event the gate wrote.
  assert.match(delivered.qualityNotices.join("\n"), /语义覆盖判定/);
  assert.match(delivered.qualityNotices.join("\n"), /台账条目 1\.1/);
  assert.match(delivered.qualityNotices.join("\n"), /未经核对/);
  // And it changed nothing about the delivery itself.
  assert.equal(delivered.status, "succeeded");
  assert.equal(delivered.errorCode, null);
  assert.deepEqual(delivered.artifacts, finished.artifacts);
  assert.equal(delivered.finishedAt, finished.finishedAt);
  assert.equal(delivered.verification, finished.verification);
  // The brief went to the judge, but the run ledger still holds only a preview.
  assert.equal(store.coverageJudgements.has(runId), false, "a settled judgement releases its cache entry");
});

test("the delivery decision does not wait for the judgement", async () => {
  // 29 live judgements: median 161 s, max 226 s. reconcileSession is awaited by
  // the dispatch and start HTTP handlers, so awaiting the judge here was three
  // minutes of a user's request spent on something that cannot change the
  // answer. The gate must return while the model is still thinking.
  let release = () => {};
  const started = [];
  const coverageJudge = {
    judge: (context) => new Promise((resolve) => {
      started.push(context);
      release = () => resolve({ notices: ["语义覆盖判定（不阻断交付）：迟到的结论。"], judged: true, verdicts: [] });
    }),
  };
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-judge-async-"));
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
    const store = new AgentRunStore({ get: async () => null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      coverageJudge,
    });
    store.scheduleMonitor = () => {};
    const binding = { sessionId: "ses_async", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const { run } = await store.reserveRun(project, binding, { baselineCursor: null });
    const pending = store.scheduleCoverageJudgement(project, run.id, { entries: [] });
    assert.equal(started.length, 1, "the judge was started");

    // The run reaches its terminal state with the model still running.
    const finished = await store.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
    });
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.qualityNotices, [], "nothing waited for the judge");

    release();
    await pending;
    const delivered = (await store.list(project)).find((item) => item.id === run.id);
    assert.deepEqual(delivered.qualityNotices, ["语义覆盖判定（不阻断交付）：迟到的结论。"]);
    // Attached without reopening the run.
    assert.equal(delivered.status, "succeeded");
    assert.equal(delivered.finishedAt, finished.finishedAt);
    assert.equal(delivered.durationMs, finished.durationMs);
    assert.equal(delivered.verification, null, "a judgement that ran does not mark the run unchecked");
    await store.settleCoverageJudgements();
    assert.equal(store.coverageJudgements.has(run.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a judgement that arrives before the run finishes is not overwritten by the terminal event", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-judge-early-"));
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
    const store = new AgentRunStore({ get: async () => null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      coverageJudge: { judge: async () => ({ notices: ["语义覆盖判定：早到的结论。"], judged: false, verdicts: [] }) },
    });
    store.scheduleMonitor = () => {};
    const binding = { sessionId: "ses_early", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const { run } = await store.reserveRun(project, binding, { baselineCursor: null });
    await store.scheduleCoverageJudgement(project, run.id, { entries: [] });
    const running = (await store.list(project)).find((item) => item.id === run.id);
    assert.equal(running.status, "running", "a notice must not finish a run");
    assert.deepEqual(running.qualityNotices, ["语义覆盖判定：早到的结论。"]);

    const finished = await store.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
      qualityNotices: ["门禁自己的说明。"],
    });
    // The gate's own notices lead; the early judgement survives behind them.
    assert.deepEqual(finished.qualityNotices, ["门禁自己的说明。", "语义覆盖判定：早到的结论。"]);
    // And so does the admission it carried: a terminal event that says nothing
    // about verification must not silently overwrite one that already did.
    assert.equal(finished.verification, "unchecked");
    assert.equal((await store.list(project)).find((item) => item.id === run.id).verification, "unchecked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the judge is asked at most once per run, however many times the delivery decision is reached", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-judge-once-"));
  try {
    let calls = 0;
    const store = new AgentRunStore({ get: async () => null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      coverageJudge: {
        judge: async () => {
          calls += 1;
          return { notices: ["语义覆盖判定：一处疑点。"], judged: true, verdicts: [] };
        },
      },
    });
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const first = await store.scheduleCoverageJudgement(project, "run_1", { entries: [] });
    const second = await store.scheduleCoverageJudgement(project, "run_1", { entries: [] });
    assert.equal(calls, 1, "a repeat pass over the same finished run must reuse the answer");
    assert.deepEqual(first, second);
    // In flight, not merely already resolved: two monitor passes landing
    // together must not both issue a call.
    await Promise.all([
      store.scheduleCoverageJudgement(project, "run_2", { entries: [] }),
      store.scheduleCoverageJudgement(project, "run_2", { entries: [] }),
    ]);
    assert.equal(calls, 2);
    // Nothing judgeable is nothing to pay for, and nothing to remember either.
    assert.equal(store.scheduleCoverageJudgement(project, "run_3", null), null);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a coverage judge that throws leaves the finished package exactly as it was", async () => {
  const coverageJudge = { judge: async () => { throw new Error("judge exploded"); } };
  const { finished, delivered } = await deliverClinicalPackage("judge-throws", { coverageJudge });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.errorCode, null);
  assert.equal(delivered.status, "succeeded");
  assert.equal(delivered.errorCode, null);
  assert.doesNotMatch(delivered.qualityNotices.join("\n"), /语义覆盖判定/);
  assert.equal(delivered.verification, null);
});

test("a judge that was asked and could not answer marks the delivery unchecked", async () => {
  // The one thing that must not happen is the degraded notice riding on a run
  // whose machine-readable verdict still reads "nothing to report".
  const coverageJudge = {
    judge: async () => ({
      notices: ["本次交付未做语义覆盖判定（「所引正文是否真的在回答这一问」这一层）：判定模型不可用（timeout）。"],
      judged: false,
      verdicts: [],
    }),
  };
  const { finished, delivered } = await deliverClinicalPackage("judge-declined", { coverageJudge });
  assert.equal(finished.status, "succeeded");
  assert.equal(delivered.status, "succeeded", "an admission never reopens a run");
  assert.equal(delivered.errorCode, null);
  assert.match(delivered.qualityNotices.join("\n"), /未做语义覆盖判定/);
  assert.equal(delivered.verification, "unchecked");
});

test("no coverage judge configured delivers exactly as before", async () => {
  const { finished, delivered } = await deliverClinicalPackage("judge-absent");
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.errorCode, null);
  // A deployment that never turned the judge on is not an unchecked delivery:
  // a mark on every run of every such deployment would mean nothing.
  assert.equal(delivered.verification, null);
  assert.deepEqual(delivered.qualityNotices, finished.qualityNotices);
});

test("the judge is not consulted while a blocking issue is still holding the package", async () => {
  // A model call on a package that is going back round the repair loop is a
  // cost with no reader on the other end.
  let calls = 0;
  const coverageJudge = {
    judge: async () => {
      calls += 1;
      return { notices: [], judged: true, verdicts: [] };
    },
  };
  const { finished } = await deliverClinicalPackage("judge-blocked", {
    coverageJudge,
    mutate: (pkg) => { pkg.matrix.claims[0].supportQuote = "这句话在它所引的来源里并不存在。"; },
  });
  // The package is delivered — a reader is better served by the analysis plus
  // the list of what could not be verified — but it carries a blocking-grade
  // finding, and that is the state in which a semantic opinion is noise.
  assert.match(finished.qualityNotices.join("\n"), /supportQuote was not found in its preserved source artifact/);
  assert.equal(calls, 0);
});

// --- "not checked" is not "checked and clean" --------------------------------

/** Drop the ledger entry that accounts for the brief's second question, so the
 *  package is complete and self-consistent and answers one question fewer than
 *  it was asked. @param {any} pkg */
function dropSecondQuestionEntry(pkg) {
  const ledger = JSON.parse(pkg.questionCoverageText);
  ledger.entries = ledger.entries.filter((entry) => !String(entry.id).startsWith("2."));
  pkg.questionCoverageText = JSON.stringify(ledger);
}

test("a delivery whose coverage check could not run says so in the field operations reads", async () => {
  // Measured, same package, only the availability of the brief changed:
  //   brief in hand   → succeeded / unverified / "MUST FIX — 题面第 2 问…"
  //   brief lost      → succeeded / null       / one degradation notice
  // The second is the more dangerous state and read as the safer one: null is
  // the value a package that passed every check carries.
  const withBrief = await deliverClinicalPackage("coverage-brief", { mutate: dropSecondQuestionEntry });
  assert.equal(withBrief.finished.status, "succeeded");
  assert.equal(withBrief.finished.verification, "unverified");
  assert.match(withBrief.finished.qualityNotices.join("\n"), /MUST FIX/);
  assert.match(withBrief.finished.qualityNotices.join("\n"), /第 2 问/);

  const withoutBrief = await deliverClinicalPackage("coverage-restart", {
    mutate: dropSecondQuestionEntry,
    forgetBrief: true,
  });
  assert.equal(withoutBrief.finished.status, "succeeded", "a lost brief is not the run's fault");
  assert.equal(
    withoutBrief.finished.verification,
    "unchecked",
    "a layer that did not run must not be reported as a layer that found nothing",
  );
  // The human-readable explanation is kept exactly as it was.
  assert.match(withoutBrief.finished.qualityNotices.join("\n"), /未按题面逐问核对覆盖/);
  // And the reader of /api/agent-runs gets the field, not just the prose.
  assert.equal(withoutBrief.delivered.verification, "unchecked");
  assert.notEqual(withoutBrief.finished.verification, withBrief.finished.verification);
});

test("a clean package with every layer run stays null, and a finding still outranks an admission", async () => {
  // Null must keep meaning "checked, nothing to report", or the third value
  // buys nothing.
  const clean = await deliverClinicalPackage("coverage-clean");
  assert.equal(clean.finished.status, "succeeded");
  assert.equal(clean.finished.verification, null);

  // Brief lost AND a blocking finding of another kind: "we checked and it did
  // not hold up" is the more serious statement and is the one shown.
  const both = await deliverClinicalPackage("coverage-both", {
    forgetBrief: true,
    mutate: (pkg) => { pkg.matrix.claims[0].supportQuote = "这句话在它所引的来源里并不存在。"; },
  });
  assert.equal(both.finished.verification, "unverified");
  assert.match(both.finished.qualityNotices.join("\n"), /未按题面逐问核对覆盖/);
});

test("GET /api/agent-runs serves the unchecked verdict and the notice that landed after delivery", async () => {
  // The whole point of a machine-readable third value is that the machines
  // reading it get it. This is the route operations and the UI actually read.
  await withApp(async ({ base, dataDir }) => {
    const ledgerDir = path.join(dataDir, "users", "dev", "projects", "default", ".openscience");
    await mkdir(ledgerDir, { recursive: true });
    const timestamp = "2026-08-16T00:00:00.000Z";
    const events = [
      {
        event: "started",
        id: "run_0001",
        sessionId: "ses_0001",
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
        model: "deepseek/deepseek-v4-pro",
        createdAt: timestamp,
        startedAt: timestamp,
      },
      {
        event: "finished",
        id: "run_0001",
        status: "succeeded",
        errorCode: null,
        artifacts: [],
        verification: "unchecked",
        qualityNotices: ["本次交付未按题面逐问核对覆盖。"],
        finishedAt: timestamp,
        durationMs: 1,
      },
      {
        event: "notice",
        id: "run_0001",
        at: timestamp,
        qualityNotices: ["语义覆盖判定（不阻断交付）：1 处疑点。"],
      },
    ];
    await writeFile(
      path.join(ledgerDir, "runs.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    const listed = await listRuns(base);
    assert.equal(listed.response.status, 200);
    const run = listed.body.data.find((item) => item.id === "run_0001");
    assert.equal(run.status, "succeeded");
    assert.equal(run.verification, "unchecked");
    assert.deepEqual(run.qualityNotices, [
      "本次交付未按题面逐问核对覆盖。",
      "语义覆盖判定（不阻断交付）：1 处疑点。",
    ]);
  });
});

test("a stored verification value outside the three is read as null", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-verification-"));
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
    const store = new AgentRunStore({ get: async () => null }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
    });
    store.scheduleMonitor = () => {};
    const binding = { sessionId: "ses_v", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const { run } = await store.reserveRun(project, binding, { baselineCursor: null });
    const finished = await store.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
      verification: "definitely-fine",
    });
    assert.equal(finished.verification, null);
    const unchecked = await store.reserveRun(project, { ...binding, sessionId: "ses_v2" }, { baselineCursor: null });
    const second = await store.finishInternal(project, unchecked.run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
      verification: "unchecked",
    });
    assert.equal(second.verification, "unchecked", "the third value survives a round trip through the ledger");
    assert.equal(
      (await store.list(project)).find((item) => item.id === unchecked.run.id).verification,
      "unchecked",
    );
    // An admission may not overwrite a finding, whichever order they arrive in.
    const found = await store.reserveRun(project, { ...binding, sessionId: "ses_v3" }, { baselineCursor: null });
    await store.finishInternal(project, found.run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
      verification: "unverified",
    });
    const after = await store.appendQualityNotices(project, found.run.id, ["某一层没跑。"], { unchecked: true });
    assert.equal(after.verification, "unverified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Shutdown used to cancel a monitor and return immediately. A monitor reads its
// cancel flag between polls, so one that was mid-poll kept going: it wrote to a
// project directory the caller had already finished with, and the failure
// surfaced as "agent run not found" somewhere unrelated. It only reproduced
// under load, which is the worst kind of true.
test("closing a project waits for its monitor instead of only asking it to stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-close-"));
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
    const binding = { sessionId: "ses_close", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let reads = 0;
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      // An interval far longer than this test may take, so a close that waited
      // out the sleep instead of interrupting it would time the test out rather
      // than pass slowly and unnoticed.
      monitorIntervalMs: 10 * 60_000,
      monitorMaxPolls: 50,
      readSessionHistory: async () => {
        reads += 1;
        return [];
      },
      readSessionStatus: async () => "busy",
    });
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_close" }, async () => ({ accepted: true }));

    const startedAt = Date.now();
    await store.closeProject(project, "canceled");
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 30_000, `closeProject took ${elapsed} ms; a cancel must interrupt the sleep, not wait it out`);
    assert.equal(store.monitors.has(run.id), false, "a closed project leaves no monitor behind");

    // And nothing touches the project's storage afterwards. The read counter is
    // the observable proxy: a monitor still alive would keep polling.
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads, after, "a monitor kept polling after its project was closed");

    const runs = await store.list(project);
    assert.equal(runs.find((item) => item.id === run.id)?.status, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// §7.1.1 (decision 2026-08-24 #20): `phase` is what `list()` adds beside the
// ledger's own four-value `status` — computed, never stored, and reachable
// from an ordinary dispatch → progress → finish sequence without needing
// anything the ledger does not already record today.
test("list() exposes the phase projection beside the ledger's own status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-phase-"));
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
    const binding = { sessionId: "ses_phase", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "busy",
    });
    store.scheduleMonitor = () => {};

    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_phase" }, async () => ({ accepted: true }));

    // Freshly dispatched, no progress observed yet: `dispatched`, not `reserved`
    // — this store always accepts a dispatch synchronously (`dispatchStatus`
    // never lingers at `dispatching` once the sender has been awaited).
    const beforeProgress = (await store.list(project)).find((item) => item.id === run.id);
    assert.equal(beforeProgress.status, "running");
    assert.equal(beforeProgress.phase, "dispatched");
    assert.equal(beforeProgress.phaseIllegalTransitions, 0);
    assert.equal("phaseNotices" in beforeProgress, false, "a clean sequence carries no notices at all");

    history = [{ info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: "working" }] }];
    assert.equal(await store.recordProgress(project, run), true);
    const whileRunning = (await store.list(project)).find((item) => item.id === run.id);
    assert.equal(whileRunning.phase, "running");

    await store.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
    const succeededClean = (await store.list(project)).find((item) => item.id === run.id);
    assert.equal(succeededClean.status, "succeeded");
    assert.equal(succeededClean.phase, "accepted", "no verification concern and not partial: accepted, not degraded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run degraded by unverified content projects the degraded phase, and canceled/failed project straight across", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-phase-degraded-"));
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
    const store = new AgentRunStore({ get: async (_p, sessionId) => ({ sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }) }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
      readSessionStatus: async () => "busy",
    });
    store.scheduleMonitor = () => {};

    const degraded = await store.dispatch(project, { sessionId: "ses_degraded", dispatchId: "turn_degraded" }, async () => ({ accepted: true }));
    await store.finishInternal(project, degraded.id, { status: "succeeded", artifacts: [], verification: "unverified" });

    const canceled = await store.dispatch(project, { sessionId: "ses_canceled", dispatchId: "turn_canceled" }, async () => ({ accepted: true }));
    await store.finishInternal(project, canceled.id, { status: "canceled", artifacts: [] });

    const failed = await store.dispatch(project, { sessionId: "ses_failed", dispatchId: "turn_failed" }, async () => ({ accepted: true }));
    await store.finishInternal(project, failed.id, { status: "failed", artifacts: [], errorCode: "runtime_tool_error" });

    const byId = new Map((await store.list(project)).map((item) => [item.id, item]));
    assert.equal(byId.get(degraded.id).phase, "degraded");
    assert.equal(byId.get(canceled.id).phase, "canceled");
    assert.equal(byId.get(failed.id).phase, "failed");
    // Terminal phases are exactly the ledger's four terminal statuses read
    // straight across, none of them flagged as an illegal sequence.
    for (const record of byId.values()) assert.equal(record.phaseIllegalTransitions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The adjacency check itself, direct: a sequence `foldEvents` accepts (a
// terminal event only ever requires `status === "running"`, never checking
// `dispatchStatus` for consistency) but that the *phase* table calls illegal —
// finishing a run while it is still formally awaiting dispatch acknowledgment,
// with no `dispatch` event ever landing in between. Not reachable through
// `AgentRunStore`'s public API (which is exactly why this mechanism exists as
// a read-time diagnostic rather than a write-time gate: the ledger is allowed
// to contain sequences nothing written after this design existed would ever
// produce).
test("runPhaseHistory counts and names an illegal phase sequence instead of throwing", () => {
  const events = [
    { event: "started", id: "run_1", dispatchId: "turn_1", sessionId: "ses_1", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null, model: "deepseek/deepseek-v4-pro", createdAt: "2026-08-24T00:00:00.000Z", startedAt: "2026-08-24T00:00:00.000Z" },
    { event: "finished", id: "run_1", status: "succeeded", finishedAt: "2026-08-24T00:00:01.000Z", durationMs: 1000, artifacts: [] },
  ];
  const result = runPhaseHistory(events, "run_1");
  assert.equal(result.phase, "accepted", "the final phase is still reported — a diagnostic, not a refusal to answer");
  assert.equal(result.illegalTransitions, 1);
  assert.deepEqual(result.notices, ["illegal_state_transition: reserved -> accepted"]);

  // The ordinary path — dispatch acknowledged before the run finishes — is not
  // flagged, whatever order the acknowledgment and the terminal event actually
  // reach the ledger's ordinary shape in.
  const ordinary = runPhaseHistory([
    events[0],
    { event: "dispatch", id: "run_1", status: "accepted" },
    events[1],
  ], "run_1");
  assert.equal(ordinary.illegalTransitions, 0);
  assert.deepEqual(ordinary.notices, []);
});

// The SSE `run/state` frame's `phase` field and the HTTP `/api/agent-runs`
// list's `phase` field both trace back to this one call site: every push
// notification passes through `notifyState`, which is the choke point that has
// to attach `phase` so `onRunStateChanged` — server.mjs's callback that
// publishes the SSE frame — never sees a record without it.
test("every state-change notification carries the phase projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-notify-phase-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const seen = [];
    const store = new AgentRunStore({ get: async (_p, sessionId) => ({ sessionId, mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }) }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
      onRunStateChanged: (_project, run) => seen.push(run.phase),
    });
    store.scheduleMonitor = () => {};

    const run = await store.dispatch(project, { sessionId: "ses_notify", dispatchId: "turn_notify" }, async () => ({ accepted: true }));
    assert.equal(seen.at(-1), "dispatched", "the dispatch notification itself carries the phase, not just list() later");

    await store.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
    assert.equal(seen.at(-1), "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run whose container is already gone is judged from its receipt, not failed for being gone", async () => {
  // The timing this pins: the kernel ends its turn, the container exits, and
  // the control plane reconciles a moment later. Reading the transcript is
  // impossible by then — it lives only inside the container — and the ledger
  // recorded `failed / artifacts 0` for a run that had written a complete,
  // valid deliverable set. The durable receipt is what decides now.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-durable-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const body = "# report\n";
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), body, "utf8");
    const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_x",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{ path: "deliverables/d1/clinical-evidence-report.md", sha256, bytes: Buffer.byteLength(body) }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 1,
        notices: ["one advisory"],
      }],
    }, null, 2), "utf8");

    const binding = { sessionId: "ses_gone", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let alive = true;
    // Both browser-facing hooks, on one list, so their relative order is
    // observable rather than assumed.
    const frames = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      onRunProjection: (_project, _run, type, data) => frames.push({ type, data }),
      onRunStateChanged: (_project, run) => frames.push({ type: "run/state", data: { state: run.status } }),
      // The real sequence: the container is alive when the run starts (the
      // baseline is captured from it) and gone by the time anything reconciles.
      readSessionHistory: async () => {
        if (alive) { alive = false; return []; }
        const error = new Error("gone");
        error.code = "runtime_not_running";
        throw error;
      },
      monitorIntervalMs: 60_000,
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    // Asserted on the ledger rather than on this call's return value: `start`
    // also schedules the monitor, which reconciles on its own, and the run's
    // recorded outcome is what the rest of the system reads either way.
    await store.reconcileSession(project, binding.sessionId).catch(() => {});
    const finished = (await store.list(project)).find((item) => item.id === started.id);

    assert.equal(finished?.status, "succeeded", "a receipt that verifies is a delivered run, whatever became of the container");
    assert.deepEqual(finished?.artifacts, ["deliverables/d1/clinical-evidence-report.md"]);
    assert.deepEqual(finished?.qualityNotices, ["one advisory"]);

    // And the receipt reaches the browser, ahead of the terminal state.
    //
    // Order is the assertion, not a detail: a settled run closes its own stream
    // client-side (`runIsSettled`), so a deliverable frame published after the
    // terminal `run/state` arrives at nobody. That is the same
    // looks-like-nothing-happened failure the panel was built to end.
    const deliverable = frames.find((frame) => frame.type === "deliverable/update");
    assert.ok(deliverable, `no deliverable/update was published: ${JSON.stringify(frames)}`);
    assert.equal(deliverable.data.id, "d1");
    assert.equal(deliverable.data.receipt?.attempt, 1);
    assert.deepEqual(deliverable.data.receipt?.files, [
      { path: "deliverables/d1/clinical-evidence-report.md", sha256, bytes: Buffer.byteLength(body) },
    ]);
    assert.deepEqual(deliverable.data.receipt?.notices, ["one advisory"]);
    assert.ok(
      frames.indexOf(deliverable) < frames.findIndex((frame) => frame.type === "run/state" && frame.data.state === "succeeded"),
      "the receipt must be published before the terminal state a watching tab closes on",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-injected skill counts as loaded, because the model is never asked to load it", async () => {
  // `skillsLoaded` was judged by scanning the transcript for `tool/call{skill}`.
  // Delegation puts the capability's skill bodies inside the child's prompt —
  // that is what `skills[]` in a capability manifest is for — so the model has
  // no reason to call that tool and the scan concludes "missing" for every run
  // that worked exactly as designed.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-skills-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, workspaceLayout.runStateDir), { recursive: true });
    const write = async (subagents) => writeFile(
      path.join(project.workspaceDir, workspaceLayout.runStateFile),
      JSON.stringify({ formatVersion: 1, runId: "run_x", subagents }),
      "utf8",
    );

    // A run whose child was delegated with the skill injected.
    await write([{ deliverableId: "d1", capability: "clinical-evidence-synthesis", skills: ["clinical-evidence-synthesis"], status: "completed" }]);
    const injected = await loadedOrInjectedSkillsForTest(project, []);
    assert.ok(injected.has("clinical-evidence-synthesis"), "the injection receipt is what makes this answerable");

    // Negative control: an empty receipt must still read as "not loaded", or
    // the check would pass for a run that never had the skill at all.
    await write([{ deliverableId: "d1", capability: "clinical-evidence-synthesis", skills: [], status: "completed" }]);
    const bare = await loadedOrInjectedSkillsForTest(project, []);
    assert.equal(bare.has("clinical-evidence-synthesis"), false, "no injection recorded must not be mistaken for one");

    // And the transcript route still works on its own, for an agent that does
    // call the tool.
    await rm(path.join(project.workspaceDir, workspaceLayout.runStateFile));
    const viaTool = await loadedOrInjectedSkillsForTest(project, [
      { parts: [{ type: "tool", tool: "skill", state: { status: "completed", input: { name: "open-domain-answer" } } }] },
    ]);
    assert.ok(viaTool.has("open-domain-answer"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the container exiting judges from the durable record too, not just a later reconcile", async () => {
  // The timing regression. The container exit and the unreadable transcript are
  // one event with two exits from it: `notifyRuntimeStop(..., "failed")` →
  // `closeProject`, and `reconcileSession` catching `runtime_not_running`. Only
  // the second consulted the durable record — and the first is the one that
  // fires, because it is driven by the exit itself rather than by the next read
  // that happens to notice it. `finishInternal` no-ops on an already-terminal
  // run, so whichever lands first decides, and the bridge was unreachable in
  // exactly the case it was built for.
  //
  // Observed in production run 6: a graded package, a 47 KB state projection on
  // disk, and a ledger entry reading `failed / runtime_stopped / artifacts 0`.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-exit-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const body = "# report\n";
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), body, "utf8");
    const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_x",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{ path: "deliverables/d1/clinical-evidence-report.md", sha256, bytes: Buffer.byteLength(body) }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 1,
        notices: ["one advisory"],
      }],
    }, null, 2), "utf8");

    const binding = { sessionId: "ses_exit", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    // The container exits. This, not a reconcile, is what the runtime reports.
    await store.closeProject(project, "failed");
    const finished = (await store.list(project)).find((item) => item.id === started.id);

    assert.equal(finished?.status, "succeeded", "the exit path must consult the receipt, not assume the run died undelivered");
    assert.deepEqual(finished?.artifacts, ["deliverables/d1/clinical-evidence-report.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a container that exits with nothing durable still says what the run last knew", async () => {
  // The bridge's own behaviour, called directly. Driving this through
  // `closeProject` proved nothing: the monitor's live projection path puts the
  // same lines on the ledger, so the assertion passed with the bridge disabled
  // — a test green for a reason other than the one it names.
  //
  // What matters here is the run that dies before any poll. Then the live path
  // never ran, and the projection's account of the run exists only in the file
  // the bridge reads. "The bridge ran and found no receipt" and "the bridge
  // never ran" both write `failed / runtime_stopped / artifacts 0`; the
  // notices are the only externally visible difference.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-exit-bare-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, workspaceLayout.runStateDir), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const admitted = "evidence ingest found no source in a completed literature_search result (structured=object)";
    const fresh = "capsule recall disabled: no endpoint configured";

    const binding = { sessionId: "ses_bare", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    // The projection is written only now, and the monitor is quiesced first.
    //
    // This assertion is about what the BRIDGE contributes, but it reads the
    // ledger — which the monitor's live projection path also writes to. That
    // path was reading the container's `/workspace` on the host, so it never
    // fired and the race did not exist; fixing that made it real and this test
    // began failing about one run in fifteen. It had been passing for a reason
    // that had just stopped being true. With nothing on disk while the monitor
    // could poll, only the bridge can have written what the verdict carries.
    const monitor = store.monitors.get(started.id);
    monitor?.cancel();
    await monitor?.promise?.catch(() => {});
    await writeFile(path.join(project.workspaceDir, workspaceLayout.runStateFile), JSON.stringify({
      formatVersion: 1,
      runId: "run_x",
      degraded: [admitted, fresh],
      qualityNotices: [],
    }), "utf8");
    // Exactly what the live path would have recorded for the first line, so the
    // dedup has something real to be measured against.
    store.projectionAdmissions.set(started.id, new Set([admitted]));
    await store.finishFromDurableRecord(project, { id: started.id, sessionId: binding.sessionId });
    const finished = (await store.list(project)).find((item) => item.id === started.id);

    assert.equal(finished?.status, "failed");
    assert.equal(finished?.errorCode, "runtime_stopped");
    assert.deepEqual(finished?.artifacts, []);
    assert.ok(finished?.qualityNotices?.includes(fresh), "a line the run admitted only in its final state must still reach the verdict");
    assert.equal(
      finished.qualityNotices.filter((line) => line === admitted).length,
      0,
      "a line already on the ledger must not be repeated by the verdict that closes the run",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the run's own projection is read from the host, not from the container's view of it", () => {
  // `runtimeWorkspaceRoot()` answers "what are the model's absolute paths
  // relative to". Under docker that is `/workspace` — inside the container —
  // and reading the projection through it asked THIS host for
  // `/workspace/.evimed-run/state.json`, which is not a path on this host. The
  // projection therefore read `missing` for the whole life of every
  // containerised run: no evidence or budget frames to the browser, nothing
  // for the stall signal to read, and the run's own degraded lines never
  // reaching the ledger. Two production runs showed
  // `observedRunSideActivity: null` end to end with the file present the whole
  // time.
  //
  // Asserted on the source because the alternative is standing up a container:
  // what matters is which of the two roots this call site names, and the two
  // are indistinguishable in any single-machine test where they are equal.
  const source = readFileSync(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  // Comments stripped before matching. The first version of this check matched
  // the comment above the fix, which names the very thing it forbids — the
  // same "a mention is not an instruction" mistake this audit has now made
  // three times, in a Dockerfile check, an image-label check, and here.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const body = code.slice(code.indexOf("async readRunSideActivity("));
  const call = body.slice(0, body.indexOf("readRunStateProjection(") + 60);
  assert.match(call, /readRunStateProjection\(project, project\.workspaceDir\)/, "the projection must be read from the host path");
  assert.equal(
    /runtimeWorkspaceRoot\(/.test(call),
    false,
    "the container's view of the workspace is not a path this process can open",
  );

  // Negative control: the two call sites that DO need the container root must
  // keep it, or fixing this would break the paths the model actually wrote.
  assert.match(code, /artifactCandidates\(message, runtimeWorkspaceRoot\)/);
  assert.match(code, /successfulEvidenceSourceArtifacts\(allAssistants, runtimeWorkspaceRoot\)/);
});

test("a repair instruction names a check the run can actually run", () => {
  // It used to open with `$XDG_CONFIG_HOME/opencode/skills/.../preflight.py` —
  // an OpenCode path, for a script this repository no longer contains. Every
  // clinical repair therefore began by ordering the run to execute something
  // that is not there, and spent one of its bounded attempts discovering that.
  // The run-side gate is what preflight became: submitting IS the check.
  // Strings, which is what `completion.qualityIssues` is at the one real call
  // site. The first version of this test passed issue OBJECTS, which the
  // function filters out — so it reported the issues missing when the code was
  // right and the fixture was wrong.
  const prompt = clinicalEvidenceRepairPromptForTest([
    "RoB 2 named in the methods but never applied to any study",
  ]);

  assert.match(prompt, /evimed_submit_deliverable/, "the repair must name the check that exists");
  assert.equal(/preflight\.py/.test(prompt), false, "no run can execute a script that is not shipped");
  assert.equal(/opencode/i.test(prompt), false, "and the path named must not belong to the other kernel");
  // The issue itself has to travel, or the run is told to fix something without
  // being told what.
  assert.match(prompt, /RoB 2 named in the methods but never applied/);
  // And an issue shape the function drops must not silently produce a prompt
  // that says "fix every issue" while listing none.
  const dropped = clinicalEvidenceRepairPromptForTest([{ message: "an object, not a string" }]);
  assert.equal(/an object, not a string/.test(dropped), false, "the filter is real, which is why the fixture above must match the call site");

  // Negative control: the assertions must be able to fail. A prompt that named
  // the deleted script would match the pattern this test forbids.
  const stale = "Run python $XDG_CONFIG_HOME/opencode/skills/clinical-evidence-synthesis/scripts/preflight.py first.";
  assert.equal(/preflight\.py/.test(stale), true);
  assert.equal(/evimed_submit_deliverable/.test(stale), false);
});

test("a delegation that read evidence is recognised under both kernels and both argument keys", () => {
  // `task` is OpenCode's delegation tool and no tool of that name exists under
  // DSH: the preset registers `subagent`, the socket registers
  // `evimed_delegate`, and the adapter passes the kernel's name through
  // verbatim. This returned [] for every DSH run, which made three things
  // unreachable without a throw or a log: the delegated-evidence-read verdict,
  // one of the two triggers for `qualityUnverified`, and the "MUST FIX" lead
  // line that gives a repair loop the cause instead of only the symptom.
  const part = (tool, input) => ({
    info: { role: "assistant", time: { created: 1, completed: 1 } },
    parts: [{ type: "tool", tool, state: { status: "completed", input } }],
  });
  const read = (messages) => delegatedDocumentReadsForTest(messages).length;

  assert.equal(read([part("subagent", { prompt: "read tool-output/abc" })]), 1, "the DSH kernel's own delegation tool");
  assert.equal(read([part("evimed_delegate", { brief: "quote from .evimed-sources/x/fulltext.md" })]), 1, "the socket's delegation, whose key is `brief`");
  assert.equal(read([part("task", { prompt: "read tool-output/abc" })]), 1, "the kernel on its way out still counts");

  // Negative controls — each is a way the widening could be wrong.
  // Widening the name alone leaves every socket delegation reading "", which
  // is the same silence with a shorter list of causes.
  assert.equal(read([part("evimed_delegate", { prompt: undefined, brief: "no evidence path here" })]), 0);
  // A delegation that read nothing evidential is not a delegated evidence read.
  assert.equal(read([part("subagent", { prompt: "summarise the plan" })]), 0);
  // And an unrelated tool must not be counted just because its input mentions a path.
  assert.equal(read([part("write", { file_path: ".evimed-sources/x/fulltext.md" })]), 0, "writing is not delegating");
});

test("an artifact is recognised from the spelling the model actually sends", () => {
  // DSH's `write` and `edit` declare `{ file_path, ... }` and camel-case it
  // internally; the transcript records the raw model-facing arguments. Reading
  // `filePath` alone therefore recognised no artifact from any DSH write —
  // indistinguishable from a run that wrote nothing, and invisible on top of
  // the projection defect that was hiding these messages from the gate
  // entirely. Two links, each silent, and fixing either one alone changes
  // nothing observable.
  const toolMessage = (input) => ({
    info: { role: "assistant", time: { created: 1, completed: 1 } },
    parts: [{ type: "tool", tool: "write", state: { status: "completed", input } }],
  });

  assert.deepEqual(artifactCandidatesForTest(toolMessage({ file_path: "deliverables/d1/report.md" }), "/w"), ["deliverables/d1/report.md"]);
  // The kernel on its way out still spells it the old ways.
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ filePath: "a.md" }), "/w"), ["a.md"]);
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ path: "b.md" }), "/w"), ["b.md"]);
  // An absolute path inside the runtime workspace is relativised.
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ file_path: "/w/deliverables/d1/x.md" }), "/w"), ["deliverables/d1/x.md"]);

  // Negative controls. The containment assertions below hold through two
  // independent layers — the explicit `../`/absolute check here and
  // `normalizeWorkspaceRelativePath`, which throws into this function\'s catch —
  // so deleting either one alone leaves them green. That is defence in depth
  // working, not a check that bites; recorded here rather than left to look
  // like a control that proves the first layer.
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ file_path: "/etc/passwd" }), "/w"), [], "outside the workspace is not an artifact");
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ file_path: "../escape.md" }), "/w"), []);
  assert.deepEqual(artifactCandidatesForTest(toolMessage({ file_path: 42 }), "/w"), [], "a non-string is not a path");
  assert.deepEqual(artifactCandidatesForTest({
    info: { role: "assistant", time: { created: 1, completed: 1 } },
    parts: [{ type: "tool", tool: "write", state: { status: "pending", input: { file_path: "half.md" } } }],
  }, "/w"), [], "an unfinished write has not produced a file");
  assert.deepEqual(artifactCandidatesForTest({
    info: { role: "assistant", time: { created: 1, completed: 1 } },
    parts: [{ type: "tool", tool: "read", state: { status: "completed", input: { file_path: "r.md" } } }],
  }, "/w"), [], "reading a file does not produce one");
});

test("a package written and never submitted is not reported as a stopped runtime", async () => {
  // Run 7, exactly: seven deliverable files on disk, the plan item still
  // `planned` with `attempts: 0`, no gate run, no receipt — and a ledger entry
  // reading `runtime_stopped`. A run cut off mid-flight and a run that wrote
  // its whole contract and never asked for a verdict both end with a gone
  // container and no receipt, so one code for both makes the second read as
  // infrastructure trouble and hides what actually happened.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-unsubmitted-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.metaDir, { recursive: true });
    await mkdir(path.join(project.workspaceDir, workspaceLayout.runStateDir), { recursive: true });
    await mkdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, "d1"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, "d1", "clinical-evidence-report.md"), "# report\n", "utf8");
    const writeState = (items) => writeFile(
      path.join(project.workspaceDir, workspaceLayout.runStateFile),
      JSON.stringify({ formatVersion: 1, runId: "run_x", plan: { revision: 1, items }, degraded: [] }),
      "utf8",
    );
    const finish = async () => {
      const binding = { sessionId: "ses_u", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
      const store = new AgentRunStore({ get: async () => binding }, {
        model: "deepseek/deepseek-v4-pro",
        readSessionHistory: async () => [],
        monitorIntervalMs: 60_000,
      });
      const started = await store.start(project, { sessionId: binding.sessionId });
      await store.closeProject(project, "failed");
      return (await store.list(project)).find((item) => item.id === started.id);
    };

    await writeState([{ id: "d1", status: "planned", attempts: 0 }]);
    const abandoned = await finish();
    assert.equal(abandoned?.errorCode, "runtime_deliverable_never_submitted");
    assert.ok(
      abandoned?.qualityNotices?.some((line) => line.includes("d1") && line.includes("1")),
      `the verdict must name the deliverable and what was written: ${JSON.stringify(abandoned?.qualityNotices)}`,
    );
    assert.deepEqual(abandoned?.artifacts, [], "ungraded files are still not deliverables");

    // Negative controls — the three ways this could lie.
    // 1. An item that was submitted and rejected wrote files too; that is a
    //    graded failure, not an abandoned one, and not infrastructure trouble
    //    either. This asserted `runtime_stopped` when those were the only two
    //    codes; a run that worked for an hour and did not meet the contract now
    //    says so. What the control is for — it must never read as abandoned —
    //    is unchanged.
    await writeState([{ id: "d1", status: "rejected", attempts: 2 }]);
    const graded = await finish();
    assert.equal(graded?.errorCode, "specialist_deliverable_not_accepted");
    assert.notEqual(graded?.errorCode, "runtime_deliverable_never_submitted");
    assert.ok(
      graded?.qualityNotices?.some((line) => line.includes("d1") && line.includes("2")),
      `the verdict must name the deliverable and how many times it was rejected: ${JSON.stringify(graded?.qualityNotices)}`,
    );
    // 2. An item never started is a run that stopped, not a package left
    //    ungraded. The directory must EXIST and be EMPTY: a missing directory
    //    is rejected one line earlier, so using one proves nothing about the
    //    file count this control is aimed at — the first version of this case
    //    stayed green with the count deleted.
    await mkdir(path.join(project.workspaceDir, workspaceLayout.deliverablesDir, "d-empty"), { recursive: true });
    await writeState([{ id: "d-empty", status: "planned", attempts: 0 }]);
    assert.equal((await finish())?.errorCode, "runtime_stopped");
    // 3. An id from the projection is input, not a name we chose. The traversal
    //    has to lead somewhere real for the guard to be under test: pointed at
    //    a path that does not exist, the read throws and the case passes with
    //    the guard deleted — which is how the first version of this one lied.
    await mkdir(path.join(root, "outside"), { recursive: true });
    await writeFile(path.join(root, "outside", "secret.txt"), "not a deliverable\n", "utf8");
    await writeState([{ id: "../../outside", status: "planned", attempts: 0 }]);
    assert.equal((await finish())?.errorCode, "runtime_stopped", "a traversing id must not be read at all");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a receipt naming a file that no longer matches its digest is refused, not delivered", async () => {
  // The receipt's whole value is that it proves the fetched artifacts are the
  // graded artifacts. A file edited after grading is not the graded file, and
  // delivering it would put something no gate has seen in front of a reader.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-digest-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    const deliverableDir = path.join(project.workspaceDir, "deliverables", "d1");
    await mkdir(deliverableDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(deliverableDir, "clinical-evidence-report.md"), "# edited after grading\n", "utf8");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_x",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{ path: "deliverables/d1/clinical-evidence-report.md", sha256: "0".repeat(64), bytes: 1 }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 1,
        notices: [],
      }],
    }, null, 2), "utf8");

    const binding = { sessionId: "ses_digest", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let alive = true;
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => {
        if (alive) { alive = false; return []; }
        const error = new Error("gone");
        error.code = "runtime_not_running";
        throw error;
      },
      monitorIntervalMs: 60_000,
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    await store.reconcileSession(project, binding.sessionId).catch(() => {});
    const finished = (await store.list(project)).find((item) => item.id === started.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.errorCode, "specialist_receipt_digest_mismatch");
    assert.deepEqual(finished?.artifacts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a required deliverable is found under deliverables/<id>/, not only at the workspace root", async () => {
  // A capability declares bare output names, and the two kernels put them in
  // different places: the OpenCode composition at the workspace root, the DSH
  // composition inside `deliverables/<deliverableId>/`, which §9.5 makes the
  // only directory its validator accepts. A gate that knows only the first
  // reports every DSH package as missing — which is what the first real
  // end-to-end run produced, with eight complete files on disk.
  const { readRequiredFileForTest } = await import("../src/agentRuns.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "os-required-output-"));
  try {
    const project = { workspaceDir: path.join(root, "workspace") };
    await mkdir(path.join(project.workspaceDir, "deliverables", "d1"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, "deliverables", "d1", "clinical-evidence-report.md"), "# nested\n", "utf8");

    const nested = await readRequiredFileForTest(project, "clinical-evidence-report.md");
    assert.ok(nested, "the package written by the DSH composition must be found");
    assert.match(nested.text, /nested/);

    // The root still wins when both exist: a run that wrote the declared path
    // literally is not made ambiguous by a directory that happens to exist.
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# root\n", "utf8");
    const rooted = await readRequiredFileForTest(project, "clinical-evidence-report.md");
    assert.match(rooted.text, /root/);

    assert.equal(await readRequiredFileForTest(project, "absent.md"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restarted control plane adopts runs a previous process left running", async () => {
  // Observed live: the startup orphan sweep reaped a finished run's container
  // at 14:18:40, and because nothing re-armed a monitor, the run's last ledger
  // event stayed a progress row from 12:42 — "running" forever, container
  // gone, deliverables on disk.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-adopt-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      metaDir: path.join(root, ".openscience"),
      workspaceDir: path.join(root, "workspace"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "session-adopt-1", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const finished = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
      onRunFinished: async () => {},
    });
    const started = await store.start(project, { sessionId: binding.sessionId });

    // A second store over the same directory is the restarted process. The
    // ledger says running; the container is not there to answer.
    const restarted = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => {
        throw Object.assign(new Error("gone"), { status: 409, code: "runtime_not_running" });
      },
      monitorIntervalMs: 60_000,
      onRunFinished: async (finishedProject, run) => {
        finished.push({ runId: run.id, status: run.status, errorCode: run.errorCode });
      },
    });
    const adoption = await restarted.adoptRunningRuns([project]);
    assert.equal(adoption.adopted, 1);
    await restarted.monitors.get(started.id)?.promise;

    const runs = await restarted.list(project);
    const run = runs.find((item) => item.id === started.id);
    assert.equal(run?.status, "failed", "the durable bridge decided, not a timeout four hours out");
    assert.equal(run?.errorCode, "runtime_stopped");

    // Idempotence and scope: a terminal run is not adopted again.
    const again = await restarted.adoptRunningRuns([project]);
    assert.equal(again.adopted, 0, "a finished run must not get a second monitor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withSpecialistRun(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-specialist-"));
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
      sessionId: "ses_specialist",
      mode: "specialist",
      agentId: "note-writer",
      agentVersion: "1.0.0",
      runtimeAgent: "evimed-note-writer",
    };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "note-writer",
          version: "1.0.0",
          runtimeAgent: "evimed-note-writer",
          skill: "note-writer",
          companionSkills: [],
          outputs: [{ path: "note.md", required: true }],
          completionChecks: ["requiredOutputsExist"],
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
      effectiveAgentId: "note-writer",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-note-writer",
    }, async () => ({ accepted: true }));
    const appendHistory = (parts) => {
      history = [...history, {
        info: { id: `msg_spec_${Math.random().toString(16).slice(2, 10)}`, role: "assistant", time: { completed: Date.now() + 10 } },
        parts,
      }];
    };
    await fn({ project, binding, dispatch, appendHistory, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** @param {string} workspaceDir @param {string} digest */
async function writeReceiptNaming(workspaceDir, digest) {
  await writeFile(path.join(workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1,
    runId: "run_live",
    bundleVersion: "0.1.0",
    domainVersion: "0.1.0",
    entries: [{
      deliverableId: "d1",
      contractKind: "clinical-evidence-report",
      capability: "clinical-evidence-synthesis",
      files: [{ path: "note.md", sha256: digest, bytes: 1 }],
      acceptedAt: "2026-01-01T00:00:00.000Z",
      attempt: 3,
      notices: [],
    }],
  }, null, 2), "utf8");
}

test("a package edited after its receipt is re-judged, not destroyed", async () => {
  // 2026-08-31: a run submitted, was told by evimed_complete_run what to fix,
  // fixed exactly that in clinical-evidence-report.md, and finished. The files
  // no longer matched the receipt, so the run was recorded failed with zero
  // artifacts — 38 minutes of work discarded over bytes that were, at that
  // moment, gate-clean.
  //
  // Changed is not broken. On this path the server has already run the same
  // domain gate over the bytes on disk, so the honest answer is to amend and
  // say which files moved.
  await withSpecialistRun(async ({ project, dispatch, appendHistory, binding, store }) => {
    await dispatch("turn_amend");
    await writeFile(path.join(project.workspaceDir, "note.md"), "# repaired after the verdict\n", "utf8");
    await writeReceiptNaming(project.workspaceDir, "0".repeat(64));
    appendHistory([{ type: "text", text: "done" }]);

    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", (run.qualityNotices ?? []).join(" | "));
    assert.deepEqual(run.artifacts, ["note.md"], "the bytes the server itself verified are what ships");
    assert.ok(
      (run.qualityNotices ?? []).some((line) => /回执之后被改动/.test(String(line))),
      "an amended delivery must say so, and name what moved",
    );
  });
});

test("a package edited after its receipt into something that fails is still refused", async () => {
  // The negative control that makes the test above mean anything: amendment is
  // conditional on the current bytes passing. Remove the required output and
  // the same drift must still be refused, with nothing shipped.
  await withSpecialistRun(async ({ project, dispatch, appendHistory, binding, store }) => {
    await dispatch("turn_amend_fail");
    await writeReceiptNaming(project.workspaceDir, "0".repeat(64));
    appendHistory([{ type: "text", text: "done" }]);

    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "failed");
    assert.deepEqual(run.artifacts, []);
  });
});
