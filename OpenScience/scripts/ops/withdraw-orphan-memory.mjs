#!/usr/bin/env node
/**
 * Find, and with `--apply` withdraw, the memories still derived from a
 * knowledge-base document or a project that no longer exists (plan 2026-09-23
 * §5.6): the 「来自资料」 capsule entries a deleted document left behind, and a
 * deleted project's notes.
 *
 *   node scripts/ops/withdraw-orphan-memory.mjs                 # report only
 *   node scripts/ops/withdraw-orphan-memory.mjs --apply         # withdraw
 *   node scripts/ops/withdraw-orphan-memory.mjs --user <id> [--limit 500] [--apply]
 *
 * The same sweep the source worker runs on its repair cycle
 * (`derivedMemory.mjs`); this is for an operator who wants the count now, or
 * the withdrawal before the next cycle. Idempotent: a withdrawn entry is
 * soft-deleted with its reason and a withdrawn ledger is emptied, so a second
 * run reports nothing. It reads only the control-plane database; the recall
 * index follows through the ordinary outbox, as it does for every forget.
 *
 * The output is one JSON object: what was (or would be) withdrawn, per
 * document or project, with counts only — never the memories' text.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { withdrawOrphanedDerivedMemory } from "../../apps/server/src/derivedMemory.mjs";
import { migrateProductStore } from "../../apps/server/src/productPersistence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string[]} argv */
function parseArguments(argv) {
  let apply = false;
  let userId = null;
  let limit = 500;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--user" || argument === "--limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--user") userId = value;
      else {
        limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer between 1 and 500");
      }
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return { apply, userId, limit };
}

/** The control-plane database, from the same sources the server reads it from. */
function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct && fs.existsSync(file)) throw new Error("Database URL has conflicting direct and file sources.");
  if (direct) return direct;
  const stat = fs.statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Database URL file must be an owner-only regular file.");
  return fs.readFileSync(file, "utf8").trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(database);
    // One bounded page per call, until a page comes back empty or — in a
    // report, which changes nothing and so would list the same page again —
    // after the first.
    const total = { applied: options.apply, sources: 0, projects: 0, entries: 0, ledgers: 0, orphans: /** @type {any[]} */ ([]) };
    for (let page = 0; page < 100; page += 1) {
      const result = await withdrawOrphanedDerivedMemory(database, { limit: options.limit, userId: options.userId, apply: options.apply });
      total.sources += result.sources;
      total.projects += result.projects;
      total.entries += result.entries;
      total.ledgers += result.ledgers;
      total.orphans.push(...result.orphans);
      if (!options.apply || result.orphans.length === 0) break;
    }
    process.stdout.write(`${JSON.stringify(total, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`withdraw_orphan_memory_failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
