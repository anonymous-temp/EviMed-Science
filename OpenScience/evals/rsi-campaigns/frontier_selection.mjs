import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { frontierMixSelect } from '../../packages/domain/src/frontierMix.mjs';
import { execFileSync } from 'node:child_process';
import { frontierMixCandidate } from '../../apps/server/src/frontierPipeline.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** Frozen full-day SQL projection plus all external selection inputs. Missing truth is ineligible, never imputed. */
export function replayFrontierPool(pool, threshold) {
  const missing = [];
  for (const key of ['day', 'window', 'rows', 'events', 'genreFloors', 'congressActive', 'preprintPlaces', 'preprintMinScore', 'scoreVersion']) {
    if (pool[key] == null) missing.push(key);
  }
  if (!Array.isArray(pool.rows)) missing.push('rows.array');
  if (typeof pool.congressActive !== 'boolean') missing.push('congressActive.boolean');
  if (!Number.isInteger(pool.preprintPlaces) || pool.preprintPlaces < 0 || !Number.isFinite(pool.preprintMinScore)) missing.push('preprint.parameters');
  if (typeof pool.scoreVersion !== 'string' || !pool.scoreVersion.trim()) missing.push('scoreVersion.state');
  if (!pool.events || typeof pool.events !== 'object' || Array.isArray(pool.events)) missing.push('events.object');
  if (!pool.genreFloors || typeof pool.genreFloors !== 'object' || Array.isArray(pool.genreFloors) || Object.values(pool.genreFloors).some((n) => !Number.isFinite(n))) missing.push('genreFloors.object');
  if (typeof pool.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pool.day)) missing.push('day.date');
  for (const members of Object.values(pool.events ?? {})) {
    if (!Array.isArray(members) || members.some((m) => !m || typeof m.id !== 'string' || typeof m.genre !== 'string' || typeof m.selected !== 'boolean' || typeof m.safety !== 'boolean' || !Object.hasOwn(m, 'rule') || !Object.hasOwn(m, 'evidenceType'))) missing.push('events.members');
  }
  if (pool.complete !== true) missing.push('complete');
  if (!Number.isFinite(threshold)) missing.push('threshold');
  const start = Date.parse(pool.window?.start), end = Date.parse(pool.window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) missing.push('window.bounds');
  const rows = Array.isArray(pool.rows) ? pool.rows : [];
  if (rows.some((row) => !row || typeof row !== 'object')) return { eligible: false, missing: ['rows.invalid'], selectedIds: [], status: 'ineligible-missing-pool-truth' };
  if (new Set(rows.map((row) => String(row.id))).size !== rows.length) missing.push('duplicate_ids');
  for (const row of rows) {
    const at = Date.parse(row.visible_at);
    if (!Number.isFinite(at) || at < start || at >= end) missing.push(`${row.id}:visible_at`);
    for (const key of ['id', 'genre', 'primary_source_id', 'source_source_type', 'source_authority', 'lang', 'title_raw', 'verification', 'flags', 'publication_types', 'summarized', 'selected', 'safety_alert', 'beside_selected']) {
      if (row[key] == null) missing.push(`${row.id}:${key}`);
    }
    if (!Array.isArray(row.flags) || !Array.isArray(row.publication_types)) missing.push(`${row.id}:arrays`);
    for (const key of ['summarized', 'selected', 'safety_alert', 'beside_selected']) if (typeof row[key] !== 'boolean') missing.push(`${row.id}:${key}.boolean`);
    for (const key of ['event_id', 'score_version', 'score_total', 'selected_rule', 'adds_value']) {
      if (!Object.hasOwn(row, key)) missing.push(`${row.id}:${key}`);
    }
    if (row.event_id != null && !Array.isArray(pool.events?.[String(row.event_id)])) missing.push(`${row.id}:event_members`);
  }
  if (missing.length) return { eligible: false, missing, selectedIds: [], status: 'ineligible-missing-pool-truth' };
  const candidates = rows.map(frontierMixCandidate);
  const result = frontierMixSelect({ candidates, threshold, events: pool.events, genreFloors: pool.genreFloors,
    congressActive: pool.congressActive, preprintPlaces: pool.preprintPlaces, preprintMinScore: pool.preprintMinScore });
  const selectedIds = [...new Set([...candidates.filter((c) => c.selected).map((c) => c.id), ...result.picks.map((p) => p.id)])]
    .filter((id) => !result.superseded.some((entry) => entry.id === id)).sort();
  return { eligible: true, missing: [], selectedIds, selectedVolume: selectedIds.length, result, datasetHash: hash(JSON.stringify(pool)), status: 'offline-candidate-only' };
}
function countBy(rows, key) { return rows.reduce((counts, row) => { const value = String(row[key] ?? 'unspecified'); counts[value] = (counts[value] ?? 0) + 1; return counts; }, {}); }
export function metrics(rows, selectedIds) {
  const selected = new Set(selectedIds), positives = rows.filter((row) => row.label?.worth === 'pick');
  const labeled = rows.filter((row) => ['pick', 'ok', 'no'].includes(row.label?.worth));
  const picked = labeled.filter((row) => selected.has(String(row.id))), tp = positives.filter((row) => selected.has(String(row.id))).length;
  return { count: rows.length, labeled: labeled.length, missingLabels: rows.length - labeled.length,
    selected: picked.length, truePositives: tp, precision: picked.length ? tp / picked.length : null, recall: positives.length ? tp / positives.length : null };
}
export function sweepFrontierThresholds(pool, { baselineThreshold, thresholds, protectedPickIds = [], labels = [] }) {
  const baseline = replayFrontierPool(pool, baselineThreshold);
  return [...new Set(thresholds)].sort((a, b) => a - b).map((threshold) => {
    const run = replayFrontierPool(pool, threshold);
    const protectedIds = [...new Set([...protectedPickIds.map(String), ...labels.filter((r) => r.label?.worth === 'pick').map((r) => String(r.id)), ...(pool.rows ?? []).filter((r) => r.safety_alert === true && r.selected === true).map((r) => String(r.id))])];
    const lostProtectedIds = protectedIds.filter((id) => baseline.selectedIds.includes(id) && !run.selectedIds.includes(id));
    return { ...run, threshold, protectionPassed: baseline.eligible && run.eligible && lostProtectedIds.length === 0, lostProtectedIds,
      ruleCounts: countBy(run.result?.picks ?? [], 'rule'), exclusionCounts: countBy(run.result?.excluded ?? [], 'reason'),
      splitMetrics: Object.fromEntries([['development', 1], ['historicalTest', 0]].map(([name, parity]) => [name, metrics(labels.filter((r) => r.n % 2 === parity), run.selectedIds)])),
      overall: metrics(labels, run.selectedIds), nonSafety: metrics(labels.filter((r) => !r.safety_alert), run.selectedIds),
      slices: Object.fromEntries([...new Set(labels.map((r) => r.genre))].map((genre) => [genre, metrics(labels.filter((r) => r.genre === genre), run.selectedIds)])),
      volumeReductionProxy: baseline.selectedIds.length - run.selectedIds.length, costClaim: 'Selected volume only; no measured CNY saving' };
  });
}
export async function frontierConsumerIdentity() {
  const paths = ['../../apps/server/src/frontierPipeline.mjs', '../../apps/server/src/frontierEditor.mjs', '../../packages/domain/src/frontierMix.mjs', '../../packages/domain/src/frontierSelection.mjs', '../../packages/domain/src/frontier-selection.json', '../../packages/domain/src/frontierGenres.mjs', '../../packages/domain/src/frontierVocabulary.mjs'];
  const contents = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url))));
  return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }).trim(), implementationSha256: hash(Buffer.concat(contents)), components: paths.map((path, i) => ({ path, sha256: hash(contents[i]) })) };
}
