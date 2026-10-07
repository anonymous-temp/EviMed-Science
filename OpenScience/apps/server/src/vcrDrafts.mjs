/**
 * The sweep of 「虚拟临床研究」 drafts: a study nobody ever spoke to is deleted an
 * hour after it was made.
 *
 * Hidden knowledge:
 *
 * - **Why drafts exist at all.** 「新建研究」 opens a conversation, and a
 *   conversation needs a project and a runtime before its first word can be
 *   typed — so the study (a row beside the project) is made at once, as a
 *   `draft`. It stays out of the list, the sidebar and the orchestrator's walk
 *   until its first definition names it (`VcrStore.saveDefinition`). Everyone who
 *   clicked 「新建研究」 and closed the tab leaves one behind; this is what
 *   removes them, so the account never accumulates 「未命名研究」 rows.
 * - **Spoken in is the control plane's ledger, not this schema's.** The user's
 *   message is a run in the project's run ledger (`agentRuns.dispatch`, the chat
 *   route), so a project with any run has been spoken in, and its draft is kept
 *   whatever its age: a person may be mid-thought, or the definition write may
 *   be a minute away. The sweep errs toward keeping — a ledger it cannot read
 *   keeps the draft — because deleting a study someone has typed into loses
 *   their conversation, and keeping an empty one costs a row.
 * - **A deletion is the project's.** The study's row, the project, the
 *   conversation's metadata and the files go in the one transaction a project
 *   deletion already is (`remove`, the same hook a failed 「新建研究」 uses), so
 *   a draft cannot outlive its project or the project its draft.
 * - **Idempotent and logged.** A draft already gone is not an error; a second
 *   sweep over the same rows does nothing. Every deletion is counted and
 *   reported with its study id, never its name.
 *
 * @module vcrDrafts
 */

/** How long a draft lives with nobody speaking in it. */
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

    /** One pass: delete the drafts past their hour in which nobody spoke. @returns {Promise<{ deleted: number, kept: number, failed: number }>} */
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
          await remove(study);
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
