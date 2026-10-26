#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { historicalFrontierReport, loadFrontierGold } from './frontier_gold.mjs';
import { frontierConsumerIdentity, metrics, sweepFrontierThresholds } from './frontier_selection.mjs';
const [poolPath, baseline, ...thresholds] = process.argv.slice(2);
const consumer = await frontierConsumerIdentity();
if (!poolPath) {
  const historical = await historicalFrontierReport();
  const gold = await loadFrontierGold();
  console.log(JSON.stringify({ consumer, ...historical, overall: metrics(gold.rows, historical.historicalSelection.selectedIds),
    nonSafety: metrics(gold.rows.filter((row) => !row.safety_alert), historical.historicalSelection.selectedIds) }, null, 2));
} else {
  if (!baseline || !thresholds.length) throw new Error('Usage: node run_frontier.mjs [full-pool.json baseline-threshold threshold ...]');
  const pool = JSON.parse(await readFile(poolPath, 'utf8'));
  const labels = pool.labels ?? [];
  const protectedPickIds = labels.filter((row) => row.label?.worth === 'pick').map((row) => String(row.id));
  console.log(JSON.stringify({ consumer, publication: 'candidate-only', freshConfirmationEligible: false,
    runs: sweepFrontierThresholds(pool, { baselineThreshold: Number(baseline), thresholds: thresholds.map(Number), labels, protectedPickIds }) }, null, 2));
}
