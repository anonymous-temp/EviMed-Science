// What a new conversation of a project is handed up front (2026-10-25, M8; found by S7 and S2 of `evals/capsule-longitudinal`): a rule the
// person gave the project in its first conversation did not reach the next one. Two gaps, on a real PostgreSQL and a stub engine:
//  - the card read only the project's project-context file, under the headings it knew, while the engine may file a stated rule as one of
//    the project's other standing files (a working fact, a decision), which the plugin's own start-of-session listing never names;
//  - a turn typed in the kernel's own composer passes through no dispatch, so the block was never handed to it at all.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROJECT_CARD_MAX_CHARS, ResidentProfiles, nativeResidentMemos, nativeSessionResident, projectCardMemo } from "../src/residentProfile.mjs";
import { projectCardRows, projectExtraRows } from "../src/nativeMemoryStore.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

const A = "p_review";
const B = "p_other";

async function scene(t) {
  const f = await fixture(t);
  const residentProfiles = new ResidentProfiles({ config: { memoryRecallEnabled: true }, store: f.memorySettings, projectCard: (userId, projectId) => f.store.residentCard(userId, projectId) });
  return { ...f, residentProfiles };
}

/** The S7 statement as the engine filed it: a standing fact tagged with the project, which only the card's own file used to be read from. */
const ruleAsFact = (f) => f.seed("project_facts/交付语言.md", "- 这个项目的所有文字交付物一律用英文写，不要写中文。", { type: "project_facts", tags: [`project=${A}`] });

test("a rule the person stated for the project reaches its next conversation up front, whichever file the engine put it in", options, async (t) => {
  const f = await scene(t);
  ruleAsFact(f);
  f.seed("decisions/发表去向.md", "- 综述投稿到 Lancet 子刊。", { type: "decisions", tags: [`project=${A}`] });
  f.seed("project_facts/别的项目.md", "- 另一个项目用中文写。", { type: "project_facts", tags: [`project=${B}`] });
  f.seed("preferences/self/回答长度.md", "- 回答尽量简短。", { type: "preferences" });
  // The page's card is the person's own card and says nothing of them; what a conversation is handed carries the project's other standing files.
  assert.deepEqual(await f.store.projectCard(f.userId, A), [], "the 项目 tab's card is as it was");
  const rows = await f.store.residentCard(f.userId, A);
  assert.deepEqual(rows.map((row) => row.slot), ["decisions", "project_facts"]);
  const block = await f.residentProfiles.forDispatch(f.userId, { projectId: A, sessionId: "ses_new", attended: true });
  assert.equal(block.due, true);
  assert.match(block.text, /项目事实：这个项目的所有文字交付物一律用英文写，不要写中文。/);
  assert.match(block.text, /决定：综述投稿到 Lancet 子刊。/);
  assert.equal(block.text.includes("另一个项目用中文写"), false, "another project's rule is not this project's");
  assert.equal(block.text.includes("回答尽量简短"), false, "the person's own preferences are the plugin's listing's, not the card's");
  assert.deepEqual(block.memories.map((memo) => memo.id), [`card:${A}`]);
});

test("a section of the card under a heading of the model's own, or 已定事项, is a row of its own in what the conversation is handed, and not on the page's card", options, async (t) => {
  const f = await scene(t);
  f.seed("projects/sglt2-综述.md", "# SGLT2 综述\n## 目标\n- 写一篇综述\n## 已定事项\n- 先写引言\n## 交付约定\n- 所有文字交付物一律用英文写\n- 参考文献用 Vancouver", { type: "project_context", tags: [`project=${A}`] });
  // The 项目 tab's card is the six slots and the clinical elements, as it always read; the sections it does not know are not on it.
  assert.deepEqual((await f.store.projectCard(f.userId, A)).map((row) => row.slot), ["goal"]);
  const rows = await f.store.residentCard(f.userId, A);
  assert.deepEqual(rows.map((row) => [row.slot, row.label ?? null]), [["goal", null], ["other", "已定事项"], ["other", "交付约定"]]);
  assert.equal(rows[2].text, "所有文字交付物一律用英文写；参考文献用 Vancouver");
  const block = await f.residentProfiles.forDispatch(f.userId, { projectId: A, sessionId: "ses_new", attended: true });
  assert.match(block.text, /交付约定：所有文字交付物一律用英文写；参考文献用 Vancouver/);
  assert.match(block.text, /已定事项：先写引言/);
  // The clinical elements stay with their own heading, never a row of the headings' own names.
  const study = projectCardRows([{ nativeType: "project_context", scopeId: A, id: "r1", updatedAt: null, value: "## 研究要素\n- 人群：成人\n- 随便写的一行\n## 目标\n- x" }], A, { sections: true });
  assert.deepEqual(study.map((row) => row.slot), ["goal", "population"]);
});

test("only for a turn a person is in, a project with a subject, a conversation that is not paused: the rules of the card hold for the rest", options, async (t) => {
  const f = await scene(t);
  ruleAsFact(f);
  const handed = (over) => f.residentProfiles.forDispatch(f.userId, { sessionId: "ses_x", attended: true, ...over });
  assert.equal((await handed({ projectId: A, attended: false })).text, "", "nobody's turn: no card");
  assert.equal((await handed({ projectId: "default" })).text, "", "the catch-all has no card");
  assert.equal((await handed({ projectId: B })).text, "", "a project with no rule says nothing");
  await f.memorySettings.updateSettings(f.userId, { recallPaused: true });
  assert.equal((await handed({ projectId: A })).text, "", "paused memory hands nothing");
});

test("the block is cut at the card's budget, the card's own rows first and each file's newest lines before its older ones", options, async (t) => {
  const f = await scene(t);
  const many = Array.from({ length: 12 }, (_, index) => `- 第 ${index + 1} 条约定：${"很长的约定内容".repeat(14)}`).join("\n");
  f.seed("project_facts/约定.md", many, { type: "project_facts", tags: [`project=${A}`] });
  f.seed("decisions/老决定.md", "- 老决定一条", { type: "decisions", tags: [`project=${A}`] });
  const rows = await f.store.residentCard(f.userId, A);
  assert.equal(rows.find((row) => row.slot === "project_facts").text.split("；").length, 6, "six lines to a row");
  const memo = projectCardMemo(A, rows);
  assert.ok(memo.content.length <= PROJECT_CARD_MAX_CHARS, `${memo.content.length} characters`);
  assert.match(memo.content, /^决定：老决定一条/, "decisions lead (their order in the card), then the working facts as far as the budget goes");
  assert.deepEqual(projectExtraRows([], A), []);
});

// --------------------------------------------------------------------------------------------- the kernel's own composer

test("a turn typed in the kernel's composer is handed the block at its first step, once, and again when it changed or the kernel compacted", options, async (t) => {
  const f = await scene(t);
  ruleAsFact(f);
  let running = [];
  const resident = nativeSessionResident({ residentProfiles: f.residentProfiles, activeRuns: async () => running, startedByPlatform: (run) => run.automated === true });
  const user = { id: f.userId };
  const project = { id: A, userId: f.userId };
  const first = await resident.forSession(user, project, "ses_native");
  assert.match(first.text, /用英文写/);
  assert.deepEqual(first.memories, [{ id: `card:${A}`, kind: "project_fact", scope: "project" }]);
  // Not noted until the step has entered: asked again, handed again.
  assert.equal((await resident.forSession(user, project, "ses_native")).digest, first.digest);
  await resident.attached(user, project, "ses_native", { digest: first.digest, memories: first.memories });
  assert.equal(await resident.forSession(user, project, "ses_native"), null, "held: nothing at the next step");
  // The card moved: handed again, with a block of its own.
  f.seed("project_facts/格式.md", "- 参考文献用 Vancouver。", { type: "project_facts", tags: [`project=${A}`] });
  const changed = await resident.forSession(user, project, "ses_native");
  assert.notEqual(changed.digest, first.digest);
  await resident.attached(user, project, "ses_native", { digest: changed.digest, memories: changed.memories });
  // The kernel compacted the conversation: the block went with the history it was written into.
  await f.memorySettings.noteCompaction(f.userId, A, "ses_native");
  assert.equal((await resident.forSession(user, project, "ses_native")).digest, changed.digest);
  // Another conversation of the same project is its own.
  assert.ok(await resident.forSession(user, project, "ses_other"));
  // A conversation whose turn the control plane dispatched has the block in its prompt; one it started itself is handed no card.
  running = [{ sessionId: "ses_dispatched", dispatchId: "d1" }];
  assert.equal(await resident.forSession(user, project, "ses_dispatched"), null);
  running = [{ sessionId: "ses_auto", automated: true }];
  assert.equal(await resident.forSession(user, project, "ses_auto"), null, "no capsule profile here and no card for a turn nobody is in");
});

test("what the block held is kept with the conversation, so the run it becomes can say it recalled it", options, async (t) => {
  const f = await scene(t);
  ruleAsFact(f);
  const resident = nativeSessionResident({ residentProfiles: f.residentProfiles, activeRuns: async () => [], startedByPlatform: () => false });
  const block = await resident.forSession({ id: f.userId }, { id: A }, "ses_native");
  await resident.attached({ id: f.userId }, { id: A }, "ses_native", { digest: block.digest, memories: block.memories });
  const state = await f.memorySettings.residentState(f.userId, A, "ses_native");
  assert.deepEqual(state.memos, [{ id: `card:${A}`, kind: "project_fact", scope: "project" }]);
  const delivered = Date.parse(state.deliveredAt);
  const run = (over = {}) => ({ id: "r1", sessionId: "ses_native", startedAt: new Date(delivered - 2_000).toISOString(), finishedAt: new Date(delivered + 30_000).toISOString(), ...over });
  assert.deepEqual(nativeResidentMemos(run(), state), state.memos, "the run the block was handed in");
  assert.deepEqual(nativeResidentMemos(run({ dispatchId: "d1" }), state), [], "a dispatched run named its own");
  assert.deepEqual(nativeResidentMemos(run({ recalledMemories: [{ id: "x" }] }), state), [], "a run that names some is left as it is");
  assert.deepEqual(nativeResidentMemos(run({ startedAt: new Date(delivered + 60_000).toISOString(), finishedAt: new Date(delivered + 90_000).toISOString() }), state), [], "a later turn was not handed it again");
  assert.deepEqual(nativeResidentMemos(run({ startedAt: new Date(delivered - 600_000).toISOString(), finishedAt: new Date(delivered - 300_000).toISOString() }), state), [], "an earlier one did not have it");
  assert.deepEqual(nativeResidentMemos(run({ finishedAt: null }), state), state.memos, "a run still going");
  assert.deepEqual(nativeResidentMemos(run(), { deliveredAt: null, memos: [] }), []);
  assert.deepEqual(nativeResidentMemos(null, state), []);
});
