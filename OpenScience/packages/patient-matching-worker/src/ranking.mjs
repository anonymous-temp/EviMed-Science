const fail = code => Object.assign(new Error('Ranking input identities are invalid.'), { code });

/** Reciprocal ranks combine declared channels without assuming provider score calibration. */
export function fuseCandidates(channels, { limit = 500, k = 20 } = {}) {
  if (!Array.isArray(channels) || channels.length > 64 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || !Number.isFinite(k) || k <= 0) throw fail('matching_rank_input_invalid');
  const entries = new Map();
  for (const [channel, value] of channels.entries()) {
    const weight = value?.weight ?? 1;
    if (!Array.isArray(value?.ids) || value.ids.length > 5000 || !Number.isFinite(weight) || weight < 0 || new Set(value.ids).size !== value.ids.length) throw fail('matching_rank_input_invalid');
    for (const [rank, id] of value.ids.entries()) {
      if (typeof id !== 'string' || !id || id.length > 200) throw fail('matching_rank_input_invalid');
      const held = entries.get(id) ?? { id, score: 0, first: entries.size, channels: [] };
      held.score += weight / (k + rank + 1);
      held.channels.push({ channel, rank: rank + 1 });
      entries.set(id, held);
    }
  }
  return [...entries.values()].sort((a, b) => b.score - a.score || a.first - b.first).slice(0, limit).map(({ first: _first, ...entry }) => entry);
}

export function validatePermutation(order, candidates) {
  if (!Array.isArray(order) || !Array.isArray(candidates) || new Set(candidates).size !== candidates.length || order.length !== candidates.length || new Set(order).size !== order.length || order.some(id => !candidates.includes(id))) throw fail('matching_rank_identity_invalid');
  return [...order];
}
