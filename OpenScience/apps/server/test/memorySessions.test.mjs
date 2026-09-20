// What one conversation's own state still adds to its dispatch.
//
// Everything else this module carried — 「本次用到的背景」, 「本次不用」 and the
// 无痕 switch, with their two routes and the ~200 lines that hydrated the run
// ledger for a panel — was deleted on 2026-09-20 with the bar that was their
// only control. What is left is the capsule a conversation is trying.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sessionDispatchNotes } from "../src/memorySessions.mjs";

function memoryDouble(state) {
  return { configured: true, async sessionState() { return state; } };
}

const capsules = {
  async trialContext(_userId, capsuleId) {
    return capsuleId === "cap_shared" ? "<evimed-capsule-trial>张医生的胶囊</evimed-capsule-trial>" : "";
  },
};

test("a conversation trying someone else's capsule is handed it, and an ordinary one is handed nothing", async () => {
  assert.deepEqual(
    await sessionDispatchNotes({ researchMemory: memoryDouble({ trialCapsuleId: "cap_shared" }), capsules }, "usr_1", "prj_1", "ses_1"),
    ["<evimed-capsule-trial>张医生的胶囊</evimed-capsule-trial>"],
  );
  assert.deepEqual(
    await sessionDispatchNotes({ researchMemory: memoryDouble({ trialCapsuleId: null }), capsules }, "usr_1", "prj_1", "ses_1"),
    [],
    "no trial, nothing added",
  );
});

test("a state that cannot be read adds nothing rather than failing the turn", async () => {
  const down = { configured: true, async sessionState() { throw new Error("down"); } };
  assert.deepEqual(await sessionDispatchNotes({ researchMemory: down, capsules }, "u", "p", "s"), []);
  assert.deepEqual(await sessionDispatchNotes({ researchMemory: { configured: false }, capsules }, "u", "p", "s"), []);
  // A trial whose capsule cannot be read is the same: the turn goes ahead.
  const unreadable = { async trialContext() { throw new Error("gone"); } };
  assert.deepEqual(
    await sessionDispatchNotes({ researchMemory: memoryDouble({ trialCapsuleId: "cap_shared" }), capsules: unreadable }, "u", "p", "s"),
    [],
  );
});

test("the session routes and the panel they served are gone, and the composition no longer mounts them", async () => {
  const module = await import("../src/memorySessions.mjs");
  for (const name of ["createMemorySessionRoutes", "sessionBackground", "mountedMethodsFor", "setAsideMethodName", "setAsideMethodNames"]) {
    assert.equal(module[name], undefined, `${name} is deleted, not kept for a caller that no longer exists`);
  }
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(server, /memorySessionRoutes/, "no route table entry for a module with no routes");
  assert.match(server, /const sessionNotes = await sessionDispatchNotes\(/, "the trial context still reaches a dispatch");
});
