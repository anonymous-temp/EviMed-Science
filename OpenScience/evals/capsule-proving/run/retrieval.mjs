/** Operator-only retrieval diagnosis. Gold enters here from score.loadGold, never a Case or model request. */
import { memoryLines, lineFingerprint, originalSources } from '../../../apps/server/src/nativeMemoryOverlay.mjs';
import { engineSessionId } from './lab.mjs';
import { selectSearchBlocks } from './answerVariants.mjs';
import { toIso } from './sets.mjs';

export function sessionMapping(entry, item, runId) {
  const sorted = entry.runtimeInput.histories.map((h, i) => ({ ...h, i, at: toIso(h.at) }))
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.i - b.i);
  if (sorted.length !== item.sessions.length) throw new Error('retrieval_session_alignment_mismatch');
  return sorted.map((history, i) => {
    if (history.at !== item.sessions[i].at) throw new Error('retrieval_session_date_mismatch');
    return { sourceSessionId: history.sourceSessionId, at: history.at,
      engineSession: engineSessionId(runId, item.userKey, item.sessions[i].sessionId) };
  });
}

export function memoryHits(blocks) {
  const hits = [];
  for (const block of selectSearchBlocks(blocks, 'memory')) {
    let result; try { result = JSON.parse(block); } catch { continue; }
    for (const hit of result.memories ?? []) if (typeof hit.uri === 'string') hits.push(hit);
  }
  return hits;
}

export function measureRetrieval({ blocks, goldIds, mapping, origins = new Map(), isError = false, limit }) {
  const gold = new Set(goldIds), history = selectSearchBlocks(blocks, 'history').join('\n\n');
  const byEngine = new Map(mapping.map(s => [s.engineSession, s.sourceSessionId]));
  const returned = [];
  for (const match of history.matchAll(/\]\(\/app\/chat\/([^\s)]+)\)/g)) {
    const engine = `dsh-${decodeURIComponent(match[1])}`;
    returned.push({ engineSession: engine, sourceSessionId: byEngine.get(engine) ?? null });
  }
  const retrieved = [...new Set(returned.map(s => s.sourceSessionId).filter(Boolean))];
  const matched = [...gold].filter(id => retrieved.includes(id));
  const memoryEvidence = [];
  let originLines = 0, totalLines = 0;
  const goldDates = new Set(mapping.filter(s => gold.has(s.sourceSessionId)).map(s => s.at.slice(0, 10)));
  for (const hit of memoryHits(blocks)) for (const line of memoryLines(hit.abstract ?? '')) {
    totalLines++;
    const origin = origins.get(hit.uri)?.get(lineFingerprint(line));
    if (origin) originLines++;
    const sourceIds = originalSources(origin).map(o => byEngine.get(o.engineSession)).filter(Boolean);
    const originMatch = sourceIds.filter(id => gold.has(id));
    const dates = line.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
    const dateMatch = dates.filter(date => goldDates.has(date));
    if (originMatch.length || dateMatch.length) memoryEvidence.push({ uri: hit.uri, fingerprint: lineFingerprint(line),
      sourceSessionIds: originMatch, matchingDates: dateMatch, method: originMatch.length ? 'native_line_origins' : 'date-proxy' });
  }
  return { limit, isError, goldSessions: gold.size, history: { returnedExcerpts: returned.length, returned, retrievedSessionIds: retrieved,
    matchedSessionIds: matched, matched: matched.length, recall: gold.size && !isError ? matched.length / gold.size : null,
    hit: gold.size ? !isError && matched.length > 0 : null, all: gold.size ? !isError && matched.length === gold.size : null },
    memory: { any: gold.size ? !isError && memoryEvidence.length > 0 : null,
      originAny: gold.size ? !isError && memoryEvidence.some(e => e.method === 'native_line_origins') : null,
      totalLines, originLines, evidence: memoryEvidence }, blocks };
}

export async function diagnoseQuestion({ entry, item, question, memory, lab, user }) {
  const mapping = sessionMapping(entry, item, lab.runId);
  const results = [];
  for (const limit of [8, 20]) {
    const started = Date.now(), result = await memory.callTool('search', { query: question.text, limit });
    const uris = [...new Set(memoryHits(result.blocks).map(h => h.uri))];
    const origins = await lab.parts.overlay.originsOf(user.userId, uris);
    results.push({ ...measureRetrieval({ blocks: result.blocks, goldIds: entry.gold.answer_session_ids ?? [], mapping, origins, isError: result.isError, limit }), ms: Date.now() - started });
  }
  return { schema: 'longmemeval-retrieval/1', runId: lab.runId, caseId: item.caseId, qid: question.qid,
    questionType: question.qid.includes('_abs') ? 'abstention' : entry.gold.question_type,
    question: question.text, goldSessionIds: entry.gold.answer_session_ids ?? [], results };
}

function aggregate(rows, limit) {
  const all = rows.map(row => row.results.find(r => r.limit === limit));
  const eligible = all.filter(r => r.goldSessions > 0), n = eligible.length;
  const total = eligible.reduce((s, r) => s + r.goldSessions, 0);
  const matched = eligible.reduce((s, r) => s + (r.isError ? 0 : r.history.matched), 0);
  return { limit, questions: all.length, answerable: n, abstention: all.length - n, errors: all.filter(r => r.isError).length,
    goldSessions: total, matchedSessions: matched, microRecall: total ? matched / total : null,
    macroRecall: n ? eligible.reduce((s, r) => s + (r.history.recall ?? 0), 0) / n : null,
    historyHitRate: n ? eligible.filter(r => r.history.hit).length / n : null,
    historyAllRate: n ? eligible.filter(r => r.history.all).length / n : null,
    memoryHitRate: n ? eligible.filter(r => r.memory.any).length / n : null,
    memoryOriginHitRate: n ? eligible.filter(r => r.memory.originAny).length / n : null,
    originLineCoverage: all.reduce((s, r) => s + r.memory.originLines, 0) / (all.reduce((s, r) => s + r.memory.totalLines, 0) || 1) };
}
export function retrievalReport(rows, identity = {}) {
  return { schema: 'longmemeval-retrieval/1', ...identity, completed: rows.length, limits: [8, 20].map(k => aggregate(rows, k)),
    byType: Object.fromEntries([...new Set(rows.map(r => r.questionType))].sort().map(type => [type, [8, 20].map(k => aggregate(rows.filter(r => r.questionType === type), k))])),
    notes: ['Search uses the original question and product gateway; no answer model or ingestion.',
      'Recall is over unique gold answer_session_ids, not answer strings. Repeated source IDs remain one logical session.',
      'Memory origin matches use exact returned-line fingerprints. Date-only matches are proxies, not proof of answer content.',
      'Source-session presence does not prove that an excerpt contains the answer. Abstentions have no retrieval target and are excluded from recall; errors count as misses.'], rows };
}
export function summaryText(report) {
  const pct = v => v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
  const line = (type, rows) => `${type}: n=${rows[0].questions} history recall@8/20=${rows.map(r => pct(r.microRecall)).join('/')} memory any@8/20=${rows.map(r => pct(r.memoryHitRate)).join('/')} origins@8/20=${rows.map(r => pct(r.memoryOriginHitRate)).join('/')}`;
  return ['LongMemEval-S product retrieval (no answer model)', line('ALL', report.limits),
    ...Object.entries(report.byType).map(([type, rows]) => line(type, rows)), 'Date matches are proxies; gold-session recall is not answer-content recall.'].join('\n');
}
