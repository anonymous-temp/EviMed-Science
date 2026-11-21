/** Offline replay of recorded searches. Gold is used only to score the frozen orders. */
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseHistory, unpack } from './read-classes.mjs';
import { historySearchText } from '../../../apps/server/src/memoryHistory.mjs';
import { diverseHistoryCandidates, compactHistoryMessages, historyLexicalScorer, fuseHistoryChannels } from '../../../apps/server/src/memoryHistoryRetrieval.mjs';

export async function* answersFrom(input) {
  if ((await stat(input)).isDirectory()) {
    for (const entry of (await readdir(input, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() || entry.isFile() && /^(?:answers.*\.jsonl|.*\.json)$/.test(entry.name)) yield* answersFrom(path.join(input, entry.name));
    }
    return;
  }
  const rows = input.endsWith('.jsonl') ? createInterface({input:createReadStream(input),crlfDelay:Infinity})
    : [await readFile(input, 'utf8')];
  for await (const line of rows) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    // LongMemEval's paired retrieval probes preserve channels separately from the rendered answer blocks.
    for (const row of raw.report?.rows ?? raw.rows ?? []) {
      if (!Array.isArray(row.results) || !row.qid) continue;
      const detail = raw.details?.find(d => d.caseId === row.caseId);
      yield {file:input,answer:{qid:row.qid,question:row.question, toolCalls:row.results.map(result => ({
        name:'mcp__openviking__search',args:{query:row.question,limit:result.limit},blocks:result.blocks,isError:result.isError,
        ms:result.ms, returnedSessions:result.history?.returned,
        // The probe records one fusedOrder per case, built from the last /find and /grep.
        historyTrace:result === row.results.at(-1) && detail?.fusedOrder ? {candidates:detail.fusedOrder, complete:true} : null,
      }))}};
    }
    const answer = Array.isArray(raw.toolCalls) ? raw : unpack(raw).answer;
    if (answer?.qid && Array.isArray(answer.toolCalls)) yield {file:input,answer};
  }
}

export function recordedHits(call, source) {
  const history = [], files = [];
  let status = null, recorded = false;
  for (const block of call.blocks ?? []) {
    const text = typeof block === 'string' ? block : block?.text ?? '';
    if (text.startsWith('Original conversation excerpts (')) {
      history.push(...parseHistory(text));
      recorded = true;
    } else if (text.startsWith('Memory lookup status: ')) {
      try { status = JSON.parse(text.split('\n')[0].slice('Memory lookup status: '.length)); } catch { /* incomplete legacy block */ }
    } else {
      let result; try { result = JSON.parse(text); } catch { continue; }
      if (Array.isArray(result?.memories)) {
        if (source === 'memory') recorded = true;
        files.push(...result.memories);
      }
      if (Array.isArray(result?.history)) { history.push(...result.history); recorded = true; }
      status ??= result?.searchStatus;
    }
  }
  const hits = (source === 'memory' ? files : history.filter(h => !h.withdrawn)).map((hit, i) => {
    const link = hit.conversationUrl;
    const messages = hit.messages ?? [{sourceRole:'memory',text:hit.abstract ?? hit.text ?? ''}];
    return { ...hit, messages, uri:hit.uri ?? link, sessionId:call.returnedSessions?.[i]?.sourceSessionId ?? hit.sessionId ?? link,
      // Text-only legacy blocks identify a conversation, not a chunk. Keep distinct excerpts distinct.
      key:hit.uri ?? (link ?? 'returned') + '#' + i };
  });
  const coverage = status?.[source === 'memory' ? 'memoryFiles' : 'earlierConversations']?.state;
  return { hits, coverage, usable:!call.isError && (recorded || coverage === 'empty' || coverage === 'searched') };
}

function matches(hit, target) {
  if (!target || !(target.uri || target.sessionId || target.quote)) return false;
  return (!target.uri || target.uri === hit.uri) && (!target.sessionId || target.sessionId === hit.sessionId)
    && (!target.quote || hit.messages?.some(message => message.text?.includes(target.quote)));
}

const rankOf = (rows, target) => rows.findIndex(row => matches(row,target)) + 1 || null;
const identity = hit => ({ uri:hit.uri ?? null, sessionId:hit.sessionId ?? null, score:hit.score ?? null });

export function replaySearch(call, label) {
  const { target, source = 'history' } = label;
  const {hits, coverage, usable} = recordedHits(call, source);
  const limit = Math.max(1,Math.min(20,Number(call.args?.limit) || 5));
  const topK = label.topK ?? limit;
  const rank = rankOf(hits,target);
  const trace = call.historyTrace;
  const candidates = source === 'history' ? trace?.candidates : call.memoryTrace?.candidates;
  const complete = (source === 'history' ? trace : call.memoryTrace)?.complete === true;
  const candidateRank = candidates ? rankOf(candidates,target) : null;
  const targetRow = candidateRank ? candidates[candidateRank-1] : target?.uri ? candidates?.find(row => row.uri === target.uri
    && (!target.sessionId || row.sessionId === target.sessionId)) : null;
  const assessable = target && (target.quote || target.uri || target.sessionId);
  const contentKnown = candidates?.every(row => (!target?.quote || Array.isArray(row.messages))
    && (!target?.sessionId || row.sessionId) && (!target?.uri || row.uri));
  let reason = 'unknown';
  if (assessable && !call.isError) {
    if (rank) reason = rank <= topK ? 'hit' : 'ranked_below_cutoff';
    else if (targetRow?.decision === 'denied') reason = 'permission_denied';
    else if (targetRow?.decision === 'stale') reason = 'invalidated';
    else if (candidateRank > topK && targetRow?.decision === 'allowed') reason = 'ranked_below_cutoff';
    else if (complete && candidates && !candidateRank && contentKnown) reason = 'not_in_candidates';
  }
  const result = {query:call.args?.query ?? null, returnedRank:rank, candidateRank, returnedCount:hits.length,
    candidateCount:candidates?.length ?? null, topK, reason, coverage:coverage ?? (usable ? 'returned_only' : 'unknown'),
    ahead:(rank ? hits.slice(0,rank-1) : candidateRank ? candidates.slice(0,candidateRank-1) : hits).map(identity)};
  if (source !== 'history') return result;
  const unavailable = {status:'missing_evidence'};
  const order = candidates ?? hits;
  // Use an artificial key only for the legacy block's lack of an exact chunk URI.
  const diverse = diverseHistoryCandidates(order.map((r,i) => ({...r, original:r, uri:r.key ?? r.uri ?? 'row:'+i})),
    r => r.sessionId ?? r.uri.slice(0,r.uri.lastIndexOf('/'))).map(r => r.original);
  const seen = new Map(), query = String(call.args?.query ?? '');
  const compact = hits.map(hit => {
    const group = seen.get(hit.sessionId) ?? new Set(); seen.set(hit.sessionId,group);
    const header = historySearchText([{...hit,messages:[]}]).length;
    return {...hit, messages:compactHistoryMessages(hit.messages,query,historyLexicalScorer([hit],query),Math.floor(48000/Math.min(8,limit))-header,group)};
  });
  const fuse = trace?.root && Array.isArray(trace.vector) && Array.isArray(trace.lexical) && candidates
    ? fuseHistoryChannels(trace.lexical,trace.vector,trace.root).map(row => candidates.find(c => c.uri === row.uri) ?? row) : null;
  const timed = Array.isArray(candidates) && candidates.every(c => Number.isFinite(c.verifyMs) && c.verifyMs >= 0 && ['allowed','denied','stale'].includes(c.decision));
  const simulate = (width, deadline) => {
    let ms = 0, i = 0;
    const kept = [];
    while (i < Math.min(80, candidates.length) && kept.length < Math.min(8,limit)) {
      const batch = candidates.slice(i, Math.min(80,i+Math.min(width,Math.min(8,limit)-kept.length)));
      i += batch.length;
      ms += Math.max(...batch.map(row => row.verifyMs));
      if (ms >= deadline) break;
      kept.push(...batch.filter(row => row.decision==='allowed'));
    }
    return {rank:rankOf(kept,target), estimatedMs:Math.min(ms,deadline)};
  };
  return {...result, variants:{
    diversity:{rank:rankOf(diverse,target),on:candidates ? 'candidate_order' : 'returned_subset'},
    fusion:fuse ? {rank:rankOf(fuse,target),on:'recorded_channels'} : unavailable,
    compact:{rank:rankOf(compact,target),on:'returned_excerpts'},
    wide:{requested:limit, v1Cap:Math.min(8,limit), v2Cap:limit,
      rank:rankOf(order.slice(0,limit),target), on:candidates ? 'candidate_order_before_validation' : 'returned_subset'},
    parallel:timed ? simulate(4,Infinity) : unavailable,
    serial:timed ? simulate(1,Infinity) : unavailable,
    deadline:timed && Number.isFinite(trace.deadlineMs) ? simulate(1,trace.deadlineMs) : unavailable,
  }};
}

export function largeLibraryBreakdown(rows) {
  const groups = {};
  for (const row of rows.filter(r => r.librarySize >= 1000 && r.librarySize <= 10000)) {
    const group = groups[row.librarySize] ??= { searches:0, counts:{}, shares:{} };
    group.searches++;
    group.counts[row.reason] = (group.counts[row.reason] ?? 0) + 1;
  }
  for (const group of Object.values(groups)) {
    for (const reason of ['hit','not_in_candidates','ranked_below_cutoff','permission_denied','invalidated','unknown']) {
      group.shares[reason] = (group.counts[reason] ?? 0) / group.searches;
    }
  }
  return groups;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [root, labelsFile] = process.argv.slice(2);
  if (!root || !labelsFile) throw Error('usage: recall-ranking.mjs RECORDINGS_DIR LABELS.json');
  const labels = JSON.parse(await readFile(labelsFile,'utf8'));
  const rows = [], found = new Set(), noSearch = [];
  for await (const {file, answer} of answersFrom(root)) {
    for (const label of labels.filter(label => label.qid === answer.qid && (!label.file || file.endsWith(label.file)))) {
      found.add(label);
      const calls = answer.toolCalls.filter(call => /^(?:mcp__openviking__)?search$/.test(call.name));
      if (!calls.length) noSearch.push({qid:answer.qid, file});
      calls.forEach((call,i) => rows.push({qid:answer.qid,file,search:i+1,librarySize:label.librarySize,...replaySearch(call,label)}));
    }
  }
  const missing = labels.filter(label => !found.has(label)).map(label=>label.qid);
  process.stdout.write(JSON.stringify({schema:'recall-ranking/1', rows, noSearch, missing, largeLibraries:largeLibraryBreakdown(rows)}, null, 2)+'\n');
  if (!rows.length || missing.length) process.exitCode = 1;
}
