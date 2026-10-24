// The capsule's identity is in the backup (2026-10-23, rectification T0.12 / A report open question 6). Every pack the platform issued is
// signed by a key kept as a file under the data directory, and every snapshot, revocation and key is read back only if it is a 0600 file in
// a 0700 directory its own user owns (`capsuleIdentityStore.protectedCapsuleDirectory`). Without the keys in a restore every issued pack is
// unverifiable; without the snapshots, unreadable. The backup is the whole data directory minus a closed list of volatile paths, so they
// are in by default — what this holds is that nothing on that list ever names them, and that the modes the server insists on survive an
// archive and a restore.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/ops");
const environment = { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE: "", OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: "",
  OPEN_SCIENCE_OBJECT_BACKUP_URI: "", OPEN_SCIENCE_BACKUP_RETENTION_DAYS: "", OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: "" };

const FILES = {
  "capsule-keys/issuer-key-aaaa.json": '{"issuerId":"issuer-1","keyId":"key-aaaa","publicKey":"PUBLIC"}\n',
  "capsule-keys/recipient-bbbb.json": '{"ownerId":"u","keyId":"bbbb","privateKey":"PRIVATE-KEY-BYTES"}\n',
  "capsule-snapshots/snapshot_cccc.evimedcap": "SNAPSHOT-CIPHERTEXT\n",
  "capsule-revocations/account-dddd.json": '{"revoked":["pack-1"]}\n',
};

/** A data directory as the server leaves one: the three protected directories at 0700 with 0600 files, beside an ordinary user tree. */
async function dataDirectory(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "backup-capsule-"));
  t.after(async () => { await execute("chmod", ["-R", "u+rwx", root]).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const data = path.join(root, "data");
  await mkdir(path.join(data, "users/u/projects/p/workspace"), { recursive: true });
  await writeFile(path.join(data, "users/u/projects/p/workspace/kept.txt"), "kept\n");
  for (const [relative, text] of Object.entries(FILES)) {
    const target = path.join(data, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700);
    await writeFile(target, text, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  return { root, data };
}

for (const strict of ["false", "true"]) {
  test(`the capsule's keys, snapshots and revocations are archived and come back with the modes the server requires (strict=${strict})`, async (t) => {
    const { root, data } = await dataDirectory(t);
    const env = { ...environment, OPEN_SCIENCE_BACKUP_STRICT: strict };
    const result = await execute("bash", [path.join(ops, "backup-data.sh"), data, path.join(root, "backups")], { env });
    const archive = result.stdout.trim().split(/\r?\n/).at(-1);
    const listed = await execute("python3", ["-c", `import json,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    print(json.dumps({member.name.rstrip('/'): member.mode & 0o777 for member in archive}))
`, archive]);
    const members = JSON.parse(listed.stdout);
    for (const relative of Object.keys(FILES)) {
      assert.ok(relative in members, `${relative} is in the archive`);
      assert.equal(members[relative], 0o600, `${relative} keeps mode 0600`);
    }
    for (const directory of ["capsule-keys", "capsule-snapshots", "capsule-revocations"]) {
      assert.ok(directory in members, `${directory} is in the archive`);
      assert.equal(members[directory], 0o700, `${directory} keeps mode 0700`);
    }
    assert.match(result.stderr, /^(?!.*left out)/s, "nothing of the capsule is said to be left out");

    // Restored: the same bytes in the same modes (a restore as the data's own user; the production recovery keeps the numeric owner).
    const target = path.join(root, "restored");
    await execute("bash", [path.join(ops, "restore-data.sh"), archive, target], { env });
    for (const [relative, text] of Object.entries(FILES)) {
      assert.equal(await readFile(path.join(target, relative), "utf8"), text);
      assert.equal((await lstat(path.join(target, relative))).mode & 0o777, 0o600);
    }
    for (const directory of ["capsule-keys", "capsule-snapshots", "capsule-revocations"]) {
      assert.equal((await lstat(path.join(target, directory))).mode & 0o777, 0o700);
      assert.ok((await readdir(path.join(target, directory))).length >= 1);
    }
  });
}

test("the backup's list of volatile paths never names the capsule's directories", async () => {
  const source = await readFile(path.join(ops, "backup-archive.mjs"), "utf8");
  const excluded = source.slice(source.indexOf("function excludedFromBackup"), source.indexOf("function metadataFields"));
  assert.ok(excluded.length > 200, "the walk found the exclusion rule");
  assert.doesNotMatch(excluded, /capsule/i, "a rule that excluded the keys would make every issued pack unverifiable after a restore");
});
