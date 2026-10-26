// Natural, unbound research turns. The product owns routing, method selection and execution.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const ACTIVE = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting']);

export async function driveTurns({ api, sessionId, turns, upload, capture, timeoutMs = 900_000, cancelTimeoutMs = 30_000, pause = sleep, onTurn = async () => {} }) {
  const records = [];
  for (const [index, turn] of turns.entries()) {
    await upload(turn.inputs ?? []);
    const startedAt = new Date().toISOString();
    let run = await api('POST', '/api/agent-runs/dispatch', {
      sessionId, dispatchId: `analysis-${randomUUID()}`, text: turn.text, automated: true,
    });
    const deadline = Date.now() + timeoutMs;
    while (ACTIVE.has(run.status) && Date.now() < deadline) {
      await pause(3000);
      const runs = await api('GET', '/api/agent-runs');
      run = runs.find((row) => row.id === run.id) ?? run;
    }
    const timedOut = ACTIVE.has(run.status);
    if (timedOut) {
      await api('POST', `/api/agent-runs/${run.id}/cancel`, {});
      const cancelDeadline = Date.now() + cancelTimeoutMs;
      while (ACTIVE.has(run.status) && Date.now() < cancelDeadline) {
        const runs = await api('GET', '/api/agent-runs');
        run = runs.find((row) => row.id === run.id) ?? run;
        if (ACTIVE.has(run.status)) await pause(1000);
      }
    }
    const artifacts = ACTIVE.has(run.status)
      ? { complete: false, failed: ['cancellation_not_settled'] } : await capture(run, index);
    const record = { index, text: turn.text, sessionId, startedAt, endedAt: new Date().toISOString(), run, timedOut, artifacts };
    records.push(record);
    await onTurn(record, records);
    if (timedOut || !['succeeded', 'completed'].includes(run.status) || !artifacts.complete) break;
  }
  return records;
}

// Structural evidence only. Independent numerical/source checks are still required.
export function analysisEvidence(record, before, mode) {
  const reasons = [];
  const manifest = record.artifacts.manifest ?? [];
  const previous = new Map(before.map((file) => [file.path, file.sha256]));
  const outputs = manifest.filter((file) => !file.path.startsWith('data/'));
  const results = outputs.filter((file) => /(?:results|estimates|metrics|values).*\.json$/.test(file.path));
  const reports = outputs.filter((file) => /(?:report|报告).*\.(?:md|html|docx)$/.test(file.path));
  const code = outputs.filter((file) => /\.(?:py|R|r|ipynb)$/.test(file.path));
  const executed = (record.artifacts.tools ?? []).some((tool) => ['bash', 'python', 'r', 'notebook'].includes(tool.name)
    && ['completed', 'success'].includes(tool.status) && !tool.error);
  const priorAnalysis = before.some((file) => /(?:results|estimates|metrics|values).*\.json$/.test(file.path) && !file.path.startsWith('data/'))
    && before.some((file) => /(?:report|报告).*\.(?:md|html|docx)$/.test(file.path))
    && before.some((file) => /\.(?:py|R|r|ipynb)$/.test(file.path));
  const conversationContinuation = mode !== 'analysis' && priorAnalysis && record.run.effectiveAgentId === 'open-domain-answer';
  if (record.run.effectiveAgentId !== 'statistical-analysis' && !conversationContinuation) reasons.push('unexpected_route');
  if (!results.length || !reports.length || !code.length) reasons.push('analysis_artifacts_missing');
  if (mode === 'reuse') {
    if (!results.length || results.some((file) => previous.get(file.path) !== file.sha256)) reasons.push('numerical_results_not_reused');
  } else {
    if (!executed) reasons.push('successful_execution_not_observed');
    if (!results.some((file) => previous.get(file.path) !== file.sha256)) reasons.push('new_results_not_observed');
    if (!reports.some((file) => previous.get(file.path) !== file.sha256)) reasons.push('new_report_not_observed');
  }
  return { complete: reasons.length === 0, reasons, mode, numericalVerification: 'requires-independent-judge' };
}
