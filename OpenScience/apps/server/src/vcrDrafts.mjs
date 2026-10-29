import { VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME } from "@evimed/domain";

/**
 * Draft visibility and conservative expiry candidates for virtual clinical research.
 * Saved inputs, study objects, registered sources and project activity keep a draft reachable.
 * Missing dependencies and unknown native attachment history never establish emptiness.
 *
 * The generic sweep permits a remover to return false when deletion cannot be proven safe.
 * The hosted composition does so for every project: VCR, source and native-upload writes do
 * not share the project's deletion lock. Automatic expiry therefore never stops a runtime,
 * deletes memory or removes project files. Explicit researcher deletion is independent.
 * @module vcrDrafts
 */

/** Age at which an unused draft becomes a retention candidate, never deletion authority. */
export const VCR_DRAFT_TTL_MS = 60 * 60_000;

/** Drafts one sweep looks at: a backlog is cleared over a few ticks, never in one long transaction. */
const SWEEP_BATCH = 50;

/**
 * @param {{ store: { draftsOlderThan: (cutoff: Date, limit: number) => Promise<any[]> },
 *   spokenIn: (study: any) => Promise<boolean>,
 *   remove: (study: any) => Promise<unknown>,
 *   ttlMs?: number, now?: () => Date,
 *   report?: (code: string) => void,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown> | unknown }} dependencies
 */
export function createVcrDraftSweeper({ store, spokenIn, remove, ttlMs = VCR_DRAFT_TTL_MS, now = () => new Date(), report = () => {}, audit = () => {} }) {
  if (!store?.draftsOlderThan) throw new TypeError("The draft sweep needs the VCR store.");
  if (typeof spokenIn !== "function" || typeof remove !== "function") throw new TypeError("The draft sweep needs to read the run ledger and to remove a project.");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) throw new TypeError("A draft lives at least a minute.");
  const counts = { sweeps: 0, deleted: 0, kept: 0, failed: 0 };

  return {
    counts,

    /** One pass: consider old empty drafts; a safe-removal refusal counts as kept. @returns {Promise<{ deleted: number, kept: number, failed: number }>} */
    async sweep() {
      counts.sweeps += 1;
      const cutoff = new Date(now().getTime() - ttlMs);
      const drafts = await store.draftsOlderThan(cutoff, SWEEP_BATCH);
      let deleted = 0;
      let kept = 0;
      let failed = 0;
      for (const study of drafts) {
        let spoken = true;
        try {
          spoken = await spokenIn(study);
        } catch (error) {
          // A ledger that cannot be read is not evidence that nobody spoke.
          report(`vcr_draft_ledger_unreadable:${study.id}:${typeof error?.code === "string" ? error.code : "error"}`);
        }
        if (spoken) { kept += 1; continue; }
        try {
          if (await remove(study) === false) { kept += 1; continue; }
          deleted += 1;
          report(`vcr_draft_deleted:${study.id}`);
          await Promise.resolve(audit("vcr.draft.delete", "completed", { userId: study.userId, projectId: study.projectId, detail: study.id })).catch(() => null);
        } catch (error) {
          // The project is already gone, or the delete was refused: the next sweep looks again.
          failed += 1;
          report(`vcr_draft_delete_failed:${study.id}:${typeof error?.code === "string" ? error.code : "error"}`);
        }
      }
      counts.deleted += deleted;
      counts.kept += kept;
      counts.failed += failed;
      return { deleted, kept, failed };
    },
  };
}

/**
 * One conservative definition of a used draft, shared by visibility and expiry.
 * A candidate is never evidence of current emptiness; always read its study again.
 * @param {{store: any, projectUsed: (study: any) => Promise<boolean>}} dependencies
 */
export function createVcrDraftUsage({ store, projectUsed }) {
  return async (/** @type {any} */ candidate) => {
    try {
      const study = await store.studyById(candidate.id);
      if (!study || study.userId !== candidate.userId || study.projectId !== candidate.projectId) return true;
      if (study.status !== "draft" || String(study.question ?? "").trim()) return true;
      const name = String(study.name ?? "").trim();
      if (name && ![VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME].includes(name)) return true;
      if (typeof store.draftHasResearchContent !== "function" || typeof projectUsed !== "function") return true;
      if (await store.draftHasResearchContent(study.id)) return true;
      return await projectUsed(study) !== false;
    } catch {
      // Unavailable dependencies cannot prove that a person's work does not exist.
      return true;
    }
  };
}
