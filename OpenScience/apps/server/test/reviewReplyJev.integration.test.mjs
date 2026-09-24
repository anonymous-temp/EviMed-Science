// The reply check with Jev first, against a real PostgreSQL and the real usage
// ledger (reviewService.mjs #checkReply → replyCheckJev.mjs → jevModel.mjs):
// Jev settles what it is sure of, the reviewer model sees only the rest, both
// calls are booked in yuan against the run, and a Jev refusal hands every
// sentence to the reviewer and is released, not held as possibly spent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { UsageLedger } from "../src/usageLedger.mjs";
import { migrateUsageLedger } from "../src/usagePersistence.mjs";
import { ReviewService, reviewMetricFamilies } from "../src/reviewService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const userId = `review_jev_user_${randomUUID()}`;
const projectId = "review-jev-project";
/** @type {any} */
let database;

const config = {
  reviewEnabled: true, reviewRepliesEnabled: true, reviewModel: "qwen3.8-max-0902", reviewApiBase: "https://dashscope.example/compatible-mode/v1",
  reviewReplyTimeoutMs: 10_000, reviewReplyConcurrency: 2, dashscopeApiKey: "test-dashscope-key", userDailySpendLimit: 0, userWeeklySpendLimit: 0,
  typesafeApiKey: "apikey_test-typesafe", reviewJevEnabled: true, reviewJevModel: "jev-1.13.0", reviewJevApiBase: "https://api.typesafe.example/v1",
  reviewJevSupportConfidence: 0.8, reviewJevMaxRequestTokens: 64_000, reviewJevMaxStateTokens: 32_000, reviewJevTimeoutMs: 5_000,
};

/** Sources the registries hold, by the reference number the reply gives them. */
const SOURCES = new Map([
  [1, "Metformin versus placebo. Metformin lowered HbA1c by 0.9 percentage points compared with placebo over 24 weeks."],
  [2, "Electrocardiography in chest pain. The electrocardiogram remains the best initial test for chest pain evaluation."],
  [3, "High-sensitivity troponin. hs-cTn assays allow myocardial infarction to be ruled out within 1 to 2 hours."],
]);

const REPLY = [
  "二甲双胍可使 HbA1c 较安慰剂降低约 0.9 个百分点 [1]。",
  "心电图是胸痛评估的最佳初始检查 [2]。",
  "高敏肌钙蛋白检测需要 12 小时以上才能排除心肌梗死 [3]。",
  "",
  "参考文献：",
  "1. Smith J. Metformin versus placebo. PMID: 12345678",
  "2. ECG in chest pain. doi:10.1000/ecg",
  "3. High-sensitivity troponin. doi:10.1000/tn",
].join("\n");

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 6, databaseConnectionTimeoutMs: 2_000 });
  await database.migrate();
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Reviewer Jev test','development')", [userId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Review Jev',1048576)", [userId, projectId]);
  await migrateUsageLedger(database);
});

after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [userId]);
  await database.close();
});

/** A streamed answer from the reviewer model. @param {any} value */
function reviewerAnswer(value) {
  const events = [
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [{ index: 0, delta: { content: JSON.stringify(value) } }] },
    { id: "chatcmpl-x", model: "qwen3.8-max-0902", choices: [], usage: { prompt_tokens: 1_200, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 0 } } },
  ];
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A choice answer the way Jev writes one. @param {string} choice @param {number} p */
function choice(choice, p) {
  const rest = (1 - p) / 2;
  const probabilities = { supports: rest, contradicts: rest, says_nothing: rest, [choice]: p };
  return { type: "choice", choice, confidence: Math.round(((3 * p - 1) / 2) * 100) / 100, probabilities };
}

/** @param {(body: any) => Response} jev */
function service(jev) {
  /** @type {{ url: string, body: any }[]} */
  const sent = [];
  const review = new ReviewService({
    config, database, usageLedger: new UsageLedger(database), retryDelayMs: 0,
    store: { userById: async () => ({ id: userId }), requireProject: async () => ({ id: projectId, userId }) },
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body });
      if (url.endsWith("/systemone")) return jev(body);
      const escalated = [...body.messages[1].content.matchAll(/^S(\d+)/gm)].map((match) => Number(match[1]));
      return reviewerAnswer({ verdicts: escalated.map((index) => ({
        sentence: index, verdict: index === 2 ? "unsupported" : "supported", reason: "对照来源",
        evidence: index === 2 ? "ruled out within 1 to 2 hours" : index === 0 ? "lowered HbA1c by 0.9 percentage points" : "best initial test for chest pain evaluation",
        safety: index === 0 ? "consistent" : "none",
      })) });
    }),
    referenceResolver: {
      resolve: async () => ({ doi: new Map(), pmid: new Map() }),
      sourceTexts: async (/** @type {any[]} */ references) => new Map(references.map((reference) => [reference.number, SOURCES.get(reference.number) ?? ""])),
    },
  });
  return { review, sent };
}

/** @param {string} runId */
async function ledgerRows(runId) {
  const rows = await database.query(`SELECT model, purpose, status, currency, price_version, actual_cost, cache_miss_tokens, output_tokens, error_code
    FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=$2 ORDER BY created_at, id`, [userId, runId]);
  return rows.rows;
}

test("Jev settles the sentence it is sure of; the reviewer sees the medicine one and the one Jev contradicts, and both are booked", options, async () => {
  const { review, sent } = service((body) => Response.json({
    model: body.model,
    answers: { S1: choice("supports", 0.98), S2: choice("contradicts", 0.97) },
    usage: { input_tokens: 820, output_tokens: 90 },
  }));
  const identity = { userId, projectId };
  const runId = "run_reply_jev_1";
  assert.ok(await review.considerReply(identity, { id: runId, sessionId: "chat-jev" }, { replyText: REPLY, question: "二甲双胍降糖多少？", turnSeq: 5 }));
  assert.equal(await review.processReplyChecks("worker-jev"), 1);

  const jevRequests = sent.filter((request) => request.url.endsWith("/systemone"));
  assert.equal(jevRequests.length, 1, "one Jev request per reply");
  assert.equal(jevRequests[0].url, "https://api.typesafe.example/v1/systemone");
  assert.deepEqual(Object.keys(jevRequests[0].body.questions), ["S1", "S2"], "the medicine sentence is never put to Jev");
  const reviewer = sent.filter((request) => !request.url.endsWith("/systemone"));
  assert.equal(reviewer.length, 1);
  const message = reviewer[0].body.messages[1].content;
  assert.match(message, /S0（涉药） 引用 \[1\]/);
  assert.match(message, /S2 引用 \[3\]/);
  assert.doesNotMatch(message, /S1 /, "the sentence Jev settled is not asked again");

  const [check] = await review.replyChecksForSession(identity, "chat-jev");
  assert.equal(check.status, "done");
  assert.deepEqual(check.verdicts.map((/** @type {any} */ verdict) => [verdict.verdict, verdict.by ?? "reviewer"]),
    [["supported", "reviewer"], ["supported", "jev"], ["unsupported", "reviewer"]]);
  assert.equal(check.verdicts[1].evidence, "", "Jev quotes nothing");
  assert.equal(check.verdicts[2].warning, true);
  const stored = (await database.query("SELECT model, cost FROM evimed_review.reply_checks WHERE run_id=$1 AND user_id=$2", [runId, userId])).rows[0];
  assert.equal(stored.model, "jev-1.13.0+qwen3.8-max-0902");

  const rows = await ledgerRows(runId);
  assert.deepEqual(rows.map((row) => [row.model, row.purpose, row.status, row.currency, row.price_version]), [
    ["jev-1.13.0", "review", "settled", "CNY", REFERENCE_PRICE_LIST.version],
    ["qwen3.8-max-0902", "review", "settled", "CNY", REFERENCE_PRICE_LIST.version],
  ]);
  const usd = /** @type {any} */ (REFERENCE_PRICE_LIST).exchangeRates.USD.rate;
  assert.equal(Number(rows[0].actual_cost), Math.round(820 / 1_000_000 * 0.042 * usd * 100_000_000) / 100_000_000, "$0.042/M input at the list's rate; output free");
  assert.equal(Number(rows[0].cache_miss_tokens), 820);
  assert.ok(Math.abs(Number(stored.cost) - rows.reduce((sum, row) => sum + Number(row.actual_cost), 0)) < 1e-8, "the check's cost is both calls'");

  const stats = review.stats();
  assert.deepEqual(stats.jev.requests, { answered: 1, failed: 0, too_large: 0 });
  assert.deepEqual(stats.jev.sentences, { decided: 1, escalated: 1, medicine: 1, failed: 0, too_large: 0 });
  const families = reviewMetricFamilies(true, stats);
  assert.ok(families.some((family) => family.name === "open_science_review_jev_sentences_total"));
  assert.deepEqual((await review.readiness()).jev, { enabled: true, model: "jev-1.13.0" });
});

test("a Jev refusal hands every sentence to the reviewer and is released, not held as possibly spent", options, async () => {
  const { review, sent } = service(() => Response.json({ detail: { error_type: "api_usage_error", message: "Payment required." } }, { status: 402 }));
  const identity = { userId, projectId };
  const runId = "run_reply_jev_2";
  assert.ok(await review.considerReply(identity, { id: runId, sessionId: "chat-jev-2" }, { replyText: REPLY, turnSeq: 9 }));
  assert.equal(await review.processReplyChecks("worker-jev"), 1);
  assert.equal(sent.filter((request) => request.url.endsWith("/systemone")).length, 1, "a refusal is not retried");
  const message = sent.find((request) => !request.url.endsWith("/systemone"))?.body.messages[1].content ?? "";
  assert.match(message, /S0（涉药）/);
  assert.match(message, /S1 引用 \[2\]/);
  assert.match(message, /S2 引用 \[3\]/);
  const [check] = await review.replyChecksForSession(identity, "chat-jev-2");
  assert.equal(check.status, "done", "Jev failing is never the check failing");
  assert.equal(check.verdicts.every((/** @type {any} */ verdict) => verdict.by === undefined), true);
  const rows = await ledgerRows(runId);
  assert.deepEqual(rows.map((row) => [row.model, row.status, row.error_code]), [
    ["jev-1.13.0", "released", "provider_refused_402"],
    ["qwen3.8-max-0902", "settled", null],
  ]);
  assert.deepEqual(review.stats().jev.failures, { jev_payment_required: 1 });
  assert.equal((await review.readiness()).jev.warning, "jev_payment_required");
});
