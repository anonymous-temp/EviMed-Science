#!/usr/bin/env node
/**
 * Record the reviewer model's contract fixtures off the live DashScope wire.
 *
 * Hidden knowledge: why this is a script and not hand-written fixtures. A
 * fixture written from the documentation inherits the documentation's reading
 * of itself and then certifies it — a hand-authored wire fixture on this
 * platform once certified a shape the wire never produced (memory:
 * golden-fixtures-record-from-live-wire). So every fixture beside this file
 * except `provenance.json` is a response body exactly as DashScope sent it:
 * the streamed ones as the raw `text/event-stream` bytes, the refusals as
 * their JSON. `provenance.json` records, per fixture, the request that
 * produced it (every header but `Authorization`, and the body), its status,
 * the response headers the client reads, and when.
 *
 * What is recorded, and why each:
 *
 * - `chat-stream.sse` — a strict-schema answer with thinking off, the shape a
 *   reply check reads;
 * - `chat-stream-thinking.sse` — the same with thinking on and a budget, the
 *   shape an editor pass reads (reasoning deltas before the answer, reasoning
 *   tokens inside `completion_tokens`);
 * - `model-not-found.json` — the 404 an unknown snapshot gets, which is what a
 *   pin that no longer exists looks like;
 * - `unauthorized.json` — the 401 a key the account does not hold gets (a
 *   made-up key, never the real one).
 *
 * The key is read from the operator's file and never printed; a recording
 * that contains it anywhere is refused before anything is written. Costs a
 * few hundred tokens (well under ¥0.1).
 *
 *   node packages/contracts/dashscope/fixtures/record.mjs [--key-file .evimed-local/secrets/dashscope.api-key]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
const API_BASE = pins.dashscope.review.apiBase;
const MODEL = pins.dashscope.review.model;
const flag = process.argv.indexOf("--key-file");
const keyFile = flag > 0 ? process.argv[flag + 1] : path.resolve(repoRoot, "../.evimed-local/secrets/dashscope.api-key");
const key = (await readFile(keyFile, "utf8")).trim();
if (!key) throw new Error("the key file is empty");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sentence", "verdict", "reason", "evidence"],
        properties: {
          sentence: { type: "integer" },
          verdict: { type: "string", enum: ["supported", "partial", "unsupported", "uncertain"] },
          reason: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};
const MESSAGES = [
  { role: "system", content: "You check whether a source supports a sentence. Copy evidence verbatim from the source. Answer only in the JSON schema." },
  { role: "user", content: "<sources>\n[1]\nMetformin lowered HbA1c by 0.9 percentage points compared with placebo (95% CI 0.7 to 1.1).\n</sources>\n<sentences>\nS0 cites [1]: Metformin reduced HbA1c by 1.5% versus placebo.\n</sentences>" },
];

/** @type {Record<string, any>} */
const provenance = { dependency: "dashscope", model: MODEL, apiBase: API_BASE, observedAt: new Date().toISOString(), observedOn: "the dev box, 2026-09-23", fixtures: {} };
/** @type {Map<string, string>} */
const bodies = new Map();

/** @param {string} name @param {Record<string, any>} body @param {string} authorization */
async function record(name, body, authorization) {
  const headers = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
  const response = await fetch(`${API_BASE}/chat/completions`, { method: "POST", headers: { ...headers, authorization }, body: JSON.stringify(body) });
  const text = await response.text();
  bodies.set(name, text);
  provenance.fixtures[name] = {
    request: { method: "POST", path: "/chat/completions", headers, body },
    status: response.status,
    responseHeaders: Object.fromEntries(["content-type", "x-request-id"].map((header) => [header, response.headers.get(header)]).filter(([, value]) => value)),
  };
}

await record("chat-stream.sse", {
  model: MODEL, messages: MESSAGES, stream: true, stream_options: { include_usage: true }, enable_thinking: false, max_tokens: 400,
  response_format: { type: "json_schema", json_schema: { name: "reply_check", strict: true, schema: SCHEMA } },
}, `Bearer ${key}`);
await record("chat-stream-thinking.sse", {
  model: MODEL, messages: MESSAGES, stream: true, stream_options: { include_usage: true }, enable_thinking: true, thinking_budget: 400, max_tokens: 800,
  response_format: { type: "json_schema", json_schema: { name: "reply_check", strict: true, schema: SCHEMA } },
}, `Bearer ${key}`);
await record("model-not-found.json", { model: "qwen3.8-max-0999", messages: MESSAGES.slice(1), stream: false, max_tokens: 10 }, `Bearer ${key}`);
await record("unauthorized.json", { model: MODEL, messages: MESSAGES.slice(1), stream: false, max_tokens: 10 }, "Bearer evimed-contract-recording-not-a-key");

for (const [name, text] of bodies) {
  if (text.includes(key)) throw new Error(`${name} contains the key; nothing was written`);
}
if (JSON.stringify(provenance).includes(key)) throw new Error("provenance contains the key; nothing was written");
for (const [name, text] of bodies) await writeFile(path.join(here, name), text);
await writeFile(path.join(here, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(`recorded ${[...bodies.keys()].join(", ")} from ${MODEL}\n`);
