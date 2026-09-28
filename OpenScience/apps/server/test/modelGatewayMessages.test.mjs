/**
 * The model gateway's Messages route: the only one DSH 0.1.7's DeepSeek
 * adapter speaks.
 *
 * 0.1.7 removed the adapter's chat-completions protocol ("Configuration accepts
 * Messages only and has no `protocol` field"). Given our `baseURL` it posts to
 * `<base>/messages` — the final `/v1` of `/internal/model/v1` is reused — with
 * the workload token in `x-api-key`, and before that tries the Files API for a
 * request's images. The event shapes below are the ones the kernel's adapter
 * parses and that a live 0.1.7-rc.2 kernel sent through this gateway on
 * 2026-09-28 (a scripted Messages upstream stood in for DeepSeek).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { createModelGatewayHandler, isModelGatewayPath, MODEL_GATEWAY_FILES_PREFIX, MODEL_GATEWAY_MESSAGES_PATH, MODEL_GATEWAY_PATH } from "../src/modelGateway.mjs";
import { createUsageTail, messagesUsage, parseMessagesReceipt } from "../src/usageMetering.mjs";

const signingSecret = "test-only-model-gateway-signing-secret-32-bytes";

/** @param {import("node:http").Server} server */
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
}

/** @param {string} baseUrl */
function config(baseUrl) {
  return {
    deepseekApiKey: "test-provider-key",
    deepseekBaseUrl: baseUrl,
    deepseekModel: "deepseek-flash",
    deepseekReasoningEffort: "high",
    modelGatewayMaxBodyBytes: 256 * 1024,
    modelGatewayMaxResponseBytes: 1024 * 1024,
    modelGatewayTimeoutMs: 2_000,
    modelGatewayReservationMaxOutputTokens: 4096,
    modelGatewaySigningSecret: signingSecret,
  };
}

const runtimeManager = {
  /** @param {string} token */
  assertActiveModelGatewayToken(token) {
    if (token !== "workload-token") throw new Error("unknown token");
    return { userId: "usage-owner", projectId: "default" };
  },
};

/** @param {any[]} events */
function ledger(events) {
  return {
    /** @param {any} input */
    async reserveModel(input) { events.push({ type: "reserve", input }); return { id: input.id }; },
    /** @param {string} userId @param {string} id @param {any} input */
    async settleModel(userId, id, input) { events.push({ type: "settle", id, input }); },
    /** @param {string} userId @param {string} id @param {string} code @param {any} input */
    async markUncertain(userId, id, code, input) { events.push({ type: "uncertain", code, input }); },
    /** @param {string} userId @param {string} id @param {string} code */
    async release(userId, id, code) { events.push({ type: "release", code }); },
  };
}

/** One Messages stream, as the kernel's adapter reads it. @param {string} text @param {number} [padding] */
function messagesStream(text, padding = 0) {
  /** @param {string} name @param {any} data */
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event("message_start", { type: "message_start", message: { id: "msg_provider_1", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, usage: { input_tokens: 120, cache_read_input_tokens: 880, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    // Enough deltas to push `message_start` out of any tail window.
    ...Array.from({ length: padding }, () => event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(64) } })),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 57 } }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

/**
 * @param {import("node:test").TestContext} t
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: any) => void} upstreamHandler
 * @param {any[]} events
 * @param {{ path?: string, headers?: Record<string, string>, body?: any }} request
 */
async function call(t, upstreamHandler, events, request) {
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    upstreamHandler(req, res, raw ? JSON.parse(raw) : null);
  });
  const upstreamBase = await listen(upstream);
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager, { usageLedger: ledger(events) }));
  const gatewayBase = await listen(gateway);
  t.after(() => new Promise((resolve) => { gateway.closeAllConnections(); gateway.close(resolve); }));
  return fetch(`${gatewayBase}${request.path ?? MODEL_GATEWAY_MESSAGES_PATH}`, {
    method: "POST",
    headers: { "x-api-key": "workload-token", "content-type": "application/json", "anthropic-version": "2023-06-01", ...(request.headers ?? {}) },
    body: JSON.stringify(request.body ?? {}),
  });
}

/** What the 0.1.7 adapter's `serialize` writes for a first request. */
function kernelRequest(overrides = {}) {
  return {
    model: "deepseek-flash",
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    max_tokens: 256000,
    thinking: { type: "enabled" },
    output_config: { effort: "high" },
    system: "You are an AI agent powered by DeepSeek Harness.",
    tools: [{ name: "evimed_plan", description: "plan", input_schema: { type: "object", properties: {} } }],
    ...overrides,
  };
}

test("the kernel's Messages request reaches DeepSeek's Messages API under the deployment's key, held to the certified model", async (t) => {
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let seen = null;
  const response = await call(t, (req, res, body) => {
    seen = { path: req.url, headers: req.headers, body };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(messagesStream("answer"));
  }, events, { body: kernelRequest({ model: "some-other-model", output_config: { effort: "max" }, thinking: { type: "disabled" } }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.equal(seen.path, "/anthropic/v1/messages");
  assert.equal(seen.headers["x-api-key"], "test-provider-key", "the provider sees the deployment's key, never the workload token");
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.body.model, "deepseek-flash", "the certified model, whatever the request named");
  assert.deepEqual(seen.body.thinking, { type: "enabled" });
  assert.deepEqual(seen.body.output_config, { effort: "high" });
  assert.equal(seen.body.system, "You are an AI agent powered by DeepSeek Harness.");
  assert.deepEqual(events.map((event) => event.type), ["reserve", "settle"]);
  assert.deepEqual(events[1].input.usage, { cacheHitTokens: 880, cacheMissTokens: 120, completionTokens: 57 });
  assert.equal(events[1].input.providerRequestId, "msg_provider_1");
});

test("the prompt counts are read from message_start even when a long answer pushed it out of the tail", async (t) => {
  /** @type {any[]} */
  const events = [];
  const response = await call(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(messagesStream("end", 600));
  }, events, { body: kernelRequest() });
  await response.text();
  assert.equal(events.at(-1).type, "settle", "a long answer is still settled exactly, not booked uncertain");
  assert.deepEqual(events.at(-1).input.usage, { cacheHitTokens: 880, cacheMissTokens: 120, completionTokens: 57 });
});

test("the session log and the plugin inventory are refused, not stripped", async (t) => {
  // 0.1.7's adapter adds provider-side extension fields to the same body, and
  // `dsh_session_log` defaulted ON: the whole session, uploaded with each call.
  for (const field of ["dsh_session_log", "dsh_plugin_packages"]) {
    /** @type {any[]} */
    const events = [];
    let dispatched = false;
    const response = await call(t, (_req, res) => { dispatched = true; res.end(); }, events, { body: kernelRequest({ [field]: { version: 1 } }) });
    assert.equal(response.status, 400, field);
    assert.equal((await response.json()).error.code, "model_gateway_field_invalid");
    assert.equal(dispatched, false, `${field} never reaches the provider`);
    assert.deepEqual(events, [], "and nothing is reserved for it");
  }
});

test("images travel inline: a provider-side file is refused, and so is the Files API", async (t) => {
  /** @type {any[]} */
  const events = [];
  const fileImage = kernelRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file-of-someone-else" } }] }] });
  const refused = await call(t, (_req, res) => res.end(), events, { body: fileImage });
  assert.equal(refused.status, 400);
  const upload = await call(t, (_req, res) => res.end(), events, { path: `${MODEL_GATEWAY_FILES_PREFIX}`, body: {} });
  assert.equal(upload.status, 404);
  assert.equal((await upload.json()).error.code, "model_gateway_files_unsupported");
  const inline = kernelRequest({ messages: [{ role: "user", content: [
    { type: "text", text: "见附图" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ] }] });
  const accepted = await call(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(messagesStream("ok")); }, events, { body: inline });
  assert.equal(accepted.status, 200);
  await accepted.text();
});

test("the Messages route authenticates the workload token from x-api-key, and a bearer header is not it", async (t) => {
  /** @type {any[]} */
  const events = [];
  const wrong = await call(t, (_req, res) => res.end(), events, { headers: { "x-api-key": "not-the-token" }, body: kernelRequest() });
  assert.equal(wrong.status, 401);
  const bearer = await call(t, (_req, res) => res.end(), events, { headers: { "x-api-key": "", authorization: "Bearer workload-token" }, body: kernelRequest() });
  assert.equal(bearer.status, 401);
  assert.deepEqual(events, []);
});

test("a tool round trip keeps its shape: results ride in a user message, and the newest person's words are the prompt", async (t) => {
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let body = null;
  const response = await call(t, (_req, res, received) => {
    body = received;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(messagesStream("done"));
  }, events, { body: kernelRequest({ messages: [
    { role: "user", content: [{ type: "text", text: "查看计划状态。" }] },
    { role: "assistant", content: [{ type: "text", text: "查看。" }, { type: "tool_use", id: "toolu_1", name: "evimed_plan", input: { action: "status" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }], is_error: false }] },
  ] }) });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[2].content[0].type, "tool_result");
});

test("both routes and the Files prefix are the gateway's, and nothing else under /internal/model is", () => {
  assert.ok(isModelGatewayPath(MODEL_GATEWAY_PATH));
  assert.ok(isModelGatewayPath(MODEL_GATEWAY_MESSAGES_PATH));
  assert.ok(isModelGatewayPath(`${MODEL_GATEWAY_FILES_PREFIX}/file-1/content`));
  assert.ok(!isModelGatewayPath("/internal/model/v1/filesystem"));
  assert.ok(!isModelGatewayPath("/internal/model/v1"));
});

test("Messages usage: a read from the cache is a hit, uncached input and cache writes are misses", () => {
  assert.deepEqual(messagesUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 }),
    { promptTokens: 105, completionTokens: 7, cacheHitTokens: 90, cacheMissTokens: 15 });
  assert.equal(messagesUsage({ output_tokens: 7 }), null, "no prompt count is no invoice");
  assert.equal(messagesUsage({ input_tokens: -1, output_tokens: 7 }), null);
  const receipt = parseMessagesReceipt(messagesStream("x"));
  assert.equal(receipt.id, "msg_provider_1");
  assert.deepEqual(receipt.usage, { promptTokens: 1000, completionTokens: 57, cacheHitTokens: 880, cacheMissTokens: 120 });
  // A 1 KiB window (the gateway keeps 16 KiB) against a ~6 KiB stream: the
  // opening event is only in the head, the closing ones only in the tail.
  const tail = createUsageTail(1024, { stream: true, protocol: "messages" });
  for (const chunk of messagesStream("y", 40).match(/[\s\S]{1,97}/g) ?? []) tail.observe(chunk);
  assert.equal(tail.finished(), true, "message_stop ends the stream the way [DONE] does");
  assert.deepEqual(tail.usage(), { promptTokens: 1000, completionTokens: 57, cacheHitTokens: 880, cacheMissTokens: 120 });
});
