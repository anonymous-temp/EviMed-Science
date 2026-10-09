import { createHash } from 'node:crypto';

// Reader state is still exportable when the feed is disabled. Both migration
// entry points share the feed's lock and this one definition of the table.
export const FRONTIER_EVENT_READING_SQL = `
CREATE SCHEMA IF NOT EXISTS evimed_frontier;
CREATE TABLE IF NOT EXISTS evimed_frontier.event_reads (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  report_marks jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, event_id)
);
`;
const migrations = new WeakMap();

/** @param {any} database */
export async function migrateFrontierEventReading(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-frontier-v1'))");
    await client.query(FRONTIER_EVENT_READING_SQL);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/** Fingerprint reader-visible facts, excluding popularity and bookkeeping. @param {any} report */
export function frontierReportFingerprint(report) {
  return createHash('sha256').update(JSON.stringify([report.role, report.title, report.summary, report.studyIds])).digest('hex');
}

/** @param {any[]} reports @param {Record<string,string> | null} baseline */
export function frontierEventChanges(reports, baseline) {
  const mark = Object.fromEntries(reports.slice(0, 256).map(report => [report.id, frontierReportFingerprint(report)]));
  return { mark, changes: baseline ? reports.filter(report => baseline[report.id] !== mark[report.id]).map(report => ({
    id: report.id, kind: baseline[report.id] ? 'updated' : 'added', title: report.title, summary: report.summary,
  })) : [] };
}
