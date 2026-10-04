// A live product is never quiescent, and a backup of one must not need it to be.
//
// The writer inventoried the data volume and then archived it, and failed the
// whole archive with `Backup source identity changed after inventory.` the moment
// any entry differed between the two passes. On the production host that was
// three failures in eleven minutes while a user worked (2026-10-03), a day
// without a backup with readiness red, and again right after a release
// (2026-10-04): a running specialist job rewrites its state file by rename every
// heartbeat, the release receipt creates and removes a `gate-<hex>` project, and
// the engines' slot files come and go.
//
// So an entry that changes or goes away between the passes is handled where it
// is. Not strict (the default, what the scheduler runs): a file is archived as it
// is when the writer reaches it, with its own bytes under its own digest, and is
// listed in the manifest's `changed` list when it is not the file the inventory
// saw; an entry that is gone is listed there as `vanished`. Strict is the mode
// for a source nobody writes (the VCR data plane, a cutover capture) and still
// refuses a changing one. What never changes: a link, a hard link or a special
// file where a file was, and a path that escapes, are refused in both.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readinessBackup } from "../src/server.mjs";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const manifestName = ".open-science-backup-manifest.json";
const environment = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "", OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "", OPEN_SCIENCE_BACKUP_STRICT: "false",
  OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: "" };
const ws = "users/u/projects/p/workspace";
const gate = "users/u/projects/gate-0123456789ab";
const changedPrefix = "backup note: entries that changed or went away while the backup ran: ";

async function scratch(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(data, relative, value) {
  const target = path.join(data, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

/** A researcher's workspace, a project beside it, and a short-lived gate project. */
async function fixture(t) {
  const root = await scratch(t);
  const data = path.join(root, "data");
  await put(data, `${ws}/kept.txt`, "kept\n");
  await put(data, `${ws}/a.txt`, "alpha\n");
  await put(data, `${ws}/sub/b.txt`, "beta\n");
  await put(data, `${ws}/sub/c.txt`, "gamma\n");
  await put(data, "users/u/projects/p/project.json", "{}\n");
  await put(data, `${gate}/project.json`, "{}\n");
  await put(data, `${gate}/workspace/result.txt`, "gate\n");
  const outsideDir = path.join(root, "outside-dir");
  await mkdir(outsideDir);
  return { root, data, outside: path.join(root, "outside.txt"), outsideDir };
}

/**
 * Runs backup-data.sh with `mutate` (bash; `$D` is the data directory, `$WS` the
 * workspace) applied after the inventory and before the writer's first open,
 * which is where a running product changes things under a backup. `watch` (bash)
 * is started beside the writer instead, and runs while the archive is being
 * written: `$OUT` is the archive's temporary file, so its size says how far the
 * writer is.
 */
async function backup(f, { mutate = "", watch = "", strict = "false", name = "backups", extra = {}, hook = "" } = {}) {
  const bin = path.join(f.root, `bin-${name}`);
  await mkdir(bin, { recursive: true });
  const script = path.join(bin, "node");
  await writeFile(script, `#!/usr/bin/env bash
D="$EVIMED_TEST_DATA"; WS="${ws}"; GATE="${gate}"; OUTSIDE="$EVIMED_TEST_OUTSIDE"; OUTSIDE_DIR="$EVIMED_TEST_OUTSIDE_DIR"
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" == inventory ]]; then
  ${hook ? 'exec "$EVIMED_TEST_REAL_NODE" --import "$EVIMED_TEST_HOOK" "$@"' : ":"}
fi
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  OUT="\${4:-}"
  ${mutate}
  ${watch ? `( ${watch} ) </dev/null >/dev/null 2>&1 &` : ":"}
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`, { mode: 0o700 });
  const env = { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict, PATH: `${bin}:${process.env.PATH}`,
    EVIMED_TEST_REAL_NODE: process.execPath, EVIMED_TEST_DATA: f.data, EVIMED_TEST_OUTSIDE: f.outside, EVIMED_TEST_OUTSIDE_DIR: f.outsideDir,
    EVIMED_TEST_HOOK: hook ? await writeHook(f.root, hook) : "", ...extra };
  return execute("bash", [path.join(ops, "backup-data.sh"), f.data, path.join(f.root, name)], { env });
}

/** A module loaded into the inventory before it reads anything (`node --import`). */
async function writeHook(root, source) {
  const file = path.join(root, "hook.mjs");
  await writeFile(file, source);
  return file;
}

const archiveOf = (result) => result.stdout.trim().split(/\r?\n/).at(-1);
const manifestOf = async (archive) => JSON.parse((await execute("tar", ["-xOzf", archive, manifestName])).stdout);
const noteOf = (stderr, prefix) => {
  const line = stderr.split("\n").find((row) => row.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : null;
};
async function members(archive) {
  const listed = await execute("python3", ["-c", `import json,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    print(json.dumps([[member.name.rstrip('/'), member.mode & 0o7777] for member in archive]))
`, archive]);
  return Object.fromEntries(JSON.parse(listed.stdout));
}

/** Restores and drills `archive`, and returns the restored tree as a map of file -> text. */
async function restored(f, archive, label = "restored") {
  const target = path.join(f.root, label);
  const receipt = path.join(f.root, `${label}.receipt`);
  const result = await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
    env: { ...environment, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
  });
  const drill = await execute("bash", [path.join(ops, "restore-drill.sh"), archive], {
    env: { ...environment, OPEN_SCIENCE_RESTORE_DRILL_DIR: path.join(f.root, `${label}-drills`) },
  });
  const tree = {};
  const walk = async (relative) => {
    for (const name of await readdir(path.join(target, relative))) {
      const child = relative ? `${relative}/${name}` : name;
      if ((await lstat(path.join(target, child))).isDirectory()) { tree[`${child}/`] = null; await walk(child); }
      else tree[child] = await readFile(path.join(target, child), "utf8");
    }
  };
  await walk("");
  return { tree, receipt: JSON.parse(await readFile(receipt, "utf8")), stderr: result.stderr, drill: drill.stdout };
}

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("a file removed after the inventory is recorded as vanished, and the archive completes", async (t) => {
  const f = await fixture(t);
  const result = await backup(f, { mutate: 'rm -f "$D/$WS/a.txt"' });
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.deepEqual(manifest.changed, [{ path: `${ws}/a.txt`, kind: "vanished" }]);
  assert.equal(manifest.entries.some((entry) => entry.path === `${ws}/a.txt`), false);
  assert.deepEqual(noteOf(result.stderr, changedPrefix), { count: 1, kinds: { vanished: 1 }, paths: [`${ws}/a.txt`] });
  assert.doesNotMatch(result.stderr, /changed while being read/, "a file that is gone is not a file that changed as it was read");

  // The drill verifies exactly what the manifest says was captured.
  const { tree, receipt, drill } = await restored(f, archive);
  assert.equal(tree[`${ws}/kept.txt`], "kept\n");
  assert.equal(`${ws}/a.txt` in tree, false);
  assert.equal(receipt.changed, 1);
  assert.match(drill, /restore drill ok: .*inventory-v1.*1 entr\(ies\) changed while the backup ran/);
});

test("a directory removed after the inventory is one record, not one per file", async (t) => {
  const f = await fixture(t);
  const result = await backup(f, { mutate: 'rm -rf "$D/$GATE"' });
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.deepEqual(manifest.changed, [{ path: gate, kind: "vanished" }], "the directory says what went with it");
  assert.equal(Object.keys(await members(archive)).some((name) => name.includes("gate-0123456789ab")), false);
  const { tree } = await restored(f, archive);
  assert.equal(Object.keys(tree).some((name) => name.includes("gate-0123456789ab")), false);
  assert.equal(tree[`${ws}/sub/b.txt`], "beta\n");
});

test("a file rewritten after the inventory is archived as it is now, and listed as changed", async (t) => {
  const f = await fixture(t);
  const rewritten = "alpha, rewritten and longer than before\n";
  const result = await backup(f, { mutate: 'printf "alpha, rewritten and longer than before\\n" > "$D/$WS/a.txt"' });
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.deepEqual(manifest.changed, [{ path: `${ws}/a.txt`, kind: "changed-during-backup" }]);
  assert.deepEqual(manifest.entries.find((entry) => entry.path === `${ws}/a.txt`),
    { path: `${ws}/a.txt`, type: "file", size: Buffer.byteLength(rewritten), sha256: sha(rewritten) },
    "the manifest describes the bytes the archive holds, not the inventory's");
  assert.match(result.stderr, /backup note: 1 file\(s\) changed while being read/);
  assert.equal((await restored(f, archive)).tree[`${ws}/a.txt`], rewritten);
});

test("a file replaced by rename after the inventory is archived at its new identity", async (t) => {
  // What a running specialist job does to its state file on every heartbeat.
  const f = await fixture(t);
  const before = await stat(path.join(f.data, ws, "a.txt"));
  const result = await backup(f, { mutate: 'printf "alpha, atomically replaced\\n" > "$D/$WS/a.txt.new" && mv "$D/$WS/a.txt.new" "$D/$WS/a.txt"' });
  const manifest = await manifestOf(archiveOf(result));
  assert.deepEqual(manifest.changed, [{ path: `${ws}/a.txt`, kind: "changed-during-backup" }]);
  assert.notEqual((await stat(path.join(f.data, ws, "a.txt"))).ino, before.ino, "the fixture really replaced the inode");
  assert.equal((await restored(f, archiveOf(result))).tree[`${ws}/a.txt`], "alpha, atomically replaced\n");
});

test("a file whose mode changed after the inventory is archived with the mode it has now", async (t) => {
  const f = await fixture(t);
  await chmod(path.join(f.data, ws, "a.txt"), 0o644);
  const result = await backup(f, { mutate: 'chmod 0600 "$D/$WS/a.txt"' });
  const archive = archiveOf(result);
  assert.equal((await members(archive))[`${ws}/a.txt`], 0o600, "the header describes the file the bytes came from");
  assert.deepEqual((await manifestOf(archive)).changed, [{ path: `${ws}/a.txt`, kind: "changed-during-backup" }]);
});

test("a name added after the inventory is not in the archive, and the drill verifies what is", async (t) => {
  const f = await fixture(t);
  const result = await backup(f, { mutate: 'printf "new\\n" > "$D/$WS/new.txt"; mkdir "$D/$WS/newdir"; printf "n\\n" > "$D/$WS/newdir/n.txt"; printf "s\\n" > "$D/$WS/sub/s.txt"' });
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.equal(manifest.changed, undefined, "nothing the inventory listed changed");
  assert.doesNotMatch(result.stderr, /changed while being read/);
  const { tree } = await restored(f, archive);
  for (const added of ["new.txt", "newdir/n.txt", "sub/s.txt"]) assert.equal(`${ws}/${added}` in tree, false, `${added} is not in the inventory`);
  assert.equal(tree[`${ws}/sub/b.txt`], "beta\n");
});

test("a directory replaced by another one keeps what it still holds and records what it lost", async (t) => {
  const f = await fixture(t);
  const result = await backup(f, { mutate: 'mv "$D/$WS/sub" "$D/$WS/sub.old" && mkdir "$D/$WS/sub" && printf "fresh\\n" > "$D/$WS/sub/b.txt"' });
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.deepEqual(manifest.changed.map((record) => [record.path, record.kind]).sort(), [
    [`${ws}/sub/b.txt`, "changed-during-backup"], [`${ws}/sub/c.txt`, "vanished"],
  ]);
  const { tree } = await restored(f, archive);
  assert.equal(tree[`${ws}/sub/b.txt`], "fresh\n");
  assert.equal(`${ws}/sub/c.txt` in tree, false);
  assert.equal(`${ws}/sub.old/b.txt` in tree, false, "a directory the inventory never saw is not archived");
});

test("a file replaced by a directory, and a directory replaced by a file, are both gone", async (t) => {
  const f = await fixture(t);
  const result = await backup(f, { mutate: 'rm "$D/$WS/a.txt" && mkdir "$D/$WS/a.txt" && printf "x\\n" > "$D/$WS/a.txt/inner"; rm -rf "$D/$WS/sub" && printf "now a file\\n" > "$D/$WS/sub"' });
  const archive = archiveOf(result);
  assert.deepEqual((await manifestOf(archive)).changed.map((record) => [record.path, record.kind]).sort(), [
    [`${ws}/a.txt`, "vanished"], [`${ws}/sub`, "vanished"],
  ]);
  const { tree } = await restored(f, archive);
  assert.equal(`${ws}/a.txt` in tree, false);
  assert.equal(`${ws}/sub` in tree || `${ws}/sub/` in tree, false);
});

test("what the inventory recorded below a directory that is gone goes with it", async (t) => {
  // A link and a left-out FIFO need an archived directory to be children of; the
  // directory is gone and nothing under it is archived, so the one record is its.
  const f = await fixture(t);
  await symlink("b.txt", path.join(f.data, ws, "sub/alias"));
  await execute("mkfifo", [path.join(f.data, ws, "sub/pipe")]);
  const archive = archiveOf(await backup(f, { mutate: 'rm -rf "$D/$WS/sub"' }));
  const manifest = await manifestOf(archive);
  assert.deepEqual(manifest.changed, [{ path: `${ws}/sub`, kind: "vanished" }]);
  assert.equal(manifest.links, undefined);
  assert.equal(manifest.omitted, undefined);
  await restored(f, archive);
});

test("a left-out hard-link alias follows its first name when that name goes away", async (t) => {
  const f = await fixture(t);
  await put(f.data, `${ws}/h-first.txt`, "hard linked bytes\n");
  await link(path.join(f.data, ws, "h-first.txt"), path.join(f.data, ws, "h-second.txt"));
  const result = await backup(f, { mutate: 'rm -f "$D/$WS/h-first.txt"' });
  const manifest = await manifestOf(archiveOf(result));
  assert.deepEqual(manifest.changed, [{ path: `${ws}/h-first.txt`, kind: "vanished" }]);
  assert.deepEqual(manifest.omitted, [{ path: `${ws}/h-second.txt`, kind: "hardlink-dropped" }],
    "the bytes are in the archive under no name, and it says so");
  assert.equal(noteOf(result.stderr, "backup note: workspace entries left out of the archive: ").contentNotArchived, 1);
  await restored(f, archiveOf(result));
});

test("a file replaced by a symbolic link after the inventory is still refused", async (t) => {
  const f = await fixture(t);
  await writeFile(f.outside, "SYNTHETIC_OUTSIDE_PRIVATE_BYTES\n");
  await assert.rejects(backup(f, { mutate: 'rm "$D/$WS/a.txt" && ln -s "$OUTSIDE" "$D/$WS/a.txt"' }),
    (error) => /symbolic links are not allowed/.test(error.stderr));
  assert.deepEqual((await readdir(path.join(f.root, "backups"))).filter((name) => name.includes(".tar.gz")), []);
});

test("a directory replaced by a symbolic link after the inventory is still refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(backup(f, { mutate: 'mv "$D/$WS/sub" "$D/$WS/sub.saved" && ln -s "$OUTSIDE_DIR" "$D/$WS/sub"' }),
    (error) => /symbolic links|data directory containing/.test(error.stderr));
  assert.deepEqual((await readdir(path.join(f.root, "backups"))).filter((name) => name.includes(".tar.gz")), []);
});

test("a second name given to a file after the inventory is still refused, and so is a special file in its place", async (t) => {
  // Where else the bytes are named is not known, and a FIFO is not data.
  const f = await fixture(t);
  await assert.rejects(backup(f, { mutate: 'ln "$D/$WS/a.txt" "$D/$WS/a-second-name.txt"' }),
    (error) => /hard-linked/.test(error.stderr));
  await assert.rejects(backup(f, { name: "fifo", mutate: 'rm "$D/$WS/kept.txt" && mkfifo "$D/$WS/kept.txt"' }),
    (error) => /not a regular file/.test(error.stderr));
  for (const name of ["backups", "fifo"]) {
    assert.deepEqual((await readdir(path.join(f.root, name))).filter((entry) => entry.includes(".tar.gz")), []);
  }
});

// Strict is for a source nobody writes. The same changes that complete a backup
// above refuse one here, as they always did.
for (const [label, mutate] of [
  ["a removed file", 'rm -f "$D/$WS/a.txt"'],
  ["a rewritten file", 'printf "alpha, rewritten and longer than before\\n" > "$D/$WS/a.txt"'],
  ["a replaced file", 'printf "x\\n" > "$D/$WS/a.txt.new" && mv "$D/$WS/a.txt.new" "$D/$WS/a.txt"'],
  ["a removed directory", 'rm -rf "$D/$GATE"'],
  ["a name added to a directory", 'printf "new\\n" > "$D/$WS/new.txt"'],
]) {
  test(`strict still refuses ${label} and publishes nothing`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(backup(f, { mutate, strict: "true" }), (error) => /strict backup refused/.test(error.stderr));
    assert.deepEqual(await readdir(path.join(f.root, "backups")), []);
  });
}

test("a file that shrinks while it is read is padded to the size its header declared, and listed", async (t) => {
  // GNU tar's answer, and the only one a stream has: the member's header and the
  // first bytes are already written. The digest covers the padding, so the
  // manifest still describes what the archive holds.
  const f = await fixture(t);
  const big = randomBytes(24 * 1024 * 1024);
  await writeFile(path.join(f.data, ws, "z-big.bin"), big);
  const result = await backup(f, {
    watch: 'for _ in $(seq 1 4000); do s=$(stat -c %s "$OUT" 2>/dev/null || echo 0); if [ "$s" -gt 65536 ]; then truncate -s 1048576 "$D/$WS/z-big.bin"; touch "$EVIMED_TEST_MARKER"; break; fi; sleep 0.005; done',
    extra: { EVIMED_TEST_MARKER: path.join(f.root, "truncated") },
  });
  await readFile(path.join(f.root, "truncated"));
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.ok(manifest.changed.some((record) => record.path === `${ws}/z-big.bin` && record.kind === "changed-during-backup"));
  const entry = manifest.entries.find((candidate) => candidate.path === `${ws}/z-big.bin`);
  assert.equal(entry.size, big.length, "the member keeps the size its header declared");
  const target = path.join(f.root, "restored");
  await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: environment });
  const body = await readFile(path.join(target, ws, "z-big.bin"));
  assert.equal(body.length, big.length);
  assert.equal(sha(body), entry.sha256, "restore verified the bytes against the manifest");
  assert.ok(body.subarray(0, 1048576).equals(big.subarray(0, 1048576)), "what the file kept is what was archived");
});

test("a directory removed after its contents were archived is still archived, so the manifest stays valid", async (t) => {
  const f = await fixture(t);
  await put(f.data, `${ws}/deep/a-big.bin`, randomBytes(24 * 1024 * 1024));
  await put(f.data, `${ws}/deep/z-small.txt`, "small\n");
  const result = await backup(f, {
    watch: 'for _ in $(seq 1 4000); do s=$(stat -c %s "$OUT" 2>/dev/null || echo 0); if [ "$s" -gt 65536 ]; then rm -rf "$D/$WS/deep"; touch "$EVIMED_TEST_MARKER"; break; fi; sleep 0.005; done',
    extra: { EVIMED_TEST_MARKER: path.join(f.root, "removed") },
  });
  await readFile(path.join(f.root, "removed"));
  const archive = archiveOf(result);
  const manifest = await manifestOf(archive);
  assert.ok(manifest.entries.some((entry) => entry.path === `${ws}/deep` && entry.type === "directory"),
    "its archived child needs its directory, whether or not the directory is still there");
  // The drill is the check: a manifest naming a member whose parent is missing is invalid.
  const { receipt } = await restored(f, archive);
  assert.ok(receipt.changed >= 1);
});

// What the inventory does when an entry goes away between the listing of its
// directory and its own lstat, the same class on the first pass.
const vanishBeforeLstat = `import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { rmSync } from "node:fs";
const target = process.env.EVIMED_TEST_VANISH;
const original = fsp.lstat;
let done = false;
fsp.lstat = async function lstat(file, ...rest) {
  if (!done && String(file) === target) { done = true; rmSync(target, { recursive: true, force: true }); }
  return original.call(this, file, ...rest);
};
syncBuiltinESMExports();
`;
const vanishBeforeReaddir = vanishBeforeLstat.replace("fsp.lstat", "fsp.readdir").replaceAll("lstat", "readdir");

for (const [label, hook] of [["lstat", vanishBeforeLstat], ["listing", vanishBeforeReaddir]]) {
  test(`an entry that goes away before its ${label} is read is not a failed inventory`, async (t) => {
    const f = await fixture(t);
    const target = path.join(f.data, ws, label === "lstat" ? "a.txt" : "sub");
    const result = await backup(f, { hook, extra: { EVIMED_TEST_VANISH: target } });
    const { tree } = await restored(f, archiveOf(result));
    assert.equal(tree[`${ws}/kept.txt`], "kept\n");
    assert.equal(label === "lstat" ? `${ws}/a.txt` in tree : `${ws}/sub/b.txt` in tree, false);
    await assert.rejects(stat(target), { code: "ENOENT" });
  });
}

test("strict inventory still refuses an entry that goes away while it is read", async (t) => {
  const f = await fixture(t);
  await assert.rejects(backup(f, { strict: "true", hook: vanishBeforeLstat, extra: { EVIMED_TEST_VANISH: path.join(f.data, ws, "a.txt") } }),
    (error) => /Backup file inventory failed/.test(error.stderr) && /ENOENT/.test(error.stderr));
});

// What is volatile by design is never inventoried, so it can never fail a backup.
test("slot locks and in-flight temporaries of the platform's own state are left out; a tenant's names are not", async (t) => {
  const f = await fixture(t);
  const project = "users/u/projects/p/.openscience/mr-jobs/s0/g0";
  await put(f.data, ".openscience/specialist-slots/running-mr-1-77.lock", "{}");
  await put(f.data, ".openscience/specialist-slots/admission.lock", "");
  await put(f.data, ".openscience/sessions.json", "[]\n");
  await put(f.data, `${project}/mr-job.json`, "{}\n");
  await put(f.data, `${project}/.mr-job.json.0123456789abcdef.tmp`, "{}");
  await put(f.data, "users/u/projects/p/.project.json.123.1760000000000.tmp_0123456789abcdef0123456789abcdef", "{}");
  await put(f.data, `${project}/.state.json.abcdef.tmpdir/inner`, "x");
  // Inside a workspace a name is the tenant's own, whatever it looks like.
  await put(f.data, `${ws}/.notes.0123456789abcdef.tmp`, "a tenant's file\n");
  const archive = archiveOf(await backup(f));
  const names = Object.keys(await members(archive));
  assert.ok(names.includes(".openscience/sessions.json") && names.includes(`${project}/mr-job.json`));
  assert.ok(names.includes(`${ws}/.notes.0123456789abcdef.tmp`), "the tenant's own file is archived");
  assert.deepEqual(names.filter((name) => /specialist-slots|\.tmp|tmpdir/.test(name) && !name.startsWith(ws)), []);
});

for (const mutation of ["unknown-kind", "changed-is-not-a-file", "vanished-is-an-entry", "vanished-without-parent", "extra-key", "duplicate"]) {
  test(`restore refuses a tampered changed record: ${mutation}`, async (t) => {
    const f = await fixture(t);
    const archive = archiveOf(await backup(f, { mutate: 'rm -f "$D/$WS/a.txt"; printf "rewritten\\n" > "$D/$WS/kept.txt"' }));
    const extracted = path.join(f.root, "extracted");
    await mkdir(extracted);
    await execute("tar", ["-xzf", archive, "-C", extracted]);
    const manifestPath = path.join(extracted, manifestName);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const vanished = manifest.changed.find((record) => record.kind === "vanished");
    const changed = manifest.changed.find((record) => record.kind === "changed-during-backup");
    if (mutation === "unknown-kind") vanished.kind = "teleported";
    else if (mutation === "changed-is-not-a-file") changed.path = `${ws}/sub`;
    else if (mutation === "vanished-is-an-entry") vanished.path = `${ws}/kept.txt`;
    else if (mutation === "vanished-without-parent") vanished.path = `${ws}/nowhere/a.txt`;
    else if (mutation === "extra-key") vanished.size = 1;
    else manifest.changed.push({ ...vanished });
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
      (error) => /backup_inventory_(invalid|extra_entry|missing_entry)/.test(error.stderr));
    await assert.rejects(lstat(target), { code: "ENOENT" });
  });
}

test("the scheduler completes a cycle on a live tree, says what changed, and readiness reports it as information", async (t) => {
  const f = await fixture(t);
  const passphrase = path.join(f.root, "passphrase");
  await writeFile(passphrase, "Synthetic scheduler passphrase for this fixture only.\n", { mode: 0o600 });
  const backups = path.join(f.root, "scheduled");
  // Between the inventory and the archive: one file gone, one rewritten.
  const bin = path.join(f.root, "scheduler-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "node"), `#!/usr/bin/env bash
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  rm -f "$EVIMED_TEST_DATA/${ws}/a.txt"; printf 'rewritten and longer\\n' > "$EVIMED_TEST_DATA/${ws}/kept.txt"
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`, { mode: 0o700 });
  const env = { ...environment, PATH: `${bin}:${process.env.PATH}`, EVIMED_TEST_REAL_NODE: process.execPath, EVIMED_TEST_DATA: f.data,
    OPEN_SCIENCE_DATA_DIR: f.data, OPEN_SCIENCE_BACKUP_DIR: backups, OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: passphrase,
    OPEN_SCIENCE_BACKUP_RUN_ONCE: "true", OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS: "60", OPEN_SCIENCE_BACKUP_RETRY_SECONDS: "1",
    OPEN_SCIENCE_BACKUP_MAX_FAILURES: "1", OPEN_SCIENCE_RESTORE_DRILL_DIR: path.join(f.root, "drills") };
  const run = await execute(process.execPath, [path.join(ops, "backup-scheduler.mjs"), "run"], { env });
  const completed = JSON.parse(run.stdout.split("\n").find((line) => line.includes('"event":"backup.completed"')));
  assert.equal(completed.restoreDrill, "completed");
  assert.equal(completed.changedRecorded, 2);
  assert.deepEqual(completed.changedKinds, { vanished: 1, "changed-during-backup": 1 });
  assert.equal(completed.changedSample.length, 2);
  const stateFile = path.join(backups, ".open-science-backup-state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.status, "healthy");
  assert.equal(state.lastChangedRecorded, 2);
  assert.deepEqual(state.lastChangedKinds, { vanished: 1, "changed-during-backup": 1 });
  assert.deepEqual((await execute(process.execPath, [path.join(ops, "backup-scheduler.mjs"), "health"], { env })).stdout.trim(), "backup scheduler healthy");

  // Readiness: information, never a failure, and no paths.
  const config = { production: true, stateStore: "file", backupMode: "local", backupDir: backups, backupStateFile: stateFile,
    dataDir: f.data, backupRetentionDays: 30, backupPassphraseConfigured: true, restoreDrillAck: true,
    backupIntervalSeconds: 86400, backupHealthGraceSeconds: 1800 };
  const ready = await readinessBackup(config);
  assert.equal(ready.schedulerHealthy, true);
  assert.deepEqual(ready.lastBackup, { changedRecorded: 2, omittedRecorded: 0, linksRecorded: 0 });
  assert.equal(JSON.stringify(ready).includes("users/u"), false, "readiness carries counts, not names");
  // An older state file, or a hand-edited one, is no reason to fail either.
  await writeFile(stateFile, JSON.stringify({ ...state, lastChangedRecorded: "many", lastOmittedRecorded: -1, lastLinksRecorded: undefined }));
  const odd = await readinessBackup(config);
  assert.equal(odd.schedulerHealthy, true);
  assert.deepEqual(odd.lastBackup, { changedRecorded: null, omittedRecorded: null, linksRecorded: null });
});

test("a researcher's own workspace link keeps being recorded while the files around it change", async (t) => {
  const f = await fixture(t);
  await symlink("a.txt", path.join(f.data, ws, "alias"));
  const result = await backup(f, { mutate: 'rm -f "$D/$WS/a.txt"' });
  const manifest = await manifestOf(archiveOf(result));
  assert.deepEqual(manifest.links, [{ path: `${ws}/alias`, target: "a.txt" }]);
  assert.deepEqual(manifest.changed, [{ path: `${ws}/a.txt`, kind: "vanished" }]);
  const { tree } = await restored(f, archiveOf(result));
  assert.equal(`${ws}/alias` in tree, false, "a recorded link is never restored");
});
