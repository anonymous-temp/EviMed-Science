// Where a correction lives (2026-10-23): the unmodified OpenViking plugin lists `preferences/` at a session's start and nothing else of
// ours, so the corrections template writes under `preferences/corrections/`. The control plane must still call such a file a correction
// — on the memory page, on the map, in a capsule export — and must go on reading the files an older template wrote under `corrections/`.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CORRECTIONS_UNDER_PREFERENCES, MEMORY_SEGMENT_OF_TYPE, nativeMemoryFile } from "../src/openVikingSessions.mjs";
import { LEGACY_KIND_OF_TYPE, NativeMemoryStore } from "../src/nativeMemoryStore.mjs";

const ROOT = "viking://user/u1/memories";

test("a file under preferences/corrections/ is a correction; the preferences beside it, and the older corrections/, keep their types", () => {
  assert.equal(CORRECTIONS_UNDER_PREFERENCES, "preferences/corrections");
  assert.deepEqual(nativeMemoryFile(`${ROOT}/preferences/corrections/终点表述.md`, ROOT), { type: "corrections", relPath: "preferences/corrections/终点表述.md" });
  assert.deepEqual(nativeMemoryFile(`${ROOT}/preferences/self/meta分析方法.md`, ROOT), { type: "preferences", relPath: "preferences/self/meta分析方法.md" });
  assert.deepEqual(nativeMemoryFile(`${ROOT}/corrections/endpoint.md`, ROOT), { type: "corrections", relPath: "corrections/endpoint.md" }, "no data is lost to the move of the template");
  // Not a memory: the directory itself, a scaffold, a hidden file, the derived index.
  assert.equal(nativeMemoryFile(`${ROOT}/preferences/corrections`, ROOT), null);
  assert.equal(nativeMemoryFile(`${ROOT}/preferences/corrections/.overview.md`, ROOT), null);
  assert.equal(nativeMemoryFile(`${ROOT}/evimed/capsule/c-x/preference/f1.r1.md`, ROOT), null);
  // The reset still removes both places: preferences/ takes its corrections with it, and corrections/ is its own segment.
  assert.equal(MEMORY_SEGMENT_OF_TYPE.preferences, "preferences");
  assert.equal(MEMORY_SEGMENT_OF_TYPE.corrections, "corrections");
  assert.equal(LEGACY_KIND_OF_TYPE.corrections, "correction");
});

test("the store reads both places as corrections: the page's kind, the type, and the preference list without them", async () => {
  const files = new Map([
    [`${ROOT}/preferences/self/周报.md`, "- 周报压到 200 字、三条"],
    [`${ROOT}/preferences/corrections/双写的含义.md`, "- 提到双写时先说明是应用层还是数据库层"],
    [`${ROOT}/corrections/终点表述.md`, "- 引用研究结果时写明终点定义"],
  ]);
  const sessions = {
    configured: true,
    memoryRoot: () => ROOT,
    async tree() { return [...files].map(([uri, body]) => ({ uri, isDir: false, size: Buffer.byteLength(body), modTime: "2026-10-23T01:00:00Z", tags: [] })); },
    async read(_user, uri) { return files.get(uri) ?? null; },
  };
  const overlay = { configured: true, files: async () => new Map(), revisionsOfMany: async () => new Map(), sources: async () => [] };
  const store = new NativeMemoryStore({ sessions: /** @type {any} */ (sessions), overlay: /** @type {any} */ (overlay) });
  const records = await store.records("u1");
  const byType = (type) => records.filter((record) => record.nativeType === type).map((record) => record.key).sort();
  assert.deepEqual(byType("corrections"), ["corrections/终点表述.md", "preferences/corrections/双写的含义.md"]);
  assert.deepEqual(byType("preferences"), ["preferences/self/周报.md"]);
  assert.deepEqual(records.filter((record) => record.nativeType === "corrections").map((record) => record.kind), ["correction", "correction"]);
  assert.deepEqual(records.filter((record) => record.nativeType === "preferences").map((record) => record.kind), ["preference"]);
});
