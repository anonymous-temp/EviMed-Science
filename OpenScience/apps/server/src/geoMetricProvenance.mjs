/** Resolve stored cells only against their own immutable computation generation. Legacy rows retain unknown compatibility. */
import { AsyncLocalStorage } from "node:async_hooks";
import { GEO_MEASUREMENT_METHOD_VERSION } from "@evimed/domain";
import { computeRoundCells, verifyFrozenNetRow } from "./geoMetricsJob.mjs";
import { geoComparisonCellKey, geoMetricInputCoverage } from "./geoComparison.mjs";

const readCache = new AsyncLocalStorage();
export const metricProvenanceReadActive = () => Boolean(readCache.getStore());
/** A cache lives for one authorized read, never across users, revisions or transactions. */
export const withMetricProvenanceRead = operation => readCache.getStore() ? operation() : readCache.run(new Map(), operation);

const cellOf = row => ({ metricId: row.metric_id, scope: row.scope, pool: row.pool ?? null, engine: row.engine ?? null,
  groupId: row.group_id ?? null, arm: row.arm ?? null, variant: row.variant ?? null, rival: row.rival ?? null });
const equalReading = (row, cell) => ["value", "numerator", "denominator"].every(key =>
  row[key] == null ? cell[key] == null : cell[key] != null && Number.isFinite(Number(row[key])) && Number(row[key]) === cell[key])
  && ["status", "reason"].every(key => (row[key] ?? null) === (cell[key] ?? null));

/** Batch across generations; a cell never borrows the newest snapshot of its round. @param {any} db @param {any[]} rows */
export async function storedMetricCoverage(db, rows) {
  const generations = [...new Set(rows.map(row => row.computation_generation).filter(Boolean))];
  const byId = new Map();
  if (!generations.length) return byId;
  const snapshots = (await db.query(`SELECT i.*,r.set_version FROM evimed_geo.metric_input_snapshots i
    JOIN evimed_geo.rounds r ON r.id=i.round_id AND r.geo_project_id=i.geo_project_id AND r.user_id=i.user_id
    WHERE generation=ANY($1::text[]) AND (i.user_id,i.geo_project_id) IN (SELECT * FROM unnest($2::text[],$3::text[]))`, [generations, rows.map(row => row.user_id), rows.map(row => row.geo_project_id)])).rows;
  const inputs = new Map();
  for (const snapshot of snapshots) {
    const payload = snapshot.payload;
    if (payload?.version !== 1 || !Array.isArray(payload.rows) || !payload.options) continue;
    try {
      const cache = readCache.getStore();
      const key = JSON.stringify([snapshot.user_id, snapshot.geo_project_id, snapshot.generation]);
      let computed = cache?.get(key);
      if (!computed) { computed = computeRoundCells(payload.rows, payload.options); cache?.set(key, computed); }
      inputs.set(snapshot.generation, { snapshot, selected: { computed, metricOptions: payload.options } });
    } catch { /* A corrupt calculation input cannot prove a historical comparison. */ }
  }
  for (const row of rows) {
    const input = inputs.get(row.computation_generation);
    if (!input || input.snapshot.round_id !== row.round_id || input.snapshot.geo_project_id !== row.geo_project_id
      || input.snapshot.user_id !== row.user_id || row.method_version !== GEO_MEASUREMENT_METHOD_VERSION) continue;
    const cell = input.selected.computed.cells.find(candidate => geoComparisonCellKey(candidate) === geoComparisonCellKey(cellOf(row)));
    if (cell && equalReading(row, cell)) byId.set(row.id, geoMetricInputCoverage(input.selected, cell, input.snapshot.payload.setVersion));
  }
  return byId;
}


/** Verify NET against the exact current and predecessor inputs recorded by its producer. @param {any} db @param {any[]} rows */
export async function storedNetProofs(db, rows) {
  const generations = [...new Set(rows.flatMap(row => [...(Array.isArray(row.assessment?.generations) ? row.assessment.generations.map(entry => entry.generation) : []), row.assessment?.noise?.generation]).filter(value => typeof value === 'string'))];
  const verified = new Set();
  if (!generations.length) return verified;
  const records = (await db.query(`SELECT * FROM evimed_geo.metric_input_snapshots WHERE generation=ANY($1::text[])
    AND (user_id,geo_project_id) IN (SELECT * FROM unnest($2::text[],$3::text[]))`,
    [generations, rows.map(row => row.user_id), rows.map(row => row.geo_project_id)])).rows;
  for (const row of rows) {
    const snapshots = new Map(records.filter(record => record.user_id === row.user_id && record.geo_project_id === row.geo_project_id)
      .map(record => [record.generation, { generation: record.generation, roundId: record.round_id, payload: record.payload }]));
    if (row.method_version === GEO_MEASUREMENT_METHOD_VERSION && verifyFrozenNetRow(row, snapshots)) verified.add(row.id);
  }
  return verified;
}
