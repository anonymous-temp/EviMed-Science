/** A learning projection of preserved history. Never edits the stored source. */
import { ownTurnStarts, rootSessionOf } from './runTurnIdentity.mjs';

/** @typedef {{schema:'run-turn-scope/1',runId:string|null,rootSessionId:string|null,available:boolean,reason:string|null,rootTurnStarts:number[],childSessionIds:string[],unverifiedChildSessionIds:string[],partial:boolean}} RunTurnScope */
/** @typedef {{header?:any,messages:any[],runScope:RunTurnScope}} ScopedRunTranscript */

/** Select only the exact run's native turns and receipt-owned child work.
 * Missing ownership or fork-seed metadata is absence of learning evidence,
 * never permission to read every earlier turn. No timestamp heuristic.
 * @param {{header?:any,messages?:readonly any[],seedEndSeq?:number,sessionId?:string}|null|undefined} transcript
 * @param {any} run @returns {ScopedRunTranscript} */
export function scopeRunTranscript(transcript, run) {
  const { sessionId, messages: rawRoot } = rootSessionOf(transcript, run);
  /** @type {any[]} */
  const records = Array.isArray(transcript?.header?.sessions) ? transcript.header.sessions : [];
  const rootRecords = records.filter(row => row?.parentSessionId == null);
  const rootRecord = rootRecords.find(row => row.sessionId === sessionId);
  /** @type {RunTurnScope} */
  const runScope = { schema: 'run-turn-scope/1', runId: typeof run?.id === 'string' ? run.id : null,
    rootSessionId: sessionId, available: false, reason: 'turn_identity_unavailable', rootTurnStarts: /** @type {number[]} */ ([]),
    childSessionIds: /** @type {string[]} */ ([]), unverifiedChildSessionIds: /** @type {string[]} */ ([]), partial: false };
  /** @param {string} reason @returns {ScopedRunTranscript} */
  const empty = reason => ({ ...transcript, messages: [], runScope: { ...runScope, reason } });
  if (!sessionId || records.length > 64) return empty('session_scope_unavailable');
  if (typeof transcript?.sessionId === 'string' && transcript.sessionId && transcript.sessionId !== sessionId) return empty('live_root_mismatch');
  if (transcript?.header && (rootRecords.length !== 1 || !rootRecord)) return empty('captured_root_mismatch');
  if (transcript?.header && (!Number.isSafeInteger(rootRecord?.seedEndSeq) || rootRecord.seedEndSeq < -1)) return empty('root_seed_scope_unavailable');
  if (typeof transcript?.header?.runId === 'string' && run?.id && transcript.header.runId !== run.id) return empty('captured_run_mismatch');
  const liveSeed = transcript?.seedEndSeq;
  const rootSeed = rootRecord?.seedEndSeq ?? (typeof liveSeed === 'number' && Number.isSafeInteger(liveSeed) ? liveSeed : -1);
  const root = rawRoot.filter(row => row?.seeded !== true && (rootSeed < 0 || Number.isSafeInteger(row?.seq) && row.seq > rootSeed));
  /** @type {any[]} */
  const declared = Array.isArray(run?.kernelRequestIds) ? run.kernelRequestIds : [];
  const ids = declared.filter(id => typeof id === 'string' && id);
  if (declared.length && !ids.length) return empty('turn_identity_invalid');
  if (!ids.length && (!Number.isSafeInteger(run?.nativeTurn?.startSeq) || run.nativeTurn.startSeq < 0)) return empty('turn_identity_unavailable');
  const turns = new Set([...(ownTurnStarts(root, { ...run, kernelRequestIds: ids }) ?? [])].filter(seq => seq >= 0));
  if (!turns?.size) return empty('turn_identity_unavailable');
  const currentRoot = root.filter(row => turns.has(row.turnStartSeq));
  if (!currentRoot.length) return empty('turn_identity_unavailable');

  const ancestors = new Set([sessionId]);
  for (let pass = 0; pass < records.length; pass++) {
    let added = false;
    for (const row of records) if (ancestors.has(row?.parentSessionId) && typeof row?.sessionId === 'string' && !ancestors.has(row.sessionId)) { ancestors.add(row.sessionId); added = true; }
    if (!added) break;
  }
  /** @type {any[]} */
  const childIds = Array.isArray(transcript?.header?.runChildSessionIds) ? transcript.header.runChildSessionIds : [];
  const claimed = [...new Set(childIds
    .filter(id => typeof id === 'string' && id && id !== sessionId))];
  const children = new Map();
  for (const id of claimed) {
    const found = records.filter(row => row?.sessionId === id);
    const proof = found[0]?.runTurnOwnership;
    if (found.length === 1 && ancestors.has(id) && Number.isSafeInteger(found[0].seedEndSeq) && found[0].seedEndSeq >= -1
      && proof?.schema === 'child-run-turns/1' && typeof run?.id === 'string' && proof.runId === run.id
      && Array.isArray(proof.turnStartSeqs) && proof.turnStartSeqs.length <= 4096
      && proof.turnStartSeqs.every((/** @type {unknown} */ seq) => Number.isSafeInteger(seq) && Number(seq) >= 0)) children.set(id, { ...found[0], turns: new Set(proof.turnStartSeqs) });
    else runScope.unverifiedChildSessionIds.push(id);
  }
  const rootMessages = new Set(currentRoot);
  const messages = (transcript?.messages ?? []).filter(row => {
    if (!row.sessionId || row.sessionId === sessionId) return rootMessages.has(row);
    const child = children.get(row.sessionId);
    return child && child.turns.has(row.turnStartSeq) && row.seeded !== true && (child.seedEndSeq < 0 || Number.isSafeInteger(row.seq) && row.seq > child.seedEndSeq);
  });
  return { ...transcript, messages, runScope: { ...runScope, available: true, reason: null,
    rootTurnStarts: [...turns].sort((a, b) => a - b), childSessionIds: [...children.keys()].sort(),
    partial: runScope.unverifiedChildSessionIds.length > 0 || transcript?.header?.completeness === 'partial' } };
}
