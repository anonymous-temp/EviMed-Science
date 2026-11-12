/** Reports are authenticated resources rendered from saved, erasure-aware judgments.
 * There is no second copy of patient rationales to survive a withdrawal. */
import { validateMatchingResult } from '@evimed/patient-matching-core';
import { csvLine } from './vcrMatchResults.mjs';
export function renderPatientMatchingReport(result, format = 'markdown') {
  validateMatchingResult(result);
  if (format === 'json') return { extension: 'json', contentType: 'application/json; charset=utf-8', text: `${JSON.stringify(result, null, 2)}\n` };
  if (format === 'csv') return { extension: 'csv', contentType: 'text/csv; charset=utf-8', text: '\uFEFF' + csvLine(['Patient', 'Trial', 'Work state', 'Clinical eligibility', 'Priority', 'Rationale', 'Unresolved facts', 'Assumptions']) + result.rows.map(row => csvLine([row.subjectKey, row.trialId, row.state, row.clinicalEligibility, row.recommendation.priority, row.recommendation.rationale, row.unresolvedFacts.join('; '), row.assumptions.join('; ')])).join('') };
  if (format !== 'markdown') throw new TypeError('Unsupported matching report format.');
  const clean = value => String(value).replace(/[\r\n]/g, ' ').replaceAll('|','\\|');
  return { extension: 'md', contentType: 'text/markdown; charset=utf-8', text: `# Patient matching\n\nState: ${result.state}. Assessed: ${result.counts.complete}/${result.counts.requested}.\n\n| Patient | Trial | Work state | Clinical eligibility | Priority | Rationale |\n| --- | --- | --- | --- | --- | --- |\n${result.rows.map(row => `| ${[row.subjectKey,row.trialId,row.state,row.clinicalEligibility,row.recommendation.priority ?? '',row.recommendation.rationale].map(clean).join(' | ')} |`).join('\n')}\n\n${result.rows.map(row => `## ${clean(row.subjectKey)} / ${clean(row.trialId)}\n\n${row.criteria.map(criterion => `- ${clean(criterion.criterionId)}: ${criterion.verdict} (${criterion.basis}). ${clean(criterion.reason)}`).join('\n')}\n\nUnresolved facts: ${row.unresolvedFacts.map(clean).join('; ') || 'None stated'}.\n\nAssumptions: ${row.assumptions.map(clean).join('; ') || 'None stated'}.`).join('\n\n')}\n${(result.openQuestions ?? []).length ? `\n## Open questions\n\n${result.openQuestions.map(question => `- ${clean(question.fact)}: decides ${question.pairs} pair(s) (${question.trials.map(clean).join(', ')})`).join('\n')}\n` : ''}` };
}
