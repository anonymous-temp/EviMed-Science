// The reviewer's model call: the stream read, the usage priced, the ledger
// settled, and every failure named (reviewModel.mjs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { providerRefusalCount } from "../src/providerRefusals.mjs";
import { callReviewModel, ReviewModelError } from "../src/reviewModel.mjs";
import { ReviewService } from "../src/reviewService.mjs";

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
function streamed(contents, usage, finish = "stop", model = "qwen3.8-max-0902") {
  const events = [
    ...contents.map((content, index) => ({ id: "chatcmpl-test", model: "qwen3.8-max-0902", object: "chat.completion.chunk", choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content, reasoning_content: "思考。" } : { content } }] })),
    { id: "chatcmpl-test", model: "qwen3.8-max-0902", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { id: "chatcmpl-test", model: "qwen3.8-max-0902", object: "chat.completion.chunk", choices: [], usage },
  ];
  const text = `${events.map((event) => `data: ${JSON.stringify({ ...event, model })}\n\n`).join("")}data: [DONE]\n\n`;
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

test("DeepSeek review uses its own credential, JSON mode, thinking controls and cached-token accounting", async () => {
  const configured = new ReviewService({ config: { ...config, reviewProvider: "deepseek", deepseekApiKey: "test-key", dashscopeApiKey: "" }, database: null, store: null });
  assert.equal(configured.configured, true);
  const missing = new ReviewService({ config: { ...config, reviewProvider: "deepseek" }, database: null, store: null });
  assert.equal(missing.configured, false);
  for (const enabled of [true, false]) {
    const ledger = fakeLedger();
    const result = await callReviewModel({
      config: { ...config, reviewProvider: "deepseek", deepseekApiKey: "test-deepseek-key", reviewApiBase: "https://api.deepseek.com", reviewModel: "deepseek-v4-pro" },
      usageLedger: ledger,
      fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
        assert.equal(url, "https://api.deepseek.com/chat/completions");
        assert.equal(init.headers.authorization, "Bearer test-deepseek-key");
        const body = JSON.parse(init.body);
        assert.deepEqual(body.response_format, { type: "json_object" });
        assert.equal(body.thinking.type, enabled ? "enabled" : "disabled");
        assert.equal(body.reasoning_effort, enabled ? "high" : undefined);
        assert.equal("enable_thinking" in body, false);
        assert.equal("thinking_budget" in body, false);
        assert.ok(body.messages[0].content.includes(JSON.stringify(call.schema)));
        return streamed(['{"findings":[]}'], { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }, "stop", "deepseek-v4-pro");
      }),
    }, { ...call, thinking: { enabled } });
    assert.deepEqual(result.value, { findings: [] });
    assert.deepEqual(result.usage, { cacheHitTokens: 40, cacheMissTokens: 60, completionTokens: 10, reasoningTokens: 0 });
    assert.equal(ledger.calls[1][2].priced, true);
  }
  await assert.rejects(callReviewModel({ config: { ...config, reviewProvider: "deepseek" } }, call),
    (error) => error instanceof ReviewModelError && error.code === "review_model_unconfigured");
});

test("DeepSeek HTTP streaming bills its reported counts, releases refusals and keeps missing usage uncertain", async (t) => {
  const requests = [];
  let status = 200;
  let usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 47, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 6 } };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(text) });
    res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
    res.end(status === 200 ? await streamed(['{"findings":[]}'], usage, "stop", "deepseek-v4-pro").text() : '{"error":{"code":"invalid_api_key"}}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const settings = { ...config, reviewProvider: "deepseek", reviewModel: "deepseek-v4-pro", deepseekApiKey: "test-deepseek-key", reviewApiBase: `http://127.0.0.1:${server.address().port}` };
  const ledger = fakeLedger();
  const result = await callReviewModel({ config: settings, usageLedger: ledger }, call);
  assert.deepEqual(result.usage, { cacheHitTokens: 40, cacheMissTokens: 47, completionTokens: 10, reasoningTokens: 6 });
  assert.equal(requests[0].path, "/chat/completions");
  assert.equal(requests[0].authorization, "Bearer test-deepseek-key");
  assert.equal(requests[0].body.stream_options.include_usage, true);
  assert.equal(ledger.calls[0][1].purpose, "review");
  assert.equal(ledger.calls[0][1].runId, "run_1");
  assert.equal(ledger.calls[1][2].providerRequestId, "chatcmpl-test");
  assert.equal(ledger.calls[1][2].usage.completionTokens, 10, "reasoning is already included in provider completion tokens");
  assert.equal(ledger.calls[1][2].actualCost, result.cost);
  assert.equal(ledger.calls[1][2].priced, true);

  status = 401;
  const before = providerRefusalCount("deepseek", 401);
  const refused = fakeLedger();
  await assert.rejects(callReviewModel({ config: settings, usageLedger: refused }, call), { code: "review_model_auth_failed" });
  assert.deepEqual(refused.calls.map(entry => entry[0]), ["reserve", "release"]);
  assert.equal(refused.calls[1][2], "provider_refused_401");
  assert.equal(providerRefusalCount("deepseek", 401), before + 1);

  for (const [code, transition] of [[402, "release"], [503, "uncertain"]]) {
    status = code;
    const failed = fakeLedger();
    await assert.rejects(callReviewModel({ config: settings, usageLedger: failed }, call), {
      code: code === 402 ? "review_model_payment_required" : "review_model_upstream_error",
    });
    assert.deepEqual(failed.calls.map(entry => entry[0]), ["reserve", transition]);
    assert.equal(failed.calls[1][2], code === 402 ? "provider_refused_402" : "provider_response_incomplete");
  }

  status = 200;
  usage = { ...usage, completion_tokens: null };
  const missing = fakeLedger();
  await callReviewModel({ config: settings, usageLedger: missing }, call);
  assert.deepEqual(missing.calls.map(entry => entry[0]), ["reserve", "uncertain"]);
  assert.equal(missing.calls[1][2], "response_usage_missing");
});

test("unsupported DeepSeek models and foreign production endpoints fail before reservation or credentials leave", async () => {
  for (const override of [{ reviewModel: "unknown" }, { production: true, reviewApiBase: "https://dashscope.example" }]) {
    const ledger = fakeLedger();
    await assert.rejects(callReviewModel({
      config: { ...config, reviewProvider: "deepseek", reviewModel: "deepseek-v4-pro", deepseekApiKey: "test-key", reviewApiBase: "https://api.deepseek.com", ...override },
      usageLedger: ledger,
      fetchImpl: async () => { assert.fail("configuration failure must precede dispatch"); },
    }, call), error => ["review_model_unconfigured", "model_gateway_configuration_invalid"].includes(error.code));
    assert.equal(ledger.calls.length, 0);
  }
});

test("a real DeepSeek request accepted before headers stays uncertain when its deadline expires", async (t) => {
  let accepted = false;
  const server = createServer(async (req) => {
    for await (const _chunk of req) { /* Consume the actual dispatched request. */ }
    accepted = true;
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const ledger = fakeLedger();
  await assert.rejects(callReviewModel({
    config: { ...config, reviewProvider: "deepseek", reviewModel: "deepseek-v4-pro", deepseekApiKey: "test-key", reviewApiBase: `http://127.0.0.1:${server.address().port}` },
    usageLedger: ledger,
  }, { ...call, timeoutMs: 1000 }), { code: "review_model_timeout" });
  assert.equal(accepted, true, "the provider really received the whole POST before the timeout");
  assert.deepEqual(ledger.calls.map(entry => entry[0]), ["reserve", "uncertain"]);
  assert.equal(ledger.calls[1][2], "provider_response_incomplete");
});

test("DeepSeek's terminal SSE event settles actual usage without waiting for HTTP EOF", async (t) => {
  const server = createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(await streamed(['{"findings":[]}'], { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5 }, "stop", "deepseek-v4-pro").text());
    // Keep the response open: the protocol's final event already ended the generation.
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const ledger = fakeLedger();
  const result = await callReviewModel({
    config: { ...config, reviewProvider: "deepseek", reviewModel: "deepseek-v4-pro", deepseekApiKey: "test-key", reviewApiBase: `http://127.0.0.1:${server.address().port}` },
    usageLedger: ledger,
  }, { ...call, timeoutMs: 1000 });
  assert.deepEqual(result.value, { findings: [] });
  assert.deepEqual(ledger.calls.map(entry => entry[0]), ["reserve", "settle"]);
  assert.equal(ledger.calls[1][2].usage.completionTokens, 5);
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
    [/** @type {any} */ (async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }), "review_model_unreachable"],
    [/** @type {any} */ (async () => streamed(["not json"], { prompt_tokens: 1, completion_tokens: 1 })), "review_model_response_invalid"],
    // Cut off at the ceiling mid-string: the ceiling is what to look at, not the model's JSON.
    [/** @type {any} */ (async () => streamed(['{"findings":[{"location":"CLM-0'], { prompt_tokens: 1, completion_tokens: 32_000 }, "length")), "review_model_truncated"],
  ];
  for (const [fetchImpl, code] of cases) {
    const ledger = fakeLedger();
    await assert.rejects(callReviewModel({ config, usageLedger: ledger, fetchImpl }, call), (error) => error instanceof ReviewModelError && error.code === code, String(code));
    const last = ledger.calls.at(-1);
    if (code === "review_model_unreachable") assert.deepEqual(last.slice(0, 1).concat(last[2]), ["release", "provider_not_accepted"], "never dispatched is released");
    else if (code === "review_model_response_invalid" || code === "review_model_truncated") assert.equal(last[0], "settle", "a bad answer was still billed");
    else if (code === "review_model_upstream_error") assert.deepEqual([last[0], last[2]], ["uncertain", "provider_response_incomplete"], "a 5xx after dispatch may have been worked on: uncertain");
    else assert.match(`${last[0]} ${last[2]}`, /^release provider_refused_(400|401|404|429)$/, `${code}: refused outright before any output is released, not billed`);
  }
});

test("a refusal is released under its status, and a 5xx stays uncertain (the 2026-09-23 balance outage)", async () => {
  // A spent balance answers 402 before any output. Booked `uncertain`, each
  // such call held its reserved ceiling as possibly spent; it was declined.
  for (const [status, expected] of [[402, ["release", "provider_refused_402"]], [403, ["release", "provider_refused_403"]],
    [409, ["release", "provider_refused_409"]], [413, ["release", "provider_refused_413"]], [422, ["release", "provider_refused_422"]],
    [500, ["uncertain", "provider_response_incomplete"]], [502, ["uncertain", "provider_response_incomplete"]], [408, ["uncertain", "provider_response_incomplete"]]]) {
    const ledger = fakeLedger();
    await assert.rejects(callReviewModel({ config, usageLedger: ledger, fetchImpl: /** @type {any} */ (async () => new Response("{}", { status: /** @type {number} */ (status) })) }, call),
      (error) => error instanceof ReviewModelError);
    assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", expected[0]], String(status));
    assert.equal(ledger.calls.at(-1)[2], expected[1], String(status));
  }
});

test("an exhausted DashScope account is named, counted as the 402 it means, and released", async () => {
  // DashScope answers an account in arrears 400 `Arrearage`, never 402
  // (help.aliyun.com/zh/model-studio/error-code); both read as the balance.
  const before = providerRefusalCount("dashscope", 402);
  for (const [status, payload, released] of [
    [400, { error: { message: "Access denied, please make sure your account is in good standing.", type: "Arrearage", param: null, code: "Arrearage" } }, "provider_refused_400"],
    [402, { error: { code: "PaymentRequired" } }, "provider_refused_402"],
  ]) {
    const ledger = fakeLedger();
    await assert.rejects(callReviewModel({ config, usageLedger: ledger, fetchImpl: /** @type {any} */ (async () => Response.json(payload, { status: /** @type {number} */ (status) })) }, call),
      (error) => error instanceof ReviewModelError && error.code === "review_model_payment_required", String(status));
    assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "release"], String(status));
    assert.equal(ledger.calls[1][2], released);
  }
  assert.equal(providerRefusalCount("dashscope", 402), before + 2, "both are counted where the balance alert reads");
  // Any other 400 is the request's fault, not the balance's.
  const other = providerRefusalCount("dashscope", 400);
  await assert.rejects(callReviewModel({ config, usageLedger: fakeLedger(), fetchImpl: /** @type {any} */ (async () => Response.json({ error: { code: "invalid_parameter" } }, { status: 400 })) }, call),
    (error) => error instanceof ReviewModelError && error.code === "review_model_request_invalid");
  assert.equal(providerRefusalCount("dashscope", 400), other + 1);
  assert.equal(providerRefusalCount("dashscope", 402), before + 2);
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

test("an uncertain reviewer call is booked at its prompt and the output that arrived, never its reservation's ceiling", async () => {
  // Audit I3-9 follow-up: the reviewer booked uncertain rows with no estimate,
  // so each held its full ceiling — the thinking budget and the answer at the
  // output rate — in the account's spend windows.
  const booked = () => {
    /** @type {any[]} */
    const calls = [];
    return {
      calls,
      async reserveModel(/** @type {any} */ input) { calls.push(["reserve", input.estimatedCost]); return { id: input.id }; },
      async settleModel() { calls.push(["settle"]); },
      async markUncertain(/** @type {string} */ _u, /** @type {string} */ _id, /** @type {string} */ code, /** @type {any} */ options = {}) { calls.push(["uncertain", code, options.estimatedCost ?? null]); },
      async release(/** @type {string} */ _u, /** @type {string} */ _id, /** @type {string} */ code) { calls.push(["release", code]); },
    };
  };
  const event = (/** @type {any} */ delta) => `data: ${JSON.stringify({ id: "chatcmpl-test", model: "qwen3.8-max-0902", choices: [{ index: 0, delta }] })}\n\n`;
  /** One chunk per read, then the connection drops (or closes). @param {string[]} chunks @param {boolean} fail */
  const stream = (chunks, fail) => {
    const queue = [...chunks];
    return new Response(new ReadableStream({
      pull(controller) {
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
        else if (fail) controller.error(new TypeError("terminated"));
        else controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const run = async (/** @type {any} */ fetchImpl, extra = {}) => {
    const ledger = booked();
    await callReviewModel({ config, usageLedger: ledger, fetchImpl }, { ...call, ...extra }).catch(() => null);
    return { reserved: ledger.calls[0][1], last: ledger.calls.at(-1) };
  };

  // A 5xx before any output: the prompt, nothing more.
  const refused = await run(async () => new Response("{}", { status: 503 }));
  assert.equal(refused.last[0], "uncertain");
  const prompt = refused.last[2];
  assert.ok(prompt > 0 && prompt < refused.reserved, `the prompt (${prompt}) is below the ceiling (${refused.reserved})`);
  // Lost after three events of output (one of them reasoning): the prompt and three tokens at ¥36/M.
  const lost = await run(async () => stream([event({ reasoning_content: "想" }), event({ content: "{\"fi" }), event({ content: "ndings\"" })], true));
  assert.deepEqual(lost.last.slice(0, 2), ["uncertain", "provider_response_incomplete"]);
  assert.ok(Math.abs(lost.last[2] - (prompt + 3 * 36 / 1_000_000)) < 1e-9, `${lost.last[2]}`);
  // Finished without a usage count: the same bound, under its own code.
  const uncounted = await run(async () => stream([event({ content: "{\"findings\":[]}" }), "data: [DONE]\n\n"], false));
  assert.deepEqual(uncounted.last.slice(0, 2), ["uncertain", "response_usage_missing"]);
  assert.ok(Math.abs(uncounted.last[2] - (prompt + 36 / 1_000_000)) < 1e-9, `${uncounted.last[2]}`);
  // Answered and then cut before any output: the prompt alone.
  const silent = await run(async () => stream([], true));
  assert.deepEqual(silent.last, ["uncertain", "provider_response_incomplete", prompt]);
});
