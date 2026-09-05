#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { migrateNotifications } from "../../apps/server/src/notificationPersistence.mjs";
import { migrateProductStore } from "../../apps/server/src/productPersistence.mjs";
import { migrateUsageLedger } from "../../apps/server/src/usagePersistence.mjs";
import { relationalIntegrity } from "../../apps/server/src/relationalIntegrity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validate = process.argv.includes("--validate");

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
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateProductStore(database);
    await migrateNotifications(database);
    await migrateUsageLedger(database);
    const status = await relationalIntegrity(database, { validate });
    if (!status.ok) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } finally { await database.close(); }
}

main().catch((error) => {
  process.stderr.write(`relational_integrity_failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
