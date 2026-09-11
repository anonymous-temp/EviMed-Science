import {
  memoryUri,
  openVikingUserId,
  parseMemoryUri,
  projectMemoryUri,
  recallTargets,
} from "./openVikingClient.mjs";
import { recallContent, searchTokens, selectWithinBudget } from "./memoryRecallPolicy.mjs";

/**
 * The narrow port in front of whatever ranks a recall.
 *
 * Two things are deliberately not behind it. The authoritative record stays in
 * the control-plane database: an index provider that also owned the record
 * would have to reimplement the `expectedVersion` compare-and-swap that keeps
 * two concurrent edits from silently losing one, and OpenViking's `write` has
 * no such mode. And the budget stays in `memoryRecallPolicy.mjs`: which
 * memories reach the prompt is product policy that must not vary by provider.
 *
 * So a provider answers exactly one question — *which* records are relevant to
 * this query, in what order — and the answer is then hydrated from the store.
 * An index that has gone stale, or that still holds a record the user deleted,
 * therefore cannot put wrong text in front of the model: the worst it can do
 * is nominate a record that no longer exists, which is dropped.
 */

/** `builtin` ranks by term overlap inside the research-memory store, which is
 *  what every deployment has done so far. `openviking` delegates ranking to the
 *  OpenViking context database's hierarchical retrieval. */
export const MEMORY_INDEX_PROVIDERS = Object.freeze(["builtin", "openviking"]);

/** How many candidates to ask the index for, relative to what the budget will
 *  admit. Over-fetching costs one larger response and gives the budget room to
 *  drop a hit whose record has been deleted, is sensitive, or has expired,
 *  without the recall coming back short. */
const CANDIDATE_OVERFETCH = 3;

/** How long one rebuild write may wait for the index to finish embedding it.
 *  The same bound the capsule index uses, for the same reason: an upstream that
 *  has not answered in five seconds is not about to. */
const WRITE_WAIT_SECONDS = 5;

export class MemorySubstrate {
  /**
   * @param {any} config
   * @param {{ store?: any, openViking?: any, rerank?: any }} dependencies
   */
  constructor(config, { store = null, openViking = null, rerank = null } = {}) {
    const requested = String(config.memoryIndexProvider ?? "builtin");
    this.provider = MEMORY_INDEX_PROVIDERS.includes(requested) ? requested : "builtin";
    this.store = store;
    this.openViking = openViking;
    this.rerank = rerank;
    this.contextLimit = Math.max(0, Math.min(20, Number(config.memoryContextLimit ?? 8)));
    this.contextMaxChars = Math.max(0, Math.min(100_000, Number(config.memoryContextMaxChars ?? 20_000)));
    // A derived index is an optimisation. When it is down, a run that would
    // have recalled eight memories should recall the eight the term matcher
    // finds, not fail — the alternative is an outage in answering caused by a
    // component that holds no original data. An operator who would rather see
    // the failure sets this.
    this.strict = Boolean(config.memoryIndexStrict);
    this.lastError = null;
  }

  /** True when the selected provider can actually be asked. */
  get active() {
    return this.provider === "openviking" && Boolean(this.openViking?.configured);
  }

  async status() {
    if (this.provider === "builtin") return { provider: "builtin", configured: true, connected: true, code: null };
    if (!this.openViking) return { provider: this.provider, configured: false, connected: false, code: "memory_index_client_missing" };
    return { provider: this.provider, ...(await this.openViking.status()) };
  }

  /**
   * The memories this question should see, already inside the prompt budget.
   *
   * @param {string} userId
   * @param {string} query
   * @param {{ projectId?: string|null, sessionId?: string|null }} scope
   */
  async recall(userId, query, { projectId = null, sessionId = null } = {}) {
    if (!this.active) return this.store.relevant(userId, query, { projectId, sessionId });
    try {
      return await this.#rankedRecall(userId, query, { projectId, sessionId });
    } catch (error) {
      this.lastError = error?.code ?? "memory_index_unavailable";
      if (this.strict) throw error;
      // Fall back rather than fail: the term matcher needs no index and reads
      // the same authoritative records.
      return this.store.relevant(userId, query, { projectId, sessionId });
    }
  }

  async #rankedRecall(userId, query, { projectId, sessionId }) {
    if (this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const hits = await this.openViking.find(userId, query, {
      targets: recallTargets(userId, { projectId, sessionId }),
      limit: this.contextLimit * CANDIDATE_OVERFETCH,
      peerId: projectId,
    });

    const nominated = [];
    const seen = new Set();
    for (const hit of hits) {
      const parsed = parseMemoryUri(hit.uri);
      // A hit we did not write — the server's own extraction, or a layout from
      // an older release. It names no record we can hydrate, so it is not a
      // candidate rather than a guess.
      if (!parsed || seen.has(parsed.recordId)) continue;
      seen.add(parsed.recordId);
      nominated.push({ recordId: parsed.recordId, score: hit.score });
    }

    // Hydrate from the store. A nomination is a claim about relevance, not
    // about content: the record read here is the one the user could edit or
    // delete a moment ago, so a stale index cannot show stale text.
    const now = Date.now();
    const records = (await Promise.all(
      nominated.map(async ({ recordId, score }) => {
        try {
          const record = await this.store.getRecord(userId, recordId);
          return { record, score };
        } catch {
          return null;
        }
      }),
    ))
      .filter(Boolean)
      .filter(({ record }) => record.status === "active")
      .filter(({ record }) => !record.sensitive)
      .filter(({ record }) => !record.expiresAt || Date.parse(record.expiresAt) > now)
      // The index is asked only for subtrees this caller may read, but the
      // check is repeated against the record itself: a scope is a permission,
      // and a permission proved by the thing being read beats one proved by
      // the path it was found at.
      .filter(({ record }) => record.scope === "user"
        || (record.scope === "project" && record.scopeId === projectId)
        || (record.scope === "session" && record.scopeId === sessionId));

    const structured = records.map(({ record, score }) => ({
      memo: {
        id: `record:${record.id}`,
        content: recallContent(record),
        updatedAt: record.updatedAt,
        memoryType: "structured",
        kind: record.kind,
        scope: record.scope,
        confidence: record.confidence,
        importance: record.importance,
      },
      score,
    })).filter((row) => row.memo.content);

    // Notes stay on the term matcher. They are user-authored, few, and already
    // found by the words the user chose; putting them through an embedding
    // would change behaviour that nobody complained about, for no measured
    // gain. Records are the machine-extracted many, and the reason for an index.
    const notes = await this.#matchingNotes(userId, query);

    const ranked = [...structured, ...notes].sort((left, right) =>
      right.score - left.score || String(right.memo.updatedAt).localeCompare(String(left.memo.updatedAt)));
    return selectWithinBudget(await this.#reranked(query, ranked), {
      contextLimit: this.contextLimit,
      contextMaxChars: this.contextMaxChars,
    });
  }

  /** Reorder the hydrated candidates, if a reranker is configured.
   *
   * Placed after hydration and before the budget on purpose. After hydration,
   * because the text scored here is the record as it exists now rather than the
   * copy the index holds. Before the budget, because the budget's job is to cut
   * the tail off an order, and cutting first would throw away exactly the
   * candidates a reranker exists to promote.
   *
   * @param {string} query @param {{memo:any,score:number}[]} candidates
   */
  async #reranked(query, candidates) {
    if (!this.rerank?.configured || candidates.length < 2) return candidates;
    try {
      const order = await this.rerank.order(query, candidates.map((row) => String(row.memo.content ?? "")));
      if (!Array.isArray(order) || order.length !== candidates.length) return candidates;
      const reordered = [];
      const used = new Set();
      for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= candidates.length || used.has(index)) return candidates;
        used.add(index);
        reordered.push(candidates[index]);
      }
      return reordered;
    } catch {
      // The vector order is a complete answer; a reranker that throws must not
      // turn a working recall into a failed one.
      return candidates;
    }
  }

  async #matchingNotes(userId, query) {
    const terms = searchTokens(query);
    if (terms.length === 0) return [];
    const notes = await this.store.list(userId, { pageSize: 100 });
    return notes
      .map((memo) => {
        const haystack = memo.content.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        return { memo: { ...memo, memoryType: "manual" }, score: matches + (memo.pinned ? 0.25 : 0) };
      })
      .filter((row) => row.score > 0);
  }

  /**
   * Rewrite one user's whole index from the store.
   *
   * The index holds nothing of its own, so this is always safe to run and
   * always converges. It is how a deployment adopts a provider, and how it
   * recovers from any drift without a reconciliation ledger to get wrong.
   */
  async rebuild(userId) {
    if (!this.active) return { written: 0, skipped: 0 };
    const records = await this.store.listAllRecords(userId);
    const now = Date.now();
    let written = 0;
    let skipped = 0;
    for (const record of records) {
      const publishable = record.status === "active"
        && !record.sensitive
        && (!record.expiresAt || Date.parse(record.expiresAt) > now);
      if (!publishable) {
        skipped += 1;
        continue;
      }
      const content = recallContent(record);
      if (!content) {
        skipped += 1;
        continue;
      }
      // `wait: true`: the caller of a rebuild is an operator or a script that
      // reports having rebuilt the index, and a write that returns before the
      // vector exists makes that report false for a while nobody can measure.
      await this.openViking.write(userId, memoryUri(userId, {
        scope: record.scope,
        scopeId: record.scopeId,
        kind: record.kind,
        recordId: record.id,
      }), content, { wait: true, timeoutSeconds: WRITE_WAIT_SECONDS });
      written += 1;
    }
    return { written, skipped };
  }

  /**
   * Forget a project's derived copies.
   *
   * Wired to the same route that deletes a project's memory, and not
   * best-effort: an index that outlives the record it was built from is a copy
   * of deleted data. When the delete cannot be confirmed the caller hears
   * about it, because "we deleted it" has to be true.
   */
  async forgetProject(userId, projectId) {
    if (!this.active) return false;
    return this.openViking.remove(userId, projectMemoryUri(userId, projectId), { recursive: true });
  }

  /** Forget everything derived from one user, for account deletion and purge. */
  async forgetUser(userId) {
    if (!this.active) return false;
    return this.openViking.remove(userId, `viking://user/${openVikingUserId(userId)}/memories/evimed`, {
      recursive: true,
    });
  }
}
