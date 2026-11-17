/** Offline question/evidence audits. Findings quarantine the measurement, never certify a product error. */
import { containsAnchor } from './scoreChecks.mjs';

const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const textOf = session => (session.messages ?? []).map(m => m.text ?? m.content ?? '').join('\n');
const emptyGold = /^(?:unknown|unanswerable|not (?:known|stated|provided)|cannot (?:answer|determine)|无法回答|未提及|不知道)[.!。]?$/i;
const key = row => JSON.stringify([row.set, row.split, row.caseId, row.kind ?? 'answer', row.id, row.checkpoint ?? null]);

export function mergeErrata(existing, findings) {
  const result = new Map(existing.map(row => [key(row), row]));
  for (const row of findings) {
    const previous = result.get(key(row));
    result.set(key(row), previous ? { ...previous, findings: [...(previous.findings ?? [previous.code ?? previous.reason]), row.code ?? row.reason] } : row);
  }
  return [...result.values()];
}

/** Literal support is a diagnostic signal only: paraphrases and deduction require review.
 * Confirmed schema contradictions can exclude a question from valid-only accuracy; suspect lexical matches cannot.
 */
export function checkQuestionData(entry, loaded, { set, split, answers: capturedAnswers = [] }) {
  const findings = [];
  for (const q of entry.gold.questions ?? []) {
    const official = q.official ?? {}, metadata = official.metadata ?? {};
    const at = q.checkpoint ?? loaded?.questions?.find(item => item.qid === q.qid)?.afterSession ?? q.afterSession;
    const sessions = (loaded?.sessions ?? []).slice(0, at).filter(s => !q.asOf || !s.at || Date.parse(s.at) <= Date.parse(q.asOf));
    const history = sessions.map(textOf).join('\n');
    const evidence = strings(official.source_key_points ?? official.key_memories ?? official.memories ?? (set.startsWith('locomo') ? null : official.evidence)).join('\n');
    const answers = (official.answers ?? []).filter(a => a.is_correct === true);
    const values = answers.length ? answers.flatMap(a => strings(a.content)) : strings(official.answer ?? official.reference_answer);
    const abstention = q.category === 'abstention' || metadata.unanswerable === true || official.unanswerable === true || official.adversarial === true || values.some(v => emptyGold.test(v));
    const add = (code, reason, confirmed = false) => findings.push({ set, split, caseId: entry.caseId, kind: 'answer', id: q.qid,
      checkpoint: at ?? null, code, reason, status: confirmed ? 'quarantined' : 'review', confirmed,
      evidenceSessionIds: sessions.map(s => s.sessionId), decidedBy: 'offline-data-check' });
    if (!abstention && evidence && values.length && values.some(v => !containsAnchor(evidence, v)))
      add('evidence_gold_mismatch', 'Supplied evidence has no literal support for at least one gold value; semantic/deductive support requires review.');
    const question = q.question ?? q.text ?? official.question ?? '';
    if (/when|event date|surgery|何时|什么时候|日期|手术/i.test(question)) {
      for (const v of values.filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) {
        if (sessions.some(s => String(s.at).slice(0, 10) === v) && !containsAnchor(history, v))
          add('record_date_as_event_date', 'Gold equals a session record date absent from the event text; event dating requires review.');
      }
    }
    const format = JSON.stringify(metadata) + ' ' + (q.expect?.judge ?? '');
    if (answers.length > 1 && /single[ _-]*(?:best|choice|answer)|one correct|单选|唯一正确/i.test(format))
      add('multiple_answers_single_best', 'More than one official correct answer is paired with a single-answer rubric.', true);
    const answerable = strings(metadata.answerable_value ?? metadata.expected_value ?? official.adversarial_answer);
    if (abstention && history && (answerable.some(v => containsAnchor(history, v)) || evidence && containsAnchor(history, evidence)))
      add('answerable_abstention', 'An answer candidate occurs in the source sessions; the question/subject binding requires review.', metadata.answerable === true);
    const anchors = strings([q.expect?.mustContain, q.expect?.exact, q.expect?.mustContainAny]);
    const statedHan = /\p{Script=Han}/u.test(entry.gold.stated ?? '');
    const captured = capturedAnswers.find(a => a.qid === q.qid)?.answer;
    const translatedReply = typeof captured === 'string' && /\p{Script=Han}/u.test(captured) && anchors.some(a => !/\p{Script=Han}/u.test(a)) && !anchors.some(a => containsAnchor(captured, a));
    if (set === 'brand-generic' && (anchors.some(a => /\p{Script=Han}/u.test(a) !== statedHan) || translatedReply))
      add('translated_verbatim_anchor', 'The source drug is translated while the rubric requires an untranslated literal anchor; equivalence needs semantic review.');
  }
  return findings;
}
