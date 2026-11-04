/**
 * The boards as the runners read them: the prepared `cases.jsonl` of each board (a patient's note and the candidate
 * trial ids, never a label) and the pure shaping of what the feature saved back into the JSONL `to_official.py` and
 * `score.py` take. Nothing here calls a model, reads a label file or touches a database.
 *
 * A candidate's order is the prepared one (a function of ids only), so what a runner names first carries no
 * information about relevance. The shapes are the ones `prepare.py` writes; see README.md in this directory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Board key -> its directory under the prepared inputs, the scorer that reads it and the kind of answer it wants. */
export const BOARDS = Object.freeze({
  sigir: Object.freeze({ dir: 'A-sigir', scorer: 'a', cohort: 'sigir', answer: 'ranking' }),
  trec2021: Object.freeze({ dir: 'A-trec2021', scorer: 'a', cohort: 'trec_2021', answer: 'ranking' }),
  trec2022: Object.freeze({ dir: 'A-trec2022', scorer: 'a', cohort: 'trec_2022', answer: 'ranking' }),
  nih: Object.freeze({ dir: 'B-nih', scorer: 'b', cohort: 'nih', answer: 'ranking' }),
  c: Object.freeze({ dir: 'C-criterion', scorer: 'c', cohort: 'criterion', answer: 'criteria' }),
});

export const SPLITS = Object.freeze(['dev', 'test', 'all']);

/** A job takes at most this many trials for one person (`VCR_MATCH_JUDGE_LIMITS.trials`); a longer list is several jobs. */
export const JOB_TRIALS = 500;

/** @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** @param {string} message @param {string} code */
export const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * The cases of a board, in file order, for a split. `limit` takes the first N after the split filter, so the same
 * flags select the same patients.
 * @param {string} boardsDir the prepared inputs directory
 * @param {keyof typeof BOARDS} board
 * @param {{ split?: string, limit?: number | null }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function loadCases(boardsDir, board, { split = 'dev', limit = null } = {}) {
  const spec = BOARDS[board];
  if (!spec) throw fail(`Unknown board ${board}: use ${Object.keys(BOARDS).join(', ')}.`, 'board_unknown');
  if (!SPLITS.includes(split)) throw fail(`Unknown split ${split}: use ${SPLITS.join(', ')}.`, 'split_unknown');
  const file = path.join(boardsDir, spec.dir, 'cases.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const chosen = rows.filter((row) => split === 'all' || row.split === split);
  const cut = limit == null ? chosen : chosen.slice(0, Math.max(0, limit));
  for (const row of cut) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(row.patientId ?? ''))) throw fail('A case has an unsafe patient id.', 'case_invalid');
  }
  return cut;
}

/** The collection manifest of a ranking board's cases (every case of a board names the same one). @param {string} boardsDir @param {Array<Record<string, any>>} cases */
export function collectionManifestOf(boardsDir, cases) {
  const names = [...new Set(cases.map((row) => String(row.collection ?? '')))];
  if (names.length !== 1 || !names[0]) throw fail('The cases of a board name one collection.', 'collection_ambiguous');
  return path.join(boardsDir, 'collections', names[0], 'collection.json');
}

/** The partition of a list into runs of at most `size`. @template T @param {readonly T[]} list @param {number} size @returns {T[][]} */
export function chunk(list, size) {
  const out = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

/**
 * The note as it is uploaded. Board C's notes carry the annotators' sentence numbers ("0. ...", one line each); the platform
 * numbers sentences itself, from 0, so the prefixes go and the lines stay. Every other board's note is uploaded as it is.
 * @param {keyof typeof BOARDS} board @param {string} note
 */
export function noteForUpload(board, note) {
  const text = String(note ?? '');
  if (BOARDS[board]?.answer !== 'criteria') return text;
  const lines = text.split('\n');
  return lines.every((line) => /^\d+\.\s/u.test(line)) ? lines.map((line) => line.replace(/^\d+\.\s/u, '')).join('\n') : text;
}

/**
 * A criterion board's trial as a protocol: its annotated clauses in the order the platform numbers them (inclusion first, then
 * exclusion, each by its number; a clause with no words is not a clause there and takes no number). `numbered[k - 1]` is the
 * annotated (kind, number) of the platform's clause k.
 * @param {{ registryId: string, trialTitle?: string, clauses: Array<{ kind: string, number: number, text: string | null, annotationId?: number }> }} trial
 */
export function protocolOf(trial) {
  const rank = (/** @type {string} */ kind) => (kind === 'inclusion' ? 0 : 1);
  const ordered = [...trial.clauses].sort((a, b) => rank(a.kind) - rank(b.kind) || a.number - b.number);
  const spoken = ordered.filter((clause) => String(clause.text ?? '').trim());
  const numbered = spoken.map((clause) => ({ kind: clause.kind, number: clause.number, text: String(clause.text).trim() }));
  const key = sha256(JSON.stringify([trial.registryId, numbered.map((clause) => [clause.kind, clause.number, clause.text])])).slice(0, 16);
  return { key, registryId: trial.registryId, title: String(trial.trialTitle ?? trial.registryId), criteria: numbered.map((clause) => ({ kind: clause.kind, sourceText: clause.text })), numbered };
}

/** Collapse whitespace the way the scorer compares clause words. @param {unknown} value */
const words = (value) => String(value ?? '').split(/\s+/u).filter(Boolean).join(' ');

/**
 * The completion state of a patient in a record, from what is saved: every candidate judged, some, none (with failures), nothing at all.
 * @param {{ candidates: number, judged: number, failed: number }} counts
 */
export function recordStatus({ candidates, judged, failed }) {
  if (judged >= candidates && candidates > 0) return 'complete';
  if (judged > 0) return 'partial';
  return failed > 0 ? 'failed' : 'none';
}

/**
 * The clause rows of one judgment as a record carries them: the clause's number, side and words, the label, the sentence ids that
 * back it, and whether the record stated it (`stated`) or the label stands on silence (`silent`).
 * @param {unknown} rows
 */
export function criteriaRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    number: row.number, kind: row.kind ?? null, label: row.label ?? null, sentenceIds: row.sentenceIds ?? [], basis: row.basis ?? null,
    ...(row.clause != null ? { clause: row.clause } : {}), ...(row.reason ? { reason: row.reason } : {}),
  }));
}

/**
 * One ranking-board record (the shape `to_official.py` reads) from a patient's saved judgments, in the reader's order. A judgment that
 * has clause rows carries them as `criteria`, so the export holds everything the platform saved for the pair. `stageTwo.wanted` is how
 * many clause-level judgments the run was meant to end with: a person whose trials are all scored but who has fewer is `partial`.
 * @param {{ case: Record<string, any>, ranking: Array<Record<string, any>>, failed: Array<{ registryId: string, code: string }>, usage?: Record<string, number> | null, stageTwo?: { wanted: number } | null }} input
 */
export function rankingRecord({ case: row, ranking, failed, usage = null, stageTwo = null }) {
  const known = new Set(row.candidateIds.map(String));
  const seen = new Set();
  const entries = [];
  for (const item of ranking) {
    const registryId = String(item.target?.registryId ?? item.target?.id ?? '');
    if (!known.has(registryId) || seen.has(registryId)) continue;
    seen.add(registryId);
    const criteria = criteriaRows(item.criteria);
    entries.push({ registryId, fit: item.fit ?? null, confidence: item.confidence ?? null, verdict: item.verdict ?? null, rank: entries.length + 1,
      ...(criteria.length ? { criteria } : {}) });
  }
  const lost = failed.filter((entry) => known.has(String(entry.registryId)) && !seen.has(String(entry.registryId)));
  const held = entries.filter((entry) => entry.criteria).length;
  let status = recordStatus({ candidates: row.candidateIds.length, judged: entries.length, failed: lost.length });
  if (status === 'complete' && stageTwo && held < stageTwo.wanted) status = 'partial';
  return {
    patientId: row.patientId,
    status,
    ranking: entries,
    failed: lost.map((entry) => ({ registryId: String(entry.registryId), code: String(entry.code ?? 'unknown') })),
    ...(stageTwo ? { stageTwo: { wanted: stageTwo.wanted, held } } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * One criterion-board record from a patient's saved judgments of each of their trials: the platform's clause k is the annotated
 * (kind, number) `numbered[k - 1]` of that trial's protocol, and a row whose clause words differ from the annotated ones is counted, not hidden.
 * @param {{ case: Record<string, any>, byTrial: Map<string, { ranking: Array<Record<string, any>>, numbered: Array<{ kind: string, number: number, text: string }> }>, failed: Array<{ registryId: string, code: string }>, usage?: Record<string, number> | null }} input
 */
export function criterionRecord({ case: row, byTrial, failed, usage = null }) {
  const entries = [];
  let textDiffers = 0;
  let judgedTrials = 0;
  for (const trial of row.trials) {
    const own = byTrial.get(String(trial.registryId));
    const judgment = own?.ranking?.[0];
    if (!own || !judgment) continue;
    judgedTrials += 1;
    const criteria = [];
    for (const clause of judgment.criteria ?? []) {
      const at = own.numbered[Number(clause.number) - 1];
      if (!at) continue;
      if (clause.clause != null && words(clause.clause) !== words(at.text)) textDiffers += 1;
      criteria.push({ kind: at.kind, number: at.number, label: clause.label ?? null, sentenceIds: clause.sentenceIds ?? [], basis: clause.basis ?? null, text: at.text });
    }
    entries.push({ registryId: String(trial.registryId), fit: judgment.fit ?? null, confidence: judgment.confidence ?? null, verdict: judgment.verdict ?? null, rank: entries.length + 1, criteria });
  }
  return {
    patientId: row.patientId,
    status: recordStatus({ candidates: row.trials.length, judged: judgedTrials, failed: failed.length }),
    ranking: entries,
    failed: failed.map((entry) => ({ registryId: String(entry.registryId), code: String(entry.code ?? 'unknown') })),
    ...(textDiffers ? { clauseTextDiffers: textDiffers } : {}),
    ...(usage ? { usage } : {}),
  };
}
