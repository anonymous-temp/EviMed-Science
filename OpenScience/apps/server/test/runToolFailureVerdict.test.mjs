// A tool failure the run got past is a notice, not the run's verdict
// (2026-10-04).
//
// Capability `adr-analysis`, brief `adr-001-osimertinib-cardiac`: the run worked
// for eleven minutes, wrote its files, `evimed_submit_deliverable` accepted the
// deliverable, the model gave its final answer — and the ledger recorded
// `failed / runtime_tool_error`, with the two files attached and no word of why.
// The transcript held one call to a tool the session does not mount, two editor
// failures the model re-read and retried, and an advisory review that said it
// could not be had. The verdict was a list of exceptions that had been widened
// twice before; these tests hold the rule that replaces it: a turn that ended on
// its own is decided by what it produced, and what its tools could not give it
// is said.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentRunStore } from "../src/agentRuns.mjs";
import { normalizeTranscript, transcriptToLedgerMessages } from "../src/dshRuntimeAdapter.mjs";
import { runFinishedNotice } from "../src/notificationService.mjs";
import { kernelToolText } from "./helpers/kernelToolText.mjs";
import { noticeTexts } from "./helpers/noticeTexts.mjs";

/** The adverse-event capability the live run was bound to, reduced to what the ledger reads. */
const ADR = {
  id: "adr-analysis",
  version: "1.3.1",
  runtimeAgent: "evimed-adr-analysis",
  outputs: [{ path: "safety-report.md", required: true }],
  completionChecks: ["requiredOutputsExist"],
};

/** The answer line: no files owed, the persona's method in front of the model. */
const ANSWER = {
  id: "open-domain-answer",
  version: "1.0.0",
  runtimeAgent: "evimed-open-domain-answer",
  skill: "open-domain-answer",
  companionSkills: [],
  outputs: [],
  completionChecks: ["skillsLoaded", "citationsResolvable"],
};

const DELIVERABLE = "osimertinib-cardiac-adr";
const DELIVERABLE_DIR = `deliverables/${DELIVERABLE}`;

/** A tool call as the ledger's messages carry one, one call to a message like the kernel's own history. */
function call(tool, input, state = {}) {
  return { type: "tool", tool, state: { status: "completed", input, ...state } };
}

const failedCall = (tool, input, error, output = "") => call(tool, input, { status: "error", error, output });

/** An MCP tool's own failure: bare JSON with the code inside. */
const mcpFailure = (tool, code) => call(tool, {}, { status: "error", error: JSON.stringify({ status: "error", error: { code } }) });

const skillLoaded = () => call("skill", { name: ANSWER.skill }, {
  output: `<skill_content name="${ANSWER.skill}">\n<skill_instructions>\n# ${ANSWER.skill}\n</skill_instructions>\n</skill_content>`,
});

/**
 * One run on a fresh project. `agent` is the capability the session is bound to,
 * or null for an unrouted turn. `turn` appends one finished turn the way the
 * kernel's history reaches the ledger — one part to a message, the turn's end on
 * the last — and `reconcile` reads it.
 */
async function withRun(agent, body, { children = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "os-run-verdict-"));
  try {
    const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir: path.join(root, "workspace"), metaDir: path.join(root, ".openscience") };
    await mkdir(project.workspaceDir, { recursive: true });
    await mkdir(project.metaDir, { recursive: true });
    const binding = agent
      ? { sessionId: "ses_verdict", mode: "specialist", agentId: agent.id, agentVersion: agent.version, runtimeAgent: agent.runtimeAgent }
      : { sessionId: "ses_verdict", mode: "open-domain", agentId: null, agentVersion: null, runtimeAgent: null };
    let history = [];
    let gone = false;
    let seq = 0;
    const store = new AgentRunStore({ get: async () => binding }, {
      ...(agent ? { agentRegistry: { get: () => agent } } : {}),
      model: "deepseek/deepseek-flash",
      monitorIntervalMs: 60_000,
      monitorMaxPolls: 20,
      readSessionHistory: async (_project, sessionId) => {
        if (gone) throw Object.assign(new Error("the runtime is gone"), { code: "runtime_not_running" });
        return sessionId === binding.sessionId ? history : (children[sessionId] ?? []);
      },
      readSessionStatus: async () => "idle",
    });
    store.scheduleMonitor = () => {};
    const dispatch = () => store.dispatch(project, {
      sessionId: binding.sessionId,
      dispatchId: "turn_verdict",
      ...(agent ? { effectiveAgentId: agent.id, effectiveAgentVersion: agent.version, effectiveRuntimeAgent: agent.runtimeAgent } : {}),
    }, async () => ({ accepted: true }));
    const turn = (parts, end = { kind: "completed" }) => {
      history = [...history, ...parts.map((part, index) => {
        seq += 1;
        const last = index === parts.length - 1;
        return {
          info: {
            id: `seq_${seq}`,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            ...(last ? { turnEnd: { ...end, seq, time: Date.now() }, ...(end.code ? { error: { name: end.kind, code: end.code } } : {}) } : {}),
          },
          parts: [part],
        };
      })];
    };
    const reconcile = () => store.reconcileSession(project, binding.sessionId);
    try {
      await body({ project, store, dispatch, turn, reconcile, runtimeGone: () => { gone = true; }, setHistory: (messages) => { history = messages; } });
    } finally {
      await store.closeAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Files into the workspace, and a receipt naming the first as accepted, under the run's own id. */
async function writeDelivery(project, runId, files, { receipt = true } = {}) {
  for (const [relative, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project.workspaceDir, relative)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, relative), body, "utf8");
  }
  if (!receipt) return;
  const [[named, text]] = Object.entries(files);
  await writeFile(path.join(project.workspaceDir, "delivery-receipt.json"), JSON.stringify({
    formatVersion: 1,
    runId,
    bundleVersion: "0.1.0",
    domainVersion: "0.1.0",
    entries: [{
      deliverableId: DELIVERABLE,
      contractKind: "adr-analysis-report",
      capability: "adr-analysis",
      files: [{ path: named, sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) }],
      acceptedAt: "2026-10-04T07:08:00.000Z",
      attempt: 1,
      notices: [],
    }],
  }, null, 2), "utf8");
}

const toolNotices = (run) => (run.qualityNotices ?? []).filter((notice) => ["run_tool_failed", "run_tool_unavailable", "review_unavailable", "capsule_unavailable"].includes(notice.code));

test("the live shape: an unmounted tool, two corrected edits, an accepted deliverable and an unavailable review are a delivered run with notices", async () => {
  await withRun(ADR, async ({ project, store, dispatch, turn, reconcile }) => {
    const run = await dispatch();
    const report = "# 奥希替尼心脏不良反应信号分析\n\n不成比例分析提示信号，但信号不等于因果。\n";
    await writeDelivery(project, run.id, {
      [`${DELIVERABLE_DIR}/safety-report.md`]: report,
      [`${DELIVERABLE_DIR}/revision-notes.md`]: "# 修订说明\n",
    });
    const stale = "file changed since it was read — re-read the file, then retry";
    turn([
      // The model called a tool this session does not mount, and moved on.
      failedCall("web_read", { url: "https://example.org/label" }, "UNKNOWN_TOOL", 'Error: unknown tool "web_read"'),
      call("write", { file_path: `${DELIVERABLE_DIR}/safety-report.md`, content: report }),
      call("write", { file_path: `${DELIVERABLE_DIR}/revision-notes.md`, content: "# 修订说明\n" }),
      // Two editor failures it re-read and retried.
      failedCall("edit", { file_path: `${DELIVERABLE_DIR}/safety-report.md` }, "FILE_CHANGED", `Error: ${stale}`),
      call("read", { file_path: `${DELIVERABLE_DIR}/safety-report.md` }, { output: report }),
      call("edit", { file_path: `${DELIVERABLE_DIR}/safety-report.md` }, { output: "edited" }),
      failedCall("edit", { file_path: `${DELIVERABLE_DIR}/revision-notes.md` }, "FILE_CHANGED", `Error: ${stale}`),
      call("read", { file_path: `${DELIVERABLE_DIR}/revision-notes.md` }, { output: "# 修订说明\n" }),
      call("edit", { file_path: `${DELIVERABLE_DIR}/revision-notes.md` }, { output: "edited" }),
      call("evimed_submit_deliverable", { deliverableId: DELIVERABLE }, { output: kernelToolText({ ok: true, data: { deliverableId: DELIVERABLE, accepted: true } }) }),
      // The advisory review said it could not be had.
      call("evimed_review_run", { deliverableId: DELIVERABLE }, {
        output: kernelToolText({ ok: false, code: "review_unavailable", issues: [{ severity: "advisory", code: "review_unavailable", message: "审查没有完成（review_not_found）。" }] }),
      }),
      { type: "text", text: "奥希替尼心脏不良反应信号分析已完成。" },
    ]);

    const finished = await reconcile();
    assert.equal(finished.status, "succeeded", noticeTexts(finished).join(" | "));
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification, null, "an accepted deliverable with its files in place carries no reservation");
    assert.deepEqual(finished.artifacts, [`${DELIVERABLE_DIR}/revision-notes.md`, `${DELIVERABLE_DIR}/safety-report.md`], "the files the run wrote are the run's artifacts");

    // One notice per tool that went without; the editor's two slips are not research work.
    const notices = toolNotices(finished);
    assert.deepEqual(notices.map((notice) => notice.code).sort(), ["review_unavailable", "run_tool_unavailable"]);
    const unmounted = notices.find((notice) => notice.code === "run_tool_unavailable");
    assert.equal(unmounted.text, "Research tool web_read is not mounted in this session: 1 call(s) answered unknown tool.");
    assert.equal(unmounted.title, "调用了本次运行没有的工具");
    assert.equal(unmounted.severity, "advice");
    assert.match(unmounted.detail, /^这次运行没有提供「读网页」，它被调用了 1 次，这一步没有执行；成果照常交付/);
    const review = notices.find((notice) => notice.code === "review_unavailable");
    assert.equal(review.title, "复核服务暂不可用");
    assert.match(review.detail, /独立复核这次没有做成.*交付结果不受影响/);
    assert.equal((finished.qualityNotices ?? []).some((notice) => /edit/.test(notice.text)), false, "a retried editor failure is nobody's notice");

    // Read back from the ledger, not only returned — and nothing reads 失败.
    const [listed] = await store.list(project);
    assert.equal(listed.status, "succeeded");
    assert.equal(listed.errorCode, null);
    assert.deepEqual(toolNotices(listed).map((notice) => notice.code).sort(), ["review_unavailable", "run_tool_unavailable"]);
    const inbox = runFinishedNotice(listed);
    assert.equal(inbox.outcome, "delivered");
    assert.equal(inbox.status, "已完成");
    assert.equal(inbox.severity, "info", "advice about a tool is not something the reader has to act on");
    assert.doesNotMatch(`${inbox.title} ${inbox.body}`, /失败|未完成/);
  });
});

test("the live shape with the capability's other required file absent is delivered marked unverified, and says both", async () => {
  // The manifest requires `signals.csv` beside the report; the live run's package
  // held the report and its notes only. That is the missing-file rule's to say,
  // as it was before the tool failure stopped hiding it: the files go out marked,
  // with the missing one named, and the tool is a notice beside it.
  const manifest = { ...ADR, outputs: [{ path: "safety-report.md", required: true }, { path: "signals.csv", required: true }] };
  await withRun(manifest, async ({ project, dispatch, turn, reconcile }) => {
    const run = await dispatch();
    const report = "# 报告\n\n正文。\n";
    await writeDelivery(project, run.id, { [`${DELIVERABLE_DIR}/safety-report.md`]: report });
    turn([
      failedCall("web_read", {}, "UNKNOWN_TOOL", 'Error: unknown tool "web_read"'),
      call("write", { file_path: `${DELIVERABLE_DIR}/safety-report.md`, content: report }),
      call("evimed_submit_deliverable", { deliverableId: DELIVERABLE }, { output: kernelToolText({ ok: true, data: { accepted: true } }) }),
      { type: "text", text: "完成。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification, "unverified");
    assert.deepEqual(finished.artifacts, [`${DELIVERABLE_DIR}/safety-report.md`]);
    assert.deepEqual(finished.qualityNotices.map((notice) => `${notice.severity}:${notice.code}`).sort(), [
      "advice:run_tool_unavailable",
      "must-fix:specialist_required_output_missing",
    ]);
  });
});

test("an uncorrected research-tool failure with the files written is delivered with a notice naming the tool, how often, and the last code it gave", async () => {
  await withRun(ADR, async ({ project, dispatch, turn, reconcile }) => {
    await dispatch();
    await mkdir(path.join(project.workspaceDir), { recursive: true });
    await writeFile(path.join(project.workspaceDir, "safety-report.md"), "# 安全性分析\n\n正文。\n", "utf8");
    turn([
      mcpFailure("mcp__evimed__evidence_deduplicate", "invalid_input"),
      call("write", { file_path: "safety-report.md" }),
      mcpFailure("mcp__evimed__evidence_deduplicate", "public_source_http_error"),
      // Editor and shell failures are the agent exploring, whatever happens to them.
      failedCall("bash", { command: "ls /nonexistent" }, "EXIT_1", "ls: cannot access"),
      failedCall("read", { file_path: "nope.md" }, "OUT_OF_RANGE", "Offset 824 is out of range"),
      { type: "text", text: "分析完成。" },
    ]);

    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.deepEqual(finished.artifacts, ["safety-report.md"]);
    const notices = toolNotices(finished);
    assert.equal(notices.length, 1, "one notice for the tool, not one per call");
    assert.equal(notices[0].code, "run_tool_failed");
    assert.equal(notices[0].text, "Research tool evidence_deduplicate failed 2 time(s) (public_source_http_error) and no later call of it succeeded.");
    assert.equal(notices[0].title, "有检索或分析工具没有成功");
    assert.match(notices[0].detail, /「给证据去重」有 2 次没有成功，之后也没有成功的同类调用；成果照常交付/);
  });
});

test("a failure a later call of the same tool got past is not a notice, under any of its four spellings; one after the last success is", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      // The bare name the kernel does not mount, then the name it does.
      failedCall("web_read", { url: "https://example.org" }, "UNKNOWN_TOOL", 'Error: unknown tool "web_read"'),
      call("mcp__evimed__web_read", { url: "https://example.org" }, { output: JSON.stringify({ status: "success", data: {} }) }),
      // A source that would not answer, asked again.
      mcpFailure("evimed_literature_search", "public_source_http_error"),
      call("evimed-research_evimed_literature_search", { query: "x" }, { output: JSON.stringify({ status: "warning", data: {} }) }),
      // A success first and a failure after it: nothing corrected that one.
      call("mcp__evimed__guideline_search", { query: "x" }, { output: JSON.stringify({ status: "success", data: {} }) }),
      mcpFailure("mcp__evimed__guideline_search", "public_source_gateway_timeout"),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    const notices = toolNotices(finished);
    assert.deepEqual(notices.map((notice) => notice.text), [
      "Research tool guideline_search failed 1 time(s) (public_source_gateway_timeout) and no later call of it succeeded.",
    ]);
  });
});

test("a call that answered with JSON status error is a failure, and a warning is not", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      call("mcp__evimed__drug_label_search", { drug: "x" }, { output: JSON.stringify({ status: "error", error: { code: "drug_label_id_invalid" } }) }),
      call("mcp__evimed__pharmacy_reference_search", { query: "x" }, { output: JSON.stringify({ status: "warning", warnings: ["verify the version"] }) }),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(toolNotices(finished).map((notice) => notice.text), [
      "Research tool drug_label_search failed 1 time(s) (drug_label_id_invalid) and no later call of it succeeded.",
    ]);
  });
});

test("the plan named files and none was written: required output missing, with the failed tools named as the likely cause", async () => {
  // The capability's own required file never written.
  await withRun(ADR, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      mcpFailure("mcp__evimed__adr_case_query", "public_source_http_error"),
      failedCall("web_read", {}, "UNKNOWN_TOOL", 'Error: unknown tool "web_read"'),
      { type: "text", text: "没能取到个例数据，所以没有写出报告。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "specialist_required_output_missing");
    assert.deepEqual(finished.artifacts, []);
    const notices = toolNotices(finished);
    assert.deepEqual(notices.map((notice) => notice.code).sort(), ["run_tool_failed", "run_tool_unavailable"]);
    for (const notice of notices) assert.match(notice.detail, /；这可能是这次没有写出交付文件的原因。$/, notice.text);
    assert.ok(finished.qualityNotices.slice(0, 2).every((notice) => notice.code.startsWith("run_tool_")), "the tools lead: they are the likely cause");
  });

  // A plan that named a deliverable, none accepted and nothing on disk.
  await withRun(ANSWER, async ({ project, dispatch, turn, reconcile }) => {
    await mkdir(path.join(project.workspaceDir, ".evimed-run"), { recursive: true });
    await writeFile(path.join(project.workspaceDir, ".evimed-run", "state.json"), JSON.stringify({
      formatVersion: 1,
      plan: { revision: 1, items: [{ id: "d1", status: "submitted", attempts: 2 }] },
      budget: { steps: 12, tokens: 1, children: 0, limits: {} },
      evidence: { total: 0, byStatus: {} },
      gateRuns: [], subagents: [], qualityNotices: [], degraded: [],
    }, null, 2), "utf8");
    await dispatch();
    turn([
      skillLoaded(),
      mcpFailure("mcp__evimed__literature_search", "public_source_http_error"),
      { type: "text", text: "检索没有成功，没能写出交付物。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "failed");
    assert.equal(finished.errorCode, "specialist_required_output_missing");
    assert.deepEqual(toolNotices(finished).map((notice) => notice.text), [
      "Research tool literature_search failed 1 time(s) (public_source_http_error) and no later call of it succeeded.",
    ]);
    assert.ok(noticeTexts(finished).some((line) => /没有一件通过契约校验/.test(line)), "the plan's own verdict is still said");
  });
});

test("an answer-line turn with a failed search and an answer is answered, with a notice", async () => {
  await withRun(ANSWER, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      skillLoaded(),
      mcpFailure("mcp__evimed__biomedical_source_search", "public_source_gateway_unavailable"),
      call("mcp__evimed__web_search", { query: "x" }, { output: JSON.stringify({ status: "success", data: {} }) }),
      { type: "text", text: "二甲双胍主要通过抑制肝糖输出发挥作用。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.errorCode, null);
    assert.equal(finished.verification, null);
    assert.deepEqual(finished.artifacts, []);
    assert.deepEqual(toolNotices(finished).map((notice) => notice.text), [
      "Research tool biomedical_source_search failed 1 time(s) (public_source_gateway_unavailable) and no later call of it succeeded.",
    ]);
    // The reader is told what was attempted, in the product's words.
    assert.match(toolNotices(finished)[0].detail, /「检索生物医学来源」有 1 次没有成功/);
  });
});

test("an unknown tool is told by the kernel's code or by its own message, and only a research tool is reported", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      // The code the kernel's ToolNotFoundError carries.
      failedCall("mcp__evimed__patent_search", { query: "x" }, "UNKNOWN_TOOL", ""),
      // A history that kept only the message, with the call's own name in it.
      failedCall("mcp__evimed__clinical_trial_search", { query: "x" }, "", 'Error: unknown tool "mcp__evimed__clinical_trial_search"'),
      // A name that is not ours, and a socket tool a deployment may not mount: not research work.
      failedCall("web_fetch", {}, "UNKNOWN_TOOL", 'Error: unknown tool "web_fetch"'),
      failedCall("evimed_capsule_note", {}, "UNKNOWN_TOOL", 'Error: unknown tool "evimed_capsule_note"'),
      // The message of another tool's failure that happens to mention one is not an unknown call.
      failedCall("mcp__evimed__guideline_search", { query: "x" }, "", 'Error: unknown tool "mcp__evimed__patent_search" was named in the question'),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    const byTool = Object.fromEntries(toolNotices(finished).map((notice) => [notice.text.split(" ")[2], notice.code]));
    assert.deepEqual(byTool, { clinical_trial_search: "run_tool_unavailable", guideline_search: "run_tool_failed", patent_search: "run_tool_unavailable" });
  });
});

test("an advisory tool that says it cannot be had is a notice worded as what it is, and a later answer from it corrects it", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    const unavailable = (code) => kernelToolText({ ok: false, code, issues: [{ severity: "advisory", code, message: "没有取到。" }] });
    turn([
      call("evimed_capsule_recall", { query: "x" }, { output: unavailable("capsule_unavailable") }),
      // The same refusal as a history keeps it when the kernel marked the call itself: the code, and no text.
      failedCall("evimed_capsule_note", { note: "x" }, "capsule_unavailable", ""),
      call("evimed_review_run", { deliverableId: "d1" }, { output: unavailable("review_unavailable") }),
      call("evimed_review_run", { deliverableId: "d1" }, { output: kernelToolText({ ok: true, data: { review: { status: "skipped" } } }) }),
      // A refusal that is the submit loop at its work is not a tool being unavailable.
      call("evimed_submit_deliverable", { deliverableId: "d1" }, {
        output: kernelToolText({ ok: false, code: "deliverable_rejected", issues: [{ severity: "required", code: "claim_unbound", message: "x" }] }),
      }),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    const notices = toolNotices(finished);
    assert.deepEqual(notices.map((notice) => notice.code), ["capsule_unavailable", "capsule_unavailable"], "the review answered later; the capsule's two tools never did");
    assert.equal(notices[0].title, "方法胶囊暂不可用");
    assert.match(notices[0].detail, /方法胶囊这次没有取到/);
    assert.deepEqual(notices.map((notice) => notice.text.split(" ")[3]).sort(), ["evimed_capsule_note", "evimed_capsule_recall"], "one per tool");
  });
});

test("a source nobody configured is a named state, never a tool failure", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      mcpFailure("mcp__evimed__biomedical_source_search", "public_source_opengwas_credential_missing"),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.connectorNeeds, ["opengwas"]);
    assert.deepEqual(toolNotices(finished), []);
  });
});

test("a turn that was stopped, refused by the spending limit or failed in its session is decided by that, and says nothing of its tools", async () => {
  const cases = [
    [{ kind: "aborted", code: "runtime_canceled" }, { status: "canceled", errorCode: "runtime_canceled" }],
    [{ kind: "error", code: "runtime_spend_limit_reached" }, { status: "failed", errorCode: "runtime_spend_limit_reached" }],
    [{ kind: "error", code: "runtime_session_error" }, { status: "failed", errorCode: "runtime_session_error" }],
    [{ kind: "max-tokens", code: "runtime_session_error", subCode: "model_max_tokens" }, { status: "failed", errorCode: "runtime_session_error", errorSubCode: "model_max_tokens" }],
    // The kernel's `blocked` end (a pre-step rejection) is a session error with its own sub-code on the wire and in the ledger.
    [{ kind: "blocked", code: "runtime_session_error", subCode: "turn_blocked" }, { status: "failed", errorCode: "runtime_session_error", errorSubCode: "turn_blocked" }],
  ];
  for (const [end, expected] of cases) {
    await withRun(null, async ({ dispatch, turn, reconcile }) => {
      await dispatch();
      turn([
        mcpFailure("mcp__evimed__literature_search", "public_source_http_error"),
        { type: "text", text: "没能继续。" },
      ], end);
      const finished = await reconcile();
      for (const [key, value] of Object.entries(expected)) assert.equal(finished[key], value, `${end.kind}: ${key}`);
      assert.deepEqual(toolNotices(finished), [], `${end.kind}: a stopped or failed turn is not asked about its tools`);
    });
  }
});

test("a delegated child's failures are said, and a success in another session does not correct them", async () => {
  const child = [{
    info: { id: "child_1", role: "assistant", time: { created: 1, completed: 2 } },
    parts: [mcpFailure("mcp__evimed__open_access_full_text", "full_text_not_available"), { type: "text", text: "没有取到全文。" }],
  }, {
    info: { id: "child_2", role: "assistant", time: { created: 3, completed: 4 } },
    // Corrected within its own session: not a notice.
    parts: [mcpFailure("mcp__evimed__literature_search", "public_source_http_error"), call("mcp__evimed__literature_search", {}, { output: JSON.stringify({ status: "success" }) })],
  }];
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    turn([
      call("evimed_delegate", { deliverableId: "d1" }, { output: kernelToolText({ ok: true, data: { childSessionId: "child-1" } }) }),
      // The root succeeds at the same tool the child failed at, afterwards.
      call("mcp__evimed__open_access_full_text", { identifier: "10.1/x" }, { output: JSON.stringify({ status: "success", data: {} }) }),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(toolNotices(finished).map((notice) => notice.text), [
      "Research tool open_access_full_text failed 1 time(s) (full_text_not_available) and no later call of it succeeded.",
    ]);
  }, { children: { "child-1": child } });
});

test("notices are one per tool, the most-failed first, and bounded", async () => {
  await withRun(null, async ({ dispatch, turn, reconcile }) => {
    await dispatch();
    const tools = ["literature_search", "guideline_search", "clinical_trial_search", "patent_search", "biomedical_source_search",
      "open_access_full_text", "web_read", "web_search", "drug_label_search", "pharmacy_reference_search"];
    turn([
      ...tools.map((tool) => mcpFailure(`mcp__evimed__${tool}`, "public_source_http_error")),
      mcpFailure("mcp__evimed__web_search", "public_source_http_error"),
      mcpFailure("mcp__evimed__web_search", "public_source_http_error"),
      { type: "text", text: "答复。" },
    ]);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded");
    const notices = toolNotices(finished);
    assert.equal(notices.length, 8, "a run that went without more tools than this has more to say than this");
    assert.match(notices[0].text, /^Research tool web_search failed 3 time\(s\)/);
    assert.equal(new Set(notices.map((notice) => notice.text.split(" ")[2])).size, 8);
  });
});

test("frames as the kernel writes them reach the same verdict: its ToolNotFoundError, an MCP tool's own error, a turn that completed", async () => {
  // The fixtures above hand the ledger the messages it reads. These are the
  // kernel's own events, through the adapter that turns them into those messages
  // - the unknown-tool error as `dsh-tools` raises it (`UNKNOWN_TOOL`, the
  // message `Error: unknown tool "<name>"`), and an MCP tool's error the way
  // the control plane's gateway words it.
  const at = Date.now();
  const frame = (type, seq, data) => ({ type: "event", event: { type, seq, time: at + seq, data } });
  const toolCall = (seq, callId, name, args) => frame("tool/call", seq, { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) });
  const toolResult = (seq, callId, text, error) => frame("tool/result", seq, {
    turn: 1, step: 1, message: { toolCallId: callId, role: "tool", content: [{ type: "text", text }], isError: Boolean(error) }, ...(error ? { error } : {}),
  });
  // The turn is the run's own: the kernel's log says so by the request the
  // dispatch sent, carried on the user message that opened it.
  const framesFor = (requestId) => [
    frame("turn/start", 1, { turn: 1 }),
    frame("user/message", 2, { turn: 1, content: [{ type: "text", text: "请做奥希替尼的心脏不良反应分析。" }], source: { kind: "user", rpcId: requestId } }),
    toolCall(3, "c1", "web_read", { url: "https://example.org/label" }),
    toolResult(4, "c1", 'Error: unknown tool "web_read"', { name: "ToolNotFoundError", code: "UNKNOWN_TOOL" }),
    toolCall(5, "c2", "mcp__evimed__adr_case_query", { drug: "osimertinib" }),
    toolResult(6, "c2", JSON.stringify({ status: "error", summary: "openFDA answered 400", error: { code: "public_source_http_error" } }), { name: "ToolError", code: "public_source_http_error" }),
    toolCall(7, "c3", "write", { file_path: "safety-report.md", content: "# 报告\n" }),
    toolResult(8, "c3", "wrote safety-report.md"),
    frame("assistant/message", 9, { turn: 1, step: 2, message: { content: [{ type: "text", text: "完成。" }] } }),
    frame("turn/end", 10, { turn: 1, reason: { kind: "completed" } }),
  ];
  await withRun(ADR, async ({ project, dispatch, reconcile, setHistory }) => {
    const run = await dispatch();
    await writeFile(path.join(project.workspaceDir, "safety-report.md"), "# 报告\n", "utf8");
    const history = transcriptToLedgerMessages(normalizeTranscript("ses_verdict", framesFor(run.kernelRequestIds[0])));
    assert.equal(history.find((message) => message.parts[0]?.tool === "web_read").parts[0].state.error, "UNKNOWN_TOOL", "the kernel's code is what the ledger's message carries");
    setHistory(history);
    const finished = await reconcile();
    assert.equal(finished.status, "succeeded", noticeTexts(finished).join(" | "));
    assert.equal(finished.errorCode, null);
    assert.deepEqual(finished.artifacts, ["safety-report.md"]);
    assert.deepEqual(toolNotices(finished).map((notice) => [notice.code, notice.text]).sort(), [
      ["run_tool_failed", "Research tool adr_case_query failed 1 time(s) (public_source_http_error) and no later call of it succeeded."],
      ["run_tool_unavailable", "Research tool web_read is not mounted in this session: 1 call(s) answered unknown tool."],
    ]);
  });
});

test("a conversation-window turn the platform adopted is decided the same way: a search that failed beside an answer is a notice", async () => {
  // The recorded native conversation (two turns, no tools), with one failed
  // research call written into its first turn.
  const fixture = JSON.parse(await readFile(new URL("./fixtures/dsh/native-turn-frames.json", import.meta.url), "utf8"));
  const events = structuredClone(fixture.events);
  const end = events.findIndex((event) => event.seq === 133);
  events.splice(end, 0,
    { type: "tool/call", seq: 100, time: events[0].time + 1, data: { turn: 1, step: 1, callId: "native-c1", name: "mcp__evimed__literature_search", arguments: "{\"query\":\"x\"}" } },
    { type: "tool/result", seq: 101, time: events[0].time + 2, data: {
      turn: 1, step: 1,
      message: { toolCallId: "native-c1", role: "tool", content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "public_source_http_error" } }) }], isError: true },
      error: { name: "ToolError", code: "public_source_http_error" },
    } },
  );
  const root = await mkdtemp(path.join(tmpdir(), "os-run-verdict-native-"));
  const project = { id: "p1", userId: "u1", rootDir: root, metaDir: path.join(root, ".openscience"), workspaceDir: path.join(root, "workspace") };
  await mkdir(project.metaDir, { recursive: true });
  await mkdir(project.workspaceDir, { recursive: true });
  const store = new AgentRunStore({ get: async () => null }, {
    model: "deepseek/deepseek-flash",
    readSessionHistory: async () => transcriptToLedgerMessages(normalizeTranscript(fixture.sessionId, events)),
    readSessionStatus: async () => "idle",
  });
  store.scheduleMonitor = () => {};
  try {
    await store.adoptRuntimeSession(project, fixture.sessionId, { transcript: normalizeTranscript(fixture.sessionId, events), routeTurn: async () => ({}) });
    const runs = await store.list(project);
    assert.equal(runs.length, 2);
    for (const run of runs) assert.equal(run.status, "succeeded", `${run.question}: ${noticeTexts(run).join(" | ")}`);
    const failing = runs.filter((run) => toolNotices(run).length > 0);
    assert.equal(failing.length, 1, "only the turn that met the failure says so");
    assert.deepEqual(toolNotices(failing[0]).map((notice) => notice.text), [
      "Research tool literature_search failed 1 time(s) (public_source_http_error) and no later call of it succeeded.",
    ]);
  } finally {
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("every notice code the ledger raises by name is titled in the domain's table, so none reaches a reader as a bare fallback", async () => {
  const { GATE_CODE_TITLES_ZH } = await import("@evimed/domain");
  const source = readFileSync(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  const codes = new Set([...source.matchAll(/runNotice\(\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]));
  assert.ok(codes.size >= 25 && codes.has("run_tool_failed") && codes.has("run_tool_unavailable"), `the scan read ${codes.size} codes — it no longer sees the ledger's notices`);
  assert.deepEqual([...codes].filter((code) => !Object.hasOwn(GATE_CODE_TITLES_ZH, code)), [], "a notice code the ledger raises has no title in GATE_CODE_TITLES_ZH");
});

test("the runtime-gone path reaches the same verdict for the same facts, and neither path ends a run on a tool", async () => {
  // One workspace of facts — an accepted receipt over files on disk — read twice:
  // once from the transcript, once after the runtime is gone and only the
  // workspace is left. They disagreed: the first ended `failed` over a tool the
  // run had got past, the second `succeeded`.
  const facts = async (project, runId) => {
    await writeDelivery(project, runId, { [`${DELIVERABLE_DIR}/safety-report.md`]: "# 报告\n\n正文。\n" });
  };
  const verdicts = [];
  for (const mode of ["transcript", "gone"]) {
    await withRun(ADR, async ({ project, dispatch, turn, reconcile, runtimeGone }) => {
      const run = await dispatch();
      await facts(project, run.id);
      if (mode === "transcript") {
        turn([
          failedCall("web_read", {}, "UNKNOWN_TOOL", 'Error: unknown tool "web_read"'),
          call("write", { file_path: `${DELIVERABLE_DIR}/safety-report.md` }),
          { type: "text", text: "完成。" },
        ]);
      } else runtimeGone();
      const finished = await reconcile();
      verdicts.push({ mode, status: finished.status, errorCode: finished.errorCode, artifacts: finished.artifacts });
    });
  }
  assert.deepEqual(verdicts.map(({ status, errorCode }) => ({ status, errorCode })), [
    { status: "succeeded", errorCode: null },
    { status: "succeeded", errorCode: null },
  ]);
  assert.deepEqual(verdicts[0].artifacts, verdicts[1].artifacts, "the same files either way");

  // Nothing owed and an answer given: answered either way. The runtime-gone path
  // learns the answer from the event pump rather than from the transcript.
  await withRun(null, async ({ project, store, dispatch, turn, reconcile, runtimeGone }) => {
    const run = await dispatch();
    store.noteRunEvent(project, run.id, { sessionId: "ses_verdict", event: { type: "message/assistant", seq: 1, text: "二甲双胍抑制肝糖输出。", interrupted: false } });
    store.noteRunEvent(project, run.id, { sessionId: "ses_verdict", event: { type: "turn/end", seq: 2, turn: 1, endKind: "completed" } });
    runtimeGone();
    const gone = await reconcile();
    assert.equal(gone.status, "succeeded");
    assert.equal(gone.errorCode, null);
    void turn;
  });

  // Nothing in either path may end a run on a tool: the code is retired from the
  // ledger. Read from the source, comments stripped, because the alternative is
  // standing up every route a transcript can take to the end.
  const source = readFileSync(new URL("../src/agentRuns.mjs", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.includes("runtime_tool_error"), false, "no path of the ledger may end a run as runtime_tool_error");
});
