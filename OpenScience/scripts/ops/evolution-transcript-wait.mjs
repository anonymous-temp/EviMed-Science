import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { setTimeout as delay } from 'node:timers/promises';
import { readRunTranscript } from '../../apps/server/src/runTranscripts.mjs';
/** Wait only for a genuinely sealed complete durable transcript; never dispatch or synthesize evidence. */
export async function waitForEvolutionTranscript(project, runId, { signal, timeoutMs = 60000, pollMs = 500, read = readRunTranscript } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid transcript wait bounds.');
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const transcript = await read(project, runId);
    if (transcript?.header?.completeness === 'complete') return transcript;
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
  } while (Date.now() <= deadline);
  throw new Error('Complete durable transcript sealing did not finish before the acceptance deadline.');
}

/** Hash the actual sealed transcript, including its complete messages; headers need no invented hash. */
export function evolutionTranscriptHash(transcript) {
  if (transcript?.header?.completeness !== 'complete') throw new Error('Only complete durable transcripts establish acceptance evidence.');
  return createHash('sha256').update(canonicalJson(transcript)).digest('hex');
}
