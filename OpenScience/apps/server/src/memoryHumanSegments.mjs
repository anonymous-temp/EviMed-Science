import { createHash } from 'node:crypto';
import { isPlatformStartedRun } from './memoryDispatch.mjs';

export const inputDigest = text => createHash('sha256').update(text).digest('hex');

/** Minted only by the authenticated owner prompt paths, before adding context.
 * The run ledger keeps a digest, never an extra copy of the submitted words. */
export function humanInputReceipt(text, now = Date.now()) {
  return typeof text === 'string' && text.trim() ? { digest: inputDigest(text), at: new Date(now).toISOString() } : null;
}

export function plainInput(message) {
  if (message?.role !== 'user') return null;
  if (typeof message.content === 'string' && !message.parts) return message.content;
  if (!Array.isArray(message.parts) || !message.parts.length || !message.parts.every(part => part?.type === 'text' && typeof part.text === 'string')) return null;
  return message.parts.map(part => part.text).join('\n');
}

/** A dated archive message must belong to exactly one run. The unmodified
 * archive has no kernel seq, so its content must independently match the
 * authenticated original of that run. A missing date cannot be reconstructed. */
export function provenArchiveInput(runs, message) {
  const time = Date.parse(message?.created_at ?? '');
  const text = plainInput(message);
  if (!text || !Number.isFinite(time)) return null;
  const covering = runs.filter(run => Date.parse(run.startedAt) <= time
    && (run.status === 'running' || Date.parse(run.finishedAt) >= time));
  if (covering.length !== 1) return null;
  const run = covering[0];
  if (run.deleted || run.forkedFrom || isPlatformStartedRun(run) || !run.kernelRequestIds?.length
    || !(Date.parse(run.memoryInput?.at) <= time) || run.memoryInput.digest !== inputDigest(text)) return null;
  return { run, text, time };
}

/** In the kernel transcript, bind both the accepted request and its sequence.
 * Exclude inputs appended by modules, assistants, child sessions or later steers. */
export function provenTranscriptInput(run, messages) {
  if (!run?.memoryInput || run.deleted || run.forkedFrom || isPlatformStartedRun(run) || !run.kernelRequestIds?.[0]) return null;
  const matches = messages.filter(message => message.source === 'user' && message.role === 'user'
    && message.sourceRequestId === run.kernelRequestIds[0] && Number.isSafeInteger(message.seq)
    && (!run.nativeTurn || run.nativeTurn.userSeq === message.seq && run.nativeTurn.startSeq === message.turnStartSeq));
  if (matches.length !== 1) return null;
  const message = matches[0];
  // A selected module can append separate text parts after the signed human
  // input. Only its exact original first part can then be copied.
  const first = message.parts?.[0];
  const text = first?.type === 'text' && typeof first.text === 'string' && inputDigest(first.text) === run.memoryInput.digest
    ? first.text : plainInput(message);
  if (!text || inputDigest(text) !== run.memoryInput.digest || !Number.isSafeInteger(message.time)
    || !(Date.parse(run.memoryInput.at) <= message.time)) return null;
  return { run, text, time: message.time, seq: message.seq };
}
