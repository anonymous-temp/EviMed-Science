import assert from "node:assert/strict";
import test from "node:test";

import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";

const ROOT = "viking://user/u1/memories";
const URI = `${ROOT}/profile.md`;

test("pending source-review rows drop the active profile's trailing as-of stamp", async () => {
  const sessions = {
    configured: true,
    engineUser: () => "u1",
    userRoot: () => "viking://user/u1",
    memoryRoot: () => ROOT,
  };
  const overlay = {
    configured: true,
    database: {},
    pendingCommits: async () => [],
    forgetRequestCommits: async () => [],
    pendingInstructionRevisions: async () => [{
      id: "revision-1",
      uri: URI,
      before: "- 对青霉素过敏 (as of 2026-11-15)\n- 已核对的另一句",
      after: "- 已核对的另一句",
      changedAt: "2026-11-15T04:17:00.000Z",
      pendingFingerprints: null,
    }],
    files: async () => new Map(),
  };
  const store = new NativeMemoryStore({ sessions: /** @type {any} */ (sessions), overlay: /** @type {any} */ (overlay) });
  store.instructionWriteCheck = async () => null;

  const pending = await store.pending("u1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, "对青霉素过敏");
  assert.equal(pending[0].reason, "instruction_origin_uncertain");
});
