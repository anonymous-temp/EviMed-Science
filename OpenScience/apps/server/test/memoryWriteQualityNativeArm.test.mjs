// The native arm of the write-quality evaluation: the corpus it replays, the way it counts a file as a record kind, and the
// decided checks it applies. No engine is needed; the live run is `evals/memory-write-quality/run_native_eval.mjs`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { filterCapturedMessage } from "../src/memoryGateway.mjs";
import { CARD_PATTERNS, NATIVE_CASE_DIRECTORIES, kindsOf, nativeCaseIssues, parseArguments, scoreNative } from "../../../evals/memory-write-quality/run_native_eval.mjs";

const evalDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/memory-write-quality");
const load = async (name) => Promise.all((await readdir(path.join(evalDirectory, name))).filter((file) => file.endsWith(".json")).sort()
  .map(async (file) => ({ file, ...JSON.parse(await readFile(path.join(evalDirectory, name, file), "utf8")) })));

test("both directories are replayed, and every case in them is shaped for this arm", async () => {
  assert.deepEqual([...NATIVE_CASE_DIRECTORIES], ["cases", "cases-general"]);
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat();
  assert.deepEqual(cases.flatMap(nativeCaseIssues), []);
  const general = await load("cases-general");
  assert.equal(general.length, 11, "the ten general cases (an engineer, a lawyer, a teacher, a product manager, a designer) and one English conversation");
  assert.ok(general.every((item) => item.replay.synthetic === true), "every name and number in them is invented");
  assert.ok(cases.length >= 35);
});

test("a file is counted as the kind it now lives as: bullets by place, the card's sections by their words", () => {
  const written = kindsOf({
    "profile.md": "# Profile\n- Backend engineer\n- Works in Go",
    "preferences/format.md": "- Short answers",
    "corrections/units.md": "- Metric units, not imperial",
    "decisions/cadence.md": "- Release every two weeks",
    "follow_ups/legal.md": "- Wait for legal's reply",
    "entities/acme.md": "- Acme Corp",
    "projects/release.md": "# Release\n领域：B 端 SaaS\n## 目标\n- Ship the export\n## 已定事项\n- Excel first\n## 阶段\n- Waiting for the permission design\n## 约束\n- Two engineers",
  });
  assert.equal(written.profile.length, 2);
  assert.equal(written.preference.length, 1);
  assert.equal(written.correction.length, 1);
  assert.equal(written.decision.length, 2, "decisions/ and the card's 已定事项");
  assert.equal(written.follow_up.length, 2, "follow_ups/ and the card's 阶段");
  assert.equal(written.project_fact.length, 3, "the 领域 line, the goal and the constraint");
  assert.deepEqual(written.entity, ["entities/acme.md"]);
});

test("the decided checks read the files: a string, a kind, a count of operations, a card key", () => {
  const files = { "projects/release.md": "# Release\n领域：B 端 SaaS\n## 目标\n- Ship the export\n## 阶段\n- Waiting for design" };
  assert.deepEqual(scoreNative({ expect: { requireKinds: { project_fact: 1, follow_up: 1 }, requireTextContains: ["export"], requireKeys: ["project.field", "project.stage"] } }, files, 3), []);
  assert.deepEqual(scoreNative({ expect: { noTextContains: ["export"], atMostRecords: 1, noRecordOfKinds: ["follow_up"] } }, files, 3),
    ['carries "export"', "1 follow_up", "3 memory operations > 1"]);
  assert.deepEqual(scoreNative({ expect: { requireKeys: ["project.population"] } }, files, 0), ["the card lacks project.population"]);
  assert.deepEqual(scoreNative({ expect: { keyValues: { "project.field": ["心血管"] } } }, files, 1), ['project.field holds "领域：B 端 SaaS", none of ["心血管"]']);
  assert.ok(Object.keys(CARD_PATTERNS).includes("project.subject"), "the card's six general slots are read");
});

test("a message wearing the platform's tag never reaches the engine, and the person's own words do", () => {
  assert.ok("drop" in filterCapturedMessage({ role: "user", content: "写一篇文章\n<evimed-geo-run>geo_eval_run</evimed-geo-run>" }));
  assert.ok("forward" in filterCapturedMessage({ role: "user", content: "我是药师，以后回答用中文。" }));
});

test("the arguments name an engine and its key, or ask for the offline check", () => {
  assert.equal(parseArguments(["--offline"]).offline, true);
  assert.throws(() => parseArguments([]), /--url/);
  assert.equal(parseArguments(["--url", "http://x", "--key-file", "/k", "--only", "g04"]).only, "g04");
  assert.throws(() => parseArguments(["--bogus"]), /unknown argument/);
});
