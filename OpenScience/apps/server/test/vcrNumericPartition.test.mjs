// The numeric suite's CI shards, held to "every case once". CI cannot be run from here, so the guard is tested the way CI
// uses it: the committed partition against the committed cases, and the merge against shard reports shaped as R writes them.
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assignMissing, declaredCases, partitionProblems, readPartition, serialize } from "../../../scripts/vcr/numeric-partition.mjs";
import { assemble, coverage } from "../../../scripts/vcr/merge-numeric-shards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(HERE, "../../../../项目代码/vcr-engine");

/** A tiny engine tree: three cases in two files, a partition of two shards and the final one. */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vcr-partition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tests/numeric"), { recursive: true });
  await writeFile(path.join(root, "tests/numeric/A.R"), 'vcr_case("A1", c("AC-04"), function() {\n})\nvcr_case("A2", c("AC-04"), function() {\n})\n# vcr_case("A3", c("x"), function() {\n');
  await writeFile(path.join(root, "tests/numeric/Z.R"), 'vcr_case("Z99", c("AC-04"), function() {\n})\n');
  const partition = { version: 1, basis: "test", shards: [["A1"], ["A2"]], final: ["Z99"] };
  await writeFile(path.join(root, "tests/numeric-partition.json"), serialize(partition));
  return { root, partition };
}

test("the committed partition names every case the suite declares exactly once", () => {
  const declared = declaredCases(engineRoot);
  assert.ok(declared.found.length > 400, `only ${declared.found.length} cases were found: the scan read nothing`);
  assert.deepEqual(partitionProblems(declared, readPartition(engineRoot)), []);
  assert.ok(readPartition(engineRoot).shards.length >= 2);
  assert.deepEqual(readPartition(engineRoot).final, ["Z99"], "the coverage walk needs the whole run's record");
});

test("a new case, a duplicate and a stale name each fail loudly, and --assign puts the new case in the lightest shard", async (t) => {
  const { root, partition } = await fixture(t);
  const declared = declaredCases(root);
  assert.deepEqual(declared.found.map((item) => item.id), ["A1", "A2", "Z99"], "a commented-out case is not declared");
  assert.deepEqual(partitionProblems(declared, partition), []);

  const grown = { found: [...declared.found, { id: "N200", file: "A.R", line: 9 }], unreadable: [] };
  assert.match(partitionProblems(grown, partition).join("\n"), /N200 .* is in no shard: it would never run in CI/);
  const { partition: next, added } = assignMissing(grown, { ...partition, shards: [["A1", "A2"], []] });
  assert.deepEqual(added, [{ id: "N200", shard: 2 }]);
  assert.deepEqual(partitionProblems(grown, next), []);

  assert.match(partitionProblems(declared, { ...partition, shards: [["A1", "A2"], ["A2"]] }).join("\n"), /A2 is in shard 1 and in shard 2: it would run twice/);
  assert.match(partitionProblems(declared, { ...partition, shards: [["A1", "GONE"], ["A2"]] }).join("\n"), /GONE is in shard 1 and no vcr_case declares it/);
  assert.match(partitionProblems(declared, { ...partition, shards: [["A1", "A2"], []] }).join("\n"), /shard 2 owns no case/);
  assert.match(partitionProblems({ found: [], unreadable: [] }, partition).join("\n"), /the scan read nothing/);
  assert.match(partitionProblems({ found: declared.found, unreadable: ["A.R:9"] }, partition).join("\n"), /A\.R:9/);
  assert.match(partitionProblems(declared, { version: 1, shards: [["A1", "A2"]], final: ["Z99"] }).join("\n"), /at least two/);
});

const run = (ids, shard, extra = {}) => ({
  schemaVersion: 1, sourceRevision: "a".repeat(40), rVersion: "4.3.3", packageLockHash: "h", methods: { m: { version: "1.0.0" } },
  cases: ids.map((id) => ({ id, ac: "AC-04", pass: true, detail: `${id} ok`, seconds: 1 })),
  methodsByCase: Object.fromEntries(ids.filter((id) => id !== "Z99").map((id) => [id, id === "A1" ? "m" : ["m"]])),
  testOnly: "", skippedCaseIds: [], complete: false, shard, methodsRun: ["m"], ...extra,
});
const logOf = (ids) => `vcr-engine 1 | R 4.3.3\n\n${ids.map((id) => `${id}   PASS AC-04 | ${id} ok  [1.0s]`).join("\n")}\n\nPASSED ${ids.length}/${ids.length}\n`;

async function shardsDir(t, parts) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vcr-shards-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, report, log] of parts) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, "vcr-numerical-evidence.json"), JSON.stringify(report));
    await writeFile(path.join(directory, name, "vcr-numeric.log"), log);
  }
  return directory;
}

test("the merge is the one complete report the importer reads, and refuses a shard that is missing, repeated or wrong", async (t) => {
  const { root } = await fixture(t);
  const good = [["s1", run(["A1"], "1"), logOf(["A1"])], ["s2", run(["A2"], "2"), logOf(["A2"])]];
  const dir = await shardsDir(t, good);
  const final = run(["Z99"], "final");
  const merged = assemble({ directory: dir, engine: root, finalReport: final, finalLog: logOf(["Z99"]) });
  assert.equal(merged.report.complete, true);
  assert.equal(merged.report.testOnly, "");
  assert.deepEqual(merged.report.cases.map((item) => item.id), ["A1", "A2", "Z99"]);
  assert.deepEqual(Object.keys(merged.report).sort(), ["cases", "complete", "methods", "methodsByCase", "packageLockHash", "rVersion", "schemaVersion", "skippedCaseIds", "sourceRevision", "testOnly"], "only the fields the importer allows");
  assert.match(merged.log, /\nPASSED 3\/3\n$/);
  assert.equal((merged.log.match(/^A1 +PASS/gm) ?? []).length, 1);
  assert.deepEqual(coverage(dir, root), { methodsRun: ["m"], methodsByCase: { A1: ["m"], A2: ["m"] } });

  const refused = async (name, parts, finalRun, message) => {
    const directory = await shardsDir(t, parts);
    assert.throws(() => assemble({ directory, engine: root, finalReport: finalRun, finalLog: logOf(["Z99"]) }), message, name);
  };
  await refused("a shard that produced nothing", [good[0]], final, /shard 2 produced no evidence/);
  await refused("a shard that ran another's case", [good[0], ["s2", run(["A1"], "2"), logOf(["A1"])]], final, /shard 2: it ran the wrong cases \(missing A2/);
  await refused("a shard that skipped a case", [good[0], ["s2", run([], "2"), logOf([])]], final, /shard 2: it ran the wrong cases/);
  await refused("a failing case", [good[0], ["s2", run(["A2"], "2", { cases: [{ id: "A2", pass: false, detail: "no", seconds: 1 }] }), logOf(["A2"])]], final, /failing cases A2/);
  await refused("a filtered shard", [good[0], ["s2", run(["A2"], "2", { testOnly: "A" }), logOf(["A2"])]], final, /a filtered run/);
  await refused("another revision", [good[0], ["s2", run(["A2"], "2", { sourceRevision: "b".repeat(40) }), logOf(["A2"])]], final, /disagree on sourceRevision/);
  await refused("the same shard twice", [good[0], ["s2", run(["A1"], "1"), logOf(["A1"])]], final, /present twice/);
  await refused("a final run that is not the final shard", good, run(["Z99"], "1"), /not the final shard/);
  await refused("a final run that ran nothing", good, run([], "final"), /final: it ran the wrong cases/);
});

test("the checker's CLI is what CI calls and names the case it refuses", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { root } = await fixture(t);
  const script = path.resolve(HERE, "../../../scripts/vcr/numeric-partition.mjs");
  const call = (/** @type {string[]} */ args, /** @type {string} */ engine) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", VCR_ENGINE_ROOT: engine } });
  assert.equal(call([], root).status, 0);
  assert.equal(call(["--count", "final"], root).stdout.trim(), "1");
  assert.equal(call(["--ids", "2"], root).stdout.trim(), "A2");
  await cp(root, `${root}-grown`, { recursive: true });
  t.after(() => rm(`${root}-grown`, { recursive: true, force: true }));
  await writeFile(path.join(`${root}-grown`, "tests/numeric/N.R"), 'vcr_case("N77x", c("AC-04"), function() {\n})\n');
  const bad = call([], `${root}-grown`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /N77x/);
  assert.equal(call(["--count", "9"], root).status, 1);
});
