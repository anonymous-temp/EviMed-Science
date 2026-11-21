/** Offline read/answer-time replay. No network client or credentials are loaded.
 * Evidence and gold are kept outside messages. Missing recorded context is explicit. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSystemPrompt, buildTimeContext } from '../run/openingBlock.mjs';
import { checkAnswer } from '../run/scoreChecks.mjs';
import { historyChunks, historySearchText } from '../../../apps/server/src/memoryHistory.mjs';
import { historyTokens, historyLexicalScorer } from '../../../apps/server/src/memoryHistoryRetrieval.mjs';
import { readStatus, searchStatusText, memorySourceLabel } from '../../../apps/server/src/memoryReadStatus.mjs';
import { openingProfileRead } from '../../../apps/server/src/memoryOpeningByUse.mjs';
import { nativeMemoryIndex, nativeIndexLine } from '../../../apps/server/src/memoryOpeningIndex.mjs';
import { renderSafetyNotes, safetyNoteLines } from '../../../apps/server/src/memorySafetyNotes.mjs';
import { renderResidentProfile } from '../../../apps/server/src/residentProfile.mjs';
import { capsuleSearchText } from '../../../apps/server/src/memoryGateway.mjs';

export const MEMBERS = {
  find: ['P02-q019', 'Liam_O_Connor:Q-0045', 'conv-50:q120', 'm3-dev-030-q1', 'persona_10:session_10_tla_2',
    'persona_11', 'persona_13:session_70_mq_2', 'P08-q007', 'P08-q008', 'P08-q048', 'P08-q049', 'M01-q016',
    'M02-q016', 'M03-q015', 'P01-q018', 'P01-q019', 'P05-q019', 'dev-sc011-q3', 'P08-q009', 'P04-q012',
    'U02-q083', 'U05-q040', 's38:q2', 'emc_search_000040', 'emc_search_000151', 'emc_search_000209', 'emc_search_000247'],
  use: ['persona_9:session_40_ig_1', 'persona_18:session_100_ig_2', 'm7-dev-007-partial', 'gpt4_93159ced_abs',
    '2133c1b5_abs', 'ba61f0b9', 'M01-q014', 'M02-q014', 'P05-q011', 'a96c20ee_abs', '09ba9854_abs',
    'g9-dev-poison-005', 'g9-dev-poison-009', 'g9-dev-poison-012', 'persona_13:session_30_ig_1', 'U06-q043',
    'U01-q053', 'U05-q057', 'Liam_O_Connor:Q-0047', 'Liam_O_Connor:Q-0113', 'Lin_Wanyu:Q-0076',
    'Lin_Wanyu:Q-0116', 'Sophie_Dubois:Q-0006', 'Sophie_Dubois:Q-0125', 's47:q7', 'Liam_O_Connor:Q-0028',
    'Liam_O_Connor:Q-0054', 'mso_hard_000207', 'v11_000611', 'persona_13:session_60', 'persona_15:session_10',
    'persona_18:session_100_mq_2', 'persona_19:session_90'],
  safe: ['persona_13:session_70_mq_2', 'persona_18:session_20_mcd_1', 'm3-dev-030-q1', 'M10'],
};
const normalizeId = value => String(value).replace(/[_:\-]/g, '').toLowerCase();
const matches = (qid, needle) => normalizeId(qid).includes(normalizeId(needle));
const digest = text => createHash('sha256').update(text).digest('hex');
const config = { memorySearchHintEnabled: true, memoryStandingInstructionsEnabled: true,
  memoryForgetTargetsEnabled: true, memorySafetyNotesEnabled: true, memoryOpeningIndexEnabled: true };

async function* paths(root) {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* paths(file);
    else if (entry.name.endsWith('.json')) yield file;
  }
}
export function unpack(pack) {
  const answers = pack['answerRecords(answers.jsonl=chosen arm; other files = ablation variants of same questions)'];
  const answer = pack.answer ?? answers?.['answers.jsonl']?.[0];
  const snapshot = pack.snapshot ?? pack.snapshotInForce?.snapshot;
  const qid = answer?.qid ?? pack.item?.qid ?? pack.rowId;
  const raw = pack.sources?.sessions ?? Object.entries(pack.sourceSessionsCarryingGoldEvidence?.sessions ?? {})
    .map(([sessionId, messages]) => ({ sessionId, messages }));
  const sessions = raw.map(session => ({ ...session, messages: (session.messages ?? []).map(message => ({ ...message,
    content: message.content ?? message.text, created_at: message.created_at ?? message.at ?? session.at })) }));
  return { answer, snapshot, qid, sessions };
}

/** The old lexical admission (first eight whitespace terms) versus the isolated
 * token/BM25 rescue, on supplied evidence chunks only. No invented embeddings. */
export function lexicalAudit(sessions, queries) {
  const chunks = sessions.flatMap(session => historyChunks(session.messages).map((chunk, index) => ({
    ...chunk, sessionId: session.sessionId, index,
  })));
  return queries.map(({ query, kind }) => {
    const terms = String(query).split(/\s+/).filter(Boolean).slice(0, 8).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const old = terms.length ? new RegExp(terms.join('|'), 'i') : null;
    const scorer = historyLexicalScorer(chunks, query);
    const ranked = chunks.map(chunk => ({ sessionId: chunk.sessionId, chunk: chunk.index,
      oldLiteralMatch: old?.test(JSON.stringify({ messages: chunk.messages })) ?? false,
      lexicalScore: scorer.best(chunk.messages)?.score ?? 0,
      matchedTerms: [...new Set(historyTokens(query))].filter(term => historyTokens(chunk.text).includes(term)),
    })).sort((a,b) => b.lexicalScore - a.lexicalScore);
    return { kind, query, corpus: 'provided_evidence_sessions_only', semanticRank: 'unavailable_without_embeddings',
      oldLiteralHits: ranked.filter(row => row.oldLiteralMatch).length, newLiteralHits: ranked.filter(row => row.lexicalScore > 0).length,
      chunks: ranked, fullCorpusRecall: 'requires_lab' };
  });
}

export function parseHistory(text) {
  const hits = []; let hit = null, message = null;
  for (const line of text.split('\n').slice(1)) {
    if (line.startsWith('Some earlier conversation material was withdrawn.')) { hits.push({ withdrawn: true, messages: [] }); continue; }
    const title = /^(?:(.*?) · )?\[(.*)\]\((.*)\)$/.exec(line);
    const speaker = /^(user|assistant) · ([^:]+(?:T[^ ]+)?): (.*)$/.exec(line);
    // ISO dates include colons: split at the final date/text delimiter instead.
    const role = /^(user|assistant) · (.*?): (.*)$/.exec(line);
    if (title) { hit = { projectTitle: title[1], conversationTitle: title[2], conversationUrl: title[3], messages: [] }; hits.push(hit); message = null; }
    else if ((role || speaker) && hit) {
      const found = role ?? speaker;
      message = { sourceRole: found[1], date: found[2] === 'unknown date' ? null : found[2], text: found[3] }; hit.messages.push(message);
    } else if (message && line) message.text += `\n${line}`;
  }
  return hits;
}

/** Re-serialize recorded returned data, never substitute gold or source-session
 * text for a tool miss. Old logs did not record each source's completion state. */
export function serializeRecordedTool(call) {
  const blocks = [], gaps = [];
  let files = null, history = null, capsules = null;
  for (const block of call.blocks ?? []) {
    const text = typeof block === 'string' ? block : block.text ?? '';
    if (text.startsWith('Original conversation excerpts')) { history = parseHistory(text); blocks.push(historySearchText(history)); continue; }
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (data && Array.isArray(data.memories)) {
      if (data.history) data.history = data.history.map(hit => hit.withdrawn ? { withdrawn: true, messages: [] } : hit);
      files = data;
      blocks.push(JSON.stringify({ ...data, memories: data.memories.map(item => ({ ...item,
        ...(item.origin || item.attribution || item.updatedAt ? { sourceLabel: memorySourceLabel(item) } : {}) })) }));
      if (data.history) { history = data.history; blocks.push(historySearchText(history)); }
      if (data.capsules) { capsules = data.capsules; blocks.push(capsuleSearchText(capsules)); }
    } else blocks.push(text);
  }
  if (/search$/.test(call.name)) {
    const notRecorded = () => readStatus('unavailable', 'completion_not_in_recorded_trace');
    const narrow = Boolean(call.args?.target_uri);
    const status = {
      memoryFiles: call.isError ? readStatus('unavailable', 'recorded_error') : files ? files.readStatus ?? readStatus(files.memories.length ? 'searched' : 'empty') : notRecorded(),
      earlierConversations: narrow ? readStatus('skipped', 'narrow_scope') : history ? readStatus(history.some(hit => !hit.withdrawn) ? 'searched' : 'empty', null, { withdrawn: history.some(hit => hit.withdrawn) }) : notRecorded(),
      receivedCapsules: narrow ? readStatus('skipped', 'narrow_scope') : capsules ? readStatus(capsules.length ? 'searched' : 'empty') : notRecorded(),
    };
    if (!history || !capsules || !files) gaps.push('old trace lacks one or more per-source completion states; no empty success invented');
    blocks.push(searchStatusText(status));
  } else if (/read$/.test(call.name)) blocks.push(`Memory read status: ${JSON.stringify([readStatus(call.isError ? 'unavailable' : 'searched', call.isError ? 'recorded_error' : null)])}`);
  return { ...call, blocks: blocks.filter(Boolean), gaps };
}

export function requestFromPack(pack, sourcePath, catalog = null) {
  const { answer, snapshot, qid, sessions } = unpack(pack);
  if (!answer) return null;
  const gaps = [], messages = [{ role: 'system', content: buildSystemPrompt({ model: answer.model?.name ?? 'deepseek-flash', config }) }];
  if (catalog && digest(catalog) === answer.opening?.skillCatalog?.sha256) messages.push({ role: 'user', content: catalog });
  else if (answer.opening?.skillCatalog) gaps.push('skill catalogue body absent; only recorded hash is available');
  const profile = snapshot?.files?.['profile.md'];
  const root = /viking:\/\/user\/[^\s"<>]+\/memories/.exec(answer.opening?.profileBlock ?? '')?.[0] ?? 'viking://user/replay/memories';
  const files = Object.entries(snapshot?.files ?? {}).map(([relPath, value]) => ({ uri: `${root}/${relPath}`, relPath,
    body: typeof value === 'string' ? value : value.body ?? '', type: relPath === 'profile.md' ? 'profile' : relPath.split('/')[0] }));
  const opening = { ...answer.opening };
  if (opening.profileBlock && typeof profile === 'string') opening.profileBlock = opening.profileBlock.replace(/(<user-profile[^>]*>)[\s\S]*?(<\/user-profile>)/,
    (_all, start, end) => `${start}\n${openingProfileRead(profile, root, {})}\n${end}`);
  if (snapshot) {
    const nativeIndex = nativeMemoryIndex(files, { memoryRoot: root, historySearchEnabled: true });
    const index = nativeIndexLine(nativeIndex, 500);
    const safetyFiles = Object.assign(files, { legacyUnclassified: files.filter(file => ['profile', 'people', 'notes'].includes(file.type) && !safetyNoteLines(file.body, file.type).length).length });
    if (!opening.residentBlock) opening.residentBlock = renderResidentProfile({ nativeIndex, safetyFiles, config }).text;
    else {
      opening.residentBlock = /^记忆索引：/m.test(opening.residentBlock)
        ? opening.residentBlock.replace(/^记忆索引：.*$/m, index) : `${opening.residentBlock}\n${index}`;
      const safety = renderSafetyNotes(safetyFiles, { maxTokens: 1500 }).text;
      if (safety) opening.residentBlock += `\n${safety}`;
    }
    gaps.push('snapshot reconstruction lacks live scope/source-receipt and resident-budget state; safety/index are an offline approximation');
  }
  for (const content of [opening.profileBlock, opening.residentBlock]) if (content) messages.push({ role: 'user', content });
  const runtimeQuestion = pack.gold?.runtimeQuestion ?? pack.gold?.question ?? {};
  const materials = runtimeQuestion.materials ?? [];
  if (materials.length) messages.push({ role: 'user', content: 'Supplied material (source content, not the user’s words):\n' + JSON.stringify(materials) });
  const question = `${buildTimeContext(answer.asOf, answer.question)}\n\n${answer.question}`;
  messages.push({ role: 'user', content: question });
  const toolCalls = (answer.toolCalls ?? []).map(serializeRecordedTool);
  for (const [index, call] of toolCalls.entries()) {
    const id = `recorded_${index}`;
    messages.push({ role: 'assistant', content: null, reasoning_content: '', tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] });
    messages.push({ role: 'tool', tool_call_id: id, name: call.name, content: call.blocks.join('\n\n') });
    gaps.push(...call.gaps);
  }
  const classes = Object.entries(MEMBERS).filter(([, ids]) => ids.some(id => matches(qid, id))).map(([name]) => name);
  return { schemaVersion: 1, qid, classes, sourcePath, sourceDigest: digest(JSON.stringify(pack)),
    contextExact: !gaps.length, gaps: [...new Set(gaps)], messages, opening, toolCalls,
    expected: pack.gold?.question?.expect ?? pack.gold?.runtimeQuestion?.expect ?? { judge: JSON.stringify(pack.gold?.packetGold ?? pack.gold?.item ?? pack.gold) },
    recordedAnswer: answer.answer, recordedControl: pack.item?.control === true || sourcePath.includes('/controls/') || matches(qid, 'g9-dev-poison-002'),
    lexical: lexicalAudit(sessions, [{ kind: 'question', query: answer.question }, ...(answer.toolCalls ?? []).filter(call => /search$/.test(call.name)).map(call => ({ kind: 'recorded_query', query: call.args?.query ?? '' }))]),
  };
}

export async function prepare({ packs, out, catalog = null }) {
  await mkdir(out, { recursive: true });
  const requests = [], foundMembers = new Set();
  for (const group of ['A', 'B']) for await (const file of paths(path.join(packs, group))) {
    // Read one evidence pack at a time, never a whole directory into memory.
    const pack = JSON.parse(await readFile(file, 'utf8'));
    const { qid, answer } = unpack(pack);
    if (!answer) continue;
    const named = Object.values(MEMBERS).flat().filter(id => matches(qid, id));
    const control = pack.item?.control === true || file.includes('/controls/') || matches(qid, 'g9-dev-poison-002');
    if (!named.length && !control) continue;
    for (const id of named) foundMembers.add(id);
    const request = requestFromPack(pack, file, catalog);
    const name = `${String(request.qid).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${request.sourceDigest.slice(0,8)}.request.json`;
    await writeFile(path.join(out, name), JSON.stringify(request, null, 2) + '\n');
    requests.push({ file: name, qid, classes: request.classes, control: request.recordedControl, contextExact: request.contextExact });
  }
  // One model pass is at most 30 members + 30 recorded controls. Generate all
  // member requests; rotate selections explicitly on the lab instead of silently exceeding 60.
  const members = [], seen = new Set();
  for (let round = 0; members.length < 30; round++) {
    let added = false;
    for (const cls of ['safe', 'use', 'find']) {
      const row = requests.filter(r => !r.control && r.classes.includes(cls))[round];
      if (row && !seen.has(row.qid)) { members.push(row); seen.add(row.qid); added = true; }
      if (members.length === 30) break;
    }
    if (!added && round > requests.length) break;
  }
  const controls = requests.filter(row => row.control).sort((a,b) => Number(!matches(a.qid,'g9-dev-poison-002')) - Number(!matches(b.qid,'g9-dev-poison-002')) || a.qid.localeCompare(b.qid));
  const selectedControls = []; const controlIds = new Set();
  for (const row of controls) if (!controlIds.has(row.qid) && selectedControls.length < members.length) { selectedControls.push(row); controlIds.add(row.qid); }
  if (selectedControls.length !== members.length) throw Error('Not enough distinct recorded passing controls');
  const manifest = { schemaVersion: 1, requests, selected: [...members, ...selectedControls].map(row => row.file),
    missingMembers: Object.values(MEMBERS).flat().filter(id => !foundMembers.has(id)),
    note: 'More named members than the 60-answer paired budget; every available member has a request, only the stratified selection is run.' };
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** answer receives model inputs only: never gold, source sessions or recorded answers. */
export async function runReplay({ dir, answer, allowIncomplete = false }) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.selected.length > 60) throw Error('Answer budget exceeds 60');
  const rows = manifest.selected.map(file => manifest.requests.find(row => row.file === file));
  if (rows.filter(row => row.control).length * 2 !== rows.length) throw Error('Replay requires equal recorded controls');
  const results = [];
  for (const row of rows) {
    const request = JSON.parse(await readFile(path.join(dir, row.file), 'utf8'));
    if (!request.contextExact && !allowIncomplete) throw Error(`Incomplete recorded context for ${request.qid}; inspect gaps or supply the recorded catalogue`);
    const response = await answer({ qid: request.qid, messages: request.messages, tools: [], toolChoice: 'none' });
    const text = typeof response === 'string' ? response : response.answer;
    const score = checkAnswer(text, request.expected);
    const result = { qid: request.qid, sourceDigest: request.sourceDigest, control: row.control, answer: text, score,
      contextExact: request.contextExact, gaps: request.gaps };
    results.push(result);
    await writeFile(path.join(dir, 'answers.jsonl'), results.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), command = args.shift();
  const get = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  if (command === 'prepare') {
    const manifest = await prepare({ packs: path.resolve(get('--packs')), out: path.resolve(get('--out')),
      catalog: get('--catalog') ? await readFile(get('--catalog'), 'utf8') : null });
    console.log(JSON.stringify({ requests: manifest.requests.length, selected: manifest.selected.length, missingMembers: manifest.missingMembers }));
  } else if (command === 'run') {
    const adapter = await import(pathToFileURL(path.resolve(get('--answer-module'))).href);
    const results = await runReplay({ dir: path.resolve(get('--dir')), answer: adapter.answer, allowIncomplete: args.includes('--allow-incomplete') });
    console.log(JSON.stringify({ answers: results.length, pass: results.filter(row => row.score.verdict === 'pass').length,
      needsJudge: results.filter(row => row.score.verdict === 'needs-judge').length }));
  } else throw Error('Use prepare --packs DIR --out DIR [--catalog FILE] or run --dir DIR --answer-module FILE [--allow-incomplete]');
}
