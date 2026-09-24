#!/usr/bin/env node
/**
 * Record Jev's contract fixtures off the live TypeSafe wire.
 *
 * Hidden knowledge: why this is a script and not hand-written fixtures. A
 * fixture written from the documentation inherits the documentation's reading
 * of itself and then certifies it — and TypeSafe's documentation is wrong about
 * its own errors (it lists 401 for a bad key and 422 for a bad request; the
 * wire answers 403 when the key is missing, 401 when it is wrong, and 400 for a
 * bad request). So every
 * fixture beside this file except `provenance.json` is a response body exactly
 * as TypeSafe sent it, and `provenance.json` records, per fixture, the request
 * that produced it (every header but `Authorization`, and the body), its
 * status, the response headers the client reads, and when. The first recording
 * of these shapes was the probe of 2026-09-21
 * (`.evimed-local/probes/2026-09-21-jev/wire-frames.json`, not in the repository).
 *
 * What is recorded, and why each:
 *
 * - `answer.json` — the reply check's own request, built by the control
 *   plane's builder (`apps/server/src/replyCheckJev.mjs`) from the sample
 *   reply below: one sentence its source states, one whose number the source
 *   contradicts, one the source does not address. The sample travels in
 *   `provenance.json`, so the contract test can rebuild the request and notice
 *   when the builder no longer asks what was recorded;
 * - `unknown-model.json` — the 400 an unknown version gets, which is what a
 *   pinned version TypeSafe has withdrawn looks like;
 * - `invalid-request.json` — the 400 a malformed question gets ("Invalid
 *   request.", no field named);
 * - `unauthenticated.json` — the 401 a key TypeSafe does not hold gets (a
 *   made-up key, never the real one). A request with no key at all is 403
 *   ("Must supply an API key!"), seen on 2026-09-21 and again on 2026-09-24;
 *   the client reads both as `jev_auth_failed`.
 *
 * The key is read from the operator's file and never printed; a recording that
 * contains it anywhere is refused before anything is written. Costs about two
 * thousand input tokens ($0.0001).
 *
 *   node packages/contracts/typesafe/fixtures/record.mjs [--key-file ../.evimed-local/secrets/typesafe.api-key]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replyCitedSentences } from "@evimed/domain";
import { jevReplyRequest } from "../../../../apps/server/src/replyCheckJev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const pins = JSON.parse(await readFile(path.join(repoRoot, "deps-version.json"), "utf8"));
const API_BASE = pins.typesafe.review.apiBase;
const MODEL = pins.typesafe.review.model;
const flag = process.argv.indexOf("--key-file");
const keyFile = flag > 0 ? process.argv[flag + 1] : path.resolve(repoRoot, "../.evimed-local/secrets/typesafe.api-key");
const key = (await readFile(keyFile, "utf8")).trim();
if (!key) throw new Error("the key file is empty");

/** A cited reply as the answer persona writes one, and what its sources say. */
const SAMPLE = {
  reply: [
    "心电图是胸痛评估的最佳初始检查 [1]。",
    "高敏肌钙蛋白检测需要 12 小时以上才能排除心肌梗死 [2]。",
    "胸痛患者中女性更常报告恶心 [1]。",
    "",
    "参考文献：",
    "1. Electrocardiography in the evaluation of chest pain. doi:10.1000/ecg",
    "2. High-sensitivity cardiac troponin. doi:10.1000/tn",
  ].join("\n"),
  sources: {
    1: "Electrocardiography in the evaluation of chest pain.\nThe electrocardiogram (ECG) remains the best initial test for chest pain evaluation because it is rapid, inexpensive, and provides critical diagnostic and prognostic information.",
    2: "High-sensitivity cardiac troponin.\nHigh-sensitivity cardiac troponin assays allow myocardial infarction to be ruled in or ruled out within 1 to 2 hours of presentation.",
  },
};

const { sentences } = replyCitedSentences(SAMPLE.reply);
const readable = new Map(Object.entries(SAMPLE.sources).map(([number, text]) => [Number(number), text]));
const request = jevReplyRequest({ sentences, readable });
if (request.asked.length !== 3) throw new Error(`the sample should put 3 sentences to Jev, not ${request.asked.length}`);

/** @type {Record<string, any>} */
const provenance = {
  dependency: "typesafe", model: MODEL, apiBase: API_BASE, observedAt: new Date().toISOString(), observedOn: "the dev box",
  firstRecorded: "2026-09-21, the Jev probe: 403 on a missing key, 400 api_usage_error for a bad request and an unknown model, no rate-limit or request-id headers; all unchanged when re-recorded",
  sample: SAMPLE, fixtures: {},
};
/** @type {Map<string, string>} */
const bodies = new Map();

/** @param {string} name @param {Record<string, any>} body @param {string} authorization */
async function record(name, body, authorization) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const started = performance.now();
  const response = await fetch(`${API_BASE}/systemone`, { method: "POST", headers: { ...headers, authorization }, body: JSON.stringify(body) });
  const text = await response.text();
  bodies.set(name, text);
  provenance.fixtures[name] = {
    request: { method: "POST", path: "/systemone", headers, body },
    status: response.status,
    ms: Math.round(performance.now() - started),
    responseHeaders: Object.fromEntries(["content-type", "server", "retry-after", "x-request-id", "x-ratelimit-remaining"]
      .map((header) => [header, response.headers.get(header)]).filter(([, value]) => value)),
  };
}

await record("answer.json", { model: MODEL, state: request.state, questions: request.questions }, `Bearer ${key}`);
await record("unknown-model.json", { model: "jev-0.0.0", state: "x", questions: { q: { type: "noul", instructions: "x is a letter" } } }, `Bearer ${key}`);
await record("invalid-request.json", { model: MODEL, state: "x", questions: { q: { type: "ranking", instructions: "x" } } }, `Bearer ${key}`);
await record("unauthenticated.json", { model: MODEL, state: "x", questions: { q: { type: "noul", instructions: "x is a letter" } } }, "Bearer evimed-contract-recording-not-a-key");

for (const [name, text] of bodies) {
  if (text.includes(key)) throw new Error(`${name} contains the key; nothing was written`);
}
if (JSON.stringify(provenance).includes(key)) throw new Error("provenance contains the key; nothing was written");
for (const [name, text] of bodies) await writeFile(path.join(here, name), text);
await writeFile(path.join(here, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
process.stdout.write(`recorded ${[...bodies.keys()].map((name) => `${name} ${provenance.fixtures[name].status} ${provenance.fixtures[name].ms}ms`).join(", ")} from ${MODEL}\n`);
