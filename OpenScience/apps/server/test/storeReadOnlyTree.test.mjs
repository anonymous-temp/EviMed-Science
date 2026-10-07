import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryStore } from "../src/store.mjs";

// 2026-10-06: an acceptance account could not be deleted because a run had left a read-only `__pycache__`
// in its workspace — `rm` answered EACCES and the route 500. Deletion must give the owner write access back.

async function readOnlyTreeIn(dir) {
  const leaf = path.join(dir, "workspace", ".audit-repo", "runtime", "__pycache__");
  await mkdir(leaf, { recursive: true });
  await writeFile(path.join(leaf, "module.cpython-312.pyc"), "x");
  await chmod(leaf, 0o555);
  await chmod(path.dirname(leaf), 0o555);
  return leaf;
}

function fileStore(dataDir) {
  return new InMemoryStore({
    dataDir,
    usersFile: path.join(dataDir, "users.json"),
    sessionsFile: path.join(dataDir, ".openscience", "sessions.json"),
    sessionCookieName: "open_science_session",
    sessionTtlMs: 60_000,
  });
}

async function missing(file) {
  return (await stat(file).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)))) == null;
}

test("a project and an account are deleted even when a run left read-only directories in them", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-store-readonly-"));
  try {
    const store = fileStore(dataDir);
    await store.createUser("reader-a", "secret123");
    const user = await store.userById("reader-a");
    await store.createProject(user, "audit-tool-probe", "Probe");
    const projectRoot = path.join(user.rootDir, "projects", "audit-tool-probe");
    await readOnlyTreeIn(projectRoot);
    await store.deleteProject(user, "audit-tool-probe");
    assert.ok(await missing(projectRoot), "the project's directory is gone");

    await store.createProject(user, "second", "Second");
    await readOnlyTreeIn(path.join(user.rootDir, "projects", "second"));
    await store.deleteUser(user);
    assert.ok(await missing(user.rootDir), "the account's directory is gone");
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("restoring access never follows a link out of the tree being removed", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-store-readonly-"));
  const outside = await mkdtemp(path.join(tmpdir(), "evimed-store-outside-"));
  try {
    await chmod(outside, 0o555);
    const store = fileStore(dataDir);
    await store.createUser("reader-b", "secret123");
    const user = await store.userById("reader-b");
    await store.createProject(user, "linked", "Linked");
    const projectRoot = path.join(user.rootDir, "projects", "linked");
    const leaf = await readOnlyTreeIn(projectRoot);
    await chmod(leaf, 0o755);
    await symlink(outside, path.join(leaf, "outside"));
    await chmod(leaf, 0o555);
    await store.deleteProject(user, "linked");
    assert.ok(await missing(projectRoot));
    assert.equal((await stat(outside)).mode & 0o777, 0o555, "the linked directory keeps its mode");
  } finally {
    await chmod(outside, 0o755).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
