import { awaitBackgroundMonitor } from "./helpers/awaitBackgroundMonitor.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import {
  AgentRunStore,
  artifactCandidatesForTest,
  clinicalEvidenceRepairPromptForTest,
  consumeRepairAuthorizationForTest,
  delegatedDocumentReadsForTest,
  ledgerTextForTest,
  loadedOrInjectedSkillsForTest,
  readDelegatedAssistantMessagesForTest,
  MAX_RUN_CORRECTIONS,
  scopeNativeProjectionForTest, scopeNativeReceiptForTest,
  snapshotAcceptedPackageForRepairForTest,
  recoverableEvidenceSourceErrorCodes,
  repairableEvidencePackageErrorCodes,
  runPhaseHistory,
  terminalEvidenceSourceErrorCodes,
} from "../src/agentRuns.mjs";
import { runStateFileFor, workspaceLayout } from "@evimed/domain";
import { deepResearchPackage, researchBrief } from "./fixtures/clinicalEvidencePackage.mjs";
import { validateClinicalEvidencePackage } from "../src/clinicalEvidenceQuality.mjs";
import { HttpError } from "../src/security.mjs";
import { kernelToolText } from "./helpers/kernelToolText.mjs";
import { noticeTexts } from "./helpers/noticeTexts.mjs";

/**
 * A completed `skill` tool call as the kernel reports one: the result is the
 * rendered `<skill_content>` block for the name that was asked for. The
 * block's first line is the shape `dsh-skill` renders on every successful path.
 * @param {string} name
 */
function skillToolPart(name) {
  return {
    type: "tool",
    tool: "skill",
    state: {
      status: "completed",
      input: { name },
      output: `<skill_content name="${name}">\n<skill_resources>\nBase directory for this skill: /opt/evimed/socket/presets/evimed-universal/skills/core/${name}\n</skill_resources>\n\n<skill_instructions>\n# ${name}\n</skill_instructions>\n</skill_content>`,
    },
  };
}

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

/** A research-memory store at the interface, for the two cases a dispatch has
 *  to tell apart: a deployment that has none, and one whose store is broken. */
function memoryStoreDouble({ configured = true, fail = null } = {}) {
  const refuse = () => { if (fail) throw fail; };
  return {
    configured,
    async status() {
      return fail
        ? { configured, connected: false, code: "memory_unavailable", structured: false }
        : { configured, connected: configured, code: null, structured: configured };
    },
    async relevant() { refuse(); return []; },
    async list() { refuse(); return []; },
    async listRecords() { refuse(); return []; },
    async listAllRecords() { refuse(); return []; },
    async profile() { refuse(); return { records: [], memos: [] }; },
  };
}

// A deployment with no control-plane database has no research memory, and that
// is a configuration rather than a fault: the researcher gets an answer without
// recalled memories, which is what every local development run has always got.
test("a deployment with no research memory store still dispatches", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_memory_absent", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_memory_absent");
    assert.equal(result.response.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.data.status, "running");
  }, { researchMemory: memoryStoreDouble({ configured: false }) });
});

// A store that exists and cannot answer is the opposite case. Continuing would
// answer as if the researcher had never told the product anything, and nothing
// in the answer would say so — so the dispatch fails, terminally, and the run
// ledger carries the reason.
test("a research memory store that cannot answer fails the dispatch and records why", async () => {
  const offline = new Error("the control-plane database is unreachable");
  /** @type {any} */ (offline).code = "memory_unavailable";
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_memory_offline", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_memory_offline");
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "memory_unavailable");
    const runs = await listRuns(base);
    assert.equal(runs.body.data[0].status, "failed");
    assert.equal(runs.body.data[0].errorCode, "memory_unavailable");
  }, { researchMemory: memoryStoreDouble({ fail: offline }) });
});

// The third case, and the one the prompt's old "科研记忆服务暂时不可用" note used
// to serve: a deployment with no store of its own whose recall still fails.
// That is what a strict index asks for when the index is down, and it is a
// rejection like any other — a run that has been told to stop is not a run to
// decorate with an excuse and dispatch anyway.
test("a recall that fails rejects the dispatch even where the store itself is absent", async () => {
  const offline = new HttpError(503, "memory_index_unavailable", "The memory index is unavailable.");
  await withApp(async ({ base }) => {
    assert.equal((await bind(base, "ses_memory_strict", { mode: "open-domain" })).status, 200);
    const result = await startRun(base, "ses_memory_strict");
    assert.equal(result.response.status, 503, JSON.stringify(result.body));
    assert.equal(result.body.code, "memory_index_unavailable");
  }, { researchMemory: memoryStoreDouble({ configured: false, fail: offline }) });
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
        model: "deepseek/deepseek-flash",
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
      // `learning` joined the vocabulary when a finished run began writing its
      // transcript down: the receipt is folded onto the run record, so every
      // run that produced a readable session leaves one.
      assert.ok(["started", "dispatch", "progress", "notice", "finished", "learning"].includes(event.event), `unknown ledger event ${event.event}`);
    }
    assert.equal(ledger.includes("prompt"), false);
    assert.equal(ledger.includes("content"), false);
    assert.equal(ledger.includes("token"), false);
  });
});

test("open-domain clinical evidence questions record and dispatch the selected specialist identity", async () => {
  await withApp(async ({ base, dataDir }) => {
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
      effectiveAgentVersion: "2.13.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    });
    const workspace = path.join(dataDir, "users", "dev", "projects", "default", "workspace");
    const routedContext = await readFile(
      path.join(workspace, ".evimed-brief", "sessions", "ses_routed_clinical", "context.md"),
      "utf8",
    );
    assert.match(
      routedContext,
      /clinical-evidence-synthesis、autopilot-episode、deep-research、biomedical-database-search、citation-integrity、manuscript-humanize/,
      "the exact completion-gate skill set must reach this dispatched session",
    );
    const routedIndex = JSON.parse(await readFile(
      path.join(workspace, ".evimed-brief", "sessions", "ses_routed_clinical", "index.json"),
      "utf8",
    ));
    assert.equal(routedIndex.runId, result.body.data.id);
    assert.match(routedIndex.contextRevision, /^req_/);

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
    assert.match(
      await readFile(path.join(workspace, ".evimed-brief", "sessions", "ses_unrouted_clinical", "context.md"), "utf8"),
      /保持开放域回答/,
    );
    await assert.rejects(
      () => readFile(path.join(workspace, ".evimed-brief", "context.md"), "utf8"),
      { code: "ENOENT" },
      "interactive sessions must not share one mutable project context",
    );
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
    await relabelReceipt(project, started.id);
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

test("canceling waits for the observer even when the terminal ledger write fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-cancel-failure-"));
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
      sessionId: "ses_cancel_failure",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      readSessionHistory: async () => [],
    });
    store.scheduleMonitor = () => {};
    const started = await store.start(project, { sessionId: binding.sessionId });
    await relabelReceipt(project, started.id);
    let observerExited = false;
    let releaseObserver;
    const observer = new Promise((resolve) => { releaseObserver = resolve; });
    store.monitors.set(started.id, {
      cancel: () => setTimeout(() => {
        observerExited = true;
        releaseObserver();
      }, 20),
      promise: observer,
    });
    const persistenceError = new Error("terminal ledger write failed");
    store.finishInternal = async () => { throw persistenceError; };

    await assert.rejects(() => store.cancelSession(project, binding.sessionId), (error) => error === persistenceError);
    assert.equal(observerExited, true, "cancel returned before the observer stopped after a persistence failure");
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
      ].map((name) => skillToolPart(name)),
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
    const skillLoadedPart = skillToolPart("open-domain-answer");
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
  const receiptRead = source.indexOf("const finalReceipt = await readDeliveryReceipt(project, run);");
  assert.ok(receiptRead > 0, "the live path no longer reads the receipt at all");
  const liveStart = source.lastIndexOf("async reconcileSession(", receiptRead);
  const liveEnd = source.indexOf("/** Append what is observably happening", receiptRead);
  assert.ok(liveStart > 0 && liveEnd > receiptRead, "could not bound the live path");
  const live = source.slice(liveStart, liveEnd);

  for (const [fact, marker] of [
    ["receipt digests", "verifiedReceiptArtifacts"],
    // Read through `receiptNotices` on both paths, which is where
    // `entry.notices` is opened now: the call is the marker.
    ["acceptance notices", "receiptNotices("],
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

    const dispatched = await dispatch("turn_accepted_notices");
    await relabelReceipt(project, dispatched.id);
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", noticeTexts(run).join(" | "));
    assert.ok(
      noticeTexts(run).some((line) => /GRADE/.test(String(line))),
      `the acceptance notices must travel: ${JSON.stringify(run.qualityNotices)}`,
    );
    // Deduplicated: a notice already admitted while the run was alive is the
    // same notice, and reporting it twice is the noise this whole area is about.
    const repeated = noticeTexts(run).filter((line) => String(line) === "重复的一条");
    assert.equal(repeated.length, 1, "one notice, once");
  });
});

test("a deliverable no gate accepted is never a clean success: failed with nothing on disk, delivered marked otherwise", async () => {
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
    assert.equal(run.status, "failed", "seven rejections and nothing on disk is not a success");
    assert.equal(run.errorCode, "specialist_deliverable_not_accepted");
    assert.ok(
      noticeTexts(run).some((line) => /没有一件通过契约校验/.test(String(line))),
      "the verdict must say why",
    );

    // The same seven rejections with the report on disk. What RQ-03's defect
    // was is a success nobody could tell from a verified one, not that its
    // files reached a reader: this rule turned seven of twelve finished v9
    // packages, judged 3.1/5 useful, into 失败 (2026-09-16). So the files are
    // delivered, and the record cannot be mistaken for a clean one.
    const relative = "deliverables/d1/clinical-evidence-report.md";
    await mkdir(path.join(project.workspaceDir, "deliverables", "d1"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), "# 二甲双胍的证据综述\n", "utf8");
    await dispatch("turn_never_accepted_with_files");
    appendHistory([
      skillLoadedPart,
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: relative } } },
      { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" },
    ]);
    const delivered = await store.reconcileSession(project, binding.sessionId);
    assert.equal(delivered.status, "succeeded", JSON.stringify(delivered.qualityNotices));
    assert.equal(delivered.verification, "unverified", "and never a clean success");
    assert.deepEqual(delivered.artifacts, [relative]);
    assert.ok(noticeTexts(delivered).some((line) => /没有通过运行内的契约校验，文件按「未核验」交付/.test(String(line))));
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
    assert.equal(passed.status, "succeeded", noticeTexts(passed).join(" | "));
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

    const dispatched = await dispatch("turn_receipt_drift");
    await relabelReceipt(project, dispatched.id);
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "failed", "a package no gate has seen must not ship");
    assert.equal(run.errorCode, "specialist_receipt_digest_mismatch");
    // Not shipped is not deleted. The verdict above is the whole of "does not
    // ship" — the run is `failed`, the package is not published as graded, and
    // nothing downstream treats it as accepted. The files are still listed,
    // marked unverified, because the alternative is telling a researcher whose
    // report is sitting in the workspace that there is 「暂无交付物」.
    assert.deepEqual(run.artifacts, [], "a package no gate has seen is not graded output");
    assert.deepEqual(run.unverifiedArtifacts, ["deliverables/d1/clinical-evidence-report.md"]);
    assert.ok(
      noticeTexts(run).some((line) => /digest the file no longer matches/.test(String(line))),
      "the verdict must say which file drifted",
    );
    assert.ok(noticeTexts(run).some((line) => String(line).includes("未经核验")),
      "and must label the files it lists as ungraded");
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

    const dispatched = await dispatch("turn_receipt_intact");
    await relabelReceipt(project, dispatched.id);
    appendHistory([skillLoadedPart, { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" }]);
    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", noticeTexts(run).join(" | "));
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
    // The sentence is shown to the researcher, on the run ledger and in
    // their inbox, so it is in the product's language (2026-09-15 walk, B8).
    assert.match(noticeTexts(run).join("\n"), /没有加载「open-domain-answer」方法/);
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
    assert.match(noticeTexts(insecure).join("\n"), /plain HTTP/);

    // A fragment is how a citation points at the passage it means.
    await dispatch("turn_answer_fragment_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "见该节 [1]。\n\n参考文献\n1. https://www.nice.org.uk/guidance/ng185#section-3" },
    ]);
    const fragment = await store.reconcileSession(project, binding.sessionId);
    assert.equal(fragment.status, "succeeded");
    assert.equal(fragment.errorCode, null);
    assert.deepEqual(noticeTexts(fragment), []);

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
    assert.match(noticeTexts(internal).join("\n"), /points inside this deployment/);

    // The same defect wearing a different address.
    await dispatch("turn_answer_loopback_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "本地证据 [1]。\n\n参考文献\n1. https://127.0.0.1:8787/doc/42" },
    ]);
    const loopback = await store.reconcileSession(project, binding.sessionId);
    assert.equal(loopback.verification, "unverified");
    assert.match(noticeTexts(loopback).join("\n"), /points inside this deployment/);

    // Credentials in a citation must never ship, whatever the scheme.
    await dispatch("turn_answer_credentialed_citation");
    appendHistory([
      skillLoadedPart,
      { type: "text", text: "见此 [1]。\n\n参考文献\n1. https://reader:placeholder-token@journals.example.org/article/9" },
    ]);
    const credentialed = await store.reconcileSession(project, binding.sessionId);
    assert.equal(credentialed.verification, "unverified");
    assert.match(noticeTexts(credentialed).join("\n"), /carries credentials/);
    // The notice names the host and never repeats the credential it found.
    assert.doesNotMatch(noticeTexts(credentialed).join("\n"), /placeholder-token/);
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
    // The package is the report and the matrix. A repair told to revise a file
    // the package no longer has spends a bounded attempt finding that out.
    assert.match(prompts[1], /in place: clinical-evidence-report\.md or clinical-evidence-matrix\.json\./);
    assert.doesNotMatch(
      prompts[1],
      /clinical-evidence-search\.json|clinical-evidence-run\.json|question-coverage\.json|citation-ledger\.csv|citation-audit\.md|references\.bib|search log/i,
    );
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
    assert.match(noticeTexts(finished)[0], /^MUST FIX — /, "an unverifiable claim leads the notices");
    assert.match(noticeTexts(finished).join("\n"), /evidence matrix must contain the report's material claims/i);

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

for (const scenario of ["missing", "valid", "tampered", "old-missing", "reused", "old-tampered", "prior-turn-only", "guideline-warning", "undigested"]) {
  test(`clinical evidence source artifacts must come from successful retrieval tools in the same turn: ${scenario}`, async () => {
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
      const sourceA = ".evimed-sources/official-pages/source-a/page.md";
      const sourceB = ".evimed-sources/official-pages/source-b/page.md";
      const quotes = [
        "Patients with acute pressure-like chest discomfort require prompt emergency evaluation for acute coronary syndrome.",
        "Serial high-sensitivity cardiac troponin measurements support rapid diagnostic assessment in acute chest pain.",
        "The evidence review included fifteen trials with a total of 1776 participants and found important study limitations.",
        "The available trials were generally of poor methodological quality, which limits confidence in treatment effects.",
      ];
      const sourceContents = new Map([
        [sourceA, quotes.slice(0, 2).join("\n")],
        [sourceB, quotes.slice(2).join("\n")],
      ]);
      const retrieval = {
        // A guideline search answers `warning` for every result — its caveat is
        // "verify the version" — while the text it preserved is real bytes with
        // their digests. Refused as "no evidence tool reported preserving that
        // file" in nine of twelve v8 ablation cells (2026-09-16).
        "guideline-warning": { tool: "mcp__evimed__guideline_search", status: "warning", digests: true },
        // What guideline preservation reported until then: a path, no digest.
        undigested: { tool: "mcp__evimed__guideline_search", status: "warning", digests: false },
      }[scenario] ?? { tool: "mcp__evimed__web_read", status: "success", digests: true };
      const retrievalParts = !["missing", "old-missing"].includes(scenario)
        ? [sourceA, sourceB].map((source) => ({
            type: "tool",
            tool: retrieval.tool,
            state: {
              status: "completed",
              output: JSON.stringify({
                status: retrieval.status,
                artifacts: [source],
                ...(retrieval.digests ? { data: { artifactSha256s: {
                  [source]: createHash("sha256").update(sourceContents.get(source), "utf8").digest("hex"),
                } } } : {}),
              }),
            },
          }))
        : [];
      const previousHistory = scenario === "prior-turn-only" ? [{
        info: { id: "prior_turn_source_receipt", role: "assistant", time: { completed: Date.now() - 86_400_000 } },
        parts: retrievalParts,
      }] : [];
      const binding = {
        sessionId: `ses_clinical_provenance_${scenario}`,
        mode: "open-domain",
        agentId: null,
        agentVersion: null,
        runtimeAgent: null,
      };
      let history = [...previousHistory];
      const store = new AgentRunStore({ get: async () => binding }, {
        agentRegistry: {
          get: () => ({
            id: "clinical-evidence-synthesis",
            version: "1.0.0",
            runtimeAgent: "evimed-clinical-evidence-synthesis",
            outputs: [
              { path: "clinical-evidence-report.md", required: true },
              { path: "clinical-evidence-matrix.json", required: true },
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
        // Held by the dispatcher, as on every production dispatch, so the
        // question-scoped safety rule runs. The question names the medicine the
        // report discusses, which leaves that rule nothing to object to.
        question: "突发压迫性胸闷，是心绞痛还是胃病？能不能先含服速效救心丸？",
        effectiveAgentId: "clinical-evidence-synthesis",
        effectiveAgentVersion: "1.0.0",
        effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
      }, async () => ({ accepted: true }));

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
      await mkdir(path.join(project.workspaceDir, path.dirname(sourceA)), { recursive: true });
      await mkdir(path.join(project.workspaceDir, path.dirname(sourceB)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, sourceA), sourceContents.get(sourceA), "utf8");
      await writeFile(path.join(project.workspaceDir, sourceB), sourceContents.get(sourceB), "utf8");
      await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), report, "utf8");
      await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), JSON.stringify({ claims }), "utf8");
      if (["tampered", "old-tampered"].includes(scenario)) {
        await writeFile(path.join(project.workspaceDir, sourceA), `${sourceContents.get(sourceA)}\nAuthored replacement.`, "utf8");
      }
      if (["old-missing", "reused", "old-tampered", "prior-turn-only"].includes(scenario)) {
        const old = new Date(Date.parse(run.startedAt) - 86_400_000);
        await Promise.all([sourceA, sourceB].map((source) => utimes(path.join(project.workspaceDir, source), old, old)));
      }
      history = [...previousHistory, {
        info: { id: `msg_clinical_provenance_${scenario}`, role: "assistant", time: { completed: Date.now() } },
        parts: [
          ...(scenario === "prior-turn-only" ? [] : retrievalParts),
          ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath } },
          })),
          { type: "text", text: "Completed." },
        ],
      }];
      const finished = await store.reconcileSession(project, binding.sessionId);
      assert.equal(finished.id, run.id);
      // Three outcomes since 2026-09-17. Sources a tool vouched for: delivered
      // clean. Sources nobody vouched for in this run: still delivered — the
      // report is on disk — and marked, with each unvouched path named, because
      // that is a gap a reader can be told about. Sources whose bytes changed
      // after a tool preserved them: withheld, the one case a reader cannot be
      // warned out of, since every quotation in the package rests on them.
      const tampered = ["tampered", "old-tampered"].includes(scenario);
      const vouched = ["valid", "reused", "guideline-warning"].includes(scenario);
      assert.equal(finished.status, tampered ? "failed" : "succeeded");
      assert.equal(finished.errorCode, tampered ? "specialist_evidence_integrity_failed" : null);
      assert.equal(finished.verification ?? null, tampered || vouched ? null : "unverified");
      if (!tampered && !vouched) {
        // The paths read are the ones the claims cite, so each is named as the
        // matrix's citation.
        for (const source of [sourceA, sourceB]) {
          assert.ok(
            noticeTexts(finished).some((notice) => notice.includes(`The evidence matrix cites ${source}, but no evidence tool reported preserving that file`)),
            JSON.stringify(finished.qualityNotices),
          );
        }
        assert.ok(finished.artifacts.includes("clinical-evidence-report.md"), JSON.stringify(finished.artifacts));
      }
      await store.closeProject(project, "canceled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    const put = await finishRun(base, started.body.data.id, { status: "succeeded", artifacts: ["forged.md"] }, "default", "PUT");
    assert.equal(put.response.status, 404);
    assert.equal(put.body.code, "not_found");
    // PATCH names a run (C3) and takes a title and nothing else, so a status
    // or an artifact list is refused by name rather than folded in.
    const patch = await finishRun(base, started.body.data.id, { status: "succeeded", artifacts: ["forged.md"] }, "default", "PATCH");
    assert.equal(patch.response.status, 400);
    assert.equal(patch.body.code, "invalid_payload");
    const smuggled = await finishRun(base, started.body.data.id, { title: "改名", status: "succeeded" }, "default", "PATCH");
    assert.equal(smuggled.response.status, 400);
    const [run] = (await listRuns(base)).body.data;
    assert.equal(run.artifacts.includes("forged.md"), false);
    assert.notEqual(run.title, "改名");
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

async function waitForProjection(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "The expected projection was not published.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A run fixture whose root history and run-side projection are both scriptable. */
async function delegatingRunFixture(t, { stallPolls = 3, maxPolls = 40, readChildSessionActivity = async () => [], readSessionHistory = null, progressPublishIntervalMs = 2_000 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-projection-"));
  let store;
  t.after(async () => {
    await store?.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  const project = {
    id: "project-1", userId: "user-1", rootDir: root,
    metaDir: path.join(root, ".openscience"), workspaceDir: root,
  };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(path.join(root, ".evimed-run"), { recursive: true });
  const frames = [];
  // `run/progress` rides the same forwarder; kept apart so a test about the
  // projection's own frames counts only those.
  const progress = [];
  store = new AgentRunStore({ get: async () => ({ sessionId: "ses_deleg", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null }) }, {
    model: "deepseek/deepseek-v4-pro",
    monitorIntervalMs: 1,
    monitorMaxPolls: maxPolls,
    monitorStallPolls: stallPolls,
    progressPublishIntervalMs,
    // The root session never moves again after this: it delegated and is waiting.
    readSessionHistory: readSessionHistory ?? (async () => [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "go" }] }]),
    readSessionStatus: async () => "running",
    readChildSessionActivity,
    runtimeWorkspaceRoot: () => root,
    onRunProjection: (_project, _run, type, data) => (type === "run/progress" ? progress : frames).push({ type, data }),
  });
  let projectionWrites = 0;
  const writeProjection = async (value) => {
    const target = path.join(root, ".evimed-run", "state.json");
    const temporary = `${target}.${projectionWrites += 1}.tmp`;
    await writeFile(temporary, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    await rename(temporary, target);
  };
  return { root, project, store, frames, progress, writeProjection };
}

test("a run whose subagents are working is not judged stalled because its root session went quiet", async (t) => {
  // The stall threshold reads the root session's message and tool-call counts,
  // and a delegated stretch is exactly when those stop moving on purpose: the
  // orchestrator hands work to children and waits. Before the run's own
  // projection was read, that was indistinguishable from a run that had died,
  // and the real clinical questions — the ones that delegate most — were the
  // ones most likely to be killed by it.
  const { project, store, writeProjection } = await delegatingRunFixture(t);
  await writeProjection({ evidence: { total: 1, byStatus: { ready: 1 } }, budget: { children: 2 } });
  const run = await store.start(project, { sessionId: "ses_deleg" });

  // The authenticated event pump keeps seeing the child's session advance
  // while the root says nothing at all.
  let seq = 1;
  const ticking = setInterval(() => {
    store.noteKernelActivity(project, run.id, { sessionId: "ses_child", seq });
    seq += 1;
  }, 2);
  try {
    await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);
  } finally {
    clearInterval(ticking);
  }

  const [finished] = await store.list(project);
  assert.equal(finished.errorCode, "runtime_monitor_timeout", "it should run out the window, not be judged dead");
  // The stall signal must not even have fired: a delegating run whose children
  // are working has observable progress, and telling the researcher it looks
  // stuck would be as wrong as ending it was.
  assert.doesNotMatch(noticeTexts(finished).join("\n"), /没有可观测的进展/);
});

test("a running-subagent label without child activity does not keep a stalled run alive", async (t) => {
  // The workspace projection is model-writable. Its claim that a child is
  // running may explain a quiet root, but it cannot be the heartbeat that
  // keeps the run alive forever. Only changing kernel-owned child activity is
  // mirrored into the budget counters used by the stall signal.
  const { project, store, writeProjection } = await delegatingRunFixture(t, { stallPolls: 3, maxPolls: 40 });
  await writeProjection({
    evidence: { total: 0, byStatus: {} },
    budget: { steps: 4, tokens: 100, children: 1 },
    subagents: [{ deliverableId: "d1", capability: "research-brief", status: "running" }],
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  store.noteKernelActivity({ ...project, id: "another-project" }, run.id, { sessionId: "ses_child", seq: 1 });
  await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);

  const [finished] = await store.list(project);
  // The judgement is unchanged and still exactly this precise — a
  // model-written "running" label is not a heartbeat. What changed is what the
  // judgement does: it says so and the run carries on to the global clock,
  // because a threshold is a guess about liveness and ending a run on a guess
  // is what left finished work undelivered.
  assert.match(noticeTexts(finished).join("\n"), /没有可观测的进展/, "a silent child must still reach the stall threshold");
  assert.equal(finished.errorCode, "runtime_monitor_timeout", "the stall threshold must not end the run any more");
});

test("a kernel-confirmed child sequence keeps a delegated run alive", async (t) => {
  let head = 10;
  const calls = [];
  const { project, store, writeProjection } = await delegatingRunFixture(t, {
    stallPolls: 3,
    maxPolls: 8,
    readChildSessionActivity: async (_project, parentSessionId, childSessionIds) => {
      calls.push({ parentSessionId, childSessionIds });
      head += 1;
      return [{ sessionId: "child-live", asOfSeq: head, running: true }];
    },
  });
  await writeProjection({
    evidence: { total: 0, byStatus: {} },
    budget: { children: 1 },
    subagents: [{ deliverableId: "d1", capability: "research-brief", status: "running", childSessionId: "child-live" }],
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);
  const [finished] = await store.list(project);
  assert.equal(finished.errorCode, "runtime_monitor_timeout", "changing authenticated child heads must prevent a false stall");
  assert.ok(calls.length >= 3);
  assert.deepEqual(calls[0], { parentSessionId: "ses_deleg", childSessionIds: ["child-live"] });
});

test("a child named only on its plan item, or only by a delegation receipt, is asked about", async (t) => {
  // Since 2026-09-18 a plan item carries its child's session id from the
  // moment the child exists, and the non-blocking delegate answers with it at
  // once. Neither the kernel's catalogue fact nor the `subagents` row is
  // needed any more for the kernel to be asked about a child — and a child
  // one of them names is still only a candidate the kernel has to confirm.
  const asked = new Set();
  let resolveBoth;
  const both = new Promise((resolve) => { resolveBoth = resolve; });
  const { project, store, writeProjection } = await delegatingRunFixture(t, {
    stallPolls: 1_000,
    maxPolls: 400,
    readChildSessionActivity: async (_project, parentSessionId, childSessionIds) => {
      assert.equal(parentSessionId, "ses_deleg");
      for (const id of childSessionIds) asked.add(id);
      if (asked.has("child-plan") && asked.has("child-receipt")) resolveBoth();
      return [];
    },
  });
  await writeProjection({
    plan: { items: [
      { id: "d1", title: "证据综述", status: "delegated", attempts: 0, childSessionId: "child-plan" },
      { id: "d2", title: "证据矩阵", status: "accepted", attempts: 1, childSessionId: "child-settled" },
    ] },
    evidence: {}, budget: { children: 2 },
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  store.noteRunEvent(project, run.id, {
    sessionId: "ses_deleg",
    event: {
      type: "tool/result", seq: 7, callId: "c-7", tool: "evimed_delegate", status: "completed", narration: "",
      output: kernelToolText({ ok: true, data: { handle: "h-2", deliverableId: "d3", childSessionId: "child-receipt", status: "started" } }),
    },
  });
  await Promise.race([both, new Promise((_, reject) => setTimeout(() => reject(new Error("the monitor never asked about both children")), 5_000))]);
  assert.equal(asked.has("child-settled"), false, "an accepted item's child is not a candidate");
  await store.closeAll();
});

test("a retry child's authenticated head replaces the failed child's stall signal", async (t) => {
  let retryHead = 20;
  let calls = 0;
  const seen = [];
  let publishRetry = async () => {};
  const { project, store, writeProjection } = await delegatingRunFixture(t, {
    stallPolls: 3,
    maxPolls: 8,
    readChildSessionActivity: async (_project, _parentSessionId, childSessionIds) => {
      calls += 1;
      seen.push([...childSessionIds]);
      const id = childSessionIds[0];
      if (id === "child-first" && calls === 3) await publishRetry();
      return id === "child-retry"
        ? [{ sessionId: id, asOfSeq: retryHead += 1, running: true }]
        : [{ sessionId: "child-first", asOfSeq: 10, running: true }];
    },
  });
  await writeProjection({
    subagents: [{ deliverableId: "d1", status: "running", childSessionId: "child-first" }],
    evidence: {}, budget: { children: 1 },
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  publishRetry = () => writeProjection({
    subagents: [{ deliverableId: "d1", status: "running", childSessionId: "child-retry", retried: true }],
    evidence: {}, budget: { children: 2 },
  });
  await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);
  const [finished] = await store.list(project);
  assert.equal(finished.errorCode, "runtime_monitor_timeout");
  assert.ok(seen.some((ids) => ids[0] === "child-retry"), "the monitor never switched to the retry child");
});

test("candidate and running-state churn cannot replace per-child sequence progress", async (t) => {
  let calls = 0;
  let mutate = async () => {};
  const projection = (childSessionId, running) => ({
    subagents: [{ deliverableId: "d1", status: "running", childSessionId }],
    evidence: {}, budget: { children: 1 }, running,
  });
  const { project, store, writeProjection } = await delegatingRunFixture(t, {
    stallPolls: 3,
    maxPolls: 40,
    readChildSessionActivity: async (_project, _parentSessionId, childSessionIds) => {
      calls += 1;
      const id = childSessionIds[0];
      await mutate();
      return [{ sessionId: id, asOfSeq: 10, running: calls % 2 === 0 }];
    },
  });
  let next = "child-b";
  mutate = async () => {
    await writeProjection(projection(next, next === "child-a"));
    next = next === "child-a" ? "child-b" : "child-a";
  };
  await writeProjection(projection("child-a", true));
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);
  const [finished] = await store.list(project);
  assert.match(noticeTexts(finished).join("\n"), /没有可观测的进展/);
  assert.equal(finished.errorCode, "runtime_monitor_timeout");
  assert.ok(calls >= 3, "the fixture did not exercise repeated candidate churn");
});

test("changing model-writable projection counters cannot keep a stalled run alive", async (t) => {
  const { project, store, writeProjection } = await delegatingRunFixture(t, { stallPolls: 3, maxPolls: 80 });
  let step = 1;
  await writeProjection({ evidence: { total: step, byStatus: { ready: step } }, budget: { steps: step, children: 1 } });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  const pendingWrites = new Set();
  let projectionWriteError;
  const ticking = setInterval(() => {
    step += 1;
    const pending = writeProjection({ evidence: { total: step, byStatus: { ready: step } }, budget: { steps: step, children: 1 } });
    pendingWrites.add(pending);
    void pending.then(() => pendingWrites.delete(pending), (error) => {
      projectionWriteError = error;
      pendingWrites.delete(pending);
    });
  }, 2);
  try {
    await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);
  } finally {
    clearInterval(ticking);
    await Promise.all(pendingWrites);
  }
  if (projectionWriteError) throw projectionWriteError;

  const [finished] = await store.list(project);
  assert.match(noticeTexts(finished).join("\n"), /没有可观测的进展/, "workspace counters are display data, not a trusted heartbeat");
  assert.equal(finished.errorCode, "runtime_monitor_timeout");
});

test("a run-side projection that will not parse is a named notice, never evidence of a stall", async (t) => {
  // §14 rule 18. Counting an unreadable file as "did not move" would mean the
  // fix for stall misjudgement introduced a fresh source of it.
  const { project, store, writeProjection } = await delegatingRunFixture(t, { stallPolls: 2 });
  await writeProjection("{ this is not json");
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);

  const [finished] = await store.list(project);
  assert.notEqual(finished.errorCode, "runtime_monitor_stalled", "an unreadable projection fed the stall counter");
  assert.ok(
    noticeTexts(finished).some((line) => /state\.json/.test(line)),
    `the unreadable projection was never said out loud: ${JSON.stringify(noticeTexts(finished))}`,
  );
  // Said once, not once per poll: the monitor woke many times over the same file.
  assert.equal(noticeTexts(finished).filter((line) => /state\.json/.test(line)).length, 1);
});

test("projection frames are sent when the projection changes and not on every poll", async (t) => {
  // Keep the observer alive for the full timing window. A low poll count made
  // this test depend on incidental ledger I/O being slow enough to prevent the
  // monitor from reaching its timeout before the final projection update.
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0, maxPolls: 400 });
  await writeProjection({ evidence: { total: 1, byStatus: { ready: 1 } }, budget: { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } } });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await waitForProjection(() => frames.length >= 2);
  const afterFirst = frames.length;
  assert.ok(afterFirst >= 2, `the first read must send both frames, got ${JSON.stringify(frames)}`);
  assert.deepEqual(frames.filter((frame) => frame.type === "evidence/update")[0].data, { total: 1, byStatus: { ready: 1 } });
  assert.deepEqual(frames.filter((frame) => frame.type === "budget/update")[0].data, { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } });

  // Many more polls over an unchanged file must add nothing.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(frames.length, afterFirst, "an unchanged projection was republished");

  // Only what changed goes out again.
  await writeProjection({ evidence: { total: 2, byStatus: { ready: 2 } }, budget: { steps: 3, tokens: 10, children: 1, limits: { maxSteps: 100 } } });
  await waitForProjection(() => frames.length > afterFirst);
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
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0, maxPolls: 400 });
  const plan = (items) => ({ plan: { revision: 1, items }, evidence: { total: 0, byStatus: {} }, budget: {} });
  await writeProjection(plan([
    { id: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", title: "证据综述", status: "submitted", childSessionId: "child-1", attempts: 1, lastIssues: [] },
    { id: "d2", contractKind: "research-brief", capability: "research-brief", title: "简报", status: "planned", childSessionId: null, attempts: 0, lastIssues: [] },
  ]));
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await waitForProjection(() => frames.filter((frame) => frame.type === "deliverable/update").length >= 2);

  const first = frames.filter((frame) => frame.type === "deliverable/update");
  assert.equal(first.length, 2, `both planned deliverables must be published once: ${JSON.stringify(first)}`);
  assert.deepEqual(first[0].data, {
    id: "d1",
    contractKind: "clinical-evidence-report",
    capability: "clinical-evidence-synthesis",
    title: "证据综述",
    status: "submitted",
    attempts: 1,
    childSessionId: "child-1",
    issues: [],
    mustFixCount: 0,
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
  await waitForProjection(() => frames.filter((frame) => frame.type === "deliverable/update").length > 2);
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
  const { project, store, frames, writeProjection } = await delegatingRunFixture(t, { stallPolls: 0, maxPolls: 400 });
  await writeProjection({
    plan: { revision: 1, items: [{ id: "d1", contractKind: "not-a-contract-kind", status: "not-a-status", capability: "x", title: "" }] },
  });
  const run = await store.start(project, { sessionId: "ses_deleg" });
  await waitForProjection(() => frames.some((frame) => frame.type === "deliverable/update"));
  const published = frames.filter((frame) => frame.type === "deliverable/update");
  assert.equal(published.length, 1);
  assert.equal(published[0].data.contractKind, "");
  assert.equal(published[0].data.status, "planned", "a status outside PLAN_ITEM_STATES must not travel as one");
  assert.equal(published[0].data.title, "d1", "a titleless item falls back to its id rather than rendering blank");
  store.monitors.get(run.id)?.cancel();
});

test("a run that stops making progress is told so, and is not ended on that guess", async () => {
  // start/dispatch/finish cannot distinguish a long run from a dead one, so
  // progress is recorded and a quiet stretch is detected. What that detection
  // is allowed to do is the part that changed: it reports, and the global clock
  // decides. Ending a run because a counter stopped moving is an inference
  // about liveness, and the runs it was wrong about — the delegating clinical
  // ones — were the ones with finished work in the workspace.
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

    // Move once, then go quiet.
    history = [...history, { info: { id: "m2", role: "assistant" }, parts: [{ type: "tool", tool: "health" }] }];
    await awaitBackgroundMonitor(store.monitors.get(run.id)?.promise);

    const [finished] = await store.list(project);
    assert.match(noticeTexts(finished).join("\n"), /没有可观测的进展/, "the quiet stretch must still be detected and reported");
    assert.equal(finished.errorCode, "runtime_monitor_timeout", "only the global clock ends a run");
    assert.ok(finished.observedToolCalls >= 1, "the progress it did make is recorded");
    // Said once. A notice repeated every poll is a log, and the run row caps
    // notices, so a chatty one would push the real findings off the end.
    assert.equal(noticeTexts(finished).filter((notice) => /没有可观测的进展/.test(notice)).length, 1);
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
    await relabelReceipt(project, started.id);
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
    await relabelReceipt(project, started.id);
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
      // Since `web_read` reads any public page, the refusals left are the
      // site's own: its robots.txt, or a page no browser could open.
      name: "a web page the gateway refused to read",
      expectedStatus: "succeeded",
      expectedErrorCode: null,
      parts: [
        {
          type: "tool",
          tool: "mcp__evimed__web_read",
          state: {
            status: "error",
            error: JSON.stringify({
              status: "error",
              summary: "closed.example.org's robots.txt does not allow reading this page; use another source for it.",
              error: { code: "web_read_robots_disallowed" },
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
    await relabelReceipt(project, started.id);
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
    /** @type {string[]} */
    const repairs = [];
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
        // Server-side repair rounds are off by default since 2026-09-17; this
        // case is about what such a round says when a deployment turns them on.
        maxClinicalRepairAttempts: 2,
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
      }, async (_session, _record, repairText) => { if (repairText) repairs.push(repairText); return { accepted: true }; });

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
      if (scenario === "recorded") {
        assert.equal(finished.status, "succeeded");
        assert.equal(finished.errorCode, null);
        assert.deepEqual(repairs, [], "a package the gate accepts is not sent back for repair");
      } else {
        // The gate's finding is unchanged — the cited source is not in the
        // snapshot — but this capability is no longer failed outright for it.
        // The repair loop used to be reserved for `clinical-evidence-synthesis`
        // while raising identical, actionable issues for the other fifteen, so
        // this run now gets the round the clinical line always got.
        assert.equal(finished.status, "running", "a repairable rejection sends the run back to fix it");
        assert.equal(repairs.length, 1, "exactly one repair round is opened");
        // The generic prompt, not the clinical one: this run has no
        // clinical-evidence-report.md, and ordering it to repair one would
        // spend a bounded attempt discovering that.
        assert.match(repairs[0], /comprehensive-drug-evaluation package/);
        assert.doesNotMatch(repairs[0], /clinical-evidence-report\.md/);
        assert.match(repairs[0], /comprehensive-evaluation-report\.md/, "it must name this capability's own required outputs");
        assert.match(repairs[0], /evidence-snapshot\.json/, "and carry the gate's issue verbatim");
      }
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

test("server-valid clinical bytes without a local receipt get one resubmit-only repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-resubmit-valid-"));
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
    const binding = { sessionId: "ses_resubmit_valid", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const pkg = deepResearchPackage();
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
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_resubmit_valid",
      // Held, as on every production dispatch, so the server's verdict on
      // these bytes covers every layer of the gate.
      question: pkg.briefText,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) repairPrompts.push(repairText);
      return { accepted: true };
    });

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
    ]);
    for (const [relative, content] of deliverables) {
      await writeFile(path.join(project.workspaceDir, relative), content, "utf8");
    }
    for (const [artifactPath, content] of Object.entries(pkg.sourceArtifacts)) {
      await mkdir(path.join(project.workspaceDir, path.dirname(artifactPath)), { recursive: true });
      await writeFile(path.join(project.workspaceDir, artifactPath), content, "utf8");
    }
    await mkdir(path.join(project.workspaceDir, ".evimed-run"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify({
      formatVersion: 1,
      runId: run.id,
      plan: { revision: 1, items: [{ id: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", status: "rejected", attempts: 3 }] },
      budget: { steps: 60, tokens: 1, children: 1, limits: {} },
      evidence: { total: 1, byStatus: { ready: 1 } },
      gateRuns: [],
      subagents: [],
      qualityNotices: [],
      degraded: [],
    }, null, 2), "utf8");

    const retrievalParts = Object.entries(pkg.sourceArtifacts).map(([artifactPath, content]) => ({
      type: "tool",
      tool: "evimed-research_evimed_open_access_full_text",
      state: {
        status: "completed",
        output: JSON.stringify({ status: "success", artifacts: [artifactPath], data: { artifactSha256s: { [artifactPath]: createHash("sha256").update(content, "utf8").digest("hex") } } }),
      },
    }));
    history = [{
      info: { id: "msg_resubmit_valid", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...retrievalParts,
        ...[...deliverables.keys()].map((filePath) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath } } })),
        { type: "text", text: "The corrected files are complete; the local submission ceiling was reached before this version could receive a receipt." },
      ],
    }];

    const current = await store.reconcileSession(project, binding.sessionId);
    assert.equal(current.status, "running", "the server-valid current bytes need a receipt, not a terminal failure");
    assert.equal(repairPrompts.length, 1, "one resubmit-only repair must be sent");
    assert.match(repairPrompts[0], /evimed_submit_deliverable/);
    assert.match(repairPrompts[0], /do not edit|不要修改/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Break only a bookkeeping check in the shared package: CLM-013 keeps its
 *  hidden marker and loses its numbered citation. Reference 1 is still cited
 *  on CLM-001's line, so no other rule has anything to say.
 *  @param {any} pkg */
function dropOneNumberedCitation(pkg) {
  const line = pkg.reportText.split("\n").find((entry) => entry.includes("<!-- claim:CLM-013 -->"));
  const stripped = line.replace(/ \[1\]\([^)]+\)/, "");
  assert.notEqual(stripped, line, "the fixture line must carry the citation this removes");
  pkg.reportText = pkg.reportText.replace(line, stripped);
}

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
    dropOneNumberedCitation(pkg);
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
      question: pkg.briefText,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
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
    history = [{
      info: { id: "msg_clinical_degrade", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...retrievalParts,
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
    // Only a bookkeeping gap remained: deliver, do not discard.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    // And do not stamp. "Unverified" is a statement about the evidence, and it
    // used to fire on any remaining issue — so a package whose only notices
    // were a gate bug of ours carried the same mark as one with a quotation
    // absent from its source. A mark that means everything means nothing.
    // Every layer ran, so it is not "unchecked" either.
    assert.equal(finished.verification ?? null, null);
    // The gap is still said, as a remark on the delivery rather than a must-fix.
    const notices = noticeTexts(finished).join("\n");
    assert.match(notices, /claims\[12\] is not paired with its standard numbered in-text citation\./);
    assert.doesNotMatch(notices, /MUST FIX|SAFETY/);
    assert.ok(finished.artifacts.includes("clinical-evidence-report.md"));
    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sources a delegated child preserved count for the parent's package, read from the delegation as the kernel records it", async () => {
  // 2026-09-16, memory-ablation v7 cell 1: the child preserved the full text
  // and the gate still refused the path, because the root's \`evimed_delegate\`
  // result is recorded as \`ok\\n{…}\` text and the reader parsed only bare JSON
  // — so it found no child to read at any address. Same package as the test
  // above, with every retrieval moved into a delegated child.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-delegated-sources-"));
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
      sessionId: "ses_delegated_sources",
      mode: "open-domain",
      agentId: null,
      agentVersion: null,
      runtimeAgent: null,
    };
    const pkg = deepResearchPackage();
    dropOneNumberedCitation(pkg);
    let history = [];
    let childHistory = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "1.0.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          outputs: [
            { path: "clinical-evidence-report.md", required: true },
            { path: "clinical-evidence-matrix.json", required: true },
          ],
          completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async (_project, sessionId, options = {}) => {
        if (sessionId === "child-sources") {
          // Only under the parent's address, as the kernel serves a subagent.
          if (options.parentSessionId !== "ses_delegated_sources") throw Object.assign(new Error("subagent Sessions require their durable parent address"), { code: "runtime_session_error" });
          return childHistory;
        }
        return history;
      },
      readSessionStatus: async () => "idle",
      // No repair budget: go straight to the terminal delivery decision.
      maxClinicalRepairAttempts: 0,
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_delegated_sources",
      question: pkg.briefText,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
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
    childHistory = [{
      info: { id: "msg_child_sources", role: "assistant", time: { completed: Date.now() } },
      parts: [...retrievalParts, { type: "text", text: "Sources preserved." }],
    }];
    history = [{
      info: { id: "msg_delegated_sources", role: "assistant", time: { completed: Date.now() } },
      parts: [
        {
          type: "tool",
          tool: "evimed_delegate",
          state: { status: "completed", output: kernelToolText({ ok: true, data: { deliverableId: "d1", childSessionId: "child-sources" } }) },
        },
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
    // Only the bookkeeping gap remained: deliver, do not discard.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    // The child's receipts vouch for every path the claims cite. Unread, each
    // path would be named as one no tool preserved and the package stamped.
    const notices = noticeTexts(finished).join("\n");
    assert.doesNotMatch(notices, /no evidence tool reported preserving that file/);
    assert.equal(finished.verification ?? null, null);
    assert.match(notices, /claims\[12\] is not paired with its standard numbered in-text citation\./);
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
    // over plain HTTP. Rewritten in the report and the matrix alike, so the
    // citation and the claims it anchors still agree.
    const insecure = "http://www.escardio.org/evidence/source-3";
    const secure = "https://www.escardio.org/evidence/source-3";
    const pkg = deepResearchPackage();
    const rewrite = (value) => value.split(secure).join(insecure);
    pkg.reportText = rewrite(pkg.reportText);
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
      question: pkg.briefText,
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    const deliverables = new Map([
      ["clinical-evidence-report.md", pkg.reportText],
      ["clinical-evidence-matrix.json", JSON.stringify(pkg.matrix)],
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
    history = [{
      info: { id: "msg_http_citation", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...retrievalParts,
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
    assert.match(noticeTexts(finished).join("\n"), /plain HTTP/);
    // A reachable source over plain HTTP says nothing about the evidence, and
    // every layer ran: no mark at all.
    assert.equal(finished.verification ?? null, null);
    assert.match(noticeTexts(finished).join("\n"), /escardio\.org\/evidence\/source-3/);
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

/** An evidence matrix whose one claim cites `source`. The cases below write
 *  that file to disk and have no tool report preserving it, so the gate names
 *  the path as one this run never vouched for.
 *  @param {string} source */
function matrixCitingUnvouchedSource(source) {
  return JSON.stringify({
    schemaVersion: 1,
    claims: [{
      claimId: "CLM-001",
      claim: "正文。",
      sourceUrl: "https://www.acc.org/guidance/source-a",
      sourceTitle: "Source A",
      artifactPath: source,
      identifier: "SOURCE-A",
      accessLevel: "official_page",
      supportQuote: "Preserved source text.",
      applicability: "Directly informs the question.",
      uncertainty: "Implementation may vary.",
      referenceNumber: 1,
    }],
  });
}

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
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      readSessionHistory: async () => {
        if (history.length) await new Promise((resolve) => setTimeout(resolve, 10));
        return history;
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
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

    // A matrix citing a source no retrieval tool reported preserving: the
    // package is otherwise written and on disk.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), matrixCitingUnvouchedSource(source), "utf8");
    history = [{
      info: { id: "msg_repair_provenance", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
    const [first, concurrent] = await Promise.all([
      store.reconcileSession(project, binding.sessionId),
      store.reconcileSession(project, binding.sessionId),
    ]);
    assert.equal(first.id, run.id);
    assert.equal(concurrent.id, run.id);
    assert.equal(repairPrompts.length, 1, "a repair prompt was sent");
    assert.match(
      repairPrompts[0],
      /The evidence matrix cites \.evimed-sources\/official-pages\/source-a\/page\.md, but no evidence tool reported preserving that file/,
    );

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an authorized revision that did not pass gets its next round, and ends delivered with its findings rather than as tampering", async () => {
  // v8 ablation, cell review-003 candidate r0 (2026-09-16): round one's grant
  // was consumed and the report edited, the resubmission was refused, and round
  // two refused to preserve a package whose files no longer matched the
  // receipt. The ledger then called it `specialist_receipt_digest_mismatch`,
  // dropped the files, and cut the notice saying which files moved.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-revision-round-two-"));
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
    const binding = { sessionId: "ses_revision_round_two", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
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
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 2,
      repairRetryDelaysMs: [0, 0],
      runtimeGeneration: async () => "runtime-generation-1",
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_revision_round_two",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) repairPrompts.push(repairText);
      return { accepted: true };
    });

    // A package the run-side gate accepted and the server refuses: its matrix
    // cites a source no retrieval tool reported preserving.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    const files = new Map([
      ["deliverables/review/clinical-evidence-report.md", "# 报告\n\n正文。"],
      ["deliverables/review/clinical-evidence-matrix.json", matrixCitingUnvouchedSource(source)],
    ]);
    await mkdir(path.join(project.workspaceDir, "deliverables", "review"), { recursive: true });
    for (const [relative, text] of files) await writeFile(path.join(project.workspaceDir, relative), text, "utf8");
    await writeFile(path.join(project.workspaceDir, workspaceLayout.receiptFile), JSON.stringify({
      formatVersion: 1,
      runId: run.id,
      bundleVersion: "1.0.0",
      domainVersion: "1.0.0",
      entries: [{
        deliverableId: "review",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        acceptedAt: new Date().toISOString(),
        attempt: 1,
        notices: [],
        files: [...files].map(([relative, text]) => ({ path: relative, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) })),
      }],
    }), "utf8");
    const turn = (id) => ({
      info: { id, role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...[...files.keys()].map((filePath) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath } } })),
        { type: "text", text: "Completed." },
      ],
    });
    history = [turn("msg_accepted")];

    const roundOne = await store.reconcileSession(project, binding.sessionId);
    assert.equal(roundOne.status, "running");
    assert.equal(repairPrompts.length, 1);
    assert.match(repairPrompts[0], /evimed_revise_deliverable/, "the accepted deliverable is frozen, so round one opens a revision");

    // The run spends the grant, edits the report, and is refused again.
    const grantDirectory = path.join(project.metaDir, "repair-authorizations");
    const grantName = (await readdir(grantDirectory)).find((name) => !name.includes(".claimed."));
    const grant = JSON.parse(await readFile(path.join(grantDirectory, grantName), "utf8"));
    const consumed = await store.consumeRepairAuthorization(project, {
      runId: grant.runId, deliverableId: grant.deliverableId, acceptedDigest: grant.acceptedDigest, runtimeGeneration: "runtime-generation-1",
    }, { revalidateRuntimeGeneration: async () => "runtime-generation-1" });
    assert.equal(consumed.authorized, true);
    await writeFile(path.join(project.workspaceDir, "deliverables/review/clinical-evidence-report.md"), "# 报告\n\n修订后的正文。", "utf8");
    history = [...history, turn("msg_revision_one")];

    const roundTwo = await store.reconcileSession(project, binding.sessionId);
    assert.equal(roundTwo.status, "running", `round two is sent, not refused: ${JSON.stringify(noticeTexts(roundTwo))}`);
    assert.equal(repairPrompts.length, 2);
    assert.doesNotMatch(repairPrompts[1], /evimed_revise_deliverable/, "the revision is already open");

    history = [...history, turn("msg_revision_two")];
    const finished = await store.reconcileSession(project, binding.sessionId);
    // Rounds spent: the revised package is what is on disk, so that is what is
    // delivered — marked, with what it still fails and the fact that these are
    // not the bytes the receipt names. Never "tampering", never no files.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification, "unverified");
    assert.ok(finished.artifacts.includes("deliverables/review/clinical-evidence-report.md"), JSON.stringify(finished.artifacts));
    assert.match(
      noticeTexts(finished).join("\n"),
      /The evidence matrix cites \.evimed-sources\/official-pages\/source-a\/page\.md, but no evidence tool reported preserving that file/,
    );
    assert.match(noticeTexts(finished).join("\n"), /交付物在写下回执之后被改动了 1 个文件/);
    assert.doesNotMatch(noticeTexts(finished).join("\n"), /重判并通过/, "an unverified package is not said to have passed");

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repair the runtime refuses is named, and the package is delivered with it rather than discarded", async () => {
  // 2026-09-16, memory-ablation v7 cell 1: the repair was refused 68 ms after it
  // was authorized, and the ledger, the audit log and the container output held
  // nothing about why — the catch around the send was empty.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-refused-"));
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
      sessionId: "ses_repair_refused",
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
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      repairRetryDelaysMs: [0, 0],
      readSessionHistory: async () => {
        if (history.length) await new Promise((resolve) => setTimeout(resolve, 10));
        return history;
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_refused",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) {
        repairPrompts.push(repairText);
        throw Object.assign(new Error("Session is busy with another turn."), { code: "runtime_session_error" });
      }
      return { accepted: true };
    });

    // A matrix citing a source no retrieval tool reported preserving: the
    // package is otherwise written and on disk.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), matrixCitingUnvouchedSource(source), "utf8");
    history = [{
      info: { id: "msg_repair_refused", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.equal(repairPrompts.length, 3, "a transient refusal is sent again, a bounded number of times");
    // A repair that could not be sent leaves the package what it was: delivered
    // with its finding and with the refusal named (2026-09-17). It used to fail
    // the run, which threw away a finished report over our own dispatch.
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.verification, "unverified");
    const notices = noticeTexts(finished).join("\n");
    assert.match(
      notices,
      /The evidence matrix cites \.evimed-sources\/official-pages\/source-a\/page\.md, but no evidence tool reported preserving that file/,
      "the issue it was meant to repair is still named",
    );
    assert.match(notices, /repair request could not be dispatched after 3 attempts \(runtime_session_error: Session is busy with another turn\.\)/);

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repair refused once while the turn settles goes through on the next attempt", async () => {
  // 2026-09-16, memory-ablation v7 cell 1: the repair was refused 68 ms after it
  // was authorized, and the ledger, the audit log and the container output held
  // nothing about why — the catch around the send was empty.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-retried-"));
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
      sessionId: "ses_repair_retried",
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
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      repairRetryDelaysMs: [0, 0],
      readSessionHistory: async () => {
        if (history.length) await new Promise((resolve) => setTimeout(resolve, 10));
        return history;
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_retried",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) {
        repairPrompts.push(repairText);
        if (repairPrompts.length === 1) throw Object.assign(new Error("Session is busy with another turn."), { code: "runtime_session_error" });
      }
      return { accepted: true };
    });

    // A matrix citing a source no retrieval tool reported preserving: the
    // package is otherwise written and on disk.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), matrixCitingUnvouchedSource(source), "utf8");
    history = [{
      info: { id: "msg_repair_retried", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
    const repairing = await store.reconcileSession(project, binding.sessionId);
    assert.equal(repairing.id, run.id);
    assert.equal(repairPrompts.length, 2);
    assert.equal(repairing.status, "running", "the repair went out on the second attempt and the run is repairing");
    assert.match(
      repairPrompts[1],
      /The evidence matrix cites \.evimed-sources\/official-pages\/source-a\/page\.md, but no evidence tool reported preserving that file/,
    );

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repair refused for good is not sent again", async () => {
  // 2026-09-16, memory-ablation v7 cell 1: the repair was refused 68 ms after it
  // was authorized, and the ledger, the audit log and the container output held
  // nothing about why — the catch around the send was empty.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-repair-final-"));
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
      sessionId: "ses_repair_final",
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
          ],
          completionChecks: ["requiredOutputsExist", "evidenceClaimsTraceable"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      maxClinicalRepairAttempts: 1,
      repairRetryDelaysMs: [0, 0],
      readSessionHistory: async () => {
        if (history.length) await new Promise((resolve) => setTimeout(resolve, 10));
        return history;
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_repair_final",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async (_session, _record, repairText = null) => {
      if (repairText) {
        repairPrompts.push(repairText);
        throw Object.assign(new Error("The run is no longer accepting repair prompts."), { code: "agent_run_active", status: 409 });
      }
      return { accepted: true };
    });

    // A matrix citing a source no retrieval tool reported preserving: the
    // package is otherwise written and on disk.
    const source = ".evimed-sources/official-pages/source-a/page.md";
    await mkdir(path.join(project.workspaceDir, path.dirname(source)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, source), "Preserved source text.", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), matrixCitingUnvouchedSource(source), "utf8");
    history = [{
      info: { id: "msg_repair_final", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.equal(repairPrompts.length, 1, "a refusal that cannot clear is not retried");
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.verification, "unverified");
    const notices = noticeTexts(finished).join("\n");
    assert.match(
      notices,
      /The evidence matrix cites \.evimed-sources\/official-pages\/source-a\/page\.md, but no evidence tool reported preserving that file/,
      "the issue it was meant to repair is still named",
    );
    assert.match(notices, /repair request could not be dispatched \(agent_run_active: The run is no longer accepting repair prompts\.\)/);

    await store.closeProject(project, "canceled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new run never joins an older run's in-flight reconciliation on the same session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-reconcile-generation-"));
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
    const binding = { sessionId: "same-session", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
    let reads = 0;
    let blockNextRead = false;
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => {
        reads += 1;
        if (blockNextRead) {
          blockNextRead = false;
          enterFirst();
          await firstRelease;
        }
        return [];
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const first = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn-first-run",
    }, async () => ({ accepted: true }));
    blockNextRead = true;
    const firstReconcile = store.reconcileSession(project, binding.sessionId, first.id);
    await firstEntered;
    await store.finishInternal(project, first.id, { status: "succeeded", errorCode: null, artifacts: [] });
    const second = await store.createRun(project, binding, { baselineCursor: null, dispatchId: "turn-second-run" });

    const readsBeforeSecondReconcile = reads;
    const secondReconcile = store.reconcileSession(project, binding.sessionId, second.id);
    releaseFirst();
    const [observedFirst, observedSecond] = await Promise.all([firstReconcile, secondReconcile]);

    assert.equal(observedFirst.id, first.id);
    assert.equal(observedSecond.id, second.id);
    assert.equal(observedSecond.status, "running");
    assert.ok(reads > readsBeforeSecondReconcile, "different runs require independent reconciliation reads");
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
    await awaitBackgroundMonitor(monitor?.promise);
    assert.equal(repairPrompts.length, 0, "the monitor sent nothing before it was stopped");
    sessionStatus = "idle";

    // A complete package on disk whose matrix does not parse. Nothing else is
    // wrong with it, and the run cannot be told anything else until it parses.
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-report.md"), "# 报告\n\n正文。", "utf8");
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), '{"claims": [', "utf8");
    const finishedTurn = (id) => ({
      info: { id, role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
    // And ends delivered: the report is on disk, the matrix that would verify
    // it cannot be read, and the mark says exactly that.
    assert.equal(third.status, "succeeded");
    assert.equal(third.verification, "unverified");
    assert.match(noticeTexts(third).join("\n"), /clinical-evidence-matrix\.json must contain strict valid JSON/);

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
    await awaitBackgroundMonitor(monitor?.promise);
    sessionStatus = "idle";

    // The same unparseable matrix as the structural case, plus one plain-HTTP
    // citation: reachable, so the claim stands and the gate only advises.
    await writeFile(
      path.join(project.workspaceDir, "clinical-evidence-report.md"),
      "# 报告\n\n正文，见 http://example.org/a 。\n",
      "utf8",
    );
    await writeFile(path.join(project.workspaceDir, "clinical-evidence-matrix.json"), '{"claims": [', "utf8");
    history = [{
      info: { id: "msg_structural_advisory_1", role: "assistant", time: { completed: Date.now() } },
      parts: [
        ...["clinical-evidence-report.md", "clinical-evidence-matrix.json"].map((filePath) => ({
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
  const gate =await readFile(new URL("../../../packages/domain/src/clinicalEvidence.mjs", import.meta.url), "utf8");
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
  // The web-read gateway answers `web_read` with its own codes, and the
  // knowledge-base gateway answers `kb_search` with its own; the tools pass
  // them through to the run unchanged (2026-09-20).
  for (const relative of [
    "../src/publicSourceGateway.mjs", "../src/webSearchGateway.mjs", "../src/geoProbeGateway.mjs",
    "../src/webRead.mjs", "../src/webReadNetwork.mjs", "../src/webReadLimits.mjs", "../src/agentbay/browser.mjs",
    "../src/kbSearchGateway.mjs",
  ]) {
    const text = await readFile(new URL(relative, import.meta.url), "utf8");
    for (const [, code] of text.matchAll(/"((?:public_source|web_search|geo_probe|web_read|web_render|kb_search)_[a-z0-9_]+)"/g)) emitted.add(code);
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
  // And for the tool that replaced it: a site saying no, or needing a browser
  // this deployment lacks, is a fact about the source.
  assert.ok(recoverableEvidenceSourceErrorCodes.has("web_read_robots_disallowed"));
  assert.ok(recoverableEvidenceSourceErrorCodes.has("web_read_needs_browser"));
  assert.ok(terminalEvidenceSourceErrorCodes.has("web_read_url_invalid"));
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
      { type: "tool", tool: "write", state: { input: { filePath: "clinical-evidence-matrix.json", content: "z" } } },
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

test("the brief reaches the gate and the workspace, and never the run ledger", async () => {
  // The brief is what the question-scoped safety rule reads, and it runs to
  // several thousand characters. runs.jsonl has a byte ceiling that a
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

// --- the delivery decision on the shared package -----------------------------

/** Deliver the shared fixture package through the store and return the terminal
 *  run.
 *
 *  `finished` is the delivery decision as reconcileSession returned it.
 *  `delivered` is what a later reader of /api/agent-runs sees.
 *  `forgetBrief: "memory"` drops the server's in-memory copy of the brief
 *  before the gate runs — the state a restart leaves a run in, which the copy
 *  kept beside the ledger now survives. `forgetBrief: true` drops that copy
 *  too: a run dispatched before briefs were kept, or whose copy is unreadable.
 *  @param {string} label @param {Record<string, any>} options */
async function deliverClinicalPackage(label, {
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
        ],
        completionChecks: ["requiredOutputsExist", "citationsResolvable", "evidenceClaimsTraceable"],
      }),
    },
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
  history = [{
    info: { id: `msg_${label}`, role: "assistant", time: { completed: Date.now() } },
    parts: [
      ...retrievalParts,
      ...[...deliverables.keys()].map((filePath) => ({
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath } },
      })),
      { type: "text", text: "Completed." },
    ],
  }];
  if (forgetBrief) store.dispatchedBriefs.delete(run.id);
  if (forgetBrief === true) await rm(store.briefFile(project, run.id), { force: true });
  const finished = await store.reconcileSession(project, binding.sessionId);
  assert.equal(finished.id, run.id);
  const delivered = (await store.list(project)).find((item) => item.id === run.id);
  await store.closeProject(project, "canceled");
  await rm(root, { recursive: true, force: true });
  return { finished, delivered };
}

// --- "not checked" is not "checked and clean" --------------------------------

test("a notice that arrives before the run finishes is not overwritten by the terminal event", async () => {
  // A notice can land while a run is still working — the monitor's stall
  // notice, an unreadable run-side projection — and folding is meant to be
  // order-independent: the terminal event must not erase it, nor the
  // admission it carried.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-notice-early-"));
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
    const binding = { sessionId: "ses_early", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const { run } = await store.reserveRun(project, binding, { baselineCursor: null });
    await store.appendQualityNotices(project, run.id, ["某一层没有运行：早到的说明。"], { unchecked: true });
    const running = (await store.list(project)).find((item) => item.id === run.id);
    assert.equal(running.status, "running", "a notice must not finish a run");
    assert.deepEqual(noticeTexts(running), ["某一层没有运行：早到的说明。"]);

    const finished = await store.finishInternal(project, run.id, {
      status: "succeeded",
      errorCode: null,
      artifacts: [],
      qualityNotices: ["门禁自己的说明。"],
    });
    // The gate's own notices lead; the early notice survives behind them.
    assert.deepEqual(noticeTexts(finished), ["门禁自己的说明。", "某一层没有运行：早到的说明。"]);
    // And so does the admission it carried: a terminal event that says nothing
    // about verification must not silently overwrite one that already did.
    assert.equal(finished.verification, "unchecked");
    assert.equal((await store.list(project)).find((item) => item.id === run.id).verification, "unchecked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run whose brief the server no longer holds is delivered unchecked, and says which rule did not run", async () => {
  // A run whose brief is gone — dispatched before briefs were kept beside the
  // ledger, or its kept copy unreadable — reaches the gate without it, and the
  // question-scoped safety rule — does the report bring in a medicine the
  // question never named? — cannot run. The same package with its brief in
  // hand is delivered with no mark at all (next test); without it, it must not
  // read as the same thing.
  const { finished, delivered } = await deliverClinicalPackage("brief-lost", { forgetBrief: true });
  assert.equal(finished.status, "succeeded", "a lost brief is not the run's fault");
  assert.equal(finished.errorCode, null);
  assert.ok(finished.artifacts.includes("clinical-evidence-report.md"), JSON.stringify(finished.artifacts));
  assert.equal(finished.verification, "unchecked");
  // Said once, in the reader's language, naming the rule that did not run.
  assert.equal(finished.qualityNotices.length, 1, JSON.stringify(finished.qualityNotices));
  assert.match(noticeTexts(finished)[0], /^本次交付没有按原始题面核对「报告是否引入了题面没有提到的药品」/);
  // And what /api/agent-runs serves afterwards says the same.
  assert.equal(delivered.verification, "unchecked");
  assert.deepEqual(delivered.qualityNotices, finished.qualityNotices);
  // Structured for the reader (C2): a code, a severity and a Chinese title.
  assert.equal(finished.qualityNotices[0].code, "run_brief_lost");
  assert.equal(finished.qualityNotices[0].title, "未按原始题面核对药品范围");
});

test("a clean package with every layer run stays null, and a finding still outranks an admission", async () => {
  // Null must keep meaning "checked, nothing to report", or the third value
  // buys nothing.
  const clean = await deliverClinicalPackage("brief-held");
  assert.equal(clean.finished.status, "succeeded");
  assert.equal(clean.finished.verification, null);
  assert.deepEqual(noticeTexts(clean.finished), []);

  // A restart no longer costs the safety layer: the process lost its memory,
  // the brief kept beside the ledger did not (E §9.1).
  const restarted = await deliverClinicalPackage("brief-restarted", { forgetBrief: "memory" });
  assert.equal(restarted.finished.verification, null, JSON.stringify(restarted.finished.qualityNotices));
  assert.deepEqual(noticeTexts(restarted.finished), []);

  // Brief lost AND a blocking finding of another kind: "we checked and it did
  // not hold up" is the more serious statement and is the one shown.
  const both = await deliverClinicalPackage("brief-lost-and-finding", {
    forgetBrief: true,
    mutate: (pkg) => { pkg.matrix.claims[0].supportQuote = "这句话在它所引的来源里并不存在。"; },
  });
  assert.equal(both.finished.verification, "unverified");
  assert.match(noticeTexts(both.finished)[0], /^MUST FIX — .*supportQuote was not found in its preserved source artifact/);
  // The admission is still said, behind the finding.
  assert.match(noticeTexts(both.finished).at(-1), /^本次交付没有按原始题面核对/);
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
        qualityNotices: ["本次交付没有按原始题面核对「报告是否引入了题面没有提到的药品」。"],
        finishedAt: timestamp,
        durationMs: 1,
      },
      {
        event: "notice",
        id: "run_0001",
        at: timestamp,
        qualityNotices: ["记忆已记录但暂缓生效 1 条：1 条因来源待确认。"],
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
    assert.deepEqual(noticeTexts(run), [
      "本次交付没有按原始题面核对「报告是否引入了题面没有提到的药品」。",
      "记忆已记录但暂缓生效 1 条：1 条因来源待确认。",
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
    await relabelReceipt(project, started.id);
    // Asserted on the ledger rather than on this call's return value: `start`
    // also schedules the monitor, which reconciles on its own, and the run's
    // recorded outcome is what the rest of the system reads either way.
    await store.reconcileSession(project, binding.sessionId).catch(() => {});
    const finished = (await store.list(project)).find((item) => item.id === started.id);

    assert.equal(finished?.status, "succeeded", "a receipt that verifies is a delivered run, whatever became of the container");
    assert.deepEqual(finished?.artifacts, ["deliverables/d1/clinical-evidence-report.md"]);
    assert.deepEqual(finished?.unverifiedArtifacts, [], "a delivered package has nothing ungraded to report");
    assert.deepEqual(noticeTexts(finished), ["one advisory"]);

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
      { parts: [skillToolPart("open-domain-answer")] },
    ]);
    assert.ok(viaTool.has("open-domain-answer"));

    // The kernel renders a lookup failure as the text result of a call the
    // session reports as completed. An evidence-appraisal run passed the gate
    // on 2026-09-09 with exactly one such call for its own capability —
    // `skill "evidence-appraisal" is unknown or no longer available` — so a
    // completed call is a load only when the skill block for that name came back.
    const refused = await loadedOrInjectedSkillsForTest(project, [
      { parts: [{ type: "tool", tool: "skill", state: { status: "completed", input: { name: "evidence-appraisal" }, output: 'Error: skill "evidence-appraisal" is unknown or no longer available' } }] },
      { parts: [{ type: "tool", tool: "skill", state: { status: "completed", input: { name: "geo-content" } } }] },
      { parts: [{ type: "tool", tool: "skill", state: { status: "completed", input: { name: "deep-research" }, output: skillToolPart("citation-integrity").state.output } }] },
    ]);
    assert.deepEqual([...refused], [], "an error text, no output, or another skill's block is not a load");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one run's injected skills cannot satisfy a later run's completion gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-skill-scope-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(path.join(project.workspaceDir, workspaceLayout.runStateDir), { recursive: true });
    await writeFile(path.join(project.workspaceDir, workspaceLayout.runStateFile), JSON.stringify({
      formatVersion: 1,
      runId: "run_a",
      subagents: [{ runId: "run_a", skills: ["clinical-evidence-synthesis"] }],
    }), "utf8");

    // Missing per-run state falls back to the legacy file only to reject its
    // foreign run id; it must not inherit Run A's receipt.
    const absent = await loadedOrInjectedSkillsForTest(project, [], { id: "run_b" });
    assert.equal(absent.has("clinical-evidence-synthesis"), false);

    const runBFile = path.join(project.workspaceDir, runStateFileFor("run_b"));
    await mkdir(path.dirname(runBFile), { recursive: true });
    await writeFile(runBFile, JSON.stringify({ formatVersion: 1, runId: "run_b", subagents: [] }), "utf8");
    const isolated = await loadedOrInjectedSkillsForTest(project, [], { id: "run_b" });
    assert.equal(isolated.has("clinical-evidence-synthesis"), false);
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
    await relabelReceipt(project, started.id);
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
    await relabelReceipt(project, started.id);
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
    await awaitBackgroundMonitor(monitor?.promise?.catch(() => {}));
    await writeFile(path.join(project.workspaceDir, workspaceLayout.runStateFile), JSON.stringify({
      formatVersion: 1,
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
    assert.ok(noticeTexts(finished).includes(fresh), "a line the run admitted only in its final state must still reach the verdict");
    assert.equal(
      noticeTexts(finished).filter((line) => line === admitted).length,
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
  assert.match(call, /readRunStateProjection\(project, project\.workspaceDir, run\)/, "the projection must be read from the host path and scoped to this run");
  assert.equal(
    /runtimeWorkspaceRoot\(/.test(call),
    false,
    "the container's view of the workspace is not a path this process can open",
  );

  // Negative control: the two call sites that DO need the container root must
  // keep it, or fixing this would break the paths the model actually wrote.
  assert.match(code, /artifactCandidates\(message, runtimeWorkspaceRoot\)/);
  assert.match(code, /successfulEvidenceSourceArtifacts\(allRunAssistants, runtimeWorkspaceRoot\)/);
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
  assert.match(prompt, /evimed_revise_deliverable/, "an accepted package needs an explicit new revision before its files can change");
  assert.match(prompt, /authenticated repair successor/, "a resumed root must know it owns the repair without delegating the package again");
  assert.match(prompt, /do not delegate any file or source to another child/);
  const unaccepted = clinicalEvidenceRepairPromptForTest([
    "clinical-evidence-matrix.json is malformed",
  ], null, false);
  assert.equal(/evimed_revise_deliverable|local gate already accepted|protected kernel storage/.test(unaccepted), false,
    "a package with no accepted receipt must be repaired directly without inventing revision authority");
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

test("the preserved accepted bytes can be read back, and only by their own digest", async () => {
  // The writer above has existed since the repair loop was built and had no
  // reader at all. That is the second half of the aripiprazole failure: the run
  // kept editing after its package was accepted, the receipt stopped matching,
  // and the version that had passed the gate sat in `.openscience/repair-revisions/`
  // with no route to it. A snapshot nobody can open is a backup that does not
  // exist, so this test is the reader.
  const root = await mkdtemp(path.join(tmpdir(), "os-repair-readback-"));
  try {
    const project = {
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const relative = "deliverables/review/clinical-evidence-report.md";
    const accepted = "# Accepted review\n二甲双胍的原始已核验版本。\n";
    await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), accepted);
    await writeFile(path.join(project.workspaceDir, workspaceLayout.receiptFile), JSON.stringify({
      formatVersion: 1,
      runId: "run_control",
      bundleVersion: "1.0.0",
      domainVersion: "1.0.0",
      entries: [{
        deliverableId: "review",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        acceptedAt: "2026-09-06T00:00:00Z",
        attempt: 1,
        notices: [],
        files: [{ path: relative, sha256: createHash("sha256").update(accepted).digest("hex"), bytes: Buffer.byteLength(accepted) }],
      }],
    }));
    await snapshotAcceptedPackageForRepairForTest(project, { id: "run_control", nativeTurn: null }, "runtime-generation-1");

    const store = new AgentRunStore({ get: async () => null }, { model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000 });

    const revisions = await store.listRepairRevisions(project, "run_control");
    assert.equal(revisions.length, 1, "the snapshot the writer just made must be listable");
    assert.match(revisions[0].acceptedDigest, /^[0-9a-f]{64}$/);
    // Metadata only. A package is a dozen files of report prose, and a list
    // endpoint that inlined all of them is the endpoint nobody calls.
    assert.deepEqual(revisions[0].files.map((file) => file.path), [relative]);
    assert.equal(Object.hasOwn(revisions[0].files[0], "text"), false, "the list must not carry file bodies");

    const file = await store.readRepairRevisionFile(project, "run_control", revisions[0].acceptedDigest, relative);
    assert.equal(file.text, accepted, "the bytes handed back must be the bytes the gate accepted");
    assert.equal(file.sha256, createHash("sha256").update(accepted).digest("hex"));

    // Another run cannot read this run's revisions, whatever digest it names.
    assert.deepEqual(await store.listRepairRevisions(project, "run_other"), []);
    await assert.rejects(
      store.readRepairRevisionFile(project, "run_other", revisions[0].acceptedDigest, relative),
      (error) => error.code === "repair_revision_not_found",
    );
    // And a file that is not in the revision is not served out of it.
    await assert.rejects(
      store.readRepairRevisionFile(project, "run_control", revisions[0].acceptedDigest, "deliverables/review/other.md"),
      (error) => error.code === "repair_revision_file_not_found",
    );

    // The digest is re-derived from the text rather than trusted: the whole
    // point of handing this back is that it is the version that passed, so
    // "this is what passed" has to be provable here.
    const snapshotName = (await readdir(path.join(project.metaDir, "repair-revisions")))
      .find((name) => name.startsWith("run_control-"));
    const snapshotPath = path.join(project.metaDir, "repair-revisions", snapshotName);
    const tampered = JSON.parse(await readFile(snapshotPath, "utf8"));
    tampered.files[0].text = "# 被改过的内容\n";
    await writeFile(snapshotPath, JSON.stringify(tampered));
    await assert.rejects(
      store.readRepairRevisionFile(project, "run_control", revisions[0].acceptedDigest, relative),
      (error) => error.code === "repair_revision_digest_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A workspace holding one accepted clinical report and the receipt naming it. */
async function acceptedReportWorkspace(prefix, runId = "run_control") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const project = { rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
  await mkdir(project.metaDir, { recursive: true });
  const relative = "deliverables/review/clinical-evidence-report.md";
  const accepted = "# Accepted review\nThe bytes the local gate accepted.\n";
  await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true });
  await writeFile(path.join(project.workspaceDir, relative), accepted);
  await writeFile(path.join(project.workspaceDir, workspaceLayout.receiptFile), JSON.stringify({
    formatVersion: 1,
    runId,
    bundleVersion: "1.0.0",
    domainVersion: "1.0.0",
    entries: [{
      deliverableId: "review",
      contractKind: "clinical-evidence-report",
      capability: "clinical-evidence-synthesis",
      acceptedAt: "2026-09-16T20:42:53.842Z",
      attempt: 2,
      notices: [],
      files: [{ path: relative, sha256: createHash("sha256").update(accepted).digest("hex"), bytes: Buffer.byteLength(accepted) }],
    }],
  }));
  const lifecycle = (generation = "runtime-generation-1") => ({
    runtimeGeneration: generation,
    controlRunRepairing: async () => true,
    revalidateRuntimeGeneration: async () => generation,
  });
  return { root, project, relative, accepted, lifecycle };
}

test("a second repair round after an authorized revision that did not pass needs no second grant", async () => {
  // v8 ablation, 2026-09-16: round one's grant was consumed, the run edited the
  // report, and its resubmission was refused, so the receipt still named the
  // accepted bytes. Round two refused to preserve a package whose files no
  // longer matched it, and the run ended `specialist_receipt_digest_mismatch`
  // after a single repair, with no files.
  const { root, project, relative, accepted, lifecycle } = await acceptedReportWorkspace("os-repair-round-two-");
  try {
    const run = { id: "run_control", nativeTurn: null };
    const first = await snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-1");
    assert.equal(first.revisionRequired, true);
    assert.equal((await consumeRepairAuthorizationForTest(project, first.authorizations[0], lifecycle())).authorized, true);
    await writeFile(path.join(project.workspaceDir, relative), "# Revised review\nA repair that did not pass.\n");

    const second = await snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-1");
    assert.equal(second.revisionRequired, false, "the revision is already open");
    assert.deepEqual(second.authorizations, []);
    assert.equal(second.snapshotPath, first.snapshotPath);
    const preserved = JSON.parse(await readFile(first.snapshotPath, "utf8"));
    assert.equal(preserved.files[0].text, accepted, "the accepted bytes stay preserved, not overwritten by the revision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files that changed without a consumed grant are still refused before repair", async () => {
  // The control for the case above. Unauthorized edits, and edits made while a
  // grant sat unused, are not a revision.
  const { root, project, relative } = await acceptedReportWorkspace("os-repair-unauthorized-drift-");
  try {
    const run = { id: "run_control", nativeTurn: null };
    await writeFile(path.join(project.workspaceDir, relative), "# Edited with no revision\n");
    await assert.rejects(snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-1"), /accepted receipt drifted before repair/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const minted = await acceptedReportWorkspace("os-repair-unused-grant-drift-");
  try {
    const run = { id: "run_control", nativeTurn: null };
    const first = await snapshotAcceptedPackageForRepairForTest(minted.project, run, "runtime-generation-1");
    assert.equal(first.revisionRequired, true);
    await writeFile(path.join(minted.project.workspaceDir, minted.relative), "# Edited while the grant sat unused\n");
    await assert.rejects(snapshotAcceptedPackageForRepairForTest(minted.project, run, "runtime-generation-1"), /accepted receipt drifted before repair/);
  } finally {
    await rm(minted.root, { recursive: true, force: true });
  }
});

test("a grant that can no longer be consumed is replaced for the next round", async () => {
  const { root, project, lifecycle } = await acceptedReportWorkspace("os-repair-stale-grant-");
  try {
    const run = { id: "run_control", nativeTurn: null };
    const first = await snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-1");
    // The runtime was replaced before the run used it.
    const replaced = await snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-2");
    assert.equal(replaced.revisionRequired, true);
    assert.equal((await consumeRepairAuthorizationForTest(project, first.authorizations[0], lifecycle("runtime-generation-1"))).authorized, false,
      "the replaced runtime's grant is gone");
    // And one left unused past its window.
    const grants = (await readdir(path.join(project.metaDir, "repair-authorizations"))).filter((name) => !name.includes(".claimed."));
    const grantPath = path.join(project.metaDir, "repair-authorizations", grants[0]);
    const grant = JSON.parse(await readFile(grantPath, "utf8"));
    await writeFile(grantPath, JSON.stringify({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const renewed = await snapshotAcceptedPackageForRepairForTest(project, run, "runtime-generation-2");
    assert.equal(renewed.revisionRequired, true);
    assert.equal((await consumeRepairAuthorizationForTest(project, renewed.authorizations[0], lifecycle("runtime-generation-2"))).authorized, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server repair preserves accepted bytes outside the runtime workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-repair-revision-"));
  try {
    const project = {
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const relative = "deliverables/review/clinical-evidence-report.md";
    const accepted = "# Accepted review\nOriginal accepted bytes.\n";
    const unrelatedRelative = "deliverables/brief/brief.md";
    const unrelated = "# Unrelated accepted brief\n";
    await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), accepted);
    await mkdir(path.dirname(path.join(project.workspaceDir, unrelatedRelative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, unrelatedRelative), unrelated);
    const receipt = {
      formatVersion: 1,
      runId: "run_control",
      bundleVersion: "1.0.0",
      domainVersion: "1.0.0",
      entries: [{
        deliverableId: "review",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        acceptedAt: "2026-09-06T00:00:00Z",
        attempt: 1,
        notices: [],
        files: [{ path: relative, sha256: createHash("sha256").update(accepted).digest("hex"), bytes: Buffer.byteLength(accepted) }],
      }, {
        deliverableId: "brief",
        contractKind: "research-brief",
        capability: "research-brief",
        acceptedAt: "2026-09-06T00:00:00Z",
        attempt: 1,
        notices: [],
        files: [{ path: unrelatedRelative, sha256: createHash("sha256").update(unrelated).digest("hex"), bytes: Buffer.byteLength(unrelated) }],
      }],
    };
    await writeFile(path.join(project.workspaceDir, workspaceLayout.receiptFile), JSON.stringify(receipt));

    const result = await snapshotAcceptedPackageForRepairForTest(project, { id: "run_control", nativeTurn: null }, "runtime-generation-1");

    assert.equal(result.revisionRequired, true);
    assert.equal(result.authorizations.length, 1);
    const authorization = result.authorizations[0];
    assert.deepEqual(
      { runId: authorization.runId, deliverableId: authorization.deliverableId },
      { runId: "run_control", deliverableId: "review" },
    );
    assert.match(authorization.acceptedDigest, /^[0-9a-f]{64}$/);
    const lifecycle = {
      runtimeGeneration: "runtime-generation-1",
      controlRunRepairing: async () => true,
      revalidateRuntimeGeneration: async () => "runtime-generation-1",
    };
    assert.equal((await consumeRepairAuthorizationForTest(project, authorization, { ...lifecycle, runtimeGeneration: "replacement-runtime" })).authorized, false,
      "a replacement runtime cannot consume the prior generation's grant");
    assert.equal((await consumeRepairAuthorizationForTest(project, authorization, { ...lifecycle, controlRunRepairing: async () => false })).authorized, false,
      "a canceled or terminal control-plane run invalidates its outstanding grant");
    assert.equal((await consumeRepairAuthorizationForTest(project, authorization, { ...lifecycle, revalidateRuntimeGeneration: async () => "runtime-generation-2" })).authorized, false,
      "a runtime replaced while the consume waits for storage cannot cross the claim linearization point");
    const barrier = path.join(root, "cross-process-consume-barrier");
    await mkdir(barrier, { recursive: true });
    const childScript = `
      import { readdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      const { consumeRepairAuthorizationForTest } = await import(process.env.AGENT_RUNS_MODULE);
      const project = JSON.parse(process.env.PROJECT);
      const input = JSON.parse(process.env.AUTHORIZATION);
      const result = await consumeRepairAuthorizationForTest(project, input, {
        runtimeGeneration: "runtime-generation-1",
        revalidateRuntimeGeneration: async () => "runtime-generation-1",
        controlRunRepairing: async () => {
          await writeFile(path.join(process.env.BARRIER, String(process.pid)), "ready");
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            if ((await readdir(process.env.BARRIER)).length >= 2) return true;
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          throw new Error("consume barrier timeout");
        },
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const runConsumer = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
        env: {
          ...process.env,
          AGENT_RUNS_MODULE: new URL("../src/agentRuns.mjs", import.meta.url).href,
          PROJECT: JSON.stringify(project),
          AUTHORIZATION: JSON.stringify(authorization),
          BARRIER: barrier,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `consumer exited ${code}`)));
    });
    const crossProcess = await Promise.all([runConsumer(), runConsumer()]);
    assert.deepEqual(crossProcess.map((result) => result.authorized).sort(), [false, true],
      "the filesystem claim must allow only one consumer across Node processes");
    assert.equal((await consumeRepairAuthorizationForTest(project, authorization, lifecycle)).authorized, false, "the authorization must be one-time");
    assert.equal((await consumeRepairAuthorizationForTest(project, { ...authorization, acceptedDigest: "f".repeat(64) }, lifecycle)).authorized, false);
    // A later round for the same accepted digest finds the revision open: it
    // mints nothing, and the consumed grant stays consumed.
    const again = await snapshotAcceptedPackageForRepairForTest(project, { id: "run_control", nativeTurn: null }, "runtime-generation-1");
    assert.equal(again.revisionRequired, false);
    assert.deepEqual(again.authorizations, []);
    assert.equal((await consumeRepairAuthorizationForTest(project, authorization, lifecycle)).authorized, false,
      "reissuing the same accepted digest must not reset consumedAt");
    assert.ok(result.snapshotPath.startsWith(project.metaDir + path.sep));
    await writeFile(path.join(project.workspaceDir, relative), "changed workspace bytes");
    const snapshot = JSON.parse(await readFile(result.snapshotPath, "utf8"));
    assert.equal(snapshot.files.find((file) => file.path === relative)?.text, accepted);
    assert.equal(snapshot.acceptedReceipt.entries[0].files[0].sha256, createHash("sha256").update(accepted).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      JSON.stringify({ formatVersion: 1, plan: { revision: 1, items }, degraded: [] }),
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
    await relabelReceipt(project, started.id);
      await store.closeProject(project, "failed");
      return (await store.list(project)).find((item) => item.id === started.id);
    };

    await writeState([{ id: "d1", status: "planned", attempts: 0 }]);
    const abandoned = await finish();
    assert.equal(abandoned?.errorCode, "runtime_deliverable_never_submitted");
    assert.ok(
      noticeTexts(abandoned).some((line) => line.includes("d1") && line.includes("1")),
      `the verdict must name the deliverable and what was written: ${JSON.stringify(abandoned?.qualityNotices)}`,
    );
    // Ungraded is a label on the files, not a reason to hide them.
    //
    // This asserted `artifacts: []` — "ungraded files are still not
    // deliverables" — and that was the whole defect, stated as an invariant. In
    // production 28 of 179 finished runs ended here, at p90 58 minutes, with a
    // complete package on disk and 「暂无交付物。」 on the screen. The verdict is
    // unchanged and still `runtime_deliverable_never_submitted`; what changed is
    // that the run no longer reports having produced nothing when it produced
    // something.
    assert.deepEqual(abandoned?.artifacts, [], "ungraded files are not graded output");
    assert.deepEqual(abandoned?.unverifiedArtifacts, ["deliverables/d1/clinical-evidence-report.md"],
      "but the run must still say what it wrote");
    assert.ok(noticeTexts(abandoned).some((line) => line.includes("未经核验")),
      `the files must be labelled unverified rather than passed off as graded: ${JSON.stringify(abandoned?.qualityNotices)}`);

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
      noticeTexts(graded).some((line) => line.includes("d1") && line.includes("2")),
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
    await relabelReceipt(project, started.id);
    await store.reconcileSession(project, binding.sessionId).catch(() => {});
    const finished = (await store.list(project)).find((item) => item.id === started.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.errorCode, "specialist_receipt_digest_mismatch");
    // Same rule on the container-gone path: refused, and still on disk.
    assert.deepEqual(finished?.artifacts, []);
    assert.deepEqual(finished?.unverifiedArtifacts, ["deliverables/d1/clinical-evidence-report.md"]);
    assert.ok(noticeTexts(finished).some((line) => String(line).includes("未经核验")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with the runtime gone, files moved by an authorized revision end as a revision not accepted, not as tampering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-revision-gone-"));
  try {
    const project = {
      id: "project-1",
      userId: "user-1",
      rootDir: root,
      workspaceDir: path.join(root, "workspace"),
      metaDir: path.join(root, ".openscience"),
    };
    const relative = "deliverables/d1/clinical-evidence-report.md";
    const accepted = "# accepted report\n";
    await mkdir(path.join(project.workspaceDir, "deliverables", "d1"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), accepted, "utf8");
    await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
      formatVersion: 1,
      runId: "run_x",
      bundleVersion: "0.1.0",
      domainVersion: "0.1.0",
      entries: [{
        deliverableId: "d1",
        contractKind: "clinical-evidence-report",
        capability: "clinical-evidence-synthesis",
        files: [{ path: relative, sha256: createHash("sha256").update(accepted).digest("hex"), bytes: Buffer.byteLength(accepted) }],
        acceptedAt: "2026-01-01T00:00:00.000Z",
        attempt: 1,
        notices: [],
      }],
    }, null, 2), "utf8");

    const binding = { sessionId: "ses_revision_gone", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
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
    // Reconciled by hand below, once the revision is in place.
    store.scheduleMonitor = () => {};
    const started = await store.start(project, { sessionId: binding.sessionId });
    await relabelReceipt(project, started.id);
    const lifecycle = { runtimeGeneration: "runtime-generation-1", controlRunRepairing: async () => true, revalidateRuntimeGeneration: async () => "runtime-generation-1" };
    const revision = await snapshotAcceptedPackageForRepairForTest(project, started, "runtime-generation-1");
    assert.equal((await consumeRepairAuthorizationForTest(project, revision.authorizations[0], lifecycle)).authorized, true);
    await writeFile(path.join(project.workspaceDir, relative), "# revised, never accepted\n", "utf8");

    await store.reconcileSession(project, binding.sessionId).catch(() => {});
    const finished = (await store.list(project)).find((item) => item.id === started.id);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.errorCode, "specialist_deliverable_not_accepted");
    assert.deepEqual(finished?.artifacts, []);
    assert.match(String(noticeTexts(finished)[0]), /交付物「d1」按服务端门禁的要求开启了修订/);
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
    await relabelReceipt(project, started.id);

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
    await awaitBackgroundMonitor(restarted.monitors.get(started.id)?.promise);

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
/**
 * Re-label the workspace receipt as `runId`'s own.
 *
 * A receipt is written by the run that owns it and carries that run's id: every
 * control-plane dispatch writes the ledger id into the run index the runtime
 * reads, and the runtime stamps it on the receipt. These fixtures used to write
 * a receipt under a made-up id before the run existed, which only worked while
 * the reader never compared the two — and that is exactly the gap that let one
 * run be credited with another run's accepted package.
 */
async function relabelReceipt(project, runId) {
  const file = path.join(project.workspaceDir, "delivery-receipt.json");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return; // no receipt in this fixture: nothing to relabel
  }
  await writeFile(file, JSON.stringify({ ...receipt, runId }, null, 2), "utf8");
}

async function writeReceiptNaming(workspaceDir, digest, runId = "run_live") {
  await writeFile(path.join(workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1,
    runId,
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
    const dispatched = await dispatch("turn_amend");
    await writeFile(path.join(project.workspaceDir, "note.md"), "# repaired after the verdict\n", "utf8");
    await writeReceiptNaming(project.workspaceDir, "0".repeat(64), dispatched.id);
    appendHistory([{ type: "text", text: "done" }]);

    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "succeeded", noticeTexts(run).join(" | "));
    assert.deepEqual(run.artifacts, ["note.md"], "the bytes the server itself verified are what ships");
    assert.ok(
      noticeTexts(run).some((line) => /回执之后被改动/.test(String(line))),
      "an amended delivery must say so, and name what moved",
    );
  });
});

test("a package edited after its receipt into something that fails is still refused", async () => {
  // The negative control that makes the test above mean anything: amendment is
  // conditional on the current bytes passing. Remove the required output and
  // the same drift must still be refused, with nothing shipped.
  await withSpecialistRun(async ({ project, dispatch, appendHistory, binding, store }) => {
    const dispatched = await dispatch("turn_amend_fail");
    await writeReceiptNaming(project.workspaceDir, "0".repeat(64), dispatched.id);
    appendHistory([{ type: "text", text: "done" }]);

    const run = await store.reconcileSession(project, binding.sessionId);
    assert.equal(run.status, "failed");
    assert.deepEqual(run.artifacts, []);
  });
});


test("a terminal row still fits when the ledger is full of other runs' progress", async () => {
  // Production wedge, reproduced. A project reached 7,800 progress rows across
  // 31 runs and stopped 114 bytes under the cap. Progress kept writing, because
  // that call site dropped its own superseded rows first; `finished` could not,
  // because it did not -- so a run that had completed could never record it and
  // its monitor retried once a minute forever. The rule now lives in the single
  // function every append goes through, so the run that has to end can end.
  const maxBytes = 1024 * 1024;
  const events = [{ event: "started", id: "run_live", at: "2026-09-04T00:00:00.000Z" }];
  const size = () => Buffer.byteLength(`${events.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  // Grown to the cap rather than to a magic count, so the fixture keeps
  // reproducing the wedge when the row shape changes.
  for (let index = 0; size() < maxBytes - 512; index += 1) {
    events.push({
      event: "progress",
      id: `run_other_${index % 30}`,
      at: "2026-09-04T00:00:00.000Z",
      messages: index,
      toolCalls: index,
    });
  }
  const wedged = size();
  assert.ok(
    wedged > maxBytes - 1024 && wedged < maxBytes,
    `the fixture is ${wedged} bytes; it must sit just under the cap to reproduce the wedge`,
  );

  const text = ledgerTextForTest(events, { event: "finished", id: "run_live", status: "succeeded" }, maxBytes);
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.ok(rows.some((row) => row.event === "finished" && row.id === "run_live"), "the terminal row was refused");
  assert.ok(rows.some((row) => row.event === "started" && row.id === "run_live"), "history was dropped with the gauge");
  const progress = rows.filter((row) => row.event === "progress");
  assert.equal(progress.length, 30, "one progress row per run should survive, and only the latest");
  assert.deepEqual(
    progress.map((row) => row.messages),
    events.filter((item) => item.event === "progress").slice(-30).map((item) => item.messages),
    "the surviving progress row must be the newest, not the first",
  );
});

test("a ledger that is genuinely too large is still refused", () => {
  // The cap is not removed, only stopped from being reached by a gauge. A
  // ledger of history alone that exceeds it must still fail loudly.
  const history = [];
  for (let index = 0; index < 40_000; index += 1) {
    history.push({ event: "started", id: `run_${index}`, at: "2026-09-04T00:00:00.000Z" });
  }
  assert.throws(
    () => ledgerTextForTest(history, { event: "finished", id: "run_0", status: "succeeded" }, 1024 * 1024),
    /agent run ledger exceeds its size limit/i,
  );
});


test("an adopted run is marked unchecked and a dispatch may take its session over", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-adopt-"));
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

    const bindings = new Map();
    const store = new AgentRunStore({
      get: async (_project, sessionId) => bindings.get(sessionId) ?? null,
    }, {
      model: "deepseek/deepseek-v4-pro",
      agentRegistry: { list: async () => [] },
    });

    const adopted = await store.adoptRuntimeSession(project, "ses_from_the_browser");
    assert.equal(adopted.mode, "open-domain");
    assert.equal(adopted.effectiveRouteReason, "adopted:runtime-ui");
    assert.equal(adopted.effectiveRuntimeAgent, null);
    // Nothing to grade against, because no question was supplied to route on.
    // The one machine-readable field that separates ungated work from work that
    // passed has to say so.
    assert.equal(adopted.verification, "unchecked");

    // With a question, the same routing a dispatch gets, and then it is graded
    // like any other run rather than labelled ungradable.
    const routed = await store.adoptRuntimeSession(project, "ses_routed", {
      question: "run a meta-analysis of SGLT2 inhibitors",
      effectiveAgentId: "meta-analysis",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-meta-analysis",
      effectiveRouteReason: "matched:meta-analysis",
    });
    assert.equal(routed.effectiveRuntimeAgent, "evimed-meta-analysis");
    assert.equal(routed.effectiveRouteReason, "adopted:runtime-ui:matched:meta-analysis");
    assert.equal(routed.question, "run a meta-analysis of SGLT2 inhibitors");
    assert.equal(routed.verification, null, "a routed adoption has a contract, so it is not unchecked");

    // Adopting twice is the same run: a burst of announcements must not file
    // the same session repeatedly.
    const again = await store.adoptRuntimeSession(project, "ses_from_the_browser");
    assert.equal(again.id, adopted.id);

    // A session the control plane owns is never adopted, however it is announced.
    bindings.set("ses_dispatched", { sessionId: "ses_dispatched", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null });
    assert.equal(await store.adoptRuntimeSession(project, "ses_dispatched"), null);

    // And a dispatch on the adopted session takes it over rather than being
    // refused by the placeholder that only exists because nothing else did.
    bindings.set("ses_from_the_browser", { sessionId: "ses_from_the_browser", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null });
    const claimed = await store.createRun(project, bindings.get("ses_from_the_browser"), { baselineCursor: null });
    assert.notEqual(claimed.id, adopted.id);
    const all = await store.list(project);
    const placeholder = all.find((run) => run.id === adopted.id);
    assert.equal(placeholder.status, "canceled");
    assert.equal(placeholder.errorCode, "superseded_by_dispatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("delegated evidence comes from kernel-owned child histories named by completed tool receipts", async () => {
  const toolMessage = (childSessionId, ok = true) => ({
    info: { id: `m-${childSessionId}`, role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{
      type: "tool",
      tool: "evimed_delegate",
      state: { status: "completed", output: ok
        ? kernelToolText({ ok: true, data: { deliverableId: "d1", childSessionId } })
        : kernelToolText({ ok: false, code: "delegation_failed", issues: [{ code: "delegation_failed", message: "The child did not start." }] }) },
    }],
  });
  const childEvidence = {
    info: { id: "child-evidence", role: "assistant", time: { created: 3, completed: 4 } },
    parts: [{ type: "tool", tool: "mcp__evimed__open_access_full_text", state: { status: "completed", output: "{}" } }],
  };
  const reads = [];
  const { assistants: messages } = await readDelegatedAssistantMessagesForTest(
    {},
    [toolMessage("child-session-1"), toolMessage("failed-child", false), {
      info: { id: "forged", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [{ type: "text", text: "childSessionId: forged-child" }],
    }],
    async (_project, sessionId) => {
      reads.push(sessionId);
      return sessionId === "child-session-1" ? [childEvidence] : [];
    },
  );

  assert.deepEqual(reads, ["child-session-1"]);
  assert.deepEqual(messages, [childEvidence]);
});

test("a delegated child is read under its parent's address, and one that cannot be read is named", async () => {
  // The kernel refuses a subagent session read at its own id. This reader used
  // to ask at the bare id and swallow the refusal, so the delivery gate built
  // its source-provenance map from the root session alone — and refused a
  // clinical-evidence run for "a path no evidence tool reported preserving"
  // about a file its child had preserved. On 2026-09-16 that failed ten of the
  // twelve runs of a paired evaluation, the first of them in a fresh project.
  const delegation = (childSessionId) => ({
    info: { id: `delegate-${childSessionId}`, role: "assistant", time: { created: 1, completed: 2 } },
    parts: [{
      type: "tool", tool: "evimed_delegate",
      state: { status: "completed", output: kernelToolText({ ok: true, data: { childSessionId } }) },
    }],
  });
  const fetched = {
    info: { id: "child-fetch", role: "assistant", time: { created: 3, completed: 4 } },
    parts: [delegation("grandchild-1").parts[0], { type: "tool", tool: "mcp__evimed__open_access_full_text", state: { status: "completed", output: "{}" } }],
  };
  const reads = [];
  const { assistants, unreadable } = await readDelegatedAssistantMessagesForTest(
    {},
    [delegation("child-1"), delegation("child-gone")],
    async (_project, sessionId, options) => {
      reads.push({ sessionId, parentSessionId: options.parentSessionId });
      if (!options.parentSessionId) throw Object.assign(new Error("subagent Sessions require their durable parent address"), { code: "runtime_session_error" });
      if (sessionId === "child-gone") throw Object.assign(new Error("session is gone"), { code: "runtime_session_not_found" });
      return sessionId === "child-1" ? [fetched] : [];
    },
    "root-session",
  );

  assert.deepEqual(reads, [
    { sessionId: "child-1", parentSessionId: "root-session" },
    { sessionId: "child-gone", parentSessionId: "root-session" },
    { sessionId: "grandchild-1", parentSessionId: "child-1" },
  ], "a nested child is addressed under the child that delegated it, not under the root");
  assert.ok(assistants.includes(fetched), "the child's own preserving tool call reaches the gate");
  assert.deepEqual(unreadable, ["child-gone"], "a child that cannot be read is named, not skipped in silence");
});

test("a finished conversation-window task counts what its children got accepted, on the receipt's evidence", () => {
  // 2026-09-19 live walk: both deliverables of an aspirin task asked in the
  // conversation window were accepted at their first submission, and the task
  // still read 「已交付，但有核验没有通过」 with nothing to show — the children
  // submitted, and a child's submission never reaches the parent's transcript.
  const clinical = { id: "review", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  const safety = { id: "safety", contractKind: "drug-safety-report", capability: "adr-analysis" };
  const run = {
    sessionId: "root",
    status: "succeeded",
    nativeWorkflow: {
      kernelRunId: "native_1",
      plan: { revision: 1, written: true, items: [clinical, safety], start: 1_000, end: 1_100 },
      submissions: [],
      delegates: ["review", "safety"],
      endTime: 9_000,
    },
  };
  const entry = (item, acceptedAt) => ({ deliverableId: item.id, contractKind: item.contractKind, capability: item.capability, acceptedAt: new Date(acceptedAt).toISOString() });
  const receipt = { runId: "native_1", entries: [entry(clinical, 5_000), entry(safety, 6_000)] };
  assert.deepEqual(scopeNativeReceiptForTest(receipt, run)?.entries.map((item) => item.deliverableId), ["review", "safety"]);

  // Not another run's receipt, not an item this turn did not delegate, not an
  // acceptance after the turn ended.
  assert.equal(scopeNativeReceiptForTest({ ...receipt, runId: "native_0" }, run), null);
  assert.equal(scopeNativeReceiptForTest(receipt, { ...run, nativeWorkflow: { ...run.nativeWorkflow, delegates: [] } }), null);
  assert.deepEqual(scopeNativeReceiptForTest({ runId: "native_1", entries: [entry(clinical, 10_000)] }, run), null);

  // The finished projection reads those items as accepted only on the
  // receipt's word; without it they stay delegated.
  const projection = { sessionId: "root", runId: "native_1", plan: { revision: 1, items: [{ ...clinical, status: "accepted", attempts: 1 }, { ...safety, status: "accepted", attempts: 1 }] } };
  const received = scopeNativeProjectionForTest(projection, run, { receiptAccepted: new Set(["review", "safety"]) });
  assert.deepEqual(received?.plan.items.map((item) => `${item.id}:${item.status}:${item.attempts}`), ["review:accepted:1", "safety:accepted:1"]);
  const unproven = scopeNativeProjectionForTest(projection, run, { receiptAccepted: new Set() });
  assert.deepEqual(unproven?.plan.items.map((item) => item.status), ["delegated", "delegated"]);
});

test("a prior run projection in the same session cannot prove current-run sources", () => {
  const item = { id: "review", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  const run = {
    sessionId: "same-session",
    nativeWorkflow: {
      kernelRunId: "current-run",
      plan: { revision: 1, written: true, items: [item] },
      submissions: [],
      delegates: ["review"],
    },
  };
  const projection = {
    sessionId: "same-session",
    runId: "prior-run",
    plan: { revision: 1, items: [{ ...item, status: "accepted" }] },
    evidence: { preservedSources: [{ artifactPath: ".evimed-sources/old/fulltext.md", digest: "a".repeat(64) }] },
  };

  assert.equal(scopeNativeProjectionForTest(projection, run), null);
  assert.equal(scopeNativeProjectionForTest({ ...projection, runId: "current-run" }, run)?.runId, "current-run");
});

/* ------------------------------------------------ a correction to a run already going */

// The design question this settles: a researcher who realises part-way through
// that the question was wrong. The obvious move is to let a second dispatch
// through on a session that already has a running run, and it is the wrong one
// — a dispatch creates a run, a run binds a deliverable contract, and one
// session with two runs is one conversation with two verdicts. Every published
// implementation of mid-run steering reaches the same conclusion from the other
// side: a steered message belongs to the response it steers, not to a turn of
// its own, because splitting it off is what lets a later compaction summarise
// away one half of a modified instruction.
//
// So `agent_run_active` stays exactly as it is — the test above at
// "a session may hold one active run" still holds it — and a correction is a
// different operation on the run that is already going.
/** A throwaway project directory, in the shape the run store expects. */
async function withProject(body) {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-correct-"));
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
    await body(project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a correction belongs to the run it corrects, and is counted on it", async () => {
  await withProject(async (project) => {
    const binding = { sessionId: "ses_correct", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    const run = await store.start(project, { sessionId: binding.sessionId });
    assert.equal(run.status, "running");
    assert.equal(run.corrections ?? 0, 0);

    const first = await store.recordCorrection(project, run.id, "req_correction_1");
    assert.equal(first.corrections, 1);
    assert.ok(first.kernelRequestIds.includes("req_correction_1"),
      "the request id is on the run before the kernel is told, or nothing can match the reply to it");
    assert.equal((await store.list(project)).length, 1, "a correction must not create a run");

    // A repair's request is recorded through the same event and is not a
    // correction: the gate asking for a fix and a researcher changing their
    // mind are different facts about a run.
    const repaired = await store.recordKernelRequest(project, run.id, "req_repair_1");
    assert.equal(repaired.corrections, 1);
    assert.ok(repaired.kernelRequestIds.includes("req_repair_1"));
  });
});

test("corrections are bounded, and a run that is not running takes none", async () => {
  await withProject(async (project) => {
    const binding = { sessionId: "ses_correct_cap", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 1000,
      monitorMaxPolls: 100,
      readSessionHistory: async () => [],
    });
    const run = await store.start(project, { sessionId: binding.sessionId });

    for (let index = 1; index <= MAX_RUN_CORRECTIONS; index += 1) {
      assert.equal((await store.recordCorrection(project, run.id, `req_c_${index}`)).corrections, index);
    }
    // An unbounded stream of corrections keeps a run alive for as long as
    // somebody keeps typing, which is a budget the dispatch-time limits cannot
    // see.
    await assert.rejects(
      () => store.recordCorrection(project, run.id, "req_c_over"),
      (error) => error?.code === "agent_run_correction_limit",
    );
    await assert.rejects(
      () => store.recordCorrection(project, "run_missing", "req_c_x"),
      (error) => error?.code === "agent_run_not_running",
    );

    // Once the run is over there is nothing left to correct, and saying so by
    // name is what stops a late correction from looking like it landed.
    await store.finishInternal(project, run.id, { status: "succeeded", artifacts: [] });
    await assert.rejects(
      () => store.recordCorrection(project, run.id, "req_c_late"),
      (error) => error?.code === "agent_run_not_running",
    );
  });
});

test("the correction route takes a text and nothing else, and names what it cannot find", async () => {
  await withApp(async ({ base }) => {
    const missing = await fetch(`${base}/api/agent-runs/run_does_not_exist/steer`, {
      method: "POST", headers: projectHeaders("default", true), body: JSON.stringify({ text: "只看随机对照试验" }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "agent_run_not_found");

    for (const [label, body] of [
      ["empty text", { text: "   " }],
      // The delivery mode is the control plane's decision, not the client's: a
      // caller that could choose `queue` here would be dispatching a second
      // turn through a route that promises not to.
      ["a chosen mode", { text: "x", mode: "queue" }],
      ["no text at all", {}],
    ]) {
      const response = await fetch(`${base}/api/agent-runs/run_x/steer`, {
        method: "POST", headers: projectHeaders("default", true), body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, label);
    }
  });
});

// The answer line's `skillsLoaded` check had no route to being true. It does
// not delegate, so `injectedSkills` — which reads `projection.subagents` —
// found nothing on every run, and the only remaining evidence was a `skill`
// tool call the brief asked for and the model made 6 times in 17. The control
// plane now mounts the body itself and records that it did; these assert the
// gate reads that record, and that the record cannot be faked from the run side.
test("a control-plane mounted persona satisfies skillsLoaded with no skill tool call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-mounted-skill-"));
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
    const binding = { sessionId: "ses_mounted", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
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
          completionChecks: ["skillsLoaded"],
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

    // Baseline: the shape production was in. No mount, no tool call, and the
    // reply is delivered unverified for a process gap the reader cannot see.
    const first = await dispatch("turn_unmounted");
    history = [{
      info: { id: "msg_unmounted", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [{ type: "text", text: "二甲双胍主要通过抑制肝糖异生发挥作用。" }],
    }];
    const unmounted = await store.reconcileSession(project, binding.sessionId);
    // Delivered, but stamped: a missing persona is a process gap the reader
    // cannot see, so the answer ships and the run says it was not verified.
    // This is the notice that fired on 11 of 17 production answer-line runs.
    assert.equal(unmounted.status, "succeeded");
    assert.equal(unmounted.verification, "unverified");
    assert.match(noticeTexts(unmounted).join("\n"), /没有加载「open-domain-answer」方法/);
    assert.equal(first.id, unmounted.id);

    // The same turn, with the control plane having mounted the body.
    const second = await dispatch("turn_mounted");
    await store.recordLearning(project, second.id, { mountedSkills: ["open-domain-answer"] });
    history = [...history, {
      info: { id: "msg_mounted", role: "assistant", time: { completed: Date.now() + 20 } },
      parts: [{ type: "text", text: "二甲双胍主要通过抑制肝糖异生发挥作用。" }],
    }];
    const mounted = await store.reconcileSession(project, binding.sessionId);
    assert.equal(mounted.status, "succeeded");
    assert.equal(mounted.errorCode, null);
    // The difference the mount makes, and the whole point of it: same reply,
    // same absence of a `skill` tool call, no notice and nothing unverified.
    assert.equal(mounted.verification, null);
    assert.deepEqual(noticeTexts(mounted), []);
    assert.deepEqual(mounted.mountedSkills, ["open-domain-answer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mounted name the control plane never recorded does not pass the check", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-mounted-other-"));
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
    const binding = { sessionId: "ses_mounted_other", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
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
          completionChecks: ["skillsLoaded"],
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
      dispatchId: "turn_wrong_mount",
      effectiveAgentId: "open-domain-answer",
      effectiveAgentVersion: "1.0.0",
      effectiveRuntimeAgent: "evimed-open-domain-answer",
    }, async () => ({ accepted: true }));
    // Some other skill was mounted. The required one still was not, so the
    // record must not be read as "a skill was mounted, therefore fine".
    await store.recordLearning(project, run.id, { mountedSkills: ["citation-integrity"] });
    history = [{
      info: { id: "msg_wrong_mount", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [{ type: "text", text: "答案。" }],
    }];
    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.verification, "unverified");
    assert.match(noticeTexts(finished).join("\n"), /没有加载「open-domain-answer」方法/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run superseded days later records how long it ran, not how long the record sat", async () => {
  // `durationMs` was `now - startedAt` at the moment of supersession. A run the
  // control plane lost track of — restarted, abandoned, left from an earlier
  // day — is superseded by the next dispatch into that session, and the
  // difference to now describes the ledger rather than the work. It feeds the
  // run list and every duration statistic read off it, where a three-day run is
  // not an outlier to explain, it is a wrong number.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-superseded-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_stale", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let clock = Date.parse("2026-09-01T00:00:00.000Z");
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      now: () => new Date(clock),
      // Four hours, the production shape: 500ms polls to a 28,800-poll ceiling.
      monitorIntervalMs: 500,
      monitorMaxPolls: 28_800,
      readSessionHistory: async () => [],
      readSessionStatus: async () => "running",
    });
    store.scheduleMonitor = () => {};

    // The superseded path is for an adopted placeholder — the run the control
    // plane creates when the browser application opens a session nobody has
    // claimed. That is exactly the run most likely to be left behind, which is
    // why its duration is the one that goes wrong.
    const first = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_one",
      effectiveRouteReason: "adopted:runtime-ui",
    }, async () => ({ accepted: true }));

    // Five days pass with the control plane none the wiser, then someone asks
    // the same session something else.
    clock += 5 * 24 * 60 * 60 * 1000;
    await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_two" },
      async () => ({ accepted: true }));

    const superseded = (await store.list(project)).find((run) => run.id === first.id);
    assert.equal(superseded?.errorCode, "superseded_by_dispatch");
    // Capped at the monitor's own ceiling: past four hours this run would have
    // been ended, so it cannot have been working longer than that.
    assert.ok(superseded.durationMs <= 500 * 28_800,
      `recorded ${superseded.durationMs}ms, which is longer than the platform would ever let a run go`);
    assert.ok(superseded.durationMs < 24 * 60 * 60 * 1000, "five days of wall clock reached the ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale root file does not shadow the package this run wrote into deliverables/", async () => {
  // Reproduces the 2026-09-08 clinical acceptance failure exactly.
  //
  // A 70-minute run produced a complete synthesis at
  // `deliverables/<id>/clinical-evidence-report.md`. A file of the same name,
  // left at the workspace root by a run in July, was found first — because
  // `readRequiredFile` returns the root hit before it looks anywhere else — and
  // the run was failed `specialist_required_output_stale` for a file it had not
  // written, while its own package sat one directory away untouched.
  //
  // The native-turn path already iterated candidates and took the fresh one,
  // with a comment saying "a root file from yesterday must not hide today's
  // nested deliverable". The rule existed; only one of the two paths had it.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-stale-root-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace"),
    };
    await mkdir(path.join(project.workspaceDir, "deliverables", "empa-kidney"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });

    // July's leftover, at the root.
    const stale = path.join(project.workspaceDir, "clinical-evidence-report.md");
    await writeFile(stale, "# an old report from a previous run\n", "utf8");
    const july = Date.parse("2026-07-23T16:02:37.000Z");
    await utimes(stale, july / 1000, july / 1000);

    const binding = { sessionId: "ses_stale_root", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis",
          version: "2.11.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          skill: "clinical-evidence-synthesis",
          companionSkills: [],
          outputs: [{ path: "clinical-evidence-report.md", required: true }],
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
    const run = await store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_stale_root",
      effectiveAgentId: "clinical-evidence-synthesis",
      effectiveAgentVersion: "2.11.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));

    // Today's real package, written after the run started.
    const fresh = path.join(project.workspaceDir, "deliverables", "empa-kidney", "clinical-evidence-report.md");
    await writeFile(fresh, "# 恩格列净对成人慢性肾脏病的证据综合\n", "utf8");
    history = [{
      info: { id: "msg_done", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [{ type: "text", text: "报告已写入。" }],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.id, run.id);
    assert.notEqual(finished.errorCode, "specialist_required_output_stale",
      "a July file at the root failed a run whose own package was written today");
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.artifacts, ["deliverables/empa-kidney/clinical-evidence-report.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with nothing fresh anywhere, a stale package is still reported stale", async () => {
  // Freshness picks which candidate, never whether one exists. A run that
  // really did write nothing must still get the staleness verdict, or this
  // becomes a way to pass by leaving an old file lying around.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-stale-only-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace"),
    };
    await mkdir(path.join(project.workspaceDir, "deliverables", "old"), { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const july = Date.parse("2026-07-23T16:02:37.000Z") / 1000;
    for (const file of [
      path.join(project.workspaceDir, "clinical-evidence-report.md"),
      path.join(project.workspaceDir, "deliverables", "old", "clinical-evidence-report.md"),
    ]) {
      await writeFile(file, "# old\n", "utf8");
      await utimes(file, july, july);
    }

    const binding = { sessionId: "ses_stale_only", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    const store = new AgentRunStore({ get: async () => binding }, {
      agentRegistry: {
        get: () => ({
          id: "clinical-evidence-synthesis", version: "2.11.0",
          runtimeAgent: "evimed-clinical-evidence-synthesis",
          skill: "clinical-evidence-synthesis", companionSkills: [],
          outputs: [{ path: "clinical-evidence-report.md", required: true }],
          completionChecks: ["requiredOutputsExist"],
        }),
      },
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000, monitorMaxPolls: 20,
      readSessionHistory: async () => history,
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    await store.dispatch(project, {
      sessionId: binding.sessionId, dispatchId: "turn_stale_only",
      effectiveAgentId: "clinical-evidence-synthesis", effectiveAgentVersion: "2.11.0",
      effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    }, async () => ({ accepted: true }));
    history = [{
      info: { id: "msg_done", role: "assistant", time: { completed: Date.now() + 10 } },
      parts: [{ type: "text", text: "done" }],
    }];

    const finished = await store.reconcileSession(project, binding.sessionId);
    assert.equal(finished.errorCode, "specialist_required_output_stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dispatch's recalled memories are on the run, as ids and kinds and never as values", async () => {
  // The recall existed only as `memory.md` inside the run's container: a
  // researcher reading an answer could not see what the platform had used about
  // them, and "why did it assume that?" was answerable only by reading a
  // filesystem (2026-09-16 review, M4③).
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-recall-"));
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
    const binding = { sessionId: "ses_recall", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async () => [],
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_recall" },
      async () => ({ accepted: true }));

    await store.recordLearning(project, run.id, {
      recalledMemories: [
        { id: "mem_a", kind: "preference", scope: "user", value: "PRIVATE VALUE" },
        { id: "mem_b", kind: "behavior", scope: "user" },
        { id: "", kind: "preference", scope: "user" },
      ],
    });
    const [stored] = await store.list(project);
    assert.deepEqual(stored.recalledMemories, [
      { id: "mem_a", kind: "preference", scope: "user" },
      { id: "mem_b", kind: "behavior", scope: "user" },
    ], "an id-less row is dropped, and no value is carried");

    // The ledger is a file in the project workspace; a memory's content belongs
    // in the memory store, where deleting it deletes it.
    const text = await readFile(path.join(project.metaDir, "runs.jsonl"), "utf8");
    assert.ok(!text.includes("PRIVATE VALUE"), "a memory's value reached the run ledger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial transcript says which session is missing and why, on the run itself", async () => {
  // `persistRunTranscript` always returned the gaps; the ledger's receipt
  // normalizer dropped them, so a run said `partial` and nothing else. The
  // reason lived only in a header line inside the project's data volume —
  // diagnosing the kernel refusing a subagent addressed at its own id needed an
  // ssh session, and a paired evaluation excluding a cell as
  // `transcript_partial` could not say which child or why.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-gaps-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_gaps", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000, monitorMaxPolls: 20,
      readSessionHistory: async () => [], readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_gaps" }, async () => ({ accepted: true }));

    const refusal = "runtime_session_error: subagent Sessions require their durable parent address";
    await store.recordLearning(project, run.id, {
      transcript: {
        path: ".openscience/transcripts/run.jsonl", completeness: "partial", bytes: 10,
        sha256: "a".repeat(64), messages: 27,
        missing: [
          { sessionId: "4c80d30a-cc9f-4c69-8fce-ea8239180993", fromSeq: 0, reason: "child_unreadable", detail: refusal },
          { sessionId: "", fromSeq: 0, reason: "child_unreadable" },
          { sessionId: "x", reason: "" },
        ],
      },
    });
    const [stored] = await store.list(project);
    assert.equal(stored.transcript.completeness, "partial");
    assert.deepEqual(stored.transcript.missing, [
      { sessionId: "4c80d30a-cc9f-4c69-8fce-ea8239180993", fromSeq: 0, reason: "child_unreadable", detail: refusal },
    ], "a gap without a session or a reason is dropped; the kernel's own sentence survives");

    // Bounded: the ledger is a file, and a run with a hundred unreadable
    // children must not write a hundred gap rows into it.
    const many = Array.from({ length: 40 }, (_, index) => ({ sessionId: `child-${index}`, fromSeq: 0, reason: "child_unreadable", detail: "x".repeat(900) }));
    await store.recordLearning(project, run.id, {
      transcript: { path: ".openscience/transcripts/run.jsonl", completeness: "partial", bytes: 10, sha256: "b".repeat(64), messages: 1, missing: many },
    });
    const [bounded] = await store.list(project);
    assert.equal(bounded.transcript.missing.length, 16);
    assert.equal(bounded.transcript.missing[0].detail.length, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a running run carries the deliverables it is working through, and a finished one does not", async () => {
  // 2026-09-16 review, P2 #14: the runs page's step list reads these.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-plan-progress-"));
  try {
    const project = {
      id: "project-1", userId: "user-1", rootDir: root,
      workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience"),
    };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = { sessionId: "ses_plan_progress", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, { model: "deepseek/deepseek-v4-pro", monitorIntervalMs: 60_000, monitorMaxPolls: 1 });
    store.scheduleMonitor = () => {};
    const run = await store.dispatch(project, { sessionId: binding.sessionId, dispatchId: "turn_plan_progress" }, async () => ({ accepted: true }));

    const stateDir = path.join(project.workspaceDir, ".evimed-run", "runs", run.id);
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "state.json"), JSON.stringify({
      formatVersion: 1, runId: run.id,
      plan: { revision: 1, items: [
        { id: "d1", title: "证据综述", status: "accepted", attempts: 1 },
        { id: "d2", title: "x".repeat(400), status: "delegated", attempts: 0 },
        { id: "d3", status: "not-a-state" },
      ] },
    }));

    const [withPlan] = await store.withPlanProgress(project, await store.list(project));
    assert.deepEqual(withPlan.planItems.map((item) => [item.id, item.status, item.attempts]), [["d1", "accepted", 1], ["d2", "delegated", 0], ["d3", "planned", 0]]);
    assert.equal(withPlan.planItems[1].title.length, 160, "a title is bounded");
    assert.equal(withPlan.planItems[2].title, "d3", "an untitled deliverable is named by its id");

    await store.finishInternal(project, run.id, { status: "failed", errorCode: "runtime_canceled", artifacts: [] });
    const [finished] = await store.withPlanProgress(project, await store.list(project));
    assert.equal(finished.planItems, undefined, "a finished run's outcome is its artifacts, not a step list");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a harness's dispatch is recorded as automated, and nothing but a boolean says so", async (t) => {
  // The inbox records an automated run's completion without notifying anyone
  // (C1); the ledger is where it learns which runs those are.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-automated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: root, metaDir: path.join(root, ".openscience") };
  await mkdir(project.metaDir, { recursive: true });
  const binding = { sessionId: "ses_auto", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
  const store = new AgentRunStore({ get: async () => binding }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: async () => [], readSessionStatus: async () => "idle",
  });
  store.scheduleMonitor = () => {};
  const run = await store.dispatch(project, { sessionId: "ses_auto", dispatchId: "eval_cell_1", automated: true }, async () => ({ accepted: true }));
  assert.equal(run.automated, true);
  assert.equal((await store.list(project)).find((item) => item.id === run.id).automated, true, "the flag survives a fold of the ledger");
  await assert.rejects(store.dispatch(project, { sessionId: "ses_auto", dispatchId: "eval_cell_2", automated: "yes" }, async () => ({ accepted: true })),
    { code: "invalid_agent_run" });
  await store.closeAll();
  const person = new AgentRunStore({ get: async () => ({ ...binding, sessionId: "ses_person" }) }, {
    model: "deepseek/deepseek-flash", monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: async () => [], readSessionStatus: async () => "idle",
  });
  person.scheduleMonitor = () => {};
  const typed = await person.dispatch(project, { sessionId: "ses_person", dispatchId: "typed_1" }, async () => ({ accepted: true }));
  assert.equal(Object.hasOwn(typed, "automated"), false, "a person's run carries no flag at all");
  await person.closeAll();
});

test("a run that ends without a verdict recovers only the files it wrote, not an earlier run's", async () => {
  // Cancelled on 2026-09-19 two minutes in, a metformin run listed 34 files an
  // aspirin run had written two days before in the same workspace as its own
  // 「未核验」 delivery, and counted their 284 claims as its claim summary.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-recovered-"));
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
    const earlier = path.join(project.workspaceDir, workspaceLayout.deliverablesDir, "adr-analysis");
    await mkdir(earlier, { recursive: true });
    await writeFile(path.join(earlier, "safety-report.md"), "# an earlier run's report\n", "utf8");
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await utimes(path.join(earlier, "safety-report.md"), twoDaysAgo, twoDaysAgo);
    await writeFile(
      path.join(project.workspaceDir, workspaceLayout.runStateFile),
      JSON.stringify({ formatVersion: 1, plan: { revision: 1, items: [{ id: "d1", status: "planned", attempts: 0 }] }, degraded: [] }),
      "utf8",
    );
    const binding = { sessionId: "ses_r", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    const store = new AgentRunStore({ get: async () => binding }, {
      model: "deepseek/deepseek-flash",
      readSessionHistory: async () => [],
      monitorIntervalMs: 60_000,
    });
    const started = await store.start(project, { sessionId: binding.sessionId });
    await relabelReceipt(project, started.id);
    const mine = path.join(project.workspaceDir, workspaceLayout.deliverablesDir, "d1");
    await mkdir(mine, { recursive: true });
    await writeFile(path.join(mine, "clinical-evidence-report.md"), "# this run's report\n", "utf8");
    await store.closeProject(project, "failed");
    const finished = (await store.list(project)).find((item) => item.id === started.id);
    assert.deepEqual(finished?.unverifiedArtifacts, ["deliverables/d1/clinical-evidence-report.md"],
      "what this run wrote is said; what an earlier run wrote is not claimed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plain answer typed into the kernel's page counts the persona its session was given", async () => {
  // No plan, so nothing for the native-projection scope to admit; the answer
  // persona was still injected into the session and the run's index says so.
  // Every such answer was delivered 未核验 until 2026-09-19.
  const root = await mkdtemp(path.join(tmpdir(), "os-agent-run-persona-"));
  try {
    const project = { id: "project-1", userId: "user-1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(path.join(project.workspaceDir, workspaceLayout.runStateDir), { recursive: true });
    const writeIndex = (sessionId) => writeFile(
      path.join(project.workspaceDir, workspaceLayout.runStateFile),
      JSON.stringify({ formatVersion: 1, runId: "native_1", sessionId, injectedSkills: ["open-domain-answer"], plan: { revision: 0, items: [] }, degraded: [] }),
      "utf8",
    );
    const run = { id: "run_plain", sessionId: "ses_plain", status: "succeeded", nativeTurn: { startSeq: 1, userSeq: 2 } };
    await writeIndex("ses_plain");
    assert.ok((await loadedOrInjectedSkillsForTest(project, [], run)).has("open-domain-answer"), "the session's own persona counts");
    await writeIndex("ses_other");
    assert.equal((await loadedOrInjectedSkillsForTest(project, [], run)).has("open-domain-answer"), false, "another session's record does not");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
