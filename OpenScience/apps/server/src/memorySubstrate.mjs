import {
  memoryUri,
  openVikingUserId,
  parseMemoryUri,
  projectMemoryUri,
  recallTargets,
} from "./openVikingClient.mjs";
import { recallContent, searchTokens, selectWithinBudget } from "./memoryRecallPolicy.mjs";
import { HttpError } from "./security.mjs";
import { TERMINAL_INDEX_FAILURES } from "./memoryIndexWorker.mjs";

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

/** Which provider a configuration selects, with an unknown name read as the
 *  builtin one.
 *
 *  Exported because two components have to agree on the answer and are built
 *  apart: the substrate that reads the index, and the store that enqueues the
 *  writes into it. A store that enqueued on a `builtin` deployment would queue
 *  work no worker claims; one that did not enqueue on an `openviking` one would
 *  leave the index empty, which is the same defect seen from the other side. */
export function selectedMemoryIndexProvider(config) {
  const requested = String(config?.memoryIndexProvider ?? "builtin");
  return MEMORY_INDEX_PROVIDERS.includes(requested) ? requested : "builtin";
}

/** How many candidates to ask the index for, relative to what the budget will
 *  admit. Over-fetching costs one larger response and gives the budget room to
 *  drop a hit whose record has been deleted, is sensitive, or has expired,
 *  without the recall coming back short. */
const CANDIDATE_OVERFETCH = 3;

/** How long one rebuild write may wait for the index to finish embedding it.
 *  The same bound the capsule index uses, for the same reason: an upstream that
 *  has not answered in five seconds is not about to. */
const WRITE_WAIT_SECONDS = 5;

/** The usual constant from the reciprocal-rank-fusion literature: large enough
 *  that the first few ranks sit close together, small enough that a long tail
 *  still decays. */
const RANK_FUSION_K = 60;

/** Merge lists that were scored on different scales.
 *
 *  The index answers with cosine similarity, where a good hit is around 0.6 and
 *  1.0 is unreachable. The note matcher answers with a count of matched query
 *  terms, where one matched word is 1.0. Sorted together on those numbers, a
 *  single note mentioning one word of the question displaces every structured
 *  memory the index found — silently, and only on the provider this stack now
 *  selects by default. Fusing by rank removes the comparison instead of
 *  calibrating it: each list is ordered on its own terms, and the best note and
 *  the best record then compete as equals. */
function fuseByRank(lists) {
  const byRecency = (left, right) =>
    String(right.memo.updatedAt ?? "").localeCompare(String(left.memo.updatedAt ?? ""));
  const fused = [];
  for (const list of lists) {
    [...list]
      .sort((left, right) => right.score - left.score || byRecency(left, right))
      .forEach((row, index) => fused.push({ ...row, score: 1 / (RANK_FUSION_K + index + 1) }));
  }
  return fused.sort((left, right) => right.score - left.score || byRecency(left, right));
}

/** The one leaf a record occupies.
 *
 *  A record's identity is its canonical key — scope, scope id, kind, key — and
 *  an update never moves a row between keys, so the path a record was written
 *  to is the path it will be removed from. There is no earlier path to chase. */
/** The three subtrees a research rebuild owns.
 *
 *  Not `memories/evimed` itself: the capsule index lives under it, has its own
 *  publication ledger and its own rebuild, and a research rebuild that removed
 *  it would silently un-publish every approved fact. */
function researchRoots(userId) {
  const root = `viking://user/${openVikingUserId(userId)}/memories/evimed`;
  return [`${root}/user`, `${root}/project`, `${root}/session`];
}

function recordUri(userId, record) {
  return memoryUri(userId, {
    scope: record.scope, scopeId: record.scopeId, kind: record.kind, recordId: record.id,
  });
}

/** What the index may hold a copy of, and the text of that copy.
 *
 *  One function because the incremental write and the rebuild have to agree:
 *  a record either has a derived copy or does not, and two answers to that
 *  would mean the state of the index depended on which path last touched it. */
function publishableContent(record, now) {
  if (!record || record.status !== "active" || record.sensitive) return "";
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return "";
  return recallContent(record) || "";
}

export class MemorySubstrate {
  /**
   * @param {any} config
   * @param {{ store?: any, openViking?: any, rerank?: any, jobs?: any }} dependencies
   */
  constructor(config, { store = null, openViking = null, rerank = null, jobs = null } = {}) {
    this.provider = selectedMemoryIndexProvider(config);
    this.store = store;
    this.openViking = openViking;
    this.rerank = rerank;
    this.jobs = jobs;
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

    const ranked = fuseByRank([structured, notes]);
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
   * Bring one record's derived copy up to date. The incremental half of the index.
   *
   * `rebuild` converges a whole account and is what an operator runs; this is
   * what keeps the index true between those runs. Without it a deployment that
   * selects this provider would index a record only when somebody remembered to
   * run that command, and every memory extracted afterwards would be invisible
   * to recall — which reads to a researcher as the model having forgotten,
   * not as an index being behind.
   *
   * The job names the record; the record's current row decides what happens to
   * the leaf. A row that is gone, archived, superseded, sensitive, expired or
   * empty is removed rather than written, so "stop remembering this" reaches
   * the copy as well as the original.
   *
   * @param {{userId:string,id:string,leaseToken:string,payload:any}} job
   */
  async indexRecord(job) {
    if (!this.jobs) {
      throw new HttpError(503, "memory_index_queue_missing", "Indexing one record requires the product job queue.");
    }
    const payload = job?.payload ?? {};
    const recordId = typeof payload.recordId === "string" ? payload.recordId : "";
    const descriptor = {
      scope: payload.scope, scopeId: payload.scopeId ?? "", kind: payload.memoryKind, recordId,
    };
    if (!recordId || typeof descriptor.scope !== "string" || typeof descriptor.kind !== "string") {
      throw new HttpError(400, "memory_index_job_invalid", "Memory record index job payload is invalid.");
    }
    // The job outlived the provider that enqueued it. There is nothing to
    // write, and retrying would only burn attempts against a component this
    // deployment has since switched off.
    if (!this.active) {
      return this.jobs.finish(job.userId, job.id, job.leaseToken, { status: "index_disabled", recordId });
    }
    const record = await this.store.getRecord(job.userId, recordId).catch((error) => {
      if (error?.code === "memory_not_found") return null;
      throw error;
    });
    const content = publishableContent(record, Date.now());
    if (!content) {
      // Addressed from the job, not from the row: when the row is gone it can
      // no longer say where its copy was written. The path is stable, so the
      // job's copy of it is the path the write used.
      await this.openViking.remove(job.userId, memoryUri(job.userId, descriptor), { recursive: false });
      return this.jobs.finish(job.userId, job.id, job.leaseToken,
        { status: record ? "withheld" : "removed", recordId });
    }
    // `wait: true` for the reason the rebuild waits: a write that returns
    // before the vector exists reports work that has not finished, and here
    // that report is what marks the job done.
    await this.openViking.write(job.userId, recordUri(job.userId, record), content,
      { wait: true, timeoutSeconds: WRITE_WAIT_SECONDS });
    return this.jobs.finish(job.userId, job.id, job.leaseToken,
      { status: "indexed", recordId, version: record.version });
  }

  /**
   * Rewrite one user's whole index from the store.
   *
   * The index holds nothing of its own, so this is always safe to run and
   * always converges. It is how a deployment adopts a provider, and how it
   * recovers from any drift without a reconciliation ledger to get wrong.
   *
   * Convergence is why one record's write failing does not end the rebuild.
   * With `wait: true` a slow embedding is answered by a 504 after the content
   * was written, so the likeliest failure here is also the least serious one —
   * and abandoning the remaining records because of it would leave a user whose
   * index is mostly empty where a second run would have finished the job.
   */
  async rebuild(userId) {
    if (!this.active) return { written: 0, skipped: 0, failed: 0, removed: 0 };
    const records = await this.store.listAllRecords(userId);
    // Empty first, then republish. Writing over what is there would make this
    // command converge only downwards: a copy whose record was deleted while
    // the index was unreachable has no event left to remove it and no row to
    // find it from, and one stranded by an expiry never had an event at all.
    // Starting from nothing is the only way a rebuild can be the answer to
    // "the index and the store disagree" rather than half of it.
    let removed = 0;
    for (const root of researchRoots(userId)) {
      if (await this.openViking.remove(userId, root, { recursive: true })) removed += 1;
    }
    const now = Date.now();
    let written = 0;
    let skipped = 0;
    let failed = 0;
    /** @type {string|null} */
    let failureCode = null;
    for (const record of records) {
      const content = publishableContent(record, now);
      if (!content) {
        skipped += 1;
        continue;
      }
      try {
        // `wait: true`: the caller of a rebuild is an operator or a script that
        // reports having rebuilt the index, and a write that returns before the
        // vector exists makes that report false for a while nobody can measure.
        await this.openViking.write(userId, recordUri(userId, record), content,
          { wait: true, timeoutSeconds: WRITE_WAIT_SECONDS });
        written += 1;
      } catch (error) {
        failed += 1;
        failureCode = typeof error?.code === "string" ? error.code : "memory_index_unavailable";
      }
    }
    // The count and the last code go back to the caller rather than into state:
    // a rebuild has exactly one caller, and it is the thing that reports.
    return { written, skipped, failed, removed, ...(failureCode ? { code: failureCode } : {}) };
  }

  /**
   * Re-arm index jobs that failed for a reason that may have passed.
   *
   * Ten attempts spread over about five minutes of backoff, which an ordinary
   * restart of the index outruns. Without this, a job that lost that race stays
   * `failed` for ever and its record's copy is wrong until somebody runs the
   * rebuild — and for a *deleted* record, "wrong" means the index still holds
   * the text the researcher asked to be forgotten. The capsule half has had
   * this since it was written; the record half now has it too.
   *
   * Only the codes the retry policy calls terminal are left alone: a payload
   * that could not name a path will not name one on the tenth retry either.
   */
  async reconcileRecords(limit = 25) {
    if (!this.active || !this.jobs) return 0;
    return this.jobs.rearm("memory-record-index", { limit, terminalCodes: TERMINAL_INDEX_FAILURES });
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
