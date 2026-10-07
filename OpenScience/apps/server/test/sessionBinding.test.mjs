// A conversation bound to a capability when it is opened reaches the runtime as a file the run policy reads before the
// first request is assembled (`workspaceLayout.sessionBindingFile`). Until 2026-10-07 the binding was a label on the
// composer and in the ledger only, and a study's conversation planned without the engine's tools.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { workspaceLayout } from "@evimed/domain";
import { ResearchSessionStore } from "../src/researchSessions.mjs";
import { RuntimeManager } from "../src/runtimeManager.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "os-binding-"));
  const workspaceDir = path.join(root, "workspace");
  const metaDir = path.join(root, "meta");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(metaDir, { recursive: true });
  const manager = new RuntimeManager({ runtimeMode: "mock", dataDir: root });
  const project = { id: "p1", userId: "u1", rootDir: root, workspaceDir, metaDir };
  return { root, manager, project, file: (/** @type {string} */ id) => path.join(workspaceDir, workspaceLayout.sessionBindingFile(id)) };
}

test("binding a conversation to a specialist writes its capability beside the session's brief files, read-only", async () => {
  const f = await fixture();
  try {
    const registry = new Map([["vcr-protocol", { id: "vcr-protocol", version: "1.2.2", runtimeAgent: "evimed-vcr-protocol", visibility: "public" }]]);
    const sessions = new ResearchSessionStore(registry);
    sessions.onSpecialistBound = (project, sessionId, agentId) => f.manager.writeSessionBinding(project, sessionId, agentId);
    await sessions.put(f.project, "vcr-abc", { mode: "specialist", agentId: "vcr-protocol", agentVersion: "1.2.2" });
    assert.deepEqual(JSON.parse(await readFile(f.file("vcr-abc"), "utf8")), { capability: "vcr-protocol" });
    assert.equal((await stat(f.file("vcr-abc"))).mode & 0o777, 0o444);

    await sessions.put(f.project, "open-1", { mode: "open-domain" });
    await assert.rejects(stat(f.file("open-1")), /ENOENT/, "an open conversation has no binding file");

    // A hook that fails never fails the binding itself.
    sessions.onSpecialistBound = async () => { throw new Error("disk full"); };
    const record = await sessions.put(f.project, "vcr-def", { mode: "specialist", agentId: "vcr-protocol", agentVersion: "1.2.2" });
    assert.equal(record.agentId, "vcr-protocol");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("opening the kernel's window writes the bindings of conversations bound before the file existed, and only those", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.manager.writeSessionBinding(f.project, "kept", "geo-content"), true);
    const written = await f.manager.syncSessionBindings(f.project, [
      { sessionId: "kept", mode: "specialist", agentId: "vcr-protocol" },
      { sessionId: "old-study", mode: "specialist", agentId: "vcr-protocol" },
      { sessionId: "open", mode: "open-domain", agentId: null },
      { sessionId: "../escape", mode: "specialist", agentId: "vcr-protocol" },
    ]);
    assert.equal(written, 1);
    assert.deepEqual(JSON.parse(await readFile(f.file("kept"), "utf8")), { capability: "geo-content" }, "an existing file is left alone");
    assert.deepEqual(JSON.parse(await readFile(f.file("old-study"), "utf8")), { capability: "vcr-protocol" });
    await assert.rejects(stat(f.file("open")), /ENOENT/);
    assert.equal(await f.manager.writeSessionBinding(f.project, "x", "../../etc"), false, "an id outside the closed shape is refused");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
