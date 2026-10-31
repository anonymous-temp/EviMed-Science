// Tests of bench-driver.mjs's group, keepRuntime, personal-skill, file-capture, timeout and dispatch-retry paths against the fake
// control plane (fake-server.mjs).
// Run: node tools/test/driver-flows.test.mjs   (about two minutes; TEST_FILTER=<regexp on the test name> runs a subset)
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
  const done = { code, log, results, calls, state: fake.state, out: resultDir };
  fake.close();
  return done;
}
const callsOf = (r, what, project) => r.calls.filter((call) => call.what === what && (project === undefined || call.project === project));
const projectOf = (r, group) => r.calls.find((call) => call.what === "project-create" && call.project.startsWith(`bench-${group}-`))?.project;

let failures = 0;
async function test(name, fn) {
  if (process.env.TEST_FILTER && !new RegExp(process.env.TEST_FILTER).test(name)) return; // TEST_FILTER=timeout node …: a subset
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

// ------------------------------------------------------------------------------------------------ file capture, timeouts, retries

const textFile = (text, ago = 0) => ({ text, ago });
const exists = async (file) => readFile(file, "utf8").then(() => true, () => false);

await test("report-like files are read first: a report listed behind 45 code files is captured, the code is what the cap cuts", async () => {
  const code = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`code/step_${String(i).padStart(2, "0")}.py`, textFile(`print(${i})`)]));
  const files = { ...code, "outputs/tables/t.csv": textFile("a,b\n1,2"), "notes/old.md": textFile("old", 600), "notes/new.md": textFile("newer note", 5),
    "deliverables/x/report.md": textFile("# Deliverable\n".repeat(50), 100), "report/report.md": textFile("# Report\nfinal"), "report/images/fig1.png": textFile("png") };
  const r = await run("cap", [item("c/1", "g", { collect: true })], { fake: { scenario: () => ({ files }) }, flags: ["--retry-scale", "0.001"] });
  assert.equal(r.code, 0, r.log);
  const res = r.results["c__1"];
  const saved = new Map(res.files.filter((f) => f.saved).map((f) => [f.path, f]));
  assert.equal(res.files.filter((f) => f.saved).length, 40);
  for (const name of ["report/report.md", "deliverables/x/report.md", "notes/new.md", "notes/old.md", "report/images/fig1.png"]) assert.ok(saved.has(name), `${name} captured`);
  assert.ok(await exists(path.join(r.out, "c__1", "files", "report", "report.md")));
  const more = res.files.find((f) => /^\(\d+ more\)$/.test(f.path));
  assert.ok(more, "the cut is listed");
  assert.equal(more.reportLikeLeft, 0, "no report-like file was cut");
  assert.ok(res.files.findIndex((f) => f.path === "report/report.md") < res.files.findIndex((f) => f.path === "code/step_00.py"), "documents before code");
  // Same mtime tier: the newer document first, the larger one before a smaller one of the same age.
  const pos = (name) => res.files.findIndex((f) => f.path === name);
  assert.ok(pos("report/report.md") < pos("deliverables/x/report.md") && pos("notes/new.md") && pos("notes/new.md") < pos("deliverables/x/report.md") && pos("deliverables/x/report.md") < pos("notes/old.md"), "newest first");
  assert.equal(res.lastReport, undefined, "lastReport belongs to a timeout");
});

await test("a run that times out: the workspace is scanned, the newest report-like files are captured and lastReport names the newest document", async () => {
  const upload = path.join(await mkdtemp(path.join(tmpdir(), "bench-up-")), "readme.md");
  await writeFile(upload, "# an input, not a report\n");
  // `ago` is seconds before the dispatch: the draft and the report were written during the run (the report later), the stale file before it.
  const files = { "report/draft.md": textFile("# Draft\nhalf", 0), "report/report.md": textFile("# Report v2\nmore text here", -2), "code/a.py": textFile("x=1"),
    "old/stale.md": textFile("written before the dispatch", 7200), "report/figures/f.png": textFile("png", -1),
    "notes/todo.md": textFile("- [ ] finish the report", -5) };
  const scenario = () => ({ files, hang: true, unlisted: true, writes: [{ atMs: 700, tool: "write", path: "/workspace/report/draft.md" }, { atMs: 1100, tool: "write", path: "/workspace/report/report.md" }] });
  const r = await run("timeout", [item("t/1", "g", { collect: true, timeoutMin: 0.03, files: [{ src: upload, dest: "inputs/readme.md" }] })], { fake: { scenario }, flags: ["--retry-scale", "0.001"] });
  assert.equal(r.code, 0, r.log);
  const res = r.results["t__1"];
  assert.equal(res.status, "timeout");
  assert.equal(res.deliveredWithinCap, false);
  assert.equal(res.lastReport.path, "report/report.md", "a scratch note written last does not stand for the report");
  assert.equal(res.lastReport.saved, true);
  assert.equal(res.lastReport.bytes, Buffer.byteLength("# Report v2\nmore text here"));
  const project = [...r.state.projects.values()][0];
  assert.equal(new Date(res.lastReport.mtime).getTime(), project.files.get("report/report.md").mtime * 1000);
  const saved = res.files.filter((f) => f.saved).map((f) => f.path);
  assert.ok(saved.includes("report/report.md") && saved.includes("report/draft.md") && saved.includes("notes/todo.md"), `captured: ${saved}`);
  assert.ok(!saved.includes("old/stale.md") && !saved.includes("inputs/readme.md"), "files from before the dispatch and the item's own uploads are not reports of the run");
  assert.equal(res.firstReportAtMs, 700);
  assert.equal(res.firstReportPath, "report/draft.md");
  assert.equal(await readFile(path.join(r.out, "t__1", "files", "report", "report.md"), "utf8"), "# Report v2\nmore text here");
});

await test("a timeout with nothing report-like written records lastReport null, never a guess", async () => {
  const scenario = () => ({ files: { "code/a.py": textFile("x=1") }, hang: true, unlisted: true });
  const r = await run("noreport", [item("n/1", "g", { collect: true, timeoutMin: 0.03 })], { fake: { scenario }, flags: ["--retry-scale", "0.001"] });
  const res = r.results["n__1"];
  assert.equal(res.status, "timeout");
  assert.equal(res.lastReport, null);
  assert.equal(res.firstReportAtMs, null);
  assert.equal(res.deliveredWithinCap, false);
});

await test("firstReportAtMs: the first completed write of a report-like file, by the write tool or a shell command; reads and failed writes do not count", async () => {
  const writes = [
    { atMs: 100, tool: "write", path: "/workspace/code/a.py" },
    { atMs: 200, tool: "bash", command: "cat report/report.md | head -5" },
    { atMs: 300, tool: "write", path: "/workspace/report/lost.md", status: "error" },
    { atMs: 400, tool: "write", path: "/tmp/scratch.md" },
    { atMs: 2500, tool: "bash", command: "pandoc notes.md -o report/final.docx" },
    { atMs: 5000, tool: "write", path: "/workspace/report/report.md" },
  ];
  const r = await run("first", [item("f/1", "g", { collect: false }), item("f/2", "g", { collect: false })], { fake: { scenario: (body) => ({ writes: body.text.includes("f/2") ? [{ atMs: 900, tool: "bash", command: "python - <<'EOF'\nfrom pathlib import Path\nPath(\"report/x.md\").write_text('hi')\nEOF" }] : writes }) } });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.results["f__1"].firstReportAtMs, 2500);
  assert.equal(r.results["f__1"].firstReportPath, "report/final.docx");
  assert.equal(r.results["f__2"].firstReportAtMs, 900);
  assert.equal(r.results["f__2"].firstReportPath, "report/x.md");
  assert.equal(r.results["f__1"].deliveredWithinCap, true);
});

await test("deliveredWithinCap and firstReportAtMs are null/false when the run wrote nothing report-like and left no answer", async () => {
  const r = await run("empty", [item("e/1", "g", { collect: false })], { fake: { scenario: () => ({ answer: "" }) } });
  const res = r.results["e__1"];
  assert.equal(res.firstReportAtMs, null);
  assert.equal(res.deliveredWithinCap, false);
});

await test("a dispatch answered 503/500 is infrastructure: retried with backoff, recorded, and the item runs", async () => {
  const refuse = [503, 500];
  const r = await run("infra", [item("i/1", "g")], { fake: { scenario: () => ({ refuse }) }, flags: ["--retry-scale", "0.001"] });
  assert.equal(r.code, 0, r.log);
  const res = r.results["i__1"];
  assert.equal(res.status, "succeeded");
  assert.deepEqual(res.dispatchRetries.map((x) => [x.status, x.kind]), [[503, "infrastructure"], [500, "infrastructure"]]);
  assert.deepEqual(res.infrastructure, { retries: 2, statuses: [503, 500] });
  assert.equal(res.infrastructureFailure, undefined);
  assert.match(r.log, /infrastructure, asking again/);
  assert.equal(callsOf(r, "dispatch-refused").length, 2);
});

await test("a dispatch refused 429 is busy, not infrastructure; a refusal that is not retried ends the item at once", async () => {
  const once = [429];
  const busy = await run("busy", [item("b/1", "g")], { fake: { scenario: () => ({ refuse: once }) }, flags: ["--retry-scale", "0.001"] });
  assert.equal(busy.results["b__1"].status, "succeeded");
  assert.equal(busy.results["b__1"].dispatchRetries[0].kind, "busy");
  assert.equal(busy.results["b__1"].infrastructure, undefined);
  const nope = [400];
  const hard = await run("hard", [item("h/1", "g")], { fake: { scenario: () => ({ refuse: nope }) }, flags: ["--retry-scale", "0.001"] });
  assert.equal(hard.results["h__1"].status, "dispatch_refused");
  assert.equal(hard.results["h__1"].dispatchRetries, undefined);
  assert.equal(hard.results["h__1"].infrastructureFailure, undefined);
});

await test("a platform that stays down is dispatch_refused after the bounded backoff, marked as infrastructure, and the item is run again next start", async () => {
  const refuse = Array.from({ length: 40 }, () => 503);
  const r = await run("down", [item("d/1", "g")], { fake: { scenario: () => ({ refuse }) }, flags: ["--retry-scale", "0.0005"] });
  const res = r.results["d__1"];
  assert.equal(res.status, "dispatch_refused");
  assert.equal(res.errorCode, "product_state_unavailable");
  assert.equal(res.infrastructureFailure, true);
  assert.equal(res.infrastructure.retries, 12);
  assert.equal(res.dispatchRetries.length, 12);
  assert.equal(callsOf(r, "dispatch-refused").length, 13, "12 retries and the last answer");
  assert.ok(r.state.accountDeleted);
});

await test("timeBudgetMinutes is sent to the dispatch only when the item sets it, and recorded", async () => {
  const r = await run("budget", [item("tb/1", "g", { timeBudgetMinutes: 20, timeoutMin: 30 }), item("tb/2", "g")]);
  assert.equal(r.code, 0, r.log);
  const [a, b] = r.state.dispatchBodies;
  assert.equal(a.timeBudgetMinutes, 20);
  assert.equal(Object.hasOwn(b, "timeBudgetMinutes"), false, "an item without the field sends none");
  assert.equal(r.results["tb__1"].timeBudgetMinutes, 20);
  assert.equal(r.results["tb__2"].timeBudgetMinutes, undefined);
  for (const bad of [0, -3, "20", 2000, null]) {
    const refused = await run("budgetbad", [item("tb/3", "g", { timeBudgetMinutes: bad })]);
    assert.notEqual(refused.code, 0, `${JSON.stringify(bad)} is refused`);
    assert.match(refused.log, /timeBudgetMinutes must be a number above 0/);
    assert.equal(refused.calls.length, 0, "before any account is made");
  }
  const warned = await run("budgetwarn", [item("tb/4", "g", { timeBudgetMinutes: 5, timeoutMin: 3 })]);
  assert.match(warned.log, /WARN .*timeBudgetMinutes 5 is not below/);
  assert.equal(warned.code, 0, warned.log);
});

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
