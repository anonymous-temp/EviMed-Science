// The independent reviewer against a real PostgreSQL: a package read from a
// workspace, every reference resolved, the editor's findings kept only where
// their words are found, the writer's answers counted, the run's notices, and
// the reply check with its safety alert (reviewService.mjs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { ReviewService, replyOfRun } from "../src/reviewService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `review_user_${randomUUID()}`;
const projectId = "review-project";
/** @type {any} */
let database;
/** @type {string} */
let workspace;

const config = {
  reviewEnabled: true, reviewRepliesEnabled: true, reviewModel: "qwen3.8-max-0902", reviewApiBase: "https://dashscope.example/compatible-mode/v1",
  reviewEditorTimeoutMs: 10_000, reviewReplyTimeoutMs: 10_000, reviewThinkingBudget: 800, reviewMaxOutputTokens: 2_000, reviewEditorPasses: 2,
  reviewReplyConcurrency: 2, dashscopeApiKey: "test-key", userDailySpendLimit: 0, userWeeklySpendLimit: 0,
};

const REPORT = [
  "# 二甲双胍与 HbA1c",
  "",
  "## 结论",
  "二甲双胍使 HbA1c 较安慰剂降低 1.5% [1]。<!-- claim:CLM-001 -->",
  "该结论适用于所有成人。",
  "",
  "## 参考文献",
  "1. Smith J. Metformin versus placebo in type 2 diabetes. doi:10.1000/real",
  "2. Ghost A. A trial that does not exist. doi:10.9999/fabricated",
  "",
].join("\n");
const SOURCE = "Metformin versus placebo in type 2 diabetes. Metformin lowered HbA1c by 0.9 percentage points compared with placebo (95% CI 0.7 to 1.1) over 24 weeks.";
const MATRIX = {
  claims: [{ claimId: "CLM-001", claimType: "direct", claim: "二甲双胍使 HbA1c 较安慰剂降低 1.5%", supportQuote: "Metformin lowered HbA1c by 0.9 percentage points compared with placebo",
    artifactPath: ".evimed-sources/pubmed/PMID1/abc/abstract.md", sourceTitle: "Metformin versus placebo", identifier: "doi:10.1000/real", referenceNumber: 1 }],
};

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Reviewer test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Review',1048576)", [userId, projectId]);
  await migrateUsageLedger(database);
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-ws-"));
  await fs.mkdir(path.join(workspace, "deliverables/d1"), { recursive: true });
  await fs.writeFile(path.join(workspace, "deliverables/d1/clinical-evidence-report.md"), REPORT);
  await fs.writeFile(path.join(workspace, "deliverables/d1/clinical-evidence-matrix.json"), JSON.stringify(MATRIX));
  await fs.mkdir(path.join(workspace, ".evimed-sources/pubmed/PMID1/abc"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".evimed-sources/pubmed/PMID1/abc/abstract.md"), SOURCE);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  await database.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A streamed answer from the reviewer model. @param {any} value */
function modelAnswer(value) {
  const events = [
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [{ index: 0, delta: { content: JSON.stringify(value) } }] },
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [], usage: { prompt_tokens: 2_000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } } },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** @param {{ modelAnswers: any[], notifications?: any, imService?: any, runtimeManager?: any }} input */
function service({ modelAnswers, notifications = null, imService = null, runtimeManager = null }) {
  /** @type {any[]} */
  const prompts = [];
  const answers = [...modelAnswers];
  return {
    prompts,
    review: new ReviewService({
      config, database, store: {
        userById: async (/** @type {string} */ id) => (id === userId ? { id } : null),
        requireProject: async () => ({ id: projectId, userId, workspaceDir: workspace }),
      },
      agentRegistry: Promise.resolve({ get: () => ({ outputs: [{ path: "clinical-evidence-report.md" }, { path: "clinical-evidence-matrix.json" }] }) }),
      attributeRun: async () => "run_review_1",
      notifications, imService, runtimeManager, retryDelayMs: 0,
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
        prompts.push(JSON.parse(init.body));
        const next = answers.shift();
        return next instanceof Response ? next : modelAnswer(next ?? { findings: [], checklist: [], acceptance: [] });
      }),
      referenceResolver: {
        resolve: async () => ({
          doi: new Map([["10.1000/real", { status: "found", title: "Metformin versus placebo in type 2 diabetes" }], ["10.9999/fabricated", { status: "not_found" }]]),
          pmid: new Map(),
        }),
        sourceTexts: async (/** @type {any[]} */ references) => new Map(references.map((reference) => [reference.number, SOURCE])),
      },
    }),
  };
}

/** @param {ReviewService} review @param {string} reviewId */
async function settled(review, reviewId) {
  for (let tries = 0; tries < 100; tries += 1) {
    const state = await review.reviewStatus({ userId, projectId }, reviewId);
    if (state?.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the review never finished");
}

test("a package is reviewed whole: references resolved, located findings kept, the rest dropped and counted", options, async () => {
  const { review, prompts } = service({ modelAnswers: [{
    findings: [
      { location: "CLM-001", kind: "contradiction", evidence: "lowered HbA1c by 0.9 percentage points", fix: "把 1.5% 改为 0.9 个百分点。" },
      { location: "结论", kind: "overclaim", evidence: "该结论适用于所有成人。", fix: "限定为试验人群。" },
      { location: "CLM-001", kind: "contradiction", evidence: "Source states 0.9 points; the claim states 1.5%.", fix: "改。" },
    ],
    checklist: [{ item: "E1", status: "present", evidence: "二甲双胍使 HbA1c 较安慰剂降低" }, { item: "E2", status: "absent", evidence: "" }],
    acceptance: [{ item: "A1", met: false, evidence: "" }],
  }] });
  await review.ready();
  const started = await review.startDeliverableReview({ userId, projectId }, {
    runId: "native_x", sessionId: "s1", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1,
    acceptance: ["写明检索日期"],
  });
  assert.equal(started.status, "running");
  const done = await settled(review, /** @type {any} */ (started).reviewId);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(done.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind, finding.origin, finding.severity]), [
    ["F01", "reference_unresolvable", "code", "advisory"],
    ["F02", "contradiction", "editor", "advisory"],
    ["F03", "overclaim", "editor", "advisory"],
  ], "the paraphrased contradiction was dropped; nothing is required until promoted");
  assert.match(done.findings[0].message, /10\.9999\/fabricated/);
  assert.equal(done.dropped, 1);
  assert.deepEqual(done.checklist, { present: 1, absent: ["E2"], unlocated: [] });
  const stored = await database.query("SELECT deterministic->'editorAnswer' AS answer FROM evimed_review.reviews WHERE id=$1", [/** @type {any} */ (started).reviewId]);
  assert.deepEqual(stored.rows[0].answer, {
    findings: 3, checklistAsked: 19, checklistAnswered: 2, checklistKept: 2, acceptanceAsked: 1, acceptanceAnswered: 1, acceptanceKept: 1,
    reasoningTokens: 0, thinkingBudget: 800,
  }, "what the editor answered at all is kept beside what survived");
  assert.deepEqual(done.acceptance, { met: [], unmet: ["A1"], unlocated: [] });
  assert.equal(done.deterministic.references.unresolvable, 1);
  assert.equal(done.model, "qwen3.8-max-0902");

  // What the editor was shown: the checklist for the kind, the acceptance
  // item, the claim with its source excerpt, the resolution, the report last.
  const message = prompts[0].messages[1].content;
  assert.match(message, /E1（临床证据报告要素）/);
  assert.match(message, /A1 写明检索日期/);
  assert.match(message, /<sources>\n\[S1\] \.evimed-sources\/pubmed\/PMID1\/abc\/abstract\.md《Metformin versus placebo》\nMetformin versus placebo in type 2 diabetes\. Metformin lowered HbA1c by 0\.9 percentage points/, "the source once, whole");
  assert.match(message, /CLM-001 \[direct\] [^\n]*\n  来源 S1\n  引文：Metformin lowered HbA1c/);
  assert.ok(message.indexOf("<sources>") < message.indexOf("<claims>"));
  assert.match(message, /查无此条 1 条/);
  assert.ok(message.indexOf("<claims>") < message.indexOf('<file name="clinical-evidence-report.md">'), "stable parts first, for the provider's prefix cache");
  assert.equal(prompts[0].enable_thinking, true);
  assert.match(prompts[0].messages[0].content, /safety（剂量/, "a clinical kind is reviewed for medicine safety too");

  // The writer answers; a decline without a reason is refused.
  const answered = await review.recordResponses({ userId, projectId }, { reviewId: /** @type {any} */ (started).reviewId, answers: [
    { id: "F02", response: "fixed" }, { id: "F03", response: "declined", reason: "" }, { id: "F09", response: "fixed" },
  ] });
  assert.equal(answered?.recorded, 1);
  assert.deepEqual(answered?.refused.map((/** @type {any} */ entry) => entry.reason), ["reason", "unknown"]);

  // The run's notices: the summary, then what still owes an answer.
  const notices = await review.reviewNoticesForRun(userId, projectId, "run_review_1");
  assert.equal(notices[0].code, "review_summary");
  assert.match(notices[0].text, /3 条审查发现（已修 1，不改并说明 0，未回应 2）/);
  assert.deepEqual(notices.slice(1).map((notice) => notice.code), ["review_reference_unresolvable", "review_overclaim"]);

  // Another account sees none of it.
  assert.equal(await review.reviewStatus({ userId: "someone-else", projectId }, /** @type {any} */ (started).reviewId), null);
});

test("a second pass reads the repaired package with the last findings and their answers; a third is deterministic only", options, async () => {
  const { review, prompts } = service({ modelAnswers: [{ findings: [], checklist: [], acceptance: [] }, { findings: [], checklist: [], acceptance: [] }] });
  const identity = { userId, projectId };
  const input = { runId: "native_second", sessionId: "s2", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1 };
  const first = await review.startDeliverableReview(identity, input);
  await settled(review, /** @type {any} */ (first).reviewId);
  // Unchanged package: no editor pass is spent on it.
  const unchanged = await review.startDeliverableReview(identity, { ...input, attempt: 2 });
  const same = await settled(review, /** @type {any} */ (unchanged).reviewId);
  assert.equal(same.editor, "unchanged");
  assert.equal(prompts.length, 1);
  await fs.writeFile(path.join(workspace, "deliverables/d1/clinical-evidence-report.md"), REPORT.replace("1.5%", "0.9 个百分点"));
  try {
    const second = await review.startDeliverableReview(identity, { ...input, attempt: 3 });
    const repaired = await settled(review, /** @type {any} */ (second).reviewId);
    assert.equal(repaired.pass, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].messages[0].content, /第二轮/);
    await fs.writeFile(path.join(workspace, "deliverables/d1/clinical-evidence-report.md"), `${REPORT}\n补充。\n`);
    const third = await review.startDeliverableReview(identity, { ...input, attempt: 4 });
    const last = await settled(review, /** @type {any} */ (third).reviewId);
    assert.equal(last.editor, "skipped", "two editor passes a deliverable");
    assert.equal(prompts.length, 2);
    assert.equal(last.deterministic.references.unresolvable, 1, "the deterministic checks still ran");
  } finally {
    await fs.writeFile(path.join(workspace, "deliverables/d1/clinical-evidence-report.md"), REPORT);
  }
});

test("a transient provider failure is retried once; a second leaves the deterministic review standing and says the editor failed", options, async () => {
  const unavailable = () => new Response(JSON.stringify({ error: { code: "ServiceUnavailable", message: "busy" } }), { status: 503, headers: { "content-type": "application/json" } });
  const identity = { userId, projectId };
  const input = { sessionId: "s-retry", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1 };
  const once = service({ modelAnswers: [unavailable(), {
    findings: [{ location: "CLM-001", kind: "contradiction", evidence: "lowered HbA1c by 0.9 percentage points", fix: "把 1.5% 改为 0.9 个百分点。" }], checklist: [], acceptance: [],
  }] });
  const recovered = await settled(once.review, /** @type {any} */ (await once.review.startDeliverableReview(identity, { ...input, runId: "native_retry_once" })).reviewId);
  assert.equal(recovered.editor, "done");
  assert.equal(once.prompts.length, 2, "one retry");
  assert.ok(recovered.findings.some((/** @type {any} */ finding) => finding.origin === "editor" && finding.kind === "contradiction"));
  assert.equal(once.review.stats().editorRetries, 1);

  const twice = service({ modelAnswers: [unavailable(), unavailable(), { findings: [], checklist: [], acceptance: [] }] });
  const failed = await settled(twice.review, /** @type {any} */ (await twice.review.startDeliverableReview(identity, { ...input, runId: "native_retry_twice" })).reviewId);
  assert.equal(failed.status, "done", "the deterministic half stands");
  assert.equal(failed.editor, "failed");
  assert.equal(failed.editorError, "review_model_upstream_error");
  assert.equal(twice.prompts.length, 2, "never a third call");
  assert.ok(failed.findings.some((/** @type {any} */ finding) => finding.kind === "reference_unresolvable"));
  assert.deepEqual([twice.review.stats().editorRetries, twice.review.stats().editorFailures], [1, 1]);
});

test("a docker runtime's own root is not where this process reads: the package comes from the host copy", options, async () => {
  // The first live review (2026-09-23) read nothing: under docker the delivery
  // root is `/workspace`, the path inside the runtime container.
  const synced = [];
  const runtimeManager = { workspaceRootForDelivery: async (/** @type {any} */ project) => { synced.push(project.id); return "/workspace"; } };
  const { review, prompts } = service({ modelAnswers: [{ findings: [], checklist: [], acceptance: [] }], runtimeManager });
  const started = await review.startDeliverableReview({ userId, projectId }, {
    runId: "native_docker_root", sessionId: "s-docker", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1,
  });
  const done = await settled(review, /** @type {any} */ (started).reviewId);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(done.deterministic.references.references, 2, "the report's reference list was read");
  assert.deepEqual(synced, [projectId], "the provider was still asked to bring the host copy up to date");
  assert.match(prompts[0].messages[1].content, /Ghost A\. A trial that does not exist/, "the editor saw the report");
});

test("a deliverable with no readable file fails by name and never reaches the model", options, async () => {
  const { review, prompts } = service({ modelAnswers: [{ findings: [{ location: "E1", kind: "missing_item", evidence: "", fix: "guess" }], checklist: [], acceptance: [] }] });
  const started = await review.startDeliverableReview({ userId, projectId }, {
    runId: "native_nothing", sessionId: "s-nothing", deliverableId: "d-absent", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1,
  });
  const failed = await settled(review, /** @type {any} */ (started).reviewId);
  assert.deepEqual(failed, { reviewId: /** @type {any} */ (started).reviewId, status: "failed", code: "review_package_unreadable" });
  assert.equal(prompts.length, 0, "no editor is paid to judge a package it was not shown");
});

test("a reply that cites or names a medicine is checked after it was shown; a contradicted medicine claim reaches a person", options, async () => {
  /** @type {any[]} */
  const alerts = [];
  /** @type {any[]} */
  const corrections = [];
  const { review, prompts } = service({
    modelAnswers: [{ verdicts: [
      { sentence: 0, verdict: "unsupported", reason: "来源说降低 0.9 个百分点", evidence: "lowered HbA1c by 0.9 percentage points", safety: "contradicted" },
    ] }],
    notifications: { create: async (/** @type {string} */ user, /** @type {any} */ item) => { alerts.push([user, item]); return item; } },
    imService: { sendRunCorrection: async (/** @type {any[]} */ ...args) => { corrections.push(args); return true; } },
  });
  const identity = { userId, projectId };
  const reply = "二甲双胍可使 HbA1c 降低 1.5% [1]。\n\n## 参考文献\n1. Smith J. Metformin versus placebo. PMID: 12345678\n";
  assert.equal(await review.considerReply(identity, { id: "run_reply_1", sessionId: "chat-1" }, { replyText: "你好！", turnSeq: 3 }), null, "a greeting is L0: nothing is written");
  const queued = await review.considerReply(identity, { id: "run_reply_2", sessionId: "chat-1" }, { replyText: reply, question: "二甲双胍降糖多少？", turnSeq: 12 });
  assert.ok(queued);
  assert.equal(await review.considerReply(identity, { id: "run_reply_2", sessionId: "chat-1" }, { replyText: reply, turnSeq: 12 }), null, "once per run");
  assert.equal(await review.processReplyChecks("worker-test"), 1);
  const [check] = await review.replyChecksForSession(identity, "chat-1");
  assert.equal(check.status, "done");
  assert.equal(check.turnSeq, 12);
  assert.deepEqual(check.medicines, ["二甲双胍"]);
  assert.equal(check.verdicts[0].verdict, "unsupported");
  assert.equal(check.verdicts[0].warning, true);
  assert.equal(check.verdicts[0].source.url, "https://pubmed.ncbi.nlm.nih.gov/12345678/");
  assert.equal(prompts.at(-1).enable_thinking, false, "a reply check does not think");
  assert.match(prompts.at(-1).messages[1].content, /S0（涉药） 引用 \[1\]/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0][1].severity, "safety");
  assert.equal(corrections.length, 1);
  assert.match(corrections[0][3], /更正提示/);
  // Processed once: a second tick claims nothing.
  assert.equal(await review.processReplyChecks("worker-test"), 0);
});

test("the reply a run gave is its last assistant text inside its window, with the question before it", () => {
  const run = { startedAt: "2026-09-23T10:00:00.000Z", finishedAt: "2026-09-23T10:01:00.000Z" };
  const at = (/** @type {string} */ time) => Date.parse(time);
  const messages = [
    { role: "user", time: at("2026-09-23T09:00:00Z"), seq: 1, parts: [{ type: "text", text: "旧问题" }] },
    { role: "assistant", time: at("2026-09-23T09:00:10Z"), seq: 2, parts: [{ type: "text", text: "旧回答" }] },
    { role: "user", time: at("2026-09-23T10:00:01Z"), seq: 7, parts: [{ type: "text", text: "新问题" }] },
    { role: "assistant", time: at("2026-09-23T10:00:30Z"), seq: 9, parts: [{ type: "text", text: "新回答" }] },
  ];
  assert.deepEqual(replyOfRun(messages, run), { replyText: "新回答", turnSeq: 9, question: "新问题" });
  assert.equal(replyOfRun(messages.slice(0, 2), run), null);
});
