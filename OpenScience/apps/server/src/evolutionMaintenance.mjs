import { EVOLUTION_OFFLINE_ONLY } from './evolutionServingPolicy.mjs';
import { methodHarmTest, EVOLUTION_TOOL_HARM_TEST, canonicalJson } from '@evimed/domain';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './security.mjs';
import { evolutionKey } from './evolutionService.mjs';
import { EVOLUTION_PROJECT_ID } from './internalProjects.mjs';

/**
 * Retirement evidence for a published tool: the platform's existing sequential harm test, applied the
 * way the learned-methods loop applies it (`retirementProposal` in the domain's `methodGraph.mjs`):
 * `methodHarmTest` read over the revision's own trials, in the order they happened, each at its
 * latest outcome. Not a second sequential test, and never restarted. `methodHarmTest` itself reads a
 * whole record and stops only at `harm` (since 2026-11-03 a `clear` is where a record stands, not a
 * verdict); what stops this test at its first verdict is this module, which takes no new trial once
 * the trials read `clear` or `harm` or number 40 (`foldHarmTrial`).
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
 *    cleared and later drifts is the offline lab's to catch, and a repaired
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
const USAGE_COUNTERS = ['retrieved', 'invoked', 'executionSucceeded', 'executionFailed', 'attributablePositiveResults', 'succeeded', 'corrected', 'costCny', 'runs'];
/** Call and retrieval identities remembered per run for idempotency; a run that goes past this has its
 *  further calls counted without being remembered, so one looping run cannot grow a record without bound. */
const IDENTITIES_PER_RUN = 500;
/** Optimistic writes are retried on a revision conflict; two runs calling one tool at once is ordinary. */
const WRITE_ATTEMPTS = 8;
/** Usage accounting of one tool is queued inside a process, so a burst of calls of one tool holds one pooled
 *  connection at a time rather than one per caller waiting on the same lock. */
const usageQueues = new WeakMap();

/**
 * Exact operating characteristics of the capped sequential test this module runs (`methodHarmTest` over
 * trials that stop at its first verdict, `foldHarmTrial`), by dynamic programming over (trials, bad): the
 * probability it ends in `harm`, in `clear`, and the mean number of trials it reads, when each trial is
 * bad independently with probability `rate`.
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
    attributablePositiveResults: invoked && observation.outcome === 'accepted' && observation.corrected !== true && observation.positiveEvidence?.verified === true && ['trusted-replay','verified-uncorrected-result'].includes(observation.positiveEvidence?.kind) ? 1 : 0,
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
  return { ...current, axis: 'researcher-correction', trials, state: read.state, reason: read.reason, runs: read.runs, bad: read.bad, llr: read.llr };
}
/** Maintenance uses actual invocation outcomes, not reads of a skill file. */
export class EvolutionMaintenance {
  /** @param {any} dependencies */
  constructor({ service, callbacks = {} }) { this.service = service; this.callbacks = callbacks; }
  /** A strict optimistic write: a revision conflict is thrown to the retry loop, never absorbed.
   * `telemetry` is the ledger's own kind of write for counters derived from a record rather than a change of it
   * (`ProductDocuments.put`): the revision still moves, no history row is kept and `updated_at` stays, which is how
   * the learned-methods loop counts use. It cannot create a record.
   * @param {string} type @param {string} id @param {any} payload @param {any} previous @param {{telemetry?:boolean}} [options] */
  async write(type, id, payload, previous, { telemetry = false } = {}) {
    return this.service.documents.put(await this.service.owner(), 'knowledge', id, { ...payload, recordType: `evolution-${type}` },
      { expectedRevision: previous?.revision ?? 0, projectId: payload.projectId ?? EVOLUTION_PROJECT_ID, ...(telemetry && previous ? { telemetry: true } : {}) });
  }
  /**
   * Run `work` as one unit for one tool: on PostgreSQL, one transaction on one connection (every ledger read and
   * write inside it uses that connection) holding the tool's usage lock until it commits.
   *
   * Optimistic writes with a few retries were the whole protection at first, and against the real ledger they were
   * not enough: forty runs calling one tool at the same moment left fourteen refused with a revision conflict after
   * eight attempts each, their run records written and their counts never added. A lock held for a few short
   * statements is the plain answer to many writers of one row. The transaction also makes the run's record and the
   * tool's counters one write: both are kept or neither is. Callers in this process queue for the tool first, so
   * the lock is contended between processes and not between forty connections of one. A ledger without a
   * database (the in-memory double of the unit tests) has no transaction to offer and runs `work` in its turn.
   * @template T @param {string} toolId @param {() => Promise<T>} work @returns {Promise<T>}
   */
  async atomically(toolId, work) {
    const database = this.service.documents.database;
    const unit = database?.transaction && database.withTransactionClient
      ? () => database.transaction((/** @type {any} */ client) => database.withTransactionClient(client, async () => {
        await database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`evimed-evolution:tool-usage:${toolId}`]);
        return work();
      })) : work;
    // Called from inside a transaction someone else holds, the unit joins that transaction and must not wait in this
    // process's queue: the caller ahead of it there may be waiting for the lock that transaction already has.
    if (database?.transactionScope?.()) return unit();
    const queue = usageQueues.get(this.service) ?? usageQueues.set(this.service, new Map()).get(this.service);
    const pending = (queue.get(toolId) ?? Promise.resolve()).catch(() => {}).then(unit);
    queue.set(toolId, pending);
    try { return await pending; } finally { if (queue.get(toolId) === pending) queue.delete(toolId); }
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
    return (await this.service.get(this.observationId(tool, runId)))?.payload ?? null;
  }
  /**
   * Record what one run did with a tool.
   *
   * Each run has its own record, and the tool keeps counters and the harm test's trials (at most 40).
   * Both used to live in one array on the tool's record (integration finding F16): two runs calling a
   * tool at once lost one of the two observations to the revision conflict, and past roughly 500 runs
   * the record exceeded the ledger's 256 KiB limit, after which the most used tool could record nothing
   * and could not be retired. Now the run's record and the tool's counters are written as one unit under the
   * tool's usage lock (`atomically`), the counter update is an increment of what this report added, and the harm
   * trial is an idempotent upsert. Counting use writes no history: a call is not a version of the tool.
   * @param {string} id @param {any} observation `userId` is the account whose run this is
   */
  async observe(id, observation) {
    // Read once before the transaction: an unknown tool is refused without taking a lock, and the ledger's own
    // one-time schema preparation never happens inside a transaction that may roll back.
    if (!await this.service.get(id)) throw new HttpError(404, 'evolution_tool_missing', 'Tool not found.');
    const saved = await this.atomically(id, async () => {
      const tool = await this.service.get(id);
      if (!tool) throw new HttpError(404, 'evolution_tool_missing', 'Tool not found.');
      const observationId = this.observationId(tool, observation.runId);
      const folded = await this.retried(async () => {
        const row = await this.service.get(observationId);
        const merged = foldRun(row?.payload ?? null, observation, this.service.now().toISOString());
        if (row && canonicalJson({ ...row.payload, recordType: null }) === canonicalJson({ toolId: tool.id, ...merged, recordType: null })) return { state: row.payload, delta: null };
        const before = contribution(row?.payload), after = contribution(merged);
        // The run's record is nothing but what the run did: its first write creates it, every later one is a count.
        const written = await this.write('observation', observationId, { toolId: tool.id, ...merged }, row, { telemetry: true });
        return { state: written.payload, delta: Object.fromEntries(USAGE_COUNTERS.map(key => [key, after[key] - before[key]])) };
      });
      if (!folded.delta) return null;
      // What the tool's record says, as opposed to what it counts: the harm test's trials and verdict.
      const said = (/** @type {any} */ harm) => canonicalJson([harm?.trials ?? [], harm?.state ?? 'watching', harm?.reviewId ?? null, harm?.overriddenAt ?? null]);
      // Other writers of the tool's record (an assessment, a retirement) do not take the usage lock; they are rare, and a conflict with one is retried.
      return this.retried(async () => {
        const current = await this.service.get(id);
        const usage = { ...current.payload.usage };
        for (const key of USAGE_COUNTERS) usage[key] = Number(usage[key] ?? 0) + folded.delta[key];
        usage.executionCount = usage.invoked;
        usage.harm = foldHarmTrial(usage.harm, folded.state);
        usage.harmState = usage.harm.overriddenAt ? 'overridden' : usage.harm.state;
        const payload = current.payload;
        const countersOnly = said(usage.harm) === said(current.payload.usage?.harm) && usage.harmState === (current.payload.usage?.harmState ?? usage.harmState);
        const validationLevel=payload.validationLevel==='V4'&&(usage.harmState!=='clear'||usage.attributablePositiveResults<1)?'V3':payload.validationLevel;
        return this.write('tool', id, { ...payload, usage, validationLevel }, current, { telemetry: countersOnly&&validationLevel===payload.validationLevel });
      });
    });
    if (!saved) return this.service.get(id);
    const harm = saved.payload.usage.harm;
    if (harm.state === 'harm' && !harm.reviewId && !harm.overriddenAt) { const reviewed=await this.proposeHarmReview(saved); await this.reviewLineageAlerts(reviewed); return reviewed; }
    // The shared test's own parameters decide when live evidence is sufficient.
    if (saved.payload.validationLevel === 'V3' && harm.state === 'clear' && saved.payload.usage.runs >= EVOLUTION_TOOL_HARM_TEST.minRuns && saved.payload.usage.attributablePositiveResults >= 1) return this.service.save('tool', id, { ...saved.payload, validationLevel: 'V4' }, saved);
    return saved;
  }
  /** Aggregate revision alarms over a lineage without disabling any serving revision. @param {any} tool */
  async reviewLineageAlerts(tool) {
    const lineageId=tool.payload.lineage?.rootId??tool.payload.lineage?.parents?.[0]??tool.id;
    return this.service.withLock(`lineage-alert:${lineageId}`,async()=>{
      const id=`evolution-lineage-alert-${evolutionKey([lineageId])}`,previous=await this.service.get(id);
      const cutoff=this.service.now().getTime()-90*86400000;
      const alerts=(previous?.payload.alerts??[]).filter(item=>Date.parse(item.at)>=cutoff);
      const revision=tool.payload.artifactDigest??tool.payload.revision;
      if(!alerts.some(item=>item.toolId===tool.id&&item.revision===revision))alerts.push({toolId:tool.id,revision,at:this.service.now().toISOString()});
      const reviewId=`evolution-lineage-review-${evolutionKey([lineageId,alerts.map(item=>[item.toolId,item.revision])])}`;
      await this.service.save('lineage-alert',id,{lineageId,alerts,label:alerts.length>=2?'two-recent-alarms':null,reviewId:alerts.length>=2?reviewId:null},previous);
      if(alerts.length<2)return;
      const tools=await this.service.tools();
      for(const row of tools.filter(item=>item.id===lineageId||item.id===tool.id||item.payload.lineage?.rootId===lineageId||item.payload.lineage?.parents?.includes(lineageId))){
        const current=await this.service.get(row.id);
        if(!current.payload.labels?.includes('two-recent-alarms'))await this.service.save('tool',row.id,{...current.payload,labels:[...(current.payload.labels??[]),'two-recent-alarms']},current);
      }
      if(!await this.service.get(reviewId))await this.service.save('maintenance-review',reviewId,{kind:'lineage-harm',lineageId,parentToolIds:[...new Set(alerts.map(item=>item.toolId))],alerts,status:'pending'});
      await this.callbacks.proposeReview?.({category:'lineage-harm',subjectId:reviewId,directional:true,attemptedPaths:['revision-harm-review','ninety-day-lineage-review'],title:'复核近期两次报警的工具谱系',body:'同一谱系在 90 天内两次报警，已标记并保留现有服务。复核关联原因和修复方向。',options:[{id:'keep',label:'保留并继续观察',operation:'keep'}],recommended:'keep',conservative:'keep'});
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
      // The conservative option of a harm alarm is the protective one: a soft retirement the same decision reverses (`restoreReview`).
      options: [{ id: 'retire', label: '软退役并保留历史', operation: 'maintenance-retire' }, { id: 'keep', label: '保留现有工具', operation: 'keep' }], recommended: 'retire', conservative: 'retire' });
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
    }, {preserveProgress:true});
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
    }, {preserveProgress:true});
  }
  /** What serving carries out of a review: keeping or retiring; a repair or a merge is the offline lab's. @param {any} action */
  async executeReview(action) {
    if (!['keep', 'retire'].includes(action.option)) return EVOLUTION_OFFLINE_ONLY;
    const review = await this.service.get(action.subjectId);
    if (!review || review.payload.recordType !== 'evolution-maintenance-review') throw new HttpError(404, 'evolution_tool_missing', 'Maintenance review unavailable.');
    const ids = review.payload.parentToolIds;
    if(action.option==='keep') {
      // An override silences the harm alarm for good, so only a person's explicit answer records one; a keep nobody chose leaves the verdict standing.
      if(review.payload.kind==='sequential-harm' && action.source==='user') await this.recordHarmOverride(ids[0],action);
      return this.restoreReview(review,action);
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
    return { state: 'kept' };
  }
  /** The operators' monthly figures of a completed month: reads of the ledger, written once. @param {any} [input] */
  async monthly(input = {}) {
    const currentMonth = this.service.now().toISOString().slice(0, 7);
    const metricsMonth = input.metricsMonth ?? new Date(Date.UTC(this.service.now().getUTCFullYear(), this.service.now().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(metricsMonth) || metricsMonth >= currentMonth) throw new Error('Monthly metrics require a completed calendar month.');
    const metricsId = `evolution-monthly-metrics-${metricsMonth}`;
    const known = await this.service.get(metricsId);
    if (known) return known;
    const date = new Date(`${metricsMonth}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 1);
    const previous = await this.service.get(`evolution-monthly-metrics-${date.toISOString().slice(0, 7)}`);
    const metrics = await this.callbacks.monthlyMetrics?.(metricsMonth, { previous: previous?.payload.metrics ?? null }) ?? {};
    return this.service.save('monthly-metrics', metricsId, { month: metricsMonth, metrics, observedAt: this.service.now().toISOString() });
  }
}
/** @param {any} dependencies */
export function createEvolutionMaintenance(dependencies) { return new EvolutionMaintenance(dependencies); }
