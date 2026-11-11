import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkpointsFor, directoryDigest, parseArguments, runIdOf, upsertJsonl } from "../run/run.mjs";

const base = ["--set", "synthetic-users", "--split", "dev", "--data", "/d", "--out", "/runs/r1"];
const engine = ["--engine-url", "http://127.0.0.1:1", "--engine-key-file", "/k", "--database-url-file", "/u"];

test("arguments: arm product needs the engine; answering needs a model key; --ingest-only needs neither key", () => {
  const options = parseArguments([...base, ...engine, "--ingest-only", "--only", "U01", "--max-sessions", "6", "--no-history-search", "--commit-every", "turn"]);
  assert.equal(options.arm, "product");
  assert.equal(options.ingestOnly, true);
  assert.equal(options.maxSessions, 6);
  assert.equal(options.historySearch, false);
  assert.equal(options.commitEvery, "turn");
  assert.equal(options.concurrency, 3);
  assert.throws(() => parseArguments([...base, "--ingest-only"]), /needs --engine-url/);
  assert.throws(() => parseArguments([...base, ...engine]), /--deepseek-key-file/);
  assert.equal(parseArguments([...base, "--arm", "keyword", "--deepseek-key-file", "/k"]).arm, "keyword");
  assert.throws(() => parseArguments([...base, "--arm", "keyword", "--ingest-only"]), /nothing to do/);
  assert.throws(() => parseArguments([...base, "--arm", "no-memory", "--deepseek-key-file", "/k", "--plant-corruptions-after", "3"]), /needs arm product/);
  assert.throws(() => parseArguments([...base, ...engine, "--ingest-only", "--max-sessions", "x"]), /whole number/);
  assert.throws(() => parseArguments([...base, ...engine, "--ingest-only", "--bogus"]), /unknown argument/);
  assert.throws(() => parseArguments([...base, ...engine, "--ingest-only", "--arm", "magic"]), /--arm is/);
  assert.throws(() => parseArguments(["--set", "s"]), /--split is required/);
});

test("ingest-only can retain every planned snapshot checkpoint without creating answer calls", () => {
  const off = parseArguments([...base, ...engine, "--ingest-only"]);
  const on = parseArguments([...base, ...engine, "--ingest-only", "--snapshot-checkpoints"]);
  assert.equal(off.snapshotCheckpoints, false);
  assert.equal(on.snapshotCheckpoints, true);
  assert.deepEqual(checkpointsFor([{ afterSession: 4 }, { afterSession: 8 }], 12), [4, 8, 12]);
});

test("the run id is the run directory's name, in the engine's alphabet", () => {
  assert.equal(runIdOf("/srv/evimed/runs/smoke-laneA-1"), "smoke-laneA-1");
  assert.throws(() => runIdOf("/srv/runs/has space"), /run id/);
});

test("checkpoints: question points within the sessions taken, the last session, and the planting point", () => {
  const questions = [{ afterSession: 25 }, { afterSession: 0 }, { afterSession: 25 }, { afterSession: 200 }];
  assert.deepEqual(checkpointsFor(questions, 200), [0, 25, 200]);
  assert.deepEqual(checkpointsFor(questions, 6), [0, 6]);
  assert.deepEqual(checkpointsFor(questions, 200, 50), [0, 25, 50, 200]);
  assert.deepEqual(checkpointsFor([], 6, 9), [6]);
});

test("a JSONL row is replaced by key, never duplicated by a rerun", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "answers.jsonl");
  await upsertJsonl(file, "qid", { qid: "q1", answer: "first" });
  await upsertJsonl(file, "qid", { qid: "q2", answer: "other" });
  await upsertJsonl(file, "qid", { qid: "q1", answer: "retried" });
  const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows, [{ qid: "q2", answer: "other" }, { qid: "q1", answer: "retried" }]);
});

test("the templates digest changes with any file's content and ignores order of listing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "run-templates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "b.yaml"), "kind: b\n");
  await writeFile(path.join(directory, "a.yaml"), "kind: a\n");
  const first = await directoryDigest(directory);
  assert.equal(first.files, 2);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await directoryDigest(directory), first);
  await writeFile(path.join(directory, "a.yaml"), "kind: a2\n");
  assert.notEqual((await directoryDigest(directory)).digest, first.digest);
});
