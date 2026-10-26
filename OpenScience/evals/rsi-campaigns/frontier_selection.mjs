import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    if (!Array.isArray(members) || members.some((m) => !m || typeof m.id !== 'string' || typeof m.genre !== 'string' || typeof m.selected !== 'boolean' || typeof m.safety !== 'boolean' || !Object.hasOwn(m, 'rule') || !(m.rule === null || typeof m.rule === 'string') || !Object.hasOwn(m, 'evidenceType') || !(m.evidenceType === null || typeof m.evidenceType === 'string'))) missing.push('events.members');
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
    const nullableString = (value) => value === null || typeof value === 'string';
    const numeric = (value) => typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    const schema = {
      id: (v) => (typeof v === 'string' && v !== '') || (Number.isSafeInteger(v) && v > 0),
      primary_source_id: (v) => typeof v === 'string' && v !== '',
      genre: nullableString, platform: nullableString, channel: nullableString, source_type: nullableString,
      source_source_type: nullableString, source_authority: (v) => v === null || numeric(v),
      lang: nullableString, title_raw: nullableString, verification: nullableString, evidence_type: nullableString,
      lane: nullableString, practice_changing: (v) => v === null || typeof v === 'boolean', practice_zh: nullableString,
      flags: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
      publication_types: (v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
      summarized: (v) => typeof v === 'boolean', selected: (v) => typeof v === 'boolean',
      safety_alert: (v) => typeof v === 'boolean', beside_selected: (v) => typeof v === 'boolean',
      event_id: (v) => v === null || (typeof v === 'string' && v !== '') || (Number.isSafeInteger(v) && v > 0),
      score_version: nullableString, score_total: (v) => v === null || numeric(v), selected_rule: nullableString,
      adds_value: (v) => v === null || typeof v === 'boolean',
    };
    for (const [key, valid] of Object.entries(schema)) if (!Object.hasOwn(row, key) || !valid(row[key])) missing.push(`${row.id}:${key}`);
    if (row.event_id != null) {
      const members = pool.events?.[String(row.event_id)];
      if (!Array.isArray(members)) missing.push(`${row.id}:event_members`);
      else {
        const own = members.filter((m) => m?.id === String(row.id));
        const candidate = frontierMixCandidate(row);
        if (own.length !== 1 || own[0].genre !== candidate.genre || own[0].evidenceType !== row.evidence_type
          || own[0].selected !== candidate.selected || own[0].rule !== candidate.rule || own[0].safety !== candidate.safety) missing.push(`${row.id}:event_members.inconsistent`);
      }
    }
  }
  for (const [eventId, members] of Object.entries(pool.events ?? {})) {
    if (!Array.isArray(members)) continue;
    const memberIds = members.map((m) => m?.id);
    if (new Set(memberIds).size !== memberIds.length) missing.push(`${eventId}:duplicate_event_members`);
    for (const member of members) {
      const candidate = rows.find((row) => String(row.id) === member?.id);
      if (candidate && String(candidate.event_id) !== eventId) missing.push(`${member.id}:event_members.wrong_event`);
    }
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
/** Join human labels by stable pool ID; metadata always belongs to frozen rows. */
function joinLabels(rows, labels) {
  const ids = new Set(rows.map((row) => String(row.id)));
  const byId = new Map(); const duplicateIds = [];
  for (const label of labels) {
    const id = String(label.id);
    if (byId.has(id)) duplicateIds.push(id);
    byId.set(id, label);
  }
  return { rows: rows.map((row) => ({ ...row, label: duplicateIds.includes(String(row.id)) ? null : byId.get(String(row.id))?.label,
    n: byId.get(String(row.id))?.n })), duplicateIds, outsidePoolIds: [...byId.keys()].filter((id) => !ids.has(id)) };
}
export function metrics(rows, selectedIds) {
  const selected = new Set(selectedIds), positives = rows.filter((row) => row.label?.worth === 'pick');
  const labeled = rows.filter((row) => ['pick', 'ok', 'no'].includes(row.label?.worth));
  const picked = rows.filter((row) => selected.has(String(row.id)));
  const pickedLabeled = labeled.filter((row) => selected.has(String(row.id)));
  const tp = positives.filter((row) => selected.has(String(row.id))).length;
  const missingLabels = rows.length - labeled.length, missingSelectedLabels = picked.length - pickedLabeled.length;
  return { count: rows.length, labeled: labeled.length, missingLabels, missingSelectedLabels,
    labelCoverage: rows.length ? labeled.length / rows.length : null,
    selectedLabelCoverage: picked.length ? pickedLabeled.length / picked.length : null,
    selected: picked.length, truePositives: tp,
    precision: picked.length && !missingSelectedLabels ? tp / picked.length : null,
    recall: positives.length && !missingLabels ? tp / positives.length : null,
    labeledSubsetPrecision: pickedLabeled.length ? tp / pickedLabeled.length : null,
    labeledSubsetRecall: positives.length ? tp / positives.length : null };
}
export function sweepFrontierThresholds(pool, { baselineThreshold, thresholds, protectedPickIds = [], labels = [] }) {
  const baseline = replayFrontierPool(pool, baselineThreshold);
  const joined = joinLabels(pool.rows ?? [], labels);
  const overallCoverage = metrics(joined.rows, baseline.selectedIds);
  const identity = consumerIdentity();
  const adapterPaths = ['./frontier_selection.mjs', './frontier_gold.mjs', './run_frontier.mjs'];
  const adapterSha256 = hash(Buffer.concat(adapterPaths.map((path) => readFileSync(new URL(path, import.meta.url)))));
  const labelsHash = hash(JSON.stringify(labels));
  return [...new Set(thresholds)].sort((a, b) => a - b).map((threshold) => {
    const run = replayFrontierPool(pool, threshold);
    const protectedIds = [...new Set([...protectedPickIds.map(String), ...joined.rows.filter((r) => r.label?.worth === 'pick').map((r) => String(r.id)), ...(pool.rows ?? []).filter((r) => r.safety_alert === true && r.selected === true).map((r) => String(r.id))])];
    const lostProtectedIds = protectedIds.filter((id) => baseline.selectedIds.includes(id) && !run.selectedIds.includes(id));
    const receipt = { threshold, baselineThreshold, baselineSelectedIds: baseline.selectedIds, protectedIds: protectedIds.sort(),
      datasetHash: hash(JSON.stringify(pool)), labelsHash, adapterSha256, consumer: identity,
      parameters: { day: pool.day, window: pool.window, events: pool.events, genreFloors: pool.genreFloors,
        congressActive: pool.congressActive, preprintPlaces: pool.preprintPlaces, preprintMinScore: pool.preprintMinScore, scoreVersion: pool.scoreVersion } };
    const labelsComplete = overallCoverage.missingLabels === 0 && joined.duplicateIds.length === 0 && joined.outsidePoolIds.length === 0;
    return { ...run, threshold, baselineThreshold, receipt, receiptHash: hash(JSON.stringify(receipt)),
      protectionPassed: baseline.eligible && run.eligible && labelsComplete && lostProtectedIds.length === 0,
      protectionStatus: !baseline.eligible || !run.eligible ? 'inconclusive-pool-truth' : !labelsComplete ? 'inconclusive-label-coverage' : lostProtectedIds.length ? 'failed' : 'passed',
      labelIssues: { duplicateIds: joined.duplicateIds, outsidePoolIds: joined.outsidePoolIds }, lostProtectedIds,
      ruleCounts: countBy(run.result?.picks ?? [], 'rule'), exclusionCounts: countBy(run.result?.excluded ?? [], 'reason'),
      splitMetrics: Object.fromEntries([['development', 1], ['historicalTest', 0]].map(([name, parity]) => [name, metrics(joined.rows.filter((r) => r.n % 2 === parity), run.selectedIds)])),
      overall: metrics(joined.rows, run.selectedIds), nonSafety: metrics(joined.rows.filter((r) => !r.safety_alert), run.selectedIds),
      slices: Object.fromEntries([...new Set(joined.rows.map((r) => r.genre))].map((genre) => [genre, metrics(joined.rows.filter((r) => r.genre === genre), run.selectedIds)])),
      volumeReductionProxy: baseline.selectedIds.length - run.selectedIds.length, costClaim: 'Selected volume only; no measured CNY saving' };
  });
}
function consumerIdentity() {
  const paths = ['../../apps/server/src/frontierPipeline.mjs', '../../apps/server/src/frontierEditor.mjs', '../../packages/domain/src/frontierMix.mjs', '../../packages/domain/src/frontierSelection.mjs', '../../packages/domain/src/frontier-selection.json', '../../packages/domain/src/frontierGenres.mjs', '../../packages/domain/src/frontierVocabulary.mjs'];
  const contents = paths.map((path) => readFileSync(new URL(path, import.meta.url)));
  return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }).trim(), implementationSha256: hash(Buffer.concat(contents)), components: paths.map((path, i) => ({ path, sha256: hash(contents[i]) })) };
}

export async function frontierConsumerIdentity() { return consumerIdentity(); }
