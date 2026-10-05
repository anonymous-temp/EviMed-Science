import { methodHarmTest, EVOLUTION_TOOL_HARM_TEST, canonicalJson } from '@evimed/domain';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './security.mjs';
import { evolutionKey } from './evolutionService.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';

/**
 * Retirement evidence for a published tool: the platform's existing sequential harm test, applied the
 * way the learned-methods loop applies it (`retirementProposal` in the domain's `methodGraph.mjs`):
 * `methodHarmTest` read over the revision's own history, in the order it happened, each run at its
 * latest outcome, stopped at its verdict. Not a second sequential test, and never restarted.
 *
 * What was wrong before (scientific finding B3): every concluded test was followed by a fresh one
 * ("epochs"), each with its own false-alarm chance, and any of them reaching `harm` retired the tool. A
 * harmless tool at the test's own 10% background rate was retired 33% of the time by 100 runs and 87% by 500.
 *
 * Three things are fixed about the evidence:
 *  - one trial per account. Runs of one researcher are not independent draws (someone who revises every
 *    result they are handed would be read as many failures), and the test's error control assumes
 *    independent trials. A trial is an account's first evaluated run of this revision. It is also what
 *    stops one account's ordinary corrections from retiring a tool for everyone (security finding S3);
 *  - the scientific axis's numbers (`EVOLUTION_TOOL_HARM_TEST`): a correction is ordinary work;
 *  - one test per revision, at most 40 trials. Once it reads `clear` or `harm` it is over. A tool that
 *    cleared and later drifts is the release replay's and the monthly review's to catch, and a repaired
 *    revision starts its own test; continuous monitoring would need an alpha-spending boundary and its
 *    own control simulation before it could retire anything (principles 4 and 11).
 *
 * False retirement. For a harmless tool the probability that the test ever reads `harm` is the operating
 * characteristic of one capped test, whatever the volume of use: 3.6% when corrections run at the 25%
 * background rate, 0.34% at 15%, 0.06% at 10% (`harmTestOperatingCharacteristics`, exact;
 * `test/evolutionHarmTest.test.mjs` reproduces it by seeded simulation of this very loop and shows that
 * it does not grow with use). At a harmful 60% the test reads `harm` 84% of the time.
 *
 * And `harm` proposes; it does not retire. The verdict opens a maintenance review and a decision an
 * operator sees (plan section 9.1: retiring a tool that agendas use is a direction decision); the tool
 * is retired by that decision or its default, and the same decision reverses it afterwards.
 */
const EVALUATED_OUTCOMES = ['accepted', 'repaired', 'rejected'];
const USAGE_COUNTERS = ['retrieved', 'invoked', 'executionSucceeded', 'executionFailed', 'succeeded', 'corrected', 'costCny', 'runs'];
/** Call and retrieval identities remembered per run for idempotency; a run that goes past this has its
 *  further calls counted without being remembered, so one looping run cannot grow a record without bound. */
const IDENTITIES_PER_RUN = 500;
/** Optimistic writes are retried on a revision conflict; two runs calling one tool at once is ordinary. */
const WRITE_ATTEMPTS = 8;

/**
 * Exact operating characteristics of the capped sequential test `methodHarmTest` implements, by dynamic
 * programming over (trials, bad): the probability it ends in `harm`, in `clear`, and the mean number of
 * trials it reads, when each trial is bad independently with probability `rate`.
 * @param {{baseRate:number,harmRate:number,alpha:number,beta:number,minRuns:number,maxRuns:number}} parameters @param {number} rate
 */
export function harmTestOperatingCharacteristics(parameters, rate) {
  const { baseRate, harmRate, alpha, beta, minRuns, maxRuns } = parameters;
  const upper = Math.log((1 - beta) / alpha), lower = Math.log(beta / (1 - alpha));
  const badStep = Math.log(harmRate / baseRate), goodStep = Math.log((1 - harmRate) / (1 - baseRate));
  let open = new Map([[0, 1]]), harm = 0, clear = 0, trials = 0;
  for (let n = 1; n <= maxRuns; n++) {
    const next = new Map();
    for (const [bad, mass] of open) for (const [count, probability] of [[bad + 1, rate], [bad, 1 - rate]]) {
      const llr = count * badStep + (n - count) * goodStep, weight = mass * probability;
      // The same boundary order and tolerance as methodHarmTest.
      if (n >= minRuns && llr >= upper - 1e-9) { harm += weight; trials += weight * n; }
      else if (llr <= lower + 1e-9) { clear += weight; trials += weight * n; }
      else next.set(count, (next.get(count) ?? 0) + weight);
    }
    open = next;
  }
  const capped = [...open.values()].reduce((sum, value) => sum + value, 0);
  return { harm, clear: clear + capped, meanTrials: trials + capped * maxRuns };
}

/** What one run's observation adds to a tool's counters. @param {any} observation */
function contribution(observation) {
  const outcomes = Object.values(observation?.callOutcomes ?? {}), ids = observation?.callIds ?? [], overflow = Number(observation?.callOverflow ?? 0);
  const invoked = observation?.invoked === true;
  return { retrieved: (observation?.retrievalIds?.length ?? 0) + Number(observation?.retrievalOverflow ?? 0), invoked: invoked ? ids.length + overflow : 0,
    executionSucceeded: outcomes.filter(value => value === true).length, executionFailed: outcomes.filter(value => value === false).length,
    succeeded: invoked && observation.outcome === 'accepted' ? ids.filter(id => observation.callOutcomes?.[id] !== false).length + overflow : 0,
    corrected: invoked && observation.corrected ? 1 : 0, costCny: Number(observation?.costCny ?? 0),
    runs: invoked && EVALUATED_OUTCOMES.includes(observation.outcome) ? 1 : 0 };
}

/** Fold one report about a run into what is already known about it. @param {any} previous @param {any} incoming @param {string} now */
function foldRun(previous, incoming, now) {
  let observation = incoming;
  // A later "pending" from the run finishing does not undo what the researcher already said about it.
  if (previous?.feedbackEventId && !observation.feedbackEventId) observation = { ...observation, outcome: previous.outcome, corrected: previous.corrected };
  const remember = (known, added) => { const fresh = added.filter(id => !known.includes(id)), room = Math.max(0, IDENTITIES_PER_RUN - known.length); return { ids: [...known, ...fresh.slice(0, room)], overflow: Math.max(0, fresh.length - room), added: fresh.length }; };
  const calls = remember(previous?.callIds ?? [], observation.invoked === true && (observation.callId || !previous?.invoked) ? [observation.callId ?? observation.runId] : []);
  const retrievals = remember(previous?.retrievalIds ?? [], observation.retrieved ? [observation.retrievalId ?? observation.runId] : []);
  const callOutcomes = { ...previous?.callOutcomes };
  if (observation.callId && typeof observation.executionOk === 'boolean' && (Object.hasOwn(callOutcomes, observation.callId) || Object.keys(callOutcomes).length < IDENTITIES_PER_RUN)) callOutcomes[observation.callId] = observation.executionOk;
  // The account is kept as a keyed digest: enough to count distinct researchers, and no identity in a platform record.
  const { callId: _call, retrievalId: _retrieval, executionOk: _ok, retrieved: _retrieved, userId, costCny, ...carried } = observation;
  return { ...previous, ...carried, callIds: calls.ids, callOverflow: Number(previous?.callOverflow ?? 0) + calls.overflow, callOutcomes,
    retrievalIds: retrievals.ids, retrievalOverflow: Number(previous?.retrievalOverflow ?? 0) + retrievals.overflow,
    costCny: Number(previous?.costCny ?? 0) + (calls.added ? Number(costCny ?? 0) : 0),
    accountKey: previous?.accountKey ?? (typeof userId === 'string' && userId ? evolutionKey(['evolution-account', userId]) : null), at: previous?.at ?? observation.at ?? now };
}

/** Fold one run into the harm test's trials and read the test again. @param {any} current @param {any} observation */
function foldHarmTrial(current, observation) {
  const trials = [...(current?.trials ?? [])];
  const evaluated = observation.invoked === true && EVALUATED_OUTCOMES.includes(observation.outcome);
  const index = trials.findIndex(trial => trial.runId === observation.runId);
  if (index >= 0) { if (evaluated) trials[index] = { ...trials[index], outcome: observation.outcome }; else trials.splice(index, 1); }
  // A new trial needs an account that has none yet, and a test that is still open: one trial per account, one test per revision.
  else if (evaluated && observation.accountKey && (current?.state ?? 'watching') === 'watching' && trials.length < EVOLUTION_TOOL_HARM_TEST.maxRuns && !trials.some(trial => trial.accountKey === observation.accountKey)) {
    trials.push({ accountKey: observation.accountKey, runId: observation.runId, outcome: observation.outcome, at: observation.at });
  }
  const read = methodHarmTest(/** @type {any} */ ({ observations: trials.map(trial => ({ runId: trial.runId, family: trial.runId, outcome: trial.outcome, invoked: true, at: trial.at })) }), EVOLUTION_TOOL_HARM_TEST);
  return { ...current, axis: 'researcher-correction', trials, state: read.state, runs: read.runs, bad: read.bad, llr: read.llr };
}
/**
 * What a failed replay of a released tool means.
 *
 * A sandbox that could not run the tool is a resource and says nothing about the tool. A tool whose own
 * code started and then failed on every replicate of a hidden case is something else: it is broken for
 * every researcher who calls it, and dependency and environment drift is exactly what the replay after
 * each release exists to find (plan section 7.4). That used to be read as `resource` with "wait"
 * recommended, so a released tool that crashed on every case stayed active.
 * @param {any} result
 */
export function evolutionReplayDisposition(result) {
  if (result.ok === true) return 'passed';
  if (result.status === 'waiting_resource' || result.resourceCode) return 'resource';
  const scored = (result.assessments ?? []).filter(row => row.independent === true && row.passed === false && row.exposed === false && row.retracted === false);
  if (scored.some(row => row.reason === 'outside_reference_tolerance' || (row.kind === 'simulation' && row.preRegistered === true && row.monteCarloError
    && Object.values(row.monteCarloError).every(Number.isFinite)))) return 'method-regression';
  // Two independent executions of the same case, both started, both failed in the tool's own code.
  const crashes = new Map();
  for (const row of scored) if (row.reason === 'candidate_execution_failed' && row.candidateStarted === true) crashes.set(row.caseId, (crashes.get(row.caseId) ?? 0) + 1);
  return [...crashes.values()].some(count => count >= 2) ? 'execution-regression' : 'resource';
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
  /** A strict optimistic write: a revision conflict is thrown to the retry loop, never absorbed.
   * @param {string} type @param {string} id @param {any} payload @param {any} previous */
  async write(type, id, payload, previous) {
    return this.service.documents.put(await this.service.owner(), 'knowledge', id, { ...payload, recordType: `evolution-${type}` },
      { expectedRevision: previous?.revision ?? 0, projectId: payload.projectId ?? EVOLUTION_PROJECT_ID });
  }
  /** @template T @param {() => Promise<T|undefined>} attempt @returns {Promise<T>} */
  async retried(attempt) {
    for (let count = 0; count < WRITE_ATTEMPTS; count++) {
      try { const result = await attempt(); if (result !== undefined) return result; }
      catch (error) { if (error?.code !== 'product_revision_conflict') throw error; }
      await delay(Math.floor(Math.random() * 5 * (count + 1)));
    }
    throw new HttpError(409, 'product_revision_conflict', 'The tool record is being updated; retry.');
  }
  /** @param {any} tool @param {string} runId */
  observationId(tool, runId) { return `evolution-observation-${evolutionKey([tool.id, tool.payload.artifactDigest ?? tool.payload.revision ?? null, runId])}`; }
  /** What is known about one run's use of a tool. @param {string} id @param {string} runId */
  async observationOf(id, runId) {
    const tool = await this.service.get(id);
    if (!tool) return null;
    return (await this.service.get(this.observationId(tool, runId)))?.payload ?? tool.payload.observations?.find((/** @type {any} */ item) => item.runId === runId) ?? null;
  }
  /**
   * Record what one run did with a tool.
   *
   * Each run has its own record, and the tool keeps counters and the harm test's trials (at most 40).
   * Both used to live in one array on the tool's record (integration finding F16): two runs calling a
   * tool at once lost one of the two observations to the revision conflict, and past roughly 500 runs
   * the record exceeded the ledger's 256 KiB limit, after which the most used tool could record nothing
   * and could not be retired. Now a run contends only with itself on its own record, the counter update
   * is an increment that is retried on conflict, and the harm trial is an idempotent upsert.
   * @param {string} id @param {any} observation `userId` is the account whose run this is
   */
  async observe(id, observation) {
    let tool = await this.service.get(id);
    if (!tool) throw new HttpError(404, 'evolution_tool_missing', 'Tool not found.');
    if (Array.isArray(tool.payload.observations) && tool.payload.observations.length) tool = await this.migrateObservations(tool);
    const observationId = this.observationId(tool, observation.runId);
    const folded = await this.retried(async () => {
      const row = await this.service.get(observationId);
      const merged = foldRun(row?.payload ?? null, observation, this.service.now().toISOString());
      if (row && canonicalJson({ ...row.payload, recordType: null }) === canonicalJson({ toolId: tool.id, ...merged, recordType: null })) return { state: row.payload, delta: null };
      const before = contribution(row?.payload), after = contribution(merged);
      const saved = await this.write('observation', observationId, { toolId: tool.id, ...merged }, row);
      return { state: saved.payload, delta: Object.fromEntries(USAGE_COUNTERS.map(key => [key, after[key] - before[key]])) };
    });
    if (!folded.delta) return tool;
    const saved = await this.retried(async () => {
      const current = await this.service.get(id);
      const usage = { ...current.payload.usage };
      for (const key of USAGE_COUNTERS) usage[key] = Number(usage[key] ?? 0) + folded.delta[key];
      usage.executionCount = usage.invoked;
      usage.harm = foldHarmTrial(usage.harm, folded.state);
      usage.harmState = usage.harm.overriddenAt ? 'overridden' : usage.harm.state;
      delete usage.harmEpochs;
      const { observations: _migrated, ...payload } = current.payload;
      return this.write('tool', id, { ...payload, usage }, current);
    });
    const harm = saved.payload.usage.harm;
    if (harm.state === 'harm' && !harm.reviewId && !harm.overriddenAt) return this.proposeHarmReview(saved);
    // The shared test's own parameters decide when live evidence is sufficient.
    if (saved.payload.validationLevel === 'V3' && harm.state === 'clear' && saved.payload.usage.invoked >= EVOLUTION_TOOL_HARM_TEST.minRuns) return this.service.save('tool', id, { ...saved.payload, validationLevel: 'V4' }, saved);
    return saved;
  }
  /** One-time move of a record written before runs had their own: each legacy observation becomes its
   * own record, already counted. They carry no account, so none of them is a harm trial. @param {any} tool */
  async migrateObservations(tool) {
    for (const legacy of tool.payload.observations) {
      if (!legacy?.runId) continue;
      const observationId = this.observationId(tool, legacy.runId);
      if (!await this.service.get(observationId)) await this.service.save('observation', observationId, { toolId: tool.id, ...legacy, accountKey: null, migrated: true });
    }
    return this.retried(async () => {
      const current = await this.service.get(tool.id);
      const { observations: _legacy, ...payload } = current.payload;
      const { harmEpochs: _epochs, ...usage } = payload.usage ?? {};
      return this.write('tool', tool.id, { ...payload, usage }, current);
    });
  }
  /** The harm verdict becomes a review and a decision an operator sees; it is never the retirement itself. @param {any} tool */
  async proposeHarmReview(tool) {
    const harm = tool.payload.usage.harm;
    const reviewId = `evolution-harm-review-${evolutionKey([tool.id, tool.payload.artifactDigest ?? tool.payload.revision ?? null])}`;
    if (!await this.service.get(reviewId)) await this.service.save('maintenance-review', reviewId, { kind: 'sequential-harm', parentToolIds: [tool.id], status: 'pending',
      evidence: { test: 'methodHarmTest', parameters: EVOLUTION_TOOL_HARM_TEST, accounts: harm.runs, corrected: harm.bad, llr: harm.llr,
        // What the reader of this evidence needs beside it: how often a harmless tool reaches this verdict.
        falseAlarmAtBackgroundRate: harmTestOperatingCharacteristics(EVOLUTION_TOOL_HARM_TEST, EVOLUTION_TOOL_HARM_TEST.baseRate).harm, association: 'not-cause' },
      proposedAt: this.service.now().toISOString() });
    // `tool-retire` is the category the decision module already names for the operator (工具退役).
    await this.callbacks.proposeReview?.({ category: 'tool-retire', subjectId: reviewId, materialVersion: tool.payload.artifactDigest ?? 1, directional: true,
      attemptedPaths: ['sequential-harm-test', 'distinct-account-evidence'], title: '复核被多位研究者纠正的科研工具',
      body: `${harm.runs} 位研究者首次使用该工具得到的结果中，有 ${harm.bad} 位作了纠正，高于平常的纠正水平。这是关联，不说明问题由工具造成。软退役后新研究不再使用它，历史结果和版本都保留，之后可以恢复。`,
      options: [{ id: 'retire', label: '软退役并保留历史', operation: 'maintenance-retire' }, { id: 'keep', label: '保留现有工具', operation: 'keep' }], recommended: 'retire', conservative: 'keep' });
    return this.retried(async () => {
      const current = await this.service.get(tool.id);
      if (current.payload.usage?.harm?.reviewId === reviewId) return current;
      return this.write('tool', tool.id, { ...current.payload, usage: { ...current.payload.usage, harm: { ...current.payload.usage.harm, reviewId } } }, current);
    });
  }
  /** The operator kept a tool the harm test flagged: recorded on the tool, so the verdict is not raised again
   * and the tool is never read as cleared. @param {string} id @param {any} action */
  async recordHarmOverride(id, action) {
    return this.retried(async () => {
      const current = await this.service.get(id);
      if (!current || current.payload.usage?.harm?.overriddenAt) return current ?? null;
      const harm = { ...current.payload.usage?.harm, overriddenAt: this.service.now().toISOString(), overriddenByActionId: action.actionId };
      return this.write('tool', id, { ...current.payload, usage: { ...current.payload.usage, harm, harmState: 'overridden' } }, current);
    });
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
    const crashed = disposition === 'execution-regression';
    if (current.payload.maintenanceState !== 'deprecating') current = await this.service.save('tool', tool.id, { ...current.payload, maintenanceState: 'deprecating',
      regression: { kind: disposition, releaseId, at: this.service.now().toISOString(), failedCaseIds: result.failedCaseIds, evaluatorHash: result.evaluatorHash, protectedCoverage: unique } }, current);
    if (!unique) await this.retire(current, 'published-replay-regression');
    const prior = await this.service.get(id);
    const review = prior ?? await this.service.save('maintenance-review', id, { kind: 'release-regression', regression: disposition, parentToolIds: [tool.id],
      status: 'pending', releaseId, protectedCoverage: unique, failedCaseIds: result.failedCaseIds });
    await this.callbacks.proposeReview?.({ category: 'tool-repair', subjectId: id, materialVersion: releaseId, directional: true,
      attemptedPaths: ['independent-published-case-replay', 'alternate-reference-coverage-check'], title: crashed ? '修复发布后无法运行的科研工具' : '修复科研工具的回放偏差',
      body: crashed ? (unique ? '发布后回放时，这个工具在独立算例上已无法运行；它提供唯一算例覆盖，保留并标记待修复。新版本须通过全部原算例。' : '发布后回放时，这个工具在独立算例上已无法运行，旧版本已软退役。可研发修复版本，并通过全部原算例后替换。')
        : unique ? '实际独立算例发现数值偏差；此工具提供唯一算例覆盖，保留并标记待修复。新版本须通过全部原算例。' : '实际独立算例发现数值偏差，旧版本已软退役。可研发修复版本，并通过全部原算例后替换。',
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
      // A retirement the harm test proposed is a decision, and the same decision reverses it; a regression of the method itself is not.
      const harmReview=review.payload.kind==='sequential-harm';
      const reversible=['monthly-direction-review','alias-quiet-period',...(harmReview?['sequential-harm']:[])];
      const blocked=row=>(!harmReview && row.payload.usage?.harmState==='harm') || (row.payload.status==='retired' && !reversible.includes(row.payload.retirement?.reason));
      if(parents.some(blocked)) throw new HttpError(409,'evolution_evaluation_invalid','A harmful or regressed version requires repair rather than reactivation.');
      if(review.payload.kind==='merge' && (!replacement || replacements.length!==1 || replacement.payload.replacedBy || !['active','retired'].includes(replacement.payload.status) || JSON.stringify([...(replacement.payload.lineage?.parents??[])].sort())!==JSON.stringify([...review.payload.parentToolIds].sort()))) throw new HttpError(409,'evolution_evaluation_invalid','A newer branch cannot be overwritten by this reversal.');
      if(review.payload.kind!=='merge' && parents.some(row=>row.payload.replacedBy)) throw new HttpError(409,'evolution_evaluation_invalid','A superseding version requires its own review.');
      if(!pending) review=await this.service.save('maintenance-review',review.id,{...review.payload,restoration:{state:'pending',actionId:action.actionId,decisionId:action.id,replacementId:replacement?.id??null,requestedAt:this.service.now().toISOString()}},review);
      for(let parent of parents) {
        await this.service.withLock(`tool-lifecycle:${parent.id}`,async()=>{
        parent=await this.service.get(parent.id);
        if(parent.payload.status==='active' && parent.payload.restorationHistory?.some(item=>item.actionId===action.actionId)) return;
        if(blocked(parent) || (parent.payload.replacedBy??null)!==(review.payload.kind==='merge'?replacement.id:null)) throw new HttpError(409,'evolution_evaluation_invalid','The current branch is not eligible for restoration.');
        if(!this.callbacks.restorePin) throw new HttpError(503,'evolution_execution_unavailable','Exact pin restoration is unavailable.');
        const expectedReplacement=parent.payload.replacedBy??null;
        try {
        await this.callbacks.restorePin({id:parent.id,digest:parent.payload.artifactDigest,revision:parent.payload.revision});
        parent=await this.service.get(parent.id);
        if(blocked(parent) || (parent.payload.replacedBy??null)!==expectedReplacement) throw new HttpError(409,'evolution_evaluation_invalid','The parent branch changed during restoration.');
        await this.service.save('tool',parent.id,{...parent.payload,status:'active',replacedBy:null,aliasSince:null,
          restorationHistory:[...(parent.payload.restorationHistory??[]),{actionId:action.actionId,previousStatus:parent.payload.status,previousReplacement:parent.payload.replacedBy??null,at:this.service.now().toISOString()}],retirement:parent.payload.retirement?{...parent.payload.retirement,state:'reversed'}:undefined},parent);
        } catch(error) {
          const current=await this.service.get(parent.id);
          if(current.payload.status!=='active' || (!harmReview && current.payload.usage?.harmState==='harm')) await this.callbacks.retirePin?.(parent.id);
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
    if(action.option==='keep') {
      if(review.payload.kind==='sequential-harm') await this.recordHarmOverride(ids[0],action);
      return this.restoreReview(review,action);
    }
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
      // Unique reference coverage protects a tool that is merely little used, not one researchers keep correcting.
      if (review.payload.kind === 'sequential-harm') return this.retire(row, 'sequential-harm');
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
