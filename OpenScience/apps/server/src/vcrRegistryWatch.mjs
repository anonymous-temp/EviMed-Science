/**
 * The registry watch (G15, owner decisions of 2026-11-04): a trial's record changes after a person has been judged against it, and until now nobody
 * noticed. Once an hour a bounded number of the trials a person holds a finished verdict about are read again, the one checked longest ago first, and a
 * trial whose record is no longer the one its verdicts were made of has those verdicts marked. The verdict stays; a read shows the mark and offers to
 * judge it again (`vcrMatchJudge.mjs`, `presentJudgment`).
 *
 * Hidden knowledge:
 *
 * - **The record is read the way a judgment reads it.** `judgmentTargets(...).trial` is the one path, so what counts as a change is exactly what changes
 *   the key of a judgment: the title, summary, eligibility text, conditions and interventions, hashed. A recruiting status that moves is not one, because
 *   a verdict does not rest on it. The same words read twice have the same hash, a ChiCTR page included (`vcrRegistryPages`: the cached words come back).
 * - **A mark is a label, never a refusal.** Nothing is deleted and nothing is withheld; a row is written over only if its column is empty or already
 *   carries this watch's mark (the store's rule), so a cause the erasure store wrote later stands. A frozen collection's trial is never read, because its
 *   text is the collection's, and a person who withdrew is untouched.
 * - **Failure is bounded and quiet.** Every read has a deadline. A trial that cannot be read is recorded as checked (so the trials behind it get their turn)
 *   and asked for again after `retryHours`, not after a week. Two failures from one registry in a tick leave the rest of that registry's trials for the next
 *   tick; the other registries go on. The tick as a whole has a budget of minutes, because a worker loop that runs past its lease reads as stalled.
 * - **Reads are one at a time.** A registry is a public service shared with everyone, and its client paces itself; running the batch in parallel would only
 *   trade the pacing for a queue. The batch is the bound.
 *
 * @module vcrRegistryWatch
 */

const HOURS = 3_600_000;
/** How long one tick may read before it leaves the rest for the next: the worker's lease is fifteen minutes. */
const TICK_BUDGET_MS = 10 * 60_000;
/** Reads of one registry that may fail in a tick before the rest of its trials wait for the next. */
const FAILURES_PER_REGISTRY = 2;

/** A read that ends at its deadline whatever the registry's client does with its signal. @template T @param {Promise<T>} work @param {number} ms */
function withDeadline(work, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The registry did not answer in time.'), { code: 'registry_watch_timeout' })), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** What the watch counts, for the operator's metric family (principle 15). */
export function createRegistryWatchCounters() {
  return { ticks: 0, checked: 0, changed: 0, marked: 0, cleared: 0, missing: 0, failed: 0, deferred: 0 };
}

/**
 * @param {{ judgments: any, targets: { trial: (input: any) => Promise<{ hash: string }> }, config?: Record<string, any>, report?: (code: string) => void,
 *   counters?: ReturnType<typeof createRegistryWatchCounters>, now?: () => Date }} deps
 */
export function createRegistryWatch({ judgments, targets, config = {}, report = () => {}, counters = createRegistryWatchCounters(), now = () => new Date() }) {
  const batch = Math.max(1, Math.min(200, Number(config.vcrRegistryWatchBatch ?? 20) || 20));
  const okHours = Math.max(1, Number(config.vcrRegistryWatchHours ?? 168) || 168);
  const retryHours = Math.max(1, Number(config.vcrRegistryWatchRetryHours ?? 6) || 6);
  const readTimeoutMs = Math.max(1_000, Number(config.vcrRegistryWatchReadTimeoutMs ?? 60_000) || 60_000);

  return {
    counters,
    /**
     * One tick. Answers counts only: how many trials were due, read, found changed, rows marked, and read failures.
     * @returns {Promise<{ due: number, checked: number, changed: number, marked: number, failed: number, deferred: number }>}
     */
    async tick() {
      counters.ticks += 1;
      const started = now();
      const due = await judgments.dueTargets({ okBefore: new Date(started.getTime() - okHours * HOURS), retryBefore: new Date(started.getTime() - retryHours * HOURS), limit: batch });
      /** @type {Map<string, Promise<{ hash: string } | { code: string }>>} the same trial held by two studies is read once */
      const reads = new Map();
      /** @type {Map<string, number>} */
      const failures = new Map();
      const sum = { due: due.length, checked: 0, changed: 0, marked: 0, failed: 0, deferred: 0 };
      for (const entry of due) {
        if (now().getTime() - started.getTime() > TICK_BUDGET_MS) { sum.deferred += 1; counters.deferred += 1; continue; }
        const registry = entry.registry;
        const at = now().toISOString();
        if (!registry) {
          // A row that never said which registry it came from cannot be read again; it is looked at again when the period is up, like any other.
          await judgments.recordCheck({ studyId: entry.studyId, targetId: entry.targetId, status: 'registry_unknown', at });
          continue;
        }
        if ((failures.get(registry) ?? 0) >= FAILURES_PER_REGISTRY) { sum.deferred += 1; counters.deferred += 1; continue; }
        const key = `${registry}\u0000${entry.targetId}`;
        let read = reads.get(key);
        if (!read) {
          read = withDeadline(Promise.resolve().then(() => targets.trial({ userId: entry.userId, registry, registryId: entry.targetId, signal: AbortSignal.timeout(readTimeoutMs) })), readTimeoutMs)
            .then((target) => ({ hash: String(target.hash) }), (error) => ({ code: String(error?.code ?? 'registry_unavailable') }));
          reads.set(key, read);
        }
        const outcome = await read;
        // Only a good read is shared: a failure for one account (a listing that needs its own key) is not another's.
        if ('code' in outcome) reads.delete(key);
        if ('code' in outcome) {
          // Not found is an answer (the record is gone from the registry; the verdicts stay as they were); anything else is the registry not answering.
          const missing = outcome.code === 'registry_not_found';
          await judgments.recordCheck({ studyId: entry.studyId, targetId: entry.targetId, status: outcome.code, at });
          if (missing) { counters.missing += 1; counters.checked += 1; sum.checked += 1; continue; }
          failures.set(registry, (failures.get(registry) ?? 0) + 1);
          sum.failed += 1; counters.failed += 1;
          if (failures.get(registry) === FAILURES_PER_REGISTRY) report(`registry_watch_${outcome.code}`);
          continue;
        }
        const { marked, cleared } = await judgments.markRegistryChanged({ studyId: entry.studyId, targetId: entry.targetId, hash: outcome.hash, at });
        await judgments.recordCheck({ studyId: entry.studyId, targetId: entry.targetId, hash: outcome.hash, status: 'ok', at });
        sum.checked += 1; counters.checked += 1;
        counters.marked += marked; counters.cleared += cleared;
        if (marked) { sum.changed += 1; sum.marked += marked; counters.changed += 1; }
      }
      return sum;
    },
  };
}
