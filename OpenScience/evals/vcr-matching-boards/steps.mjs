/**
 * How a patient's judging is cut into jobs, and what is left of it. Pure: no database, no model.
 *
 * A job takes at most `JOB_TRIALS` trials of one person, so a longer candidate list is several jobs. Stage one (the trial-level
 * score) can be cut anywhere; stage two (clause by clause, for the best `topK` of a person) cannot: "best" is the person's, not a
 * chunk's. So a person above the chunk size is judged in two phases, the way one job does it for a smaller list: every chunk at
 * stage one, then one job at stage two over the person's own best `topK` (ranked from the saved stage-one rows, by the same
 * function the job uses, so a rerun picks the same trials). A person within one job is judged as the product does it, in one job.
 */
import { rankJudgments } from '@evimed/domain';
import { JOB_TRIALS, chunk } from './board_cases.mjs';

/**
 * The steps of one person on a ranking board.
 * @param {{ ids: readonly string[], mode: 'fit' | 'criteria' | 'both', topK: number | 'all', jobTrials?: number }} input
 * @returns {{ steps: Array<{ ids: string[], fit: boolean, topK: number | 'all' }>, follow: number }} `follow` is the K of the second phase, or 0
 */
export function rankingSteps({ ids, mode, topK, jobTrials = JOB_TRIALS }) {
  const all = [...ids];
  const chunks = chunk(all, jobTrials);
  if (mode === 'fit' || (mode === 'both' && topK === 0)) return { steps: chunks.map((part) => ({ ids: part, fit: true, topK: 0 })), follow: 0 };
  if (mode === 'criteria') {
    // Without stage one nothing ranks the trials, so "the first K" are the first K named; all of them is every chunk.
    return topK === 'all'
      ? { steps: chunks.map((part) => ({ ids: part, fit: false, topK: 'all' })), follow: 0 }
      : { steps: [{ ids: all.slice(0, Number(topK)), fit: false, topK: 'all' }], follow: 0 };
  }
  if (topK === 'all') return { steps: chunks.map((part) => ({ ids: part, fit: true, topK: 'all' })), follow: 0 };
  if (chunks.length <= 1) return { steps: [{ ids: all, fit: true, topK: Number(topK) }], follow: 0 };
  return { steps: chunks.map((part) => ({ ids: part, fit: true, topK: 0 })), follow: Math.min(Number(topK), all.length) };
}

/**
 * How many clause-level judgments a person is meant to end with.
 * @param {{ candidates: number, mode: 'fit' | 'criteria' | 'both', topK: number | 'all' }} input
 */
export function stageTwoWanted({ candidates, mode, topK }) {
  if (mode === 'fit') return 0;
  return topK === 'all' ? candidates : Math.min(Number(topK), candidates);
}

/**
 * A person's best `k` of `ids` by their saved stage-one rows: the order the job itself uses (score, then confidence, then id), over
 * the finished rows only, so the same rows give the same trials on every run.
 * @param {ReadonlyArray<{ mode: string, status: string, targetId: string, fit: number | null, confidence: number | null }>} rows @param {readonly string[]} ids @param {number} k
 */
export function bestOf(rows, ids, k) {
  const wanted = new Set(ids);
  const judged = rows.filter((row) => row.mode === 'fit' && row.status === 'done' && wanted.has(row.targetId)).map((row) => ({ id: row.targetId, fit: row.fit, confidence: row.confidence }));
  return rankJudgments(judged).slice(0, k).map((row) => String(row.id));
}

/**
 * What a step still has to do, from the targets a person already has finished rows for in each mode.
 * @param {{ ids: readonly string[], fit: boolean, topK: number | 'all' }} step
 * @param {{ fit: ReadonlySet<string>, criteria: ReadonlySet<string> }} done
 * @returns {{ fit: number, criteria: number, complete: boolean }}
 */
export function stepRemaining(step, done) {
  const fit = step.fit ? step.ids.filter((id) => !done.fit.has(id)).length : 0;
  const wanted = !step.fit ? step.ids.length : step.topK === 'all' ? step.ids.length : Math.min(Number(step.topK), step.ids.length);
  const held = step.ids.filter((id) => done.criteria.has(id)).length;
  const criteria = Math.max(0, wanted - held);
  return { fit, criteria, complete: fit === 0 && criteria === 0 };
}
