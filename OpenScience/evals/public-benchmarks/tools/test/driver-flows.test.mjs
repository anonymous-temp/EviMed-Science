// Tests of bench-driver.mjs's group, keepRuntime and personal-skill paths against the fake control plane (fake-server.mjs).
// Run: node tools/test/driver-flows.test.mjs   (from the benchmark work directory)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFake } from "./fake-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, "..", "bench-driver.mjs");
const helper = new URL("../../../../scripts/ops/throwaway-account.mjs", import.meta.url).pathname;
const t3Queue = path.join(here, "t3-skill.jsonl");

const SKILL = { title: "probe", description: "Mandatory: load before answering.", instructions: "End every reply with SKILL-PROBE-OK" };
const item = (key, group, extra = {}) => ({ key, group, prompt: `question ${key}`, timeoutMin: 1, collect: false, ...extra });

async function run(name, lines, { fake: fakeOptions = {}, flags = [] } = {}) {
  const fake = await startFake(fakeOptions);
  const out = await mkdtemp(path.join(tmpdir(), `bench-${name}-`));
  const queue = path.join(out, "queue.jsonl");
  await writeFile(queue, `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}\n`);
  const child = spawn("node", [driver, "--queue", queue, "--out", path.join(out, "results"), "--base", `http://127.0.0.1:${fake.port}`, "--poll-ms", "150", "--skill-warmup-s", "20", ...flags],
    { env: { ...process.env, BENCH_THROWAWAY_HELPER: helper }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const results = {};
  const resultDir = path.join(out, "results");
  for (const entry of await readdir(resultDir).catch(() => [])) {
    try { results[entry] = JSON.parse(await readFile(path.join(resultDir, entry, "result.json"), "utf8")); } catch { /* a file, or no result */ }
  }
  const calls = fake.state.calls;
  const done = { code, log, results, calls, state: fake.state };
  fake.close();
  return done;
}
const callsOf = (r, what, project) => r.calls.filter((call) => call.what === what && (project === undefined || call.project === project));
const projectOf = (r, group) => r.calls.find((call) => call.what === "project-create" && call.project.startsWith(`bench-${group}-`))?.project;

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}\n${error.stack}`); }
}

await test("t3-skill.jsonl: alternating base/skill, both runtimes kept, skill mounted from the first run", async () => {
  const lines = (await readFile(t3Queue, "utf8")).trim().split("\n");
  const r = await run("t3", lines);
  assert.equal(r.code, 0, r.log);
  assert.ok(r.state.accountDeleted, "account deleted");
  assert.deepEqual(Object.keys(r.results).sort(), ["t3__base-1", "t3__base-2", "t3__skill-1", "t3__skill-2"]);
  for (const key of Object.keys(r.results)) assert.equal(r.results[key].status, "succeeded", key);
  const base = projectOf(r, "t3-base"), skill = projectOf(r, "t3-skill");
  // The control arm: nothing selected, nothing mounted.
  for (const key of ["t3__base-1", "t3__base-2"]) {
    assert.equal(r.results[key].groupSkill, null);
    assert.deepEqual(r.results[key].skillSelectionBefore, { revision: 1, selected: 0 });
    assert.deepEqual(r.results[key].personalPinsInRun, []);
  }
  // The skill arm: one skill, the same in both items, proven before the first dispatch, mounted in both runs.
  const [a, b] = [r.results["t3__skill-1"], r.results["t3__skill-2"]];
  assert.equal(a.groupSkill.skillId, b.groupSkill.skillId);
  assert.equal(a.groupSkill.digest, b.groupSkill.digest);
  assert.match(a.groupSkill.nativeName, /^personal-/);
  assert.equal(a.skillActivationBefore.phase, "effective");
  assert.equal(a.skillActivationAfter.phase, "effective");
  for (const x of [a, b]) {
    assert.equal(x.skillEvidence.mountedInRun, true);
    assert.equal(x.skillEvidence.catalogue.found, true);
    assert.equal(x.skillEvidence.loadedByModel, true);
    assert.equal(x.checks.expectInAnswer, true);
    assert.equal(x.skillSelectionBefore.selected, 1);
  }
  assert.equal(callsOf(r, "skill-create").length, 1);
  assert.equal(callsOf(r, "skill-select").length, 1);
  assert.equal(callsOf(r, "start_runtime", skill).length, 1, "one warm-up start of the skill project");
  // keepRuntime: no runtime was stopped while the lane moved between the groups; the lane end stopped them.
  const firstDispatch = r.calls.findIndex((c) => c.what === "dispatch");
  const lastDispatch = r.calls.map((c) => c.what).lastIndexOf("dispatch");
  const stopsBetween = r.calls.slice(firstDispatch, lastDispatch).filter((c) => c.what === "stop_runtime" && c.project === skill);
  assert.equal(stopsBetween.length, 0, "the skill runtime was kept");
  assert.equal(callsOf(r, "dispatch", skill).length, 2);
  assert.equal(callsOf(r, "dispatch", base).length, 2);
  // deleteGroupAfter on the last items: both projects deleted.
  assert.equal(callsOf(r, "project-delete").length, 2);
});

await test("without --no-skill-warmup the first run is the proof; with it the first run is not mounted and says so loudly", async () => {
  const lines = [item("w/1", "w", { groupSkill: SKILL, expectInAnswer: "SKILL-PROBE-OK" }), item("w/2", "w", { groupSkill: SKILL, expectInAnswer: "SKILL-PROBE-OK" })];
  const r = await run("nowarm", lines, { flags: ["--no-skill-warmup"] });
  assert.equal(r.code, 0, r.log);
  const [a, b] = [r.results["w__1"], r.results["w__2"]];
  assert.equal(a.skillActivationBefore.phase, "pending");
  assert.equal(a.skillEvidence.mountedInRun, false);
  assert.equal(a.checks.expectInAnswer, false);
  assert.match(r.log, /SKILL-NOT-MOUNTED item w\/1/);
  assert.match(r.log, /SKILL-ACTIVATION-WARN item w\/1: before the run/);
  // The held-back selection is mounted once the first run ended: the second run carries the skill.
  assert.equal(b.skillEvidence.mountedInRun, true, r.log);
  assert.equal(b.checks.expectInAnswer, true);
});

await test("default behaviour: a group change stops the previous group's runtime and deletes it when flagged", async () => {
  const r = await run("plain", [item("p/1", "ga"), item("p/2", "gb", { deleteGroupAfter: true })]);
  assert.equal(r.code, 0, r.log);
  const ga = projectOf(r, "ga"), gb = projectOf(r, "gb");
  const order = r.calls.map((c) => `${c.what}:${c.project}`);
  assert.ok(order.indexOf(`stop_runtime:${ga}`) < order.indexOf(`dispatch:${gb}`), "ga stopped before gb ran");
  assert.equal(callsOf(r, "project-delete", gb).length, 1);
  assert.equal(r.results["p__1"].skillSelectionBefore.selected, 0);
});

await test("keepRuntime keeps at most two runtimes: the third group makes the least recently used one yield", async () => {
  const keep = { keepRuntime: true };
  const r = await run("cap", [item("k/1", "ga", keep), item("k/2", "gb", keep), item("k/3", "gc", keep), item("k/4", "ga", keep)]);
  assert.equal(r.code, 0, r.log);
  const [ga, gb, gc] = ["ga", "gb", "gc"].map((g) => projectOf(r, g));
  const order = r.calls.map((c) => `${c.what}:${c.project}`);
  assert.ok(order.indexOf(`stop_runtime:${ga}`) > order.indexOf(`dispatch:${gb}`), "ga is not stopped when gb starts");
  assert.ok(order.indexOf(`stop_runtime:${ga}`) < order.indexOf(`dispatch:${gc}`), "ga yields before gc runs");
  assert.equal(callsOf(r, "stop_runtime", gb).filter((c) => order.indexOf(`stop_runtime:${gb}`) < order.indexOf(`dispatch:${gc}`)).length, 0, "gb stays while gc runs");
  assert.equal(callsOf(r, "project-create").length, 3, "ga comes back to its project");
});

await test("keepRuntime on one side of the change is enough (base flagged, skill group not)", async () => {
  const r = await run("oneside", [item("o/1", "ga", { keepRuntime: true }), item("o/2", "gb"), item("o/3", "ga", { keepRuntime: true }), item("o/4", "gb")]);
  assert.equal(r.code, 0, r.log);
  const [ga, gb] = ["ga", "gb"].map((g) => projectOf(r, g));
  const order = r.calls.map((c) => `${c.what}:${c.project}`);
  const dispatches = order.map((o, i) => [o, i]).filter(([o]) => o.startsWith("dispatch:"));
  const lastRunStart = dispatches.at(-1)[1];
  assert.equal(order.slice(0, lastRunStart).filter((o) => o === `stop_runtime:${ga}` || o === `stop_runtime:${gb}`).length, 0, "no stop between the four items");
});

await test("a group without a skill whose project has a selection is refused and never dispatched", async () => {
  const r = await run("rogue", [item("r/1", "ga")], { fake: { preselect: true } });
  assert.equal(r.results["r__1"].status, "driver_error");
  assert.match(r.results["r__1"].error, /no groupSkill but 1 personal skill\(s\) are selected/);
  assert.equal(callsOf(r, "dispatch").length, 0);
  assert.ok(r.state.accountDeleted);
});

await test("a skill that cannot be made is a driver error before any dispatch of that group, other groups go on", async () => {
  const r = await run("nocreate", [item("n/1", "ga", { groupSkill: SKILL }), item("n/2", "gb")], { fake: { failSkillCreate: true } });
  assert.equal(r.results["n__1"].status, "driver_error");
  assert.match(r.results["n__1"].error, /personal skill was not created \(503 product_state_unavailable\)/);
  assert.equal(r.results["n__2"].status, "succeeded");
  assert.equal(callsOf(r, "dispatch").length, 1);
});

await test("keys with # map to folders with _ and a collision is refused before an account is made", async () => {
  const ok = await run("hash", [item("bench/123#r1", "g"), item("bench/123#r2", "g")]);
  assert.equal(ok.code, 0, ok.log);
  assert.deepEqual(Object.keys(ok.results).sort(), ["bench__123_r1", "bench__123_r2"]);
  const clash = await run("clash", [item("a#r1", "g"), item("a_r1", "g")]);
  assert.notEqual(clash.code, 0);
  assert.match(clash.log, /same result folder a_r1/);
  assert.equal(clash.calls.length, 0);
});

await test("a group's items must carry the same skill, or none", async () => {
  const r = await run("mixed", [item("m/1", "ga", { groupSkill: SKILL }), item("m/2", "ga", { groupSkill: { ...SKILL, instructions: "other" } })]);
  assert.notEqual(r.code, 0);
  assert.match(r.log, /different groupSkill/);
});

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
