/** Deliverable identifiers independently witnessed in a run's own ledger. */
function witnessedIds(run) {
  const proof = run?.nativeWorkflow;
  if (!proof) return new Set((run?.deliverables ?? []).map((item) => item?.id).filter(validId));
  const submissions = Array.isArray(proof.submissions) ? proof.submissions : [];
  const delegated = new Set(Array.isArray(proof.delegates) ? proof.delegates : []);
  const invoked = new Set([...submissions.map((item) => item?.id), ...delegated]);
  const items = Array.isArray(proof.plan?.items) ? proof.plan.items : [];
  const ids = [...(Array.isArray(proof.writtenPlanIds) ? proof.writtenPlanIds : []),
    ...items.filter((item) => proof.plan?.written || invoked.has(item.id)).map((item) => item.id)];
  for (const item of submissions) if (item?.accepted) ids.push(item.id);
  return new Set(ids.filter(validId));
}

/** @param {unknown} id */
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !/[\\/]/.test(id);
}

/** @param {any} current @param {readonly any[]} peers @returns {any[]} */
export function overlappingRuns(current, peers) {
  const start = Date.parse(String(current?.startedAt ?? ''));
  if (!Number.isFinite(start)) return [];
  const end = Date.parse(String(current?.finishedAt ?? ''));
  return peers.filter((peer) => {
    if (peer.id === current.id) return false;
    const otherStart = Date.parse(String(peer.startedAt ?? ''));
    const otherEnd = Date.parse(String(peer.finishedAt ?? ''));
    return Number.isFinite(otherStart) && (!Number.isFinite(end) || otherStart <= end)
      && (!Number.isFinite(otherEnd) || otherEnd >= start);
  });
}

/**
 * IDs witnessed only in another overlapping run. An ID shared by both runs,
 * a root file, or a run without a start time remains ambiguous.
 * @param {any} current @param {readonly any[]} peers @returns {Set<string>}
 */
export function foreignDeliverableIds(current, peers) {
  const own = witnessedIds(current);
  const foreign = new Set();
  for (const peer of overlappingRuns(current, peers)) {
    for (const id of witnessedIds(peer)) if (!own.has(id)) foreign.add(id);
  }
  return foreign;
}
