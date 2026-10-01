import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const manifestName = ".open-science-backup-manifest.json";
const environment = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "", OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "", OPEN_SCIENCE_BACKUP_STRICT: "false",
  OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: "" };

async function fixture(t, count = 1, encrypted = false) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  await mkdir(path.join(data, "users"), { recursive: true });
  if (count) await writeFile(path.join(data, "pharmacy.sqlite"), "synthetic pharmacy fixture\n");
  const env = { ...environment };
  if (encrypted) {
    const passphrase = path.join(root, "passphrase");
    await writeFile(passphrase, "Synthetic backup integrity test passphrase\n", { mode: 0o600 });
    env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE = passphrase;
  }
  return { root, data, env };
}

async function capture({ root, data, env }) {
  const result = await execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env });
  return result.stdout.trim();
}

async function numericRestore(archive, target, env) {
  // Exercise the real descriptor-held implementation with this user's owners.
  // The public CLI's privileged-owner requirement is tested separately.
  return execute("python3", ["-c", `import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('recovery_volume', sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.restore_numeric(sys.argv[2], Path(sys.argv[3]), require_privilege=False)
`, path.join(ops, "recovery-volume.py"), archive, target], { env });
}

for (const encrypted of [false, true]) {
  for (const files of [0, 1]) {
    test(`inventory restore and drill verify ${files} files with initialized users/ (${encrypted ? "encrypted" : "plain"})`, async t => {
      const f = await fixture(t, files, encrypted);
      const archive = await capture(f);
      const target = path.join(f.root, "restored");
      const receipt = path.join(f.root, "receipt");
      const restored = await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
        env: { ...f.env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
      });
      assert.equal(restored.stdout.trim(), target);
      assert.deepEqual(await readdir(target), files ? ["pharmacy.sqlite", "users"] : ["users"]);
      if (files) assert.equal(await readFile(path.join(target, "pharmacy.sqlite"), "utf8"), "synthetic pharmacy fixture\n");
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { verification: "inventory-v1", files, directories: 2 });
      assert.equal((await stat(receipt)).mode & 0o777, 0o600);
      const numericTarget = path.join(f.root, "numeric-restored");
      const numericReceipt = path.join(f.root, "numeric-receipt");
      await numericRestore(archive, numericTarget, { ...f.env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: numericReceipt });
      assert.deepEqual(await readdir(numericTarget), await readdir(target));
      if (files) assert.equal(await readFile(path.join(numericTarget, "pharmacy.sqlite"), "utf8"), "synthetic pharmacy fixture\n");
      assert.deepEqual(JSON.parse(await readFile(numericReceipt, "utf8")), { ...JSON.parse(await readFile(receipt, "utf8")), numericOwnersVerified: true });
      const drills = path.join(f.root, "drills");
      const result = await execute("bash", [path.join(ops, "restore-drill.sh"), archive], {
        env: { ...f.env, OPEN_SCIENCE_RESTORE_DRILL_DIR: drills },
      });
      assert.match(result.stdout, /restore drill ok:.*inventory-v1/);
      assert.deepEqual(await readdir(drills), []);
    });
  }
}

test("manifest describes the bytes actually archived with no source identity or credentials", async t => {
  const f = await fixture(t);
  const archive = await capture(f);
  const listed = await execute("tar", ["-xOzf", archive, manifestName]);
  const manifest = JSON.parse(listed.stdout);
  assert.equal(manifest.format, "open-science-backup-inventory");
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.entries.find(entry => entry.path === "pharmacy.sqlite"), {
    path: "pharmacy.sqlite", type: "file", size: 27,
    sha256: createHash("sha256").update("synthetic pharmacy fixture\n").digest("hex"),
  });
  assert.deepEqual(Object.keys(manifest.entries.find(entry => entry.path === "users")).sort(), ["path", "size", "type"]);
});

for (const mutation of ["missing", "changed", "extra", "type", "version", "reserved-descendant", "traversal", "duplicate", "malformed"]) {
  test(`restore refuses ${mutation} inventory corruption before replacing the target`, async t => {
    const f = await fixture(t);
    const archive = await capture(f);
    const extracted = path.join(f.root, "extracted");
    await mkdir(extracted);
    await execute("tar", ["-xzf", archive, "-C", extracted]);
    const payload = path.join(extracted, "pharmacy.sqlite");
    if (mutation === "missing") await rm(payload);
    else if (mutation === "changed") await writeFile(payload, "Synthetic pharmacy fixture\n");
    else if (mutation === "extra") await writeFile(path.join(extracted, "extra.txt"), "unlisted\n");
    else if (mutation === "type") { await rm(payload); await mkdir(payload); }
    else {
      const manifestPath = path.join(extracted, manifestName);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (mutation === "version") manifest.version = 2;
      else if (mutation === "duplicate") manifest.entries.push(manifest.entries[0]);
      else manifest.entries[0].path = mutation === "traversal" ? "../outside" : `${manifestName}/collision`;
      await writeFile(manifestPath, mutation === "malformed" ? '{"invalid":' : JSON.stringify(manifest));
    }
    const corrupt = path.join(f.root, "corrupt.tar.gz");
    await execute("python3", ["-c", `import sys,tarfile
from pathlib import Path
root=Path(sys.argv[1])
with tarfile.open(sys.argv[2], 'w:gz') as archive:
    for item in sorted(root.rglob('*')): archive.add(item, arcname=str(item.relative_to(root)), recursive=False)
    archive.add(root, arcname='.', recursive=False)
`, extracted, corrupt]);
    const target = path.join(f.root, "restored");
    await mkdir(target);
    await writeFile(path.join(target, "existing"), "preserve existing target\n");
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), corrupt, target], {
      env: { ...f.env, OPEN_SCIENCE_RESTORE_REPLACE: "true" },
    }), error => /backup_inventory_/.test(error.stderr));
    assert.equal(await readFile(path.join(target, "existing"), "utf8"), "preserve existing target\n");
    const digest = createHash("sha256").update(await readFile(corrupt)).digest("hex");
    await writeFile(`${corrupt}.sha256`, `${digest}  ${path.basename(corrupt)}\n`);
    const numericTarget = path.join(f.root, "numeric-restored");
    await assert.rejects(numericRestore(corrupt, numericTarget, f.env), error => /backup_inventory_/.test(error.stderr));
    await assert.rejects(access(numericTarget), { code: "ENOENT" });
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".open-science-restore")), false);
  });
}

test("strict capture verifies a zero-byte regular file by its empty SHA-256", async t => {
  const f = await fixture(t);
  f.env.OPEN_SCIENCE_BACKUP_STRICT = "true";
  await writeFile(path.join(f.data, "pharmacy.sqlite"), "");
  const archive = await capture(f);
  const target = path.join(f.root, "restored");
  await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: f.env });
  assert.equal((await stat(path.join(target, "pharmacy.sqlite"))).size, 0);
  const listed = await execute("tar", ["-xOzf", archive, manifestName]);
  assert.equal(JSON.parse(listed.stdout).entries.find(entry => entry.type === "file").sha256,
    createHash("sha256").update("").digest("hex"));
});

test("verification removes its private manifest while preserving a read-only restored root", async t => {
  const f = await fixture(t);
  await chmod(f.data, 0o500);
  const target = path.join(f.root, "restored");
  try {
    const archive = await capture(f);
    await mkdir(target);
    await execute("tar", ["-xzf", archive, "-C", target]);
    // tar implementations differ in whether they apply the archived root's
    // mode to an existing extraction directory. Exercise the restrictive case.
    await chmod(target, 0o500);
    await execute("python3", [path.join(ops, "backup_integrity.py"), target], { env: f.env });
    assert.equal((await stat(target)).mode & 0o777, 0o500);
    assert.deepEqual(await readdir(target), ["pharmacy.sqlite", "users"]);
  } finally {
    await chmod(f.data, 0o700);
    await chmod(target, 0o700).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
});

test("oversized manifest members are refused before either restore writes them", async t => {
  const f = await fixture(t);
  const archive = path.join(f.root, "oversized.tar.gz");
  await execute("python3", ["-c", `import io,sys,tarfile
class Zeroes:
    def read(self, size): return b'\\0' * size
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    root=tarfile.TarInfo('.')
    root.type=tarfile.DIRTYPE
    archive.addfile(root)
    member=tarfile.TarInfo(sys.argv[2])
    member.size=64 * 1024 * 1024 + 1
    archive.addfile(member, Zeroes())
`, archive, manifestName]);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  const target = path.join(f.root, "restored");
  await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: f.env }),
    error => /backup_inventory_invalid/.test(error.stderr));
  await assert.rejects(numericRestore(archive, target, f.env), error => /backup_inventory_invalid/.test(error.stderr));
  await assert.rejects(access(target), { code: "ENOENT" });
});

for (const strict of ["false", "true"]) {
  for (const directory of [false, true]) {
    test(`backup refuses a reserved manifest ${directory ? "directory" : "file"} collision (strict=${strict})`, async t => {
      const f = await fixture(t);
      const reserved = path.join(f.data, manifestName);
      if (directory) await mkdir(reserved);
      else await writeFile(reserved, "customer-owned collision\n");
      f.env.OPEN_SCIENCE_BACKUP_STRICT = strict;
      await assert.rejects(capture(f), error => /reserved backup manifest/.test(error.stderr));
      assert.deepEqual(await readdir(path.join(f.root, "backups")), []);
    });
  }
}

for (const files of [0, 1]) {
  test(`legacy restore remains supported, with an explicitly limited drill for ${files} files`, async t => {
    const f = await fixture(t, files);
    const archive = path.join(f.root, "legacy.tar.gz");
    await execute("tar", ["-czf", archive, "-C", f.data, "."]);
    const receipt = path.join(f.root, "receipt");
    await execute("bash", [path.join(ops, "restore-data.sh"), archive, path.join(f.root, "restored")], {
      env: { ...f.env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
    });
    assert.equal(JSON.parse(await readFile(receipt, "utf8")).verification, "legacy-shape-only");
    const drill = execute("bash", [path.join(ops, "restore-drill.sh"), archive], { env: f.env });
    await assert.rejects(drill, error => /legacy-shape-only.*content completeness unverified/.test(error.stderr)
      && (files > 0 || /empty/.test(error.stderr)));
  });
}

for (const type of ["hardlink", "symlink", "fifo", "traversal", "duplicate"]) {
  test(`ordinary restore rejects an unsupported ${type} tar member before extraction`, async t => {
    const f = await fixture(t);
    const archive = path.join(f.root, "unsupported.tar.gz");
    await execute("python3", ["-c", `import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    root = tarfile.TarInfo('.')
    root.type = tarfile.DIRTYPE
    archive.addfile(root)
    member = tarfile.TarInfo('../outside' if sys.argv[2] == 'traversal' else 'unsupported')
    member.type = {'hardlink': tarfile.LNKTYPE, 'symlink': tarfile.SYMTYPE, 'fifo': tarfile.FIFOTYPE, 'traversal': tarfile.REGTYPE, 'duplicate': tarfile.REGTYPE}[sys.argv[2]]
    if sys.argv[2] in ('hardlink','symlink'): member.linkname = '../outside'
    archive.addfile(member, io.BytesIO(b''))
    if sys.argv[2] == 'duplicate': archive.addfile(member, io.BytesIO(b''))
`, archive, type]);
    const target = path.join(f.root, "restored");
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: f.env }));
    await assert.rejects(access(target), { code: "ENOENT" });
  });
}

test("a removed manifest is legacy-unverified and cannot pass the automatic drill", async t => {
  const f = await fixture(t);
  const archive = await capture(f);
  const extracted = path.join(f.root, "extracted");
  await mkdir(extracted);
  await execute("tar", ["-xzf", archive, "-C", extracted]);
  await rm(path.join(extracted, manifestName));
  const stripped = path.join(f.root, "stripped.tar.gz");
  await execute("tar", ["-czf", stripped, "-C", extracted, "."]);
  await assert.rejects(execute("bash", [path.join(ops, "restore-drill.sh"), stripped], { env: f.env }),
    error => /legacy-shape-only.*unverified/.test(error.stderr));
});

for (const location of ["existing", "leaf-symlink", "parent-symlink"]) {
  test(`a verification receipt refuses ${location} without changing customer data or the existing receipt`, async t => {
    const f = await fixture(t);
    const archive = await capture(f);
    const preserved = path.join(f.root, "preserved");
    await writeFile(preserved, "keep receipt\n");
    let receipt = preserved;
    if (location === "leaf-symlink") {
      receipt = path.join(f.root, "linked-receipt");
      await symlink(preserved, receipt);
    } else if (location === "parent-symlink") {
      const linked = path.join(f.root, "linked-parent");
      await symlink(f.root, linked);
      receipt = path.join(linked, "receipt");
    }
    const target = path.join(f.root, "restored");
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
      env: { ...f.env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
    }));
    assert.equal(await readFile(preserved, "utf8"), "keep receipt\n");
    await assert.rejects(access(target), { code: "ENOENT" });
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".backup-verification-") || name.startsWith(".open-science-restore")), false);
  });
}

for (const encrypted of [false, true]) test(`restore retains ordinary private modes and strips special bits (${encrypted ? "encrypted" : "plain"})`, async t => {
  const f = await fixture(t, 0, encrypted);
  const privateDir = path.join(f.data, "protected-state");
  await mkdir(privateDir, { mode: 0o700 });
  await writeFile(path.join(privateDir, "secret-fixture"), "synthetic private material", { mode: 0o600 });
  for (const mode of [0o4755, 0o2755, 0o1755]) {
    const name = path.join(f.data, `special-${mode}`);
    await writeFile(name, "non-executed permission fixture"); await chmod(name, mode);
  }
  const archive = await capture(f);
  const target = path.join(f.root, "restored");
  await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: f.env });
  assert.equal((await stat(path.join(target, "protected-state"))).mode & 0o7777, 0o700);
  assert.equal((await stat(path.join(target, "protected-state/secret-fixture"))).mode & 0o7777, 0o600);
  for (const mode of [0o4755, 0o2755, 0o1755]) assert.equal((await stat(path.join(target, `special-${mode}`))).mode & 0o7777, 0o755);
});

for (const encrypted of [false, true]) test(`a read-only archive root is installed before its final mode is restored (${encrypted ? "encrypted" : "plain"})`, async t => {
  const f = await fixture(t, 1, encrypted);
  const target = path.join(f.root, "restored");
  await chmod(f.data, 0o500);
  try {
    const archive = await capture(f);
    await mkdir(target); await writeFile(path.join(target, "old"), "previous target");
    await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env: { ...f.env, OPEN_SCIENCE_RESTORE_REPLACE: "true" } });
    assert.equal((await stat(target)).mode & 0o7777, 0o500);
    assert.equal(await readFile(path.join(target, "pharmacy.sqlite"), "utf8"), "synthetic pharmacy fixture\n");
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".open-science-restore.")), false);
  } finally {
    await chmod(f.data, 0o700);
    await chmod(target, 0o700).catch(() => {});
    for (const name of await readdir(f.root)) if (name.startsWith(".open-science-restore.")) await chmod(path.join(f.root, name), 0o700);
  }
});

for (const encrypted of [false, true]) test(`failed restore removes restrictive staging and decrypted archives (${encrypted ? "encrypted" : "plain"})`, async t => {
  const f = await fixture(t, 0, encrypted);
  const protectedDir = path.join(f.data, "protected");
  await mkdir(protectedDir); await writeFile(path.join(protectedDir, "data"), "synthetic private bytes", { mode: 0o600 });
  await chmod(protectedDir, 0o500);
  const target = path.join(f.root, "existing");
  const decryptTmp = path.join(f.root, "decrypt-tmp");
  try {
    const archive = await capture(f);
    await mkdir(target); await writeFile(path.join(target, "kept"), "existing data");
    await mkdir(decryptTmp);
    const receipt = path.join(f.root, "already-present-receipt"); await writeFile(receipt, "must not replace");
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
      env: { ...f.env, TMPDIR: decryptTmp, OPEN_SCIENCE_RESTORE_REPLACE: "true", OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt },
    }));
    assert.equal(await readFile(path.join(target, "kept"), "utf8"), "existing data");
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".open-science-restore.")), false);
    assert.deepEqual(await readdir(decryptTmp), []);
  } finally {
    await chmod(protectedDir, 0o700);
    for (const name of await readdir(f.root)) if (name.startsWith(".open-science-restore.")) {
      await chmod(path.join(f.root, name), 0o700); await chmod(path.join(f.root, name, "protected"), 0o700).catch(() => {});
    }
  }
});

test("staging cleanup restores owner access without following an outside link", async t => {
  const f = await fixture(t, 0);
  const staging = path.join(f.root, ".open-science-restore.123");
  const protectedDir = path.join(staging, "protected");
  const outside = path.join(f.root, "outside");
  await mkdir(protectedDir, { recursive: true }); await writeFile(path.join(protectedDir, "data"), "private fixture");
  await mkdir(outside); await writeFile(path.join(outside, "kept"), "not staging");
  await symlink(outside, path.join(staging, "outside-link"));
  await chmod(protectedDir, 0o000); await chmod(outside, 0o500);
  try {
    await execute("python3", [path.join(ops, "backup_integrity.py"), "prepare-cleanup", staging]);
    assert.equal((await stat(protectedDir)).mode & 0o777, 0o700);
    assert.equal((await stat(outside)).mode & 0o777, 0o500);
    await rm(staging, { recursive: true });
    assert.equal(await readFile(path.join(outside, "kept"), "utf8"), "not staging");
  } finally { await chmod(outside, 0o700); await chmod(protectedDir, 0o700).catch(() => {}); }
});

for (const encrypted of [false, true]) test(`install failure cleans already restricted staging (${encrypted ? "encrypted" : "plain"})`, async t => {
  const f = await fixture(t, 0, encrypted);
  const restricted = path.join(f.data, "protected");
  await mkdir(restricted); await writeFile(path.join(restricted, "data"), "private fixture"); await chmod(restricted, 0o500);
  const target = path.join(f.root, "not-installed");
  try {
    const archive = await capture(f);
    const bin = path.join(f.root, "bin"), temporary = path.join(f.root, "decrypt-tmp");
    await mkdir(bin); await mkdir(temporary);
    await writeFile(path.join(bin, "mv"), "#!/bin/sh\nexit 37\n", { mode: 0o700 });
    await assert.rejects(execute("bash", [path.join(ops, "restore-data.sh"), archive, target], {
      env: { ...f.env, TMPDIR: temporary, PATH: `${bin}:${process.env.PATH}` },
    }), error => error.code === 37);
    assert.equal((await readdir(f.root)).some(name => name.startsWith(".open-science-restore.")), false);
    assert.deepEqual(await readdir(temporary), []);
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally { await chmod(restricted, 0o700); }
});
