import { recordShareLearning } from "./capsuleShareMetrics.mjs";

/**
 * Whether a share has earned the right to count for the platform (evidence-flywheel plan §7, 2026-10-05).
 *
 * The defence is on the write side and has two halves, both here:
 *
 * - **`shareIsCorroborated`**: a share by a new author is false until `minAccounts` OTHER accounts have imported that exact
 *   snapshot and kept it enabled for `keptDays` without disabling it (`CapsuleService` stamps `keptSince` when a received pack
 *   is enabled and clears it when it is disabled; a newer snapshot starts the period again). The author's own copy never counts,
 *   a taken-down pack never counts, and a pack whose author the platform could not verify can never be corroborated: it names
 *   nobody whose other accounts could be counted.
 * - **`guestInfluence`**: which of a finished run's guest capsules were not corroborated when it ran. Such a run still learns for
 *   its own account — its lesson is queued as every other run's is — but nothing it produced reaches a platform-level consumer:
 *   the run is marked, and `evolutionLearningCoupling.mjs`, the one place a researcher's handbook becomes a platform lead, leaves
 *   its observations out.
 *
 * What was found to flow where is in the work package's report; the short version is that a lesson, a learned method and a
 * handbook are each one account's, and the only channel from learning to the whole platform is the handbook-gap scan.
 *
 * @module capsuleShareTrust
 */

export const SHARE_CORROBORATION_MIN_ACCOUNTS = 3;
export const SHARE_CORROBORATION_KEPT_DAYS = 14;
const DAY_MS = 86_400_000;
/** The recordType of the marker a guest-influenced run leaves. */
export const GUEST_RUN_RECORD_TYPE = "guest-influenced-run";

/**
 * @param {{ authorId?: string | null, snapshotHash?: string | null }} share
 * @param {{ database: any, minAccounts?: number, keptDays?: number, now?: () => number }} context
 * @returns {Promise<boolean>}
 */
export async function shareIsCorroborated({ authorId, snapshotHash }, { database, minAccounts = SHARE_CORROBORATION_MIN_ACCOUNTS, keptDays = SHARE_CORROBORATION_KEPT_DAYS, now = Date.now }) {
  if (typeof authorId !== "string" || !authorId || typeof snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshotHash)) return false;
  const cutoff = new Date(now() - keptDays * DAY_MS).toISOString();
  const result = await database.query(`SELECT count(DISTINCT user_id)::integer AS n FROM evimed_product.documents
    WHERE kind='capsule' AND deleted_at IS NULL AND user_id<>$1 AND payload @> '{"imported":true}'::jsonb
      AND payload->'transfer'->>'authorId'=$1 AND payload->'transfer'->>'manifestSha256'=$2
      AND payload->'takenDown' IS NULL AND (payload->>'keptSince') IS NOT NULL AND (payload->>'keptSince')::timestamptz<=$3::timestamptz`,
  [authorId, snapshotHash, cutoff]);
  return Number(result.rows[0]?.n ?? 0) >= minAccounts;
}

/** @param {unknown} value @returns {string[]} */
const capsuleFactIds = (value) => (Array.isArray(value) ? value : [])
  .map((item) => String(/** @type {any} */ (item)?.id ?? ""))
  .filter((id) => id.startsWith("capsule:")).map((id) => id.slice("capsule:".length)).slice(0, 80);
/** A mounted method is `method-<the fact's id>` when the id is a safe directory name (an imported fact's is a UUID). @param {unknown} value */
const methodFactIds = (value) => (Array.isArray(value) ? value : [])
  .map((item) => String(/** @type {any} */ (item)?.name ?? ""))
  .filter((name) => /^method-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)).map((name) => name.slice("method-".length)).slice(0, 80);

/**
 * @param {{ database: any, documents?: any, minAccounts?: number, keptDays?: number, now?: () => number }} options
 */
export function createGuestInfluence({ database, documents = null, minAccounts = SHARE_CORROBORATION_MIN_ACCOUNTS, keptDays = SHARE_CORROBORATION_KEPT_DAYS, now = Date.now }) {
  return {
    /**
     * The received packs a finished run drew on — an entry its recall returned, or a method mounted into it — and for each
     * whether the share was corroborated. A run that used none answers an empty list. Reads only this account's own records.
     * @param {string} userId @param {{ recalledMemories?: unknown, methodsLoaded?: unknown }} run
     * @returns {Promise<{ guest: { capsuleId: string, authorId: string | null, snapshotHash: string | null, corroborated: boolean }[], uncorroborated: string[] }>}
     */
    async assess(userId, run) {
      const factIds = [...new Set([...capsuleFactIds(run?.recalledMemories), ...methodFactIds(run?.methodsLoaded)])];
      if (!factIds.length) return { guest: [], uncorroborated: [] };
      const facts = await database.query(`SELECT DISTINCT payload->>'capsuleId' AS capsule_id FROM evimed_product.documents
        WHERE user_id=$1 AND kind='fact' AND id=ANY($2::text[]) AND payload ? 'capsuleId'`, [userId, factIds]);
      const capsuleIds = facts.rows.map((/** @type {any} */ row) => String(row.capsule_id));
      if (!capsuleIds.length) return { guest: [], uncorroborated: [] };
      const packs = await database.query(`SELECT id,payload FROM evimed_product.documents WHERE user_id=$1 AND kind='capsule' AND id=ANY($2::text[])
        AND payload @> '{"imported":true}'::jsonb`, [userId, capsuleIds]);
      const guest = [];
      for (const row of packs.rows) {
        const authorId = typeof row.payload?.transfer?.authorId === "string" ? row.payload.transfer.authorId : null;
        const snapshotHash = typeof row.payload?.transfer?.manifestSha256 === "string" ? row.payload.transfer.manifestSha256 : null;
        const corroborated = await shareIsCorroborated({ authorId, snapshotHash }, { database, minAccounts, keptDays, now });
        guest.push({ capsuleId: String(row.id), authorId, snapshotHash, corroborated });
      }
      return { guest, uncorroborated: guest.filter((item) => !item.corroborated).map((item) => item.capsuleId) };
    },

    /**
     * Leave the marker `evolutionLearningCoupling` reads: this run used a pack no other account has vouched for. Idempotent: a
     * second marker for the run is the first.
     * @param {{ id: string, userId: string }} project @param {{ id: string }} run
     * @param {{ guest: any[], uncorroborated: string[] }} assessment
     */
    async mark(project, run, assessment) {
      if (!documents) return;
      try {
        await documents.put(project.userId, "preferences", `guest-run:${run.id}`.slice(0, 200), {
          recordType: GUEST_RUN_RECORD_TYPE, runId: run.id, projectId: project.id, markedAt: new Date(now()).toISOString(),
          capsules: assessment.guest.map((item) => ({ capsuleId: item.capsuleId, authorId: item.authorId, snapshotHash: item.snapshotHash, corroborated: item.corroborated })),
        }, { expectedRevision: 0, projectId: project.id });
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      }
    },

    /** The counters of what learning did with a run that used a guest capsule. @param {{ uncorroborated: string[], guest: any[] }} assessment */
    count(assessment) {
      if (!assessment.guest.length) return;
      recordShareLearning(assessment.uncorroborated.length ? "kept_from_platform" : "counted");
    },
  };
}

/**
 * Of a researcher's runs, those marked as having used an uncorroborated guest capsule. One query; a database that cannot say
 * returns every run unmarked (the platform signal then behaves as it did before this rule, never worse).
 * @param {any} database @param {string} userId @param {readonly string[]} runIds
 * @returns {Promise<Set<string>>}
 */
export async function guestMarkedRuns(database, userId, runIds) {
  if (!runIds.length) return new Set();
  try {
    const result = await database.query(`SELECT payload->>'runId' AS run_id FROM evimed_product.documents
      WHERE user_id=$1 AND kind='preferences' AND payload @> '{"recordType":"guest-influenced-run"}'::jsonb AND payload->>'runId'=ANY($2::text[]) AND deleted_at IS NULL`,
    [userId, [...runIds]]);
    return new Set(result.rows.map((/** @type {any} */ row) => row?.run_id).filter((/** @type {unknown} */ id) => typeof id === "string"));
  } catch { return new Set(); }
}
