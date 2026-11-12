// The file of a table study screened by its rules: every person of the newest assessments, or every rule of every person, in the same plain
// column style as the judged files. Read in chunks and written through the caller's sink, so five thousand people are never one string.
import { VCR_CRITERION_STATE_LABELS_ZH, VCR_ELIGIBILITY_SUMMARY_LABELS_ZH } from "@evimed/domain";
import { csvLine } from "./vcrMatchResults.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";

const CHUNK = 200;
const SUMMARY_RANK = "CASE l.summary WHEN 'eligible' THEN 0 WHEN 'insufficient_evidence' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END";
const HEADER = ["患者", "结论", "满足", "不满足", "未知", "待复评", "评估时间", "判定方式"];
const CLAUSE_HEADER = ["患者", "结论", "条款编号", "类型", "条款原文", "状态"];

/**
 * @param {{ rows: (sql: string, args: unknown[]) => Promise<any[]> }} store the matching store
 * @param {any} study @param {{ format: 'csv' | 'json', kind: 'pairs' | 'clauses', protocolVersionId: string | null }} options
 * @param {() => Date} [now]
 */
export async function rulesExporter(store, study, { format, kind, protocolVersionId }, now = () => new Date()) {
  const latest = `SELECT DISTINCT ON (subject_key) * FROM ${VCR_SCHEMA}.matching_assessments
    WHERE study_id = $1 AND ($2::text IS NULL OR protocol_version_id = $2) ORDER BY subject_key, as_of DESC, created_at DESC`;
  const args = [study.id, protocolVersionId];
  const people = await store.rows(`SELECT l.id, l.subject_key, l.summary, l.counts, l.as_of, l.provenance,
      EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals w WHERE w.study_id = $1 AND w.subject_key = l.subject_key) AS withdrawn
    FROM (${latest}) l ORDER BY ${SUMMARY_RANK}, l.subject_key COLLATE "C"`, args);
  const exportedAt = now().toISOString();
  const filename = `matching-rules-${kind}-${exportedAt.slice(0, 10)}.${format}`;
  const summaryWord = (/** @type {string} */ summary) => /** @type {Record<string, string>} */ (VCR_ELIGIBILITY_SUMMARY_LABELS_ZH)[summary] ?? summary;
  const stateWord = (/** @type {any} */ row) => row.applicable === false ? "不适用" : /** @type {Record<string, string>} */ (VCR_CRITERION_STATE_LABELS_ZH)[row.override_state ?? row.state] ?? "";
  /** @param {{ write: (chunk: string) => Promise<void> }} sink */
  const run = async (sink) => {
    if (format === "csv") await sink.write(`\uFEFF${csvLine(kind === "pairs" ? HEADER : CLAUSE_HEADER)}`);
    else await sink.write(`{"schema":"evimed-matching-export/1","direction":"trial_to_patient","source":"rules","kind":${JSON.stringify(kind)},"exportedAt":${JSON.stringify(exportedAt)},"rows":[`);
    let first = true;
    const put = async (/** @type {string} */ line, /** @type {unknown} */ object) => {
      if (format === "csv") await sink.write(line);
      else { await sink.write(`${first ? "" : ","}${JSON.stringify(object)}`); first = false; }
    };
    for (let at = 0; at < people.length; at += CHUNK) {
      const group = people.slice(at, at + CHUNK);
      if (kind === "pairs") {
        for (const person of group) {
          const counts = person.counts ?? {};
          const asOf = person.as_of ? new Date(person.as_of).toISOString() : null;
          const label = person.withdrawn ? "已撤回" : summaryWord(person.summary);
          await put(csvLine([person.subject_key, label, counts.satisfied ?? 0, counts.not_satisfied ?? 0, counts.unknown ?? 0, counts.pending_recheck ?? 0, asOf, "规则筛选"]),
            { subjectKey: person.subject_key, verdict: person.summary, withdrawn: person.withdrawn === true, counts: { satisfied: counts.satisfied ?? 0, notSatisfied: counts.not_satisfied ?? 0, unknown: counts.unknown ?? 0, pendingRecheck: counts.pending_recheck ?? 0 }, assessedAt: asOf, producer: "rules" });
        }
        continue;
      }
      const judgments = await store.rows(`SELECT j.assessment_id, j.state, j.override_state, j.applicable, c.ordinal, c.kind, c.source_text
        FROM ${VCR_SCHEMA}.criterion_judgments j JOIN ${VCR_SCHEMA}.criteria c ON c.id = j.criterion_id
        WHERE j.assessment_id = ANY($1::text[]) ORDER BY j.assessment_id, c.ordinal`, [group.map((person) => person.id)]);
      /** @type {Map<string, any[]>} */
      const byAssessment = new Map();
      for (const row of judgments) byAssessment.set(String(row.assessment_id), [...(byAssessment.get(String(row.assessment_id)) ?? []), row]);
      for (const person of group) {
        for (const row of byAssessment.get(String(person.id)) ?? []) {
          const type = row.kind === "exclusion" ? "排除" : "入选";
          await put(csvLine([person.subject_key, person.withdrawn ? "已撤回" : summaryWord(person.summary), row.ordinal, type, row.source_text, stateWord(row)]),
            { subjectKey: person.subject_key, verdict: person.summary, clause: { number: row.ordinal, kind: row.kind, text: row.source_text, state: row.override_state ?? row.state, applicable: row.applicable !== false } });
        }
      }
    }
    if (format === "json") await sink.write("]}");
  };
  return { filename, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", rows: people.length, run };
}
