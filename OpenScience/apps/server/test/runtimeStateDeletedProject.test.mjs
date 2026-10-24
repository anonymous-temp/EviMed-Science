import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeManager, appendRuntimeEventForProvider } from "../src/runtimeManager.mjs";

// A runtime that stops after its account was deleted wrote "stopped" back into the account's directory, and the writer's own
// mkdir brought the directory back (2026-10-24, a throwaway account on production: `projects/default/.openscience/` alone).

async function projectIn(tmp) {
  const rootDir = path.join(tmp, "users", "gone", "projects", "default");
  const project = {
    id: "default", userId: "gone", rootDir,
    workspaceDir: path.join(rootDir, "workspace"), runtimeDir: path.join(rootDir, "runtime"), metaDir: path.join(rootDir, ".openscience"),
  };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  return project;
}

const settled = {
  runtime: { kind: "dsh", startedAt: "2026-10-24T13:46:14.461Z", pid: null, sandboxMode: "docker", containerName: "open-science-gone-default-1" },
  attempts: 1, failedAt: Date.now(),
};

test("a stop recorded for a project that still exists writes its state and its event", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rt-state-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const project = await projectIn(tmp);
  await new RuntimeManager({ runtimeMode: "kernel", maxLogFileBytes: 1024 * 1024 }).recordSettledStop(project, settled, "closed");
  assert.equal(JSON.parse(await readFile(path.join(project.metaDir, "runtime-state.json"), "utf8")).event, "stopped");
  assert.match(await readFile(path.join(project.metaDir, "runtime.jsonl"), "utf8"), /"event":"cleanup_recovered"/);
});

test("a stop that lands after the account was deleted leaves no directory behind", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rt-state-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const project = await projectIn(tmp);
  await rm(path.join(tmp, "users", "gone"), { recursive: true, force: true });
  await new RuntimeManager({ runtimeMode: "kernel", maxLogFileBytes: 1024 * 1024 }).recordSettledStop(project, settled, "closed");
  await appendRuntimeEventForProvider(project, "stopped", {}, { maxLogFileBytes: 1024 * 1024 });
  await assert.rejects(lstat(path.join(tmp, "users", "gone")), { code: "ENOENT" });
});
