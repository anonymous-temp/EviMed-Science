import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HttpError,
  appendJsonLineNoFollow,
  assertNoSymlinkPath,
  openScopedDirectoryNoFollow,
  readFileNoFollow,
  resolveScopedPath,
  safeId,
  writeFileAtomicNoFollow,
  writeFileExclusiveNoFollow,
} from "../src/security.mjs";

test("a hard link cannot read a file that lives outside the workspace", async () => {
  // Every other containment check is path-based, and the link's path is
  // genuinely inside the root — only the inode gives it away.
  const base = await mkdtemp(path.join(tmpdir(), "os-web-hardlink-"));
  const root = path.join(base, "workspace");
  await mkdir(root, { recursive: true });
  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "content the workspace must not reach", "utf8");
  const planted = path.join(root, "innocent.txt");
  await link(outside, planted);

  await assert.rejects(
    () => readFileNoFollow(root, planted),
    (error) => error instanceof HttpError && error.status === 403 && error.code === "path_forbidden",
  );

  const ordinary = path.join(root, "ordinary.txt");
  await writeFile(ordinary, "ordinary content", "utf8");
  assert.equal(String(await readFileNoFollow(root, ordinary)), "ordinary content");
  await rm(base, { recursive: true, force: true });
});

test("a FIFO in the workspace is refused instead of blocking the request", async () => {
  // mkfifo needs no privilege, so without O_NONBLOCK any workspace occupant
  // could park a reader in open() forever and the type check below would never
  // be reached.
  const root = await mkdtemp(path.join(tmpdir(), "os-web-fifo-"));
  const fifo = path.join(root, "pipe.txt");
  execFileSync("mkfifo", [fifo]);

  const outcome = await Promise.race([
    readFileNoFollow(root, fifo).then(() => "returned").catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
  ]);
  assert.notEqual(outcome, "blocked", "opening a FIFO must not wait for a writer");
  assert.ok(outcome instanceof HttpError && outcome.code === "not_a_file", `unexpected outcome: ${outcome}`);
  await rm(root, { recursive: true, force: true });
});

test("resolveScopedPath keeps relative paths inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-"));
  const full = resolveScopedPath(root, "data/table.csv");

  assert.equal(full, path.join(root, "data/table.csv"));
});

test("resolveScopedPath rejects absolute paths and traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-"));

  assert.throws(() => resolveScopedPath(root, "/etc/passwd"), HttpError);
  assert.throws(() => resolveScopedPath(root, "../secret.txt"), HttpError);
  assert.throws(() => resolveScopedPath(root, "nested/../../secret.txt"), HttpError);
  assert.throws(() => resolveScopedPath(root, "C:\\Users\\secret.txt"), HttpError);
});

test("safeId accepts compact ids and rejects path-like ids", () => {
  assert.equal(safeId("project_1"), "project_1");
  assert.throws(() => safeId("../project"), HttpError);
});

test("assertNoSymlinkPath refuses a symlinked root", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-root-"));
  try {
    const realRoot = path.join(parent, "real-root");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);

    await assert.rejects(
      () => assertNoSymlinkPath(linkedRoot, path.join(linkedRoot, "artifact.txt"), { allowMissingTail: true }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("scoped no-follow file helpers atomically write and read nested files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-io-"));
  try {
    const file = path.join(root, "nested", "artifact.txt");
    await writeFileAtomicNoFollow(root, file, "first", { encoding: "utf8" });
    await writeFileAtomicNoFollow(root, file, "second", { encoding: "utf8" });
    assert.equal(await readFileNoFollow(root, file, "utf8"), "second");
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ["artifact.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive scoped writes are atomic and never replace user files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-exclusive-"));
  try {
    const file = path.join(root, "example", "README.md");
    await writeFileExclusiveNoFollow(root, file, "bundled", { encoding: "utf8" });
    await assert.rejects(
      () => writeFileExclusiveNoFollow(root, file, "replacement", { encoding: "utf8" }),
      (err) => err?.code === "EEXIST",
    );
    assert.equal(await readFileNoFollow(root, file, "utf8"), "bundled");
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ["README.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scoped no-follow file helpers reject final and parent symlinks without changing outside files", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-io-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "final.txt"));
    await assert.rejects(
      () => readFileNoFollow(root, path.join(root, "final.txt"), "utf8"),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    await assert.rejects(
      () => writeFileAtomicNoFollow(root, path.join(root, "final.txt"), "changed", { encoding: "utf8" }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    await symlink(outside, path.join(root, "linked-parent"));
    await assert.rejects(
      () => writeFileAtomicNoFollow(root, path.join(root, "linked-parent", "secret.txt"), "changed", { encoding: "utf8" }),
      (err) => err instanceof HttpError && err.code === "path_forbidden",
    );
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "outside");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Linux scoped directory handles stay pinned when a path is replaced by an outside symlink", { skip: process.platform !== "linux" }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "os-web-security-fd-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  const nested = path.join(root, "nested");
  const moved = path.join(root, "moved");
  await mkdir(nested, { recursive: true });
  await mkdir(outside);
  const opened = await openScopedDirectoryNoFollow(root, nested);
  try {
    await rename(nested, moved);
    await symlink(outside, nested);
    await writeFile(path.join(opened.path, "pinned.txt"), "safe", "utf8");
    assert.equal(await readFile(path.join(moved, "pinned.txt"), "utf8"), "safe");
    await assert.rejects(() => readFile(path.join(outside, "pinned.txt"), "utf8"), (err) => err?.code === "ENOENT");
  } finally {
    await opened.handle.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("appendJsonLineNoFollow rotates oversized jsonl logs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-logs-"));
  const file = path.join(root, ".openscience", "audit.jsonl");

  await appendJsonLineNoFollow(root, file, { message: "first".repeat(20) }, { maxBytes: 80 });
  await appendJsonLineNoFollow(root, file, { message: "second".repeat(20) }, { maxBytes: 80 });

  const current = await readFile(file, "utf8");
  const rotated = await readFile(`${file}.1`, "utf8");
  assert.equal(current.includes("second"), true);
  assert.equal(current.includes("first"), false);
  assert.equal(rotated.includes("first"), true);
});

test("appendJsonLineNoFollow refuses symlinked rotation targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-logs-"));
  const file = path.join(root, ".openscience", "audit.jsonl");
  const outside = path.join(root, "outside.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{\"message\":\"old\"}\n", "utf8");
  await writeFile(outside, "{\"message\":\"outside\"}\n", "utf8");
  await symlink(outside, `${file}.1`);

  await assert.rejects(
    () => appendJsonLineNoFollow(root, file, { message: "new".repeat(20) }, { maxBytes: 8 }),
    HttpError,
  );
  assert.equal(await readFile(outside, "utf8"), "{\"message\":\"outside\"}\n");
});

test("Linux scoped reads survive a concurrent atomic replace of the same file", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-replace-"));
  const file = path.join(root, "ledger.jsonl");
  await writeFile(file, "seed\n", "utf8");
  let missing = 0;
  const replaces = (async () => {
    for (let round = 0; round < 1200; round += 1) {
      await writeFileAtomicNoFollow(root, file, `line ${round}\n`, { encoding: "utf8" });
    }
  })();
  const reads = (async () => {
    for (let round = 0; round < 1200; round += 1) {
      try {
        await readFileNoFollow(root, file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "file_not_found") missing += 1;
        else throw error;
      }
    }
  })();
  try {
    await Promise.all([replaces, reads]);
    assert.equal(missing, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux descriptor checks do not accept a live file named like an unlinked one", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "os-web-security-deleted-"));
  const file = path.join(root, "report (deleted)");
  await writeFile(file, "present\n", "utf8");
  try {
    assert.equal(await readFileNoFollow(root, file, "utf8"), "present\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
