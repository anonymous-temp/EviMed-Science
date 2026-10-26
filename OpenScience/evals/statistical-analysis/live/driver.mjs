// Natural, unbound research turns. The product owns routing, method selection and execution.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const ACTIVE = new Set(['queued', 'running', 'planned', 'dispatching', 'starting', 'waiting']);

export async function driveTurns({ api, sessionId, turns, upload, capture, timeoutMs = 900_000, pause = sleep, onTurn = async () => {} }) {
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
    if (timedOut) await api('POST', `/api/agent-runs/${run.id}/cancel`, {});
    const artifacts = await capture(run, index);
    const record = { index, text: turn.text, sessionId, startedAt, endedAt: new Date().toISOString(), run, timedOut, artifacts };
    records.push(record);
    await onTurn(record, records);
    if (timedOut || !['succeeded', 'completed'].includes(run.status) || !artifacts.complete) break;
  }
  return records;
}
