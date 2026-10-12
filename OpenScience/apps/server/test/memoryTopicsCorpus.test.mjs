// The topic grouping's eval corpus (2026-10-12): the live replay asks a model and runs offline in `evals/memory-topics`. What this file
// holds without one: that the corpus is whole, that the grouping a reader would agree with passes every check a case names, and that the
// grouping that makes the mistakes the case is about fails them — a check that cannot fail is not a check.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FRONTIER_SPECIALTIES } from "@evimed/domain";
import { groupable, parseTopics } from "../src/memoryTopics.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runner = await import(pathToFileURL(path.join(repoRoot, "evals/memory-topics/run_topics_eval.mjs")).href);
const cases = await runner.loadCases(path.join(repoRoot, "evals/memory-topics/cases"));
const tools = { specialties: FRONTIER_SPECIALTIES };
const asked = (item) => (item.existing ?? []).map((topic) => ({ id: topic.id, label: topic.label, modelLabel: topic.label, fixed: Boolean(topic.fixed) }));
const grouped = (item, reply) => parseTopics(JSON.stringify(reply), item.memories.map((memory) => memory.id), asked(item));

test("the corpus is whole: every class has a case, every case is well formed, and a third of the memories are not medical", () => {
  assert.deepEqual(cases.flatMap(runner.caseIssues), []);
  for (const name of runner.REQUIRED_CLASSES) assert.ok(cases.some((item) => item.class === name), `no case of class ${name}`);
  const asking = cases.filter((item) => item.class !== "bounds");
  assert.ok(asking.length >= 5);
  // The office worker's case holds no medical word at all; the clinician's holds an engineer's and an office worker's memories beside the trial's.
  const office = cases.find((item) => item.id === "office-budget-and-travel");
  assert.ok(!office.memories.some((memory) => /患者|药|心衰|试验|临床|诊/u.test(memory.summary)));
  const clinician = cases.find((item) => item.id === "clinician-with-other-work");
  const nonMedical = clinician.memories.filter((memory) => /索引|查询|连接池|预算|采购/u.test(memory.summary));
  assert.ok(nonMedical.length >= 4 && nonMedical.length / clinician.memories.length >= 0.2);
});

test("a grouping a reader would agree with passes every check its case names", () => {
  for (const item of cases.filter((entry) => entry.class !== "bounds")) {
    const verdicts = runner.topicVerdicts(item, grouped(item, item.fixtures.good), tools);
    assert.ok(verdicts.length >= 3, `${item.id} decides something`);
    assert.deepEqual(verdicts.filter((entry) => !entry.passed), [], item.id);
  }
});

test("a grouping that makes the mistakes the case is about fails at least those checks: merge, split, kind words, the researcher's word", () => {
  for (const item of cases.filter((entry) => entry.class !== "bounds")) {
    const failed = runner.topicVerdicts(item, grouped(item, item.fixtures.bad), tools).filter((entry) => !entry.passed).map((entry) => entry.check);
    for (const check of item.fixtures.badFails) assert.ok(failed.includes(check), `${item.id}: the bad grouping does not fail ${check} (it failed ${failed.join(", ")})`);
  }
});

test("the researcher's word: a regrouping that drops a renamed topic's id or name fails, and so does bringing a dismissed one back under another name", () => {
  const item = cases.find((entry) => entry.id === "researchers-word-survives");
  const good = grouped(item, item.fixtures.good);
  assert.equal(good.find((topic) => topic.id === "topic:1111111111")?.label, "我们组的人手", "the id the model was told to keep survives the platform's re-verification");
  const renamed = good.map((topic) => (topic.id === "topic:1111111111" ? { ...topic, label: "招聘" } : topic));
  assert.ok(runner.topicVerdicts(item, renamed, tools).some((entry) => entry.check === "keeps" && !entry.passed));
  const back = [...good, { id: "topic:9999999999", label: "户外出行", members: ["m12", "m04"] }];
  assert.ok(runner.topicVerdicts(item, back, tools).some((entry) => entry.check === "dismissedAbsent" && entry.passed === false) === false, "a different meaning is not the dismissed one");
  const same = [...good, { id: "topic:9999999999", label: "周末出行安排", members: ["m12", "m04"] }];
  assert.ok(runner.topicVerdicts(item, same, tools).some((entry) => entry.check === "dismissedAbsent" && !entry.passed));
});

test("too few memories to group: the code says so, and no model is asked", () => {
  const item = cases.find((entry) => entry.class === "bounds");
  const records = runner.recordsOf(item);
  assert.equal(groupable(records).length, item.expect.groupable);
  assert.ok(groupable(records).length < item.expect.minMemories);
});

test("a case that misspells a check, names a memory it does not have or has no fixtures is a shape error, not a silent pass", () => {
  const sound = cases.find((entry) => entry.id === "same-word-two-senses");
  assert.match(runner.caseIssues({ ...sound, expect: { ...sound.expect, pairRecal: 0.6 } }).join("\n"), /pairRecal is not a check/u);
  assert.match(runner.caseIssues({ ...sound, expect: { ...sound.expect, neverTogether: [["m01", "m99"]] } }).join("\n"), /neverTogether holds a pair/u);
  assert.match(runner.caseIssues({ ...sound, fixtures: null }).join("\n"), /carries fixtures/u);
  assert.match(runner.caseIssues({ ...sound, truth: { x: ["m01", "m99"] } }).join("\n"), /names m99/u);
  assert.match(runner.caseIssues({ ...sound, file: "other.json" }).join("\n"), /not named after its id/u);
});
