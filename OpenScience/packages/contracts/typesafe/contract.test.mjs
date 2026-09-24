// Jev's contract: TypeSafe's own recorded answers, replayed to the control
// plane's real client (apps/server/src/jevModel.mjs) and the reply check's
// real builder and gate (apps/server/src/replyCheckJev.mjs). A fixture here is
// a body the wire produced (fixtures/record.mjs), never a hand-written reading
// of the documentation — which is wrong about the statuses (see record.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REFERENCE_PRICE_LIST, priceUsage, replyCitedSentences } from "@evimed/domain";
import { JevError, callJev } from "../../../apps/server/src/jevModel.mjs";
import { jevDecisions, jevReplyRequest } from "../../../apps/server/src/replyCheckJev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const pins = JSON.parse(await readFile(path.join(here, "../../../deps-version.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(fixtures, "provenance.json"), "utf8"));
const QUESTION_TYPES = new Set(["choice", "score", "noul"]);

/**
 * A local TypeSafe that answers each request with the recording it names: no
 * key or another key is the 401, a model it does not know the unknown-model
 * 400, a question of no known type the invalid-request 400, anything else the
 * recorded answer.
 */
async function replay() {
  /** @type {any[]} */
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ path: req.url, headers: req.headers, body });
      const name = req.headers.authorization !== "Bearer contract-key" ? "unauthenticated.json"
        : body.model !== pins.typesafe.review.model ? "unknown-model.json"
          : Object.values(body.questions ?? {}).some((question) => !QUESTION_TYPES.has(/** @type {any} */ (question)?.type)) ? "invalid-request.json"
            : "answer.json";
      const recorded = provenance.fixtures[name];
      res.writeHead(recorded.status, { "content-type": recorded.responseHeaders["content-type"] ?? "application/json" });
      res.end(await readFile(path.join(fixtures, name)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { seen, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

/** The config the control plane loads, pointed at the replay. @param {string} base */
function configFor(base, key = "contract-key") {
  return {
    typesafeApiKey: key, reviewJevModel: pins.typesafe.review.model, reviewJevApiBase: base, reviewJevTimeoutMs: 5_000,
    reviewJevMaxRequestTokens: pins.typesafe.review.maxRequestTokens, reviewJevMaxStateTokens: pins.typesafe.review.maxStateTokens,
    userDailySpendLimit: 0, userWeeklySpendLimit: 0,
  };
}

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

/** The request the reply check builds today for the recorded sample. */
function sampleRequest() {
  const { sentences } = replyCitedSentences(provenance.sample.reply);
  const readable = new Map(Object.entries(provenance.sample.sources).map(([number, text]) => [Number(number), String(text)]));
  return jevReplyRequest({ sentences, readable });
}

test("the recordings came off the version this repository pins, and carry no credential", async () => {
  assert.equal(provenance.dependency, "typesafe");
  assert.equal(provenance.model, pins.typesafe.review.model);
  assert.equal(provenance.apiBase, pins.typesafe.review.apiBase);
  for (const [name, entry] of Object.entries(provenance.fixtures)) {
    assert.equal(JSON.stringify(entry.request.headers).toLowerCase().includes("authorization"), false, `${name}: no credential is recorded`);
    assert.equal((await readFile(path.join(fixtures, name), "utf8")).includes("apikey_"), false, `${name}: no key in the body`);
  }
  assert.equal(JSON.stringify(provenance).includes("apikey_"), false);
  // No rate-limit or request-id header on any answer: nothing to honour, nothing to log.
  for (const entry of Object.values(provenance.fixtures)) {
    assert.deepEqual(Object.keys(entry.responseHeaders).sort(), ["content-type", "server"]);
  }
});

test("the recorded answer is the one the reply check asks for today", () => {
  // The fixture answers a request; if the builder asks something else now, the
  // recording certifies a question nobody sends — re-record it.
  const request = sampleRequest();
  const recorded = provenance.fixtures["answer.json"].request.body;
  assert.equal(recorded.model, pins.typesafe.review.model);
  assert.deepEqual(recorded.state, request.state);
  assert.deepEqual(recorded.questions, request.questions);
});

test("an answer is read whole, booked on the provider's own count in yuan, and gated the way the reply check gates it", async () => {
  const server = await replay();
  try {
    const ledger = fakeLedger();
    const request = sampleRequest();
    const answer = await callJev({ config: configFor(server.base), usageLedger: ledger, retryDelayMs: 0 }, {
      userId: "u1", projectId: "p1", runId: "run_1", purpose: "review", state: request.state, questions: request.questions,
    });
    assert.equal(server.seen[0].path, "/v1/systemone");
    assert.equal(answer.model, pins.typesafe.review.model, "the provider answers as the pinned version");
    assert.deepEqual(Object.keys(answer.answers).sort(), ["S0", "S1", "S2"]);
    assert.ok(answer.usage.inputTokens > 0);
    assert.equal(answer.priced, true, "priced: the list in force knows the pinned model");
    const recorded = JSON.parse(await readFile(path.join(fixtures, "answer.json"), "utf8"));
    assert.equal(answer.cost, priceUsage({ resourceType: "model", model: pins.typesafe.review.model, cacheMiss: recorded.usage.input_tokens, output: recorded.usage.output_tokens, peak: true }).cost);
    assert.equal(ledger.calls[0][1].priceVersion, REFERENCE_PRICE_LIST.version);
    assert.deepEqual(ledger.calls.map((entry) => entry[0]), ["reserve", "settle"]);
    // What the gate relies on holds on the wire: each choice's confidence is
    // (k·p_max − 1)/(k − 1) of its own probabilities.
    for (const [id, value] of Object.entries(answer.answers)) {
      const probabilities = Object.values(value.probabilities).map(Number);
      const derived = (3 * Math.max(...probabilities) - 1) / 2;
      assert.ok(Math.abs(derived - value.confidence) < 0.011, `${id}: confidence ${value.confidence} vs ${derived}`);
    }
    // The sample: a sentence its source states, one whose number it contradicts, one it does not address.
    assert.deepEqual(Object.fromEntries(Object.entries(answer.answers).map(([id, value]) => [id, value.choice])),
      { S0: "supports", S1: "contradicts", S2: "says_nothing" });
    const { decided, escalated } = jevDecisions(answer.answers, { asked: request.asked, threshold: pins.typesafe.review.supportConfidence });
    assert.deepEqual([...decided.keys()], [0]);
    assert.deepEqual(escalated, [1, 2]);
  } finally {
    await server.close();
  }
});

test("an unknown version, a malformed question and a refused key are named, released, and not retried", async () => {
  const server = await replay();
  try {
    const cases = [
      [configFor(server.base), { model: "ignored" }, "unknown-model.json"],
      [configFor(server.base), { questions: { q: { type: "ranking", instructions: "x" } } }, "invalid-request.json"],
      [configFor(server.base, "someone-elses"), {}, "unauthenticated.json"],
    ];
    const codes = { "unknown-model.json": "jev_model_unknown", "invalid-request.json": "jev_request_invalid", "unauthenticated.json": "jev_auth_failed" };
    for (const [config, override, name] of cases) {
      const ledger = fakeLedger();
      const status = provenance.fixtures[name].status;
      const before = server.seen.length;
      const request = sampleRequest();
      const configured = override.model ? { ...config, reviewJevModel: "jev-0.0.0" } : config;
      await assert.rejects(callJev({ config: configured, usageLedger: ledger, retryDelayMs: 0 }, {
        userId: "u1", projectId: "p1", state: request.state, questions: override.questions ?? request.questions,
      }), (error) => error instanceof JevError && error.code === codes[name] && error.status === status, name);
      assert.equal(server.seen.length - before, 1, `${name}: a refusal is not retried`);
      assert.deepEqual(ledger.calls.map((entry) => [entry[0], entry[2]]).slice(1), [["release", `provider_refused_${status}`]], name);
    }
  } finally {
    await server.close();
  }
});
