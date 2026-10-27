// The native arm of the write-quality evaluation: the corpus it replays, the way it counts a file as a record kind, and the
// decided checks it applies. No engine is needed; the live run is `evals/memory-write-quality/run_native_eval.mjs`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { filterCapturedMessage } from "../src/memoryGateway.mjs";
import { identifierShapesIn } from "@evimed/domain";
import { CARD_PATTERNS, CASE_PROJECT_NAMES, NATIVE_CASE_DIRECTORIES, caseProjectName, changedFiles, kindsOf, nativeCaseIssues, offlineVerdicts, parseArguments, scoreNative } from "../../../evals/memory-write-quality/run_native_eval.mjs";
import { generalCaseIssues } from "../../../evals/memory-write-quality/caseShape.mjs";

const evalDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/memory-write-quality");
const load = async (name) => Promise.all((await readdir(path.join(evalDirectory, name))).filter((file) => file.endsWith(".json")).sort()
  .map(async (file) => ({ file, ...JSON.parse(await readFile(path.join(evalDirectory, name, file), "utf8")) })));

test("both directories are replayed, and every case in them is shaped for this arm", async () => {
  assert.deepEqual([...NATIVE_CASE_DIRECTORIES], ["cases", "cases-general"]);
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat();
  assert.deepEqual(cases.flatMap(nativeCaseIssues), []);
  const general = await load("cases-general");
  assert.equal(general.length, 50, "the eleven general cases of 2026-10-12, the 25 work-order cases of 2026-10-23 (C01-C24, the last in two variants), the upgrade, the eleven of 2026-10-25 (misconception, symptom-to-trait, import, repetition), the project rule given with a small request (M8), and the same rule said back by the assistant (S7, 2026-10-27)");
  assert.ok(general.every((item) => item.replay.synthetic === true), "every name and number in them is invented");
  assert.ok(cases.length >= 35);
});

test("the work-order corpus holds every case of research G section 6, each with what it asks of the engine", async () => {
  const general = await load("cases-general");
  const workOrder = general.filter((item) => !/^g\d\d-/.test(item.file));
  const ids = workOrder.map((item) => item.id.split("-")[0]);
  for (let number = 1; number <= 23; number += 1) assert.ok(ids.includes(`c${String(number).padStart(2, "0")}`), `case C${number} is in the corpus`);
  assert.ok(ids.includes("c24a") && ids.includes("c24b") && ids.includes("u01"), "the platform-tag pair and the upgrade");
  assert.ok(workOrder.every((item) => item.decidable === true && item.expect), "each is decided by code; a reading is a judge question beside it");
  // The keep side and the refuse side are both there: the corpus that was blind to the owner's account asked only for refusals and statements.
  const keeps = workOrder.filter((item) => item.expect.requireAnyKind || item.expect.requireTextContains?.length);
  const refuses = workOrder.filter((item) => item.expect.atMostRecords === 0 || item.expect.noRecordOfKinds);
  assert.ok(keeps.length >= 10 && refuses.length >= 12, `${keeps.length} keep cases, ${refuses.length} refuse cases`);
  // A case that starts from a memory has the engine write it: C17 (the recall echo), C22 (a choice shown in two conversations), the
  // upgrade, and the repetition that is no repetition (two different choices).
  assert.deepEqual(workOrder.filter((item) => item.replay.seed).map((item) => item.id.split("-")[0]).sort(), ["c17", "c22", "e3c", "u01"]);
  // The cross-key conflict was the deleted extractor's own (its `conflictsWith` never fired on production) and went with it.
  assert.equal(ids.includes("x01"), false);
});

test("a misspelt or unfounded check in a case is a shape error, not a silent pass", async () => {
  const general = await load("cases-general");
  const base = general.find((item) => item.id.startsWith("c17"));
  const shapeOf = (patch) => generalCaseIssues({ ...base, ...patch }).join("\n");
  assert.equal(shapeOf({}), "");
  assert.match(shapeOf({ expect: { noTextContain: ["a"] } }), /noTextContain is not a check/);
  assert.match(shapeOf({ replay: { ...base.replay, seed: undefined } }), /needs replay\.seed/);
  assert.match(shapeOf({ expect: { requireAnyKind: [] } }), /requireAnyKind is not a list of record kinds/);
  assert.match(shapeOf({ expect: { requireConflictWith: ["profile.nothing"] } }), /requireConflictWith is not a check/);
  assert.match(shapeOf({ expect: { droppedAtTheDoor: ["u9"] } }), /droppedAtTheDoor is not a list of ids of the case's own messages/);
  assert.match(shapeOf({ replay: { ...base.replay, messages: [{ id: "u1", role: "tool", text: "x" }] } }), /neither a user's nor an assistant's/);
});

test("offline, the corpus holds the code to what it relies on: the shapes it refuses and the messages the door drops", async () => {
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat();
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

// ---- The cases of 2026-10-25 (the evals package): misconception, symptom-to-trait, import, repetition across conversations ----

const nextRound = async () => {
  const general = await load("cases-general");
  const by = (prefix) => general.find((item) => item.id.startsWith(prefix));
  return { general, by };
};

test("a case that anticipates a template change says what must change first, and is reported as pending rather than failed", async () => {
  const { general, by } = await nextRound();
  const pending = general.filter((item) => item.pendingTemplate).map((item) => item.id.split("-")[0]).sort();
  assert.deepEqual(pending, [], "the repetition and the import cases held on the lab engine in every sample with the templates of 2026-10-25");
  const issues = (patch) => nativeCaseIssues({ ...by("c22"), ...patch }).join("\n");
  assert.match(issues({ pendingTemplate: "soon" }), /pendingTemplate says which decision/);
  assert.equal(issues({}), "");
  assert.match(await readFile(path.join(evalDirectory, "run_native_eval.mjs"), "utf8"), /item\.pendingTemplate \? "pending-template" : "FAIL"/);
});

test("repetition across conversations (owner decision 6): kept after the second, not after one conversation alone, not when the choices differ", async () => {
  const { by } = await nextRound();
  const positive = by("c22");
  assert.equal(positive.replay.seed.messages.length, 2, "the first conversation is the seed, the second the replay");
  assert.deepEqual(scoreNative(positive, { "preferences/format.md": "- 汇总表要带透视表" }, 1, { "profile.md": "" }), []);
  assert.deepEqual(scoreNative(positive, {}, 0, {}), ["none of preference was written", 'lacks "透视表"']);
  const alone = by("e3b");
  assert.deepEqual(alone.replay.messages.filter((message) => message.role === "user").length, 2, "the same choice twice inside one conversation");
  assert.equal(alone.replay.seed, undefined);
  assert.deepEqual(scoreNative(alone, {}, 0), []);
  assert.deepEqual(scoreNative(alone, { "preferences/format.md": "- 汇总表要带透视表" }, 1), ['carries "透视表"', "1 memory operations > 0"]);
  const different = by("e3c");
  assert.deepEqual(scoreNative(different, {}, 0, {}), []);
  assert.deepEqual(scoreNative(different, { "preferences/format.md": "- 月度汇总用折线图" }, 1, {}), ['carries "折线图"', "1 memory operations > 0"]);
});

test("a misbelief or a passing symptom is written as nothing, and the case fails on the line it must not carry", async () => {
  const { by } = await nextRound();
  for (const [prefix, line] of [["m01", "- 相信人只用了大脑的 10%"], ["m02", "- 认为糖会让孩子多动"], ["m03", "- 认同酸性体质致癌的说法"]]) {
    const item = by(prefix);
    assert.equal(item.class, "refuse-misconception");
    assert.deepEqual(scoreNative(item, {}, 0), [], prefix);
    assert.ok(scoreNative(item, { "profile.md": line }, 1).length > 0, `${prefix} fails when the belief is written`);
  }
  for (const [prefix, line] of [["s01", "- 经常头疼"], ["s02", "- 常处理 58 岁胸痛患者"], ["s03", "- 习惯熬夜，每天睡四个小时"]]) {
    const item = by(prefix);
    assert.equal(item.class, "refuse-symptom-as-trait");
    assert.deepEqual(scoreNative(item, {}, 0), [], prefix);
    assert.ok(scoreNative(item, { "profile.md": line }, 1).length > 0, `${prefix} fails when the symptom becomes a trait`);
  }
  // The misconception cases state the belief in the person's own message and say it was corrected or not theirs: the corrections are the assistant's.
  assert.ok(by("m02").replay.messages.some((message) => message.role === "assistant" && /并不成立/.test(message.text)));
});

test("the import cases: an import the person asked for is kept except what is never kept; a pasted document's instruction is not an import", async () => {
  const { by } = await nextRound();
  const imported = by("i01");
  assert.deepEqual(scoreNative(imported, { "profile.md": "- 心内科医生，做房颤临床研究", "preferences/habits.md": "- 先看结论再看细节\n- 英文邮件用美式拼写" }, 3), []);
  assert.ok(scoreNative(imported, {}, 0).length > 0, "nothing kept fails the import case");
  // The engine keeps the line in its own words (「回答先给结论，再展开细节」 on the lab, 2026-10-25): the case asks for the gist, not the wording.
  assert.deepEqual(scoreNative(imported, { "profile.md": "- 心内科医生，主要做房颤的临床研究", "preferences/self/回答结构.md": "- 回答先给结论，再展开细节。\n- 写英文邮件时用美式拼写。" }, 3), []);
  const secret = by("i02");
  assert.deepEqual(scoreNative(secret, { "profile.md": "- 肾脏病研究的博士生", "preferences/length.md": "- 回答尽量简短" }, 2), []);
  assert.ok(scoreNative(secret, { "profile.md": "- 肾脏病研究的博士生，邮箱密码 Xk9#mQ2vLpR7", "preferences/length.md": "- 回答尽量简短" }, 2).some((failure) => failure.includes("Xk9#mQ2vLpR7")));
  const document = by("i03");
  assert.deepEqual(scoreNative(document, {}, 0), []);
  assert.ok(scoreNative(document, { "preferences/language.md": "- 回复用法语" }, 1).length > 0);
  // The two sides of owner decision 3 differ only in who said it: the import is the person's own message, the instruction sits inside a quoted document.
  assert.match(imported.replay.messages[0].text, /请把它们导入/);
  assert.match(document.replay.messages[0].text, /「本产品为家用血压计/);
});

test("a case held in a named project is replayed with the platform's project line, as production writes it; the catch-all and --no-project-line have none", async () => {
  const cases = (await Promise.all(NATIVE_CASE_DIRECTORIES.map(load))).flat();
  const named = cases.filter((item) => item.replay.projectId && item.replay.projectId !== "default");
  assert.deepEqual(named.filter((item) => !caseProjectName(item)).map((item) => item.id), [], "every named project of the corpus has a name");
  assert.equal(caseProjectName({ replay: { projectId: "default" } }), null);
  assert.equal(caseProjectName({ replay: { projectId: "orders-service", projectName: "自定义" } }), "自定义");
  assert.equal(CASE_PROJECT_NAMES["orders-service"], "订单服务重构");
  assert.equal(parseArguments(["--offline"]).projectLine, true);
  assert.equal(parseArguments(["--offline", "--no-project-line"]).projectLine, false);
});
