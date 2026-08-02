import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  certifiedDeepSeekModel,
  createModelGatewayHandler,
  pipeModelGatewayBody,
  supportedDeepSeekModels,
} from "../src/modelGateway.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function config(baseUrl, overrides = {}) {
  return {
    deepseekApiKey: "server-only-test-secret",
    deepseekBaseUrl: baseUrl,
    deepseekModel: "deepseek-v4-pro",
    modelGatewayMaxBodyBytes: 32 * 1024,
    modelGatewayTimeoutMs: 1_000,
    modelGatewayMaxResponseBytes: 32 * 1024 * 1024,
    ...overrides,
  };
}

test("model gateway caps declared upstream response bodies without leaking provider data", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    const body = "provider-secret-body".repeat(128);
    res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
    res.end(body);
  });
  const upstreamBase = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase, {
    modelGatewayMaxResponseBytes: 1024,
  }), runtimeManager()));
  const gatewayBase = await listen(gateway);
  t.after(() => close(gateway));
  const response = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /model_gateway_response_too_large/);
  assert.doesNotMatch(text, /provider-secret-body|server-only-test-secret/);
});

test("model gateway backpressure exits immediately when the downstream closes", async () => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.write = () => false;
  response.end = () => { response.writableEnded = true; };
  response.destroy = () => { response.destroyed = true; response.emit("close"); };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = pipeModelGatewayBody(body, response, controller.signal, 1024);
  setImmediate(() => response.emit("close"));
  await assert.rejects(pending, (error) => error?.code === "model_gateway_downstream_closed");
  assert.equal(Date.now() - startedAt < 500, true);
});

function runtimeManager(activeToken = "runtime-token") {
  return {
    assertActiveModelGatewayToken(token) {
      if (token !== activeToken) {
        const error = new Error("invalid");
        error.status = 401;
        error.code = "model_gateway_token_invalid";
        throw error;
      }
      return { userId: "alice", projectId: "paper-1", jti: "runtime-1" };
    },
  };
}

test("DeepSeek configuration prefers secret files and keeps a safe host-development gateway default", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "model-gateway-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "deepseek.key");
  const signingFile = path.join(root, "gateway-signing.key");
  await writeFile(keyFile, "file-deepseek-key\n", { mode: 0o600 });
  await writeFile(signingFile, "gateway-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 });

  const loaded = loadConfig({
    rootDir: root,
    port: 9123,
    deepseekApiKey: "ignored-direct-key",
    deepseekApiKeyFile: keyFile,
    modelGatewaySigningSecret: "ignored-direct-secret-with-at-least-32-bytes",
    modelGatewaySigningSecretFile: signingFile,
  });

  assert.equal(loaded.deepseekApiKey, "file-deepseek-key");
  assert.equal(loaded.deepseekApiKeySource, "file");
  assert.equal(loaded.modelGatewaySigningSecret, "gateway-signing-secret-with-at-least-32-bytes");
  assert.equal(loaded.modelGatewaySigningSecretSource, "file");
  assert.equal(loaded.deepseekModel, "deepseek-v4-pro");
  assert.equal(loaded.deepseekBaseUrl, "https://api.deepseek.com");
  assert.equal(loaded.modelGatewayInternalUrl, "http://127.0.0.1:9123/internal/model/v1");
});

test("DeepSeek and model-gateway secret files must be private on POSIX", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "model-gateway-secret-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "deepseek.key");
  const signingFile = path.join(root, "gateway-signing.key");
  await writeFile(keyFile, "file-deepseek-key\n", { mode: 0o600 });
  await writeFile(signingFile, "gateway-signing-secret-with-at-least-32-bytes\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(keyFile, 0o644);
    await chmod(signingFile, 0o644);
    const rejected = loadConfig({ deepseekApiKeyFile: keyFile, modelGatewaySigningSecretFile: signingFile });
    assert.equal(rejected.deepseekApiKeyError, "deepseek_api_key_file_permissions");
    assert.equal(rejected.modelGatewaySigningSecretError, "model_gateway_signing_secret_file_permissions");
    assert.equal(rejected.deepseekApiKey, "");
    assert.equal(rejected.modelGatewaySigningSecret, "");
  }
  await chmod(keyFile, 0o600);
  await chmod(signingFile, 0o600);
  const accepted = loadConfig({ deepseekApiKeyFile: keyFile, modelGatewaySigningSecretFile: signingFile });
  assert.equal(accepted.deepseekApiKey, "file-deepseek-key");
  assert.equal(accepted.modelGatewaySigningSecret, "gateway-signing-secret-with-at-least-32-bytes");
});

test("model gateway authenticates runtime, forces DeepSeek policy, and forwards tool calls", async (t) => {
  let upstreamRequest;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequest = {
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chat-1", choices: [] }));
  });
  const upstreamBase = await listen(upstream);
  t.after(() => close(upstream));

  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager()));
  const gatewayBase = await listen(gateway);
  t.after(() => close(gateway));

  const response = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "untrusted-model",
      messages: [{ role: "user", content: "Analyze this." }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      stream: false,
      thinking: { type: "disabled" },
      reasoning_effort: "low",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "chat-1", choices: [] });
  assert.equal(upstreamRequest.authorization, "Bearer server-only-test-secret");
  assert.equal(upstreamRequest.contentType, "application/json");
  assert.equal(upstreamRequest.body.model, "deepseek-v4-pro");
  assert.deepEqual(upstreamRequest.body.thinking, { type: "enabled" });
  assert.equal(upstreamRequest.body.reasoning_effort, "high");
  assert.equal(upstreamRequest.body.stream, false);
  assert.equal(upstreamRequest.body.tools[0].function.name, "lookup");
});

test("model gateway preserves streaming response content type and chunks", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write("data: {\"id\":1}\n\n");
    setTimeout(() => res.end("data: [DONE]\n\n"), 10);
  });
  const upstreamBase = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager()));
  const gatewayBase = await listen(gateway);
  t.after(() => close(gateway));

  const response = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "stream" }], stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(await response.text(), "data: {\"id\":1}\n\ndata: [DONE]\n\n");
});

test("model gateway rejects stale tokens, unknown fields, and oversized collections without leaking secrets", async (t) => {
  let calls = 0;
  const upstream = createServer((_req, res) => {
    calls += 1;
    res.writeHead(500);
    res.end("should not run");
  });
  const upstreamBase = await listen(upstream);
  t.after(() => close(upstream));
  const gateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager()));
  const gatewayBase = await listen(gateway);
  t.after(() => close(gateway));

  const stale = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer old-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(stale.status, 401);
  assert.doesNotMatch(await stale.text(), /server-only-test-secret|old-token/);

  const unknown = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }], api_key: "attacker" }),
  });
  assert.equal(unknown.status, 400);

  const tooMany = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: Array.from({ length: 1025 }, () => ({ role: "user", content: "x" })) }),
  });
  assert.equal(tooMany.status, 400);

  // A long specialist run legitimately reaches several hundred messages and
  // must still be forwarded.
  const longRun = await fetch(`${gatewayBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: Array.from({ length: 400 }, () => ({ role: "user", content: "x" })) }),
  });
  assert.notEqual(longRun.status, 400);
  assert.equal(calls, 1);
});

test("model gateway maps upstream errors and timeouts to redacted stable errors", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    if (req.url.includes("timeout")) return;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream mentions server-only-test-secret" } }));
  });
  const upstreamBase = await listen(upstream);
  t.after(() => close(upstream));

  const errorGateway = createServer(createModelGatewayHandler(config(upstreamBase), runtimeManager()));
  const errorBase = await listen(errorGateway);
  t.after(() => close(errorGateway));
  const errorResponse = await fetch(`${errorBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(errorResponse.status, 429);
  assert.doesNotMatch(await errorResponse.text(), /server-only-test-secret|upstream mentions/);

  const timeoutGateway = createServer(createModelGatewayHandler(
    config(`${upstreamBase}/timeout`, { modelGatewayTimeoutMs: 30 }),
    runtimeManager(),
  ));
  const timeoutBase = await listen(timeoutGateway);
  t.after(() => close(timeoutGateway));
  const timeoutResponse = await fetch(`${timeoutBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(timeoutResponse.status, 504);
  assert.deepEqual(await timeoutResponse.json(), {
    error: { code: "model_gateway_timeout", message: "The model gateway request timed out." },
  });
});

test("production model gateway sends credentials only to the exact official DeepSeek origin", async (t) => {
  let calls = 0;
  const gateway = createServer(createModelGatewayHandler(config("https://mirror.example.com", {
    production: true,
  }), runtimeManager(), {
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  }));
  const base = await listen(gateway);
  t.after(() => close(gateway));
  const rejected = await fetch(`${base}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(rejected.status, 500);
  assert.equal(calls, 0);

  let officialRequest;
  const official = createServer(createModelGatewayHandler(config("https://api.deepseek.com", {
    production: true,
  }), runtimeManager(), {
    fetchImpl: async (url, options) => {
      officialRequest = { url: String(url), authorization: options.headers.authorization, redirect: options.redirect };
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const officialBase = await listen(official);
  t.after(() => close(official));
  const accepted = await fetch(`${officialBase}/internal/model/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(officialRequest, {
    url: "https://api.deepseek.com/chat/completions",
    authorization: "Bearer server-only-test-secret",
    redirect: "error",
  });
});

test("the message ceiling accommodates a long specialist run and stays configurable", async () => {
  const config = loadConfig({ dataDir: "/tmp/os-model-gateway-messages" });
  assert.equal(config.modelGatewayMaxMessages, 1024);
  assert.equal(
    loadConfig({ dataDir: "/tmp/os-model-gateway-messages", modelGatewayMaxMessages: 64 }).modelGatewayMaxMessages,
    64,
  );
});

test("only a certified DeepSeek model is served, and it is the one configured", () => {
  // The model is certified end to end, not merely configured: the release gate
  // runs the tool chain against whatever this resolves to and signs a receipt
  // naming it. An uncertified name must resolve to nothing rather than to a
  // default, or a typo would quietly serve on a model no gate ever exercised.
  assert.equal(certifiedDeepSeekModel({}), "deepseek-v4-pro");
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: "" }), "deepseek-v4-pro");
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: "deepseek-v4-flash" }), "deepseek-v4-flash");
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: " deepseek-v4-flash " }), "deepseek-v4-flash");
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: "deepseek-v4-turbo" }), null);
  assert.equal(certifiedDeepSeekModel({ OPEN_SCIENCE_DEEPSEEK_MODEL: "gpt-4o" }), null);

  for (const model of supportedDeepSeekModels) {
    const config = loadConfig({ dataDir: "/tmp/os-model-gateway-certified", deepseekModel: model });
    assert.equal(config.deepseekModel, model);
  }
});
