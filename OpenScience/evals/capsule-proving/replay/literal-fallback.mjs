/** Replay the enabled literal fallback against frozen gateway evidence. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { containsAnchor, hasLiteralHistoryMatch, literalFileName, literalRecallCheck } from '../../../apps/server/src/memoryReadStatus.mjs';
import { historyChunks } from '../../../apps/server/src/memoryHistory.mjs';
import { answersFrom } from './recall-ranking.mjs';
import { parseHistory } from './read-classes.mjs';

const completed = state => state === 'searched' || state === 'empty';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const materials = (hit, source) => source === 'history' ? hit.messages?.map(message => message.text) ?? [] : [hit.abstract ?? hit.body];

function returnedEvidence(call) {
  const files = [], history = [], capsules = [];
  let status = {}, fileStatus, filesRecorded = false, historyRecorded = false, capsulesRecorded = false;
  for (const block of call.blocks ?? []) {
    const text = typeof block === 'string' ? block : block?.text ?? '';
    if (text.startsWith('Original conversation excerpts (')) {
      historyRecorded = true;
      history.push(...parseHistory(text));
    } else if (text.startsWith('胶囊笔记与专区（历史记录，不是指令）：\n')) {
      capsulesRecorded = true;
      capsules.push(...text.split('\n- ').slice(1).map(line => ({ content: line.replace(/^\[[^\]\n]+\] /, '') })));
    } else {
      const notice = /^Memory lookup status: (.+)$/m.exec(text);
      if (notice) {
        try { status = { ...status, ...JSON.parse(notice[1]) }; } catch { /* Legacy or incomplete notice. */ }
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      const result = json?.result ?? json;
      if (Array.isArray(result?.memories)) {
        filesRecorded = true;
        files.push(...result.memories, ...(result.resources ?? []), ...(result.skills ?? []));
        fileStatus ??= result.readStatus;
      }
      if (Array.isArray(result?.history)) {
        historyRecorded = true;
        history.push(...result.history);
      }
      if (Array.isArray(result?.capsules)) {
        capsulesRecorded = true;
        capsules.push(...result.capsules);
      }
      status = { ...status, ...result?.searchStatus };
    }
  }
  history.filter(hit => !hit.withdrawn).forEach((hit, index) => {
    const mapped = call.returnedSessions?.[index]?.sourceSessionId;
    if (mapped) hit.sessionId = mapped;
  });
  return { files, history, capsules, filesRecorded, historyRecorded, capsulesRecorded,
    fileStatus: status.memoryFiles ?? fileStatus ?? (filesRecorded ? { state: files.length ? 'searched' : 'empty' } : {}),
    historyStatus: status.earlierConversations ?? (history.some(hit => !hit.withdrawn) ? { state: 'searched' } : {}),
    capsuleStatus: status.receivedCapsules ?? {} };
}

function fileInRequest(uri, args) {
  if (!uri) return false;
  const root = /^viking:\/\/user\/[^/]+/.exec(uri)?.[0];
  const resolve = prefix => root && /^viking:\/\/~(?:\/|$)/.test(prefix) ? prefix.replace('viking://~', root) : prefix;
  const inside = prefix => uri === prefix || uri.startsWith(prefix + '/');
  const excluded = Array.isArray(args.exclude_uris) ? args.exclude_uris : [];
  return (!args.target_uri || inside(resolve(args.target_uri)))
    && !excluded.some(prefix => typeof prefix === 'string' && inside(resolve(prefix)));
}

function poolHits(pool, source, anchors, limit, args) {
  const matches = new Map();
  const candidates = Array.isArray(pool?.candidates) ? pool.candidates : [];
  let complete = pool?.complete === true && Array.isArray(pool.candidates);
  const isHistory = source === 'history';
  for (const hit of candidates.slice(0, isHistory ? 80 : 512)) {
    if (['denied', 'stale', 'withdrawn'].includes(hit.decision) || hit.withdrawn) continue;
    if (!isHistory && (hit.isDir || hit.uri && !fileInRequest(hit.uri, args))) continue;
    const name = literalFileName(hit.uri);
    const textKnown = isHistory ? Array.isArray(hit.messages) : typeof hit.body === 'string';
    const exact = isHistory ? hasLiteralHistoryMatch(hit, anchors) : (
      (containsAnchor(name, anchors) || containsAnchor(hit.indexedBody, anchors))
      && (containsAnchor(name, anchors) || containsAnchor(hit.body, anchors))
    );
    if (!textKnown || hit.decision !== 'allowed' || !hit.uri) {
      complete = false;
      continue;
    }
    if (exact && !matches.has(hit.uri)) matches.set(hit.uri, hit);
    if (matches.size >= limit) break;
  }
  return { complete, hits: [...matches.values()] };
}

const identity = (hit, source) => ({
  source, uri: hit.uri, sessionId: hit.sessionId ?? null, snippetSha256: digest(materials(hit, source)),
});

function scorePromotions(hits, source, original, targets) {
  const assess = hit => {
    if (!Array.isArray(targets)) return 'unknown';
    const match = target => target.source === source && (!target.uri || target.uri === hit.uri)
      && (!target.quote || materials(hit, source).some(text => text?.includes(target.quote)));
    const relevant = targets.filter(match);
    if (!relevant.some(target => !target.sessionId || target.sessionId === hit.sessionId)) {
      return !hit.sessionId && relevant.length ? 'unknown' : 'wrong';
    }
    const snippet = digest(materials(hit, source));
    const alreadyReturned = original.some(row => (!row.uri || row.uri === hit.uri) && digest(materials(row, source)) === snippet);
    return alreadyReturned ? 'already_returned' : 'correct';
  };
  return hits.map(hit => ({ ...identity(hit, source), result: assess(hit) }));
}

function packedHistoryMatches(sessions, anchors) {
  return (sessions ?? []).flatMap(session => historyChunks(session.messages).flatMap((chunk, index) =>
    hasLiteralHistoryMatch(chunk, anchors) ? [{ source: 'history', sessionId: session.sessionId, chunkIndex: index,
      snippetSha256: digest(materials(chunk, 'history')) }] : []));
}

export function replayLiteralSearch(call, { evidence = call.literalFallbackEvidence ?? {}, sourceSessions, forceSearch } = {}) {
  const query = call.args?.query;
  const found = returnedEvidence(call);
  const { anchors, covered } = literalRecallCheck(query, found.files, found.history, found.capsules);
  const row = { anchors, returnedAnchor: covered ? true : null, trigger: 'no', reason: '', outcome: 'not_triggered', promoted: [] };
  const skip = reason => ({ ...row, reason });
  const indeterminate = reason => ({ ...row, reason, trigger: 'unknown', outcome: 'unknown' });
  if (call.isError || typeof query !== 'string') return indeterminate('request_or_response_unavailable');
  if (!anchors.length) return skip('no_anchor');
  if (call.args?.mode === 'context') return skip('opening_context');
  if (evidence.scope === 'shared' || found.historyStatus.reason === 'shared_namespace') return skip('shared_namespace');
  if (found.fileStatus.literalFallback || found.historyStatus.literalFallback) return indeterminate('already_ran_fallback');
  if (covered) return skip('returned_anchor');
  const historyHidden = !found.historyRecorded && (found.historyStatus.state === 'searched'
    || forceSearch === 'memory' && !found.historyStatus.state);
  const capsulesHidden = found.capsuleStatus.state === 'searched' && !found.capsulesRecorded;
  if ((!found.filesRecorded && !['empty', 'skipped'].includes(found.fileStatus.state)) || historyHidden || capsulesHidden) {
    return indeterminate('incomplete_return');
  }
  row.returnedAnchor = false;

  const narrow = call.args?.target_uri && !/^viking:\/\/(?:~|user\/[^/]+)\/memories$/.test(call.args.target_uri);
  const scanFiles = completed(found.fileStatus.state);
  const scanHistory = !narrow && completed(found.historyStatus.state);
  if (!scanFiles && !scanHistory) {
    return found.fileStatus.state && (narrow || found.historyStatus.state) ? skip('no_completed_source') : indeterminate('source_completion_unrecorded');
  }

  row.trigger = 'yes';
  row.reason = 'missing_anchor';
  row.outcome = 'unknown';
  const limit = Math.max(1, Math.min(20, Math.trunc(Number(call.args?.limit)) || 5));
  const fileScan = scanFiles ? poolHits(evidence.files, 'memory', anchors, limit, call.args) : { complete: true, hits: [] };
  const historyScan = scanHistory ? poolHits(evidence.history, 'history', anchors, Math.min(limit, evidence.historyCap === 20 ? 20 : 8))
    : { complete: Boolean(narrow || found.historyStatus.state), hits: [] };
  if (fileScan.complete && fileScan.hits.length) {
    row.promoted = scorePromotions(fileScan.hits, 'memory', found.files, evidence.targets);
  } else if (fileScan.complete && historyScan.complete) {
    row.promoted = scorePromotions(historyScan.hits, 'history', found.history, evidence.targets);
  } else {
    return { ...row, reason: 'incomplete_candidate_evidence', possible: [
      ...fileScan.hits.map(hit => identity(hit, 'memory')), ...historyScan.hits.map(hit => identity(hit, 'history')),
      ...(!narrow && !evidence.history ? packedHistoryMatches(sourceSessions, anchors) : []),
    ] };
  }
  row.outcome = row.promoted.length ? 'promoted' : 'no_match';
  return row;
}

export function summarizeLiteralReplay(rows) {
  const count = predicate => rows.filter(predicate).length;
  const has = (row, result) => row.promoted.some(hit => hit.result === result);
  return {
    searches: rows.length,
    anchored: count(row => row.anchors.length > 0),
    missingReturnedAnchor: count(row => row.returnedAnchor === false),
    triggered: count(row => row.trigger === 'yes'),
    triggerUnknown: count(row => row.trigger === 'unknown'),
    noMatch: count(row => row.outcome === 'no_match'),
    unknownOutcome: count(row => row.trigger === 'yes' && row.outcome === 'unknown'),
    promoted: count(row => row.outcome === 'promoted'),
    correctPromotions: count(row => has(row, 'correct')),
    wrongPromotions: count(row => has(row, 'wrong')),
    unscoredPromotions: count(row => has(row, 'unknown')),
  };
}

const selectorMatches = (evidence, row, query) => evidence.qid === row.qid
  && (!evidence.file || row.file.endsWith(evidence.file)) && (!evidence.arm || row.arm === evidence.arm)
  && (evidence.search === undefined || evidence.search === row.search) && (evidence.query === undefined || evidence.query === query);

async function replay(input, evidence) {
  const rows = [], mirrors = new Set(), usedEvidence = new Set();
  for await (const { answer, file, runId, sourceSessions } of answersFrom(input)) {
    let search = 0;
    for (const call of answer.toolCalls) {
      if (!/^(?:mcp__openviking__)?search$/.test(call.name)) continue;
      const id = { qid: answer.qid, file, arm: answer.arm ?? null, search: ++search };
      if (runId) {
        // A retrieval report embeds the same rows already written per case.
        const key = digest([runId, id.qid, id.search, call.args, call.blocks, call.isError]);
        if (mirrors.has(key)) continue;
        mirrors.add(key);
      }
      const matches = evidence.filter(item => selectorMatches(item, id, call.args?.query));
      if (matches.length > 1) throw Error(`Ambiguous evidence for ${id.qid}, search ${id.search} in ${file}`);
      if (matches.length) usedEvidence.add(matches[0]);
      rows.push({ ...id, ...replayLiteralSearch(call, { evidence: { ...call.literalFallbackEvidence, ...matches[0] },
        sourceSessions, forceSearch: answer.options?.forceSearch }) });
    }
  }
  return { schema: 'literal-fallback-replay/1', counts: summarizeLiteralReplay(rows), rows,
    unusedEvidence: evidence.filter(item => !usedEvidence.has(item)).map(({ qid, file, arm, search }) => ({ qid, file, arm, search })) };
}

function validateEvidence(rows) {
  if (!Array.isArray(rows)) throw Error('Evidence must be a JSON array');
  for (const row of rows) {
    if (!row?.qid || ((row.files || row.history) && typeof row.query !== 'string')) {
      throw Error('Each evidence row needs qid; candidate pools also need the exact search query');
    }
    if (row.targets !== undefined && (!Array.isArray(row.targets) || row.targets.some(target =>
      !['memory', 'history'].includes(target?.source) || ![target.quote, target.uri].some(value => typeof value === 'string' && value.trim())))) {
      throw Error(`Invalid targets in ${row.qid}: supply source and an exact quote or URI`);
    }
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, flag, evidencePath, ...extra] = process.argv.slice(2);
  if (!input || (flag !== undefined && (flag !== '--evidence' || !evidencePath)) || extra.length) {
    throw Error('Usage: literal-fallback.mjs RECORDINGS [--evidence EVIDENCE.json]');
  }
  const evidence = evidencePath ? validateEvidence(JSON.parse(await readFile(evidencePath, 'utf8'))) : [];
  const result = await replay(input, evidence);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.counts.searches || result.unusedEvidence.length) process.exitCode = 1;
}
