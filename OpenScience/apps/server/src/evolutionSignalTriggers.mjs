/** A public summary generation is a trigger, not the independent evidence validating a candidate. */
export function evolutionSignalTrigger(row) {
  return { id: row.id, ...(row.payload.generation ? { generation: row.payload.generation } : {}) };
}

/** Read current summaries when resuming work; a frozen generation cannot inherit newer membership. */
export async function evolutionTriggersCurrent(service, payload) {
  const refs = new Map((payload?.triggerRefs ?? []).map(ref => [ref.id, ref]));
  const roots = [...new Set([...(payload?.evidenceRoots ?? []), ...refs.keys()])];
  for (const id of roots) {
    const row = await service.get(id), expected = refs.get(id);
    if (!row) { if (expected) return false; continue; }
    if (row.payload.recordType !== 'evolution-signal-summary') { if (expected) return false; continue; }
    if (row.payload.state === 'inactive' || (expected?.generation && expected.generation !== row.payload.generation)) return false;
  }
  return true;
}
