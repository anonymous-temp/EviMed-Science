// What a run changed in its workspace (course correction 2026-10-12, GA16): the files an ordinary conversation produced,
// found by what is new or modified between its start and its end, whichever tool wrote them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WORKSPACE_WALK_DEPTH, workspaceChangedFiles } from "../src/runWorkspaceChanges.mjs";

async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "os-workspace-changes-"));
  try {
    const put = async (relative, text = "x", at = null) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), text);
      if (at != null) await utimes(path.join(root, relative), new Date(at), new Date(at));
    };
    await fn({ root, put });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a file is the run's when it was written inside the run's window, and only then", async () => {
  await withWorkspace(async ({ root, put }) => {
    const start = Date.parse("2026-10-13T08:00:00Z");
    const end = start + 60_000;
    await put("before.docx", "x", start - 5_000);
    await put("during.docx", "x", start + 20_000);
    await put("at-the-start.md", "x", start);
    await put("after.xlsx", "x", end + 5_000);
    await put("sub/dir/during.py", "x", start + 30_000);
    assert.deepEqual(await workspaceChangedFiles(root, { since: start, until: end }), ["at-the-start.md", "during.docx", "sub/dir/during.py"]);
    // No end known: everything since the start.
    assert.deepEqual(await workspaceChangedFiles(root, { since: start }), ["after.xlsx", "at-the-start.md", "during.docx", "sub/dir/during.py"]);
    assert.deepEqual(await workspaceChangedFiles(root, { since: Number.NaN }), [], "no start, no window");
  });
});

test("scratch, dependencies, hidden names and the platform's partitions are not walked", async () => {
  await withWorkspace(async ({ root, put }) => {
    const now = Date.now();
    for (const relative of ["tmp/a.py", "work/b.md", "venv/lib/c.py", "node_modules/p/d.js", "a/__pycache__/e.pyc", ".hidden/f", ".evimed-run/state.json", "data/g.csv", "knowledge-base/h.md", "library/i.md", "task-plan.json", "delivery-receipt.json", ".dotfile"]) await put(relative);
    await put("report.md");
    await put("a/keep.txt");
    assert.deepEqual(await workspaceChangedFiles(root, { since: now - 5_000 }), ["a/keep.txt", "report.md"]);
    // The partitions only close at the root: a nested directory of the same name is the person's.
    await put("project/data/results.csv");
    await put("project/knowledge-base/notes.md");
    assert.deepEqual(await workspaceChangedFiles(root, { since: now - 5_000 }), ["a/keep.txt", "project/data/results.csv", "project/knowledge-base/notes.md", "report.md"]);
  });
});

test("a link is neither followed nor listed, and the walk is bounded in depth, entries and files", async () => {
  await withWorkspace(async ({ root, put }) => {
    const now = Date.now();
    const outside = await mkdtemp(path.join(tmpdir(), "os-workspace-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "host file");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
      await symlink(outside, path.join(root, "linked-dir"));
      await put("real.txt");
      assert.deepEqual(await workspaceChangedFiles(root, { since: now - 5_000 }), ["real.txt"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const deep = Array.from({ length: WORKSPACE_WALK_DEPTH + 2 }, (_, index) => `d${index}`).join("/");
    await put(`${deep}/too-deep.md`);
    await put("d0/d1/reachable.md");
    assert.deepEqual(await workspaceChangedFiles(root, { since: now - 5_000 }), ["d0/d1/reachable.md", "real.txt"]);
    for (let index = 0; index < 12; index += 1) await put(`many/f-${String(index).padStart(2, "0")}.txt`);
    assert.equal((await workspaceChangedFiles(root, { since: now - 5_000, limit: 5 })).length, 5);
    assert.ok((await workspaceChangedFiles(root, { since: now - 5_000, maxEntries: 3 })).length <= 3);
  });
  assert.deepEqual(await workspaceChangedFiles(path.join(tmpdir(), "os-no-such-workspace"), { since: 0 }), [], "a workspace that is not there has no changes");
});
