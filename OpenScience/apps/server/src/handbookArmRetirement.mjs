import { migrateProductStore } from "./productPersistence.mjs";

/**
 * What is left of the capability-handbook arm in a database, taken away once at start.
 *
 * Hidden knowledge. Until 2026-10-25 a lesson whose only evidence was the delivery gate's own findings (a repaired delivery, `repair_accepted`)
 * was filed as an account's capability handbook, applied by a loop of its own, mounted into runs under that capability, and offered to the platform's
 * pack of handbooks. The one thing that produced such a lesson was read at a share of 0 and is deleted, and with it everything that only existed to
 * consume it. This is the step that makes the data match the code. On production there is nothing for it to do: the handbooks lived on accounts that
 * were deleted (2026-10-25), so every statement here finds nothing. It exists for a deployment that still holds some, and it is written so that it can
 * never take anything but what only the arm used:
 *
 *  - **The account's handbooks and the candidates waiting to become one** (`capability-handbook`, `handbook-candidate`, method records): deleted with their
 *    history. No page lists them any more and no run mounts them; a copy that stayed would be text nobody can see or remove.
 *  - **The jobs of the arm that are still waiting** (`consolidate` with `action: "optimize"`, which applied a handbook, and `distill` with the trigger
 *    `repair_accepted`, which wrote one): cancelled with the arm named as the reason, and left in the table as history. The action and the trigger no
 *    longer exist, so a job still queued would only be refused by name; one already running is left to its worker.
 *  - **The evolution module's records of the platform handbook path** (`evolution-handbook-*`: a candidate, a use): deleted. What it published into
 *    the platform's skill supply as a tool of kind `handbook` is only counted and said: those entries are served by the supply and retired through the
 *    evolution module, not by a delete here.
 *
 * Idempotent, and never throws into the start: a failure is reported and the next start asks again. Build to delete: when no deployment can hold the
 * records, this module goes.
 *
 * @module handbookArmRetirement
 */

/**
 * @param {{ database: any, report?: (line: string) => void }} dependencies
 * @returns {Promise<{ handbooks: number, candidates: number, jobs: number, evolutionRecords: number, tools: number, failed?: string }>}
 */
export async function retireHandbookArm({ database, report = () => {} }) {
  /** @type {Awaited<ReturnType<typeof retireHandbookArm>>} */
  const result = { handbooks: 0, candidates: 0, jobs: 0, evolutionRecords: 0, tools: 0 };
  try {
    await migrateProductStore(database);
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-handbook-arm-retirement-v1'))");
      const methods = await client.query(`DELETE FROM evimed_product.documents
        WHERE kind='method' AND payload->>'recordType' IN ('capability-handbook','handbook-candidate') RETURNING payload->>'recordType' AS record_type`);
      result.handbooks = methods.rows.filter((/** @type {any} */ row) => row.record_type === "capability-handbook").length;
      result.candidates = methods.rows.length - result.handbooks;
      result.jobs = Number((await client.query(`UPDATE evimed_product.jobs SET status='canceled', result=jsonb_build_object('retired','handbook_arm'),
        finished_at=coalesce(finished_at,clock_timestamp()), updated_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL
        WHERE status='queued' AND ((kind='consolidate' AND payload->>'action'='optimize') OR (kind='distill' AND payload->>'trigger'='repair_accepted'))`)).rowCount ?? 0);
      result.evolutionRecords = Number((await client.query(`DELETE FROM evimed_product.documents
        WHERE kind='knowledge' AND payload->>'recordType' LIKE 'evolution-handbook-%'`)).rowCount ?? 0);
      result.tools = Number((await client.query(`SELECT count(*)::int AS n FROM evimed_product.documents
        WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-tool' AND payload->>'toolKind'='handbook' AND payload->>'status'<>'retired'`)).rows[0]?.n ?? 0);
    });
    if (result.handbooks || result.candidates || result.jobs || result.evolutionRecords) {
      report(`handbook arm retired: handbooks=${result.handbooks} candidates=${result.candidates} jobs_canceled=${result.jobs} evolution_records=${result.evolutionRecords}`);
    }
    if (result.tools) report(`handbook arm: ${result.tools} platform handbook tool(s) are still published in the skill supply; retire them through the evolution module`);
  } catch (error) {
    result.failed = String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.name ?? "error");
    report(`handbook arm retirement failed: ${result.failed}`);
  }
  return result;
}
