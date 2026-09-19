// How often one site hears from us, and how many reads run at once.
import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyGate, HostPacer } from "../src/webReadLimits.mjs";

test("one site is paced; a request that would wait too long is refused by name", async () => {
  let clock = 1_000_000;
  const waits = [];
  const pacer = new HostPacer({
    intervalMs: 1_000,
    maxWaitMs: 2_500,
    now: () => clock,
    wait: async (ms) => { waits.push(ms); },
  });
  await pacer.acquire("www.nmpa.gov.cn");
  await pacer.acquire("WWW.NMPA.GOV.CN");
  await pacer.acquire("www.nmpa.gov.cn");
  assert.deepEqual(waits, [1_000, 2_000], "the second and third requests wait for their slots");
  await assert.rejects(pacer.acquire("www.nmpa.gov.cn"), (error) => error.code === "web_read_host_busy" && error.status === 429);
  // Another site is not held up by the first.
  await pacer.acquire("www.cde.org.cn");
  assert.deepEqual(waits, [1_000, 2_000]);
  // Time passes and the site is free again.
  clock += 10_000;
  await pacer.acquire("www.nmpa.gov.cn");
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.deepEqual(pacer.counts, { waited: 2, refused: 1 });
});

test("a robots.txt Crawl-delay stretches the interval for that site", async () => {
  const clock = 0;
  const waits = [];
  const pacer = new HostPacer({ intervalMs: 1_000, maxWaitMs: 60_000, now: () => clock, wait: async (ms) => { waits.push(ms); } });
  await pacer.acquire("slow.example.org", { crawlDelayMs: 5_000 });
  await pacer.acquire("slow.example.org", { crawlDelayMs: 5_000 });
  assert.deepEqual(waits, [5_000]);
});

test("the gate never runs more than its limit, even when a newcomer arrives as a slot frees", async () => {
  // The defect this guards: a finishing job that decremented the count and
  // then woke a waiter left one microtask in which a newcomer saw a free slot,
  // took it, and the woken waiter took it again. Two slots are freed in the
  // same tick while newcomers arrive at every microtask depth, so one of them
  // lands in that window if it exists.
  for (let depth = 0; depth < 12; depth += 1) {
    const gate = new ConcurrencyGate({ limit: 2, maxQueue: 50, busyCode: "web_read_busy" });
    let active = 0;
    let peak = 0;
    const releases = [];
    const job = () => gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
    });
    const running = [job(), job(), job(), job()];
    await new Promise((resolve) => setImmediate(resolve));
    const hop = (count, then) => (count === 0 ? then() : queueMicrotask(() => hop(count - 1, then)));
    releases.shift()();
    releases.shift()();
    for (let offset = 0; offset <= depth; offset += 1) hop(offset, () => running.push(job()));
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      while (releases.length) releases.shift()();
    }
    await Promise.all(running);
    assert.equal(peak, 2, `more than two ran at once with newcomers ${depth} microtasks deep`);
    assert.equal(gate.active, 0);
  }
});

test("a full queue refuses with the gate's code; an abandoned waiter leaves the queue", async () => {
  const gate = new ConcurrencyGate({ limit: 1, maxQueue: 1, busyCode: "web_render_busy" });
  let release;
  const first = gate.run(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const queued = gate.run(async () => "late", { signal: controller.signal });
  await assert.rejects(gate.run(async () => "third"), (error) => error.code === "web_render_busy" && error.status === 503);
  controller.abort(new Error("run cancelled"));
  await assert.rejects(queued, /run cancelled/);
  assert.equal(gate.queue.length, 0);
  release();
  await first;
  assert.equal(await gate.run(async () => "after"), "after");
  assert.equal(gate.active, 0);
});
