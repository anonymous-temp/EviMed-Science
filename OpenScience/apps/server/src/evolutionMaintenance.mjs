import { methodHarmTest, METHOD_HARM_TEST } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { evolutionKey } from './evolutionService.mjs';

/** @param {any[]} observations */
const assessHarm = observations => methodHarmTest(/** @type {any} */ ({ observations }));
/** Execution/dependency exceptions are not evidence of a wrong scientific calculation. @param {any} result */
export function evolutionReplayDisposition(result) {
  if (result.ok === true) return 'passed';
  if (result.status === 'waiting_resource' || result.resourceCode) return 'resource';
  const wrong = (result.assessments ?? []).some(row => row.independent === true && row.passed === false && row.exposed === false && row.retracted === false
    && (row.reason === 'outside_reference_tolerance' || (row.kind === 'simulation' && row.preRegistered === true && row.monteCarloError
      && Object.values(row.monteCarloError).every(Number.isFinite))));
  return wrong ? 'method-regression' : 'resource';
}

/** Reference identities remain opaque; gold values never enter retrieval tasks. @param {any[]} tools */
export function evolutionRetrievalBenchmark(tools) {
  const cases = new Map();
  for (const row of tools.filter(item => item.payload.status === 'active')) for (const item of row.payload.holdoutCases ?? []) {
    const key = `${item.id}:${item.sha256}`;
    if (!cases.has(key)) cases.set(key, { id: key, referenceId: item.id, referenceHash: item.sha256,
      task: row.payload.whenToUse ?? row.payload.description ?? row.payload.name ?? null,
      capabilityIds: row.payload.capabilityIds ?? [], track: row.payload.track, acceptableToolIds: [] });
    cases.get(key).acceptableToolIds.push(row.id);
  }
  return [...cases.values()];
}

/** An absent selector is never perfect performance. @param {any[]} cases @param {any[]} selections */
export function evolutionRetrievalScore(cases, selections) {
  const measured = cases.filter(item => item.task && selections.some(selection => selection.caseId === item.id));
  const correct = measured.filter(item => selections.some(selection => selection.caseId === item.id && item.acceptableToolIds.includes(selection.toolId))).length;
  return { observation: measured.length ? 'observed' : 'not-observed', totalCases: cases.length,
    measuredCases: measured.length, correct, selectionAccuracy: measured.length ? correct / measured.length : null };
}

/** Maintenance uses actual invocation outcomes, not reads of a skill file. */
export class EvolutionMaintenance {
  /** @param {any} dependencies */
  constructor({ service, callbacks = {} }) { this.service = service; this.callbacks = callbacks; }
  /** @param {string} id @param {any} observation */
  async observe(id, observation) {
    const row = await this.service.get(id);
    if (!row) throw new HttpError(404, 'evolution_tool_missing', 'Tool not found.');
    const observations = [...row.payload.observations ?? []];
    const previousObservation = observations.find((/** @type {any} */ item) => item.runId === observation.runId);
    if (previousObservation?.feedbackEventId && !observation.feedbackEventId) observation = { ...observation,
      outcome: previousObservation.outcome, corrected: previousObservation.corrected };
    const callIds = [...new Set([...(previousObservation?.callIds ?? []), ...(observation.invoked === true && (observation.callId || !previousObservation?.invoked) ? [observation.callId ?? observation.runId] : [])])];
    const oldCalls = previousObservation?.callIds?.length ?? (previousObservation?.invoked ? 1 : 0);
    const retrievalIds = [...new Set([...(previousObservation?.retrievalIds ?? []), ...(observation.retrieved ? [observation.retrievalId ?? observation.runId] : [])])];
    const callOutcomes = { ...previousObservation?.callOutcomes };
    if (observation.callId && typeof observation.executionOk === 'boolean') callOutcomes[observation.callId] = observation.executionOk;
    const oldSucceeded = Object.values(previousObservation?.callOutcomes ?? {}).filter(value => value === true).length;
    const executedSuccessfully = Object.values(callOutcomes).filter(value => value === true).length;
    if (previousObservation && previousObservation.outcome === observation.outcome && previousObservation.corrected === observation.corrected
      && callIds.length === oldCalls && retrievalIds.length === (previousObservation.retrievalIds?.length ?? 0)
      && JSON.stringify(callOutcomes) === JSON.stringify(previousObservation.callOutcomes ?? {})) return row;
    const usage = { ...row.payload.usage };
    usage.retrieved += retrievalIds.length - (previousObservation?.retrievalIds?.length ?? 0);
    usage.executionSucceeded = Number(usage.executionSucceeded ?? 0) + executedSuccessfully - oldSucceeded;
    usage.executionFailed = Number(usage.executionFailed ?? 0) + Object.values(callOutcomes).filter(value => value === false).length
      - Object.values(previousObservation?.callOutcomes ?? {}).filter(value => value === false).length;
    if (observation.invoked === true) {
      usage.invoked += callIds.length - oldCalls;
      usage.executionCount = usage.invoked;
      if (callIds.length > oldCalls) usage.costCny += Number(observation.costCny ?? 0);
      const acceptedCalls = callIds.filter(callId => callOutcomes[callId] !== false).length;
      const previousAcceptedCalls = (previousObservation?.callIds ?? []).filter(callId => previousObservation?.callOutcomes?.[callId] !== false).length;
      usage.succeeded += (observation.outcome === 'accepted' ? acceptedCalls : 0) - (previousObservation?.outcome === 'accepted' ? previousAcceptedCalls : 0);
      usage.corrected += (observation.corrected ? 1 : 0) - (previousObservation?.corrected ? 1 : 0);
    }
    if (previousObservation) observations.splice(observations.indexOf(previousObservation), 1);
    observations.push({ ...previousObservation, ...observation, callIds, callOutcomes, retrievalIds, at: previousObservation?.at ?? observation.at ?? this.service.now().toISOString() });
    const evaluated = observations.filter(item => item.invoked === true && ['accepted', 'repaired', 'rejected'].includes(item.outcome));
    const epochs = (usage.harmEpochs ?? []).map(epoch => ({ ...epoch, runIds: [...epoch.runIds] }));
    for (const item of evaluated) {
      if (epochs.some(epoch => epoch.runIds.includes(item.runId))) continue;
      let epoch = epochs.at(-1);
      if (!epoch || epoch.state !== 'watching' || epoch.runIds.length >= METHOD_HARM_TEST.maxRuns) {
        epoch = { index: epochs.length, runIds: [], state: 'watching' }; epochs.push(epoch);
      }
      epoch.runIds.push(item.runId);
      Object.assign(epoch, assessHarm(evaluated.filter(sample => epoch.runIds.includes(sample.runId))));
    }
    for (const epoch of epochs) Object.assign(epoch, assessHarm(evaluated.filter(sample => epoch.runIds.includes(sample.runId))));
    const harm = epochs.find(epoch => epoch.state === 'harm') ?? epochs.at(-1) ?? assessHarm([]);
    usage.harmEpochs = epochs; usage.harmState = harm.state; usage.runs = evaluated.length;
    const saved = await this.service.save('tool', id, { ...row.payload, usage, observations }, row);
    if (harm.state === 'harm') return this.retire(saved, 'sequential-harm');
    // Existing shared test parameters decide when live evidence is sufficient.
    if (row.payload.validationLevel === 'V3' && harm.state === 'clear' && usage.invoked >= METHOD_HARM_TEST.minRuns) return this.service.save('tool', id, { ...saved.payload, validationLevel: 'V4' }, saved);
    return saved;
  }
  /** @param {any} row @param {string} reason */
  async retire(row, reason) {
    return this.service.withLock(`tool-lifecycle:${row.id}`, async () => {
      let current = await this.service.get(row.id);
      if (current.payload.status==='retired' && current.payload.retirement?.state === 'complete') return current;
      if (current.payload.status !== 'retired' || current.payload.retirement?.state !== 'pending') current = await this.service.save('tool', row.id, {
        ...current.payload, status: 'retired', retirementHistory:[...(current.payload.retirementHistory??[]),...(current.payload.retirement?.state==='reversed'?[current.payload.retirement]:[])], retirement: { reason,
          at: this.service.now().toISOString(), state: 'pending' } }, current);
      await this.callbacks.notifyAffected?.({ toolId: row.id, reason: current.payload.retirement.reason, preserveHistoricalVersions: true });
      return this.service.save('tool', row.id, { ...current.payload, retirement: { ...current.payload.retirement,
        state: 'complete', completedAt: this.service.now().toISOString() } }, current);
    });
  }
  /** Reuse immutable build generations and all-parent replay, without exposing evaluator numbers.
   * @param {any} tool @param {any} result @param {string} releaseId */
  async releaseReplay(tool, result, releaseId) {
    const disposition = evolutionReplayDisposition(result);
    if (disposition === 'passed') return { disposition };
    const id = `evolution-release-review-${evolutionKey([tool.id, tool.payload.artifactDigest, releaseId])}`;
    if (disposition === 'resource') {
      await this.callbacks.proposeReview?.({ category: 'release-replay-resource', subjectId: id, resourceOnly: true,
        title: '科研工具回放等待资源', body: '独立参考、执行环境或依赖尚不可用；这不证明计算方法错误。',
        options: [{ id: 'wait', label: '等待资源', operation: 'wait' }, { id: 'keep', label: '保留现有版本', operation: 'keep' }], recommended: 'wait', conservative: 'wait', alternative: 'wait' });
      return { disposition, reviewId: id };
    }
    const tools = await this.service.tools();
    const unique = (tool.payload.holdoutCases ?? []).some(item => !tools.some(other => other.id !== tool.id && other.payload.status === 'active'
      && (other.payload.holdoutCases ?? []).some(reference => reference.id === item.id && reference.sha256 === item.sha256)));
    let current = await this.service.get(tool.id);
    if (current.payload.maintenanceState !== 'deprecating') current = await this.service.save('tool', tool.id, { ...current.payload, maintenanceState: 'deprecating',
      regression: { releaseId, at: this.service.now().toISOString(), failedCaseIds: result.failedCaseIds, evaluatorHash: result.evaluatorHash, protectedCoverage: unique } }, current);
    if (!unique) await this.retire(current, 'published-replay-regression');
    const prior = await this.service.get(id);
    const review = prior ?? await this.service.save('maintenance-review', id, { kind: 'release-regression', parentToolIds: [tool.id],
      status: 'pending', releaseId, protectedCoverage: unique, failedCaseIds: result.failedCaseIds });
    await this.callbacks.proposeReview?.({ category: 'tool-repair', subjectId: id, materialVersion: releaseId, directional: true,
      attemptedPaths: ['independent-published-case-replay', 'alternate-reference-coverage-check'], title: '修复科研工具的回放偏差',
      body: unique ? '实际独立算例发现数值偏差；此工具提供唯一算例覆盖，保留并标记待修复。新版本须通过全部原算例。' : '实际独立算例发现数值偏差，旧版本已软退役。可研发修复版本，并通过全部原算例后替换。',
      options: [{ id: 'repair', label: '研发修复版本', operation: 'maintenance-repair' }, { id: 'retire', label: unique ? '保留唯一覆盖并复核' : '保留退役状态', operation: 'maintenance-retire' }],
      recommended: 'repair', conservative: 'repair' });
    return { disposition, reviewId: review.id, protectedCoverage: unique };
  }
  /** A merged version must independently replay every case of every parent. @param {string[]} ids @param {any} candidate */
  async verifyMerge(ids, candidate) {
    const parents = await Promise.all(ids.map((id) => this.service.get(id)));
    if (parents.some((row) => !row)) throw new HttpError(404, 'evolution_tool_missing', 'A merge parent is missing.');
    const originalCases = parents.flatMap((row) => row.payload.holdoutCases ?? []);
    if (originalCases.some((/** @type {any} */ item) => originalCases.some((/** @type {any} */ other) => item.id === other.id && item.sha256 !== other.sha256))) throw new HttpError(409, 'evolution_merge_case_conflict', 'Source cases changed identity.');
    const cases = [...new Map(parents.flatMap((row) => row.payload.holdoutCases ?? []).map((/** @type {any} */ item) => [item.id, item])).values()];
    const replay = await this.callbacks.replayCases?.({ candidate, cases });
    if (!replay?.independent || !cases.every((item) => replay.passedCaseIds?.includes(item.id))) throw new HttpError(409, 'evolution_merge_unverified', 'The merged tool must pass every parent case.');
    return { parents, cases };
  }
  /** @param {string[]} ids @param {any} candidate */
  async merge(ids, candidate) {
    const { parents, cases } = await this.verifyMerge(ids, candidate);
    const registered = await this.service.registerTool({ ...candidate, status: 'active', holdoutCases: cases, lineage: { ...candidate.lineage, parents: ids } });
    const merged = await this.service.save('tool', registered.id, { ...registered.payload, holdoutCases: cases,
      lineage: { ...registered.payload.lineage, parents: ids } }, registered);
    for (const parent of parents) {
      if (parent.id === merged.id || (parent.payload.status === 'alias' && parent.payload.replacedBy === merged.id)) continue;
      await this.service.withLock(`tool-lifecycle:${parent.id}`,async()=>{
        const current=await this.service.get(parent.id);
        if(current.payload.replacedBy && current.payload.replacedBy!==merged.id) throw new HttpError(409,'evolution_evaluation_invalid','A newer parent branch cannot be overwritten.');
        await this.service.save('tool',parent.id,{...current.payload,status:'alias',replacedBy:merged.id,aliasSince:this.service.now().toISOString()},current);
      });
    }
    return merged;
  }
  /** Restore only the exact branch governed by this review; historical pins remain immutable. @param {any} review @param {any} action */
  async restoreReview(review,action) {
    return this.service.withLock(`maintenance-restore:${review.id}`,async()=>{
      review=await this.service.get(review.id);
      const parents=await Promise.all(review.payload.parentToolIds.map(id=>this.service.get(id)));
      if(parents.some(row=>!row)) throw new HttpError(404,'evolution_tool_missing','A preserved parent is unavailable.');
      const replacements=[...new Set([...parents.map(row=>row.payload.replacedBy),review.payload.restoration?.state==='pending'?review.payload.restoration.replacementId:null].filter(Boolean))];
      const replacement=replacements.length===1?await this.service.get(replacements[0]):null;
      const pending=review.payload.restoration?.state==='pending' && review.payload.restoration.actionId===action.actionId;
      if(parents.every(row=>row.payload.status==='active') && !pending) return {state:'kept'};
      if(parents.some(row=>row.payload.usage?.harmState==='harm' || (row.payload.status==='retired' && !['monthly-direction-review','alias-quiet-period'].includes(row.payload.retirement?.reason)))) throw new HttpError(409,'evolution_evaluation_invalid','A harmful or regressed version requires repair rather than reactivation.');
      if(review.payload.kind==='merge' && (!replacement || replacements.length!==1 || replacement.payload.replacedBy || !['active','retired'].includes(replacement.payload.status) || JSON.stringify([...(replacement.payload.lineage?.parents??[])].sort())!==JSON.stringify([...review.payload.parentToolIds].sort()))) throw new HttpError(409,'evolution_evaluation_invalid','A newer branch cannot be overwritten by this reversal.');
      if(review.payload.kind!=='merge' && parents.some(row=>row.payload.replacedBy)) throw new HttpError(409,'evolution_evaluation_invalid','A superseding version requires its own review.');
      if(!pending) review=await this.service.save('maintenance-review',review.id,{...review.payload,restoration:{state:'pending',actionId:action.actionId,decisionId:action.id,replacementId:replacement?.id??null,requestedAt:this.service.now().toISOString()}},review);
      for(let parent of parents) {
        await this.service.withLock(`tool-lifecycle:${parent.id}`,async()=>{
        parent=await this.service.get(parent.id);
        if(parent.payload.status==='active' && parent.payload.restorationHistory?.some(item=>item.actionId===action.actionId)) return;
        if(parent.payload.usage?.harmState==='harm' || (parent.payload.replacedBy??null)!==(review.payload.kind==='merge'?replacement.id:null) || (parent.payload.status==='retired' && !['monthly-direction-review','alias-quiet-period'].includes(parent.payload.retirement?.reason))) throw new HttpError(409,'evolution_evaluation_invalid','The current branch is not eligible for restoration.');
        if(!this.callbacks.restorePin) throw new HttpError(503,'evolution_execution_unavailable','Exact pin restoration is unavailable.');
        const expectedReplacement=parent.payload.replacedBy??null;
        try {
        await this.callbacks.restorePin({id:parent.id,digest:parent.payload.artifactDigest,revision:parent.payload.revision});
        parent=await this.service.get(parent.id);
        if(parent.payload.usage?.harmState==='harm' || (parent.payload.status==='retired' && !['monthly-direction-review','alias-quiet-period'].includes(parent.payload.retirement?.reason)) || (parent.payload.replacedBy??null)!==expectedReplacement) throw new HttpError(409,'evolution_evaluation_invalid','The parent branch changed during restoration.');
        await this.service.save('tool',parent.id,{...parent.payload,status:'active',replacedBy:null,aliasSince:null,
          restorationHistory:[...(parent.payload.restorationHistory??[]),{actionId:action.actionId,previousStatus:parent.payload.status,previousReplacement:parent.payload.replacedBy??null,at:this.service.now().toISOString()}],retirement:parent.payload.retirement?{...parent.payload.retirement,state:'reversed'}:undefined},parent);
        } catch(error) {
          const current=await this.service.get(parent.id);
          if(current.payload.status!=='active' || current.payload.usage?.harmState==='harm') await this.callbacks.retirePin?.(parent.id);
          throw error;
        }
        });
      }
      if(replacement) await this.retire(replacement,'merge-direction-reversed');
      review=await this.service.get(review.id);
      await this.service.save('maintenance-review',review.id,{...review.payload,restoration:{...review.payload.restoration,state:'complete',completedAt:this.service.now().toISOString()}},review);
      return {state:'restored',toolIds:parents.map(row=>row.id),reversedReplacementId:replacement?.id??null};
    });
  }
  /** Only a direction is approved here; actual merged publication still requires merge() replay. @param {any} action */
  async executeReview(action) {
    const review = await this.service.get(action.subjectId);
    if (!review || review.payload.recordType !== 'evolution-maintenance-review') throw new HttpError(404, 'evolution_tool_missing', 'Maintenance review unavailable.');
    const ids = review.payload.parentToolIds;
    if(action.option==='keep') return this.restoreReview(review,action);
    if (action.option === 'repair') {
      const tool = await this.service.get(ids[0]);
      const original = (await this.service.dossiers()).find(row => row.id === tool.payload.dossierId || row.payload.toolId === tool.id);
      if (!original) throw new HttpError(409, 'evolution_evaluation_invalid', 'The preserved original research card is required for a faithful repair.');
      const id = `evolution-repair-${evolutionKey([review.id, action.actionId])}`;
      const dossier = await this.service.get(id) ?? await this.service.save('dossier', id, { ...original.payload, id, status: 'planned', buildAttempts: 0,
        toolId: null, parentToolIds: [tool.id], repairOf: { toolId: tool.id, artifactDigest: tool.payload.artifactDigest }, decisionActionId: action.actionId,
        goal: `${original.payload.goal}. ${review.payload.kind === 'public-boundary-regression' ? 'Repair the observed public input-boundary regression, preserve the method, and pass every public development and original reference case.' : 'Repair the observed published-reference regression, preserve the method, and pass every original reference case.'}`,
        ...(review.payload.kind === 'public-boundary-regression' ? {feedback:{passed:false,failedCaseIds:(review.payload.executions??[]).filter(row=>row.executed===true && row.passed===false).map(row=>row.caseId),issueCodes:['public_development_case_failed']}} : {}), createdAt: this.service.now().toISOString() });
      return this.service.enqueue('build', { dossierId: dossier.id, decisionActionId: action.actionId }, action.actionId);
    }
    if (action.option === 'retire') {
      const tools = await this.service.tools();
      const row = tools.find(tool => tool.id === ids[0]);
      if (!row) throw new HttpError(404, 'evolution_tool_missing', 'Tool unavailable.');
      const unique = (row.payload.holdoutCases ?? []).some(item => !tools.some(other => other.id !== row.id && other.payload.status === 'active'
        && (other.payload.holdoutCases ?? []).some(reference => reference.id === item.id && reference.sha256 === item.sha256)));
      if (unique) return { state: 'protected-coverage' };
      return this.retire(row, 'monthly-direction-review');
    }
    if (action.option === 'merge') return this.service.enqueue('scout', { maintenanceReviewId: review.id, parentToolIds: ids }, action.actionId);
    return { state: 'kept' };
  }
  /** @param {string} kind @param {string[]} ids @param {string} month @param {string} title @param {string} body */
  async proposeMaintenance(kind, ids, month, title, body) {
    const id = `evolution-maintenance-review-${evolutionKey([kind, ids, month])}`;
    const previous = await this.service.get(id);
    const review = previous ?? await this.service.save('maintenance-review', id, { month, kind, parentToolIds: ids, status: 'pending' });
    await this.callbacks.proposeReview?.({ category: `tool-${kind}`, subjectId: id, materialVersion: month,
      title, body, directional: true, attemptedPaths: ['retain-current-version', 'compare-reference-coverage'], recommended: 'keep', conservative: 'keep',
      options: [{ id: 'keep', label: '保留现有工具', operation: 'keep' }, { id: kind === 'merge' ? 'merge' : 'retire',
        label: kind === 'merge' ? '研发合并版本并复测' : '软退役并保留历史', operation: kind === 'merge' ? 'maintenance-merge' : 'maintenance-retire' }] });
    return review;
  }
  /** @param {any} [input] */
  async monthly(input = {}) {
    const currentMonth = this.service.now().toISOString().slice(0, 7);
    const month = input.month ?? currentMonth;
    const metricsMonth = input.metricsMonth ?? new Date(Date.UTC(this.service.now().getUTCFullYear(), this.service.now().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(metricsMonth) || metricsMonth >= currentMonth) throw new Error('Monthly metrics require a completed calendar month.');
    const metricsId = `evolution-monthly-metrics-${metricsMonth}`;
    let metricsRecord = await this.service.get(metricsId);
    if (!metricsRecord) {
      const date = new Date(`${metricsMonth}-01T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() - 1);
      const previous = await this.service.get(`evolution-monthly-metrics-${date.toISOString().slice(0, 7)}`);
      const metrics = await this.callbacks.monthlyMetrics?.(metricsMonth, { previous: previous?.payload.metrics ?? null }) ?? {};
      metricsRecord = await this.service.save('monthly-metrics', metricsId, { month: metricsMonth, metrics, observedAt: this.service.now().toISOString() });
    }
    if (input.metricsOnly) return metricsRecord;
    const tools = await this.service.tools();
    for (const row of tools) if (row.payload.status === 'alias' && row.payload.aliasSince && this.service.now().getTime() - Date.parse(row.payload.aliasSince) >= 30 * 86400000) await this.retire(row, 'alias-quiet-period');
    const covered = new Map();
    for (const row of tools.filter((/** @type {any} */ r) => r.payload.status === 'active')) for (const item of row.payload.holdoutCases ?? []) covered.set(`${item.id}:${item.sha256}`, (covered.get(`${item.id}:${item.sha256}`) ?? 0) + 1);
    const rows = tools.map((/** @type {any} */ row) => {
      const u = row.payload.usage;
      const protectedCoverage = (row.payload.holdoutCases ?? []).some((/** @type {any} */ item) => covered.get(`${item.id}:${item.sha256}`) === 1);
      return { id: row.id, maintenanceScore: (u.invoked ? u.succeeded / u.invoked : 0) + Math.log1p(u.invoked) + (u.retrieved ? u.invoked / u.retrieved : 0), protectedCoverage };
    }).sort((/** @type {any} */ a, /** @type {any} */ b) => a.maintenanceScore - b.maintenanceScore);
    const reviews = [];
    const active = tools.filter(row => row.payload.status === 'active' && row.createdAt
      && this.service.now().getTime() - Date.parse(row.createdAt) >= 30 * 86400000);
    const lowest = rows.find(row => !row.protectedCoverage && active.some(tool => tool.id === row.id));
    if (lowest && active.length > 1) reviews.push(await this.proposeMaintenance('retirement', [lowest.id], month,
      '复核使用收益最低的科研工具', '维护分综合真实调用成功率、调用量和检索转调用率；唯一算例覆盖受到保护。'));
    for (let left = 0; left < active.length; left++) for (let right = left + 1; right < active.length; right++) {
      const a = active[left], b = active[right];
      const overlap = (a.payload.holdoutCases ?? []).some(item => (b.payload.holdoutCases ?? []).some(other => item.id === other.id && item.sha256 === other.sha256));
      const words = value => new Set(String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      const aWords = words(a.payload.description ?? a.payload.name), bWords = words(b.payload.description ?? b.payload.name);
      const similar = aWords.size > 0 && [...aWords].filter(word => bWords.has(word)).length / new Set([...aWords, ...bWords]).size >= 0.5;
      if (overlap && similar && a.payload.track === b.payload.track) reviews.push(await this.proposeMaintenance('merge', [a.id, b.id], month,
        '复核相似且算例重叠的科研工具', '这里只提合并研发方向；新版本必须独立通过全部来源算例，原版本先保留为别名。'));
    }
    const benchmark = evolutionRetrievalBenchmark(tools);
    const benchmarkId = `evolution-retrieval-${month}`;
    if (!await this.service.get(benchmarkId)) await this.service.save('retrieval-benchmark', benchmarkId, { month, cases: benchmark, status: 'pending', score: evolutionRetrievalScore(benchmark, []) });
    if (benchmark.length) await this.service.enqueue('evaluate', { action: 'retrieval-selection', benchmarkId }, `retrieval:${month}`);
    const report = { month, metricsMonth, tools: rows, reviews: reviews.map(row => row.id), retrievalBenchmarkId: benchmarkId, coverage: covered.size, activeBytes: tools.filter((/** @type {any} */ row) => row.payload.status === 'active').reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + Number(row.payload.artifactBytes ?? 0), 0), metrics: metricsRecord.payload.metrics };
    const id = `evolution-maintenance-${month}`;
    const previous = await this.service.get(id);
    return this.service.save('maintenance', id, report, previous);
  }
}
/** @param {any} dependencies */
export function createEvolutionMaintenance(dependencies) { return new EvolutionMaintenance(dependencies); }
