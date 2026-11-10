/** Deterministic offline packets and hash-bound checkpoints; uses the existing Qwen client unchanged. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { judgeBatch, JUDGE_MODEL, JUDGE_RUBRIC } from '../offlineJudge.mjs';
import { memoryLines } from './scoreChecks.mjs';

export const PACKET_SCHEMA = 'capsule-proving-run-judge/1';
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(v => stableJson(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const JUDGE_CLIENT_SHA256 = sha256(readFileSync(new URL('../offlineJudge.mjs', import.meta.url)));
export const rowKey = row => stableJson([row.runId, row.set, row.split, row.caseId, row.kind, row.id]);

/** Context is scorer-only: original question, gold rubric, actual retrieval and source history, never a model workspace. */
export function buildJudgePacket(row, context) {
  if (row.verdict !== 'needs-judge') return null;
  // Attribution and unsupported-place checks may require a nearby heading or a line without the anchor.
  // Preserve complete files with line coordinates rather than silently truncate semantic evidence.
  const payload = { schema: PACKET_SCHEMA, model: JUDGE_MODEL, rubricVersion: JUDGE_RUBRIC, judgeClientSha256: JUDGE_CLIENT_SHA256,
    rowKey: rowKey(row), question: context.question ?? '', reply: context.answer?.answer ?? '',
    expected: context.rubric, source: context.source ?? null, gold: context.gold ?? null,
    retrieved: context.answer?.toolCalls ?? [], opening: context.answer?.opening ?? null,
    memoryLines: memoryLines(context.snapshot) ?? [],
    memorySnapshots: (context.snapshots ?? []).map(s => ({ afterSession: s.afterSession, lines: memoryLines(s) })),
    control: context.control ?? null,
    taskStatus: 'completed', failures: [], checks: row.checks };
  const hash = sha256(stableJson(payload));
  return { id: `run-score:${hash}`, hash, ...payload };
}

/** A stale verdict cannot be applied to a changed answer, snapshot, rubric or control. */
export function mergeJudgeResults(rows, packets, results) {
  const packetByRow = new Map(packets.map(p => [p.rowKey, p])), byId = new Map();
  for (const result of results) {
    if (byId.has(result.id) || !['pass', 'fail', 'unknown'].includes(result.verdict) || typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('judge_checkpoint_invalid');
    byId.set(result.id, result);
  }
  return rows.map(row => {
    if (row.verdict !== 'needs-judge') return row;
    const packet = packetByRow.get(rowKey(row)), result = packet && byId.get(packet.id);
    if (result && result.hash !== packet.hash) throw new Error('judge_resume_identity_mismatch');
    if (!result) return { ...row, verdict: 'unknown', needsJudge: true };
    if (!/^qwen3\.8-max(?:-(?:0902|2026-09-02))?$/.test(result.model ?? '')) throw new Error('judge_checkpoint_model_invalid');
    return { ...row, verdict: result.verdict, by: 'judge', needsJudge: true,
      judge: { model: result.model, requestId: result.requestId ?? null, verdict: result.verdict, reason: result.reason } };
  });
}

/** Save after every batch. fetchImpl allows tests to exercise the full call path without network. */
export async function judgePackets(packets, { key, results = [], fetchImpl, persist = async () => {}, batchSize = 1 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12) throw new Error('judge_batch_invalid');
  const valid = new Map(packets.map(p => [p.id, p]));
  const saved = results.filter(result => valid.has(result.id));
  // Validate before making any paid call, including checkpoint duplicates and provider identity.
  mergeJudgeResults(packets.map(p => {
    const [runId, set, split, caseId, kind, id] = JSON.parse(p.rowKey);
    return { runId, set, split, caseId, kind, id, verdict: 'needs-judge' };
  }), packets, saved);
  const done = new Set(saved.map(r => r.id)), pending = packets.filter(p => !done.has(p.id));
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const result = await judgeBatch(batch, { key, fetchImpl });
    saved.push(...result.judgements.map(row => ({ ...row, hash: valid.get(row.id).hash,
      model: result.model, requestId: result.requestId, usage: result.usage })));
    await persist(saved);
  }
  return saved;
}
