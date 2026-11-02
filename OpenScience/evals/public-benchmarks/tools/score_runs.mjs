#!/usr/bin/env node
// Scores recorded answers with the lab's own scorers: stdin {"jobs": [...]}, stdout {"results": [...]}. Nothing is ported here.
//
// The scorers are evals/rsi-campaigns/harness_scorers.mjs (medcalc, arb-deep, arb-wide, bixbench-deterministic, mbc-normalized; the
// judged scorer has no code and is refused), called exactly as the lab calls them: a run that did not succeed is scored on a null
// answer (`harness_campaign.mjs` runScore), a row must pass the scorer's own `validRow`. A job is
//   {id, scorer, row, answer, atCapAnswer?}
// where `answer` is the text the lab would score (null unless the run succeeded) and `atCapAnswer` is the draft a timed-out run left,
// scored apart as `scoreAtCap` and never mixed into `score`. A result is {id, score, scoreAtCap?, detail?} or {id, error[, detail]}; `detail`
// carries the verdicts the same module computes for the two scorers that leave cases to a judge (bixbench-deterministic: one verdict
// per question; mbc-normalized: the case verdict), so the tables can state how far the code score is from a judged one.
// Used by score_round.py and judged_packets_round.py; run with node >= 22.
import { HARNESS_SCORERS, mbcVerdict } from '../../rsi-campaigns/harness_scorers.mjs';
import { bixbenchAnswers, bixbenchDeterministic, bixbenchVerdict } from '../../rsi-campaigns/skill_scorers.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { jobs } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

/** @param {any} job @param {string | null} answer */
function detailOf(job, answer) {
  if (job.scorer === 'bixbench-deterministic') {
    const { answers, extraction } = bixbenchAnswers(answer);
    return {
      extraction,
      questions: job.row.gold.questions.map((q) => ({ n: q.n, qid: q.qid, evalMode: q.eval_mode, deterministic: bixbenchDeterministic(q), verdict: bixbenchVerdict(q, answers.get(q.n)) })),
    };
  }
  if (job.scorer === 'mbc-normalized') {
    const { verdict, extraction, extracted } = mbcVerdict(answer, job.row.gold);
    return { verdict, extraction, extracted };
  }
  return undefined;
}

const results = jobs.map((job) => {
  const scorer = Object.hasOwn(HARNESS_SCORERS, job.scorer) ? HARNESS_SCORERS[job.scorer] : null;
  if (!scorer || scorer.judged) return { id: job.id, error: 'scorer_not_code' };
  try {
    if (!scorer.validRow(job.row)) {
      // bixbench-deterministic refuses a capsule whose questions a judge must settle all of; the verdicts are still the module's own.
      const detail = job.scorer === 'bixbench-deterministic' && Array.isArray(job.row?.gold?.questions) ? detailOf(job, job.answer ?? null) : undefined;
      return detail ? { id: job.id, error: 'row_invalid', detail } : { id: job.id, error: 'row_invalid' };
    }
    const out = { id: job.id, score: scorer.score(job.answer ?? null, job.row) };
    if (typeof job.atCapAnswer === 'string') out.scoreAtCap = scorer.score(job.atCapAnswer, job.row);
    const detail = detailOf(job, job.answer ?? null);
    if (detail) out.detail = detail;
    return out;
  } catch (error) {
    return { id: job.id, error: `scorer_threw: ${String(error?.message ?? error).slice(0, 120)}` };
  }
});
process.stdout.write(JSON.stringify({ results }));
