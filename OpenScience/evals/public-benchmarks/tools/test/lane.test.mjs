// Tests of lane.sh (parallel lanes) with a fake driver: no docker, no production.
// Run: node --test tools/test/lane.test.mjs   (from evals/public-benchmarks; needs bash and flock)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const LANE = path.join(here, "..", "lane.sh");
const FAKE = path.join(here, "fake-lane-driver.sh");
chmodSync(FAKE, 0o755);

const roots = [];
const lanes = [];
after(() => {
  for (const lane of lanes) if (lane.child.exitCode === null && lane.child.signalCode === null) lane.child.kill("SIGTERM");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A host directory with queue files q1..qN and pending.txt listing them. */
function host(names) {
  const root = mkdtempSync(path.join(tmpdir(), "lane-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "queue"));
  mkdirSync(path.join(root, "lane"));
  for (const name of names) writeFileSync(path.join(root, "queue", `${name}.jsonl`), `${JSON.stringify({ key: `${name}/1`, prompt: "p" })}\n`);
  writeFileSync(path.join(root, "lane", "pending.txt"), names.length ? `${names.join("\n")}\n` : "");
  return root;
}
const fakeDir = (root) => path.join(root, "fake");
const marker = (root, kind, name) => { mkdirSync(fakeDir(root), { recursive: true }); writeFileSync(path.join(fakeDir(root), `${kind}-${name}`), ""); };
const unmark = (root, kind, name) => rmSync(path.join(fakeDir(root), `${kind}-${name}`), { force: true });
const touch = (root, ...parts) => writeFileSync(path.join(root, "lane", ...parts), "");
const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const pending = (root) => lines(path.join(root, "lane", "pending.txt"));
const done = (root) => lines(path.join(root, "lane", "done.txt"));
const claims = (root) => (existsSync(path.join(root, "lane", "claims")) ? readdirSync(path.join(root, "lane", "claims")).sort() : []);
const calls = (root) => lines(path.join(fakeDir(root), "calls.log")).map((line) => {
  const [kind, queue, lane, at, extra, note] = line.split(" ");
  return { kind, queue, lane, at: Number(at), extra, note };
});
const started = (root, queue) => calls(root).filter((c) => c.kind === "start" && (queue === undefined || c.queue === queue));
const logOf = (root, id) => readFileSync(path.join(root, "lane", id ? `lane-${id}.log` : "lane.log"), "utf8");

/** Start a lane (id undefined = the default lane). */
function startLane(root, id, env = {}) {
  const child = spawn("bash", [LANE, ...(id ? [id] : [])], {
    env: { ...process.env, BENCH_LANE_ROOT: root, BENCH_LANE_IDLE_S: "0.1", BENCH_LANE_RUN: FAKE, FAKE_SLEEP: "0.1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });
  const lane = { child, id, output: () => output, exited: new Promise((resolve) => child.on("close", (code) => resolve(code))) };
  lanes.push(lane);
  return lane;
}
async function until(what, predicate, ms = 15000) {
  const began = Date.now();
  while (Date.now() - began < ms) { if (predicate()) return; await sleep(25); }
  assert.fail(`timed out waiting for ${what}`);
}
const running = (lane) => lane.child.exitCode === null && lane.child.signalCode === null;
const release = (root, name) => writeFileSync(path.join(fakeDir(root), `release-${name}`), "");
async function stopAll(root, ...laneList) {
  touch(root, "STOP-ALL");
  for (const lane of laneList) assert.equal(await lane.exited, 0, lane.output());
}

test("two lanes claim distinct queues and together run each queue exactly once", async () => {
  const root = host(["q1", "q2", "q3", "q4"]);
  marker(root, "hold", "q1");
  const a = startLane(root, "A");
  await until("A to start q1", () => started(root, "q1").length === 1);
  const b = startLane(root, "B");
  await until("B to start q2", () => started(root, "q2").length === 1);
  // A is still inside q1 while B works through the others: the lanes really overlap
  assert.ok(running(a));
  assert.equal(claims(root).includes("q1"), true);
  await until("B to finish q2..q4", () => done(root).length === 3);
  release(root, "q1");
  await until("all four done", () => done(root).length === 4);
  assert.deepEqual(started(root).map((c) => c.queue).sort(), ["q1", "q2", "q3", "q4"]);
  assert.deepEqual(started(root).filter((c) => c.lane === "A").map((c) => c.queue), ["q1"]);
  assert.deepEqual(started(root).filter((c) => c.lane === "B").map((c) => c.queue), ["q2", "q3", "q4"]);
  const endOfQ1 = calls(root).find((c) => c.kind === "end" && c.queue === "q1").at;
  assert.ok(started(root, "q2")[0].at < endOfQ1, "q2 started while q1 was still running");
  assert.deepEqual(started(root).map((c) => c.extra).sort(), ["bench-q1-A", "bench-q2-B", "bench-q3-B", "bench-q4-B"]);
  assert.deepEqual(pending(root), []);
  await until("every claim released", () => claims(root).length === 0); // the claim goes right after the done.txt line
  assert.deepEqual(claims(root), [], "every claim was released");
  for (const q of ["q1", "q2", "q3", "q4"]) assert.ok(existsSync(path.join(root, "results", q)), `results/${q} is the queue's own --out`);
  await stopAll(root, a, b);
  assert.match(logOf(root, "A"), /lane A: queue q1 start/);
  assert.match(logOf(root, "B"), /lane B: STOP-ALL file: lane ends/);
});

test("many lanes on a long list: every queue exactly once, none lost from pending.txt", async () => {
  const names = Array.from({ length: 24 }, (_, n) => `s${n + 1}`);
  const root = host(names);
  const group = ["L1", "L2", "L3", "L4"].map((id) => startLane(root, id, { FAKE_SLEEP: "0.02" }));
  await until("all queues done", () => done(root).length === names.length, 30000);
  assert.deepEqual(started(root).map((c) => c.queue).sort(), [...names].sort(), "each queue started exactly once");
  assert.deepEqual(done(root).sort(), [...names].sort());
  assert.deepEqual(pending(root), []);
  await until("every claim released", () => claims(root).length === 0);
  assert.ok(new Set(started(root).map((c) => c.lane)).size > 1, "more than one lane did work");
  await stopAll(root, ...group);
});

test("STOP-<id> ends only that lane, after its current queue", async () => {
  const root = host(["q1", "q2", "q3", "q4"]);
  marker(root, "hold", "q1");
  marker(root, "hold", "q2");
  const a = startLane(root, "A");
  await until("A in q1", () => started(root, "q1").length === 1);
  const b = startLane(root, "B");
  await until("B in q2", () => started(root, "q2").length === 1);
  touch(root, "STOP-A");
  await sleep(300);
  assert.ok(running(a), "A finishes the queue it is in");
  release(root, "q1");
  assert.equal(await a.exited, 0);
  assert.ok(!existsSync(path.join(root, "lane", "STOP-A")), "the lane removes its own STOP file");
  assert.ok(running(b), "B is not affected");
  assert.match(logOf(root, "A"), /lane A: STOP file: lane ends/);
  release(root, "q2");
  await until("B to finish the rest", () => done(root).length === 4);
  assert.deepEqual(started(root).filter((c) => c.lane === "A").map((c) => c.queue), ["q1"]);
  assert.deepEqual(started(root).filter((c) => c.lane === "B").map((c) => c.queue), ["q2", "q3", "q4"]);
  touch(root, "STOP-B");
  assert.equal(await b.exited, 0);
});

test("STOP-ALL ends every lane after its current queue and keeps new lanes from starting", async () => {
  const root = host(["q1", "q2", "q3", "q4"]);
  marker(root, "hold", "q1");
  marker(root, "hold", "q2");
  const a = startLane(root, "A");
  await until("A in q1", () => started(root, "q1").length === 1);
  const b = startLane(root, "B");
  await until("B in q2", () => started(root, "q2").length === 1);
  touch(root, "STOP-ALL");
  await sleep(250);
  assert.ok(running(a) && running(b), "both finish the queue in hand");
  release(root, "q1");
  release(root, "q2");
  assert.equal(await a.exited, 0);
  assert.equal(await b.exited, 0);
  assert.deepEqual(started(root).map((c) => c.queue).sort(), ["q1", "q2"], "q3 and q4 were not started");
  assert.deepEqual(pending(root), ["q3", "q4"]);
  assert.ok(existsSync(path.join(root, "lane", "STOP-ALL")), "no lane removes STOP-ALL");
  const late = startLane(root, "C");
  assert.equal(await late.exited, 0);
  assert.equal(started(root).length, 2, "a lane started under STOP-ALL runs nothing");
  assert.match(logOf(root, "C"), /STOP-ALL file: lane ends/);
});

test("a non-zero driver exit stops the lane and parks the queue under it: others skip it, --release-stale frees it, a live claim stays", async () => {
  const root = host(["q1", "q2", "q3", "q4"]);
  marker(root, "fail", "q1");
  marker(root, "hold", "q3");
  const a = startLane(root, "A");
  assert.equal(await a.exited, 7, "the lane exits with the driver's status");
  assert.match(logOf(root, "A"), /queue q1 exit=7/);
  assert.match(logOf(root, "A"), /lane stops on non-zero exit/);
  assert.deepEqual(pending(root), ["q1", "q2", "q3", "q4"], "the failed queue stays pending");
  assert.deepEqual(claims(root), ["q1"], "and keeps its claim");
  assert.match(readFileSync(path.join(root, "lane", "claims", "q1", "holder"), "utf8"), /^lane=A$/m);
  const b = startLane(root, "B");
  await until("B to hold q3", () => started(root, "q3").length === 1);
  assert.equal(started(root, "q1").length, 1, "B did not take over A's queue");
  assert.deepEqual(claims(root), ["q1", "q3"]);
  const released = spawnSync("bash", [LANE, "--release-stale"], { env: { ...process.env, BENCH_LANE_ROOT: root }, encoding: "utf8" });
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /released q1/);
  assert.doesNotMatch(released.stdout, /q3/);
  assert.deepEqual(claims(root), ["q3"], "only the dead lane's claim went");
  const status = spawnSync("bash", [LANE, "--status"], { env: { ...process.env, BENCH_LANE_ROOT: root }, encoding: "utf8" });
  assert.match(status.stdout, /q3: claimed by lane B \(running\)/);
  assert.match(status.stdout, /q1: unclaimed/);
  assert.match(status.stdout, /A: not running/);
  unmark(root, "fail", "q1");
  release(root, "q3");
  await until("everything done", () => done(root).length === 4);
  assert.equal(started(root, "q1").length, 2, "q1 ran again, by B, after the claim was released");
  assert.equal(started(root, "q1")[1].lane, "B");
  await stopAll(root, b);
});

test("a restarted lane resumes the queue it still holds before taking a new one", async () => {
  const root = host(["q1", "q2"]);
  marker(root, "fail", "q1");
  const first = startLane(root, "A");
  assert.equal(await first.exited, 7);
  // the operator puts another queue in front while the lane is down
  writeFileSync(path.join(root, "queue", "q0.jsonl"), `${JSON.stringify({ key: "q0/1", prompt: "p" })}\n`);
  writeFileSync(path.join(root, "lane", "pending.txt"), "q0\nq1\nq2\n");
  unmark(root, "fail", "q1");
  const second = startLane(root, "A");
  await until("all three done", () => done(root).length === 3);
  assert.deepEqual(started(root).map((c) => c.queue), ["q1", "q1", "q0", "q2"], "the held queue q1 came before the new head q0");
  await stopAll(root, second);
});

test("a second start of the same lane id is refused while the first lives; bad ids are refused", async () => {
  const root = host(["q1"]);
  marker(root, "hold", "q1");
  const a = startLane(root, "A");
  await until("A in q1", () => started(root, "q1").length === 1);
  const twin = startLane(root, "A");
  assert.equal(await twin.exited, 3);
  assert.match(twin.output(), /lane A is already running/);
  assert.equal(started(root).length, 1, "q1 was not run twice");
  for (const bad of ["default", "a b", "../x", "-x"]) {
    const refused = spawnSync("bash", [LANE, bad], { env: { ...process.env, BENCH_LANE_ROOT: root, BENCH_LANE_RUN: FAKE }, encoding: "utf8" });
    assert.equal(refused.status, 2, `${bad}: ${refused.stderr}`);
  }
  release(root, "q1");
  await until("q1 done", () => done(root).length === 1);
  await stopAll(root, a);
});

test("the default lane is the single lane as before: lane.log, lane/STOP, bench-<queue>, queue order, pause keeps the queue pending", async () => {
  const root = host(["q1", "q2", "q3"]);
  marker(root, "hold", "q2");
  const lane = startLane(root);
  await until("q2 running", () => started(root, "q2").length === 1);
  assert.deepEqual(started(root).map((c) => c.queue), ["q1", "q2"], "queues run one after another in pending.txt order");
  assert.deepEqual(started(root).map((c) => c.lane), ["default", "default"]);
  assert.deepEqual(started(root).map((c) => c.extra), ["bench-q1", "bench-q2"], "the container name carries no lane suffix");
  assert.ok(existsSync(path.join(root, "lane", "lane.log")) && existsSync(path.join(root, "lane", "lane.lock")));
  touch(root, "STOP");
  release(root, "q2");
  assert.equal(await lane.exited, 0);
  assert.ok(!existsSync(path.join(root, "lane", "STOP")), "lane/STOP is consumed");
  assert.deepEqual(pending(root), ["q3"], "q3 never started");
  assert.deepEqual(done(root), ["q1", "q2"]);
  const text = logOf(root);
  assert.match(text, /^\S+ lane start image=\(BENCH_LANE_RUN\)$/m);
  assert.match(text, /^\S+ queue q1 start$/m);
  assert.match(text, /^\S+ queue q1 exit=0$/m);
  assert.match(text, /^\S+ STOP file: lane ends$/m);
  assert.doesNotMatch(text, /lane default:/, "the default lane's log lines carry no lane prefix");

  // a queue paused by the driver's own STOP stays pending and its claim is released; a restart resumes it
  const paused = host(["p1", "p2"]);
  marker(paused, "pause", "p1");
  marker(paused, "hold", "p1");
  const stopped = startLane(paused);
  await until("p1 running", () => started(paused, "p1").length === 1);
  touch(paused, "STOP"); // the operator touches both: the driver's STOP ends the queue, the lane's STOP ends the lane
  release(paused, "p1");
  assert.equal(await stopped.exited, 0);
  assert.match(logOf(paused), /queue p1 paused by STOP; stays pending/);
  assert.deepEqual(pending(paused), ["p1", "p2"]);
  assert.deepEqual(claims(paused), []);
  assert.ok(!existsSync(path.join(paused, "results", "p1", "STOP")), "the driver's STOP file is consumed");
  const resumed = startLane(paused);
  await until("both done", () => done(paused).length === 2);
  assert.deepEqual(started(paused).map((c) => c.queue), ["p1", "p1", "p2"]);
  await stopAll(paused, resumed);
});

test("the default lane and a named lane share the list without colliding", async () => {
  const root = host(["q1", "q2", "q3"]);
  marker(root, "hold", "q1");
  const def = startLane(root);
  await until("default in q1", () => started(root, "q1").length === 1);
  const named = startLane(root, "N");
  await until("N finished q2 and q3", () => done(root).length === 2);
  assert.deepEqual(started(root).filter((c) => c.lane === "N").map((c) => c.queue), ["q2", "q3"]);
  release(root, "q1");
  await until("all", () => done(root).length === 3);
  await stopAll(root, def, named);
});

test("lane.sh is shellcheck-clean when shellcheck is installed", { skip: spawnSync("shellcheck", ["--version"]).error ? "shellcheck is not installed" : false }, () => {
  const result = spawnSync("shellcheck", ["-x", LANE, FAKE], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
});
