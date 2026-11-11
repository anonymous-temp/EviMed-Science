// Reuse the existing code checks and Qwen judge, with the assistant messages the PRODUCT actually produced.
// The original expected answers stay unchanged. A changed conversation can dispute gold; it cannot manufacture a memory failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import { scoreRun } from '../run/score.mjs';
import { answerAnchors } from '../run/scoreChecks.mjs';
import { buildJudgePacket, judgePackets, mergeJudgeResults, rowKey } from '../run/judgePackets.mjs';
import { createTranscriptIndex } from '../run/baselines.mjs';
import { read, save } from './common.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const sample = await read(args.selection);
const sourceRun = await read(`${args.run}/run.json`);
const target = `${args.run}/scores`;
const base = await scoreRun({ run: args.run, data: args.data, noJudge: true, out: `${target}/source-checks` });
const selected = sample.questions.filter(q => sourceRun.options.caseIds.includes(q.user));
const rows = base.rawRows.filter(r => r.kind === 'answer' && selected.some(q => q.qid === r.id));
const packets = [];
for (const sq of selected) {
  const dir = `${args.run}/cases/${sq.user}`;
  const q = (await read(`${args.data}/dev/${sq.user}/gold.json`)).questions.find(q => q.qid === sq.qid);
  const row = rows.find(r => r.id === sq.qid), old = base.packets.find(p => p.rowKey === rowKey(row));
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
  const answer = await read(`${dir}/answer-records/${sq.qid}.json`);
  const snapshot = await read(`${dir}/snapshots/${sq.checkpoint}.json`);
  const anchors = answerAnchors(q.expect);
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
    transcriptNote: 'These excerpts are the actual product-path conversations through the checkpoint. User turns match the source script; assistant turns were generated live and can differ from the original engine replay. Source calendar times are dataset metadata; product conversations use the recorded wall clock. Expected answers are unchanged: dispute gold where the actual conversation contradicts an expected assistant suggestion or attribution; never assume the original assistant text was seen.' });
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
