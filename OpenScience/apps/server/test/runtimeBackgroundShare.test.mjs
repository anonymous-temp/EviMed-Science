import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtimeManager.mjs";

// Background work in a researcher's own projects holds at most one slot less
// than their ceiling (owner, 2026-10-08): two background analysis runs had held
// both slots of an account while its third study's conversation waited.

const budget = (runId) => ({ runId, dailyLimit: 50, weeklyLimit: 200, runLimit: 10 });

async function fixture(t, maxRunningRuntimesPerUser) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "background-share-"));
  const manager = new RuntimeManager({ runtimeMode: "mock", allowMockRuntime: true, production: false,
    maxRunningRuntimes: 8, maxRunningRuntimesPerUser, runtimeIdleTimeoutMs: 12 * 60 * 60_000 });
  t.after(async () => { await manager.closeAll(); await rm(rootDir, { recursive: true, force: true }); });
  const project = async (userId, id) => {
    const base = path.join(rootDir, userId, id);
    const value = { id, userId, rootDir: base, baseDir: base, metaDir: path.join(base, ".openscience"),
      workspaceDir: path.join(base, "workspace"), runtimeDir: path.join(base, "runtime") };
    await mkdir(value.workspaceDir, { recursive: true });
    return value;
  };
  return { manager, project };
}

test("background work holds one slot less than the account's ceiling and the researcher still opens a conversation", async t => {
  const { manager, project } = await fixture(t, 2);
  const studyA = await project("alice", "study-a");
  const studyB = await project("alice", "study-b");
  const studyC = await project("alice", "study-c");
  await manager.reserveBoundedRuntimeSession(studyA, budget("vcr-step-a"));
  await assert.rejects(manager.reserveBoundedRuntimeSession(studyB, budget("vcr-step-b")),
    (error) => error.code === "runtime_capacity_full" && error.status === 429);
  assert.equal(manager.boundedRuntimeScope(studyB), null, "a refused reservation leaves nothing reserved");
  // The slot the share leaves is the researcher's: their conversation opens.
  await manager.start(studyC, { opening: true });
  assert.ok(manager.runtimes.has(manager.key(studyC)));
  const stats = manager.statsAll().background;
  assert.equal(stats.shareRefusals, 1);
  assert.equal(stats.inResearcherProjects, 1);
  // The finished step gives its slot back and the waiting one starts on its next pass.
  await manager.endBoundedRuntime(studyA, "vcr-step-a");
  await manager.reserveBoundedRuntimeSession(studyB, budget("vcr-step-b"));
  assert.equal(manager.boundedRuntimeScope(studyB).runId, "vcr-step-b");
});

test("another account's background work is not this account's share", async t => {
  const { manager, project } = await fixture(t, 2);
  await manager.reserveBoundedRuntimeSession(await project("bob", "geo"), budget("geo-step"));
  await manager.reserveBoundedRuntimeSession(await project("alice", "study"), budget("vcr-step"));
  assert.equal(manager.statsAll().background.inResearcherProjects, 2);
});

test("a ceiling of one leaves background work its one slot", async t => {
  const { manager, project } = await fixture(t, 1);
  await manager.reserveBoundedRuntimeSession(await project("alice", "study"), budget("vcr-step"));
  assert.equal(manager.statsAll().background.shareRefusals, 0);
});

test("a ceiling of three lets background work hold two", async t => {
  const { manager, project } = await fixture(t, 3);
  await manager.reserveBoundedRuntimeSession(await project("alice", "s1"), budget("r1"));
  await manager.reserveBoundedRuntimeSession(await project("alice", "s2"), budget("r2"));
  await assert.rejects(manager.reserveBoundedRuntimeSession(await project("alice", "s3"), budget("r3")), { code: "runtime_capacity_full" });
});
