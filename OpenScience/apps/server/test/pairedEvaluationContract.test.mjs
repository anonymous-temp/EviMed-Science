/**
 * The control plane and the paired-evaluation harness, checked against each
 * other by running them.
 *
 * They disagreed for as long as both existed. `runPairedEvaluation` spawned
 * `--method/--candidate-digest/--baseline-digest` and parsed stdout as JSON;
 * `run_paired.py` accepted only `--config` and printed a human table. Each side
 * had tests and both suites were green, because neither suite ever ran the
 * other side — so no operator who configured the command could have got a
 * verdict, and the failure would have arrived as "the paired evaluation printed
 * no readable verdict" months later.
 *
 * This test spawns the real script. It is skipped where python3 is absent
 * rather than faked, because a fake would restore exactly the property that
 * made the original disagreement invisible.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const script = path.join(repoRoot, "evals/method-quality/run_paired.py");
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const havePython = python.status === 0;

/** The flags `runPairedEvaluation` appends, read off the server's own source
 *  rather than restated here: a test that lists them separately is a second
 *  opinion about the contract, which is what this file exists to prevent. */
async function serverFlags() {
  const source = await readFile(path.join(here, "../src/server.mjs"), "utf8");
  const block = source.slice(source.indexOf("function runPairedEvaluation("));
  const spawnCall = block.slice(block.indexOf("spawn(program, ["), block.indexOf("], { stdio"));
  return [...spawnCall.matchAll(/"(--[a-z-]+)"/g)].map((match) => match[1]);
}

test("the flags the server sends are flags the harness accepts", async (t) => {
  if (!havePython) return t.skip("python3 is not available");
  const flags = await serverFlags();
  assert.ok(flags.includes("--json"), "the server must ask for machine-readable output");
  assert.ok(flags.includes("--method") && flags.includes("--candidate-digest") && flags.includes("--baseline-digest"));
  const help = spawnSync("python3", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const flag of flags) {
    assert.match(help.stdout, new RegExp(flag.replace(/-/g, "\\-")), `the harness does not accept ${flag}`);
  }
});

test("the server's own command line produces one line the server can parse", async (t) => {
  if (!havePython) return t.skip("python3 is not available");
  const dir = await mkdtemp(path.join(tmpdir(), "evimed-paired-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // A template of the shape an operator configures: the brief set, budget and
  // judge are theirs, and only the two arms are synthesised around the
  // candidate the nightly job names.
  const briefsFile = path.join(dir, "briefs.json");
  await writeFile(briefsFile, JSON.stringify([{
    id: "contract-001", title: "契约用简报", family: "contract",
    inputs: { question: "question" }, mustDo: ["deliver"], mustNotDo: ["invent"],
  }]), "utf8");
  const splitsFile = path.join(dir, "splits.json");
  await writeFile(splitsFile, JSON.stringify({
    schemaVersion: 1, registryVersion: "method-quality/splits/1",
    dev: { briefs: ["contract-001"] }, holdout: { briefs: [] },
    regression: { briefs: [] }, chronological: { briefs: [] },
  }), "utf8");
  const templateFile = path.join(dir, "template.json");
  await writeFile(templateFile, JSON.stringify({
    id: "contract", capability: "test-capability", briefsFile, briefs: ["contract-001"],
    repeats: 1, seed: 1, concurrency: 1, margin: 0.02, bootstrapSamples: 50,
    project: { id: "eval-contract", name: "契约" },
    budget: { latencyCapMs: 60000, costCap: 1 },
    baseline: { methodSnapshot: { id: "template", records: [] }, compactionPolicy: "basic" },
  }), "utf8");

  // Exactly what `runPairedEvaluation` runs, plus the report-only switch so no
  // server is contacted. If the two sides disagree about a flag or about which
  // stream carries the verdict, this fails here rather than in production.
  const flags = await serverFlags();
  const args = [script, "--template", templateFile, "--splits", splitsFile,
    "--results-dir", path.join(dir, "results"), "--reports-dir", path.join(dir, "reports"), "--report-only"];
  for (const flag of flags) {
    args.push(flag);
    if (flag === "--method") args.push("method:learned:contract");
    if (flag === "--candidate-digest") args.push("sha256:candidate");
    if (flag === "--baseline-digest") args.push("sha256:baseline");
  }
  const run = spawnSync("python3", args, { encoding: "utf8", cwd: repoRoot });
  assert.equal(run.status, 0, `harness exited ${run.status}: ${run.stderr.slice(-500)}`);

  const lines = run.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `stdout must be one machine-readable line, got: ${JSON.stringify(lines)}`);
  const parsed = JSON.parse(lines.at(-1) ?? "");
  assert.equal(typeof parsed.verdict, "string");
  assert.equal(typeof parsed.report, "string");
  assert.equal(parsed.candidateDigest, "sha256:candidate");
  assert.equal(parsed.baselineDigest, "sha256:baseline");
  // And the human summary still exists, on the stream the server ignores.
  assert.match(run.stderr, /verdict:/);
});

test("the harness names the candidate arm's trial, so the two arms differ", async (t) => {
  if (!havePython) return t.skip("python3 is not available");
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location('runner', ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    "arms = mod.synthesize_arms({'baseline': {'methodSnapshot': {'id': 't', 'records': []}, 'compactionPolicy': 'basic'}},",
    "                           'method:learned:x', 'sha256:c', 'sha256:b')",
    "print(json.dumps({'candidate': arms['candidate']['methodSnapshot']['trialMethodIds'],",
    "                  'baseline': arms['baseline']['methodSnapshot']['trialMethodIds']}))",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const arms = JSON.parse(probe.stdout.trim());
  assert.deepEqual(arms.candidate, ["method:learned:x"], "the candidate arm must mount the candidate");
  assert.deepEqual(arms.baseline, [], "the baseline arm must mount nothing extra, or the arms are the same arm");
});
