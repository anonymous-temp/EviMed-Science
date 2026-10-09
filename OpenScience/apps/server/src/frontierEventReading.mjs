import { createHash } from 'node:crypto';

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
