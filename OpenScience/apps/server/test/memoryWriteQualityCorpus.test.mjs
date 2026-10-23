// The write-quality incidents as an eval corpus (audit 2026-09-26, M-9), and
// the fourteen synthetic replays of 2026-10-12 beside them.
//
// The live replay needs a model and runs offline in `evals/`. What this file
// holds without one: that the corpus is whole — one case per class, each with
// the verbatims it was filed from — and that the classes code can decide are
// decided the way the case expects when the incident's own candidate comes
// back from the model. For the synthetic replays that also means: the checks
// that say a record must be kept read the records, the identifiers a replay
// carries are shapes the code refuses, and the candidates a leaking model
// could return are refused for the reason the case names.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PLATFORM_CONTEXT_TAGS, identifierShapesIn } from "@evimed/domain";
import { MemoryIntelligence, conversationMemorySources } from "../src/memoryIntelligence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runner = await import(pathToFileURL(path.join(repoRoot, "evals/memory-write-quality/run_write_quality_eval.mjs")).href);

const cases = await runner.loadCases(path.join(repoRoot, "evals/memory-write-quality/cases"));

const config = {
  deepseekProviderEnabled: true,
  deepseekApiKey: "unit-test-key",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  memoryExtractionEnabled: true,
  memoryExtractionTimeoutMs: 1_000,
};

class StoreDouble {
  constructor() { this.records = new Map(); this.configured = false; }
  async listRecords() { return [...this.records.values()]; }
  async upsertRecord(_userId, input) {
    const stored = { ...input, id: input.key, version: 1, revisions: [], evidence: [], evidenceCount: 0 };
    this.records.set([input.scope, input.scopeId ?? "", input.kind, input.key].join("\u0000"), stored);
    return stored;
  }
  async getRecord() { throw Object.assign(new Error("not found"), { code: "memory_not_found" }); }
}

test("the corpus holds one well-formed case of every write-quality class", () => {
  // A corpus that loaded nothing would pass every assertion below.
  assert.ok(cases.length >= runner.REQUIRED_CLASSES.length, `loaded only ${cases.length} cases`);
  assert.deepEqual(cases.flatMap(runner.caseIssues), []);
  for (const name of runner.REQUIRED_CLASSES) {
    assert.equal(cases.filter((item) => item.class === name).length, 1, `one case of ${name}`);
  }
  for (const item of cases) {
    for (const record of item.written) {
      assert.ok(record.summary || record.key || record.verbatimFragment, `${item.id} names what was written`);
    }
  }
});

/**
 * A case's `incidentCandidates` as the model's answer, run through the extractor's own validation.
 * @param {any} item @returns {Promise<{ result: any, written: any[] }>}
 */
async function replayCandidates(item) {
  const store = new StoreDouble();
  const result = await new MemoryIntelligence(config, store, {
    fetchImpl: async (_input, init) => {
      const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        candidates: item.replay.incidentCandidates.map(({ refusedBecause: _expected, ...candidate }) => ({
          importance: 0.6, sensitive: false, ...candidate,
          sourceRef: sources.find((source) => source.sourceRef.endsWith(`/messages/${candidate.sourceRef}`)).sourceRef,
        })),
      }) } }] });
    },
  }).recordRun({ id: item.replay.projectId, userId: "usr_eval" }, { id: "run_eval", sessionId: "session_eval", status: "succeeded",
    finishedAt: "2026-09-26T00:00:00Z" }, runner.replayMessages(item));
  return { result, written: [...store.records.values()].filter((record) => record.kind !== "run_summary") };
}

test("the catch-all incident, replayed with the model's own candidate, is refused at write time", async () => {
  const item = cases.find((entry) => entry.class === "default-project-follow-up");
  const { result, written } = await replayCandidates(item);
  assert.equal(result.proposed, 1, "the incident's candidate reached validation");
  assert.deepEqual(runner.decidedVerdicts(item, written).map((verdict) => verdict.passed), [true]);
});

test("the platform-brief incident is refused before any model sees it, whatever registered tag the dispatcher uses", () => {
  const item = cases.find((entry) => entry.class === "platform-brief-as-user-words");
  const verdicts = runner.briefVerdicts(item, { conversationMemorySources, tags: PLATFORM_CONTEXT_TAGS });
  assert.ok(verdicts.length >= 15, `checked only ${verdicts.length} tags`);
  assert.ok(verdicts.every((verdict) => verdict.passed), verdicts.filter((verdict) => !verdict.passed).map((verdict) => verdict.check).join("; "));
  // And the incident as production recorded it — no tag — is exactly what
  // reached the extractor as the researcher's words.
  const untagged = conversationMemorySources(runner.replayMessages(item), "session_eval");
  assert.equal(untagged.sources.length, 1);
});

test("the code-decided checks read the written records, not their prose", () => {
  const byClass = Object.fromEntries(cases.map((item) => [item.class, item]));
  assert.deepEqual(runner.decidedVerdicts(byClass["internal-id"], [{ key: "k", kind: "project_fact", value: "草稿 ge_c4de7529 已写", summary: "" }])
    .map((verdict) => verdict.passed), [false]);
  assert.deepEqual(runner.decidedVerdicts(byClass["near-duplicates"], [
    { key: "a", kind: "follow_up", value: "x", summary: "" }, { key: "b", kind: "follow_up", value: "y", summary: "" },
  ]).map((verdict) => verdict.passed), [false]);
  assert.deepEqual(runner.decidedVerdicts(byClass["hollow-summary"], []), [], "a judgement class has no code verdict");
});

const synthetic = cases.filter((item) => item.replay.synthetic === true);

test("the synthetic replays of 2026-10-12 each say how the earlier extractor fared on what it wrote", () => {
  assert.equal(synthetic.length, 25, "fourteen synthetic replays, the two of the owner's R9 ruling, the two of the project card, and the seven of the general card");
  for (const item of synthetic) {
    assert.equal(item.decidable, true, `${item.id} is decided by code`);
    const verdicts = runner.decidedVerdicts(item, item.written);
    assert.ok(verdicts.length > 0, `${item.id} decides something`);
    // `written` is a sample of what the earlier extractor wrote: the failing one where it failed, so the case is not vacuous.
    assert.equal(verdicts.every((verdict) => verdict.passed), item.preChange === "held",
      `${item.id}: preChange ${item.preChange}, yet the sample is judged ${verdicts.map((verdict) => verdict.passed).join("/")}`);
  }
  assert.deepEqual(synthetic.filter((item) => item.preChange === "held").map((item) => item.class).sort(),
    ["credentials", "own-health-in-passing", "project-card-clinical-rct", "project-card-not-guessed", "project-card-observational-database",
      "project-card-task-not-a-project", "run-tool-and-field-names", "standing-method-and-format", "standing-role-and-focus"]);
});

test("a record that must be kept is checked by kind and by a string it carries, and a typo in a check is a shape error", () => {
  const byClass = Object.fromEntries(cases.map((item) => [item.class, item]));
  /** The checks of a case that its written records fail, by name. */
  const failing = (item, written) => runner.decidedVerdicts(item, written).filter((verdict) => !verdict.passed).map((verdict) => verdict.check);
  const record = (kind, value, key = `k.${kind}`) => ({ key, kind, value, summary: "" });

  assert.deepEqual(failing(byClass["standing-method-and-format"], [record("preference", "a", "p1"), record("preference", "b", "p2"), record("preference", "c", "p3")]), []);
  assert.deepEqual(failing(byClass["standing-method-and-format"], [record("preference", "a", "p1"), record("preference", "b", "p2")]),
    ["at least 3 preference record(s)"], "two of three is not enough");
  assert.deepEqual(failing(byClass["standing-method-and-format"], []), ["at least 3 preference record(s)"], "nothing written is a failure where something must be");
  assert.deepEqual(failing(byClass["research-tool-preferences"], [record("preference", "检索用 PubMed 和 Embase")]), []);
  assert.deepEqual(failing(byClass["research-tool-preferences"], [record("preference", "报告用中文")]), ["some record carries PubMed"],
    "a preference without the tools is not the one asked for");
  const cohort = [record("project_fact", "队列", "a"), record("project_fact", "变量", "b"), record("project_fact", "终点", "c"), record("decision", "IPTW")];
  assert.deepEqual(failing(byClass["project-shape-and-decision"], [...cohort.slice(0, 1), record("project_fact", "约 3200 例", "b"), ...cohort.slice(2)]), []);
  assert.deepEqual(failing(byClass["project-shape-and-decision"], cohort), ["some record carries 3200"], "the data source is what the earlier extractor refused");
  assert.deepEqual(failing(byClass["user-correction"], [record("correction", "引用时写明复合终点")]), []);
  assert.deepEqual(failing(byClass["user-correction"], [record("correction", "HR 约为 0.88")]), ["no record carries 0.88"], "the study's number is not what is kept");
  assert.deepEqual(failing(byClass["user-correction"], [record("preference", "引用时写明复合终点")]), ["at least 1 correction record(s)"]);
  assert.deepEqual(failing(byClass["standing-role-and-focus"], [record("profile", "a", "r"), record("profile", "b", "f")]), []);
  assert.deepEqual(failing(byClass["standing-role-and-focus"], [record("profile", "a", "r"), record("profile", "b", "f"), record("project_fact", "出血风险问题")]),
    [`no project_fact record in ${byClass["standing-role-and-focus"].replay.projectId}`]);

  // The project card: the keys a record was written under (the field is open vocabulary, so no value of it is judged here).
  const slots = ["population", "intervention", "comparator", "outcome", "design", "data_source", "stage"].map((slot) => record("project_fact", slot, `project.${slot}`));
  assert.deepEqual(failing(byClass["project-card-slots"], slots), []);
  assert.deepEqual(failing(byClass["project-card-slots"], [record("project_fact", "药物流行病学", "project.field"), ...slots]), [],
    "a field in the researcher's own words, off every list, is no failure");
  assert.deepEqual(failing(byClass["project-card-slots"], slots.slice(0, 6)), ["some record is written under project.stage"]);
  assert.deepEqual(failing(byClass["project-card-slots"], [record("project_fact", "队列", "project.af_cohort.design")]).length, 7,
    "the keys of the earlier extractor are no slot");
  assert.deepEqual(failing(byClass["project-card-not-guessed"], []), []);
  assert.deepEqual(failing(byClass["project-card-not-guessed"], [record("project_fact", "75 岁以上", "project.population")]).length, 2);

  // The card made general: the general keys are what a refactor, a launch and a thesis are kept under, and the keys only a clinical
  // study has are not written for them; a clinical study keeps its own, and a data source nobody stated is not made up.
  const general = ["project.goal", "project.stage", "project.constraints", "project.data_source", "project.field", "project.subject"].map((key) => record("project_fact", key, key));
  for (const kind of ["software-refactor", "launch-plan", "history-thesis", "market-analysis"]) {
    const item = byClass[`project-card-${kind}`];
    assert.ok(item, `${kind} has a case`);
    assert.deepEqual(failing(item, [...general, record("project_fact", "近代史", "project.ext.audience")].map((entry) => ({ ...entry, value: "近代史" }))), [],
      `${kind}: the general keys satisfy it`);
    assert.deepEqual(failing(item, [...general, record("project_fact", "x", "project.design")].map((entry) => ({ ...entry, value: "近代史" }))),
      ["no record is written under project.design"], `${kind}: a study's design is not written for it`);
    assert.ok(failing(item, [record("project_fact", "把单体拆成三个服务", "project.design")]).length >= 2, `${kind}: the earlier extractor's shape fails`);
  }
  const trial = byClass["project-card-clinical-rct"];
  const trialKeys = ["population", "intervention", "comparator", "outcome", "design", "stage"].map((slot) => record("project_fact", slot, `project.${slot}`));
  assert.deepEqual(failing(trial, trialKeys), []);
  assert.deepEqual(failing(trial, [...trialKeys, record("project_fact", "医保数据库", "project.data_source")]), ["no record is written under project.data_source"]);
  assert.deepEqual(failing(trial, trialKeys.slice(1)), ["some record is written under project.population"]);
  assert.deepEqual(failing(byClass["project-card-task-not-a-project"], [record("project_fact", "订单汇总脚本", "project.goal")]).length, 2);
  const keyless = { ...byClass["project-card-slots"], file: "x.json", expect: { noKeys: [] } };
  assert.match(runner.caseIssues(keyless).join("\n"), /noKeys is not a list of memory keys/);

  const misspelt = { ...byClass["credentials"], file: "x.json", expect: { noTextContain: ["a"] } };
  assert.match(runner.caseIssues(misspelt).join("\n"), /noTextContain is not a check the runner decides/);
  const emptyKeys = { ...byClass["project-card-slots"], file: "x.json", expect: { requireKeys: [] } };
  assert.match(runner.caseIssues(emptyKeys).join("\n"), /requireKeys is not a list of memory keys/);
  const valueless = { ...byClass["project-card-slots"], file: "x.json", expect: { keyValues: { "project.field": [] } } };
  assert.match(runner.caseIssues(valueless).join("\n"), /keyValues is not a map from a memory key to the values it may hold/);
  const countless = { ...byClass["standing-method-and-format"], file: "x.json", expect: { requireKinds: { preference: 0 } } };
  assert.match(runner.caseIssues(countless).join("\n"), /requireKinds is not a map from a record kind to a positive count/);
  const unsaid = { ...byClass["credentials"], file: "x.json", preChange: undefined };
  assert.match(runner.caseIssues(unsaid).join("\n"), /preChange/);
});

test("the identifiers a replay carries are shapes the code refuses, and no other replay message looks like one", () => {
  const shaped = cases.filter((item) => item.expect?.identifierShapes);
  assert.deepEqual(shaped.map((item) => item.class).sort(), ["credentials", "patient-identifiers", "third-party-details"]);
  for (const item of shaped) {
    const verdicts = runner.shapeVerdicts(item, { identifierShapesIn });
    assert.equal(verdicts.length, item.expect.identifierShapes.length);
    assert.ok(verdicts.every((verdict) => verdict.passed), `${item.id}: ${verdicts.filter((verdict) => !verdict.passed).map((verdict) => verdict.check).join("; ")}`);
  }
  // A shape that fires on an NCT number, a DOI, a dose or a dataset name would refuse real research memory.
  for (const item of cases) {
    for (const message of item.replay.messages) {
      if (item.expect?.identifierShapes && message.role === "user") continue;
      assert.deepEqual(identifierShapesIn(message.text), [], `${item.id}/${message.id} reads as an identifier`);
    }
  }
  // And the check is not vacuous: take the key out of its message and the credential shape is gone.
  const credentials = cases.find((item) => item.class === "credentials");
  const stripped = { ...credentials, replay: { ...credentials.replay, messages: credentials.replay.messages.map((message) => ({ ...message, text: message.text.replace(/[0-9a-f]{36}/, "") })) } };
  assert.deepEqual(runner.shapeVerdicts(stripped, { identifierShapesIn }).map((verdict) => verdict.passed), [false]);
});

test("the candidates a leaking model could return are refused in code, each for the reason its case names", async () => {
  const reasons = {
    identifier: /carries a credential or a personal identifier/,
    sensitive: /is sensitive: extraction does not keep it/,
    bookkeeping: /is the run's own bookkeeping/,
    // What the assistant narrated about its own work is refused before its words are read at all (2026-10-14): the candidate
    // quotes the assistant, and a memory rests on the person's message. The words check below still guards what they typed.
    "assistant-source": /must cite a message the person wrote \(got role "assistant"\)/,
  };
  const replayed = synthetic.filter((item) => item.replay.incidentCandidates);
  assert.deepEqual(replayed.map((item) => item.class).sort(),
    ["credentials", "own-health", "patient-identifiers", "run-tool-and-field-names", "third-party-details"]);
  for (const item of replayed) {
    const { result, written } = await replayCandidates(item);
    assert.equal(result.proposed, item.replay.incidentCandidates.length, `${item.id}: every candidate reached validation`);
    assert.equal(written.length, 0, `${item.id}: nothing was stored: ${written.map((record) => record.key).join(", ")}`);
    for (const candidate of item.replay.incidentCandidates) {
      const reason = result.rejectionReasons.find((text) => text.includes(`"${candidate.key}"`));
      assert.ok(reason, `${item.id}: ${candidate.key} was not refused (${result.rejectionReasons.join(" | ")})`);
      assert.match(reason, reasons[candidate.refusedBecause], `${item.id}: ${candidate.key} was refused for another reason`);
    }
    assert.ok(runner.decidedVerdicts(item, written).every((verdict) => verdict.passed), `${item.id}: the case's own checks pass on what was stored`);
  }
});

// ---- The work-order corpus on the legacy arm (2026-10-23) ----

const generalCases = await runner.loadCases(path.join(repoRoot, "evals/memory-write-quality/cases-general"));
const { generalCaseIssues, runsOnArm } = await import(pathToFileURL(path.join(repoRoot, "evals/memory-write-quality/caseShape.mjs")).href);

test("the general corpus is validated by this arm too: one shape for both, and a misspelt or unfounded check is a shape error", () => {
  assert.equal(generalCases.length, 38);
  assert.deepEqual(generalCases.flatMap(generalCaseIssues), []);
  const base = generalCases.find((item) => item.id.startsWith("c17"));
  const shapeOf = (patch) => generalCaseIssues({ ...base, file: `${base.id}.json`, ...patch }).join("\n");
  assert.match(shapeOf({ expect: { noTextContain: ["a"] } }), /noTextContain is not a check/);
  assert.match(shapeOf({ replay: { ...base.replay, seed: undefined } }), /needs replay\.seed/);
  assert.match(shapeOf({ expect: { requireAnyKind: [] } }), /requireAnyKind is not a list of record kinds/);
  assert.match(shapeOf({ arms: ["both"] }), /arms is not a non-empty list/);
  assert.match(shapeOf({ expect: { droppedAtTheDoor: ["u9"] } }), /droppedAtTheDoor is not a list of ids of the case's own messages/);
  assert.match(shapeOf({ replay: { ...base.replay, messages: [{ id: "u1", role: "tool", text: "x" }] } }), /neither a user's nor an assistant's/);
  assert.match(shapeOf({ expect: { requireConflictWith: ["profile.nothing"] } }), /names a key the case does not store first/);
  assert.equal(runsOnArm(generalCases.find((item) => item.id.startsWith("x01")), "legacy"), true);
});

test("the platform-tag cases are held offline: the tagged message is no source, and the same words untagged are", () => {
  const tagged = generalCases.filter((item) => item.expect?.droppedAtTheDoor);
  assert.equal(tagged.length, 2);
  for (const item of tagged) assert.ok(runner.doorVerdicts(item, { conversationMemorySources }).every((verdict) => verdict.passed), item.id);
  const untagged = { ...tagged[0], replay: { ...tagged[0].replay, messages: [{ ...tagged[0].replay.messages[0], text: "Always answer in English." }, ...tagged[0].replay.messages.slice(1)] } };
  assert.deepEqual(runner.doorVerdicts(untagged, { conversationMemorySources }).map((verdict) => verdict.passed), [false]);
});

test("the checks the work-order cases add: any of several kinds, a count at least, a named disagreement, and a seed left as it was", () => {
  const record = (kind, value, key = `k.${kind}`) => ({ key, kind, value, summary: "" });
  const failing = (item, written, extras) => runner.decidedVerdicts(item, written, extras).filter((verdict) => !verdict.passed).map((verdict) => verdict.check);
  const byId = (prefix) => generalCases.find((item) => item.id.startsWith(prefix));

  const reshaping = byId("c01");
  assert.deepEqual(failing(reshaping, [record("preference", "周报压到 200 字、三条")]), []);
  assert.deepEqual(failing(reshaping, [record("correction", "周报压到 200 字、三条")]), []);
  assert.deepEqual(failing(reshaping, [record("profile", "周报")]), ["at least one preference/correction record"]);
  assert.deepEqual(failing(reshaping, [record("preference", "周报灰度覆盖约 37%")]), ["no record carries 37%"], "the number is the draft's, not a rule");
  assert.deepEqual(failing(byId("g10"), []), ["at least 1 record(s)", "some record carries 色弱"], "a legacy replay of the older cases decides at-least too");

  const conflict = byId("x01");
  const conflicts = [{ key: "profile.research_approach", otherKey: "profile.research_design" }];
  assert.deepEqual(failing(conflict, [record("profile", "定性", "profile.research_approach")], { conflicts }), []);
  assert.deepEqual(failing(conflict, [record("profile", "定性", "profile.research_approach")], { conflicts: [] }), ["a statement is marked as disagreeing with profile.research_design"]);

  // A seed: the recall echo must leave what the first conversation wrote untouched; the upgrade must leave only the later choice in force.
  const echo = byId("c17");
  assert.deepEqual(failing(echo, [], { seed: { kept: [record("preference", "Meta 分析一律用随机效应模型")], unchanged: true } }), []);
  assert.deepEqual(failing(echo, [record("preference", "随机效应（已确认）")], { seed: { kept: [record("preference", "随机效应")], unchanged: false } }),
    ["the case's conversation left what the seed wrote as it was"]);
  assert.deepEqual(failing(echo, [], { seed: { kept: [], unchanged: true } }), ["the seed stored 随机效应"], "a seed that stored nothing makes the replay void");
  const upgrade = byId("u01");
  const seed = { kept: [record("preference", "参考文献一律用 Vancouver 格式", "preference.citation_style")], unchanged: false };
  assert.deepEqual(failing(upgrade, [record("preference", "参考文献一律用 AMA 格式", "preference.citation_style")], { seed, inForce: [record("preference", "参考文献一律用 AMA 格式", "preference.citation_style")] }), []);
  assert.deepEqual(failing(upgrade, [record("preference", "参考文献一律用 AMA 格式", "preference.citation_ama")],
    { seed, inForce: [record("preference", "参考文献一律用 Vancouver 格式", "preference.citation_style"), record("preference", "参考文献一律用 AMA 格式", "preference.citation_ama")] }),
  ["no record carries Vancouver"], "the old choice standing beside the new one is the failure the case is for");
});

test("the cross-key conflict: a stubbed extractor that names the stored key as disagreeing is seen by the replay store, and one that does not is a failure", async () => {
  const item = generalCases.find((entry) => entry.id.startsWith("x01"));
  /** @param {string | null} conflictsWith */
  const replay = async (conflictsWith) => {
    const store = new runner.ReplayStore(item.replay.existingKeys);
    const before = new Set(store.records.keys());
    await new MemoryIntelligence(config, store, {
      fetchImpl: async (_input, init) => {
        const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content).sources;
        const user = sources.find((source) => source.sourceRef.endsWith("/messages/u1"));
        return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{
          kind: "profile", scope: "user", origin: "explicit", key: "profile.research_approach", value: "主要做定性研究，以访谈和扎根理论为主",
          summary: "主要做定性研究", sourceRef: user.sourceRef, evidenceQuote: "我主要做定性研究", importance: 0.7, sensitive: false,
          ...(conflictsWith ? { conflictsWith } : {}),
        }] }) } }] });
      },
    }).recordRun({ id: item.replay.projectId, userId: "usr_eval" }, { id: "run_x01", sessionId: "session_eval", status: "succeeded", finishedAt: "2026-10-23T00:00:00Z" }, runner.replayMessages(item));
    const written = [...store.records.entries()].filter(([key, record]) => !before.has(key) && record.kind !== "run_summary").map(([, record]) => ({ kind: record.kind, key: record.key, summary: record.summary, value: record.value }));
    return { store, verdicts: runner.decidedVerdicts(item, written, { conflicts: store.conflicts }) };
  };
  const named = await replay("profile.research_design");
  assert.deepEqual(named.store.conflicts, [{ key: "profile.research_approach", otherKey: "profile.research_design" }]);
  assert.ok(named.verdicts.every((verdict) => verdict.passed));
  const silent = await replay(null);
  assert.deepEqual(silent.store.conflicts, []);
  assert.deepEqual(silent.verdicts.map((verdict) => verdict.passed), [false], "the stored statement and the new one stand beside each other, said by nobody");
});
