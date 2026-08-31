// The restore drill exists to prove a backup can be restored. It broke backups.
//
// `restore-data.sh` decrypts into a temp directory, and on the success path it
// ran `trap - EXIT` to stop the cleanup removing the extraction directory it
// had just moved into place — disarming the removal of the decrypted archive
// along with it. Only success reached that line, so a failing restore cleaned
// up correctly and every successful one left 404MB behind. Five of them filled
// the backup container's 2GB /tmp between 2026-08-24 and 08-28; the run on
// 08-29 failed with ENOSPC and every run since failed the same way.
//
// This runs the real script against a real encrypted archive and looks at the
// temp directory afterwards, because reading the source for `trap - EXIT` would
// pass the moment someone wrote the same leak a different way.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const opsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "ops");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasTar = spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;

async function encryptedArchive(workDir, passphraseFile) {
  const payload = path.join(workDir, "payload");
  await mkdir(path.join(payload, "projects"), { recursive: true });
  await writeFile(path.join(payload, "projects", "note.txt"), "restored\n", "utf8");
  const plain = path.join(workDir, "data.tar.gz");
  await execFileAsync("tar", ["-czf", plain, "-C", payload, "."]);
  const encrypted = path.join(workDir, "data.tar.gz.enc");
  await execFileAsync("node", [path.join(opsDir, "archive-crypto.mjs"), "encrypt", plain, encrypted], {
    env: { ...process.env, OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: passphraseFile },
  });
  return encrypted;
}

test("a successful restore leaves nothing behind in TMPDIR", { skip: hasBash && hasTar ? false : "bash/tar unavailable" }, async () => {
  const work = await mkdtemp(path.join(tmpdir(), "restore-leak-"));
  const scratchTmp = path.join(work, "tmp");
  await mkdir(scratchTmp, { recursive: true });
  try {
    const passphraseFile = path.join(work, "passphrase");
    await writeFile(passphraseFile, "correct horse battery staple\n", { mode: 0o600 });
    const archive = await encryptedArchive(work, passphraseFile);

    const target = path.join(work, "restored");
    await execFileAsync("bash", [path.join(opsDir, "restore-data.sh"), archive, target], {
      env: {
        ...process.env,
        TMPDIR: scratchTmp,
        OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: passphraseFile,
      },
    });

    // The restore worked...
    const restored = await readdir(path.join(target, "projects"));
    assert.deepEqual(restored, ["note.txt"], "the archive must actually restore, or this test proves nothing");

    // ...and took its scratch space with it.
    const leftovers = (await readdir(scratchTmp)).filter((name) => name.startsWith("open-science-backup."));
    assert.deepEqual(leftovers, [], "a successful restore left its decrypted archive in TMPDIR — this is what filled production's 2GB tmpfs");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
