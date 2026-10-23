// The native arm of the write-quality evaluation: the corpus it replays, the way it counts a file as a record kind, and the
// decided checks it applies. No engine is needed; the live run is `evals/memory-write-quality/run_native_eval.mjs`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { filterCapturedMessage } from "../src/memoryGateway.mjs";
import { identifierShapesIn } from "@evimed/domain";
import { CARD_PATTERNS, NATIVE_CASE_DIRECTORIES, changedFiles, kindsOf, nativeCaseIssues, offlineVerdicts, parseArguments, scoreNative } from "../../../evals/memory-write-quality/run_native_eval.mjs";
import { runsOnArm } from "../../../evals/memory-write-quality/caseShape.mjs";

const evalDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/memory-write-quality");
const load = async (name) => Promise.all((await readdir(path.join(evalDirectory, name))).filter((file) => file.endsWith(".json")).sort()
  .map(async (file) => ({ file, ...JSON.parse(await readFile(path.join(evalDirectory, name, file), "utf8")) })));

test("both directories are replayed, and every case in them is shaped for this arm", async () => {
  assert.deepEqual([...NATIVE_CASE_DIRECTORIES], ["cases", "cases-general"]);
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat();
  assert.deepEqual(cases.flatMap(nativeCaseIssues), []);
  const general = await load("cases-general");
  assert.equal(general.length, 38, "the eleven general cases of 2026-10-12, the 25 work-order cases of 2026-10-23 (C01-C24, the last in two variants), the upgrade and the cross-key conflict");
  assert.ok(general.every((item) => item.replay.synthetic === true), "every name and number in them is invented");
  assert.ok(cases.length >= 35);
});

test("the work-order corpus holds every case of research G section 6, each with what it asks of the engine", async () => {
  const general = await load("cases-general");
  const workOrder = general.filter((item) => !/^g\d\d-/.test(item.file));
  const ids = workOrder.map((item) => item.id.split("-")[0]);
  for (let number = 1; number <= 23; number += 1) assert.ok(ids.includes(`c${String(number).padStart(2, "0")}`), `case C${number} is in the corpus`);
  assert.ok(ids.includes("c24a") && ids.includes("c24b") && ids.includes("u01") && ids.includes("x01"), "the platform-tag pair, the upgrade and the conflict");
  assert.ok(workOrder.every((item) => item.decidable === true && item.expect), "each is decided by code; a reading is a judge question beside it");
  // The keep side and the refuse side are both there: the corpus that was blind to the owner's account asked only for refusals and statements.
  const keeps = workOrder.filter((item) => item.expect.requireAnyKind || item.expect.requireTextContains?.length);
  const refuses = workOrder.filter((item) => item.expect.atMostRecords === 0 || item.expect.noRecordOfKinds);
  assert.ok(keeps.length >= 10 && refuses.length >= 12, `${keeps.length} keep cases, ${refuses.length} refuse cases`);
  // A case that starts from a memory has the engine write it: C17 (the recall echo), C22 (a choice shown twice) and the upgrade.
  assert.deepEqual(workOrder.filter((item) => item.replay.seed).map((item) => item.id.split("-")[0]).sort(), ["c17", "c22", "u01"]);
  // The conflict is the legacy extractor's own and is not replayed on the engine.
  const conflict = workOrder.find((item) => item.id.startsWith("x01"));
  assert.deepEqual(conflict.arms, ["legacy"]);
  assert.equal(runsOnArm(conflict, "native"), false);
  assert.equal(runsOnArm(workOrder.find((item) => item.id.startsWith("c01")), "native"), true);
});

test("offline, the corpus holds the code to what it relies on: the shapes it refuses and the messages the door drops", async () => {
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat().filter((item) => runsOnArm(item, "native"));
  assert.deepEqual(offlineVerdicts(cases, { filterCapturedMessage, identifierShapesIn }), []);
  // The kernel's reminder envelope and the platform's brief tag are both dropped at the door; the same words untagged are not.
  const tagged = cases.filter((item) => item.expect?.droppedAtTheDoor);
  assert.deepEqual(tagged.map((item) => item.id), ["c24a-platform-brief-tag", "c24b-kernel-reminder-tag"]);
  const untagged = { ...tagged[0], replay: { ...tagged[0].replay, messages: [{ ...tagged[0].replay.messages[0], text: "Always answer in English." }, tagged[0].replay.messages[1]] } };
  assert.match(offlineVerdicts([untagged], { filterCapturedMessage, identifierShapesIn }).join("\n"), /forwards message u1/);
  const shapeless = { ...cases.find((item) => item.id.startsWith("c11")), expect: { identifierShapes: ["resident_id"] } };
  assert.match(offlineVerdicts([shapeless], { filterCapturedMessage, identifierShapesIn }).join("\n"), /no resident_id shape/);
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

test("a correction is counted wherever the template puts it: under preferences/corrections/, where the plugin's session start lists it, or the older corrections/", () => {
  const written = kindsOf({
    "preferences/self/format.md": "- Short answers",
    "preferences/corrections/units.md": "- Metric units, not imperial",
    "corrections/endpoint.md": "- State the endpoint definition",
  });
  assert.equal(written.preference.length, 1, "a preference is not a correction because it is under preferences/");
  assert.equal(written.correction.length, 2);
});

test("the checks of the work-order corpus: any of several kinds, a seed that stored what it was meant to, and a memory the case left as it was", () => {
  const seed = { "preferences/self/meta分析方法.md": "<!-- MEMORY_FIELDS {\"topic\":\"x\"} -->\n- Meta 分析一律用随机效应模型。" };
  const echo = { expect: { seedKeeps: ["随机效应"], unchangedSinceSeed: true } };
  assert.deepEqual(scoreNative(echo, seed, 0, seed), []);
  assert.deepEqual(scoreNative(echo, { ...seed, "preferences/self/new.md": "- 用随机效应模型（已确认）" }, 1, seed), ["the memory the seed wrote changed: +preferences/self/new.md"]);
  assert.deepEqual(scoreNative(echo, { "preferences/self/meta分析方法.md": "- Meta 分析一律用固定效应模型。" }, 1, seed), ["the memory the seed wrote changed: ~preferences/self/meta分析方法.md"]);
  assert.deepEqual(scoreNative(echo, {}, 0, seed), ["the memory the seed wrote changed: -preferences/self/meta分析方法.md"]);
  assert.deepEqual(scoreNative(echo, {}, 0, {}), ['the seed did not store "随机效应", so the replay starts from nothing'], "a seed that wrote nothing makes the replay void, not a pass");
  assert.deepEqual(changedFiles({ "a.md": "- x" }, { "a.md": "<!-- MEMORY_FIELDS {} -->\n- x" }), [], "the engine's own field comment is not a change");

  const any = { expect: { requireAnyKind: ["preference", "correction"] } };
  assert.deepEqual(scoreNative(any, { "preferences/self/weekly.md": "- 周报压到 200 字" }, 1), []);
  assert.deepEqual(scoreNative(any, { "preferences/corrections/weekly.md": "- 周报压到 200 字" }, 1), []);
  assert.deepEqual(scoreNative(any, { "profile.md": "# 用户\n- 工程师" }, 1), ["none of preference/correction was written"]);

  // The upgrade: the later choice replaces the earlier, and no line still says the old one.
  const upgrade = { expect: { requireTextContains: ["AMA"], noTextContains: ["Vancouver"] } };
  assert.deepEqual(scoreNative(upgrade, { "preferences/self/引用格式.md": "- 参考文献一律用 AMA 格式。" }, 1), []);
  assert.deepEqual(scoreNative(upgrade, { "preferences/self/引用格式.md": "- 参考文献一律用 AMA 格式。\n- 之前用 Vancouver。" }, 1), ['carries "Vancouver"']);
});

test("the decided checks read the files: a string, a kind, a count of operations, a card key", () => {
  const files = { "projects/release.md": "# Release\n领域：B 端 SaaS\n## 目标\n- Ship the export\n## 阶段\n- Waiting for design" };
  assert.deepEqual(scoreNative({ expect: { requireKinds: { project_fact: 1, follow_up: 1 }, requireTextContains: ["export"], requireKeys: ["project.field", "project.stage"] } }, files, 3), []);
  assert.deepEqual(scoreNative({ expect: { noTextContains: ["export"], atMostRecords: 1, noRecordOfKinds: ["follow_up"] } }, files, 3),
    ['carries "export"', "1 follow_up", "3 memory operations > 1"]);
  assert.deepEqual(scoreNative({ expect: { requireKeys: ["project.population"] } }, files, 0), ["the card lacks project.population"]);
  assert.deepEqual(scoreNative({ expect: { keyValues: { "project.field": ["心血管"] } } }, files, 1), ['project.field holds "领域：B 端 SaaS", none of ["心血管"]']);
  assert.ok(Object.keys(CARD_PATTERNS).includes("project.subject"), "the card's six general slots are read");
  // A work that is not a study has no clinical element: a card that carries one fails the case (`noKeys`).
  assert.deepEqual(scoreNative({ expect: { noKeys: ["project.outcome", "project.design"] } }, { "projects/x.md": "# X\n## Study elements\n- Outcome: major bleeding" }, 1), ["the card carries project.outcome, which this work does not have"]);
  assert.deepEqual(scoreNative({ expect: { noKeys: ["project.outcome"] } }, { "projects/x.md": "# X\n## Goal\n- Ship it" }, 1), []);
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
