// What the engine was still extracting when the account reset its memory (2026-10-23, T1.8 / D7): the extraction finishes after the reset,
// its files are what the person asked to forget, and the worker takes them out again instead of reading them in as new memories.
import assert from "node:assert/strict";
import test from "node:test";

import { nativeMemoryCounters } from "../src/nativeMemoryMetrics.mjs";
import { nativeAppIntegration } from "./helpers/nativeAppFixture.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();
const app = nativeAppIntegration();
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

test("an extraction accepted before the reset removes what it wrote, unless the file has been written since", options, async (t) => {
  const { userId, worker, overlay, researchMemory, sessions, commitConversation, seed, root } = await fixture(t, {
    extract: ({ user, session }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/${session.slice(-4)}.md`, memory_type: "preferences", after: `Said in ${session.slice(-4)}.` }] }),
  });
  const said = [{ role: "user", text: "Remember this.", at: hourAgo() }];
  const old = await commitConversation("aaaa", said);
  const rewritten = await commitConversation("bbbb", said);
  const plain = await commitConversation("cccc", [{ role: "user", text: "No time on this one." }]);
  const later = await commitConversation("dddd", [{ role: "user", text: "After the reset.", at: hourAhead() }]);
  // The reset happens while these four extractions are in flight; the one for bbbb is then written over by a later conversation.
  await researchMemory.noteReset(userId);
  seed("preferences/bbbb.md", "Said again, later, by the person.", { type: "preferences" });
  assert.equal(await worker.processCommits({ userId }), 4);

  assert.equal(await sessions.read(userId, `${root}/preferences/aaaa.md`), null, "what a conversation from before the reset wrote is taken out");
  assert.equal(await sessions.read(userId, `${root}/preferences/bbbb.md`), "Said again, later, by the person.", "a file that says anything else is not the extraction's any more");
  assert.equal(await sessions.read(userId, `${root}/preferences/cccc.md`), "Said in cccc.", "a message with no time places the commit nowhere");
  assert.equal(await sessions.read(userId, `${root}/preferences/dddd.md`), "Said in dddd.", "a conversation after the reset is learned from");
  const row = await overlay.commit(userId, old.archive_uri);
  assert.equal(row.state, "completed");
  assert.equal(row.operations, 0);
  assert.equal(row.extraction.beforeReset, 1);
  assert.equal((await overlay.commit(userId, rewritten.archive_uri)).extraction.beforeReset, 0);
  assert.equal((await overlay.commit(userId, plain.archive_uri)).extraction.beforeReset, undefined);
  assert.equal((await overlay.commit(userId, later.archive_uri)).operations, 1);
  // Nothing of the old extraction was read into the overlay as a memory, and no text of it is kept.
  assert.deepEqual(await overlay.revisionsOf(userId, `${root}/preferences/aaaa.md`), []);
  assert.equal(nativeMemoryCounters().workerCommits.before_reset, 2);
  assert.equal(nativeMemoryCounters().workerCommits.ingested, 2);
});

test("an account that never reset is untouched by all of it", options, async (t) => {
  const { userId, worker, sessions, commitConversation, root } = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/plain.md`, memory_type: "preferences", after: "Kept." }] }),
  });
  await commitConversation("eeee", [{ role: "user", text: "Old message.", at: hourAgo() }]);
  assert.equal(await worker.processCommits({ userId }), 1);
  assert.equal(await sessions.read(userId, `${root}/preferences/plain.md`), "Kept.");
  assert.equal(nativeMemoryCounters().workerCommits.before_reset, 0);
});

test("the reset takes its instant, then the files, the engine's sessions and the overlay", app.options, async (t) => {
  const { base, headers, app: server, user, stub, engineUser, seed, sessions } = await app.fixture(t);
  seed("preferences/tone.md", "Plain language.", { type: "preferences" });
  const session = "dsh-session_ffff";
  stub.sessions.set(`${engineUser}/${session}`, { id: session, user: engineUser, archives: 0, commitCount: 0, messages: [{ role: "user", parts: [{ type: "text", text: "Old." }] }] });
  // A live session is a directory in the engine, listed under the account's `sessions/`.
  stub.files.set(`viking://user/${engineUser}/sessions/${session}/messages.jsonl`, "{}");
  assert.equal(await server.researchMemory.resetInstant(user.id), null);
  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  assert.equal(reset.status, 200, await reset.clone().text());
  const instant = await server.researchMemory.resetInstant(user.id);
  assert.ok(instant, "the instant is on the account");
  assert.equal(stub.sessions.has(`${engineUser}/${session}`), false, "the engine's sessions are deleted");
  assert.equal(await sessions.read(user.id, `viking://user/${engineUser}/memories/preferences/tone.md`), null);
  assert.ok(Date.parse(instant) <= Date.now());
});
