import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForEvolutionTranscript } from './evolution-transcript-wait.mjs';
/** Import-only engineering fixture; never count its copied publication as a newly developed method. */
export async function runEvolutionToolWakeAcceptance({ app, sourceToolId, ownerId, publicInput, probeId = 'v2', execute = false, signal }) {
  assert.equal(execute, true, 'Explicit isolated acceptance execution is required.');
  assert.equal(app.config.dataDir, '/acceptance');
  assert.ok(String(app.config.databaseUrl ?? app.config.productDatabaseUrl).includes('evimed_test_evolution'));
  assert.ok(/^[a-z0-9_-]{1,30}$/.test(probeId));
  const { service, supply, candidateEvaluator, integration } = app.evolution;
  const source = await service.get(sourceToolId);
  assert.ok(['diagnostic-posterior', 'decision-net-benefit'].includes(source.payload.methodId));
  assert.ok(source.payload.capabilityIds.includes('dataset-research-scoping'), 'The actual episode capability must be declared before creating this fixture.');
  const methodId = source.payload.methodId;
  assert.equal(source.payload.validationLevel, 'V2');
  const frozen = await supply.candidateForEvaluation({ id: source.id, digest: source.payload.artifactDigest, revision: source.payload.revision });
  const fixtureId = `engineering-tool-wake-${probeId}`;
  const user = await app.store.userById(ownerId), project = await app.store.projectFor(user, `tool-wake-${probeId}`, '工具发布唤醒隔离验收');
  const checkpointId = `engineering-tool-wake-checkpoint-${probeId}`;
  let checkpoint = await service.get(checkpointId, ownerId);
  if (checkpoint?.payload.completed) return checkpoint.payload.completed;
  assert.ok(checkpoint || !(await service.get(fixtureId)), 'An uncheckpointed active fixture cannot prove a new publication wake.');
  const agenda = checkpoint ? await app.autopilotService.get(ownerId, checkpoint.payload.agendaId) : await app.autopilotService.create(ownerId, { projectId: project.id, title: '工具发布唤醒工程验收', prompt: `调用平台工具 ${fixtureId}，向网关客户端 stdin 传入完整函数命名参数 JSON 对象：${JSON.stringify(publicInput)}。外层参数名必须保留，不可展开 specification，也不可传空对象。保存实际数值结果。这是工程唤醒验收，不作临床建议。`, topics: ['Public diagnostic arithmetic'], taskTypes: ['data-prospecting'], dailyBudgetCny: 10, weeklyBudgetCny: 20, maxEpisodeCny: 10, schedule: { kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' } });
  if (!checkpoint) checkpoint = await service.save('observation', checkpointId, { agendaId: agenda.id, projectId: project.id, fixtureId, sourceToolId, phase: 'initialized' }, null, ownerId);
  const sourceEpisodeId = `tool-wake-fixture-${probeId}`;
  if (checkpoint.payload.phase === 'initialized') await service.documents.put(ownerId, 'agenda', agenda.id, { ...agenda.payload, plannerStop: { kind: 'needs_input' }, evolutionWaiting: { sourceEpisodeId }, acceptanceFixture: true }, { expectedRevision: agenda.revision, projectId: project.id });
  const waiter = await service.waitFor({ userId: ownerId, projectId: project.id, agendaId: agenda.id, sourceEpisodeId, kind: 'tool', methodId, toolId: fixtureId });
  const unrelated = await service.waitFor({ userId: ownerId, projectId: project.id, agendaId: agenda.id, sourceEpisodeId, kind: 'tool', methodId: 'unrelated-method', toolId: 'unrelated-tool' });
  if (checkpoint.payload.phase === 'initialized') {
    assert.equal((await service.get(waiter.id, ownerId)).payload.status, 'waiting');
    const waitingAgenda = await app.autopilotService.get(ownerId, agenda.id);
    assert.equal(waitingAgenda.payload.enabled, false);
    assert.equal(waitingAgenda.payload.status, 'paused');
    checkpoint = await service.save('observation', checkpointId, { ...checkpoint.payload, phase: 'waiting-observed', waitingObservedAt: service.now().toISOString(), waiterId: waiter.id, unrelatedWaiterId: unrelated.id }, checkpoint, ownerId);
  }
  let publication = checkpoint.payload.publication;
  if (!publication) {
  const candidate = { ...source.payload, ...frozen, id: fixtureId, methodId, lineage: { ...source.payload.lineage, parents: [source.id] }, acceptanceFixture: true };
  const verdict = await candidateEvaluator.evaluate(candidate, { card: candidate, signal });
  assert.equal(verdict.ok, true); assert.equal(verdict.verificationLevel, 'V2');
  assert.ok(verdict.assessments.length >= 4 && verdict.assessments.every(item => item.passed));
  publication = await supply.publish(candidate, { card: candidate, evaluation: verdict, activate: false });
  await service.registerTool({ ...candidate, files: undefined, sourceFiles: undefined, artifactDigest: publication.digest, revision: publication.revision, nativeName: publication.nativeName, status: 'staged', dataLevel: source.payload.dataLevel });
  for (const assessment of verdict.assessments) await service.recordAssessment(fixtureId, { ...assessment, id: `${verdict.evaluatorHash}:${assessment.caseId}:${assessment.replicate}`, kind: assessment.kind === 'published' ? 'published-case' : assessment.kind, independent: true });
  await supply.activate(publication);
  const staged = await service.get(fixtureId);
  await service.save('tool', fixtureId, { ...staged.payload, status: 'active' }, staged);
  checkpoint = await service.save('observation', checkpointId, { ...checkpoint.payload, phase: 'published', publication }, checkpoint, ownerId);
  }
  await integration.publish({ id: `engineering-publication:${fixtureId}`, type: 'tool-ready', toolId: fixtureId, origin: 'tool-result' });
  const deadline = Date.now() + app.config.evolutionEvaluationTimeoutMs;
  let evidence;
  while (Date.now() < deadline) {
    await app.evolution.worker.tick({ kinds: ['evolution-event'] });
    const resolved = await service.get(waiter.id, ownerId), untouched = await service.get(unrelated.id, ownerId);
    assert.equal(untouched.payload.status, 'waiting');
    const receipts = (await service.list('use', ownerId)).filter(row => row.payload.projectId === project.id && row.payload.toolId === fixtureId && row.payload.digest === publication.digest && row.payload.result?.ok === true && row.payload.resultEvidence?.substantive === true);
    for (const receipt of receipts) {
      const run = (await app.agentRuns.list(project)).find(item => item.id === receipt.payload.runId);
      if (run?.status !== 'succeeded') continue;
      const transcript = await waitForEvolutionTranscript(project, run.id, { signal });
      if (resolved.payload.status === 'resolved' && transcript.header.completeness === 'complete') evidence = { runId: run.id, receiptId: receipt.id, waiterId: waiter.id, unrelatedWaiterId: unrelated.id };
    }
    if (evidence) break;
    const runs = await app.agentRuns.list(project);
    assertEvolutionWakeEpisode(runs, Boolean(evidence));
    await delay(1000, undefined, { signal });
  }
  assert.ok(evidence, 'Durable tool-ready consumption must wake an ordinary actual-call episode.');
  const completed = { kind: 'tool-publication-wake-engineering-fixture', newlyDevelopedTool: false, projectId: project.id, toolId: fixtureId, sourceToolId, digest: publication.digest, ...evidence };
  await service.save('observation', checkpointId, { ...checkpoint.payload, completed }, checkpoint, ownerId);
  return completed;
}

/** A terminal episode without a real successful tool receipt is a failed measurement, not a wait.
 * @param {any[]} runs @param {boolean} hasEvidence */
export function assertEvolutionWakeEpisode(runs,hasEvidence){
 if(!hasEvidence&&runs.some(run=>['succeeded','failed','cancelled'].includes(run.status)))throw new Error('The terminal wake episode has no successful substantive pinned-tool execution.');
}
