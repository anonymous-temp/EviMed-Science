// The earlier versions a memory page lists are the file's own words with the forgotten lines taken out (dc88c32aa). When the list of forgotten
// lines cannot be read, nothing can tell which words those are: the versions are left out rather than shown, and the page still opens.
import assert from "node:assert/strict";
import { test } from "node:test";

import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { lineFingerprint } from "../src/nativeMemoryOverlay.mjs";

const ROOT = "viking://user/u1/memories";
const URI = `${ROOT}/preferences/journal.md`;
const FORGOTTEN = "Target journal is Kidney International and nothing else.";
const KEPT = "Reference style is Vancouver.";

function store(overlayExtra) {
  const sessions = {
    configured: true, engineUser: () => "u1", userRoot: () => "viking://user/u1", memoryRoot: () => ROOT,
    async tree() { return [{ uri: URI, relPath: "preferences/journal.md", isDir: false, size: 10, modTime: "2026-10-30T01:00:00.000Z", tags: [] }]; },
    async read() { return "Target journal is JASN and nothing else."; },
  };
  const overlay = {
    configured: true,
    files: async () => new Map(),
    revisionsOfMany: async () => new Map([[URI, [{ id: "r1", actor: "user", change: "updated", changedAt: "2026-10-30T02:00:00.000Z", reason: "edited on the memory page",
      before: `- ${FORGOTTEN}\n- ${KEPT}`, after: "- Target journal is JASN and nothing else." }]]]),
    sources: async () => [], originsOf: async () => new Map(), sessionProjects: async () => new Map(),
    ...overlayExtra,
  };
  return new NativeMemoryStore({ sessions: /** @type {any} */ (sessions), overlay: /** @type {any} */ (overlay) });
}
const versions = async (memories) => (await memories.records("u1")).find((record) => record.uri === URI).revisions;

test("an earlier version is listed without the words the person forgot", async () => {
  const forgotten = [{ fingerprint: lineFingerprint(FORGOTTEN), text: FORGOTTEN, origin: "forget" }];
  const [only] = await versions(store({ forgottenLines: async () => forgotten }));
  assert.ok(only.value.includes(KEPT));
  assert.ok(!only.value.includes("Kidney International"));
});

test("a read of the forgotten lines that fails lists no earlier versions, and the memory is still there", async () => {
  for (const forgottenLines of [async () => { throw new Error("database down"); }, () => { throw new Error("not a promise"); }, undefined]) {
    const memories = store({ forgottenLines });
    const records = await memories.records("u1");
    assert.equal(records.length, 1, "the page still lists the memory");
    assert.deepEqual(records[0].revisions, [], "no version that could show a forgotten word");
    assert.ok(!JSON.stringify(records).includes("Kidney International"), "no forgotten word anywhere in the records");
  }
});
