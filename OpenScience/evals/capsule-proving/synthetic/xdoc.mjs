#!/usr/bin/env node
/**
 * Cross-document synthesis questions for the knowledge-pages instrument, written by the generator model (Kimi) and verified by
 * the instrument's own corpus check (`knowledge-pages/lib/corpus.mjs`, imported, not re-implemented): every key point's support
 * quote must be verbatim in the document it names and a synthesis question must draw on at least two documents.
 *
 *   node synthetic/xdoc.mjs --out DIR [--topics a,b] [--target 15] [--per-batch 9] [--max-batches 4] [--status FILE]
 *
 * Output: `<out>/<topic>/bNN.json` (one file per topic per batch: accepted questions, what was dropped and why), then
 * `<out>/<topic>/questions.json` and `<out>/manifest.json` (counts, generator per file, sha256 per file, dev/sealed split:
 * the first 6 accepted questions of a topic are dev, the rest sealed). Resumable: a batch file that exists is skipped, and each
 * finished step is appended to the STATUS file. A question that fails verification goes back once with the exact problems
 * named; if it still fails it is dropped. Near-duplicates (same document set and high token overlap) of an existing question
 * or of an accepted one are dropped. Question ids are assigned by code (`af-x01`…); the model's ids are ignored.
 * @module capsule-proving/synthetic/xdoc
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GENERATOR, callKimi } from './kimi.mjs';
import { checkTopic, loadTopic } from '../../knowledge-pages/lib/corpus.mjs';

export const ID_PREFIX = { 'af-doac-warfarin': 'af', 'sglt2-hf-ckd': 'sg', 'aspirin-primary-prevention': 'as' };
export const DEV_PER_TOPIC = 6;
export const TYPES = [
  'compare effect sizes (hazard ratios, relative risks, absolute rates) across trials',
  'reconcile apparently conflicting results between documents',
  'a population or subgroup contrast (age, kidney function, ejection fraction, diabetes status, region, baseline risk)',
  'a safety-versus-efficacy trade-off drawn from more than one document',
  'a dose, regimen or comparator difference between documents',
  'what a meta-analysis adds to, or changes about, the single trials',
  'a time or guideline evolution question (earlier versus later evidence, how the recommendation moved)',
];
export const DUP_OVERLAP = 0.55;

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g)?.filter((w) => w.length > 2) ?? []);

/** Jaccard overlap of two question texts' tokens. */
export function overlap(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** The set of document keys a question's support quotes name, as a sorted key. */
export const docSet = (q) => [...new Set((q?.reference?.keyPoints ?? []).flatMap((p) => (p?.support ?? []).map((s) => s?.doc)))].filter(Boolean).sort();

/** The question in `others` this one repeats (same document set AND token overlap ≥ DUP_OVERLAP), or null. */
export function findDuplicate(q, others) {
  const mine = docSet(q).join('|');
  for (const o of others) if (docSet(o).join('|') === mine && overlap(q.question, o.question) >= DUP_OVERLAP) return o;
  return null;
}

const schemaText = `{"questions":[{"kind":"synthesis","question":"...","reference":{"keyPoints":[{"id":"kp1","text":"...","support":[{"doc":"<document key>","quote":"<verbatim substring of that document>"}]}]}}]}`;

function documentsBlock(topic) {
  return topic.documents.map((d) => `=== DOCUMENT key=${d.key} ===\nTitle: ${d.title}\n(${d.journal}, ${d.year})\n${d.text.trim()}`).join('\n\n');
}

const rules = `Rules:
- Each question must need at least two documents to answer; prefer three or more. The question must be answerable from the abstracts alone.
- Give 2 to 5 key points per question. A key point is a decidable statement (numbers, directions, populations), and each carries one or more support entries.
- Every support "quote" must be copied character for character from the named document's text (10 to 300 characters, a contiguous stretch, no ellipses, no edits). "doc" is the document key shown in the header.
- A question that is about a single document is not wanted. Do not invent facts that the abstracts do not state.
- Do not repeat or paraphrase any existing question or any question already listed below.
- Reply with one JSON object and nothing else, in exactly this shape: ${schemaText}`;

/**
 * The prompt for one batch. @param {{ id: string, title: string, documents: any[], questions: any[] }} topic
 * @param {{ count: number, taken?: string[], batch?: number }} o
 */
export function buildPrompt(topic, { count, taken = [], batch = 0 }) {
  const focus = [...TYPES.slice(batch % TYPES.length), ...TYPES.slice(0, batch % TYPES.length)];
  const existing = topic.questions.filter((q) => q.kind === 'synthesis').map((q) => `- ${q.question}`);
  return `You are writing evaluation questions for a medical evidence-synthesis test. Topic: ${topic.title}.
Below are the topic's ${topic.documents.length} documents (PubMed abstracts). Write ${count} NEW cross-document synthesis questions, each drawing on at least two documents.
Vary the type across the batch; types to cover (start with the first ones listed): ${focus.map((t, i) => `${i + 1}. ${t}`).join('; ')}.

${documentsBlock(topic)}

Existing synthesis questions (do not repeat):
${existing.join('\n') || '(none)'}
${taken.length ? `\nQuestions already accepted in this run (do not repeat):\n${taken.map((t) => `- ${t}`).join('\n')}\n` : ''}
${rules}`;
}

/** The repair prompt: only the questions that failed, each with its exact problems. */
export function buildRepairPrompt(topic, failed) {
  const body = failed.map((f, i) => `Question ${i + 1}: ${JSON.stringify(f.q)}\nProblems:\n${f.problems.map((p) => `  - ${p}`).join('\n')}`).join('\n\n');
  return `You wrote cross-document questions for a medical evidence test. Topic: ${topic.title}. The checker found the problems listed under each question below. Fix only what is named: replace a bad quote by a verbatim stretch of the named document (or point the key point at the document that does say it), keep everything else. Return every question, corrected.

${documentsBlock(topic)}

${body}

${rules}`;
}

/**
 * Verify one candidate with the instrument's own check. Returns the problems (empty: it stands) and the cleaned question.
 * The instrument's per-topic count rule (5 synthesis + 4 single) is not applied; every other check is.
 */
export function verifyQuestion(topic, raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return { problems: ['not an object'], question: null };
  if (raw.kind !== 'synthesis') problems.push('kind must be "synthesis"');
  const points = Array.isArray(raw.reference?.keyPoints) ? raw.reference.keyPoints : [];
  const q = {
    id: 'candidate', kind: 'synthesis', question: typeof raw.question === 'string' ? raw.question.trim() : '',
    reference: { keyPoints: points.map((p, i) => ({ id: `kp${i + 1}`, text: p?.text, support: Array.isArray(p?.support) ? p.support.map((s) => ({ doc: s?.doc, quote: s?.quote })) : p?.support })) },
  };
  const issues = checkTopic({ ...topic, questions: [q] }).filter((m) => m.startsWith(`${topic.id}/candidate`));
  problems.push(...issues.map((m) => m.replace(`${topic.id}/candidate`, 'question')));
  if (points.length < 2) problems.push('needs at least 2 key points');
  if (!problems.length && docSet(q).length < 2) problems.push('draws on fewer than 2 documents');
  return { problems, question: q };
}

/**
 * One batch: ask, verify, repair the failures once, drop what still fails or repeats. `call(prompt)` returns the wrapper's result.
 * @returns {Promise<{ accepted: any[], dropped: Array<{ reason: string, question: string }>, repaired: number, asked: number, error?: string }>}
 */
export async function runBatch(topic, { count, taken = [], batch = 0, prior = [] }, call) {
  const accepted = [];
  const dropped = [];
  let repaired = 0;
  const first = await call(buildPrompt(topic, { count, taken: taken.length ? taken : prior.map((q) => q.question), batch }));
  if (!first.ok) return { accepted, dropped, repaired, asked: 0, error: first.error };
  const list = Array.isArray(first.value?.questions) ? first.value.questions : [];
  const others = () => [...topic.questions, ...prior, ...accepted];
  const accept = (q, others) => {
    const dup = findDuplicate(q, others);
    if (dup) { dropped.push({ reason: `near-duplicate of "${dup.question.slice(0, 80)}"`, question: q.question }); return false; }
    accepted.push(q);
    return true;
  };
  const failed = [];
  for (const raw of list) {
    const { problems, question } = verifyQuestion(topic, raw);
    if (problems.length) failed.push({ q: raw, problems });
    else accept(question, others());
  }
  if (failed.length) {
    const r = await call(buildRepairPrompt(topic, failed));
    const fixed = r.ok && Array.isArray(r.value?.questions) ? r.value.questions : [];
    failed.forEach((f, i) => {
      const { problems, question } = verifyQuestion(topic, fixed[i]);
      if (problems.length) { dropped.push({ reason: `still failing after repair: ${problems.slice(0, 3).join('; ')}`, question: String(f.q?.question ?? '').slice(0, 200) }); return; }
      if (accept(question, others())) repaired += 1;
    });
  }
  return { accepted, dropped, repaired, asked: list.length };
}

// ---- driver ----------------------------------------------------------------------------------------------------------

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]] : a), []));
const now = () => new Date().toISOString();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { const t = `${JSON.stringify(v, null, 1)}\n`; writeFileSync(p, t); if (readFileSync(p, 'utf8').length !== t.length) throw new Error(`short write ${p}`); };

async function main() {
  const out = args.out ?? (() => { throw new Error('--out required'); })();
  const target = Number(args.target ?? 15);
  const perBatch = Number(args['per-batch'] ?? 9);
  const maxBatches = Number(args['max-batches'] ?? 4);
  const statusFile = args.status ?? join(dirname(out), 'STATUS');
  const status = (line) => appendFileSync(statusFile, `${now()} xdoc ${line}\n`);
  const say = (line) => process.stdout.write(`${now()} ${line}\n`);
  const topicIds = String(args.topics ?? Object.keys(ID_PREFIX).join(',')).split(',');
  mkdirSync(out, { recursive: true });
  const call = (prompt) => callKimi(prompt);
  const summary = {};

  for (const id of topicIds) {
    const topic = await loadTopic(id);
    const dir = join(out, id);
    mkdirSync(dir, { recursive: true });
    const batchFiles = [];
    for (let b = 0; b < maxBatches; b++) {
      const file = join(dir, `b${String(b).padStart(2, '0')}.json`);
      const prior = batchFiles.flatMap((f) => readJson(f).accepted);
      if (prior.length >= target) break;
      if (existsSync(file)) { batchFiles.push(file); continue; }
      let result = null;
      for (let attempt = 1; attempt <= 3 && !result; attempt++) {
        const r = await runBatch(topic, { count: perBatch, prior, batch: b }, call);
        if (r.error) { say(`${id} b${b} attempt ${attempt}: ${r.error}`); continue; }
        result = r;
      }
      if (!result) { say(`${id} b${b}: generator unusable, stopping this topic`); break; }
      writeJson(file, { topic: id, batch: b, generator: GENERATOR, asked: result.asked, repaired: result.repaired, accepted: result.accepted, dropped: result.dropped });
      batchFiles.push(file);
      say(`${id} b${b}: asked ${result.asked}, accepted ${result.accepted.length}, repaired ${result.repaired}, dropped ${result.dropped.length}`);
      status(`DONE ${id} b${b} (asked ${result.asked}, accepted ${result.accepted.length}, repaired ${result.repaired}, dropped ${result.dropped.length}, ${GENERATOR})`);
    }
    // Assemble: batches in order, the topic's target of accepted questions, ids by code.
    const batches = batchFiles.map((f) => readJson(f));
    const all = [];
    for (const bt of batches) for (const q of bt.accepted) if (!findDuplicate(q, [...topic.questions, ...all.map((x) => x.q)])) all.push({ q, generator: bt.generator });
    const chosen = all.slice(0, target);
    const prefix = ID_PREFIX[id];
    const questions = chosen.map(({ q }, i) => ({ id: `${prefix}-x${String(i + 1).padStart(2, '0')}`, kind: 'synthesis', question: q.question, reference: q.reference }));
    const problems = checkTopic({ ...topic, questions }).filter((m) => m.includes(`${id}/`) && !m.startsWith(`${id}/pmid`));
    if (problems.length) throw new Error(`assembled ${id} fails the instrument check: ${problems.slice(0, 3).join(' | ')}`);
    writeJson(join(dir, 'questions.json'), {
      schemaVersion: 1, topic: id, generator: [...new Set(chosen.map((c) => c.generator))],
      note: 'Cross-document synthesis questions written by an outside model; every support quote verified verbatim by the knowledge-pages corpus check.', questions,
    });
    summary[id] = { chosen, questions, batches };
    status(`DONE ${id} assembled (${questions.length} questions)`);
    say(`${id}: ${questions.length} questions`);
  }

  const files = {};
  const topics = {};
  const dist = {};
  for (const [id, s] of Object.entries(summary)) {
    files[`${id}/questions.json`] = sha256(readFileSync(join(out, id, 'questions.json')));
    for (const bt of s.batches) { const n = `${id}/b${String(bt.batch).padStart(2, '0')}.json`; files[n] = sha256(readFileSync(join(out, n))); }
    const ids = s.questions.map((q) => q.id);
    const byGenerator = {};
    for (const c of s.chosen) byGenerator[c.generator] = (byGenerator[c.generator] ?? 0) + 1;
    for (const q of s.questions) { const n = docSet(q).length; dist[n] = (dist[n] ?? 0) + 1; }
    topics[id] = {
      accepted: ids.length, dev: ids.slice(0, DEV_PER_TOPIC), sealed: ids.slice(DEV_PER_TOPIC), generators: byGenerator,
      asked: s.batches.reduce((a, b) => a + b.asked, 0), repaired: s.batches.reduce((a, b) => a + b.repaired, 0), dropped: s.batches.reduce((a, b) => a + b.dropped.length, 0),
      batchGenerators: Object.fromEntries(s.batches.map((b) => [`b${String(b.batch).padStart(2, '0')}`, b.generator])),
    };
  }
  writeJson(join(out, 'manifest.json'), {
    schema: 'capsule-proving-knowledge-xdoc/1', generatedAt: now(), generatorScript: 'evals/capsule-proving/synthetic/xdoc.mjs', generator: GENERATOR, target,
    totals: { accepted: Object.values(topics).reduce((a, t) => a + t.accepted, 0), dev: Object.values(topics).reduce((a, t) => a + t.dev.length, 0), sealed: Object.values(topics).reduce((a, t) => a + t.sealed.length, 0) },
    documentsPerQuestion: dist, topics, sha256: files,
  });
  status(`DONE manifest (${Object.values(topics).map((t) => t.accepted).join('+')} questions, ${GENERATOR})`);
  say(`manifest written: ${JSON.stringify(Object.fromEntries(Object.entries(topics).map(([k, t]) => [k, [t.dev.length, t.sealed.length]])))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
