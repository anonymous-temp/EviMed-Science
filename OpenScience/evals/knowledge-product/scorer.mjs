import { pairedBootstrap, mean } from '../knowledge-pages/lib/stats.mjs';
export function validateBenchmark(b) {
  if (b.cases.length !== 90) throw new Error('Expected 90 questions');
  for (const key of ['id', 'prompt']) if (new Set(b.cases.map(c => c[key])).size !== 90) throw new Error(`duplicate ${key}`);
  for (const s of ['general', 'medical', 'lifecycle']) if (b.cases.filter(c => c.stratum === s).length !== 30) throw new Error(`Invalid ${s} denominator`);
  return true;
}
export function validateObservation(c, r) {
  if (r.caseId !== c.id || r.prompt !== c.prompt) throw new Error('Question identity or unaltered prompt mismatch');
  if (r.actor !== c.actor || r.project !== c.project) throw new Error('Authenticated identity mismatch');
  if (!Number.isFinite(r.score) || r.score < 0 || r.score > 1) throw new Error('Invalid score');
  if (!['baseline', 'candidate'].includes(r.arm) || !Number.isInteger(r.repetition) || r.repetition < 1 || r.repetition > 3) throw new Error('Invalid cell');
  if (!Array.isArray(r.violations) || !Array.isArray(r.citedSources) || !Array.isArray(r.staleSources) || typeof r.abstained !== 'boolean') throw new Error('Missing explicit review fields');
  if (r.staleSources?.length || (r.citedSources ?? []).some(id => !c.sources.includes(id))) throw new Error('Stale or foreign source');
  if (!r.evidence?.runId || !r.evidence?.transcript || !r.evidence?.provider) throw new Error('Missing real runtime evidence');
  return true;
}
export function summarize(b, rows) {
  validateBenchmark(b);
  const cells = new Map();
  for (const r of rows) {
    if (!b.cases.some(c => c.id === r.caseId) || !Number.isFinite(r.score) || r.score < 0 || r.score > 1 || !['baseline','candidate'].includes(r.arm) || ![1,2,3].includes(r.repetition)) throw new Error('Invalid observation');
    const key = `${r.caseId}:${r.arm}:${r.repetition}`;
    if (cells.has(key)) throw new Error('duplicate observation');
    cells.set(key, r);
  }
  const complete = c => ['baseline','candidate'].every(a => [1,2,3].every(i => cells.has(`${c.id}:${a}:${i}`)));
  const result = { verdict: 'inconclusive', strata: {}, lifecycle: {}, unanswerable: {} };
  for (const stratum of ['general','medical']) {
    const all = b.cases.filter(c => c.stratum === stratum);
    const answerable = all.filter(c => !c.unanswerable);
    const differences = answerable.filter(complete).map(c => mean([1,2,3].map(i => cells.get(`${c.id}:candidate:${i}`).score - cells.get(`${c.id}:baseline:${i}`).score)));
    const comparison = pairedBootstrap(differences);
    result.strata[stratum] = { expected: all.length, answerableExpected: answerable.length, complete: all.filter(complete).length, comparison, noninferior: all.every(complete) && comparison.ciLow > -0.02 };
    const absent = all.filter(c => c.unanswerable);
    const records = rows.filter(r => r.arm === 'candidate' && absent.some(c => c.id === r.caseId));
    result.unanswerable[stratum] = { expectedQuestions: absent.length, observedRepetitions: records.length, abstentionRate: records.length ? mean(records.map(r => r.abstained === true ? 1 : 0)) : null };
  }
  result.conditions = {};
  for (const substrate of ['knowledge','memory','combined']) {
    result.conditions[substrate] = {};
    for (const stratum of ['general','medical']) {
      const selected = b.cases.filter(c=>c.stratum===stratum&&c.evaluation?.substrate===substrate&&!c.unanswerable);
      const differences=selected.filter(complete).map(c=>mean([1,2,3].map(i=>cells.get(`${c.id}:candidate:${i}`).score-cells.get(`${c.id}:baseline:${i}`).score)));
      result.conditions[substrate][stratum]={expectedQuestions:selected.length,completeQuestions:selected.filter(complete).length,comparison:pairedBootstrap(differences),independentUnit:'question'};
    }
  }
  result.inputCoverage = Object.fromEntries(['size','language','format'].map(dimension=>[dimension,Object.fromEntries([...new Set(b.cases.map(c=>c.evaluation?.[dimension]).filter(Boolean))].map(value=>[value,b.cases.filter(c=>c.evaluation?.[dimension]===value).length]))]));
  const lifecycle = b.cases.filter(c => c.stratum === 'lifecycle');
  const violations = rows.filter(r => r.arm === 'candidate' && lifecycle.some(c => c.id === r.caseId)).flatMap(r => r.violations ?? []);
  result.lifecycle = { expected: 30, complete: lifecycle.filter(complete).length, violations };
  if (violations.length) result.verdict = 'fail';
  else if (lifecycle.every(complete) && Object.values(result.strata).every(s => s.noninferior) && Object.values(result.unanswerable).every(s => s.abstentionRate === 1)) result.verdict = 'pass';
  return result;
}
