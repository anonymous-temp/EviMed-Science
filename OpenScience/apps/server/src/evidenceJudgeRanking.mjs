/** Reorder only a bounded, already visible prefix. Identity and access stay with the caller.
 * @param {any[]} rows @param {string} query @param {any} judgeService @param {any} context
 * @returns {Promise<any[]>} */
export async function rankEvidenceCards(rows, query, judgeService, context) {
  if (!judgeService || !context?.projectId || rows.length < 2) return rows;
  const prefix = rows.slice(0, 15);
  try {
    const decision = await judgeService.judge('J13', { query, cards: prefix.map(row => ({
      id: String(row.id), summary: [row.title, row.summary, row.question, row.answer].filter(Boolean).join('\n').slice(0, 10000),
    })) }, context);
    const ids = decision.value?.rankedIds;
    const byId = new Map(prefix.map(row => [String(row.id), row]));
    if (decision.outcome !== 'settled' || !Array.isArray(ids) || ids.length !== prefix.length
      || new Set(ids).size !== ids.length || byId.size !== prefix.length || ids.some(id => !byId.has(id))) return rows;
    return [...ids.map(id => byId.get(id)), ...rows.slice(prefix.length)];
  } catch { return rows; }
}
