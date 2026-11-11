// Reuse the existing code checks and Qwen judge, with the assistant messages the PRODUCT actually produced.
// The original expected answers stay unchanged. A changed conversation can dispute gold; it cannot manufacture a memory failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scoreRun, questionAnchors } from '../run/score.mjs';
import { containsAnchor } from '../run/scoreChecks.mjs';
import { answerTrace, buildJudgePacket, judgePackets, mergeJudgeResults, rowKey } from '../run/judgePackets.mjs';
import { createTranscriptIndex } from '../run/baselines.mjs';
import { read, save, profileOpening } from './common.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const sample = await read(args.selection);
const sourceRun = await read(`${args.run}/run.json`);
const target = `${args.run}/scores`;
const selected = sample.questions.filter(q => sourceRun.options.caseIds.includes(q.user));
const normalizedAnswers = new Map();
// Build normalized scorer inputs from immutable provider requests and raw turn receipts.
// The per-question raw records and full provider requests are retained unchanged.
for (const user of sourceRun.options.caseIds) {
  const normalized = [];
  for (const q of selected.filter(q => q.user === user)) {
    const answer = await read(`${args.run}/cases/${user}/answer-records/${q.qid}.json`);
    if (!answer) continue;
    const first = answer.evidence?.firstRequest && await read(answer.evidence.firstRequest);
    normalized.push({ ...answer, opening: { ...answer.opening, profileBlock: first ? profileOpening(first) : '' },
      openingExtractionVersion: 2, usage: { ...answer.usage, promptTokens: answer.usage.promptTokens ?? answer.usage.inputTokens ?? 0,
        completionTokens: answer.usage.completionTokens ?? answer.usage.outputTokens ?? 0, cachedTokens: answer.usage.cachedTokens ?? answer.usage.cachedInputTokens ?? 0 } });
  }
  for (const answer of normalized) normalizedAnswers.set(answer.qid, answer);
  if (normalized.length) await fs.writeFile(`${args.run}/cases/${user}/answers.jsonl`, normalized.map(a => JSON.stringify(a)).join('\n') + '\n');
}
const base = await scoreRun({ run: args.run, data: args.data, noJudge: true, out: `${target}/source-checks` });
const rows = base.rawRows.filter(r => r.kind === 'answer' && selected.some(q => q.qid === r.id));
const packets = [];
for (const sq of selected) {
  const dir = `${args.run}/cases/${sq.user}`;
  const gold = await read(`${args.data}/dev/${sq.user}/gold.json`);
  const q = gold.questions.find(q => q.qid === sq.qid);
  const row = rows.find(r => r.id === sq.qid), old = base.packets.find(p => p.rowKey === rowKey(row));
  const answer = normalizedAnswers.get(sq.qid);
  if (!answer) continue;
  const perQuestion = await read(`${dir}/question-snapshots/${sq.qid}.json`);
  const snapshot = perQuestion ?? await read(`${dir}/snapshots/${sq.checkpoint}.json`);
  const anchors = questionAnchors({ gold, skeleton: await read(`${args.data}/dev/${sq.user}/skeleton.json`) }, q);
  row.traceLegacy = row.trace;
  row.trace = { ...answerTrace({ ...answer, toolCalls: answer.toolCalls.filter(c => /^mcp__openviking__(search|read|list)$/.test(c.name)) }, snapshot, anchors),
    inOpening: anchors.some(a => containsAnchor(answer.opening.profileBlock, a)), storageSnapshot: perQuestion ? 'pre-question' : 'checkpoint-only' };
  if (!old) continue;
  const input = await read(`${args.data}/dev/${sq.user}/input.json`);
  const sessions = [];
  for (const s of input.sessions.slice(0, sq.checkpoint)) {
    const id = s.sourceSessionId ?? s.sessionId;
    const actual = await read(`${dir}/conversations/${id}.json`);
    if (!actual) throw new Error(`Missing actual source conversation: ${sq.user}/${id}`);
    sessions.push({ sessionId: id, at: actual.startedAt, project: s.project ?? null,
      messages: actual.turns.flatMap(t => [{ role: 'user', text: t.text }, { role: 'assistant', text: t.reply ?? '' }]) });
  }
  for (const prior of selected.filter(p => p.user === sq.user && p.qid !== sq.qid)) {
    const probe = await read(`${dir}/conversations/${prior.qid}.json`);
    if (probe && Date.parse(probe.startedAt) < Date.parse(answer.evidence.productAt)) sessions.push({ sessionId: prior.qid, at: probe.startedAt, project: null,
      messages: probe.turns.flatMap(t => [{ role: 'user', text: t.text }, { role: 'assistant', text: t.reply ?? '' }]) });
  }
  sessions.sort((a, b) => a.at.localeCompare(b.at));
  const index = createTranscriptIndex(sessions);
  const hits = [...anchors, q.question].map(query => index.search(query, 6));
  const excerpts = [], seen = new Set();
  for (let rank = 0; rank < 6 && excerpts.length < 6; rank++) for (const results of hits) {
    const hit = results[rank];
    if (!hit || seen.has(hit.index) || excerpts.length === 6) continue;
    seen.add(hit.index); excerpts.push({ sessionId: hit.sessionId, at: hit.at, project: hit.project, text: hit.text });
  }
  const packet = buildJudgePacket(row, { question: q.question, answer, snapshot, anchors, checkpoint: sq.checkpoint, asOf: answer.evidence.productAt,
    gold: old.gold, rubric: old.expected, transcriptEvidence: excerpts,
    transcriptNote: 'These excerpts are the actual product-path conversations through the checkpoint, including any earlier question probes that the product may also have committed. Source user turns match the script; assistant turns were generated live and can differ from the original engine replay. Source calendar times are dataset metadata; product conversations use the recorded wall clock. Expected answers are unchanged: dispute gold where the actual conversation contradicts an expected assistant suggestion or attribution; never assume the original assistant text was seen.' });
  if (packet) packets.push(packet);
}
await save(`${target}/actual-packets.json`, packets);
const previous = await read(`${target}/actual-judge-results.json`, []);
const results = await judgePackets(packets, { key: (await fs.readFile(args['judge-key-file'], 'utf8')).trim(), results: previous,
  concurrency: 3, retries: 2, persist: rows => save(`${target}/actual-judge-results.json`, rows) });
const merged = mergeJudgeResults(rows, packets, results);
await fs.writeFile(`${target}/rows.jsonl`, merged.map(r => JSON.stringify(r)).join('\n') + '\n');
await save(`${target}/summary.json`, { n: merged.length, verdicts: Object.fromEntries([...new Set(merged.map(r => r.verdict))].map(v => [v, merged.filter(r => r.verdict === v).length])),
  source: 'existing code checks and Qwen judge; actual product transcripts replace replayed assistant evidence', packets: packets.length });
console.log(`${path.basename(args.run)} scored ${merged.length} selected questions, ${packets.length} actual-transcript judge packets`);
