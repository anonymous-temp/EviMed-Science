import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/host");

/** @param {string} text @returns {Map<string, string[]>} "Section.Key" -> values, in order */
function unitEntries(text) {
  const entries = new Map();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { section = header[1]; continue; }
    const split = line.indexOf("=");
    assert.ok(split > 0, `not a unit line: ${line}`);
    const key = `${section}.${line.slice(0, split)}`;
    entries.set(key, [...(entries.get(key) ?? []), line.slice(split + 1)]);
  }
  return entries;
}

async function unit(name) {
  return unitEntries(await readFile(path.join(hostDir, name), "utf8"));
}

// The knowledge-source plugin's database had no backup at all (2026-09-26
// audit, I3-3): the platform timer dumps `evimed` only. The ruling is a second
// timer running the same script against `evimed_knowledge` with its own
// backup directory and so its own state file — installed on the host
// 2026-09-27, and these files are the repository copy of exactly that.
test("the knowledge-plugin database backup is the platform backup pointed at evimed_knowledge", async () => {
  const platform = await unit("evimed-postgres-backup.service");
  const knowledge = await unit("evimed-knowledge-db-backup.service");

  assert.deepEqual(knowledge.get("Service.Environment"), [
    "EVIMED_POSTGRES_DATABASE=evimed_knowledge",
    "EVIMED_POSTGRES_BACKUP_DIR=/srv/evimed-science/shared/backups/postgres-knowledge",
  ]);
  // Its own directory, writable and nothing else: the platform archive and
  // its receipt stay out of this unit's reach.
  assert.deepEqual(knowledge.get("Service.ReadWritePaths"), ["/srv/evimed-science/shared/backups/postgres-knowledge"]);
  assert.notDeepEqual(knowledge.get("Service.ReadWritePaths"), platform.get("Service.ReadWritePaths"));
  assert.match(knowledge.get("Unit.Description")?.[0] ?? "", /evimed_knowledge/);

  // Everything else is the platform unit's: the same executable, the same
  // sandbox, the same role and passphrase (their defaults), the same limits.
  const differs = new Set(["Unit.Description", "Service.Environment", "Service.ReadWritePaths"]);
  for (const [key, values] of platform) {
    if (differs.has(key)) continue;
    assert.deepEqual(knowledge.get(key), values, `${key} differs from the platform backup unit`);
  }
  for (const key of knowledge.keys()) {
    assert.ok(platform.has(key) || differs.has(key), `${key} is not in the platform backup unit`);
  }
});

test("the knowledge-plugin backup timer runs daily, apart from the platform one, and catches up", async () => {
  const platform = await unit("evimed-postgres-backup.timer");
  const knowledge = await unit("evimed-knowledge-db-backup.timer");
  assert.deepEqual(knowledge.get("Timer.Unit"), ["evimed-knowledge-db-backup.service"]);
  assert.deepEqual(knowledge.get("Timer.OnCalendar"), ["*-*-* 03:20:00 Asia/Shanghai"]);
  assert.deepEqual(knowledge.get("Timer.RandomizedDelaySec"), ["20m"]);
  assert.deepEqual(knowledge.get("Timer.Persistent"), ["true"]);
  assert.deepEqual(knowledge.get("Install.WantedBy"), platform.get("Install.WantedBy"));
  // The two dumps share one PostgreSQL container: the platform window
  // (02:30 + up to 20 min) ends before this one opens.
  assert.notDeepEqual(knowledge.get("Timer.OnCalendar"), platform.get("Timer.OnCalendar"));
});
