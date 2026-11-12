/**
 * Board F, the n2c2 2018 Track 1 cohort-selection notes, on the platform's judging job: one protocol (the thirteen criteria in the
 * annotation guide's own wording, in the order the official scorer prints them) judged against a roster of patients, each patient's
 * record kept as the dated documents it came in. The model answers each clause with one of the six labels; `score.py f` reads the
 * labels as met or not met under stated readings and runs the official scorer, unchanged.
 *
 * The notes are real. Nothing here prints one, and a run's logs and summaries carry counts only.
 */
import { CRITERIA, TAGS } from '../vcr-matching/n2c2/criteria.mjs';
import { sha256 } from './board_cases.mjs';

export { TAGS };

/** The protocol the job judges: the guide's wording, every clause an inclusion, clause k of the platform being tag k of the scorer. */
export function n2c2Protocol() {
  const criteria = CRITERIA.map((criterion) => ({ kind: 'inclusion', criterionType: 'other', sourceText: criterion.sourceText }));
  return { key: sha256(JSON.stringify(criteria.map((criterion) => criterion.sourceText))).slice(0, 16), title: 'n2c2 2018 Track 1: cohort selection criteria', criteria, tags: [...TAGS] };
}

/**
 * Each record of a patient as a dated document: the text exactly as the file holds it from its `Record date:` line to the next, the date
 * as the instant the record becomes visible, in the order of the file.
 * @param {string} text @returns {Array<{ date: string, text: string }>}
 */
export function recordsOfNote(text) {
  const heads = [...String(text).matchAll(/^Record date: (\d{4}-\d{2}-\d{2})[ \t]*$/gmu)];
  return heads.map((head, index) => ({ date: head[1], text: String(text).slice(head.index, heads[index + 1]?.index ?? String(text).length).replace(/\s+$/u, '') }));
}

/** @param {unknown} label @returns {'met' | 'not met' | 'unknown'} the reading every scorer starts from: a stated yes, a stated no, or neither */
export function stateOfLabel(label) {
  const text = String(label ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
  return text === 'included' ? 'met' : text === 'not_included' ? 'not met' : 'unknown';
}

/**
 * One patient's record for the scorer: the label and basis of each of the thirteen tags, from the clause rows the reader returns for the
 * protocol (clause k is tag k), and whether the clause words are the guide's.
 * @param {{ case: Record<string, any>, judgment: Record<string, any> | null | undefined, failed?: Array<{ registryId: string, code: string }>, usage?: Record<string, number> | null }} input
 */
export function n2c2Record({ case: row, judgment, failed = [], usage = null }) {
  /** @type {Record<string, { label: string | null, basis: string | null, sentenceIds: number[] }>} */
  const labels = {};
  let textDiffers = 0;
  for (const clause of judgment?.criteria ?? []) {
    const tag = TAGS[Number(clause.number) - 1];
    if (!tag) continue;
    labels[tag] = { label: clause.label ?? null, basis: clause.basis ?? null, sentenceIds: clause.sentenceIds ?? [] };
    if (clause.clause != null && String(clause.clause).split(/\s+/u).join(' ') !== CRITERIA[Number(clause.number) - 1].sourceText.split(/\s+/u).join(' ')) textDiffers += 1;
  }
  const held = Object.keys(labels).length;
  return {
    patientId: row.patientId,
    status: held === TAGS.length ? 'complete' : held ? 'partial' : failed.length ? 'failed' : 'none',
    labels,
    failed: failed.map((entry) => ({ code: String(entry.code ?? 'unknown') })),
    ...(textDiffers ? { clauseTextDiffers: textDiffers } : {}),
    ...(usage ? { usage } : {}),
  };
}
