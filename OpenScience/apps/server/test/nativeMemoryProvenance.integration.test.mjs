// Where a native memory came from (2026-10-23, rectification T1.6 / I4): the overlay already keeps, on every revision, the engine session
// and the archive of the commit that wrote it; the ledger names the project. Joined, they are the evidence the memory drawer already
// reads — the conversation a memory came out of — and no quotation, because the engine keeps none and none is made up.
import assert from "node:assert/strict";
import test from "node:test";

import { nativeFileId } from "../src/nativeMemoryStore.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

/** What the server's resolver answers: a title per conversation, `null` for a deleted one, nothing for an unknown one. */
function titlesFrom(table, calls = []) {
  return async (userId, refs) => {
    calls.push(refs.map((ref) => `${ref.projectId}/${ref.sessionId}`));
    return Object.fromEntries(refs.filter((ref) => Object.hasOwn(table, ref.sessionId)).map((ref) => [ref.sessionId, table[ref.sessionId]]));
  };
}

test("a memory file names the conversation whose commit wrote it, and the project that conversation was in", options, async (t) => {
  const calls = [];
  const { userId, store, worker, commitConversation, overlay, root } = await fixture(t, {
    extract: ({ user, session }) => (session === "dsh-session_aaaa"
      ? { adds: [{ uri: `viking://user/${user}/memories/preferences/citation.md`, memory_type: "preferences", after: "Cites with numbered references." }] }
      : { updates: [{ uri: `viking://user/${user}/memories/preferences/citation.md`, memory_type: "preferences", before: "Cites with numbered references.", after: "Cites with numbered references; DOIs always." }] }),
    conversationTitles: titlesFrom({ session_aaaa: "给综述加引用", session_bbbb: "统一参考文献格式" }, calls),
  });
  await overlay.noteSession(userId, "dsh-session_aaaa", "p_review");
  await overlay.noteSession(userId, "dsh-session_bbbb", "p_other");
  await commitConversation("aaaa", [{ role: "user", text: "Please cite with numbered references." }], { projectId: "p_review" });
  await commitConversation("bbbb", [{ role: "user", text: "And always give the DOI." }], { projectId: "p_other" });
  assert.equal(await worker.processCommits({ userId }), 2);

  const page = await store.profile(userId);
  const record = page.records.find((entry) => entry.id === nativeFileId(`${root}/preferences/citation.md`));
  assert.ok(record, "the file is on the page");
  // Oldest first: the first is where the memory began, which is what 「来源对话」 links to.
  assert.deepEqual(record.evidence.map((item) => [item.conversationId, item.projectId]), [["session_aaaa", "p_review"], ["session_bbbb", "p_other"]]);
  assert.equal(record.evidenceCount, 2);
  for (const item of record.evidence) {
    assert.match(item.sourceRef, /^sessions\/session_[a-z]{4}\/commits\/archive_001$/);
    assert.equal(item.quote, "", "the engine keeps no quotation and none is made up");
    assert.equal(item.sourceType, "conversation");
    assert.ok(item.observedAt);
  }
  assert.deepEqual(page.conversations, { session_aaaa: "给综述加引用", session_bbbb: "统一参考文献格式" });
  // The drawer's own reading of it.
  assert.match(record.evidence[0].sourceRef, /^sessions\/([^/]+)\//);
  // One resolver call for the page, however many records; a second page inside the minute reads nothing again.
  assert.equal(calls.length, 1);
  await store.profile(userId);
  assert.equal(calls.length, 1, "the titles are kept for a minute: the ledger they come from is a file per project");
});

test("a line of the profile names the commit that brought that line, and a line that was already there names nothing", options, async (t) => {
  let step = 0;
  const { userId, store, worker, commitConversation, overlay, root } = await fixture(t, {
    extract: ({ user }) => {
      step += 1;
      const uri = `viking://user/${user}/memories/profile.md`;
      if (step === 1) return { adds: [{ uri, memory_type: "profile", after: "# Profile\n- Works as a clinical pharmacist (as of 2026-10-01)" }] };
      return { updates: [{ uri, memory_type: "profile", before: "# Profile\n- Works as a clinical pharmacist (as of 2026-10-01)", after: "# Profile\n- Works as a clinical pharmacist (as of 2026-10-01)\n- Based in Chengdu (as of 2026-10-02)" }] };
    },
    conversationTitles: titlesFrom({ session_cccc: "自我介绍", session_dddd: "排班问题" }),
  });
  await overlay.noteSession(userId, "dsh-session_cccc", null);
  await overlay.noteSession(userId, "dsh-session_dddd", "p_shift");
  await commitConversation("cccc", [{ role: "user", text: "I am a clinical pharmacist." }]);
  await worker.processCommits({ userId });
  await commitConversation("dddd", [{ role: "user", text: "I live in Chengdu." }], { projectId: "p_shift" });
  await worker.processCommits({ userId });

  const page = await store.profile(userId);
  const lines = page.records.filter((record) => record.document && record.uri === `${root}/profile.md`);
  const pharmacist = lines.find((line) => /pharmacist/.test(line.value));
  const city = lines.find((line) => /Chengdu/.test(line.value));
  assert.deepEqual(pharmacist.evidence.map((item) => item.conversationId), ["session_cccc"], "the conversation that touched the file later is not the source of this line");
  assert.deepEqual(city.evidence.map((item) => [item.conversationId, item.projectId]), [["session_dddd", "p_shift"]]);
  assert.equal(pharmacist.evidence[0].projectId, undefined, "a conversation with no project names none");
  // The document itself, opened as a file, was written by both.
  const document = await store.getRecord(userId, nativeFileId(`${root}/profile.md`));
  assert.deepEqual(document.evidence.map((item) => item.conversationId), ["session_cccc", "session_dddd"]);
});

test("what no platform conversation wrote has no source conversation: a migration, a replay, the page's own edit", options, async (t) => {
  const { userId, store, worker, commitConversation, seed, root } = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/length.md`, memory_type: "preferences", after: "Short answers." }] }),
    conversationTitles: titlesFrom({}),
  });
  // A migration session: an engine session the plugin did not derive from a conversation.
  await commitConversation("", [{ role: "user", text: "x" }], { origin: "migration", engineSession: "evimed-migrate-abcdef0123456789" });
  await worker.processCommits({ userId });
  const migrated = (await store.profile(userId)).records.find((record) => record.uri === `${root}/preferences/length.md`);
  assert.ok(migrated, "the engine wrote the file");
  assert.deepEqual(migrated.evidence, []);
  assert.equal(migrated.evidenceCount, 0);
  // A file the person wrote on the page is theirs: no conversation either.
  seed("preferences/own.md", "Tables for comparisons.", { type: "preferences" });
  const own = (await store.records(userId)).find((record) => record.key === "preferences/own.md");
  assert.deepEqual(own.evidence, []);
});

test("a deleted conversation is not a source: the link to nothing is dropped, an unknown one stays unnamed, a failing resolver costs only the titles", options, async (t) => {
  const { userId, store, worker, commitConversation, overlay, root } = await fixture(t, {
    extract: ({ user, session }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/${session.slice(-4)}.md`, memory_type: "preferences", after: `Preference of ${session.slice(-4)}.` }] }),
    conversationTitles: titlesFrom({ session_gone: null, session_kept: "保留的对话" }),
  });
  for (const name of ["gone", "kept", "wild"]) {
    await overlay.noteSession(userId, `dsh-session_${name}`, "p_one");
    await commitConversation(name, [{ role: "user", text: `Say ${name}.` }], { projectId: "p_one" });
  }
  await worker.processCommits({ userId });
  const page = await store.profile(userId);
  const byFile = (name) => page.records.find((record) => record.key === `preferences/${name}.md`);
  assert.deepEqual(byFile("gone").evidence, [], "the person deleted that conversation");
  assert.equal(byFile("kept").evidence.length, 1);
  assert.equal(byFile("wild").evidence.length, 1, "an unknown conversation is still a link back, without a title");
  assert.deepEqual(page.conversations, { session_kept: "保留的对话" });
  assert.ok(root);

  // A resolver that fails: the page is served, the sources stay, and nothing is named.
  const failing = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/x.md`, memory_type: "preferences", after: "X." }] }),
    conversationTitles: async () => { throw new Error("the ledger is unreadable"); },
  });
  await failing.overlay.noteSession(failing.userId, "dsh-session_zzzz", "p_one");
  await failing.commitConversation("zzzz", [{ role: "user", text: "x" }], { projectId: "p_one" });
  await failing.worker.processCommits({ userId: failing.userId });
  const fallback = await failing.store.profile(failing.userId);
  assert.deepEqual(fallback.conversations, {});
  assert.equal(fallback.records.find((record) => record.key === "preferences/x.md").evidence.length, 1);
});

test("a search carries the titles of the conversations behind its hits, and a store with no resolver serves the evidence without them", options, async (t) => {
  const { userId, store, worker, commitConversation, overlay } = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/citation.md`, memory_type: "preferences", after: "Cites with numbered references." }] }),
    conversationTitles: titlesFrom({ session_ssss: "给综述加引用" }),
  });
  await overlay.noteSession(userId, "dsh-session_ssss", "p_review");
  await commitConversation("ssss", [{ role: "user", text: "Cite with numbers." }], { projectId: "p_review" });
  await worker.processCommits({ userId });
  const found = await store.search(userId, "numbered");
  assert.equal(found.items.length, 1);
  assert.deepEqual(found.conversations, { session_ssss: "给综述加引用" });
  assert.equal(found.items[0].evidence[0].conversationId, "session_ssss");

  const bare = await fixture(t, { extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/q.md`, memory_type: "preferences", after: "Q." }] }) });
  await bare.overlay.noteSession(bare.userId, "dsh-session_qqqq", "p_review");
  await bare.commitConversation("qqqq", [{ role: "user", text: "q" }], { projectId: "p_review" });
  await bare.worker.processCommits({ userId: bare.userId });
  const page = await bare.store.profile(bare.userId);
  assert.deepEqual(page.conversations, {});
  assert.equal(page.records.find((record) => record.key === "preferences/q.md").evidence.length, 1);
});
