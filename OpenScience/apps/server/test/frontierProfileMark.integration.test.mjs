// 「与你相关」 knows its reader's memory has changed by a mark read from the overlay's tables, not by a clock and not by a call from every
// writer: an extraction, a page edit, a forget and a restore of the memory engine's files each leave the mark different, and a change
// nobody made leaves it as it was. The reader's profile is due again at the next round exactly when the mark moved
// (`frontierProfiles.integration.test.mjs` holds the rounds); this holds the mark against the engine's real store and worker, with only the
// engine's wire doubled.
import assert from "node:assert/strict";
import test from "node:test";

import { frontierMemoryMark } from "../src/frontierProfiles.mjs";
import { nativeIntegration } from "./helpers/nativeFixture.mjs";

const { options, fixture } = nativeIntegration();

test("the mark of a reader's memory moves on an extraction, a page edit, a forget and its restore, and on nothing else", options, async (t) => {
  const f = await fixture(t, {
    extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/preferences/dates.md`, memory_type: "preferences", after: "Dates as YYYY-MM-DD." }] }),
  });
  const mark = () => frontierMemoryMark(f.database, f.userId);
  const empty = await mark();
  assert.equal(empty, "0::0", "a reader the overlay has never recorded anything for");

  // The engine extracts a file from a conversation.
  await f.commitConversation("mark", [{ role: "user", text: "dates as YYYY-MM-DD" }]);
  await f.worker.processCommits({ userId: f.userId });
  const extracted = await mark();
  assert.notEqual(extracted, empty, "an extraction");
  assert.match(extracted, /^1:[\d.]+:[1-9]\d*$/, "one file, and the newest revision");

  // The person edits it on the memory page.
  const record = (await f.store.records(f.userId)).find((entry) => entry.nativeType === "preferences");
  assert.ok(record, "the extracted file is a memory of the account");
  const edited = await f.store.update(f.userId, record.id, { value: "Dates as DD/MM/YYYY.", expectedVersion: record.version });
  const afterEdit = await mark();
  assert.notEqual(afterEdit, extracted, "a page edit");

  // They forget it, and bring it back.
  const forgotten = await f.store.update(f.userId, record.id, { status: "archived", expectedVersion: edited.version });
  const afterForget = await mark();
  assert.notEqual(afterForget, afterEdit, "a forget");
  await f.store.undo(f.userId, record.id, { expectedVersion: forgotten.version });
  const afterRestore = await mark();
  assert.notEqual(afterRestore, afterForget, "a restore");

  // Reading it again, and another account's changes, move nothing.
  assert.equal(await mark(), afterRestore);
  const other = await fixture(t);
  await other.commitConversation("elsewhere", [{ role: "user", text: "nothing to learn" }]);
  assert.equal(await mark(), afterRestore, "another reader's memory is not this reader's");
});
