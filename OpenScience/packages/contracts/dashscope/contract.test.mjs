// The reviewer model's contract: DashScope's own recorded answers, replayed to
// the control plane's real client (apps/server/src/reviewModel.mjs). A fixture
// here is a body the wire produced (fixtures/record.mjs), never a hand-written
// reading of the documentation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callReviewModel, ReviewModelError } from "../../../apps/server/src/reviewModel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const pins = JSON.parse(await readFile(path.join(here, "../../../deps-version.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(fixtures, "provenance.json"), "utf8"));

/**
 * A local DashScope that answers each request with the recording its body
 * names: a model it does not know is the 404, a key it does not hold the 401,
 * thinking on the thinking stream.
 * @param {(request: { headers: Record<string, any>, body: any }) => void} [observe]
 */
async function replay(observe = () => {}) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      observe({ headers: req.headers, body });
      const name = req.headers.authorization !== "Bearer contract-key" ? "unauthorized.json"
        : body.model !== pins.dashscope.review.model ? "model-not-found.json"
          : body.enable_thinking ? "chat-stream-thinking.sse" : "chat-stream.sse";
      const recorded = provenance.fixtures[name];
      res.writeHead(recorded.status, { "content-type": recorded.responseHeaders["content-type"] ?? "application/json" });
      res.end(await readFile(path.join(fixtures, name)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}/compatible-mode/v1`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

const call = {
  userId: "u1", projectId: "p1",
  messages: [{ role: /** @type {const} */ ("user"), content: "check" }],
  schema: { type: "object" }, schemaName: "reply_check",
};

test("the recordings came off the version this repository pins", () => {
  assert.equal(provenance.model, pins.dashscope.review.model);
  assert.equal(provenance.apiBase, pins.dashscope.review.apiBase);
  for (const [name, entry] of Object.entries(provenance.fixtures)) {
    assert.equal(JSON.stringify(entry.request.headers).toLowerCase().includes("authorization"), false, `${name}: no credential is recorded`);
  }
});

test("a strict-schema answer streamed with thinking off is read whole, with the provider's own count", async () => {
  const server = await replay();
  try {
    const answer = await callReviewModel({ config: { dashscopeApiKey: "contract-key", reviewModel: pins.dashscope.review.model, reviewApiBase: server.base } },
      { ...call, thinking: { enabled: false } });
    assert.ok(Array.isArray(answer.value.verdicts), JSON.stringify(answer.value));
    assert.equal(answer.value.verdicts[0].sentence, 0);
    assert.equal(answer.model, pins.dashscope.review.model, "the provider answers as the pinned snapshot");
    assert.ok(answer.usage.completionTokens > 0);
    assert.ok(answer.usage.cacheMissTokens > 0);
    assert.equal(answer.reasoningChars, 0);
    assert.ok(answer.cost > 0, "priced: the price list knows the pinned model");
  } finally {
    await server.close();
  }
});

test("with thinking on the reasoning streams first and is billed inside completion_tokens", async () => {
  const server = await replay();
  try {
    const answer = await callReviewModel({ config: { dashscopeApiKey: "contract-key", reviewModel: pins.dashscope.review.model, reviewApiBase: server.base } },
      { ...call, thinking: { enabled: true, budget: 400 } });
    assert.ok(Array.isArray(answer.value.verdicts));
    assert.ok(answer.reasoningChars > 0, "the reasoning arrived as its own deltas");
    assert.ok(answer.usage.reasoningTokens > 0);
    assert.ok(answer.usage.reasoningTokens <= answer.usage.completionTokens, "reasoning is counted within completion tokens");
  } finally {
    await server.close();
  }
});

test("an unknown snapshot and a refused key are named for what they are", async () => {
  const server = await replay();
  try {
    await assert.rejects(callReviewModel({ config: { dashscopeApiKey: "contract-key", reviewModel: "qwen3.8-max-0999", reviewApiBase: server.base } }, call),
      (error) => error instanceof ReviewModelError && error.code === "review_model_unavailable");
    await assert.rejects(callReviewModel({ config: { dashscopeApiKey: "someone-elses", reviewModel: pins.dashscope.review.model, reviewApiBase: server.base } }, call),
      (error) => error instanceof ReviewModelError && error.code === "review_model_auth_failed");
  } finally {
    await server.close();
  }
});
