// What else a run can make in its own workspace that an archive cannot carry
// is recorded and left out, never a failed backup — the class the 2026-09-26/27
// symlinks belonged to. Found by sweeping it on 2026-09-27, each of these
// failed every tenant's backup: a FIFO, a hard-linked file, a name that is
// not UTF-8, a file the backup may not read. Outside a workspace each is still
// a refusal. A hard-linked file whose every name is in one workspace is its
// bytes, and is archived once; one with a name elsewhere is not archived, and
// the note says so.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const manifestName = ".open-science-backup-manifest.json";
const environment = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "", OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "", OPEN_SCIENCE_BACKUP_STRICT: "false",
  OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: "" };
const workspace = "users/u/projects/p/workspace";
const omittedPrefix = "backup note: workspace entries left out of the archive: ";
// Root reads a mode-000 file anyway, so there is nothing unreadable to record.
const privileged = process.getuid?.() === 0;
const contained = "HARDLINK_CONTAINED_BYTES_ARCHIVED_ONCE";
const shared = "HARDLINK_SHARED_BYTES_NEVER_ARCHIVED";
const gbkFile = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]); // 中文.txt in GBK
// 数据 in GBK. Not every GBK name is invalid UTF-8: 目录 (c4bf c2bc) decodes
// cleanly as "Ŀ¼" and is, correctly, archived under that name.
const gbkDirectory = Buffer.from([0xca, 0xfd, 0xbe, 0xdd]);

function supportsRawNames(directory) {
  const file = Buffer.concat([Buffer.from(`${directory}/raw-probe-`), gbkFile]);
  const folder = Buffer.concat([Buffer.from(`${directory}/raw-probe-`), gbkDirectory]);
  let wrote = false, made = false;
  try {
    fs.writeFileSync(file, "probe"); wrote = true;
    fs.mkdirSync(folder); made = true;
    return true;
  } catch (error) {
    if (["EILSEQ", "EINVAL"].includes(error.code)) return false;
    throw error;
  } finally {
    if (made) fs.rmdirSync(folder);
    if (wrote) fs.unlinkSync(file);
  }
}

async function scratch(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-entries-"));
  t.after(async () => {
    await execute("chmod", ["-R", "u+rwx", root]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function put(data, relative, value) {
  const target = path.join(data, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

/** Every kind, inside one workspace, and what the backup must record for it. */
async function fixture(t) {
  const root = await scratch(t);
  const data = path.join(root, "data");
  const ws = path.join(data, workspace);
  await put(data, `${workspace}/kept.txt`, "kept\n");
  await put(data, `${workspace}/notes.sock`, "A file of the tenant's, whatever its name.\n");
  await execute("mkfifo", [path.join(ws, "pipe")]);
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path.join(ws, "endpoint"), resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Every name in this workspace: archived once, the other name an alias.
  await put(data, `${workspace}/a-first.txt`, `${contained}\n`);
  await mkdir(path.join(ws, "sub"));
  await link(path.join(ws, "a-first.txt"), path.join(ws, "sub/b-second.txt"));
  // A name in the runtime's package cache, which the backup never walks.
  const cache = await put(data, "users/u/projects/p/runtime/container-runtime/xdg-cache/pkg.txt", `${shared}\n`);
  await link(cache, path.join(ws, "from-cache.txt"));
  // A name in another project's workspace.
  const other = await put(data, "users/u/projects/q/workspace/cross.txt", `${shared}\n`);
  await link(other, path.join(ws, "cross.txt"));
  // Names that are not UTF-8: an unzipped GBK archive does exactly this.
  const rawNames = supportsRawNames(ws);
  if (rawNames) {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${ws}/`), gbkFile]), "gbk named file\n");
    fs.mkdirSync(Buffer.concat([Buffer.from(`${ws}/`), gbkDirectory]));
    fs.writeFileSync(Buffer.concat([Buffer.from(`${ws}/`), gbkDirectory, Buffer.from("/inside.txt")]), "inside\n");
  }
  const records = [
    { path: `${workspace}/endpoint`, kind: "socket" },
    { path: `${workspace}/pipe`, kind: "fifo" },
    { path: `${workspace}/sub/b-second.txt`, kind: "hardlink", of: `${workspace}/a-first.txt` },
    { path: `${workspace}/from-cache.txt`, kind: "hardlink-dropped" },
    { path: `${workspace}/cross.txt`, kind: "hardlink-dropped" },
    { path: "users/u/projects/q/workspace/cross.txt", kind: "hardlink-dropped" },
    ...(rawNames ? [
      { parent: workspace, kind: "non-utf8-name", nameHex: gbkFile.toString("hex") },
      { parent: workspace, kind: "non-utf8-name", nameHex: gbkDirectory.toString("hex") },
    ] : []),
  ];
  if (!privileged) {
    await chmod(await put(data, `${workspace}/locked.txt`, "unreadable\n"), 0o000);
    await put(data, `${workspace}/sealed/inside.txt`, "behind a sealed directory\n");
    await chmod(path.join(ws, "sealed"), 0o000);
    records.push({ path: `${workspace}/locked.txt`, kind: "unreadable" }, { path: `${workspace}/sealed`, kind: "unreadable" });
  }
  return { root, data, records };
}

const sortRecords = (records) => records.map((record) => JSON.stringify(record, Object.keys(record).sort())).sort();

async function backup({ root, data }, env, name = "backups") {
  return execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, name)], { env });
}

async function members(archive) {
  const listed = await execute("python3", ["-c", `import json,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    print(json.dumps([member.name.rstrip('/') for member in archive]))
`, archive]);
  return JSON.parse(listed.stdout);
}

function occurrences(buffer, text) {
  let count = 0;
  for (let at = buffer.indexOf(text); at >= 0; at = buffer.indexOf(text, at + 1)) count++;
  return count;
}

for (const strict of ["false", "true"]) {
  test(`workspace entries an archive cannot carry are recorded and left out (strict=${strict})`, async (t) => {
    const f = await fixture(t);
    const env = { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict };
    const result = await backup(f, env);
    const archive = result.stdout.trim().split(/\r?\n/).at(-1);

    // The note: counted, by kind, and what the archive does not hold said outright.
    const line = result.stderr.split("\n").find((row) => row.startsWith(omittedPrefix));
    assert.ok(line, `the backup must say what it left out: ${result.stderr}`);
    const note = JSON.parse(line.slice(omittedPrefix.length));
    const kinds = {};
    for (const record of f.records) kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    assert.equal(note.count, f.records.length, JSON.stringify(note));
    assert.deepEqual(note.kinds, kinds);
    assert.equal(note.contentNotArchived, f.records.filter((record) => ["hardlink-dropped", "unreadable", "non-utf8-name"].includes(record.kind)).length);
    assert.equal(note.paths.length, 5);

    // The archive: the records in its manifest, none of them a member, the
    // contained hard link's bytes exactly once, the shared one's never.
    const manifest = JSON.parse((await execute("tar", ["-xOzf", archive, manifestName])).stdout);
    assert.deepEqual(sortRecords(manifest.omitted), sortRecords(f.records));
    const names = await members(archive);
    assert.ok(names.includes(`${workspace}/a-first.txt`) && names.includes(`${workspace}/notes.sock`) && names.includes(`${workspace}/kept.txt`));
    for (const record of f.records.filter((entry) => entry.path)) {
      assert.equal(names.some((name) => name === record.path || name.startsWith(`${record.path}/`)), false, `${record.path} must not be a member`);
    }
    assert.equal(names.some((name) => name.includes("inside.txt")), false, "nothing below a left-out directory");
    const body = gunzipSync(await readFile(archive));
    assert.equal(occurrences(body, contained), 1, "a hard link inside one workspace is archived once");
    assert.equal(occurrences(body, shared), 0, "a hard link with a name elsewhere is not archived at all");

    // The restore: verified against the records, and none of them restored.
    const target = path.join(f.root, "restored");
    const receipt = path.join(f.root, "receipt");
    const restored = await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
      env: { ...env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
    });
    assert.match(restored.stderr, new RegExp(`${f.records.length} other workspace entr\\(ies\\) recorded in the archive manifest, not restored`));
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).omitted, f.records.length);
    assert.equal(await readFile(path.join(target, workspace, "a-first.txt"), "utf8"), `${contained}\n`);
    assert.equal(await readFile(path.join(target, workspace, "notes.sock"), "utf8"), "A file of the tenant's, whatever its name.\n");
    assert.deepEqual((await readdir(path.join(target, workspace))).sort(), ["a-first.txt", "kept.txt", "notes.sock", "sub"]);
    assert.deepEqual(await readdir(path.join(target, workspace, "sub")), []);
    assert.equal((await lstat(path.join(target, workspace, "a-first.txt"))).nlink, 1);

    await execute("python3", ["-c", `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('recovery_volume', sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.restore_numeric(sys.argv[2], Path(sys.argv[3]), require_privilege=False)
`, path.join(ops, "recovery-volume.py"), archive, path.join(f.root, "numeric")], { env });
    const drill = await execute("bash", [path.join(ops, "restore-drill.sh"), archive], {
      env: { ...env, OPEN_SCIENCE_RESTORE_DRILL_DIR: path.join(f.root, "drills") },
    });
    assert.match(drill.stdout, new RegExp(`restore drill ok: .*inventory-v1, ${f.records.length} other workspace entr\\(ies\\) recorded, not restored\\)`));
  });

  // Outside a workspace, each is what it always was: a refused backup.
  const outside = {
    fifo: [/Refusing to back up a non-file data entry/, async (data) => {
      await mkdir(path.join(data, "users/u/projects/p"), { recursive: true });
      await execute("mkfifo", [path.join(data, "users/u/projects/p/pipe")]);
    }],
    hardlink: [/Refusing to back up a hard-linked data file outside a workspace/, async (data) => {
      await link(await put(data, "users/u/projects/p/project.json", "{}\n"), path.join(data, "users/u/projects/p/project-copy.json"));
    }],
    "non-utf8-name": [/Refusing to back up a data entry whose name is not UTF-8/, async (data) => {
      await mkdir(path.join(data, "users/u"), { recursive: true });
      fs.writeFileSync(Buffer.concat([Buffer.from(`${data}/users/u/`), gbkFile]), "x\n");
    }],
    unreadable: [/permission denied/i, async (data) => {
      await chmod(await put(data, "users/u/projects/p/project.json", "{}\n"), 0o000);
    }],
  };
  for (const [kind, [refusal, make]] of Object.entries(outside)) {
    test(`outside a workspace a ${kind} still refuses the backup (strict=${strict})`, { skip: kind === "unreadable" && privileged }, async (t) => {
      const root = await scratch(t);
      const data = path.join(root, "data");
      await put(data, `${workspace}/kept.txt`, "kept\n");
      if (kind === "non-utf8-name" && !supportsRawNames(data)) {
        t.skip("This filesystem rejects non-UTF-8 names"); return;
      }
      await make(data);
      await assert.rejects(backup({ root, data }, { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict }),
        (error) => refusal.test(error.stderr));
      assert.deepEqual((await readdir(path.join(root, "backups"))).filter((name) => name.includes(".tar.gz")), []);
    });
  }
}

test("a name that is not UTF-8 in the runtime scratch the backup never walks is not a refusal", async (t) => {
  const root = await scratch(t);
  const data = path.join(root, "data");
  await put(data, `${workspace}/kept.txt`, "kept\n");
  if (!supportsRawNames(data)) { t.skip("This filesystem rejects non-UTF-8 names"); return; }
  const cache = path.join(data, "users/u/projects/p/runtime/container-runtime/xdg-cache");
  await mkdir(cache, { recursive: true });
  fs.writeFileSync(Buffer.concat([Buffer.from(`${cache}/`), gbkFile]), "scratch\n");
  fs.writeFileSync(Buffer.concat([Buffer.from(`${data}/users/u/projects/p/runtime/container-runtime/`), gbkDirectory]), "scratch\n");
  const result = await backup({ root, data }, environment);
  assert.doesNotMatch(result.stderr, /left out of the archive/);
});

test("a file unreadable only by the time the writer opens it is recorded, and its alias loses its bytes", { skip: privileged }, async (t) => {
  const root = await scratch(t);
  const data = path.join(root, "data");
  const first = await put(data, `${workspace}/a-first.txt`, `${contained}\n`);
  await link(first, path.join(data, workspace, "b-second.txt"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "node"), `#!/usr/bin/env bash
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then chmod 000 "$EVIMED_TEST_LOCK"; fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`, { mode: 0o700 });
  const env = { ...environment, PATH: `${bin}:${process.env.PATH}`, EVIMED_TEST_REAL_NODE: process.execPath, EVIMED_TEST_LOCK: first };
  const noted = await backup({ root, data }, env);
  assert.match(noted.stderr, /backup note: 1 file\(s\) changed while being read/);
  const archive = noted.stdout.trim().split(/\r?\n/).at(-1);
  const manifest = JSON.parse((await execute("tar", ["-xOzf", archive, manifestName])).stdout);
  assert.deepEqual(sortRecords(manifest.omitted), sortRecords([
    { path: `${workspace}/b-second.txt`, kind: "hardlink-dropped" },
    { path: `${workspace}/a-first.txt`, kind: "unreadable" },
  ]));
  assert.equal(occurrences(gunzipSync(await readFile(archive)), contained), 0);
  await execute("bash", [path.join(ops, "restore-data.sh"), archive, path.join(root, "restored")], { env: environment });
  await chmod(first, 0o600);
  await assert.rejects(backup({ root, data }, { ...env, OPEN_SCIENCE_BACKUP_STRICT: "true" }, "strict"),
    (error) => /strict backup refused a changing source/.test(error.stderr));
});

for (const mutation of ["unknown-kind", "outside-workspace", "alias-of-nothing", "utf8-name-as-non-utf8", "restored-special"]) {
  test(`restore refuses a tampered omitted record: ${mutation}`, async (t) => {
    const f = await fixture(t);
    const archive = (await backup(f, environment)).stdout.trim().split(/\r?\n/).at(-1);
    const extracted = path.join(f.root, "extracted");
    await mkdir(extracted);
    await execute("tar", ["-xzf", archive, "-C", extracted]);
    const manifestPath = path.join(extracted, manifestName);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const byKind = (kind) => manifest.omitted.find((record) => record.kind === kind);
    if (mutation === "unknown-kind") byKind("fifo").kind = "door";
    else if (mutation === "outside-workspace") byKind("fifo").path = "users/u/projects/p/pipe";
    else if (mutation === "alias-of-nothing") byKind("hardlink").of = `${workspace}/missing.txt`;
    else if (mutation === "utf8-name-as-non-utf8") {
      const record = byKind("non-utf8-name") ?? { parent: workspace, kind: "non-utf8-name" };
      if (!manifest.omitted.includes(record)) manifest.omitted.push(record);
      record.nameHex = Buffer.from("plain.txt").toString("hex");
    }
    else await writeFile(path.join(extracted, byKind("fifo").path), "a file where the record says a FIFO was\n");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const corrupt = path.join(f.root, "corrupt.tar.gz");
    await execute("python3", ["-c", `import sys,tarfile
from pathlib import Path
root=Path(sys.argv[1])
with tarfile.open(sys.argv[2], 'w:gz') as archive:
    archive.add(root, arcname='.', recursive=False)
    for item in sorted(root.rglob('*')): archive.add(item, arcname=str(item.relative_to(root)), recursive=False)
`, extracted, corrupt]);
    const target = path.join(f.root, "restored");
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), corrupt, target], { env: environment }),
      (error) => /backup_inventory_(invalid|extra_entry)/.test(error.stderr));
    await assert.rejects(lstat(target), { code: "ENOENT" });
  });
}

test("the scheduler records what was left out, by kind, and stays healthy", async (t) => {
  const f = await fixture(t);
  const passphrase = path.join(f.root, "passphrase");
  await writeFile(passphrase, "Synthetic scheduler passphrase for this fixture only.\n", { mode: 0o600 });
  const backups = path.join(f.root, "backups");
  const env = { ...environment, OPEN_SCIENCE_DATA_DIR: f.data, OPEN_SCIENCE_BACKUP_DIR: backups,
    OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: passphrase, OPEN_SCIENCE_BACKUP_RUN_ONCE: "true",
    OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: "60", OPEN_SCIENCE_BACKUP_RETRY_SECONDS: "1",
    OPEN_SCIENCE_BACKUP_MAX_FAILURES: "1", OPEN_SCIENCE_RESTORE_DRILL_DIR: path.join(f.root, "drills") };
  const run = await execute(process.execPath, [path.join(ops, "backup-scheduler.mjs"), "run"], { env });
  const completed = JSON.parse(run.stdout.split("\n").find((line) => line.includes('"event":"backup.completed"')));
  assert.equal(completed.restoreDrill, "completed");
  assert.equal(completed.omittedRecorded, f.records.length);
  const state = JSON.parse(await readFile(path.join(backups, ".open-science-backup-state.json"), "utf8"));
  assert.equal(state.status, "healthy");
  assert.equal(state.lastOmittedRecorded, f.records.length);
  assert.equal(state.lastOmittedKinds["hardlink-dropped"], 3);
  assert.equal(state.lastOmittedKinds["non-utf8-name"] ?? 0, f.records.filter(record => record.kind === "non-utf8-name").length);
  assert.equal(state.lastOmittedSample.length, 5);
  assert.equal(state.lastLinksRecorded, 0);
});
