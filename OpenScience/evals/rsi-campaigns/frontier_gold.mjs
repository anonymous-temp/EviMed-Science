import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function frontierGoldStatus() {
  return { status: 'historical-calibration-development', freshConfirmationEligible: false,
    exposure: ['compare-v1-test', 'final-edit-all'], rawRaterAgreementRecomputable: false,
    declaredKappa: 0.87, limitations: ['Raw individual ratings absent', 'Visibility, event membership, complete competitor pools, score versions and genre floors absent; not production replay'] };
}
export async function loadFrontierGold(path = new URL('../frontier-selection/gold.jsonl', import.meta.url)) {
  const bytes = await readFile(path);
  const rows = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('Duplicate gold IDs');
  return { rows, sha256: createHash('sha256').update(bytes).digest('hex'), ...frontierGoldStatus(),
    split: { development: rows.filter((row) => row.n % 2 === 1).map((row) => row.id), historicalTest: rows.filter((row) => row.n % 2 === 0).map((row) => row.id) } };
}

/** Historical cached selections only: never fills absent full-day replay inputs. */
export async function historicalFrontierReport() {
  const gold = await loadFrontierGold();
  const exposures = await Promise.all(gold.exposure.map(async (name) => {
    const bytes = await readFile(new URL(`../frontier-selection/results/${name}.json`, import.meta.url));
    return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  return { ...gold, rows: undefined, exposures, exposureHash: createHash('sha256').update(JSON.stringify(exposures)).digest('hex'),
    labelCounts: gold.rows.reduce((counts, row) => { const key = row.label.worth; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
    historicalSelection: { selectedIds: gold.rows.filter((row) => row.live.selected).map((row) => row.id), cachedScores: gold.rows.map((row) => ({ id: row.id, score: row.live.total })) },
    interpretation: 'Sampled historical label analysis, not exact production replay; no fresh confirmation or clinical gain certificate' };
}
