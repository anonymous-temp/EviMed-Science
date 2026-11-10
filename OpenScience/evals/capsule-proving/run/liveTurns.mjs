import { messageTimes } from "./lab.mjs";

// Live interventions replace only a structurally marked user turn's recorded assistant reply.
// The journal is written before replay resumes, so a restart reuses the model's actual reply.

/** @param {any} before @param {any} after */
export function snapshotDiff(before, after) {
  return Object.fromEntries([...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
    .filter(file => before.files[file] !== after.files[file])
    .map(file => [file, { before: before.files[file] ?? null, after: after.files[file] ?? null }]));
}

/** Replay one session with opt-in live forget turns; ordinary sessions use the original ingestion path.
 * @param {{lab: any, user: any, session: any, caseId: string, answer: Function, persist: Function,
 * records?: any[], onUsage?: Function}} input
 */
export async function ingestLiveSession({ lab, user, session, caseId, answer, persist, records = [], onUsage = () => {} }) {
  const working = structuredClone(session);
  const indexes = working.messages.flatMap((message, index) => message.liveTurn === 'forget' ? [index] : []);
  if (!indexes.length) return lab.ingestSession(user, session);
  for (const index of indexes) {
    const turnId = `${session.sessionId}:${index}`;
    let row = records.find(record => record.turnId === turnId);
    if (row && !['answered', 'settled'].includes(row.state)) throw new Error(`live_turn_incomplete:${turnId}: inspect journal before retrying a mutation`);
    if (!row) {
      if (index > 0) await lab.ingestSession(user, { ...working, messages: working.messages.slice(0, index) }, { resumeMessages: true });
      const before = await lab.snapshot(user);
      row = { turnId, caseId, sessionId: session.sessionId, messageIndex: index, liveTurn: 'forget', at: messageTimes(working)[index],
        state: 'running', forgetCalled: null, uris: [], gatewayAnswers: [], before };
      await persist(row);
      const record = await answer({ question: working.messages[index].text, asOf: row.at, arm: 'product',
        memory: lab.memoryFor(user, { project: session.project ?? null, executeForget: true }),
        conversation: working.messages.slice(0, index), caseId, qid: `live:${turnId}`, project: session.project ?? null });
      onUsage(record);
      const calls = record.toolCalls.filter(call => call.name === 'mcp__openviking__forget');
      const after = await lab.snapshot(user);
      row = { ...row, state: record.error ? 'error' : 'answered', record, after,
        forgetCalled: calls.some(call => call.executed === true),
        uris: calls.filter(call => call.executed === true).map(call => call.args?.uri).filter(uri => typeof uri === 'string'),
        gatewayAnswers: calls.map(call => ({ uri: call.args?.uri ?? null, executed: call.executed === true, blocks: call.blocks, isError: call.isError })),
        snapshotDiff: snapshotDiff(before, after) };
      await persist(row);
      if (record.error) throw new Error(`live_turn_error:${turnId}:${record.error}`);
    }
    // Keep every other recorded exchange, including later turns in this same session.
    working.messages[index + 1] = { ...working.messages[index + 1], text: row.record.answer };
  }
  const result = await lab.ingestSession(user, working, { resumeMessages: true });
  const settled = await lab.snapshot(user);
  for (const index of indexes) {
    const turnId = `${session.sessionId}:${index}`;
    const row = records.find(record => record.turnId === turnId);
    // persist() updates the shared journal array before the next turn or restart.
    if (row) await persist({ ...row, state: 'settled', settled, settledDiff: snapshotDiff(row.before, settled) });
  }
  return result;
}
