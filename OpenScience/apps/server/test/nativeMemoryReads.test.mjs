// What reading an account's native memory costs the engine (r19-walkfix): the memory page asks for the list, a project's overview and the
// changes at once, and each of them read every file. A stub engine with a latency counts what reaches it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";

const ROOT = "viking://user/u1/memories";

/** An engine of `count` files, each read taking `delay` ms; counts listings and reads. */
function engine({ count = 20, delay = 5 } = {}) {
  const files = new Map(Array.from({ length: count }, (_unused, index) => [`${ROOT}/preferences/p${index}.md`, { body: `- 偏好 ${index}`, modTime: `2026-10-18T01:00:${String(index).padStart(2, "0")}.000Z` }]));
  const calls = { tree: 0, read: 0, replace: 0 };
  const sessions = {
    configured: true,
    memoryRoot: () => ROOT,
    async tree() {
      calls.tree += 1;
      return [...files].map(([uri, file]) => ({ uri, relPath: uri.slice(ROOT.length + 1), isDir: false, size: Buffer.byteLength(file.body), modTime: file.modTime, tags: [] }));
    },
    async read(_user, uri) {
      calls.read += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return files.get(uri)?.body ?? null;
    },
    async replace(_user, uri, text) {
      calls.replace += 1;
      files.set(uri, { body: text, modTime: files.get(uri)?.modTime ?? "" });
      return true;
    },
  };
  const overlay = {
    configured: true,
    files: async () => new Map(),
    revisionsOfMany: async () => new Map(),
    sources: async () => [],
    reject: async () => {}, unreject: async () => {}, addRevision: async () => {}, upsertFile: async () => {}, setSources: async () => {},
  };
  return { files, calls, store: new NativeMemoryStore({ sessions: /** @type {any} */ (sessions), overlay: /** @type {any} */ (overlay) }) };
}

test("three reads of one account that overlap are one read of the engine", async () => {
  const { store, calls } = engine({ count: 20 });
  const [profile, overview, again] = await Promise.all([store.files("u1"), store.files("u1"), store.records("u1")]);
  assert.equal(profile.length, 20);
  assert.equal(overview, profile, "the second caller shared the first's read");
  assert.equal(again.length, 20);
  assert.equal(calls.tree, 1, "one listing");
  assert.equal(calls.read, 20, "one read per file, not three");
});

test("a read that begins after another has ended is its own, but a file that has not changed is not read again", async () => {
  const { store, calls, files } = engine({ count: 10 });
  await store.files("u1");
  assert.equal(calls.read, 10);
  await store.files("u1");
  assert.equal(calls.tree, 2, "the listing is always the engine's");
  assert.equal(calls.read, 10, "no file moved, so no file was read");
  // The engine changes one file (its modTime moves): that file, and only that file, is read.
  const uri = `${ROOT}/preferences/p3.md`;
  files.set(uri, { body: "- 偏好 3，改过了", modTime: "2026-10-18T02:00:00.000Z" });
  const read = await store.files("u1");
  assert.equal(calls.read, 11);
  assert.equal(read.find((file) => file.uri === uri)?.body, "- 偏好 3，改过了");
  // A file the engine no longer lists is forgotten with it.
  files.delete(uri);
  assert.equal((await store.files("u1")).length, 9);
});

test("an engine without a modTime is read every time: nothing is kept that cannot be told from what changed", async () => {
  const { store, calls, files } = engine({ count: 4 });
  for (const [uri, file] of files) files.set(uri, { ...file, modTime: /** @type {any} */ (null) });
  await store.files("u1");
  await store.files("u1");
  assert.equal(calls.read, 8);
});

test("a write forgets the account's bodies, so the page reads back what it just wrote — even where the engine's clock did not move", async () => {
  const { store, calls, files } = engine({ count: 3 });
  const [record] = await store.records("u1");
  assert.equal(calls.read, 3);
  const uri = record.uri;
  const modTime = files.get(uri)?.modTime ?? "";
  // The engine rewrites the file at the same instant and the same length: only the store's own write can tell the cache the body is old.
  await store.update("u1", record.id, { value: "- 偏好 Z", expectedVersion: record.version });
  files.set(uri, { body: "- 偏好 Z", modTime });
  assert.equal(Buffer.byteLength("- 偏好 Z"), Buffer.byteLength("- 偏好 0"), "the same size, the same modTime");
  const read = (await store.files("u1")).find((file) => file.uri === uri);
  assert.equal(read?.body, "- 偏好 Z");
  assert.equal(calls.read, 3 + 3, "every body was read again after the write (and the one the write made)");
});

test("a read that was under way when a write happened is not shared with the readers after it", async () => {
  const { store, calls } = engine({ count: 6, delay: 20 });
  const before = store.files("u1");
  // A write begins (the store counts it), then another reader arrives: it gets a read of its own.
  await store.remember("u1", { text: "记一下" }).catch(() => null);
  const after = store.files("u1");
  assert.notEqual(await before, await after);
  assert.equal(calls.tree, 2);
});
