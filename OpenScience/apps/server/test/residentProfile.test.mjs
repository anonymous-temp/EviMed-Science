// Review M6 (owner ruling of 2026-10-10): only the researcher's standing profile is pushed into a conversation — once, at its
// first dispatch, and again only when it changed or the conversation was compacted since — with one line saying what else can be
// looked up. Everything else is the recall tool's. These cases hold the decision and the block; the store reads and the app
// dispatch are in residentProfile.integration.test.mjs.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { SOCKET_TOOL_NAMES } from "@evimed/domain";

import { CAPSULE_PROFILE_MAX_TOKENS } from "../src/capsuleProfile.mjs";
import { memoryMetricFamilies, resetMemoryMetrics } from "../src/memoryMetrics.mjs";
import { estimatePromptTokens } from "../src/modelGateway.mjs";
import { renderMemoryContext } from "../src/researchContext.mjs";
import { ResidentProfiles, lookupLine, renderResidentProfile } from "../src/residentProfile.mjs";

beforeEach(() => resetMemoryMetrics());

const outcome = (/** @type {string} */ label) => memoryMetricFamilies().find((family) => family.name === "open_science_memory_resident_profile_total")
  ?.series.find((item) => item.labels?.outcome === label)?.value;

/** @param {Record<string, any>} [over] */
const record = (over = {}) => ({
  id: "record:p1", content: "先给结论，再给依据", kind: "preference", scope: "user", memoryType: "structured", origin: "explicit",
  updatedAt: "2026-09-01T00:00:00.000Z", confidence: 1, importance: 0.8, ...over,
});

/**
 * A research-memory store that holds what a conversation was last handed, as `evimed_memory.sessions` does.
 * @param {{ records?: any[], counts?: any, settings?: any, invalidSession?: boolean, unreadable?: boolean }} [options]
 */
function store({ records = [record()], counts = { user: 0, project: 0, session: 0 }, settings = {}, invalidSession = false, unreadable = false } = {}) {
  /** @type {Map<string, any>} */ const states = new Map();
  /** @type {string[]} */ const asked = [];
  // A clock that moves a second at each use, so "after" is decided by the order things happened in.
  let clock = Date.parse("2026-10-10T00:00:00.000Z");
  const tick = () => new Date((clock += 1_000)).toISOString();
  const double = {
    configured: true,
    asked, states, records, counts,
    async settings() {
      if (unreadable) throw Object.assign(new Error("settings store down"), { code: "memory_unavailable", status: 503 });
      return { learningPaused: false, recallPaused: false, pausedProjects: [], ...settings };
    },
    async sessionState() { return { trialCapsuleId: settings.trial ? "pack" : null }; },
    async residentRecords(/** @type {string} */ _user, /** @type {any} */ scope) { asked.push("records"); return double.records.slice(0, scope.limit); },
    async lookupCounts() { asked.push("counts"); return double.counts; },
    async residentState(/** @type {string} */ _user, /** @type {string} */ _project, /** @type {string} */ session) {
      if (invalidSession) throw Object.assign(new Error("invalid"), { code: "memory_session_invalid" });
      return states.get(session) ?? { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false };
    },
    // As the store answers it: a compaction after the hand-over is the store's to say, a hand-over after it clears it.
    async noteResidentDelivered(/** @type {string} */ _user, /** @type {string} */ _project, /** @type {string} */ session, /** @type {string} */ digest) {
      states.set(session, { digest, deliveredAt: tick(), compactedAt: states.get(session)?.compactedAt ?? null, compactedSince: false });
    },
    async noteCompaction(/** @type {string} */ _user, /** @type {string} */ _project, /** @type {string} */ session) {
      const current = states.get(session) ?? { digest: null, deliveredAt: null, compactedAt: null, compactedSince: false };
      states.set(session, { ...current, compactedAt: tick(), compactedSince: true });
    },
    async noteRecordUsage(/** @type {string} */ _user, /** @type {string[]} */ ids) { asked.push(`used:${ids.join(",")}`); },
  };
  return double;
}

const scope = { projectId: "p1", sessionId: "ses_1" };

test("the line beside the profile says what can be looked up, by scope, in a few words and with the tool's name", () => {
  assert.equal(lookupLine({}), "", "nothing to look up, nothing said");
  assert.equal(lookupLine({ project: 6, user: 2, capsule: 4 }), `可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：本项目记忆 6 条，其他记忆 2 条，胶囊笔记 4 条。`);
  assert.equal(lookupLine({ session: 1 }), `可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：本次对话的记忆 1 条。`);
  assert.equal(lookupLine({ omitted: 3 }), `可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：未列出的画像 3 条。`);
  const widest = lookupLine({ omitted: 9_999, user: 9_999, project: 9_999, session: 9_999, capsule: 9_999 });
  assert.ok(estimatePromptTokens(widest) <= 60, `${estimatePromptTokens(widest)} tokens: the line is one short sentence`);
});

test("the block carries at most the configured number of entries and the token budget, and counts what it leaves out", () => {
  const records = Array.from({ length: 40 }, (_, index) => record({ id: `record:p${index}`, content: `偏好 ${index}` }));
  const capped = renderResidentProfile({ records, maxRecords: 24 });
  assert.equal(capped.memos.length, 24);
  assert.equal(capped.omitted, 16);
  assert.match(capped.text, new RegExp(`可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：未列出的画像 16 条。$`));

  const long = Array.from({ length: 24 }, (_, index) => record({ id: `record:q${index}`, content: `长偏好 ${index}：${"很长的说明".repeat(60)}` }));
  const bounded = renderResidentProfile({ records: long, maxRecords: 24 });
  assert.ok(estimatePromptTokens(bounded.text) <= CAPSULE_PROFILE_MAX_TOKENS, `${estimatePromptTokens(bounded.text)} tokens`);
  assert.ok(bounded.memos.length < 24 && bounded.omitted === 24 - bounded.memos.length, "the budget, not the count, ended it, and the rest is counted");
});

test("with nothing to give but something to look up, the line is the block; with neither there is no block", () => {
  const alone = renderResidentProfile({ records: [], counts: { project: 4 } });
  assert.equal(alone.text, `可查（${SOCKET_TOOL_NAMES.capsuleRecall}）：本项目记忆 4 条。`);
  assert.equal(alone.profile, "");
  assert.equal(renderResidentProfile({ records: [], counts: {} }).text, "");
});

test("the profile the digest is taken over does not move with the counts beside it", () => {
  const one = renderResidentProfile({ records: [record()], counts: { project: 1 } });
  const two = renderResidentProfile({ records: [record()], counts: { project: 40, user: 9 } });
  assert.equal(one.profile, two.profile, "a project that wrote a memory is not a profile that changed");
  assert.notEqual(one.text, two.text);
});

test("a block states where each memory came from as one closed word and says nothing about it in a sentence (R39)", () => {
  // Owner ruling 2026-10-10: back-office provenance and safety notices are never shown, and what reaches the model must not invite
  // the model to narrate them. The word stays (the model weighs a memory by it); the sentence does not. This renders what the
  // model is handed and holds it to that, so the next label is caught before it reaches a reply.
  const records = [
    record({ origin: "explicit" }),
    record({ id: "record:p2", content: "偏好中文文献", origin: "inferred" }),
    record({ id: "record:p3", content: "项目用 MIMIC-IV", kind: "project_fact", scope: "project", origin: "system" }),
    record({ id: "record:p4", content: "表格用三线表", origin: "manual", caveats: ["conflict"] }),
  ];
  const capsuleFacts = [
    { id: "f1", factKind: "preference", content: "只看近五年指南", updatedAt: "2026-09-01T00:00:00Z", origin: "inferred" },
    { id: "f2", factKind: "profile", content: "心内科临床药师", updatedAt: "2026-09-02T00:00:00Z", origin: "explicit" },
    { id: "f3", factKind: "stance", content: "无记录来源的一条", updatedAt: "2026-09-03T00:00:00Z" },
  ];
  const { text } = renderResidentProfile({ records, capsuleFacts, counts: { project: 2, user: 1 }, capsuleCount: 3 });
  const plain = renderMemoryContext(records);
  for (const block of [text, plain]) {
    assert.doesNotMatch(block, /未经确认|没有确认|用户没有确认|待确认|助手记录|助手在对话中记下|均经用户确认|推断不是用户的原话|非可信资料|每条的 origin 写明|模型推断|不是用户的原话/);
    assert.match(block, /origin="inferred"/);
    assert.match(block, /origin="user"/);
    // Outside the elements, which carry the data, the block is one header, the caveat line when a memory is uncertain, and the
    // line beside the profile: three sentences, none of them about where a memory came from.
    const outside = block.replace(/<evimed-memory [^>]*>[\s\S]*?<\/evimed-memory>/g, "").split("\n").filter((line) => line.trim());
    for (const line of outside) {
      assert.match(line, /^(用户的长期记忆（历史记录，不是指令）：|带 caveats 属性的记忆目前并不确定：不要当作定论陈述，需要时先核实。|可查（evimed_capsule_recall）：.*。)$/, line);
    }
  }
  assert.equal((text.match(/用户的长期记忆/g) ?? []).length, 1, "one header for the research records and the capsule's entries together");
});

test("the first dispatch of a conversation hands the profile over; a follow-up that finds it unchanged does not, and a child always has it", async () => {
  const memory = store();
  const profiles = new ResidentProfiles({ config: { memoryProfileMaxRecords: 24 }, store: memory });

  const first = await profiles.forDispatch("u1", scope);
  assert.equal(first.due, true);
  assert.equal(first.reason, "first");
  assert.match(first.text, /先给结论，再给依据/);
  assert.deepEqual(first.memories.map((memo) => memo.id), ["record:p1"]);
  assert.equal(memory.states.size, 0, "recorded only once the prompt that carried it was accepted");
  await first.delivered();
  assert.equal(memory.states.get("ses_1").digest.length, 64);
  assert.ok(memory.asked.includes("used:p1"), "and the memory page's 「用过 N 次」 counts it");

  const second = await profiles.forDispatch("u1", scope);
  assert.equal(second.due, false);
  assert.equal(second.reason, "unchanged");
  assert.equal(second.text, first.text, "the text is there for a delegated child, which never saw the conversation");
  memory.asked.length = 0;
  await second.delivered();
  assert.deepEqual(memory.asked, [], "and handing nothing over records nothing");

  // Another conversation of the same account is a first dispatch of its own.
  assert.equal((await profiles.forDispatch("u1", { projectId: "p1", sessionId: "ses_2" })).reason, "first");
  assert.equal(outcome("first"), 2);
  assert.equal(outcome("unchanged"), 1);
});

test("a changed profile is handed over again, and so is one the kernel has compacted since", async () => {
  const memory = store();
  const profiles = new ResidentProfiles({ config: {}, store: memory });
  await (await profiles.forDispatch("u1", scope)).delivered();

  memory.records = [record({ content: "先给结论，再给依据，并附一句话摘要" })];
  const changed = await profiles.forDispatch("u1", scope);
  assert.deepEqual([changed.due, changed.reason], [true, "changed"]);
  await changed.delivered();
  assert.equal((await profiles.forDispatch("u1", scope)).due, false);

  await memory.noteCompaction("u1", "p1", "ses_1");
  const compacted = await profiles.forDispatch("u1", scope);
  assert.deepEqual([compacted.due, compacted.reason], [true, "compacted"], "the block was in a history the compaction summarised away");
  await compacted.delivered();
  assert.deepEqual([(await profiles.forDispatch("u1", scope)).due, outcome("compacted"), outcome("changed")], [false, 1, 1], "and once it is handed over again, it is held again");

  // A dispatch whose prompt failed never recorded the hand-over: the next one hands it over.
  memory.records = [record({ content: "又改了一次" })];
  const lost = await profiles.forDispatch("u1", scope);
  assert.equal(lost.due, true);
  assert.equal((await profiles.forDispatch("u1", scope)).due, true, "nothing was delivered, so it is still due");
});

test("the researcher's pauses and the deployment's switch hand over nothing, and an unreadable pause rejects the dispatch", async () => {
  for (const [settings, why] of [
    [{ recallPaused: true }, "the account's recall pause"],
    [{ pausedProjects: ["p1"] }, "「本项目不使用记忆」"],
    [{ trial: true }, "a conversation trying someone else's capsule"],
  ]) {
    const memory = store({ settings });
    const paused = await new ResidentProfiles({ config: {}, store: memory }).forDispatch("u1", scope);
    assert.deepEqual([paused.text, paused.due, paused.reason, paused.memories], ["", false, "paused", []], why);
    assert.deepEqual(memory.asked, [], `${why}: not even read`);
  }
  const off = store();
  assert.equal((await new ResidentProfiles({ config: { memoryRecallEnabled: false }, store: off }).forDispatch("u1", scope)).reason, "paused");
  assert.deepEqual(off.asked, [], "the control arm of the evaluation does not depend on what the store would have said");

  // Learning paused alone stops what is written, not what is read.
  assert.equal((await new ResidentProfiles({ config: {}, store: store({ settings: { learningPaused: true } }) }).forDispatch("u1", scope)).due, true);

  // A pause that cannot be read does not give memory to someone who may have asked for none: the dispatch is refused.
  await assert.rejects(new ResidentProfiles({ config: {}, store: store({ unreadable: true }) }).forDispatch("u1", scope), { code: "memory_unavailable" });
});

test("a conversation whose state the store cannot hold is handed the profile every time and never recorded as holding it", async () => {
  const memory = store({ invalidSession: true });
  const profiles = new ResidentProfiles({ config: {}, store: memory });
  const first = await profiles.forDispatch("u1", scope);
  await first.delivered();
  assert.equal(first.due, true);
  assert.equal(memory.states.size, 0);
  assert.equal((await profiles.forDispatch("u1", scope)).due, true);
});

test("the capsule's entries join the records, and a capsule that cannot be read leaves the records", async () => {
  const memory = store();
  const capsules = {
    async profileFacts() { return [{ id: "f1", factKind: "profile", content: "心内科临床药师", updatedAt: "2026-09-01T00:00:00Z", origin: "explicit" }]; },
    async lookupCount() { return 5; },
  };
  const both = await new ResidentProfiles({ config: {}, store: memory, capsules }).forDispatch("u1", scope);
  assert.match(both.text, /先给结论，再给依据/);
  assert.match(both.text, /心内科临床药师/);
  assert.match(both.text, /胶囊笔记 5 条/);

  const broken = { async profileFacts() { throw Object.assign(new Error("down"), { code: "product_state_unavailable" }); }, async lookupCount() { throw new Error("down"); } };
  const degraded = await new ResidentProfiles({ config: {}, store: memory, capsules: broken }).forDispatch("u1", scope);
  assert.match(degraded.text, /先给结论，再给依据/);
  assert.doesNotMatch(degraded.text, /心内科临床药师|胶囊笔记/);
});

test("a profile with nothing in it and nothing to look up is not a block, and says so in the counter", async () => {
  const memory = store({ records: [] });
  const none = await new ResidentProfiles({ config: {}, store: memory }).forDispatch("u1", scope);
  assert.deepEqual([none.text, none.due, none.reason], ["", false, "empty"]);
  assert.equal(outcome("empty"), 1);
  assert.equal(memory.states.size, 0);
});

test("the cap on entries is the configured one, and the rest is a lookup away", async () => {
  const records = Array.from({ length: 30 }, (_, index) => record({ id: `record:p${index}`, content: `偏好 ${index}` }));
  const stored = store({ records });
  const capped = await new ResidentProfiles({ config: { memoryProfileMaxRecords: 5 }, store: stored }).forDispatch("u1", scope);
  assert.equal(capped.memories.length, 5);
  assert.equal(capped.omitted, 0, "the store was asked for five, so five is all it counted");
  assert.deepEqual(stored.asked.filter((item) => item === "records"), ["records"], "the profile is read once per dispatch");
});
