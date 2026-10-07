import { cleanMethodDisplay } from "@evimed/domain";
import { methodStepsOf } from "./learningService.mjs";
import { HttpError } from "./security.mjs";

/**
 * The capability handbooks an account holds, as a researcher reads and undoes
 * them: the lessons the platform learned for one research tool on this
 * account's work (`HandbookConsolidation` writes them, one document per tool
 * and name).
 *
 * Hidden knowledge: this is the handbook half of what 「做法」 is on the memory
 * page, and it exists because a handbook had no HTTP surface at all — the page
 * could count them and list the six newest, but nobody could read one whole,
 * stop one or go back to the version before. The rules it holds are the ones a
 * learned method already follows, so the two read alike on the page:
 *
 *  - Stopping is a write that keeps the record (`status: "retired"`), never a
 *    deletion. Every reader of handbooks (`prepareCapabilityHandbooks`, the
 *    summary, the evolution coupling) asks for `status: "active"`, so a stopped
 *    handbook is simply no longer used, and restoring it is the rollback to the
 *    state saved before it was stopped.
 *  - 「回到上一版」 saves an earlier body forward by compare-and-swap and never
 *    deletes history. Use counts belong to the version they were counted on, so
 *    they do not cross a rollback.
 *  - What a researcher reads is the title and sentence the learning loop wrote
 *    for them (`display`) and the steps in their language (`displaySteps`, kept
 *    on the candidate the handbook was applied from); the SKILL.md body is
 *    written for the model and is the fallback, not the first choice.
 *
 * It does not evaluate anything. A handbook's `verification` is the loop's own
 * bookkeeping and no reader of this class shows it.
 */

export const CAPABILITY_HANDBOOK_RECORD_TYPE = "capability-handbook";

/** How many saved revisions one history read walks, in pages of a hundred (the same bound a learned method's has). */
const HISTORY_PAGES = 20;

export class HandbookLibrary {
  /** @param {{learning: any, now?: () => Date}} input */
  constructor({ learning, now = () => new Date() }) {
    this.learning = learning;
    this.documents = learning.documents;
    this.now = now;
  }

  /**
   * One page of the account's handbooks, newest first. `status` is `active`
   * (in use) or `retired` (stopped by the researcher).
   * @param {string} userId @param {{status?: string, limit?: number, cursor?: string|null}} [options]
   */
  async list(userId, { status = "active", limit = 50, cursor = null } = {}) {
    if (!["active", "retired"].includes(status)) throw new HttpError(400, "handbook_status_invalid", "Handbook status must be active or retired.");
    return this.documents.list(userId, "method", {
      filter: { recordType: CAPABILITY_HANDBOOK_RECORD_TYPE, status }, limit, cursor,
    });
  }

  /** @param {string} userId @param {string} id */
  async get(userId, id) {
    const document = await this.documents.get(userId, "method", id);
    if (document?.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE) throw new HttpError(404, "handbook_unavailable", "The handbook is unavailable.");
    return document;
  }

  /**
   * The steps a researcher reads for the body a handbook holds now: its own
   * rendering when it carries one, otherwise the one kept on the candidate it
   * was applied from — when that rendering is of this very body. Null when
   * there is none; the page then shows the body.
   * @param {string} userId @param {any} document
   */
  async stepsOf(userId, document) {
    const own = methodStepsOf(document.payload);
    if (own) return own;
    const candidateId = document.payload?.source?.candidateId;
    if (typeof candidateId !== "string" || !candidateId) return null;
    const candidate = await this.documents.get(userId, "method", candidateId).catch(() => null);
    return candidate?.payload?.contentDigest === document.payload?.contentDigest ? methodStepsOf(candidate.payload) : null;
  }

  /**
   * Every saved revision, newest first, paged to the end under a bound.
   * @param {string} userId @param {string} id @returns {Promise<any[]>}
   */
  async #saved(userId, id) {
    /** @type {any[]} */
    const saved = [];
    /** @type {number | null} */
    let before = null;
    for (let page = 0; page < HISTORY_PAGES; page += 1) {
      const result = await this.documents.history(userId, "method", id, { limit: 100, ...(before ? { beforeRevision: before } : {}) });
      const items = Array.isArray(result) ? result : result?.items ?? [];
      saved.push(...items);
      if (items.length < 100) break;
      before = items.at(-1).revision;
    }
    return saved.sort((left, right) => right.revision - left.revision);
  }

  /**
   * 「以前的版本」: the bodies the handbook has held, newest first, each with
   * what a researcher needs to read it — never a counter write or a status
   * change of the same text. `revision` is the first save of that body, the
   * number 「回到这一版」 names.
   * @param {string} userId @param {string} id
   */
  async history(userId, id) {
    const current = await this.get(userId, id);
    const saved = (await this.#saved(userId, id)).filter((entry) => entry.payload?.recordType === CAPABILITY_HANDBOOK_RECORD_TYPE && !entry.deletedAt)
      .sort((left, right) => left.revision - right.revision);
    /** @type {any[]} */
    const versions = [];
    let previous = "";
    for (const entry of saved) {
      const digest = String(entry.payload?.contentDigest ?? "");
      if (!digest || digest === previous) continue;
      previous = digest;
      const steps = methodStepsOf(entry.payload);
      versions.push({
        version: versions.length + 1,
        revision: entry.revision,
        contentDigest: digest,
        at: entry.payload?.appliedAt ?? entry.recordedAt ?? null,
        title: cleanMethodDisplay(entry.payload?.display)?.title ?? null,
        summary: cleanMethodDisplay(entry.payload?.display)?.summary ?? null,
        whenToUse: String(entry.payload?.frontmatter?.whenToUse ?? ""),
        steps,
        // The model's text only when there is no rendering of the body: a version is read, not diffed.
        ...(steps ? {} : { body: String(entry.payload?.body ?? "") }),
        current: false,
      });
    }
    const last = versions.at(-1);
    if (last && last.contentDigest === current.payload.contentDigest) last.current = true;
    return versions.reverse();
  }

  /**
   * 「不再使用」. Stopping is always allowed and always undone by restoring.
   * @param {string} userId @param {string} id @param {{expectedRevision: number, reason?: string}} input
   */
  async retire(userId, id, { expectedRevision, reason }) {
    const current = await this.get(userId, id);
    const at = this.now().toISOString();
    await this.documents.put(userId, "method", id, {
      ...current.payload, status: "retired", ...(reason ? { statusReason: String(reason).slice(0, 500) } : {}), statusChangedAt: at,
    }, { expectedRevision });
    return this.get(userId, id);
  }

  /**
   * Restore a saved body forward by compare-and-swap. Observations belong to a
   * version and never cross the restore. For a stopped handbook the target is
   * the newest saved state that was not stopped: restoring it is the undo of
   * 「不再使用」.
   * @param {string} userId @param {string} id @param {{expectedRevision: number, targetRevision: number}} input
   */
  async rollback(userId, id, { expectedRevision, targetRevision }) {
    const current = await this.documents.get(userId, "method", id);
    if (current?.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE) throw new HttpError(404, "handbook_unavailable", "The handbook is unavailable.");
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1 || targetRevision >= current.revision) {
      throw new HttpError(404, "handbook_revision_unavailable", "That handbook revision is unavailable.");
    }
    const stopped = current.payload.status === "retired";
    const candidates = await this.documents.history(userId, "method", id, { beforeRevision: targetRevision + 1, limit: stopped ? 100 : 1 });
    const saved = (Array.isArray(candidates) ? candidates : candidates?.items ?? [])
      .find((entry) => !entry.deletedAt && (!stopped || entry.payload?.status !== "retired"));
    if (!saved || saved.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE
      || saved.payload.capabilityId !== current.payload.capabilityId) throw new HttpError(404, "handbook_revision_unavailable", "That handbook revision is unavailable.");
    await this.learning.validateHandbook(userId, saved.payload);
    return this.documents.put(userId, "method", id, { ...saved.payload, status: "active", version: Number(current.payload.version ?? 1) + 1,
      verification: "unmeasured", evaluation: null, observations: [], previousRevision: current.revision,
      restoredFromRevision: saved.revision, appliedAt: this.now().toISOString(),
    }, { expectedRevision });
  }
}
