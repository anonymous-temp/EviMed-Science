import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/ops/gate-health.mjs", import.meta.url));

/** @param {string} root @param {string[]} args */
function run(root, args = []) {
  return execFileSync(process.execPath, [script, "--ledger", root, ...args], { encoding: "utf8" });
}

/** One finished event, in the shape `agentRuns.mjs` appends. */
function finished(overrides) {
  return `${JSON.stringify({
    event: "finished", id: "run_1", status: "failed", durationMs: 1000,
    finishedAt: new Date().toISOString(), artifacts: [], ...overrides,
  })}\n`;
}

test("the ledger walk reaches the meta directory the ledger actually lives in", async (t) => {
  // The bug this pins, found against production: `runs.jsonl` lives in each
  // project's `.openscience/` directory, and the walk skipped hidden names —
  // correct when hunting for report packages, catastrophic here. It found zero
  // ledgers on a host holding 41 and reported "0 finished runs" about a
  // deployment with 179, which is indistinguishable from a healthy quiet system.
  const root = await mkdtemp(path.join(tmpdir(), "gate-health-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "users", "u1", "projects", "p1", ".openscience");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "runs.jsonl"), [
    finished({ id: "r1", status: "succeeded", errorCode: null, artifacts: ["deliverables/d1/report.md"] }),
    finished({ id: "r2", errorCode: "specialist_required_output_missing" }),
    finished({ id: "r3", errorCode: "specialist_required_output_missing" }),
  ].join(""));

  const out = run(root);
  assert.match(out, /from 1 run ledger\(s\)/, "the scan must say it found the ledger, or a zero result proves nothing");
  assert.match(out, /3 finished runs, 2 recorded no artifacts/);
  assert.match(out, /specialist_required_output_missing/);
});

test("a scan that found nothing fails instead of reporting a clean bill of health", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gate-health-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => run(root), (error) => {
    assert.equal(error.status, 2, "an empty scan must not exit 0");
    assert.match(String(error.stderr), /nothing was measured/);
    return true;
  });
});

test("the two review flags are the ones principle #4 asks for", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gate-health-flags-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "p", ".openscience");
  await mkdir(project, { recursive: true });
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const lines = [finished({ id: "ok", status: "succeeded", errorCode: null, artifacts: ["a"] })];
  // Fires on three of four runs — over the half-of-traffic line.
  for (const id of ["a", "b", "c"]) lines.push(finished({ id, errorCode: "noisy_check" }));
  lines.push(finished({ id: "z", errorCode: "quiet_check", finishedAt: old }));
  await writeFile(path.join(project, "runs.jsonl"), lines.join(""));

  const out = run(root);
  assert.match(out, /noisy_check\s+<-- always-fires/, "a check tripping most runs has stopped carrying information");
  assert.match(out, /quiet_check\s+<-- silent-30d/, "a check that has not fired in a month is unnecessary or broken");
  // Counted over the table rows, not over the whole output: the closing
  // paragraph explains both flag names, so a substring count finds them there
  // and proves nothing about the table.
  const flagged = out.split("\n").filter((line) => /^\s+\d/.test(line) && line.includes("<--"));
  assert.equal(flagged.length, 2, `exactly the two flagged rows: ${JSON.stringify(flagged)}`);
});

test("the same walk summarizes the refusals that never became runs", async (t) => {
  // `errors.jsonl` sits beside `runs.jsonl` and holds what was refused before a
  // run existed: a spend ceiling, a bad credential, an unreachable source.
  // Nothing read it on a schedule, so the only way anyone learned what was in
  // it was to aggregate it by hand after something had already gone wrong —
  // which is how eighteen gateway refusals sat unexplained for five days.
  const root = await mkdtemp(path.join(tmpdir(), "gate-health-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meta = path.join(root, "users", "u1", "projects", "p1", ".openscience");
  await mkdir(meta, { recursive: true });
  await writeFile(path.join(meta, "runs.jsonl"), finished({ id: "r1", status: "succeeded", errorCode: null, artifacts: ["a.md"] }));
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  await writeFile(path.join(meta, "errors.jsonl"), [
    JSON.stringify({ createdAt: new Date().toISOString(), code: "unauthorized", status: 401 }),
    JSON.stringify({ createdAt: new Date().toISOString(), code: "unauthorized", status: 401 }),
    JSON.stringify({ createdAt: old, code: "public_source_gateway_token_invalid", status: 401 }),
    "not json at all",
  ].join("\n"));

  const out = run(root);
  // It must say how many ledgers it read, for the same reason the run walk
  // does: a summary that found nothing and one that read nothing print alike.
  assert.match(out, /HTTP refusals from 1 error ledger\(s\): 3 rows/, "an unparseable line must be skipped, not counted");
  assert.match(out, /2\s+last 0d ago\s+unauthorized/);
  assert.match(out, /1\s+last 40d ago\s+public_source_gateway_token_invalid/);
});

test("a deployment with no refusals says nothing rather than printing an empty table", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gate-health-no-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meta = path.join(root, "users", "u1", "projects", "p1", ".openscience");
  await mkdir(meta, { recursive: true });
  await writeFile(path.join(meta, "runs.jsonl"), finished({ id: "r1", status: "succeeded", errorCode: null, artifacts: ["a.md"] }));

  const out = run(root);
  assert.doesNotMatch(out, /HTTP refusals/);
  assert.match(out, /1 finished runs/);
});
