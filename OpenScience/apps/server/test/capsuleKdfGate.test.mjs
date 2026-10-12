// 2026-10-10 review C-10: the capsule password derivation was one process-wide slot that refused everyone else at once, so
// one account sending requests back to back kept every other account's preview, import and link redemption at 429. The gate
// gives an account one place, serves places in the order they were taken, and bounds the line and the wait.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { KDF_GATE_DEFAULTS, KDF_REFUSAL_REASONS, PasswordKdfGate } from "../src/capsuleKdfGate.mjs";

// The gate's wait timer is unref'd on purpose: a queued request must not hold a stopping process open, and in production the
// request's own socket keeps the event loop alive. A test has no socket, and Node 22's runner (CI pins 22.22.0) cancels a test whose
// only pending handle is an unref'd timer ("Promise resolution is still pending but the event loop has already resolved"), so the
// file holds one ref'd handle while it runs, as a listening server would.
const alive = setInterval(() => {}, 60_000);
after(() => clearInterval(alive));

/** A task the test finishes when it chooses. */
function manual() {
  /** @type {(value?: unknown) => void} */ let finish = () => {};
  /** @type {(error: Error) => void} */ let fail = () => {};
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  return { task: () => done, finish: (/** @type {unknown} */ value = "ok") => finish(value), fail: (/** @type {Error} */ error) => fail(error) };
}
/** @param {Promise<unknown>} promise */
async function pending(promise, ms = 15) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}

test("the refusal reasons are the three a counter can tell apart", () => {
  assert.deepEqual([...KDF_REFUSAL_REASONS], ["account_busy", "queue_full", "waited_out"]);
});

test("an idle gate runs a task at once, and a failed task gives its place back", async () => {
  const gate = new PasswordKdfGate();
  assert.equal(await gate.run("a", async () => 7), 7);
  await assert.rejects(gate.run("a", async () => { throw new Error("test-only-failure"); }), /test-only-failure/);
  assert.deepEqual(gate.load, { running: 0, waiting: 0 });
  assert.equal(await gate.run("a", async () => 8), 8, "the failure did not keep the account's place");
});

test("an account holds one place, running or waiting, and asking again takes nobody else's", async () => {
  const gate = new PasswordKdfGate();
  const first = manual();
  const running = gate.run("a", first.task);
  const second = manual();
  const waiting = gate.run("b", second.task);
  assert.deepEqual(gate.load, { running: 1, waiting: 1 });
  for (const account of ["a", "b"]) {
    await assert.rejects(gate.run(account, async () => 1), (error) => error.code === "capsule_password_busy" && error.reason === "account_busy" && error.retryAfterSeconds > 0, account);
  }
  assert.deepEqual(gate.load, { running: 1, waiting: 1 }, "the refusals changed nobody's place");
  first.finish(); await running;
  second.finish(); await waiting;
  assert.deepEqual(gate.load, { running: 0, waiting: 0 });
});

test("places are served in the order they were taken, and an account that was just served goes to the back", async () => {
  const gate = new PasswordKdfGate();
  /** @type {string[]} */ const started = [];
  /** @type {Map<string, ReturnType<typeof manual>>} */ const tasks = new Map();
  const request = (/** @type {string} */ account, label = account) => {
    const held = manual();
    tasks.set(label, held);
    return gate.run(account, () => { started.push(label); return held.task(); });
  };
  const a1 = request("a", "a1");
  const b = request("b");
  const c = request("c");
  assert.deepEqual(started, ["a1"], "one at a time");
  tasks.get("a1")?.finish(); await a1;
  const a2 = request("a", "a2");
  assert.deepEqual(started, ["a1", "b"], "b was next, not a's new request");
  tasks.get("b")?.finish(); await b;
  assert.deepEqual(started, ["a1", "b", "c"]);
  tasks.get("c")?.finish(); await c;
  assert.deepEqual(started, ["a1", "b", "c", "a2"]);
  tasks.get("a2")?.finish(); await a2;
});

test("a line longer than the gate allows is refused rather than held", async () => {
  const gate = new PasswordKdfGate({ maxWaiting: 2 });
  const holds = ["a", "b", "c"].map((account) => ({ account, held: manual() }));
  const runs = holds.map(({ account, held }) => gate.run(account, held.task));
  assert.deepEqual(gate.load, { running: 1, waiting: 2 });
  await assert.rejects(gate.run("d", async () => 1), (error) => error.code === "capsule_password_busy" && error.reason === "queue_full");
  for (const { held } of holds) held.finish();
  await Promise.all(runs);
});

test("a request that waits longer than the gate allows is refused, and its place in the line is gone", async () => {
  const gate = new PasswordKdfGate({ maxWaitMs: 20 });
  const first = manual();
  const running = gate.run("a", first.task);
  await assert.rejects(gate.run("b", async () => 1), (error) => error.code === "capsule_password_busy" && error.reason === "waited_out");
  assert.deepEqual(gate.load, { running: 1, waiting: 0 });
  // The account that waited out can ask again, and the one that held the slot is unaffected. The second wait gets room: at
  // 20 ms a loaded run (a parallel suite, 2026-10-12) waited it out too before the slot was freed, which is not the property.
  gate.configure({ maxWaitMs: 10_000 });
  const next = manual();
  const again = gate.run("b", next.task);
  assert.equal(await pending(again), true);
  first.finish(); await running;
  next.finish("done");
  assert.equal(await again, "done");
});

test("the number of derivations that run at once is the gate's concurrency", async () => {
  const gate = new PasswordKdfGate({ concurrency: 2 });
  const holds = [manual(), manual(), manual()];
  const runs = holds.map((held, index) => gate.run(`acct-${index}`, held.task));
  assert.deepEqual(gate.load, { running: 2, waiting: 1 });
  holds[0].finish(); await runs[0];
  assert.deepEqual(gate.load, { running: 2, waiting: 0 }, "the freed place passed to the one that waited");
  holds[1].finish(); holds[2].finish();
  await Promise.all(runs);
  assert.deepEqual(gate.load, { running: 0, waiting: 0 });
});

test("callers that name no account are one account among the others", async () => {
  const gate = new PasswordKdfGate();
  const first = manual();
  const running = gate.run(undefined, first.task);
  await assert.rejects(gate.run(null, async () => 1), (error) => error.reason === "account_busy");
  const named = gate.run("a", async () => "a");
  assert.equal(await pending(named), true, "a named account waits behind it");
  first.finish(); await running;
  assert.equal(await named, "a");
});

test("the limits are the deployment's: set from the configuration, left alone by a value that is no limit, and by default the ones the gate shipped with (review C4e)", async () => {
  assert.deepEqual({ ...KDF_GATE_DEFAULTS }, { concurrency: 1, maxWaiting: 6, maxWaitMs: 10_000 });
  const gate = new PasswordKdfGate();
  assert.deepEqual(gate.limits, KDF_GATE_DEFAULTS);
  gate.configure({ concurrency: 2, maxWaiting: 0, maxWaitMs: 50 });
  assert.deepEqual(gate.limits, { concurrency: 2, maxWaiting: 0, maxWaitMs: 50 });
  // Two run at once and the line is empty, so a third is refused where it stands.
  const holds = [manual(), manual()];
  const runs = holds.map((held, index) => gate.run(`acct-${index}`, held.task));
  assert.deepEqual(gate.load, { running: 2, waiting: 0 });
  await assert.rejects(gate.run("acct-2", async () => 1), (error) => error.reason === "queue_full");
  // Nothing that is not a limit takes a limit away: zero derivations, a negative line, a fraction, a string, nothing.
  gate.configure({ concurrency: 0, maxWaiting: -1, maxWaitMs: 0.5 });
  gate.configure({ concurrency: "3", maxWaiting: "4", maxWaitMs: "5" });
  gate.configure({});
  assert.deepEqual(gate.limits, { concurrency: 2, maxWaiting: 0, maxWaitMs: 50 });
  for (const held of holds) held.finish();
  await Promise.all(runs);
});
