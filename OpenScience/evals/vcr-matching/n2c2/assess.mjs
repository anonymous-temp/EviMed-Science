/**
 * From the model's raw answer for one patient to the thirteen verdicts, by the code a study's matching runs.
 *
 * What the model wrote is checked the way the platform checks it, and nothing is kept on the model's say-so:
 *
 * - `acceptExtractedFacts` (the domain's own closed vocabulary for a batch reading) drops a variable nobody asked about, a
 *   polarity outside the list, a quotation that is missing or does not hold its own surface words.
 * - A quotation must be in the file word for word. Like the batch reading, the position is the first place it occurs. A quotation
 *   that is not in the file is dropped and counted; its fact never reaches the evaluator.
 * - `verifyFactEvidence` (the evaluator's own check of a fact against the bytes it claims) is run at write time, as the fact writer
 *   runs it, and `assessSubject` runs it again before it reasons, as the evaluation of a stored fact does.
 * - A language answer of `satisfied` or `not_satisfied` keeps only the quotations that are in the file; with none left, it is
 *   `unknown`, which is what the evaluator does with an unanchored answer.
 * - The verdicts are `assessSubject`'s: Kleene's strong three-valued logic over the facts, the windows counted back from "now",
 *   the value against the range with its unit. No verdict is the model's own except the four language criteria's, and those
 *   carry the quotation that anchors them.
 *
 * @module n2c2/assess
 */
import { acceptExtractedFacts } from '@evimed/domain';
import { assessSubject, verifyFactEvidence } from '../../../apps/server/src/vcrMatching.mjs';
import { CRITERIA, languageKeysOf, variablesOf } from './criteria.mjs';

const DOCUMENT = 'note';
const STATES = Object.freeze(['satisfied', 'not_satisfied', 'unknown']);

/** @param {Record<string, number>} counts @param {string} reason */
const bump = (counts, reason) => { counts[reason] = (counts[reason] ?? 0) + 1; };

/**
 * @param {{ id: string, text: string, asOf: string | null }} patient
 * @param {unknown} answer the parsed JSON object the model returned (or null when no answer was obtained)
 * @param {readonly any[]} [criteria]
 */
export function assessPatient(patient, answer, criteria = CRITERIA) {
  const text = patient.text;
  const documents = new Map([[DOCUMENT, { id: DOCUMENT, text }]]);
  /** @type {Record<string, number>} */
  const dropped = {};
  const object = answer && typeof answer === 'object' && !Array.isArray(answer) ? /** @type {Record<string, any>} */ (answer) : {};

  const accepted = acceptExtractedFacts(object, new Set(variablesOf(criteria)));
  for (const [reason, count] of Object.entries(accepted.dropped)) dropped[reason] = (dropped[reason] ?? 0) + count;
  const proposed = accepted.facts.length;
  /** @type {any[]} */
  const facts = [];
  for (const item of accepted.facts) {
    const start = text.indexOf(item.quote);
    if (start < 0) { bump(dropped, 'quote_not_found'); continue; }
    const fact = {
      id: `f${facts.length + 1}`, subjectKey: patient.id, variable: item.variable, polarity: item.polarity,
      value: item.value ?? null, unit: item.unit ?? null, occurredAt: item.occurredAt ?? null, recordedAt: null,
      surface: item.surface, dateSurface: item.dateSurface ?? null,
      source: { documentId: DOCUMENT, start, end: start + item.quote.length, quote: item.quote },
      extractedBy: 'model', provenance: { schema: 1, status: 'batch_extraction', factSchema: 2 },
    };
    const checked = verifyFactEvidence(fact, { documents, anyPolarity: true });
    if (!checked.ok) { bump(dropped, String(checked.reason)); continue; }
    facts.push(fact);
  }

  /** @type {Record<string, any>} */
  const modelJudgments = {};
  let languageProposed = 0;
  const keys = new Set(languageKeysOf(criteria));
  for (const item of Array.isArray(object.language_judgments) ? object.language_judgments : []) {
    languageProposed += 1;
    const key = typeof item?.criterionKey === 'string' ? item.criterionKey : '';
    if (!keys.has(key)) { bump(dropped, 'language_key_not_asked'); continue; }
    if (!STATES.includes(item?.state)) { bump(dropped, 'language_state_invalid'); continue; }
    /** @type {any[]} */
    const evidence = [];
    for (const piece of Array.isArray(item.evidence) ? item.evidence.slice(0, 10) : []) {
      const quote = typeof piece?.quote === 'string' ? piece.quote : '';
      const start = quote.trim() ? text.indexOf(quote) : -1;
      if (start < 0) { bump(dropped, 'language_quote_not_found'); continue; }
      evidence.push({ documentId: DOCUMENT, quote, start, end: start + quote.length });
    }
    if (item.state !== 'unknown' && !evidence.length) { bump(dropped, 'language_answer_without_evidence'); continue; }
    modelJudgments[key] = { id: `l-${key}`, state: item.state, evidence: item.state === 'unknown' ? [] : evidence };
  }

  const assessment = assessSubject({
    subjectKey: patient.id, direction: 'trial_to_patient', asOf: patient.asOf ?? '1970-01-01',
    criteria: criteria.map(({ id, kind, criterionType, requirement, sourceText }) => ({ id, kind, criterionType, requirement, sourceText })),
    facts, documents, modelJudgments,
  });

  /** @type {Record<string, 'satisfied' | 'not_satisfied' | 'unknown'>} */
  const states = {};
  /** @type {Record<string, 'code' | 'model'>} */
  const decidedBy = {};
  /** @type {Record<string, string>} */
  const reasons = {};
  for (const [index, criterion] of criteria.entries()) {
    const judgment = assessment.judgments[index];
    states[criterion.tag] = judgment.state === 'satisfied' || judgment.state === 'not_satisfied' ? judgment.state : 'unknown';
    decidedBy[criterion.tag] = judgment.decidedBy;
    if (states[criterion.tag] === 'unknown') reasons[criterion.tag] = String(judgment.missing?.[0]?.reason ?? 'not_recorded');
  }
  return {
    states, decidedBy, reasons,
    facts: { proposed, kept: facts.length, voidedByEvaluator: assessment.voidedFacts.length, dropped },
    language: { proposed: languageProposed, kept: Object.keys(modelJudgments).length },
  };
}
