// A backup that has never left the machine it protects is a backup for the
// failures that do not take the machine with them.
//
// On 2026-08-31 production had made 119 encrypted archives, drilled the restore
// on every one, reported healthy — and copied none of them anywhere. The
// readiness probe said so (`backup_external_unconfirmed`, acknowledgement
// unsigned, object URI empty) and it was right, but the scheduler had no code
// to upload with: object-backup.mjs existed as an ops tool nothing called.
//
// These pin the three outcomes apart, because collapsing any two of them is how
// the situation stayed invisible: no target configured is a decision, a failed
// upload is an incident, and a successful upload is the only one that means the
// data exists in two places.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the scheduler uploads off-box when a target is configured", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/ops/backup-scheduler.mjs"), "utf8");
  assert.match(source, /objectBackupScript/, "the scheduler must call the upload, not merely ship beside it");
  assert.match(source, /"upload", archive, config\.objectBackupUri/);
  assert.match(source, /objectBackupUri: String\(process\.env\.OPEN_SCIENCE_OBJECT_BACKUP_URI/);
});

test("the three outcomes stay distinguishable", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/ops/backup-scheduler.mjs"), "utf8");
  for (const outcome of ['"not_configured"', '"uploaded"', '"failed"']) {
    assert.ok(source.includes(outcome), `the scheduler must be able to report ${outcome}`);
  }
  // A failed upload may not read as a healthy backup, and may not discard a
  // local archive that did succeed and was just drilled.
  assert.match(source, /offsite === "failed" \? "degraded" : "healthy"/);
  assert.match(source, /backup\.offsite_failed/);
});

test("credentials reach the container as a file, never as a value in .env", async () => {
  // Same rule as every other secret on this platform: by path. An access key in
  // .env is read by more things and copied to more places than anyone tracks.
  const compose = await readFile(path.join(repoRoot, "deploy/web/docker-compose.backup.yml"), "utf8");
  assert.match(compose, /AWS_SHARED_CREDENTIALS_FILE: \/run\/secrets\/object-backup-credentials/);
  assert.match(compose, /open-science-object-backup-credentials:/);
  assert.doesNotMatch(compose, /AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/, "credentials must not be passed as environment values");
});

test("an unconfigured deployment is still a working one", async () => {
  // The off-box copy is optional and its absence is a stated decision, not a
  // crash. What must not exist is the state this replaced: external mode
  // declared, nothing configured, and nobody told.
  const source = await readFile(path.join(repoRoot, "scripts/ops/backup-scheduler.mjs"), "utf8");
  assert.match(source, /let offsite = "not_configured"/);
  assert.match(source, /if \(config\.objectBackupUri\) \{/, "an empty URI must skip the upload rather than fail the backup");
});

// The deployment's declaration has to reach every container, and on 2026-08-31
// it did not. `.env` said `local`; the web container reported `external`.
//
// Both overlays set the same key on the same service as a literal, so which
// value a container ended up with was decided by nothing but the order its `-f`
// files were passed: the web container was created from `yml,saas,local-auth,
// monitoring` and got `external`, the backup container from `yml,local-auth,
// backup,monitoring` and got `local`. One stack, two containers, two beliefs
// about whether backups leave the machine — and no place where they met.
//
// A literal here cannot be overridden by an operator, so the check is not that
// the two agree today but that the declaration is what decides. Profiles keep
// their own defaults; `.env` outranks all of them.
test("every compose file lets the deployment declare its own backup mode", async () => {
  const dir = path.join(repoRoot, "deploy/web");
  const files = (await readdir(dir)).filter((name) => name.startsWith("docker-compose") && name.endsWith(".yml"));
  assert.ok(files.length >= 3, `expected the web compose set, found ${files.length}`);

  let setters = 0;
  for (const name of files) {
    const body = await readFile(path.join(dir, name), "utf8");
    for (const line of body.split("\n")) {
      const match = /^\s*OPEN_SCIENCE_BACKUP_MODE:\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      setters += 1;
      assert.match(
        match[1],
        /^\$\{OPEN_SCIENCE_BACKUP_MODE(:-[a-z]+)?\}$/,
        `${name} pins the backup mode to the literal ${match[1]}, so a deployment that declares `
        + `a different one is silently overruled — and which literal wins depends on -f order`,
      );
    }
  }
  // Without this the loop passes on a directory it failed to read.
  assert.ok(setters >= 3, `expected every overlay to carry the key, saw ${setters}`);
});
