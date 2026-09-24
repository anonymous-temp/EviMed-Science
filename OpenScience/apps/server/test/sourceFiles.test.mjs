import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { removeSourceCopies, sourceAttemptId, sourceReadCopyDirectory } from "../src/sourceFiles.mjs";

const sourceId = `src_${"a".repeat(32)}`;
const options = { skip: process.platform !== "linux" && "Descriptor-relative deletion runs in the hosted Linux environment" };

async function fixture(t) {
  const root = await fs.mkdtemp("/tmp/evimed-source-files-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  async function file(relative, content = relative) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content); return target;
  }
  const original = await file("project/knowledge-base/original.pdf");
  const report = await file("project/report.md");
  const foreign = await file(`other/knowledge-base/.evimed-derived/${sourceId}/index.md`);
  const other = await file("project/knowledge-base/.evimed-derived/other-source/index.md");
  await file(`project/knowledge-base/.evimed-derived/${sourceId}/generation-1-job-one/index.md`);
  await file(`project/knowledge-base/.evimed-openlist-staging/${sourceId}/job-one/raw.pdf`);
  return { root, projectRoot, file, kept: [original, report, foreign, other] };
}

test("source cleanup removes only its owned copies and is idempotent", options, async t => {
  const f = await fixture(t);
  const input = { projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"] };
  await removeSourceCopies(input);
  await removeSourceCopies(input);
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  for (const relative of [`knowledge-base/.evimed-derived/${sourceId}`, `knowledge-base/.evimed-openlist-staging/${sourceId}`]) {
    await assert.rejects(fs.stat(path.join(f.projectRoot, relative)), { code: "ENOENT" });
  }
});

test("cleanup never follows owned leaf symlinks or a substituted ancestor", options, async t => {
  const f = await fixture(t);
  const managed = path.join(f.projectRoot, "knowledge-base/.evimed-derived");
  await fs.symlink(path.join(f.root, "other"), path.join(managed, sourceId, "linked-originals"));
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: [] });
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  await fs.rename(managed, `${managed}-old`);
  await fs.symlink(path.join(f.root, "other/knowledge-base/.evimed-derived"), managed);
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: [] }));
  assert.ok((await fs.stat(f.kept[2])).isFile());
});

test("an ancestor replacement during the walk cannot redirect deletion outside the opened tree", options, async t => {
  const f = await fixture(t);
  const managed = path.join(f.projectRoot, "knowledge-base/.evimed-derived");
  const read = fs.readdir.bind(fs);
  let swapped = false;
  t.mock.method(fs, "readdir", async (...args) => {
    if (!swapped && String(args[0]).startsWith("/proc/self/fd/")) {
      swapped = true;
      await fs.rename(managed, `${managed}-old`);
      await fs.symlink(path.join(f.root, "other/knowledge-base/.evimed-derived"), managed);
    }
    return read(...args);
  });
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: [] });
  assert.equal(swapped, true);
  for (const target of f.kept.filter(target => !target.includes("project/knowledge-base/.evimed-derived"))) assert.ok((await fs.stat(target)).isFile());
  assert.ok((await fs.stat(path.join(`${managed}-old`, "other-source/index.md"))).isFile());
});

test("unpublished-attempt cleanup preserves a new lease's index and staging copy for the same job", options, async t => {
  const f = await fixture(t);
  const old = sourceAttemptId({ leaseToken: "old-test-lease" });
  const fresh = sourceAttemptId({ leaseToken: "fresh-test-lease" });
  assert.notEqual(old, fresh);
  assert.ok(!old.includes("old-test-lease"));
  const oldFiles = [];
  const freshFiles = [];
  for (const [attempt, files] of [[old, oldFiles], [fresh, freshFiles]]) {
    files.push(await f.file(`project/knowledge-base/.evimed-derived/${sourceId}/generation-1-job-one-${attempt}/index.md`));
    files.push(await f.file(`project/knowledge-base/.evimed-openlist-staging/${sourceId}/job-one-${attempt}/raw.pdf`));
  }
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 1, attemptId: old });
  for (const file of oldFiles) await assert.rejects(fs.stat(file), { code: "ENOENT" });
  for (const file of freshFiles) assert.ok((await fs.stat(file)).isFile());
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["../other"] }), { code: "source_cleanup_path_invalid" });
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 1 }), { code: "source_cleanup_path_invalid" });
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"] });
  for (const file of freshFiles) await assert.rejects(fs.stat(file), { code: "ENOENT" });
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
});

test("the text a document is read into outlives its understanding run's cleanup, and goes only when asked for by name", options, async t => {
  // 2026-09-24: the text is written before the understanding is dispatched
  // now, and the run's cleanup — on a dispatch that found no free runtime, or
  // a cancel — removes the attempt's run directory. The text lives beside it.
  const f = await fixture(t);
  const attempt = sourceAttemptId({ leaseToken: "read-lease" });
  const directory = sourceReadCopyDirectory({ sourceId, generation: 2, jobId: "job-one", attemptId: attempt });
  assert.equal(directory, `knowledge-base/.evimed-derived/${sourceId}/read-2-job-one-${attempt}`);
  const text = await f.file(`project/${directory}/index.md`);
  const run = await f.file(`project/knowledge-base/.evimed-derived/${sourceId}/generation-2-job-one-${attempt}/input.json`);
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 2, attemptId: attempt });
  await assert.rejects(fs.stat(run), { code: "ENOENT" });
  assert.ok((await fs.stat(text)).isFile(), "the run's cleanup never reaches the text");
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 2, attemptId: attempt, readCopy: true });
  await assert.rejects(fs.stat(text), { code: "ENOENT" });
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], readCopy: true }), { code: "source_cleanup_path_invalid" });
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 2, attemptId: attempt, readCopy: true, stagingOnly: true }),
    { code: "source_cleanup_path_invalid" });
});
