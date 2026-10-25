// E3 and recent work, end to end on a real PostgreSQL and a stub engine (owner decision 6 of 2026-10-25).
//
// A choice the person made in a request and never called a rule is written by the engine as a note of the `observations` type (the
// stub's `extract` plays the engine). The control plane counts the conversations that wrote it and, when two different ones did, hands
// the words to the engine as the person's explicit request to keep them: the same path as 「记住这一条」. One conversation alone never
// promotes, however many commits it makes or replays; a note is never listed, searched, recalled or counted as a memory.
import assert from "node:assert/strict";
import { test } from "node:test";

import { frontierMemoryMark } from "../src/frontierProfiles.mjs";
import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { NativeMemoryObservations } from "../src/nativeMemoryObservations.mjs";
import { nativeMemoryFile, observationFile } from "../src/openVikingSessions.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture, database } = nativeIntegration();

const OBSERVATION = "observations/预算类表格-透视表.md";

/** The engine's extraction for these scenarios, by the session that reached it. @param {() => any} later the fixture, known once it exists */
function engine(later) {
  return ({ session, messages }) => {
    const f = later();
    const said = messages.map((message) => message.parts?.map((part) => part.text).join("") ?? "").join("\n");
    const file = `${f.root}/${OBSERVATION}`;
    if (session.startsWith("evimed-promote-")) {
      return { adds: [{ uri: `${f.root}/preferences/self/预算类表格.md`, memory_type: "preferences", after: "- 预算类表格一律带透视表。" }] };
    }
    if (/透视表/.test(said) && !/折线图/.test(said)) {
      const held = f.stub.files.get(file);
      return held === undefined
        ? { adds: [{ uri: file, memory_type: "observations", after: `- 预算类表格：带透视表（${said.slice(0, 8)}）` }] }
        : { updates: [{ uri: file, memory_type: "observations", before: held, after: `${held}\n- 预算类表格：带透视表（${said.slice(0, 8)}）` }] };
    }
    return {};
  };
}

/** The fixture, with the promotion the composition root builds from the store. */
async function scene(t, extra = {}) {
  const held = { f: /** @type {any} */ (null) };
  const f = await fixture(t, { extract: engine(() => held.f), ...extra });
  held.f = f;
  f.worker.observations = new NativeMemoryObservations({
    overlay: f.overlay, sessions: f.sessions, memorySettings: f.memorySettings, keepRepeatedChoice: (userId, choice) => f.store.keepRepeatedChoice(userId, choice),
  });
  return f;
}

/** A second commit of a session that already exists (the control plane commits after each attended turn): no new session, one more archive. */
async function commitAgain(f, name, text) {
  const session = `dsh-session_${name}`;
  f.stub.sessions.get(`${f.engineUser}/${session}`).messages.push({ role: "user", parts: [{ type: "text", text }] });
  const committed = f.stub.commitSession(f.engineUser, session);
  await f.overlay.recordCommit({ userId: f.userId, archiveUri: committed.archive_uri, engineSession: session, projectId: null, origin: "gateway", taskId: committed.task_id });
  return committed;
}

test("a note is not a memory: no reader of native memory names it, and a reset takes it", options, async (t) => {
  const f = await scene(t);
  assert.equal(nativeMemoryFile(`${f.root}/${OBSERVATION}`, f.root), null, "the page's reader does not know the type");
  assert.deepEqual(observationFile(`${f.root}/${OBSERVATION}`, f.root), { type: "observations", relPath: OBSERVATION });
  assert.equal(observationFile(`${f.root}/observations/sub/dir.md`, f.root), null);
  assert.equal(observationFile(`${f.root}/observations/.overview.md`, f.root), null);
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(f.stub.files.has(`${f.root}/${OBSERVATION}`), true, "the engine wrote it");
  const page = await f.store.profile(f.userId, { holder: { id: f.userId, name: "T" } });
  assert.equal(page.records.length, 0, "the list does not hold it");
  assert.equal(page.activeCount, 0);
  assert.equal((await f.store.search(f.userId, "透视表")).items.length, 0, "search does not find it");
  assert.equal((await f.store.mapMemories(f.userId)).records.length, 0, "the map does not draw it");
  assert.equal((await f.overlay.observationFiles(f.userId)).length, 1, "the overlay keeps it for the counting");
  await f.store.reset(f.userId);
  assert.equal(f.stub.files.has(`${f.root}/${OBSERVATION}`), false, "a reset leaves none behind");
  assert.equal((await f.overlay.observationFiles(f.userId)).length, 0);
});

test("two different conversations make a preference of a choice; one alone never does", options, async (t) => {
  const f = await scene(t);
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(f.stub.sent("POST", "/api/v1/sessions").filter((request) => String(request.body?.session_id ?? "").startsWith("evimed-promote-")).length, 0, "one conversation: nothing");
  // The same conversation, again (a second turn's commit), is still one conversation.
  await commitAgain(f, "a", "月度汇总也要带透视表。");
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 0, "two commits of one conversation are one conversation");
  assert.equal(f.stub.files.has(`${f.root}/${OBSERVATION}`), true);

  // A second conversation shows it too: promoted.
  await f.commitConversation("b", [{ role: "user", text: "季度汇总请带透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  const promotions = f.stub.sent("POST", "/api/v1/sessions").filter((request) => String(request.body?.session_id ?? "").startsWith("evimed-promote-"));
  assert.equal(promotions.length, 1, "one session of its own");
  const sent = f.stub.requests.find((request) => request.method === "POST" && /\/messages$/.test(request.path) && request.path.includes("evimed-promote-"));
  const words = sent.body.parts[0].text;
  assert.match(words, /^请记住我做事的一个偏好（我在两次不同的对话里都这样选，以后默认这样做）：/);
  assert.match(words, /预算类表格：带透视表/, "the note's own words");
  assert.equal(f.stub.files.has(`${f.root}/${OBSERVATION}`), false, "the note is spent");
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 1);
  const spent = (await f.overlay.revisionsOf(f.userId, `${f.root}/${OBSERVATION}`)).find((revision) => revision.change === "deleted");
  assert.deepEqual([spent.actor, spent.reason], ["platform", "promoted to a preference"]);

  // The preference lands as any commit's does, and says where it came from.
  await f.worker.processCommits({ userId: f.userId });
  const records = (await f.store.records(f.userId)).filter((record) => record.nativeType === "preferences");
  assert.equal(records.length, 1);
  assert.match(records[0].value, /透视表/);
  assert.deepEqual(records[0].evidence.map((item) => [item.sourceType, item.label]), [["repetition", "你在两次对话里都这样做"]]);
  const commit = (await f.overlay.commitsOf(f.userId)).find((row) => row.origin === "promotion");
  assert.equal(commit.state, "completed");
});

test("a replay of a failed extraction is its own conversation's, not a second one", options, async (t) => {
  const f = await scene(t);
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  // The same conversation's next commit fails and is replayed as a session of its own: still the conversation `a`.
  f.stub.extract = (input) => (input.session.startsWith("dsh-session_a") && input.messages.length === 1 && input.messages[0].parts[0].text.includes("季度") ? "fail" : engine(() => f)(input));
  await commitAgain(f, "a", "季度汇总也要带透视表。");
  await f.worker.processCommits({ userId: f.userId });
  f.advance(3_600_000);
  await f.worker.processCommits({ userId: f.userId, now: f.now() });
  const replays = (await f.overlay.commitsOf(f.userId)).filter((row) => row.origin === "replay");
  assert.equal(replays.length, 1, "the failed commit was replayed");
  assert.equal(await f.overlay.conversationOf(f.userId, replays[0].engineSession, replays[0].archiveUri), "session_a", "the replay traces to the conversation it replays");
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 0, "the conversation and its replay are one");

  // A different conversation then makes two.
  await f.commitConversation("b", [{ role: "user", text: "月报也要带透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 1);
});

test("two different choices are two notes, and nothing is promoted from either", options, async (t) => {
  const f = await scene(t, { extract: () => ({}) });
  const pivot = `${f.root}/observations/pivot.md`;
  const chart = `${f.root}/observations/chart.md`;
  f.stub.extract = ({ session }) => (session.endsWith("_a")
    ? { adds: [{ uri: pivot, memory_type: "observations", after: "- 预算类表格：带透视表（月度汇总时）" }] }
    : { adds: [{ uri: chart, memory_type: "observations", after: "- 月度汇总：折线图，不要表格（月度汇总时）" }] });
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }]);
  await f.commitConversation("b", [{ role: "user", text: "月度汇总请做成折线图，不要表格。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.observationFiles(f.userId)).length, 2);
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 0);
  assert.equal(f.stub.sent("POST", "/api/v1/sessions").filter((request) => String(request.body?.session_id ?? "").startsWith("evimed-promote-")).length, 0);
});

test("a paused account is not written to: the note stays and is looked at again", options, async (t) => {
  const f = await scene(t);
  await f.memorySettings.updateSettings(f.userId, { learningPaused: true });
  f.stub.users.get(f.engineUser).learning = true; // the stub's extraction still runs: only the control plane's own write is under test
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }]);
  await f.commitConversation("b", [{ role: "user", text: "季度汇总请带透视表。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(f.stub.files.has(`${f.root}/${OBSERVATION}`), true);
  assert.equal(nativeMemoryCounters().observationOutcomes.promoted, 0);
  assert.equal((await f.worker.observations.promote(f.userId)).paused, true);
  await f.memorySettings.updateSettings(f.userId, { learningPaused: false });
  assert.equal((await f.worker.observations.promote(f.userId)).promoted, 1, "resumed, the second pass promotes it");
});

test("the engine's own check after a write holds for a note: an identifier in it is taken out", options, async (t) => {
  const f = await scene(t, { extract: () => ({}) });
  const uri = `${f.root}/observations/contact.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: "observations", after: "- 回复发到 zhang.wei@example.com\n- 报告带透视表" }] });
  await f.commitConversation("a", [{ role: "user", text: "报告带透视表，回复发到我邮箱。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(f.stub.files.get(uri), "- 报告带透视表", "the line with an e-mail address is gone");
});

// ------------------------------------------------------------------------------------------------------------ recent work

test("recent work is the project card's last row: three lines of the newest files, tagged to the project, never the default project's", options, async (t) => {
  const f = await scene(t, { extract: () => ({}) });
  f.seed("projects/房颤队列.md", "# 房颤队列\n## 目标\n- 评价抗凝药的真实世界疗效", { type: "project_context", tags: ["project=p_af"] });
  f.seed("recent_work/房颤队列.md", "# 房颤队列\n- 给第 2 章补参考文献（2026-10-24）\n- 整理 Q3 渠道数据（2026-10-22）\n- 画森林图（2026-10-20）\n- 更早的一条（2026-10-01）", { type: "recent_work", tags: ["project=p_af"] });
  f.seed("recent_work/别处.md", "- 另一个项目的活（2026-10-24）", { type: "recent_work", tags: ["project=p_other"] });
  const page = await f.store.profile(f.userId, { holder: { id: f.userId, name: "T" } });
  assert.equal(page.records.filter((record) => record.nativeType === "recent_work").length, 2, "the person can see, edit and forget them like any memory");
  const card = await f.store.projectCard(f.userId, "p_af");
  const row = card.find((entry) => entry.slot === "recent_work");
  assert.deepEqual(card.map((entry) => entry.slot), ["goal", "recent_work"], "last, after the card's own slots");
  assert.equal(row.text, "给第 2 章补参考文献（2026-10-24）；整理 Q3 渠道数据（2026-10-22）；画森林图（2026-10-20）", "three lines, newest first");
  assert.equal((await f.store.projectCard(f.userId, "p_other")).find((entry) => entry.slot === "recent_work").text, "另一个项目的活（2026-10-24）");

  // Written from the catch-all project it has nowhere to be carried: taken out, said why.
  const stray = `${f.root}/recent_work/随手.md`;
  f.stub.extract = () => ({ adds: [{ uri: stray, memory_type: "recent_work", after: "- 帮我改了一封邮件（2026-10-25）" }] });
  await f.commitConversation("c", [{ role: "user", text: "帮我改一封邮件。" }], { projectId: "default" });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(f.stub.files.has(stray), false);
  assert.equal(nativeMemoryCounters().checkActions.recent_work_default_project, 1);
});

test("a note does not move the mark 「与你相关」 reads the memory by: nobody reads a note, so nothing is recomputed for one", options, async (t) => {
  const f = await scene(t);
  const before = await frontierMemoryMark(database(), f.userId);
  await f.commitConversation("a", [{ role: "user", text: "做个 12 个月预算表，要有透视表。" }, { role: "assistant", text: "好的。" }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.observationFiles(f.userId)).length, 1);
  assert.equal(await frontierMemoryMark(database(), f.userId), before, "a note written, a revision of it recorded: the mark stands");
  // A memory does move it.
  f.seed("preferences/self/格式.md", "- 先给结论。", { type: "preferences" });
  await f.overlay.upsertFile({ userId: f.userId, uri: `${f.root}/preferences/self/格式.md`, memoryType: "preferences", body: "- 先给结论。" });
  assert.notEqual(await frontierMemoryMark(database(), f.userId), before);
});
