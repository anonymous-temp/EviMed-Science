// The reviewer's model call: the stream read, the usage priced, the ledger
// settled, and every failure named (reviewModel.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { callReviewModel, ReviewModelError } from "../src/reviewModel.mjs";

const config = {
  dashscopeApiKey: "test-dashscope-key",
  reviewModel: "qwen3.8-max-0902",
  reviewApiBase: "https://dashscope.example/compatible-mode/v1",
  reviewEditorTimeoutMs: 5_000,
  reviewMaxOutputTokens: 1_000,
  userDailySpendLimit: 0,
  userWeeklySpendLimit: 0,
};

/** An SSE response the way DashScope streams one (recorded shape, 2026-09-23). @param {string[]} contents @param {any} usage */
function streamed(contents, usage) {
  const events = [
    ...contents.map((content, index) => ({ id: "chatcmpl-test", model: "qwen3.8-max-0902", object: "chat.completion.chunk", choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content, reasoning_content: "思考。" } : { content } }] })),
    { id: "chatcmpl-test", model: "qwen3.8-max-0902", object: "chat.completion.chunk", choices: [], usage },
  ];
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(new ReadableStream({
    start(controller) {
      // Cut mid-line on purpose: a reader that assumes one event per chunk loses the answer.
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeLedger() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    async reserveModel(/** @type {any} */ input) { calls.push(["reserve", input]); return { id: input.id }; },
    async settleModel(/** @type {string} */ userId, /** @type {string} */ id, /** @type {any} */ input) { calls.push(["settle", id, input]); },
    async markUncertain(/** @type {string} */ userId, /** @type {string} */ id, /** @type {string} */ code) { calls.push(["uncertain", id, code]); },
    async release(/** @type {string} */ userId, /** @type {string} */ id, /** @type {string} */ code) { calls.push(["release", id, code]); },
  };
}

const call = {
  userId: "u1", projectId: "p1", runId: "run_1",
  messages: [{ role: /** @type {const} */ ("user"), content: "审阅" }],
  schema: { type: "object", properties: { findings: { type: "array" } } }, schemaName: "review_findings",
  thinking: { enabled: true, budget: 800 },
};

test("a streamed answer is read whole, priced at DashScope's rate and settled on the provider's own count", async () => {
  /** @type {any} */
  let sent = null;
  const ledger = fakeLedger();
  const result = await callReviewModel({
    config, usageLedger: ledger,
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { sent = { url, init }; return streamed(['{"findings":', "[]}"], { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 300 } }); }),
  }, call);
  assert.deepEqual(result.value, { findings: [] });
  assert.equal(result.model, "qwen3.8-max-0902");
  assert.deepEqual(result.usage, { cacheHitTokens: 400, cacheMissTokens: 600, completionTokens: 500, reasoningTokens: 300 });
  // ¥1.5/M cached + ¥12/M input + ¥36/M output, no night rate.
  assert.equal(result.cost, (400 * 1.5 + 600 * 12 + 500 * 36) / 1_000_000);
  assert.equal(sent.url, "https://dashscope.example/compatible-mode/v1/chat/completions");
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, "qwen3.8-max-0902");
  assert.equal(body.stream, true);
  assert.equal(body.enable_thinking, true);
  assert.equal(body.thinking_budget, 800);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(sent.init.headers.authorization, "Bearer test-dashscope-key");
  assert.equal(ledger.calls[0][0], "reserve");
  assert.equal(ledger.calls[0][1].purpose, "review");
  assert.equal(ledger.calls[0][1].runId, "run_1");
  assert.deepEqual(ledger.calls[1].slice(0, 1), ["settle"]);
  assert.equal(ledger.calls[1][2].priced, true);
  assert.equal(ledger.calls.length, 2);
});

test("thinking off is said, not assumed: the provider thinks unless told not to", async () => {
  /** @type {any} */
  let body = null;
  await callReviewModel({ config, fetchImpl: /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => { body = JSON.parse(init.body); return streamed(["{}"], { prompt_tokens: 1, completion_tokens: 1 }); }) },
    { ...call, thinking: { enabled: false } });
  assert.equal(body.enable_thinking, false);
  assert.equal("thinking_budget" in body, false);
});

test("every failure is a named code, and the reservation is closed the way the call ended", async () => {
  /** @param {number} status @param {any} payload */
  const answering = (status, payload) => /** @type {any} */ (async () => new Response(JSON.stringify(payload), { status }));
  const cases = [
    [answering(404, { error: { code: "model_not_found", message: "The model does not exist" } }), "review_model_unavailable"],
    [answering(401, { error: { code: "invalid_api_key" } }), "review_model_auth_failed"],
    [answering(429, { error: { code: "Throttling" } }), "review_model_rate_limited"],
    [answering(400, { error: { code: "invalid_parameter" } }), "review_model_request_invalid"],
    [answering(503, {}), "review_model_upstream_error"],
    [/** @type {any} */ (async () => { throw new TypeError("fetch failed"); }), "review_model_unreachable"],
    [/** @type {any} */ (async () => streamed(["not json"], { prompt_tokens: 1, completion_tokens: 1 })), "review_model_response_invalid"],
  ];
  for (const [fetchImpl, code] of cases) {
    const ledger = fakeLedger();
    await assert.rejects(callReviewModel({ config, usageLedger: ledger, fetchImpl }, call), (error) => error instanceof ReviewModelError && error.code === code, String(code));
    const last = ledger.calls.at(-1);
    if (code === "review_model_unreachable") assert.equal(last[0], "release", "never dispatched is released");
    else if (code === "review_model_response_invalid") assert.equal(last[0], "settle", "a bad answer was still billed");
    else assert.equal(last[0], "uncertain", `${code}: dispatched and answered without usage is uncertain`);
  }
});

test("no key is refused before anything is reserved or sent", async () => {
  const ledger = fakeLedger();
  await assert.rejects(callReviewModel({ config: { ...config, dashscopeApiKey: "" }, usageLedger: ledger, fetchImpl: /** @type {any} */ (async () => { throw new Error("must not be called"); }) }, call),
    (error) => error instanceof ReviewModelError && error.code === "review_model_unconfigured");
  assert.equal(ledger.calls.length, 0);
});

test("a call that outlives its timeout is stopped and named", async () => {
  const hanging = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(callReviewModel({ config, fetchImpl: hanging }, { ...call, timeoutMs: 1_000 }),
    (error) => error instanceof ReviewModelError && error.code === "review_model_timeout");
});
