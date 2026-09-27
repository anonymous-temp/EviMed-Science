// A symbolic link a run makes inside its own workspace is recorded by the
// backup, never followed, never archived as a member and never restored.
//
// Twice a run made one (2026-09-26: a deliverable alias `疳证Meta论文 ->
// pigan-meta`; 09-27: seventeen `.evimed-sources/<id>/fulltext.md -> <sha>/…`
// aliases), the walker refused the whole data directory, every tenant's backup
// stopped, and the next release switch left the site down behind the unhealthy
// backup container. These tests hold both halves: the workspace link no longer
// fails anything, and a link anywhere else still does.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
const privateBytes = "SYNTHETIC_OUTSIDE_PRIVATE_BYTES";
const linkRefusal = /Refusing to back up data directory containing symbolic links/;

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const put = async (relative, value) => {
    const target = path.join(data, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, `${privateBytes}\n`);
  await put(`${workspace}/deliverables/pigan-meta/report.md`, "# Meta-analysis\n");
  await put(`${workspace}/deliverables/.evimed-sources/PMC1/0a1b/fulltext.md`, "Full text.\n");
  // The two incidents' shapes, then the two a run could make worse: a link out
  // of the tree (never read) and one that names nothing.
  const links = {
    [`${workspace}/deliverables/.evimed-sources/PMC1/fulltext.md`]: "0a1b/fulltext.md",
    [`${workspace}/deliverables/疳证Meta论文`]: "pigan-meta",
    [`${workspace}/dangling`]: "does-not-exist",
    [`${workspace}/leak`]: outside,
  };
  for (const [relative, target] of Object.entries(links)) await symlink(target, path.join(data, relative));
  return { root, data, links };
}

async function backup({ root, data }, env) {
  return execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env });
}

async function members(archive) {
  const listed = await execute("python3", ["-c", `import json,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    print(json.dumps([[member.name, member.type.decode()] for member in archive]))
`, archive]);
  return JSON.parse(listed.stdout);
}

async function walk(root, relative = "") {
  const found = [];
  for (const name of await readdir(path.join(root, relative))) {
    const child = relative ? `${relative}/${name}` : name;
    const metadata = await lstat(path.join(root, child));
    found.push([child, metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : "file"]);
    if (metadata.isDirectory()) found.push(...await walk(root, child));
  }
  return found;
}

for (const strict of ["false", "true"]) {
  test(`workspace links are recorded, not followed, and restore as nothing (strict=${strict})`, async (t) => {
    const f = await fixture(t);
    const env = { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict };
    const result = await backup(f, env);
    const archive = result.stdout.trim().split(/\r?\n/).at(-1);

    // The report: one bounded line, the count and the first names.
    const note = result.stderr.split("\n").find((line) => line.startsWith("backup note: workspace symbolic links recorded, not followed: "));
    assert.ok(note, `the backup must say it recorded links: ${result.stderr}`);
    const reported = JSON.parse(note.slice(note.indexOf("{")));
    assert.equal(reported.count, 4);
    assert.deepEqual(reported.paths.toSorted(), Object.keys(f.links).toSorted());

    // The archive: no link member, no byte from outside the tree, and the
    // manifest carries each link's path and target text.
    const archived = await members(archive);
    assert.ok(archived.some(([name]) => name.endsWith("pigan-meta/report.md")), "what an alias names is archived under its own name");
    assert.deepEqual(archived.filter(([, type]) => type !== "0" && type !== "5" && type !== "x"), [], "only files, directories and pax headers");
    for (const relative of Object.keys(f.links)) {
      assert.equal(archived.some(([name]) => name.replace(/\/$/, "") === relative), false, `${relative} must not be a member`);
    }
    assert.equal(gunzipSync(await readFile(archive)).includes(privateBytes), false, "a link is never followed");
    const manifest = JSON.parse((await execute("tar", ["-xOzf", archive, manifestName])).stdout);
    assert.deepEqual(Object.fromEntries(manifest.links.map((link) => [link.path, link.target])), f.links);
    assert.equal(manifest.version, 1);

    // The restore: verified, link-free, and says how many it did not restore.
    const target = path.join(f.root, "restored");
    const receipt = path.join(f.root, "receipt");
    const restored = await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
      env: { ...env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
    });
    assert.match(restored.stderr, /4 workspace link\(s\) recorded in the archive manifest, not restored/);
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).links, 4);
    const tree = await walk(target);
    assert.deepEqual(tree.filter(([, type]) => type === "link"), []);
    assert.ok(tree.some(([name]) => name === `${workspace}/deliverables/pigan-meta/report.md`));
    assert.ok(tree.some(([name]) => name === `${workspace}/deliverables/.evimed-sources/PMC1/0a1b/fulltext.md`));

    // The numeric-owner restore reads the same manifest through the same reader.
    await execute("python3", ["-c", `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('recovery_volume', sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.restore_numeric(sys.argv[2], Path(sys.argv[3]), require_privilege=False)
`, path.join(ops, "recovery-volume.py"), archive, path.join(f.root, "numeric")], { env });
    assert.deepEqual((await walk(path.join(f.root, "numeric"))).filter(([, type]) => type === "link"), []);

    // The drill: accepts the recorded form and names it.
    const drill = await execute("bash", [path.join(ops, "restore-drill.sh"), archive], {
      env: { ...env, OPEN_SCIENCE_RESTORE_DRILL_DIR: path.join(f.root, "drills") },
    });
    assert.match(drill.stdout, /restore drill ok: .*inventory-v1, 4 workspace link\(s\) recorded, not restored\)/);
  });

  // Everywhere a link is not the run's to make, it still refuses the backup:
  // these are the paths a link could use to point the backup out of the tree.
  for (const relative of ["leak", "users/u/leak", "users/u/projects/p/leak", workspace,
    "users/u/projects/p/runtime/container-runtime/dsh-home/sessions/linked.jsonl"]) {
    test(`a link outside a workspace still refuses the backup: ${relative} (strict=${strict})`, async (t) => {
      const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-links-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const data = path.join(root, "data");
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "private.txt"), `${privateBytes}\n`);
      await mkdir(path.join(data, "users/u/projects/p/runtime/container-runtime/dsh-home/sessions"), { recursive: true });
      await writeFile(path.join(data, "users/u/projects/p/runtime/container-runtime/dsh-home/sessions/kept.jsonl"), "{}\n");
      await mkdir(path.dirname(path.join(data, relative)), { recursive: true });
      await symlink(outside, path.join(data, relative));
      await assert.rejects(backup({ root, data }, { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict }),
        (error) => linkRefusal.test(error.stderr));
      assert.deepEqual(await readdir(path.join(root, "backups")).catch(() => []), [], "nothing is published");
    });
  }
}

test("a link replaced after the inventory is a changed source: a note, and a refusal when strict", async (t) => {
  const f = await fixture(t);
  const alias = `${workspace}/deliverables/疳证Meta论文`;
  // Swap the alias's target text between the inventory and the archive writer.
  const bin = path.join(f.root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "node"), `#!/usr/bin/env bash
if [[ "\${1:-}" == */backup-archive.mjs && "\${2:-}" != inventory ]]; then
  rm -f "$EVIMED_TEST_ALIAS" && ln -s elsewhere "$EVIMED_TEST_ALIAS"
fi
exec "$EVIMED_TEST_REAL_NODE" "$@"
`, { mode: 0o700 });
  const env = { ...environment, PATH: `${bin}:${process.env.PATH}`, EVIMED_TEST_REAL_NODE: process.execPath,
    EVIMED_TEST_ALIAS: path.join(f.data, alias) };
  const noted = await backup(f, env);
  assert.match(noted.stderr, /backup note: 1 file\(s\) changed while being read/);
  const manifest = JSON.parse((await execute("tar", ["-xOzf", noted.stdout.trim().split(/\r?\n/).at(-1), manifestName])).stdout);
  assert.equal(manifest.links.find((link) => link.path === alias).target, "pigan-meta", "the record is the inventory's moment");
  await assert.rejects(backup({ ...f, root: path.join(f.root, "strict") }, { ...env, OPEN_SCIENCE_BACKUP_STRICT: "true" }),
    (error) => /strict backup refused a changing source/.test(error.stderr));
});

for (const mutation of ["outside-workspace", "entry-collision", "extra-key", "no-parent", "restored-as-file"]) {
  test(`restore refuses a tampered link record: ${mutation}`, async (t) => {
    const f = await fixture(t);
    const archive = (await backup(f, environment)).stdout.trim().split(/\r?\n/).at(-1);
    const extracted = path.join(f.root, "extracted");
    await mkdir(extracted);
    await execute("tar", ["-xzf", archive, "-C", extracted]);
    const manifestPath = path.join(extracted, manifestName);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const [link] = manifest.links;
    if (mutation === "outside-workspace") link.path = "users/u/projects/p/notes";
    else if (mutation === "entry-collision") link.path = `${workspace}/deliverables/pigan-meta/report.md`;
    else if (mutation === "extra-key") link.type = "link";
    else if (mutation === "no-parent") link.path = `${workspace}/missing/alias`;
    else await writeFile(path.join(extracted, link.path), "a file where the record says a link was\n");
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

test("the scheduler records the links in its state and log, and stays healthy", async (t) => {
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
  assert.equal(completed.linksRecorded, 4);
  const state = JSON.parse(await readFile(path.join(backups, ".open-science-backup-state.json"), "utf8"));
  assert.equal(state.status, "healthy");
  assert.equal(state.lastLinksRecorded, 4);
  assert.deepEqual(state.lastLinksSample.toSorted(), Object.keys(f.links).toSorted());
  const health = await execute(process.execPath, [path.join(ops, "backup-scheduler.mjs"), "health"], { env });
  assert.match(health.stdout, /backup scheduler healthy/);
});
