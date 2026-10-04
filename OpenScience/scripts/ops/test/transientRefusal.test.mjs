// A driver is patient with the refusal the product itself waits out.
//
// 2026-10-04: after a release the first start of a project with saved plugin
// settings answered 423 `plugin_apply_in_progress` for a few seconds, and five
// drivers each failed their first call. The control plane now waits for the
// apply and the web shell retries by itself; these hold the one helper the
// drivers share, and the drivers to it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patientFetch, refusalCodeOf, sendThroughApply, transientRefusalCode } from "../transient-refusal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {number} status @param {unknown} body */
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const applying = () => answer(423, { error: "Plugin settings are being applied; retry shortly.", code: "plugin_apply_in_progress" });

/** A clock the test moves, so a wait is measured and never slept. */
function clock() {
  const state = { at: 1_000_000, slept: /** @type {number[]} */ ([]) };
  return { state, now: () => state.at, sleep: async (/** @type {number} */ ms) => { state.slept.push(ms); state.at += ms; } };
}

test("only the refusals that clear are transient, by code and status together", () => {
  assert.equal(transientRefusalCode(423, { code: "plugin_apply_in_progress" }), "plugin_apply_in_progress");
  assert.equal(transientRefusalCode(423, { data: { code: "plugin_apply_in_progress" } }), "plugin_apply_in_progress");
  assert.equal(transientRefusalCode(423, { error: { code: "plugin_apply_in_progress" } }), "plugin_apply_in_progress");
  // A hold the product does not lift by waiting is the answer, not a reason to wait.
  assert.equal(transientRefusalCode(423, { code: "runtime_reserved_for_autopilot" }), null);
  assert.equal(transientRefusalCode(429, { code: "runtime_limit_exceeded" }), null);
  assert.equal(transientRefusalCode(500, { code: "plugin_apply_in_progress" }), null, "the status is part of the identity");
  assert.equal(transientRefusalCode(423, null), null);
  assert.equal(transientRefusalCode(423, "plugin_apply_in_progress"), null);
});

test("a refusal is read off either client's response without spending its body", async () => {
  const refused = applying();
  assert.equal(await refusalCodeOf(refused), "plugin_apply_in_progress");
  assert.equal((await refused.json()).code, "plugin_apply_in_progress", "the caller can still read it");
  assert.equal(await refusalCodeOf(answer(200, { data: {} })), null);
  assert.equal(await refusalCodeOf(new Response("not json", { status: 423 })), null, "a 423 that says nothing is not asked again");
  // Playwright's APIResponse: `status()` is a function and `json()` can be read again.
  const playwright = { status: () => 423, json: async () => ({ code: "plugin_apply_in_progress" }) };
  assert.equal(await refusalCodeOf(playwright), "plugin_apply_in_progress");
  assert.equal(await refusalCodeOf({ status: () => 200, json: async () => ({}) }), null);
});

test("it asks again until the apply ends, spacing the asks, and returns the answer that is not a refusal", async () => {
  const { state, now, sleep } = clock();
  let asked = 0;
  const result = await sendThroughApply(async () => (++asked <= 3 ? applying() : answer(200, { data: { id: "run_1" } })), { now, sleep });
  assert.equal(result.status, 200);
  assert.equal(asked, 4);
  assert.deepEqual(state.slept, [500, 1_000, 2_000], "each ask waits a little longer");
});

test("an apply that outlasts the wait is returned as the refusal it is, with its code intact", async () => {
  const { state, now, sleep } = clock();
  let asked = 0;
  const result = await sendThroughApply(async () => { asked += 1; return applying(); }, { now, sleep, waitMs: 5_000 });
  assert.equal(result.status, 423);
  assert.equal((await result.json()).code, "plugin_apply_in_progress", "the driver fails with the code the product gave");
  assert.ok(state.slept.reduce((sum, ms) => sum + ms, 0) <= 5_000, "bounded");
  assert.ok(asked >= 3 && asked < 20);
});

test("nothing else is asked again: a success, another refusal and a server error are returned at once", async () => {
  for (const response of [answer(200, {}), answer(423, { code: "runtime_reserved_for_autopilot" }), answer(429, { code: "runtime_limit_exceeded" }), answer(500, { code: "x" })]) {
    const { state, now, sleep } = clock();
    let asked = 0;
    const result = await sendThroughApply(async () => { asked += 1; return response; }, { now, sleep });
    assert.equal(result, response);
    assert.equal(asked, 1);
    assert.deepEqual(state.slept, []);
  }
});

test("the body of a refusal that is asked again is let go, and the final answer is not", async () => {
  const { now, sleep } = clock();
  const released = [];
  let asked = 0;
  const result = await sendThroughApply(async () => (++asked < 3 ? { status: 423, json: async () => ({ code: "plugin_apply_in_progress" }), dispose: async () => { released.push(asked); } } : { status: 200, json: async () => ({}), dispose: async () => { released.push("final"); } }),
    { now, sleep });
  assert.equal(result.status, 200);
  assert.deepEqual(released, [1, 2]);
});

test("patientFetch is fetch: the same arguments reach each attempt", async () => {
  const { now, sleep } = clock();
  const calls = [];
  let asked = 0;
  const response = await patientFetch("https://control.example/api/commands/start_runtime", { method: "POST", body: "{}" }, {
    now, sleep,
    fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { calls.push([url, init]); return ++asked < 2 ? applying() : answer(200, { data: { running: true } }); }),
  });
  assert.equal((await response.json()).data.running, true);
  assert.deepEqual(calls.map(([url, init]) => [url, init.method, init.body]), [
    ["https://control.example/api/commands/start_runtime", "POST", "{}"], ["https://control.example/api/commands/start_runtime", "POST", "{}"],
  ]);
});

test("every driver that opens a conversation through the product's routes goes through the shared helper", async () => {
  // The first call after a release is the one that fails, so a driver that
  // keeps its own bare `fetch` for its requests is the defect this closes.
  const drivers = [
    ["deployment-smoke.mjs", "../deployment-smoke.mjs"],
    ["session-stream-acceptance.mjs", "../session-stream-acceptance.mjs"],
    ["hosted-production-e2e.mjs", "../hosted-production-e2e.mjs"],
    ["result-revision-acceptance.mjs", "../result-revision-acceptance.mjs"],
    ["vcr/live-acceptance.mjs", "../../vcr/live-acceptance.mjs"],
  ];
  for (const [name, relative] of drivers) {
    const text = await readFile(path.join(here, relative), "utf8");
    assert.match(text, /from ['"]\.{1,2}\/(?:ops\/)?transient-refusal\.mjs['"]/, `${name} imports the shared helper`);
    assert.match(text, /patientFetch\(|sendThroughApply\(/, `${name} sends through it`);
  }
});
