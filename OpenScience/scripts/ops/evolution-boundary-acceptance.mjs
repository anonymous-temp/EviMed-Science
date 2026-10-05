import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '@evimed/domain';
import { createEvolutionDevelopmentValidation } from '../../apps/server/src/evolutionDevelopmentValidation.mjs';
import { evolutionKey } from '../../apps/server/src/evolutionService.mjs';
import { waitForEvolutionTranscript, evolutionTranscriptHash } from './evolution-transcript-wait.mjs';

const inputHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** A rejection proves only the exact declared input and immutable tool revision. */
export function boundaryExecutionReceipts(rows, { userId, projectId, runId, tool, cases }) {
  const receipts = rows.filter(row => {
    const value = row.payload;
    return value?.userId === userId && value.projectId === projectId && value.runId === runId
      && value.toolId === tool.id && value.digest === tool.payload.artifactDigest && value.revision === tool.payload.revision
      && value.callId && value.result?.ok === true && value.resultEvidence?.kind === 'structured'
      && value.resultEvidence?.explicitlyUnsupported === true && value.resultEvidence?.substantive === false;
  });
  const checked = cases.map(item => ({ caseId: item.id, inputSha256: inputHash(item.input),
    receiptIds: receipts.filter(row => row.payload.inputSha256 === inputHash(item.input)).map(row => row.id) }));
  return { passed: checked.length > 0 && checked.every(item => item.receiptIds.length > 0), cases: checked };
}

/** Replay a public regression, then use the production maintenance repair and parent replay path.
 * This engineering control never changes a hidden reference or resets the model budget. */
export async function repairEvolutionPublicBoundary({ app, controller, tool, contract, signal, checkpoint = async () => {} }) {
  assert.equal(app.config.dataDir, '/acceptance');
  assert.ok(String(app.config.databaseUrl ?? app.config.productDatabaseUrl).includes('evimed_test_evolution'));
  const { service, supply, maintenance, worker } = app.evolution;
  const identity = evolutionKey([tool.id, tool.payload.artifactDigest, inputHash(contract)]);
  const reviewId = `evolution-boundary-review-${identity}`, actionId = `acceptance-boundary-repair-${identity}`;
  let review = await service.get(reviewId);
  const validator = createEvolutionDevelopmentValidation({ controller });
  if (!review) {
    const original = await supply.candidateForEvaluation({ id: tool.id, digest: tool.payload.artifactDigest, revision: tool.payload.revision });
    const result = await validator.validate(original, { contract, signal });
    if (result.ok) return { toolId: tool.id, digest: tool.payload.artifactDigest, revision: tool.payload.revision,
      repairRequired: false, publicContractHash: inputHash(contract), executions: result.executions, scored: false };
    assert.equal(result.status, 'repair', 'A genuine executed public regression is required before repair.');
    assert.ok(result.executions?.some(row => row.executed && !row.passed));
    review = await service.save('maintenance-review', reviewId, { kind: 'public-boundary-regression', parentToolIds: [tool.id],
      status: 'pending', publicContractHash: inputHash(contract), executions: result.executions });
    await checkpoint({ stage: 'actual-public-boundary-regression', toolId: tool.id, digest: tool.payload.artifactDigest,
      publicContractHash: inputHash(contract), executions: result.executions, scored: false });
  }
  await maintenance.executeReview({ subjectId: review.id, actionId, option: 'repair' });
  const dossierId = `evolution-repair-${evolutionKey([review.id, actionId])}`;
  let dossier = await service.get(dossierId);
  while (dossier.payload.status !== 'published' && Number(dossier.payload.buildAttempts ?? 0) < app.config.evolutionMaxBuildAttempts) {
    signal?.throwIfAborted();
    const attempt = Number(dossier.payload.buildAttempts ?? 0);
    const result = await worker.perform({ id: `acceptance-boundary-build-${identity}-${attempt}`, kind: 'evolution-build',
      payload: { dossierId, decisionActionId: actionId } });
    await checkpoint({ stage: 'actual-boundary-repair-attempt', dossierId, attempt, status: result.status, feedback: result.feedback, scored: false });
    dossier = await service.get(dossierId);
    if (result.status !== 'repair') break;
  }
  assert.equal(dossier.payload.status, 'published', 'The actual AI repair must independently pass before acceptance.');
  const repaired = await service.get(dossier.payload.toolId);
  assert.equal(repaired.payload.status, 'active');
  assert.equal(repaired.payload.validationLevel, 'V2');
  assert.ok(repaired.payload.lineage.parents.includes(tool.id));
  const original = await service.get(tool.id);
  assert.equal(original.payload.status, 'alias');
  assert.equal(original.payload.replacedBy, repaired.id);
  const candidate = await supply.candidateForEvaluation({ id: repaired.id, digest: repaired.payload.artifactDigest, revision: repaired.payload.revision });
  const replay = await validator.validate(candidate, { contract, signal });
  assert.equal(replay.ok, true);
  return { toolId: repaired.id, digest: repaired.payload.artifactDigest, revision: repaired.payload.revision, repairRequired: true,
    originalToolId: tool.id, originalDigest: tool.payload.artifactDigest, dossierId, reviewId,
    publicContractHash: inputHash(contract), executions: replay.executions,
    assessments: repaired.payload.assessments.map(item => ({ id: item.id, caseId: item.caseId, passed: item.passed })), scored: false };
}

/** The researcher submits all declared public invalid inputs through the ordinary runtime. */
export async function runEvolutionBoundaryAcceptance({ app, ownerId, password, tool, contract, probeId = 'v1', signal }) {
  assert.equal(app.config.dataDir, '/acceptance');
  assert.ok(/^[a-z0-9_-]{1,40}$/.test(probeId));
  const cases = contract.cases.filter(item => item.expectedRefusal === true);
  assert.ok(cases.length);
  const login = await fetch('http://127.0.0.1:8787/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ownerId, password }), signal });
  assert.ok(login.ok);
  const identity = await login.json(), projectId = `evolution-boundary-acceptance-${probeId}`;
  const project = await app.store.projectFor(await app.store.userById(ownerId), projectId, '科研工具输入边界验收');
  const headers = { 'content-type': 'application/json', 'x-evimed-automated': '1', Cookie: login.headers.get('set-cookie').split(';')[0],
    'X-Open-Science-CSRF': identity.data.csrfToken, 'X-Open-Science-Project': project.id };
  const request = async (url, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:8787' + url, { method, headers, body: JSON.stringify(body), signal });
    const value = await response.json(); assert.ok(response.ok, `Acceptance API failed: ${response.status} ${value.code ?? value.error?.code ?? 'unknown'}`); return value.data;
  };
  const dispatchId = `acceptance_boundary_${probeId}_${tool.payload.artifactDigest.slice(7, 23)}`;
  let run = (await app.agentRuns.list(project)).find(item => item.dispatchId === dispatchId);
  if (!run) {
    const session = await request('/api/runtime/sessions', {});
    await request(`/api/research-sessions/${encodeURIComponent(session.id)}`, { mode: 'open-domain' }, 'PUT');
    const dispatched = await request('/api/agent-runs/dispatch', { sessionId: session.id, dispatchId, line: 'statistical-analysis', automated: true,
      text: `使用已安装的平台工具 ${tool.id}，分别真实执行以下 ${cases.length} 个公开非法输入，每个只调用一次。每个 input 就是完整函数参数，保持逐字段逐数值不变。报告实际的结构化拒绝；不要修正数据再算，不要追加猜测性测试。没有实际拒绝时如实报告。样例：${JSON.stringify(cases.map(item => ({ id: item.id, input: item.input })))}` });
    run = { id: dispatched.id ?? dispatched.run?.id, status: 'queued' };
  }
  const deadline = Date.now() + app.config.evolutionEvaluationTimeoutMs;
  while (Date.now() < deadline && ['queued', 'dispatching', 'running'].includes(run?.status)) {
    await delay(1000, undefined, { signal });
    run = (await app.agentRuns.list(project)).find(item => item.id === run.id);
  }
  assert.equal(run?.status, 'succeeded');
  const transcript = await waitForEvolutionTranscript(project, run.id, { signal });
  assert.equal(transcript.header.completeness, 'complete');
  const proof = boundaryExecutionReceipts(await app.evolution.service.list('use', ownerId), { userId: ownerId, projectId: project.id, runId: run.id, tool, cases });
  assert.equal(proof.passed, true, 'Every exact invalid input needs its own successful structured refusal receipt.');
  await app.runtimeManager.stop(project);
  return { projectId: project.id, runId: run.id, toolId: tool.id, digest: tool.payload.artifactDigest,
    cases: proof.cases, transcriptHash: evolutionTranscriptHash(transcript), scored: false };
}
