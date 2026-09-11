import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { removeSourceCopies, sourceAttemptId, stageParserInput } from "../src/sourceFiles.mjs";

const sourceId = `src_${"a".repeat(32)}`;
const options = { skip: process.platform !== "linux" && "Descriptor-relative deletion runs in the hosted Linux environment" };

test("parser staging keeps writer ownership and grants only the parser group read access", async t => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parserGid = process.getgid();
  const input = { stagingRoot: root, relative: "job-one-attempt/paper.pdf", bytes: Buffer.from("synthetic PDF bytes"), parserGid };
  const file = await stageParserInput(input);
  assert.equal(file, path.join(root, input.relative));
  for (const directory of [root, path.dirname(file)]) {
    const info = await fs.stat(directory);
    assert.equal(info.uid, process.getuid());
    assert.equal(info.gid, parserGid);
    assert.equal(info.mode & 0o777, 0o710);
  }
  const info = await fs.stat(file);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.gid, parserGid);
  assert.equal(info.mode & 0o777, 0o440);
  assert.deepEqual(await fs.readFile(file), input.bytes);
});

test("parser staging rejects unavailable groups and linked attempt paths", async t => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const groups = new Set([process.getgid(), ...process.getgroups()]);
  let unavailable = 65000;
  while (groups.has(unavailable)) unavailable--;
  const input = { stagingRoot: root, relative: "job/paper.pdf", bytes: Buffer.from("payload"), parserGid: unavailable };
  await assert.rejects(stageParserInput(input), { code: "document_parser_group_unavailable" });
  assert.deepEqual(await fs.readdir(root), []);
  const outside = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, "job"));
  await assert.rejects(stageParserInput({ ...input, parserGid: process.getgid() }), { code: "path_forbidden" });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, "job"));
  await fs.mkdir(path.join(root, "job"));
  const original = path.join(outside, "original.pdf");
  await fs.writeFile(original, "retained original");
  await fs.link(original, path.join(root, input.relative));
  await assert.rejects(stageParserInput({ ...input, parserGid: process.getgid() }), { code: "path_forbidden" });
  assert.equal(await fs.readFile(original, "utf8"), "retained original");
});

for (const permission of ["file", "directory"]) test(`parser staging cleans its unpublished input when ${permission} permissions fail`, async t => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const open = fs.open.bind(fs);
  let injected = false;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const info = await handle.stat();
    if (!injected && (permission === "file" ? info.isFile() : info.isDirectory() && String(args[0]).endsWith("/job"))) {
      injected = true;
      handle.chmod = async () => { throw Object.assign(new Error("Synthetic permission failure"), { code: "EPERM" }); };
    }
    return handle;
  });
  await assert.rejects(stageParserInput({ stagingRoot: root, relative: "job/paper.pdf", bytes: Buffer.from("payload"),
    parserGid: process.getgid() }), { code: "EPERM" });
  assert.equal(injected, true);
  assert.deepEqual(await fs.readdir(root), []);
});

test("parser staging never replaces or cleans another publisher's input", async t => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-collision-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = fs.link.bind(fs);
  t.mock.method(fs, "link", async (from, to) => {
    await fs.writeFile(to, "concurrent publisher", { mode: 0o600 });
    return link(from, to);
  });
  await assert.rejects(stageParserInput({ stagingRoot: root, relative: "job/paper.pdf", bytes: Buffer.from("payload"),
    parserGid: process.getgid() }), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(root, "job/paper.pdf"), "utf8"), "concurrent publisher");
  assert.deepEqual(await fs.readdir(path.join(root, "job")), ["paper.pdf"]);
});

test("real Linux capability-free Web hands readable immutable bytes to the parser group", {
  skip: (process.platform !== "linux" || process.getuid() !== 0) && "Requires an isolated Linux root test process with setpriv",
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/evimed-parser-permissions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o755);
  const stagingRoot = path.join(root, "staging");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  await fs.mkdir(projectRoot, { mode: 0o700 });
  // CI's checkout can be private to the runner account. A root process without
  // DAC capabilities cannot traverse that account's directories. Copy the exact
  // production module closure into this test's owned directory before dropping
  // privileges; do not widen checkout permissions or replace code with a stub.
  const code = path.join(root, "code");
  await fs.mkdir(code, { mode: 0o700 });
  for (const name of ["sourceFiles.mjs", "security.mjs"]) {
    const bytes = await fs.readFile(new URL(`../src/${name}`, import.meta.url));
    await fs.writeFile(path.join(code, name), bytes, { mode: 0o600 });
    assert.deepEqual(await fs.readFile(path.join(code, name)), bytes);
  }
  const domain = path.join(code, "node_modules/@evimed/domain");
  await fs.mkdir(domain, { recursive: true, mode: 0o700 });
  for (const name of ["package.json", "index.mjs", "src"]) {
    await fs.cp(new URL(`../../../packages/domain/${name}`, import.meta.url), path.join(domain, name), { recursive: true });
  }
  const module = pathToFileURL(path.join(code, "sourceFiles.mjs")).href;
  const attempt = "b".repeat(24);
  const relative = `job-one-${attempt}/paper.pdf`;
  const file = path.join(stagingRoot, relative);
  const payload = "Owned input bytes for the read-only parser";
  const child = (uid, gid, groupArgs, script) => execFileSync("setpriv", [
    `--reuid=${uid}`, `--regid=${gid}`, ...groupArgs, "--bounding-set=-all", "--inh-caps=-all",
    "--ambient-caps=-all", "--no-new-privs", process.execPath, "--input-type=module", "--eval", script,
  ], { encoding: "utf8", timeout: 10000 });
  const common = String.raw`import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    const status=await fs.readFile('/proc/self/status','utf8');
    for (const key of ['CapEff','CapPrm','CapBnd']) assert.match(status,new RegExp(key+':\\s+0+\\n'));
    assert.match(status,/NoNewPrivs:\s+1/);`;
  child(0, 0, ["--groups=1000"], `${common}
    const {stageParserInput}=await import(${JSON.stringify(module)});
    await stageParserInput({...${JSON.stringify({ stagingRoot, relative, parserGid: 1000 })},bytes:Buffer.from(${JSON.stringify(payload)})});
    await assert.rejects(fs.chown(${JSON.stringify(file)},1000,1000),{code:'EPERM'});`);
  const info = await fs.stat(file);
  assert.equal(info.uid, 0);
  assert.equal(info.gid, 1000);
  assert.equal(info.mode & 0o777, 0o440);
  child(1000, 1000, ["--clear-groups"], `${common}
    assert.equal(await fs.readFile(${JSON.stringify(file)},'utf8'),${JSON.stringify(payload)});
    await assert.rejects(fs.writeFile(${JSON.stringify(file)},'changed'),{code:'EACCES'});
    await assert.rejects(fs.readdir(${JSON.stringify(stagingRoot)}),{code:'EACCES'});`);
  child(1001, 1001, ["--clear-groups"], `${common}
    await assert.rejects(fs.readFile(${JSON.stringify(file)}),{code:'EACCES'});`);
  child(0, 0, ["--clear-groups"], `${common}
    const {stageParserInput}=await import(${JSON.stringify(module)});
    await assert.rejects(stageParserInput({...${JSON.stringify({ stagingRoot, relative, parserGid: 1000 })},bytes:Buffer.from('new')}),{code:'document_parser_group_unavailable'});`);
  child(0, 0, ["--groups=1000"], `${common}
    const {removeSourceCopies}=await import(${JSON.stringify(module)});
    await removeSourceCopies(${JSON.stringify({ projectRoot, sourceId, jobIds: ["job-one"], generation: 1,
      attemptId: attempt, stagingOnly: true, parserStagingRoot: stagingRoot })});`);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
async function fixture(t) {
  const root = await fs.mkdtemp("/tmp/evimed-source-files-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const parserStagingRoot = path.join(root, "parser");
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
  await file("parser/job-one/raw.pdf");
  const otherStage = await file("parser/other-job/raw.pdf");
  return { root, projectRoot, parserStagingRoot, file, kept: [original, report, foreign, other, otherStage] };
}

test("source cleanup removes only its owned copies and is idempotent", options, async t => {
  const f = await fixture(t);
  const input = { projectRoot: f.projectRoot, parserStagingRoot: f.parserStagingRoot, sourceId, jobIds: ["job-one"] };
  await removeSourceCopies(input);
  await removeSourceCopies(input);
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  for (const relative of [`knowledge-base/.evimed-derived/${sourceId}`, `knowledge-base/.evimed-openlist-staging/${sourceId}`]) {
    await assert.rejects(fs.stat(path.join(f.projectRoot, relative)), { code: "ENOENT" });
  }
  await assert.rejects(fs.stat(path.join(f.parserStagingRoot, "job-one")), { code: "ENOENT" });
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

test("unpublished-attempt cleanup preserves a new lease's index and both staging copies for the same job", options, async t => {
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
    files.push(await f.file(`parser/job-one-${attempt}/raw.pdf`));
  }
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 1, attemptId: old, parserStagingRoot: f.parserStagingRoot });
  for (const file of oldFiles) await assert.rejects(fs.stat(file), { code: "ENOENT" });
  for (const file of freshFiles) assert.ok((await fs.stat(file)).isFile());
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["../other"] }), { code: "source_cleanup_path_invalid" });
  await assert.rejects(removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], generation: 1 }), { code: "source_cleanup_path_invalid" });
  await removeSourceCopies({ projectRoot: f.projectRoot, sourceId, jobIds: ["job-one"], parserStagingRoot: f.parserStagingRoot });
  for (const file of freshFiles) await assert.rejects(fs.stat(file), { code: "ENOENT" });
  for (const target of f.kept) assert.ok((await fs.stat(target)).isFile());
});
