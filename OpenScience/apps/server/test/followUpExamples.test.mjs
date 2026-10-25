// Which examples of the follow-up judge's bank a message is shown with (2026-10-25): the nearest by meaning when the embedder answers, by character
// n-grams when it does not, and never a throw. Choosing examples is retrieval; what the message means is the model's.
import assert from "node:assert/strict";
import test from "node:test";

import { FOLLOW_UP_EXAMPLES_VERSION, followUpPool } from "@evimed/domain/follow-up-examples";
import { FOLLOW_UP_EXAMPLES_K, createFollowUpExamples } from "../src/followUpExamples.mjs";

const pool = followUpPool();

/** An embedder that places each text on an axis by a property of it: the example whose message shares the query's axis is the nearest. @param {string[]} log */
function axisEmbed(log = []) {
  return async (texts) => {
    log.push(texts.length);
    return texts.map((text) => [/以后|from now on|always/i.test(text) ? 1 : 0, /长|短|long|short/i.test(text) ? 1 : 0, 0.05]);
  };
}

test("the nearest examples by meaning, nearest first, from a pool the anchors are not in; the bank is embedded once", async () => {
  const log = [];
  const examples = createFollowUpExamples({ embed: axisEmbed(log) });
  const first = await examples.select("以后月报都这样");
  assert.equal(first.mode, "embedding");
  assert.equal(first.version, FOLLOW_UP_EXAMPLES_VERSION);
  assert.equal(first.examples.length, FOLLOW_UP_EXAMPLES_K);
  assert.ok(first.examples.every((example) => pool.includes(example)), "only pool examples: the anchors are in the instructions already");
  assert.ok(first.examples.slice(0, 3).every((example) => /以后|always|from now on/i.test(example.message)), "the nearest are the ones on the same axis");
  await examples.select("太长了");
  assert.deepEqual(log, [pool.length, 1, 1], "the bank in one call, then one call per message");
  assert.deepEqual((await examples.select("以后月报都这样", { limit: 2 })).examples.length, 2);
  assert.deepEqual(examples.stats(), { embedding: 3, ngram: 0, failures: 0 });
});

test("without an embedder, or when it fails, the examples are chosen by character n-grams, and an embedder that is down is one failed request, not one per message", async () => {
  const offline = createFollowUpExamples({ embed: null });
  const chosen = await offline.select("以后月报也按这个来");
  assert.equal(chosen.mode, "ngram");
  assert.ok(chosen.examples.length > 0 && chosen.examples.every((example) => pool.includes(example)));
  assert.deepEqual((await offline.select("以后月报也按这个来")).examples.map((example) => example.id), chosen.examples.map((example) => example.id), "deterministic");

  let calls = 0;
  let clock = 0;
  const warned = [];
  const failing = createFollowUpExamples({ embed: async () => { calls += 1; throw Object.assign(new Error("down"), { code: "embedding_unavailable" }); },
    now: () => clock, retryAfterMs: 30_000, logger: { warn: (message) => warned.push(message) } });
  assert.equal((await failing.select("以后月报也按这个来")).mode, "ngram");
  assert.equal((await failing.select("以后周报也按这个来")).mode, "ngram");
  assert.equal(calls, 1, "not retried inside the window");
  assert.equal(warned.length, 1);
  clock = 31_000;
  assert.equal((await failing.select("以后周报也按这个来")).mode, "ngram");
  assert.equal(calls, 2, "tried again once the window has passed");
  assert.deepEqual(failing.stats().failures, 2);

  // An answer that is not vectors is the embedder's fault and the same fallback.
  const garbled = createFollowUpExamples({ embed: async () => [[1, 2]] });
  assert.equal((await garbled.select("以后月报也按这个来")).mode, "ngram");
  const nan = createFollowUpExamples({ embed: async (texts) => texts.map(() => [Number.NaN, 1]) });
  assert.equal((await nan.select("以后月报也按这个来")).mode, "ngram");
  // Nothing to show is no examples, never a throw: an empty message, an empty pool, a limit of none.
  assert.deepEqual((await offline.select("   ")).examples, []);
  assert.deepEqual((await createFollowUpExamples({ pool: [] }).select("太长了")).examples, []);
  assert.deepEqual((await offline.select("太长了", { limit: 0 })).examples, []);
});
