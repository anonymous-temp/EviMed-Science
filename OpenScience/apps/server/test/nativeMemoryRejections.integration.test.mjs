// Forget-and-don't-relearn, in the engine's own words (2026-10-23, T1.9): the worker takes out a line the engine writes that repeats one the
// person removed — verbatim, with something added, or in other words as a model judges — once per commit at the cost of one call, and
// keeps whatever it cannot place. The model here is a double: what it is asked and what is done with its answer are what is held.
import assert from "node:assert/strict";
import test from "node:test";

import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";
import { nativeFileId } from "../src/nativeMemoryStore.mjs";
import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { NativeMemoryWorker } from "../src/nativeMemoryWorker.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

/** A judge double: records each request and answers from `answer(request)`. */
function judgeDouble(answer = () => ({ same: new Map(), stated: new Set() })) {
  /** @type {any[]} */ const requests = [];
  return { requests, available: true, same: async (request) => { requests.push(request); return answer(request); } };
}

/** A worker over the fixture's pieces with this judge; the fixture's own worker has none. */
const workerWith = (f, judge) => new NativeMemoryWorker({ config: f.config, researchMemory: f.researchMemory, sessions: f.sessions, overlay: f.overlay, rejectionJudge: judge, now: f.now });

/** The person removed a file; the engine then writes `after` under `name`. Returns what the file holds afterwards. */
async function removeThenWrite(t, { removedText, after, said = "Let us talk about something else.", judge, extra = {}, name = "citation", memoryType = "preferences" }) {
  let writing = null;
  const f = await fixture(t, { extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/${memoryType}/${name}.md`, memory_type: memoryType, after: writing }] }) });
  const first = f.seed(`${memoryType}/old.md`, removedText, { type: memoryType });
  await f.store.remove(f.userId, nativeFileId(first), { keepText: false, actor: "user" });
  writing = after;
  const worker = workerWith(f, judge);
  await f.commitConversation("rrrr", [{ role: "user", text: said }]);
  await worker.processCommits({ userId: f.userId });
  return { ...f, worker, uri: `${f.root}/${memoryType}/${name}.md`, read: () => f.sessions.read(f.userId, `${f.root}/${memoryType}/${name}.md`), ...extra };
}

test("a line that contains a removed line is taken out in code, with no model asked, and remembered as removed in its own words", options, async (t) => {
  const judge = judgeDouble();
  const f = await removeThenWrite(t, { removedText: "Cites with numbered references.", after: "- Cites with numbered references; always gives the DOI.\n- Prefers metric units.", judge });
  assert.equal(await f.read(), "- Prefers metric units.");
  assert.equal(judge.requests.length, 0, "containment is decidable, so it is code");
  const revision = (await f.overlay.revisionsOf(f.userId, f.uri)).find((entry) => entry.actor === "platform");
  assert.equal(revision.reason, "rejected_reworded");
  assert.equal(revision.change, "updated");
  assert.equal(nativeMemoryCounters().checkActions.rejected_reworded, 1);
  assert.equal(nativeMemoryCounters().rejectionLines.contained, 1);
  // The new wording is on the list too: its own repeat is exact next time.
  assert.ok((await f.overlay.rejectedFingerprints(f.userId, "preferences")).has(lineFingerprint("Cites with numbered references; always gives the DOI.")));
});

test("a line that is only near one goes to one call a commit; what the judge says is the same is taken out, the rest stays", options, async (t) => {
  const judge = judgeDouble((request) => ({ same: new Map(request.candidates.map((candidate, index) => [index, candidate.removed[0].fingerprint]).filter(([index]) => /^Likes/.test(request.candidates[index].text))), stated: new Set() }));
  const f = await removeThenWrite(t, { removedText: "Prefers tables for comparisons.", after: "- Likes comparisons presented as tables.\n- Prefers tables and figures for comparisons of options.\n- Works in a hospital pharmacy.", judge });
  assert.equal(await f.read(), "- Prefers tables and figures for comparisons of options.\n- Works in a hospital pharmacy.", "the line the judge said is the same is out; the one it did not is kept");
  assert.equal(judge.requests.length, 1, "one call for the commit's near lines");
  assert.equal(judge.requests[0].candidates.length, 2);
  assert.equal(judge.requests[0].userId, f.userId);
  assert.deepEqual(judge.requests[0].said, ["Let us talk about something else."], "the call is shown what the person said");
  assert.equal(nativeMemoryCounters().checkActions.rejected_judged, 1);
  assert.equal(nativeMemoryCounters().rejectionLines.judged_same, 0, "the double does not count: the real judge does");
  const revision = (await f.overlay.revisionsOf(f.userId, f.uri)).find((entry) => entry.actor === "platform");
  assert.match(revision.reason, /rejected_judged/);
});

test("a judge that fails keeps the line, and a line no removed one is near is never asked about", options, async (t) => {
  const failing = { requests: [], available: true, same: async () => ({ same: new Map(), stated: new Set() }) };
  const f = await removeThenWrite(t, { removedText: "Prefers tables for comparisons.", after: "- Likes comparisons presented as tables.", judge: failing });
  assert.equal(await f.read(), "- Likes comparisons presented as tables.", "kept: the judge said nothing");
  assert.equal((await f.overlay.revisionsOf(f.userId, f.uri)).filter((entry) => entry.actor === "platform").length, 0);
  const judge = judgeDouble();
  const far = await removeThenWrite(t, { removedText: "Prefers tables for comparisons.", after: "- Works in a hospital pharmacy.", judge });
  assert.equal(await far.read(), "- Works in a hospital pharmacy.");
  assert.equal(judge.requests.length, 0);
  // No judge wired at all: containment and exact repeats are still met, near lines are counted as unjudged and kept.
  const bare = await removeThenWrite(t, { removedText: "Prefers tables for comparisons.", after: "- Likes comparisons presented as tables.", judge: null });
  assert.equal(await bare.read(), "- Likes comparisons presented as tables.");
  assert.equal(nativeMemoryCounters().rejectionLines.judge_failed, 1);
});

test("the person's own words win: a line they said themselves is kept and the removal it repeats is lifted, in code and as the judge sees it", options, async (t) => {
  // Word for word: the engine's line contains the removed one and the person said that line themselves in this conversation.
  const judge = judgeDouble();
  const verbatim = await removeThenWrite(t, { removedText: "Cites with numbered references.", after: "- Cites with numbered references; always gives the DOI.", judge,
    said: "Actually: cites with numbered references; always gives the DOI. That is how I want it." });
  assert.equal(await verbatim.read(), "- Cites with numbered references; always gives the DOI.");
  assert.equal((await verbatim.overlay.rejectedFingerprints(verbatim.userId, "preferences")).has(lineFingerprint("Cites with numbered references.")), false, "their restatement lifted the removal");
  // In other words: the judge says it is the same and that the person said it themselves.
  const stated = judgeDouble((request) => ({ same: new Map([[0, request.candidates[0].removed[0].fingerprint]]), stated: new Set([0]) }));
  const other = await removeThenWrite(t, { removedText: "Prefers tables for comparisons.", after: "- Likes comparisons presented as tables.", judge: stated,
    said: "When I ask you to compare, please use a table." });
  assert.equal(await other.read(), "- Likes comparisons presented as tables.");
  assert.equal((await other.overlay.rejectedFingerprints(other.userId, "preferences")).has(lineFingerprint("Prefers tables for comparisons.")), false);
  assert.equal((await other.overlay.revisionsOf(other.userId, other.uri)).filter((entry) => entry.actor === "platform").length, 0);
});

test("only what a write brought is held to it, a rejection made before the words were kept meets only an exact repeat, and a short removed line is not contained", options, async (t) => {
  const judge = judgeDouble();
  const f = await removeThenWrite(t, { removedText: "Cites with numbered references.", after: "- Prefers metric units.", judge });
  // A line already in the file when a later commit touches it is not this commit's: only what the diff brought is checked.
  f.seed("preferences/already.md", "- Cites with numbered references; DOIs too.\n- Old line.", { type: "preferences" });
  await f.overlay.upsertFile({ userId: f.userId, uri: `${f.root}/preferences/already.md`, memoryType: "preferences", body: "- Cites with numbered references; DOIs too.\n- Old line." });
  f.stub.extract = ({ user }) => ({ updates: [{ uri: `viking://user/${user}/memories/preferences/already.md`, memory_type: "preferences", before: "- Cites with numbered references; DOIs too.\n- Old line.", after: "- Cites with numbered references; DOIs too.\n- Old line.\n- New line." }] });
  f.stub.files.set(`viking://user/${f.engineUser}/memories/preferences/already.md`, "- Cites with numbered references; DOIs too.\n- Old line.\n- New line.");
  await f.commitConversation("ssss", [{ role: "user", text: "Add a line." }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.match(await f.sessions.read(f.userId, `${f.root}/preferences/already.md`), /Cites with numbered references; DOIs too\./, "a line the write did not bring stays");

  // A rejection that has no words (made before they were kept): only an exact repeat meets it.
  await f.database.query("UPDATE evimed_memory.native_rejections SET text=NULL WHERE user_id=$1", [f.userId]);
  f.stub.extract = ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/again.md`, memory_type: "preferences", after: "- Cites with numbered references; always gives the DOI." }] });
  await f.commitConversation("tttt", [{ role: "user", text: "Again." }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, `${f.root}/preferences/again.md`), "- Cites with numbered references; always gives the DOI.");

  // A removed line under the contained minimum is met only by exact repeat.
  const short = await removeThenWrite(t, { removedText: "用表格比较。", after: "- 我也用表格比较，而且喜欢图。", judge: judgeDouble() });
  assert.equal(await short.read(), "- 我也用表格比较，而且喜欢图。");
});

test("a removed line is kept with its words and lifted with them: the rejection list holds what recognition needs and nothing after a reset", options, async (t) => {
  const { userId, store, seed, overlay, root } = await fixture(t);
  const uri = seed("preferences/format.md", "Answers as short paragraphs, tables for comparisons.", { type: "preferences" });
  await store.remove(userId, nativeFileId(uri), { keepText: false, actor: "user" });
  const lines = await overlay.rejectedLines(userId, "preferences");
  assert.deepEqual(lines.map((line) => line.text), ["answers as short paragraphs, tables for comparisons."], "the normalised words, no as-of date");
  assert.equal(lines[0].fingerprint, lineFingerprint("Answers as short paragraphs, tables for comparisons."));
  // The person writes it themselves on the page: the removal is lifted, words and all.
  await store.remember?.call?.(store, userId, "x").catch(() => {});
  await overlay.unreject(userId, "preferences", ["Answers as short paragraphs, tables for comparisons."]);
  assert.deepEqual(await overlay.rejectedLines(userId, "preferences"), []);
  await overlay.reject(userId, "preferences", `${root}/preferences/format.md`, ["Another removed line of mine."]);
  assert.equal((await overlay.rejectedLines(userId, "preferences")).length, 1);
  await overlay.purgeUser(userId);
  assert.deepEqual(await overlay.rejectedLines(userId, "preferences"), [], "a reset takes the words with the rest");
});
