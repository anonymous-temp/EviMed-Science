import { inputDigest } from './memoryHumanSegments.mjs';
import { isGoalContinuation, roundProducedFiles, setsResearchGoal } from './researchGoalState.mjs';

const labels = new Map(Object.entries({
  active:'进行中', paused:'已暂停', finished:'已完成', waiting:'等待继续', interrupted:'已中断', stopped:'已停止',
}));
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

/** Reopen the two business records on each read. The goal supplies current
 * state and the completed automatic round supplies a link to its outputs.
 * Nothing is written into the engine, a method, or a history window. */
export function createGoalStatusReader({ config, contexts, documents, projectFor, runsOf, permitted, resetInstant }) {
  return async function read(userId, projectId, sessionId = null, query = null, limit = 3) {
    if (!config.memoryGoalStatusEnabled || !contexts || !documents) return [];
    const project = await projectFor(userId, projectId);
    if (!project || project.userId !== userId || !await permitted(project, sessionId)) return [];
    const context = await contexts.forProject(project);
    if (context.kind !== 'owned') return [];
    const page = await documents.list(userId, 'research-goal', {projectId, limit:100});
    if (!page.items.length) return [];
    const reset = await resetInstant(userId);
    const index = await runsOf(project);
    const results = [];
    for (const doc of page.items) {
      const goal = doc.payload;
      if (doc.projectId !== projectId || !validId(goal.sessionId) || doc.id !== 'goal-' + goal.sessionId || !labels.has(goal.status)) continue;
      const rows = index.get(goal.sessionId) ?? [];
      if (rows.some(run => run.deleted || run.forkedFrom)) continue;
      // A person can replace a goal in the same conversation. Never attribute
      // the old goal's outputs to the new one, even with the same status.
      const start = rows.find(setsResearchGoal);
      const rounds = rows.filter(run => isGoalContinuation(run) && validId(run.id) && run.status === 'succeeded'
        && Number.isFinite(Date.parse(run.finishedAt)) && (!start || Date.parse(run.startedAt) >= Date.parse(start.startedAt))
        && (!goal.goalId || run.goal?.id === goal.goalId)
        && (!reset || Date.parse(run.startedAt) >= Date.parse(reset)));
      const requestedRound = query && rounds.find(run => query.includes(run.id));
      const source = requestedRound || rounds[0];
      if (!source) continue;
      const progress = goal.progress;
      const fraction = Number.isSafeInteger(progress?.processed) && Number.isSafeInteger(progress?.total)
        && progress.processed >= 0 && progress.total >= progress.processed ? {processed:progress.processed,total:progress.total} : null;
      const output = requestedRound ? (roundProducedFiles(source) ? source : null) : rounds.find(roundProducedFiles);
      const record = { sourceId:doc.id, runId:source.id, sessionId:goal.sessionId, status:goal.status, progress:fraction,
        hasOutput:Boolean(output), outputRunId:output?.id ?? null, finishedAt:source.finishedAt, conversationUrl:'/app/chat/' + encodeURIComponent(goal.sessionId) };
      if (query && ![doc.id,source.id,...(output ? [output.id] : []),goal.sessionId,goal.status,labels.get(goal.status),'目标状态','研究进展','近期工作','研究目标','goal status','research progress','recent work']
        .some(term => query.toLowerCase().includes(term))) continue;
      if (!await permitted(project, goal.sessionId, rows)) continue;
      const text = '自动研究' + labels.get(goal.status) + (fraction ? `（${fraction.processed}/${fraction.total}）` : '');
      results.push({record,row:{slot:'recent_work',recordId:doc.id,label:'近期工作',text,updatedAt:source.finishedAt,
        originalSources:[{id:doc.id,contentDigest:inputDigest(JSON.stringify(record)),attribution:{origins:['system']},
          sourcePrivacy:{schemaVersion:1,classification:'unclassified',reasons:['automated-goal-status']}}]}});
    }
    await contexts.assertLive(context);
    return results.sort((a,b)=>Date.parse(b.record.finishedAt)-Date.parse(a.record.finishedAt)).slice(0,limit);
  };
}
