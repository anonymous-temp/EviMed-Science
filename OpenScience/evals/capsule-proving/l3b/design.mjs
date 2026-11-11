import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function loadPairs() {
  const manifest = JSON.parse(await fs.readFile(`${HERE}/pairs/manifest.json`, 'utf8'));
  const pairs = await Promise.all(manifest.items.map(async item => ({ ...JSON.parse(await fs.readFile(`${HERE}/pairs/${item.file}`, 'utf8')), kind: item.kind })));
  const controls = JSON.parse(await fs.readFile(`${HERE}/pairs/${manifest.controls}`, 'utf8'));
  return { manifest, pairs, controls };
}
export function armEnv(arm) {
  if (!['A', 'B', 'C', 'D'].includes(arm)) throw new Error('Expected arm A, B, C, D');
  return {
    OPEN_SCIENCE_MEMORY_RUNTIME_LOCK_ISOLATION_ENABLED: 'true',
    OPEN_SCIENCE_LEARNING_ENABLED: String(['C', 'D'].includes(arm)),
    OPEN_SCIENCE_MEMORY_ENABLED: String(arm !== 'A'),
    OPEN_SCIENCE_MEMORY_RECALL_ENABLED: String(arm !== 'A'),
    OPEN_SCIENCE_MEMORY_HISTORY_SEARCH_ENABLED: String(arm !== 'A'),
    ...(arm === 'A' ? { OPEN_SCIENCE_OPENVIKING_URL: '' } : {}),
    // All other product behavior uses integration defaults. D adds exactly these three treatments.
    ...(arm === 'D' ? {
      OPEN_SCIENCE_METHOD_PYRAMID_ENABLED: 'true',
      OPEN_SCIENCE_METHOD_OFFICIAL_IN_LOOP_ENABLED: 'true',
      OPEN_SCIENCE_METHOD_CARD_EVIDENCE_ENABLED: 'true',
    } : {}),
    OPEN_SCIENCE_LEARNING_CONCURRENCY: '1',
    OPEN_SCIENCE_LEARNING_WINDOW: '',
    OPEN_SCIENCE_LEARNING_CONSOLIDATION_INTERVAL_MS: '86400000',
    OPEN_SCIENCE_MAX_RUNNING_RUNTIMES: '1', OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER: '1',
    EVAL_METHOD_RANKER: '1', EVAL_DEFER_LEARNING: '1', EVAL_ADD_ONLY: '0',
    EVAL_CONTROL_EXTRA: `${HERE}/control.mjs`,
  };
}
// Same fixed interleaving in every arm, controls distributed through the exam, rotated by repetition.
export function examOrder(pairs, controls, rep) {
  const rows = pairs.flatMap((p, i) => i % 2 ? [p, controls[(i - 1) / 2]] : [p]).filter(Boolean);
  const shift = ((rep - 1) * 5) % rows.length;
  return [...rows.slice(shift), ...rows.slice(0, shift)];
}

export function profileBlocksOf(requests) {
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  return requests.flatMap(r => strings(r.messages).flatMap(text =>
    [...text.matchAll(/<openviking-context source="profile">([\s\S]*?)<\/openviking-context>/g)].map(m => m[0])));
}
