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

/** An editor that answered and found nothing: one checklist item, absent. */
const QUIET = Object.freeze({ findings: [], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] });
/** An editor that said nothing at all. */
const SILENT = Object.freeze({ findings: [], checklist: [], acceptance: [] });

/** @param {{ modelAnswers: any[], notifications?: any, imService?: any, runtimeManager?: any, outputs?: { path: string }[] }} input */
function service({ modelAnswers, notifications = null, imService = null, runtimeManager = null,
  outputs = [{ path: "clinical-evidence-report.md" }, { path: "clinical-evidence-matrix.json" }] }) {
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
      agentRegistry: Promise.resolve({ get: () => ({ outputs }) }),
      attributeRun: async () => "run_review_1",
      notifications, imService, runtimeManager, retryDelayMs: 0,
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
        prompts.push(JSON.parse(init.body));
        const next = answers.shift();
        return next instanceof Response ? next : modelAnswer(next ?? QUIET);
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
    reasoningTokens: 0, thinkingBudget: 800, emptyAnswers: 0,
  }, "what the editor answered at all is kept beside what survived");
  assert.deepEqual(done.acceptance, { met: [], unmet: ["A1"], unlocated: [] });
  assert.equal(done.deterministic.references.unresolvable, 1);
  assert.equal(done.model, "qwen3.8-max-0902");

  // What the editor was shown: the checklist for the kind, the acceptance
  // item, the claim with its source excerpt, the resolution, the report last.
  const message = prompts[0].messages[1].content;
  assert.match(message, /^<submission [^\n]*>\n今天是 \d{4}-\d{2}-\d{2}（UTC）。/, "the editor is told the date, not left to its training data's");
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(prompts[0].messages[0].content), false, "and the system prompt carries none, so it stays cacheable");
  assert.match(message, /E1（临床证据报告要素）/);
  assert.match(message, /A1 写明检索日期/);
  assert.match(message, /<sources>\n\[S1\] \.evimed-sources\/pubmed\/PMID1\/abc\/abstract\.md《Metformin versus placebo》\nMetformin versus placebo in type 2 diabetes\. Metformin lowered HbA1c by 0\.9 percentage points/, "the source once, whole");
  assert.match(message, /CLM-001 \[direct\] [^\n]*\n  来源 S1\n  引文：Metformin lowered HbA1c/);
  assert.ok(message.indexOf("<sources>") < message.indexOf("<claims>"));
  assert.match(message, /查无此条 1 条/);
  assert.ok(message.indexOf("<claims>") < message.indexOf('<file name="clinical-evidence-report.md">'), "stable parts first, for the provider's prefix cache");
  assert.equal(prompts[0].enable_thinking, true);
  const schema = prompts[0].response_format.json_schema.schema;
  assert.deepEqual([schema.properties.checklist.minItems, schema.properties.acceptance.maxItems, schema.properties.findings.minItems], [19, 1, 1], "this package's items, exactly, and one finding entry at least");
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

test("a section declared a randomised trial is asked the trial's list, and a checklist row that points at nothing is a located finding", options, async () => {
  // Owner ruling 2026-09-24: the plan declares the study type, the reviewer
  // attaches its reporting checklist, and the deliverable carries its own
  // completed copy — which the editor may hold to the text.
  const row = "| Methods — Randomisation: allocation concealment mechanism | 18 | Mechanism used to implement the random allocation sequence | 资料与方法 › 随机化 |";
  const section = [
    "## 资料与方法",
    "本研究为多中心随机对照试验，按 1:1 分配 [1]。",
    "",
    "## 参考文献",
    "1. Smith J. Metformin versus placebo in type 2 diabetes. doi:10.1000/real",
    "",
  ].join("\n");
  const dir = path.join(workspace, "deliverables/sec1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manuscript-section.md"), section);
  await fs.writeFile(path.join(dir, "reporting-checklist.md"), `# CONSORT 2025\n\n| Section/topic | Item | Checklist item | 报告位置 |\n| --- | --- | --- | --- |\n${row}\n`);
  const { review, prompts } = service({
    outputs: [{ path: "manuscript-section.md" }, { path: "section-claims.json" }, { path: "citation-ledger.csv" }, { path: "reporting-checklist.md" }],
    modelAnswers: [{
      findings: [{ location: "18", kind: "missing_item", evidence: row, fix: "在「随机化」下写明分配隐藏的方法，或把这一行改为「未报告：原因」。" }],
      checklist: [{ item: "C1", status: "present", evidence: "本研究为多中心随机对照试验" }, { item: "C18", status: "absent", evidence: "" }],
      acceptance: [],
    }],
  });
  const started = await review.startDeliverableReview({ userId, projectId }, {
    runId: "native_rct", sessionId: "s-rct", deliverableId: "sec1", contractKind: "manuscript-section", capability: "manuscript-support", attempt: 1, studyType: "rct",
  });
  const done = await settled(review, /** @type {any} */ (started).reviewId);
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(done.findings.map((/** @type {any} */ finding) => [finding.kind, finding.origin, finding.location]), [["missing_item", "editor", "18"]],
    "the checklist row it rests on is in the package, so the finding is located and kept");
  assert.equal(done.deterministic.references.references, 1, "the references were read from the section, not from the checklist");
  assert.deepEqual(done.checklist, { present: 1, absent: ["C18"], unlocated: [] });

  const schema = prompts[0].response_format.json_schema.schema;
  assert.equal(schema.properties.checklist.minItems, 39, "SAMPL for the contract, CONSORT 2025 for the declared trial");
  assert.ok(schema.properties.checklist.items.properties.item.enum.includes("C30"));
  const message = prompts[0].messages[1].content;
  assert.match(message, /^<submission contract="manuscript-section" deliverable="sec1" tier="L2" clinical="true" study-type="rct">/);
  assert.match(message, /研究类型：随机对照试验（作者声明），报告规范 CONSORT 2025。/);
  assert.match(message, /作者附了填好的报告规范清单（reporting-checklist\.md）/);
  assert.match(message, /<file name="reporting-checklist\.md">/);
  const stored = await database.query("SELECT deterministic->>'studyType' AS study_type FROM evimed_review.reviews WHERE id=$1", [/** @type {any} */ (started).reviewId]);
  assert.equal(stored.rows[0].study_type, "rct", "the review's record says which design it was held to");
});

test("a second pass reads the repaired package with the last findings and their answers; a third is deterministic only", options, async () => {
  const { review, prompts } = service({ modelAnswers: [QUIET, QUIET] });
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

test("a finding the writer declined and the next review raises word for word stays declined; one called fixed that comes back does not", options, async () => {
  // The answer to review N travels with the submission that starts review
  // N+1, and a reader is shown N+1: before this, a declined deterministic
  // finding came back as a new unanswered row on every pass (2026-09-27, the
  // missed-dialysis topic run: 32 declined, 0 in the ledger).
  const { review } = service({ modelAnswers: [QUIET, QUIET] });
  const identity = { userId, projectId };
  const input = { runId: "native_declined", sessionId: "s-declined", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1 };
  const first = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, input)).reviewId);
  const unresolvable = first.findings.find((/** @type {any} */ finding) => finding.kind === "reference_unresolvable");
  assert.ok(unresolvable, JSON.stringify(first.findings));
  const reason = "The registry lacks this record; the trial report was read in full.";
  const answered = await review.recordResponses(identity, { reviewId: first.reviewId, answers: [{ id: unresolvable.id, response: "declined", reason }] });
  assert.equal(answered?.recorded, 1);

  const second = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 2 })).reviewId);
  const again = second.findings.find((/** @type {any} */ finding) => finding.kind === "reference_unresolvable");
  assert.deepEqual([again?.response, again?.responseReason], ["declined", reason], "the decline stands on the pass the reader is shown");

  // Called fixed, raised again unchanged: it was not fixed, and is not carried.
  await review.recordResponses(identity, { reviewId: second.reviewId, answers: [{ id: again.id, response: "fixed" }] });
  const third = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 3 })).reviewId);
  const onceMore = third.findings.find((/** @type {any} */ finding) => finding.kind === "reference_unresolvable");
  assert.equal(onceMore?.response, "declined", "the newest decline still stands; the unfounded fixed did not replace it");
});

test("only ids an engine wrote a job directory for are traced against, never a word of the same shape", options, async () => {
  // 2026-09-27: the topic review traced 「meta-analysis」, 「topic-run-receipt」
  // and 「topic-report-specialist-scan」 as jobs, and named them in every
  // finding; the real job was the fourth match, and only four were read.
  const jobId = "topic-20260927132630-8ccbf68d5210";
  await fs.mkdir(path.join(workspace, "deliverables/d-topic"), { recursive: true });
  await fs.mkdir(path.join(workspace, "research-topic-runs", jobId, "output"), { recursive: true });
  await fs.writeFile(path.join(workspace, "research-topic-runs", jobId, "output", "portfolio.json"), JSON.stringify({ records: 16, candidates: 3 }));
  await fs.writeFile(path.join(workspace, "deliverables/d-topic/research-topic-report.md"), [
    "# Topic agenda",
    "",
    "A meta-analysis, the topic-run-receipt, the topic-report-specialist-scan and the topic-review-notes-draft are not jobs.",
    `The engine job ${jobId} returned 16 records.`,
    "",
  ].join("\n"));
  const { review } = service({ modelAnswers: [QUIET], outputs: [{ path: "research-topic-report.md" }] });
  const done = await settled(review, /** @type {any} */ (await review.startDeliverableReview({ userId, projectId }, {
    runId: "native_jobs", sessionId: "s-jobs", deliverableId: "d-topic", contractKind: "research-topic-report", capability: "research-topic-selection", attempt: 1,
  })).reviewId);
  assert.deepEqual(done.deterministic.jobs, [jobId]);
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

  const twice = service({ modelAnswers: [unavailable(), unavailable(), QUIET] });
  const failed = await settled(twice.review, /** @type {any} */ (await twice.review.startDeliverableReview(identity, { ...input, runId: "native_retry_twice" })).reviewId);
  assert.equal(failed.status, "done", "the deterministic half stands");
  assert.equal(failed.editor, "failed");
  assert.equal(failed.editorError, "review_model_upstream_error");
  assert.equal(twice.prompts.length, 2, "never a third call");
  assert.ok(failed.findings.some((/** @type {any} */ finding) => finding.kind === "reference_unresolvable"));
  assert.deepEqual([twice.review.stats().editorRetries, twice.review.stats().editorFailures], [1, 1]);
});

test("an editor that says nothing at all is asked once more, and saying nothing twice is a failure by name, never a clean pass", options, async () => {
  const identity = { userId, projectId };
  const input = { sessionId: "s-empty", deliverableId: "d1", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis", attempt: 1 };
  const once = service({ modelAnswers: [SILENT, {
    findings: [{ location: "CLM-001", kind: "contradiction", evidence: "lowered HbA1c by 0.9 percentage points", fix: "把 1.5% 改为 0.9 个百分点。" }],
    checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [],
  }] });
  const started = await once.review.startDeliverableReview(identity, { ...input, runId: "native_empty_once" });
  const recovered = await settled(once.review, /** @type {any} */ (started).reviewId);
  assert.equal(recovered.editor, "done");
  assert.equal(recovered.pass, 1);
  assert.equal(once.prompts.length, 2, "asked once more");
  assert.ok(recovered.findings.some((/** @type {any} */ finding) => finding.origin === "editor" && finding.kind === "contradiction"));
  const stored = await database.query("SELECT deterministic->'editorAnswer' AS answer, usage, cost FROM evimed_review.reviews WHERE id=$1", [/** @type {any} */ (started).reviewId]);
  assert.equal(stored.rows[0].answer.emptyAnswers, 1);
  assert.equal(stored.rows[0].usage.completionTokens, 600, "both answers were paid for, and both are counted");
  assert.deepEqual([once.review.stats().editorEmpty, once.review.stats().editorFailures], [1, 0]);

  const twice = service({ modelAnswers: [SILENT, SILENT, QUIET] });
  const failed = await settled(twice.review, /** @type {any} */ (await twice.review.startDeliverableReview(identity, { ...input, runId: "native_empty_twice" })).reviewId);
  assert.equal(failed.status, "done", "the deterministic half stands");
  assert.equal(failed.editor, "failed");
  assert.equal(failed.editorError, "review_editor_empty");
  assert.equal(failed.pass, 0, "a next submission may still have an editor pass");
  assert.equal(twice.prompts.length, 2, "never a third call");
  assert.ok(failed.findings.every((/** @type {any} */ finding) => finding.origin === "code"));
  assert.deepEqual([twice.review.stats().editorEmpty, twice.review.stats().editorFailures], [1, 1]);
});

test("after the editor is spent, the reader still sees what its last pass left in the report, never 「nothing to handle」", options, async () => {
  // 2026-09-23, the first submit-path review on production: a third,
  // deterministic-only pass said 「没有发现需要处理的问题」 over eleven findings
  // the second pass had left in the report.
  await fs.mkdir(path.join(workspace, "deliverables/d2"), { recursive: true });
  const reportPath = path.join(workspace, "deliverables/d2/clinical-evidence-report.md");
  await fs.writeFile(reportPath, REPORT);
  await fs.writeFile(path.join(workspace, "deliverables/d2/clinical-evidence-matrix.json"), JSON.stringify(MATRIX));
  const { review } = service({ modelAnswers: [
    { findings: [{ location: "结论", kind: "wording", evidence: "该结论适用于所有成人。", fix: "限定人群。" }], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] },
    { findings: [
      { location: "结论", kind: "overclaim", evidence: "该结论适用于所有成人。", fix: "限定为试验人群。" },
      { location: "CLM-001", kind: "wording", evidence: "二甲双胍使 HbA1c 较安慰剂降低 1.5%", fix: "改用来源的数字。" },
    ], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] },
  ] });
  const identity = { userId, projectId };
  const input = { runId: "native_carry", sessionId: "s-carry", deliverableId: "d2", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 1 })).reviewId);
  await fs.writeFile(reportPath, `${REPORT}补充。\n`);
  const second = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 2 })).reviewId);
  // Ids hold across passes, and none of these three is the first pass's: the
  // appended sentence joined the last reference entry, so the unresolvable
  // reference rests on new words (F03), and the editor's two are new (F04, F05).
  assert.deepEqual(second.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind]), [["F03", "reference_unresolvable"], ["F04", "overclaim"], ["F05", "wording"]]);
  // The writer fixes the number, in the report and its matrix, and leaves the
  // overclaim; the editor is spent.
  await fs.writeFile(reportPath, `${REPORT.replace("降低 1.5% [1]", "降低 0.9 个百分点 [1]")}补充。\n`);
  await fs.writeFile(path.join(workspace, "deliverables/d2/clinical-evidence-matrix.json"),
    JSON.stringify({ claims: [{ ...MATRIX.claims[0], claim: "二甲双胍使 HbA1c 较安慰剂降低 0.9 个百分点" }] }));
  const third = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 3 })).reviewId);
  assert.equal(third.editor, "skipped");

  const [view] = (await review.reviewsForRun(identity, "native_carry"));
  assert.deepEqual(view.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind, finding.response ?? null]), [
    ["F03", "reference_unresolvable", null],
    ["2.F04", "overclaim", null],
    ["2.F05", "wording", "resolved"],
  ], "the second pass's findings, the one whose words are gone marked resolved");
  const notices = await review.reviewNoticesForRun(userId, projectId, "run_review_1");
  const summary = notices.find((notice) => notice.code === "review_summary" && notice.text.includes("「d2」"));
  assert.match(String(summary?.text), /3 条审查发现（已修 1，不改并说明 0，未回应 2）/);
  assert.ok(notices.some((notice) => notice.code === "review_overclaim"), "the overclaim it left still owes an answer");
});

test("the editor pass a review carries is the one before it, even when both were made in the same millisecond", options, async () => {
  // "Before this review" was bounded by the review's created_at read into
  // JavaScript: .123 for a column that holds .123456, so an editor pass made
  // at .123100 was not before it and its findings never reached the reader.
  await fs.mkdir(path.join(workspace, "deliverables/d5"), { recursive: true });
  await fs.writeFile(path.join(workspace, "deliverables/d5/clinical-evidence-report.md"), REPORT);
  await fs.writeFile(path.join(workspace, "deliverables/d5/clinical-evidence-matrix.json"), JSON.stringify(MATRIX));
  const { review } = service({ modelAnswers: [
    { findings: [{ location: "结论", kind: "overclaim", evidence: "该结论适用于所有成人。", fix: "限定为试验人群。" }], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] },
  ] });
  const identity = { userId, projectId };
  const input = { runId: "native_same_ms", sessionId: "s-ms", deliverableId: "d5", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  const first = /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 1 })).reviewId;
  assert.equal((await settled(review, first)).pass, 1);
  const second = /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 2 })).reviewId;
  assert.equal((await settled(review, second)).editor, "unchanged");
  await database.query("UPDATE evimed_review.reviews SET created_at=$2 WHERE id=$1", [first, "2026-09-29T00:00:00.123100Z"]);
  await database.query("UPDATE evimed_review.reviews SET created_at=$2 WHERE id=$1", [second, "2026-09-29T00:00:00.123456Z"]);
  const [view] = await review.reviewsForRun(identity, "native_same_ms");
  assert.deepEqual(view.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind]), [["F01", "reference_unresolvable"], ["1.F02", "overclaim"]],
    "the latest review's own finding, and the editor pass's carried under its pass");
});

test("a finding raised again keeps its id across passes, a new one is numbered after every id used, and the reader still sees the gravest first", options, async () => {
  // Numbered afresh on each pass, the writer's answers pointed at findings
  // that had moved (2026-09-27 osimertinib: 「第二轮编号已重排」; 2026-09-28
  // topic: F06–F09 answered against ids that no longer named them).
  await fs.mkdir(path.join(workspace, "deliverables/d6"), { recursive: true });
  await fs.writeFile(path.join(workspace, "deliverables/d6/clinical-evidence-report.md"), REPORT);
  await fs.writeFile(path.join(workspace, "deliverables/d6/clinical-evidence-matrix.json"), JSON.stringify(MATRIX));
  const overclaim = { location: "结论", kind: "overclaim", evidence: "该结论适用于所有成人。", fix: "限定为试验人群。" };
  const { review } = service({ modelAnswers: [
    { findings: [overclaim, { location: "标题", kind: "wording", evidence: "二甲双胍与 HbA1c", fix: "写明比较。" }], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] },
    { findings: [overclaim, { location: "结论", kind: "contradiction", evidence: "二甲双胍使 HbA1c 较安慰剂降低 1.5%", fix: "按来源改为 0.9 个百分点。" }], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] },
  ] });
  const identity = { userId, projectId };
  const input = { runId: "native_stable_ids", sessionId: "s-ids", deliverableId: "d6", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  const first = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 1 })).reviewId);
  assert.deepEqual(first.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind]), [["F01", "reference_unresolvable"], ["F02", "overclaim"], ["F03", "wording"]]);

  await fs.writeFile(path.join(workspace, "deliverables/d6/clinical-evidence-report.md"), REPORT.replace("该结论适用于所有成人。", "该结论适用于所有成人。\n补充一句。"));
  const second = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 2 })).reviewId);
  assert.equal(second.pass, 2);
  assert.deepEqual(second.findings.map((/** @type {any} */ finding) => [finding.id, finding.kind]),
    [["F01", "reference_unresolvable"], ["F04", "contradiction"], ["F02", "overclaim"]],
    "the same two findings keep F01 and F02; the new contradiction is F04, never a reused F03; the contradiction is still read before the overclaim");
  // An answer written against the first pass's id reaches the finding it meant.
  const answered = await review.recordResponses(identity, { reviewId: second.reviewId, answers: [{ id: "F02", response: "fixed" }, { id: "F03", response: "fixed" }] });
  assert.deepEqual([answered?.recorded, answered?.refused.map((/** @type {any} */ entry) => entry.id)], [1, ["F03"]], "F03 is gone from the report, so it is not this review's to answer");
});

test("the revision notes are the writer's backstage file: never read as the package, never reviewed", options, async () => {
  // 2026-09-25 geo-content: a finding about the notes' own list forced a
  // third submission.
  await fs.mkdir(path.join(workspace, "deliverables/d7"), { recursive: true });
  await fs.writeFile(path.join(workspace, "deliverables/d7/clinical-evidence-report.md"), REPORT);
  await fs.writeFile(path.join(workspace, "deliverables/d7/clinical-evidence-matrix.json"), JSON.stringify(MATRIX));
  await fs.writeFile(path.join(workspace, "deliverables/d7/revision-notes.md"), "# 修改说明\n\n第一轮把全部 17 条阻断码逐条对照了一遍。\n");
  const { review, prompts } = service({
    outputs: [{ path: "clinical-evidence-report.md" }, { path: "clinical-evidence-matrix.json" }, { path: "revision-notes.md" }],
    modelAnswers: [{ findings: [{ location: "修改说明", kind: "structure", evidence: "第一轮把全部 17 条阻断码逐条对照了一遍。", fix: "删去。" }], checklist: [{ item: "E2", status: "absent", evidence: "" }], acceptance: [] }],
  });
  const identity = { userId, projectId };
  const input = { runId: "native_notes", sessionId: "s-notes", deliverableId: "d7", contractKind: "clinical-evidence-report", capability: "clinical-evidence-synthesis" };
  const first = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 1 })).reviewId);
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0].messages[1].content, /阻断码/, "the editor is not shown the notes");
  assert.match(prompts[0].messages[1].content, /该结论适用于所有成人/, "it is shown the report");
  assert.equal(first.findings.some((/** @type {any} */ finding) => finding.kind === "structure"), false, "a finding resting on the notes' words is not located in the package");

  // Editing only the notes is not a new package: no editor pass is spent on it.
  await fs.appendFile(path.join(workspace, "deliverables/d7/revision-notes.md"), "第二轮：回应了审查。\n");
  const second = await settled(review, /** @type {any} */ (await review.startDeliverableReview(identity, { ...input, attempt: 2 })).reviewId);
  assert.equal(second.editor, "unchanged");
  assert.equal(prompts.length, 1);
});

test("a docker runtime's own root is not where this process reads: the package comes from the host copy", options, async () => {
  // The first live review (2026-09-23) read nothing: under docker the delivery
  // root is `/workspace`, the path inside the runtime container.
  const synced = [];
  const runtimeManager = { workspaceRootForDelivery: async (/** @type {any} */ project) => { synced.push(project.id); return "/workspace"; } };
  const { review, prompts } = service({ modelAnswers: [QUIET], runtimeManager });
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
