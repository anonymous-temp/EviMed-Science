#!/usr/bin/env node
/**
 * Archive the memories the extractor wrote under its old rules — the run's
 * own bookkeeping — so the memory page stops leading with them.
 *
 * On 2026-09-20 the write side changed: the 「分析口径」 kind is no longer
 * extracted, the default project (a catch-all) no longer receives project
 * facts, and a text carrying the platform's own vocabulary or an identifier
 * shape (`referenceNumber`, `report.md`) is refused (`runBookkeepingIn`). What
 * was written before stays, and on production it was nearly all of it: the
 * acceptance account's 「EviMed 眼中的你」 opened with 「需为编号错位提供精确对照表并附勘误」
 * and its recent changes with 「ledger 的 referenceNumber 字段……」.
 *
 * This applies the new rules to what exists, once:
 *   - only `active` rows the platform wrote (`origin` system or inferred);
 *     anything the researcher said or edited is never touched;
 *   - never an episode (`run_summary`), which the timeline still reads;
 *   - archived, not deleted: each one is a revision with a reason, it shows
 *     under 「已忘记」, and one click (`undo`) restores it.
 *
 * Dry run by default; prints counts only, never memory text.
 *   node scripts/ops/archive-legacy-memory.mjs            # what would change
 *   node scripts/ops/archive-legacy-memory.mjs --apply    # archive them
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBookkeepingIn } from "@evimed/domain";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import { migrateResearchMemory } from "../../apps/server/src/researchMemoryPersistence.mjs";
import { ResearchMemoryStore } from "../../apps/server/src/researchMemory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apply = process.argv.includes("--apply");
/** The project classes the default project no longer receives (2026-09-20). */
const PROJECT_KINDS = new Set(["project_fact", "decision", "follow_up", "analysis"]);
const DEFAULT_PROJECT = "default";

function databaseUrl() {
  const direct = process.env.OPEN_SCIENCE_DATABASE_URL;
  const file = process.env.OPEN_SCIENCE_DATABASE_URL_FILE
    ?? process.env.OPEN_SCIENCE_DATABASE_URL_HOST_FILE
    ?? path.join(repoRoot, "deploy/web/secrets/database-url.txt");
  if (direct) return direct;
  return fs.readFileSync(file, "utf8").trim();
}

/** Why the new write rules would refuse this row, or null. @param {any} row */
export function legacyReason(row) {
  if (row.status !== "active" || !["system", "inferred"].includes(row.origin) || row.kind === "run_summary") return null;
  if (row.kind === "analysis") return "analysis-kind-retired";
  if (row.scope === "project" && row.scope_id === DEFAULT_PROJECT && PROJECT_KINDS.has(row.kind)) return "default-project-fact";
  if (runBookkeepingIn(`${row.value}\n${row.summary ?? ""}`).length) return "run-bookkeeping";
  return null;
}

async function main() {
  const database = new ControlPlaneDatabase({ databaseUrl: databaseUrl(), databasePoolMax: 2, databaseConnectionTimeoutMs: 5_000 });
  try {
    await migrateResearchMemory(database);
    const store = new ResearchMemoryStore({}, { database });
    const rows = (await database.query(`SELECT user_id,id,version,kind,scope,scope_id,origin,status,value,summary
      FROM evimed_memory.records WHERE status='active' ORDER BY user_id,id`)).rows;
    /** @type {Record<string, Record<string, number>>} */
    const counts = {};
    let archived = 0;
    for (const row of rows) {
      const reason = legacyReason(row);
      if (!reason) continue;
      counts[row.user_id] ??= {};
      counts[row.user_id][reason] = (counts[row.user_id][reason] ?? 0) + 1;
      if (!apply) continue;
      const existing = await store.getRecord(row.user_id, row.id);
      if (existing.version !== row.version || existing.status !== "active") continue;
      await store.upsertRecord(row.user_id, { ...existing, status: "archived" }, null, {
        expectedVersion: existing.version,
        reason: `archived under the 2026-09-20 write rules: ${reason}`,
        by: "system",
      });
      archived += 1;
    }
    process.stdout.write(`${JSON.stringify({ apply, active: rows.length, legacy: counts, archived })}\n`);
  } finally { await database.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`archive_legacy_memory_failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
