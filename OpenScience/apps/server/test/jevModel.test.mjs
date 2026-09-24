// TypeSafe's Jev as the control plane calls it (jevModel.mjs): the request as
// the wire takes it, the answer priced in dollars and booked in yuan, every
// failure named, the reservation closed the way the call ended, one retry for
// what is transient, and the key in nothing but the Authorization header.
import assert from "node:assert/strict";
import test from "node:test";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";
import { JevError, callJev, estimateJevTokens } from "../src/jevModel.mjs";
import { providerRefusalCount } from "../src/providerRefusals.mjs";

const KEY = "apikey_test-typesafe-key-0123456789";
const config = {
  typesafeApiKey: KEY,
  reviewJevModel: "jev-1.13.0",
  reviewJevApiBase: "https://api.typesafe.example/v1",
  reviewJevTimeoutMs: 5_000,
  reviewJevMaxRequestTokens: 64_000,
  reviewJevMaxStateTokens: 32_000,
  userDailySpendLimit: 0,
  userWeeklySpendLimit: 0,
};

const call = {
  userId: "u1", projectId: "p1", runId: "run_1", purpose: "review",
  state: { items: { S0: { sentence: "心电图是胸痛评估的最佳初始检查 [1]。", sources: { "[1]": "The electrocardiogram remains the best initial test for chest pain evaluation." } } } },
  questions: { S0: { type: "choice", instructions: "How do the passages in `items.S0.sources` relate to the sentence `items.S0.sentence`?", criteria: { supports: "a", contradicts: "b", says_nothing: "c" } } },
};

/** The body the live wire returned (recorded shape, 2026-09-21). */
const ANSWER = {
  model: "jev-1.13.0",
  answers: { S0: { type: "choice", choice: "supports", confidence: 1, probabilities: { contradicts: 0, supports: 1, says_nothing: 0 } } },
  usage: { input_tokens: 484, output_tokens: 77 },
};

function fakeLedger() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    async reserveModel(/** @type {any} */ input) { calls.push(["reserve", input]); return { id: input.id }; },
    async settleModel(/** @type {string} */ _userId, /** @type {string} */ id, /** @type {any} */ input) { calls.push(["settle", id, input]); },
    async markUncertain(/** @type {string} */ _userId, /** @type {string} */ id, /** @type {string} */ code) { calls.push(["uncertain", id, code]); },
    async release(/** @type {string} */ _userId, /** @type {string} */ id, /** @type {string} */ code) { calls.push(["release", id, code]); },
  };
}

/** @param {...(Response | Error | (() => Promise<Response>))} answers */
function wire(...answers) {
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  const queue = [...answers];
  /** @type {any} */
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next ?? Response.json(ANSWER);
  };
  return { sent, fetchImpl };
}

/** @param {string} code */
function networkFailure(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

test("a question goes to /systemone with the pinned model, and its answer is booked in yuan on the provider's own count", async () => {
  const ledger = fakeLedger();
  const { sent, fetchImpl } = wire(Response.json(ANSWER));
  const result = await callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.typesafe.example/v1/systemone");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(sent[0].init.body), { model: "jev-1.13.0", state: call.state, questions: call.questions });
  assert.deepEqual(result.answers, ANSWER.answers);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.usage, { inputTokens: 484, outputTokens: 77 });
  // $0.042 per million input tokens at the list's own USD rate; output free.
  const usd = /** @type {any} */ (REFERENCE_PRICE_LIST).exchangeRates.USD.rate;
  assert.equal(result.cost, Math.round(484 / 1_000_000 * 0.042 * usd * 100_000_000) / 100_000_000);
  assert.equal(result.priced, true);
  const [reserve, settle] = ledger.calls;
  assert.equal(reserve[0], "reserve");
  assert.equal(reserve[1].purpose, "review");
  assert.equal(reserve[1].model, "jev-1.13.0");
  assert.equal(reserve[1].runId, "run_1");
  assert.equal(reserve[1].currency, "CNY");
  assert.equal(reserve[1].priceVersion, REFERENCE_PRICE_LIST.version);
  assert.ok(reserve[1].estimatedCost > 0, "the reservation is priced: the list knows the pinned model");
  assert.match(reserve[1].requestFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(settle, ["settle", reserve[1].id, {
    usage: { cacheHitTokens: 0, cacheMissTokens: 484, completionTokens: 77 }, actualCost: result.cost, priced: true, providerRequestId: null,
  }]);
  assert.equal(ledger.calls.length, 2);
});

test("every refusal is named, released under its status, and never retried", async () => {
  const cases = [
    // Recorded 2026-09-21/24: a refused key is 403, a malformed request 400 naming no field.
    [Response.json({ detail: { error_type: "authentication_error", message: "Invalid API key." } }, { status: 403 }), "jev_auth_failed", 403],
    [Response.json({ detail: { error_type: "api_usage_error", message: "Invalid request." } }, { status: 400 }), "jev_request_invalid", 400],
    [Response.json({ detail: { error_type: "api_usage_error", message: "Unknown model: jev-1.13.0" } }, { status: 400 }), "jev_model_unknown", 400],
    [Response.json({ detail: "Unauthorized" }, { status: 401 }), "jev_auth_failed", 401],
    [Response.json({ detail: "Payment required" }, { status: 402 }), "jev_payment_required", 402],
    [Response.json({ detail: "Too large" }, { status: 413 }), "jev_request_too_large", 413],
    [Response.json({ detail: [{ loc: ["body"] }] }, { status: 422 }), "jev_request_invalid", 422],
  ];
  for (const [response, code, status] of cases) {
    const ledger = fakeLedger();
    const { sent, fetchImpl } = wire(/** @type {Response} */ (response), Response.json(ANSWER));
    await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call),
      (error) => error instanceof JevError && error.code === code && error.status === status, String(code));
    assert.equal(sent.length, 1, `${code}: a refusal would be refused again`);
    assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "release"], String(code));
    assert.equal(ledger.calls[1][2], `provider_refused_${status}`, "a refusal before any output was not billed");
  }
});

test("spent TypeSafe credit is named, counted where the balance alert reads, and released", async () => {
  const before = providerRefusalCount("typesafe", 402);
  const ledger = fakeLedger();
  const { sent, fetchImpl } = wire(Response.json({ detail: "Payment required" }, { status: 402 }));
  await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_payment_required");
  assert.equal(sent.length, 1);
  assert.deepEqual(ledger.calls.map((entry) => [entry[0], entry[2]]).slice(1), [["release", "provider_refused_402"]]);
  assert.equal(providerRefusalCount("typesafe", 402), before + 1);
});

test("a rate limit is retried once after the pause, and each attempt is its own ledger row", async () => {
  const limited = () => Response.json({ detail: "Too many requests" }, { status: 429 });
  const ledger = fakeLedger();
  const { sent, fetchImpl } = wire(limited(), Response.json(ANSWER));
  const result = await callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call);
  assert.equal(result.attempts, 2);
  assert.equal(sent.length, 2);
  assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "release", "reserve", "settle"]);
  assert.equal(ledger.calls[1][2], "provider_refused_429");

  const twice = fakeLedger();
  const again = wire(limited(), limited(), Response.json(ANSWER));
  await assert.rejects(callJev({ config, usageLedger: twice, fetchImpl: again.fetchImpl, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_rate_limited");
  assert.equal(again.sent.length, 2, "one retry, not a loop");
});

test("a 5xx after dispatch is uncertain and retried once; a request that never left is released", async () => {
  for (const status of [500, 503, 529]) {
    const ledger = fakeLedger();
    const { sent, fetchImpl } = wire(new Response("overloaded", { status }), new Response("overloaded", { status }));
    await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call),
      (error) => error instanceof JevError && error.code === "jev_upstream_error" && error.status === status);
    assert.equal(sent.length, 2, `${status} is transient: retried once`);
    assert.deepEqual(ledger.calls.map((entry) => [entry[0], entry[2]]).filter(([kind]) => kind !== "reserve"),
      [["uncertain", "provider_response_incomplete"], ["uncertain", "provider_response_incomplete"]], String(status));
  }
  // Refused at the socket: nothing was sent, nothing can have been billed.
  const refused = fakeLedger();
  const nowhere = wire(networkFailure("ECONNREFUSED"), networkFailure("ENOTFOUND"));
  await assert.rejects(callJev({ config, usageLedger: refused, fetchImpl: nowhere.fetchImpl, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_unreachable" && /ENOTFOUND/.test(error.message));
  assert.deepEqual(refused.calls.filter((entry) => entry[0] !== "reserve").map((entry) => entry[2]), ["provider_not_accepted", "provider_not_accepted"]);
  // Reset after the request left: it may have been answered and billed.
  const reset = fakeLedger();
  const dropped = wire(networkFailure("ECONNRESET"), Response.json(ANSWER));
  const result = await callJev({ config, usageLedger: reset, fetchImpl: dropped.fetchImpl, retryDelayMs: 0 }, call);
  assert.equal(result.attempts, 2);
  assert.deepEqual(reset.calls.map((entry) => entry[0]), ["reserve", "uncertain", "reserve", "settle"]);
});

test("a call that outlives its timeout is stopped, named, not retried, and uncertain", async () => {
  const ledger = fakeLedger();
  let calls = 0;
  /** @type {any} */
  const hanging = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  await assert.rejects(callJev({ config: { ...config, reviewJevTimeoutMs: 1_000 }, usageLedger: ledger, fetchImpl: hanging, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_timeout");
  assert.equal(calls, 1, "a timeout would time out again");
  assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "uncertain"]);
});

test("an answer from another version than the pin is booked and not used", async () => {
  const ledger = fakeLedger();
  const { sent, fetchImpl } = wire(Response.json({ ...ANSWER, model: "jev-1.14.0" }));
  await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_model_mismatch");
  assert.equal(sent.length, 1);
  assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "settle"], "the provider billed it whatever it said");
  // An answer with no usage and no answers is neither settled nor used.
  const missing = fakeLedger();
  const empty = wire(Response.json({ model: "jev-1.13.0" }));
  await assert.rejects(callJev({ config, usageLedger: missing, fetchImpl: empty.fetchImpl, retryDelayMs: 0 }, call),
    (error) => error instanceof JevError && error.code === "jev_response_invalid");
  assert.deepEqual(missing.calls.map((entry) => [entry[0], entry[2]]).slice(1), [["uncertain", "response_usage_missing"]]);
});

test("nothing is reserved or sent without a key, a pin, or room in Jev's two ceilings", async () => {
  const ledger = fakeLedger();
  const { sent, fetchImpl } = wire();
  await assert.rejects(callJev({ config: { ...config, typesafeApiKey: "" }, usageLedger: ledger, fetchImpl }, call),
    (error) => error instanceof JevError && error.code === "jev_unconfigured");
  await assert.rejects(callJev({ config: { ...config, reviewJevModel: "" }, usageLedger: ledger, fetchImpl }, call),
    (error) => error instanceof JevError && error.code === "jev_unconfigured");
  // 32k tokens is the state plus its longest question; 40k CJK characters is past it.
  const big = { ...call, state: { items: { S0: { sentence: "x", sources: { "[1]": "心".repeat(40_000) } } } } };
  assert.ok(estimateJevTokens(big.state, big.questions).stateAndLongestQuestion > 32_000);
  await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl }, big),
    (error) => error instanceof JevError && error.code === "jev_request_too_large");
  // And 64k is the whole request: many small questions over a modest state.
  const many = { ...call, questions: Object.fromEntries(Array.from({ length: 400 }, (_value, index) => [`S${index}`, { ...call.questions.S0, instructions: "说明".repeat(100) }])) };
  const size = estimateJevTokens(many.state, many.questions);
  assert.ok(size.total > 64_000 && size.stateAndLongestQuestion < 32_000);
  await assert.rejects(callJev({ config, usageLedger: ledger, fetchImpl }, many),
    (error) => error instanceof JevError && error.code === "jev_request_too_large");
  assert.equal(sent.length, 0);
  assert.equal(ledger.calls.length, 0);
});

test("the key reaches the Authorization header and nothing else", async () => {
  const echoing = [
    Response.json({ detail: { error_type: "authentication_error", message: `Invalid API key ${KEY}` } }, { status: 403 }),
    Response.json({ detail: { error_type: "api_usage_error", message: `Invalid request. ${KEY}` } }, { status: 400 }),
    new Response(`upstream said ${KEY}`, { status: 502 }),
  ];
  for (const response of echoing) {
    const { fetchImpl } = wire(response, new Response(`upstream said ${KEY}`, { status: 502 }));
    const error = await callJev({ config, fetchImpl, retryDelayMs: 0 }, call).catch((failure) => failure);
    assert.ok(error instanceof JevError);
    const everything = JSON.stringify({ message: error.message, code: error.code, stack: error.stack, ...error });
    assert.equal(everything.includes(KEY), false, `${error.code} carries the key`);
    assert.equal(everything.includes("apikey_"), false);
  }
});
