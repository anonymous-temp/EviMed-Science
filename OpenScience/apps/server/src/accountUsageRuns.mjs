/**
 * The settings page's usage 明细 (2026-09-23 plan §5.9): one row per research
 * run of the month — its date, the conversation's title and what it cost —
 * newest first, and one 「其他」 sum for what no conversation can show.
 *
 * The ledger attributes a model call to a run by `run_id`, which is either the
 * run's own id or, for a bounded run, its dispatch id (`runUsageFrom`); both
 * name the same row here. Spend that no run is attributed to, spend of a run
 * the ledger of runs no longer lists, of a run the researcher deleted, and of
 * the platform's own background runs (a source being understood, a method
 * being distilled) is summed into `other`, so the rows and `other` together
 * are the month — nothing is dropped and nothing is counted twice.
 *
 * Tokens travel with each row for an operator; a researcher's view shows the
 * money only.
 *
 * @module accountUsageRuns
 */

/** @param {number} value */
function money(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

/** @param {any} run @returns {string | null} */
function titleOf(run) {
  for (const value of [run?.title, run?.question]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return null;
}

/**
 * @param {ReadonlyArray<{ runId: string | null, calls: number, cost: number, inputTokens?: number, outputTokens?: number, firstAt?: string | null }>} groups
 *   the ledger's per-run groups (`UsageLedger.runsSince`)
 * @param {ReadonlyArray<{ run: any, projectId: string, internal?: boolean }>} runs
 *   every run of the account's projects, with whether it is the platform's own
 * @returns {{ items: Array<{ runId: string, projectId: string, title: string | null, at: string | null, calls: number, cost: number, inputTokens: number, outputTokens: number }>, other: { calls: number, cost: number } }}
 */
export function accountUsageRuns(groups, runs) {
  /** @type {Map<string, { run: any, projectId: string, internal: boolean }>} */
  const byKey = new Map();
  for (const entry of runs) {
    const run = entry?.run;
    if (!run?.id) continue;
    for (const key of [run.id, run.dispatchId]) {
      if (typeof key === "string" && key && !byKey.has(key)) {
        byKey.set(key, { run, projectId: entry.projectId, internal: entry.internal === true });
      }
    }
  }
  /** @type {Map<string, { runId: string, projectId: string, title: string | null, at: string | null, calls: number, cost: number, inputTokens: number, outputTokens: number }>} */
  const items = new Map();
  const other = { calls: 0, cost: 0 };
  for (const group of groups) {
    const found = group.runId ? byKey.get(group.runId) : undefined;
    if (!found || found.internal || found.run.deleted) {
      other.calls += Number(group.calls) || 0;
      other.cost += Number(group.cost) || 0;
      continue;
    }
    const id = String(found.run.id);
    const item = items.get(id) ?? {
      runId: id,
      projectId: found.projectId,
      title: titleOf(found.run),
      at: found.run.startedAt ?? found.run.createdAt ?? group.firstAt ?? null,
      calls: 0, cost: 0, inputTokens: 0, outputTokens: 0,
    };
    item.calls += Number(group.calls) || 0;
    item.cost += Number(group.cost) || 0;
    item.inputTokens += Number(group.inputTokens) || 0;
    item.outputTokens += Number(group.outputTokens) || 0;
    items.set(id, item);
  }
  return {
    items: [...items.values()]
      // A run whose every call ended unsettled has no money to show; the page
      // says how many calls went unreported in its own line.
      .filter((item) => item.calls > 0 || item.cost > 0)
      .map((item) => ({ ...item, cost: money(item.cost) }))
      .sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? ""))),
    other: { calls: other.calls, cost: money(other.cost) },
  };
}
