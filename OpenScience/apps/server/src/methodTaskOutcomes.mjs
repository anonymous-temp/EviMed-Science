// The run ledger keeps every card, observed body read and terminal result. Only
// task-level results with an attributable exposure enter the priority decision.
const taskFailures = new Set(["deliverable_rejected", "specialist_required_output_missing", "specialist_required_output_stale"]);

/** @param {any} run @param {any} observed @param {any[]} methods */
export function methodTaskOutcomes(run, observed, methods) {
  if (!observed.answered || run.automated || run.terminalConflict || !Number.isFinite(Date.parse(run.finishedAt))) return [];
  const failed = run.status === "failed" && taskFailures.has(run.errorCode);
  if (!failed && (run.status !== "succeeded" || run.verification === "unverified")) return [];
  const loaded = observed.methodsLoaded;
  return methods.flatMap(method => {
    if (!method.contentDigest || method.id.startsWith("official:")) return [];
    const card = loaded.find(entry => entry.name === method.name && entry.digest === method.digest);
    if (!card) return [];
    const opened = observed.methodsInvoked.some(entry => entry.name === method.name && entry.digest === method.digest);
    if (!opened && loaded.length !== 1) return [];
    return [{ methodId: method.id, digest: method.contentDigest, sample: { runId: run.id,
      at: run.finishedAt, startedAt: run.startedAt ?? run.createdAt, opened, failed } }];
  });
}

/** Recompute in completion order so concurrent terminal callbacks and retries
 * agree. Two separate streaks' worth of runs are required to retire a body.
 * @param {any} payload @param {any} sample @param {number} threshold */
export function taskOutcomeWindow(payload, sample, threshold) {
  const prior = payload.taskOutcomes;
  const rows = prior?.digest === payload.contentDigest ? prior.samples : [];
  const previous = rows.find(row => row.runId === sample.runId);
  // A researcher can correct a task after the runtime reported successful completion.
  if (previous && (previous.failed || !sample.corrected)) return null;
  const since = payload.taskOutcomesSince ?? payload.bodyUpdatedAt;
  if (since && !(Date.parse(sample.startedAt) >= Date.parse(since))) return null;
  const samples = [...rows.filter(row => row !== previous), sample].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.runId.localeCompare(b.runId)).slice(0, 2 * threshold);
  if (!samples.includes(sample)) return null;
  const firstSuccess = samples.findIndex(row => !row.failed);
  const streak = firstSuccess < 0 ? samples.length : firstSuccess;
  return { digest: payload.contentDigest, samples, demoted: streak >= threshold, retire: streak >= threshold * 2 };
}
