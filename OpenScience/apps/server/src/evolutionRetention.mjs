import { evolutionKey } from './evolutionService.mjs';
import { evolutionRecordedFailures } from './evolutionGrowth.mjs';

/**
 * Retention of the two high-frequency record types of 循证进化, in the product ledger (`evimed_product.documents`, kind `knowledge`).
 *
 * Live (2026-10-07 to 12) five days left 11,322 `evolution-module-observation` and 1,099 `evolution-event` rows, and nothing ever removed one. Both are
 * written for a moment and read in it, so a row that has been read is folded into a count of its day (`evolution-module-observation-daily`,
 * `evolution-event-daily`) and deleted, in one transaction (a crash between the count and the delete cannot count a row twice). What is folded is
 * only what no reader can ask for again, found by reading the readers (2026-10-12):
 *  - a module observation that counted no failure: `growth.collect` skips it and no dossier names it as an evidence root, because a dossier is opened only
 *    for a failure (`evolutionRecordedFailures`, the one definition both use). An observation that counted a failure stays: it is the evidence root of a
 *    dossier, read again by the proposal gate and by the receipt of a repair (`recordedModuleFailure`, `observedFailureReceipt`) however old it is;
 *  - an event of a closed set of types, the platform's own, that the worker has processed: a scan or a resumption that only woke missions, a feed item
 *    published (its durable products, the time-holdout candidates and the prospective matches, are `evolution-observation` rows of their own), a tool published.
 *    A `dataset-ready` event is never folded (the latest per dataset is read again by every `tool-ready`, and the owners of the datasets are found from it),
 *    nor is one still `queued`, nor any other type: the rest are few, and a prospective registration is not a thing to forget.
 * The four scientific acceptance items read none of what is folded: the confirmation ledger is files on disk, the time holdout reads `evolution-observation`,
 * the audit pool reads tasks and resource assets, and the monthly metrics read the missions' own observation lists (`evolutionMonthlyObservations`).
 * Both aggregates are written under record types of their own, so `service.list('module-observation')` never sees them as observations.
 */
export const EVOLUTION_FOLDED_EVENT_TYPES = Object.freeze(['handbook-gap-scan', 'source-facts-scan', 'prospective-target-scan', 'lead-source-scan', 'search-resumed',
  'frontier-publication', 'tool-ready']);
/** The counts an observation carries, as the SQL below reads them: the failure sum is `evolutionRecordedFailures`'s, written once more for the database. */
const NO_FAILURE_SQL = `coalesce((payload#>>'{counts,failed}')::numeric, (payload#>>'{counts,rejected}')::numeric, (payload#>>'{counts,unsupported}')::numeric, 0)
  + coalesce((payload#>>'{counts,numberFailures}')::numeric, 0) + coalesce((payload#>>'{counts,unitMismatches}')::numeric, 0) = 0`;
const utcDay = (/** @type {any} */ value) => new Date(value).toISOString().slice(0, 10);

/** @param {{service:any, config?:any}} dependencies */
export function createEvolutionRetention({ service, config = service.config ?? {} }) {
  const counters = { observationsFolded: 0, eventsFolded: 0, dailyRecordsWritten: 0, passes: 0, failures: 0, lastPassAt: /** @type {string|null} */ (null) };
  /** Add `counts` and `n` to the day's record of `kind`. @param {string} type @param {string} id @param {Record<string, any>} identity @param {Record<string, number>} counts @param {number} n */
  async function addToDay(type, id, identity, counts, n) {
    const previous = await service.get(id);
    const merged = { ...(previous?.payload.counts ?? {}) };
    for (const [key, value] of Object.entries(counts)) merged[key] = (Number(merged[key]) || 0) + value;
    await service.save(type, id, { ...(previous?.payload ?? {}), ...identity, rows: Number(previous?.payload.rows ?? 0) + n, counts: merged, foldedAt: service.now().toISOString() }, previous);
    counters.dailyRecordsWritten++;
  }
  /** @param {any} database @param {string} owner @param {Date} cutoff @param {number} limit */
  async function foldObservations(database, owner, cutoff, limit) {
    const found = await database.query(`SELECT id, payload, created_at FROM evimed_product.documents
      WHERE user_id=$1 AND kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-module-observation' AND created_at < $2 AND ${NO_FAILURE_SQL}
      ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED`, [owner, cutoff.toISOString(), limit]);
    // The shared definition decides last: a row the database called clean and the code does not is left where it is.
    const rows = found.rows.filter((/** @type {any} */ row) => evolutionRecordedFailures(row.payload, 'evolution-module-observation') === 0);
    const days = new Map();
    for (const row of rows) {
      const key = [row.payload.moduleId, row.payload.kind, utcDay(row.created_at)].join('|');
      const day = days.get(key) ?? { moduleId: row.payload.moduleId, kind: row.payload.kind, day: utcDay(row.created_at), rows: 0, counts: /** @type {Record<string, number>} */ ({}), revisions: /** @type {Record<string, number>} */ ({}) };
      day.rows++;
      for (const [name, value] of Object.entries(row.payload.counts ?? {})) if (Number.isFinite(Number(value))) day.counts[name] = (day.counts[name] ?? 0) + Number(value);
      const revision = String(row.payload.policyRevisionId ?? 'unknown');
      day.revisions[revision] = (day.revisions[revision] ?? 0) + 1;
      days.set(key, day);
    }
    for (const day of days.values()) {
      await addToDay('module-observation-daily', `evolution-module-observation-daily-${evolutionKey([day.moduleId, day.kind, day.day])}`,
        { moduleId: day.moduleId, kind: day.kind, day: day.day }, { ...day.counts, ...Object.fromEntries(Object.entries(day.revisions).map(([revision, n]) => [`revision:${revision}`, n])) }, day.rows);
    }
    if (rows.length) await database.query('DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind=\'knowledge\' AND id = ANY($2::text[])', [owner, rows.map((/** @type {any} */ row) => row.id)]);
    return { folded: rows.length, more: found.rows.length === limit };
  }
  /** @param {any} database @param {string} owner @param {Date} cutoff @param {number} limit */
  async function foldEvents(database, owner, cutoff, limit) {
    const found = await database.query(`SELECT id, payload, created_at FROM evimed_product.documents
      WHERE user_id=$1 AND kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-event' AND payload->>'status'='processed'
        AND payload->>'type' = ANY($2::text[]) AND updated_at < $3
      ORDER BY updated_at LIMIT $4 FOR UPDATE SKIP LOCKED`, [owner, [...EVOLUTION_FOLDED_EVENT_TYPES], cutoff.toISOString(), limit]);
    const days = new Map();
    for (const row of found.rows) {
      const key = `${row.payload.type}|${utcDay(row.created_at)}`;
      days.set(key, { type: row.payload.type, day: utcDay(row.created_at), rows: (days.get(key)?.rows ?? 0) + 1 });
    }
    for (const day of days.values()) await addToDay('event-daily', `evolution-event-daily-${evolutionKey([day.type, day.day])}`, { type: day.type, day: day.day }, {}, day.rows);
    if (found.rows.length) await database.query('DELETE FROM evimed_product.documents WHERE user_id=$1 AND kind=\'knowledge\' AND id = ANY($2::text[])', [owner, found.rows.map((/** @type {any} */ row) => row.id)]);
    return { folded: found.rows.length, more: found.rows.length === limit };
  }
  /**
   * One pass, at most `evolutionRetentionBatchRows` rows of each type, oldest first; the daily housekeeping comes back to the rest. A failure is counted and
   * leaves every row where it was (the transaction rolled back); it never reaches the job that called it.
   * @returns {Promise<{observations:number, events:number, skipped?:string}>}
   */
  async function compact() {
    const database = service.documents?.database;
    if (!database?.query) return { observations: 0, events: 0, skipped: 'no-database' };
    const days = Number(config.evolutionRecordRetentionDays ?? 14), limit = Number(config.evolutionRetentionBatchRows ?? 5000);
    if (!Number.isFinite(days) || days < 1 || !Number.isFinite(limit) || limit < 1) return { observations: 0, events: 0, skipped: 'retention-off' };
    const cutoff = new Date(service.now().getTime() - days * 86_400_000);
    try {
      const owner = await service.owner();
      const result = await service.withLock('retention', async () => {
        const observations = await foldObservations(database, owner, cutoff, limit);
        const events = await foldEvents(database, owner, cutoff, limit);
        return { observations: observations.folded, events: events.folded };
      });
      counters.observationsFolded += result.observations; counters.eventsFolded += result.events; counters.passes++; counters.lastPassAt = service.now().toISOString();
      return result;
    } catch { counters.failures++; return { observations: 0, events: 0, skipped: 'failed' }; }
  }
  return { compact, counters };
}
