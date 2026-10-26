import { openVikingUserId, researchMemoryRoots } from "./openVikingClient.mjs";
import { migrateMemorySettings } from "./memorySettingsPersistence.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { recordLegacyRetirement } from "./memoryMetrics.mjs";

/**
 * What is left of the legacy memory engine in a database and in the engine's index, taken away once at start.
 *
 * Hidden knowledge. Until 2026-10-25 an account's memory was on one of two engines: the platform's own extraction into PostgreSQL
 * records (`evimed_memory.records`, with `record_sources`, `record_conflicts`, `record_usage` and `record_reviews` beside it,
 * OpenViking only a derived recall index of them under `memories/evimed/{user,project,session}`) or OpenViking's own. The records
 * engine was deleted; this is the step that makes the data match the code, and it is written so that it can never take away a
 * memory somebody still has:
 *
 *  - **The tables are dropped only when they hold nothing and no account says it is on the legacy engine** (`settings.engine`, the
 *    column that said which). Otherwise they are kept as they are, one line names why, and the outcome is counted
 *    (`open_science_legacy_memory_retirement_total{outcome}`): a deployment with legacy rows has to decide about them, and the
 *    account export carries them (`MemorySettingsStore.exportUserMemory`) so that nothing held about a person is out of their copy. The
 *    engine columns are dropped with the tables, under the same condition — kept, they are how the next start tells that an account
 *    still says legacy.
 *  - **The index's copies are withdrawn once, whatever became of the tables**: the three subtrees the records occupied, for every
 *    account, through the withdrawal ledger (`MemoryIndexWithdrawals`, drained by the index worker, retried until the engine answers).
 *    The capsule's facts sit beside them under `memories/evimed/capsule` and are never named. The marker is a row of
 *    `evimed_product.schema_migrations`, written in the same transaction as the work it marks, so a second start does nothing and a
 *    crash between the two does not lose it. Without a withdrawal ledger (no engine composed here) nothing is asked and nothing is
 *    marked: a later start with the engine does it.
 *  - **The queued jobs of the retired index kind are deleted** (`memory-record-index`): nothing claims them any more, and each
 *    names a record that is gone.
 *  - **The erasure ledger of the retired usememos store is dropped** (`evimed_memory.retired_erasures`, unconditionally): it held the
 *    two digests of every account erased since that store was left behind, only so that an archive of the store could be re-sealed
 *    against it, and production never made the archive. Nothing reads it and no migration makes it any more; the table is dropped in
 *    the same transaction as the rest, and a database that never had it finds nothing.
 *
 * Idempotent: on a database that has none of it, every statement finds nothing. Never throws into the start: a failure is reported
 * and counted (`failed`) and the next start asks again.
 *
 * Build to delete: when no deployment holds the tables or the marker has been written everywhere, this module and the retired job
 * kind (`PRODUCT_JOB_KINDS`) can go.
 *
 * @module legacyMemoryRetirement
 */

/** The marker of the index withdrawal, in `evimed_product.schema_migrations`. */
export const LEGACY_INDEX_WITHDRAWN = "2026-10-25-legacy-memory-index-withdrawn";

/** The tables only the legacy engine used, children first. */
const LEGACY_TABLES = Object.freeze(["record_reviews", "record_conflicts", "record_sources", "record_usage", "records"]);

/** @param {any} client @param {string} table */
async function tableExists(client, table) {
  return (await client.query("SELECT to_regclass($1) AS name", [`evimed_memory.${table}`])).rows[0]?.name != null;
}

/**
 * @param {{ database: any, withdrawals?: { migrate: () => Promise<void>, enqueue: (client: any, userId: string, uris: readonly string[]) => Promise<void> } | null,
 *   report?: (line: string) => void }} dependencies
 * @returns {Promise<{ tables: "dropped" | "absent" | "kept_records" | "kept_legacy_accounts", jobs: number, withdrawn: "queued" | "done_before" | "not_composed", accounts: number,
 *   ledger: "dropped" | "absent", failed?: string }>}
 */
export async function retireLegacyMemory({ database, withdrawals = null, report = () => {} }) {
  /** @type {Awaited<ReturnType<typeof retireLegacyMemory>>} */
  const result = { tables: "absent", jobs: 0, withdrawn: "not_composed", accounts: 0, ledger: "absent" };
  try {
    await migrateMemorySettings(database);
    await migrateProductStore(database);
    if (withdrawals) await withdrawals.migrate();
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-legacy-retirement-v1'))");

      // 1. The tables, and the column that said which engine an account was on.
      const present = await tableExists(client, "records");
      const column = (await client.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema='evimed_memory' AND table_name='settings' AND column_name='engine'`)).rowCount === 1;
      const records = present ? Number((await client.query("SELECT count(*)::int AS n FROM evimed_memory.records")).rows[0].n) : 0;
      const accounts = column ? Number((await client.query("SELECT count(*)::int AS n FROM evimed_memory.settings WHERE engine = 'legacy'")).rows[0].n) : 0;
      if (records > 0) {
        result.tables = "kept_records";
        report(`legacy memory: ${records} structured record(s) are still held in evimed_memory.records; the tables are kept (nothing reads them; the account export carries them)`);
      } else if (accounts > 0) {
        result.tables = "kept_legacy_accounts";
        report(`legacy memory: ${accounts} account(s) still say they are on the legacy engine (evimed_memory.settings.engine); the tables are kept`);
      } else if (present || column) {
        for (const table of LEGACY_TABLES) await client.query(`DROP TABLE IF EXISTS evimed_memory.${table} CASCADE`);
        await client.query("ALTER TABLE evimed_memory.settings DROP COLUMN IF EXISTS engine");
        await client.query("ALTER TABLE evimed_memory.settings DROP COLUMN IF EXISTS engine_changed_at");
        result.tables = "dropped";
      }

      // 2. The queued jobs of the retired index kind.
      result.jobs = Number((await client.query("DELETE FROM evimed_product.jobs WHERE kind='memory-record-index'")).rowCount ?? 0);

      // 3. The erasure ledger of the retired usememos store, which nothing reads.
      if (await tableExists(client, "retired_erasures")) {
        await client.query("DROP TABLE evimed_memory.retired_erasures");
        result.ledger = "dropped";
      }

      // 4. The index's copies of the records, once.
      if (withdrawals) {
        const done = (await client.query("SELECT 1 FROM evimed_product.schema_migrations WHERE name=$1", [LEGACY_INDEX_WITHDRAWN])).rowCount === 1;
        if (done) result.withdrawn = "done_before";
        else {
          const users = (await client.query("SELECT id FROM evimed_control.users ORDER BY id")).rows;
          for (const user of users) {
            // An id the engine cannot name has no subtree to withdraw.
            let roots = [];
            try { openVikingUserId(String(user.id)); roots = researchMemoryRoots(String(user.id)); } catch { continue; }
            await withdrawals.enqueue(client, String(user.id), roots);
          }
          await client.query("INSERT INTO evimed_product.schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [LEGACY_INDEX_WITHDRAWN]);
          result.withdrawn = "queued";
          result.accounts = users.length;
        }
      }
    });
    recordLegacyRetirement(result.tables);
    if (result.withdrawn === "queued") recordLegacyRetirement("index_withdrawals_queued");
    if (result.jobs > 0) recordLegacyRetirement("jobs_deleted");
    if (result.ledger === "dropped") recordLegacyRetirement("erasure_ledger_dropped");
    if (result.tables === "dropped" || result.withdrawn === "queued" || result.jobs > 0 || result.ledger === "dropped") {
      report(`legacy memory: tables ${result.tables}; ${result.jobs} retired index job(s) deleted; index copies of the records ${result.withdrawn}${result.withdrawn === "queued" ? ` for ${result.accounts} account(s)` : ""}${result.ledger === "dropped" ? "; the retired usememos erasure ledger dropped" : ""}`);
    }
  } catch (error) {
    result.failed = String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 200);
    recordLegacyRetirement("failed");
    report(`legacy memory: the retirement could not run (${result.failed}); the next start asks again`);
  }
  return result;
}
