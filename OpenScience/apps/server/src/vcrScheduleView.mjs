/**
 * What a schedule of activities and a log of regulatory contacts are to a reader and to the runtime, as pure functions: the rows of a
 * table, the part of a report model they are, the visit times a scenario takes from the schedule. No store, no clock — the stores that
 * keep them are `vcrSchedule.mjs` and `vcrRegulatory.mjs`; this module is what the report model (`vcrRender.mjs`), the package reader
 * (`vcrViews.mjs`), the exported document (`vcrDocumentExport.mjs`) and the gateway share, and it imports only the domain.
 *
 * @module vcrScheduleView
 */

import { VCR_REGULATORY_LIMITS, VCR_SOA_TIME_UNITS, soaDayText, soaSummary, soaVisitTimes, soaWindowText } from "@evimed/domain";

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const num = (value) => (value == null ? null : Number(value));

/** The name a visit is matched by: trimmed, spacing collapsed, case ignored. @param {unknown} name */
export const visitKey = (name) => String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The flat rows of one protocol version's schedule as visits: by day (a visit with no planned day, such as an end-of-treatment visit,
 * after the dated ones), visits on the same day in the order they were written, and each visit's activities in the order they were written.
 * @param {readonly Record<string, any>[]} rows
 * @returns {Array<{ visit: string, day: number | null, windowDays: number | null, note: string, procedures: Array<{ name: string, note: string }> }>}
 */
export function visitsFromRows(rows) {
  /** @type {Map<string, any>} */
  const byVisit = new Map();
  const ordered = [...list(rows)].sort((a, b) => Number(a.ordinal) - Number(b.ordinal) || Number(a.position) - Number(b.position));
  for (const row of ordered) {
    const key = visitKey(row.visit);
    if (!byVisit.has(key)) {
      byVisit.set(key, { visit: String(row.visit), day: num(row.day), windowDays: num(row.window_days), note: String(row.visit_note ?? ""),
        ordinal: Number(row.ordinal), procedures: [] });
    }
    byVisit.get(key).procedures.push({ name: String(row.procedure), note: String(row.note ?? "") });
  }
  return [...byVisit.values()]
    .sort((a, b) => Number(a.day === null) - Number(b.day === null) || (a.day ?? 0) - (b.day ?? 0) || a.ordinal - b.ordinal)
    .map(({ ordinal: _ordinal, ...visit }) => visit);
}

/**
 * A schedule as a table of strings, for the package reader and the exported document.
 * @param {ReadonlyArray<{ visit: string, day: number | null, windowDays: number | null, note: string, procedures: ReadonlyArray<{ name: string, note: string }> }>} visits
 * @returns {{ columns: string[], rows: string[][] }}
 */
export function scheduleTable(visits) {
  return {
    columns: ["访视", "计划日", "窗口", "评估与操作"],
    rows: list(visits).map((visit) => {
      const activities = list(visit.procedures).map((activity) => (activity.note ? `${activity.name}（${activity.note}）` : activity.name)).join("、");
      return [visit.visit, soaDayText(visit.day), soaWindowText(visit.windowDays), visit.note ? `${activities}；备注：${visit.note}` : activities];
    }),
  };
}

/**
 * The part of a report model a schedule is: what the package prints and what a template may bind numbers to
 * (`schedule.totals.visits`, `schedule.visits[2].day`). Null when the study has none.
 * @param {{ protocol?: { version?: number } | null, visits?: readonly any[] } | null | undefined} schedule
 */
export function reportSchedule(schedule) {
  const visits = list(schedule?.visits);
  if (!visits.length) return null;
  return { protocolVersion: schedule?.protocol?.version ?? null, visits, totals: soaSummary(visits) };
}

/** The reason a schedule could not give visit times, in the words a run reads. @type {Record<string, string>} */
const TIME_REFUSALS = Object.freeze({
  unit_unknown: `unit 写 ${VCR_SOA_TIME_UNITS.join("、")} 之一：它是这个情景里效应和斜率所用的时间单位。`,
  too_few_visits: "本研究的访视日程里从第 0 天起的访视不足两个，排不出访视时间；补写日程，或直接在 visits 里写时间数组。",
  too_many_visits: "访视日程里从第 0 天起的访视多于轨迹模型一次能取的 50 个；直接在 visits 里写要用的时间数组。",
  unit_too_coarse: "按这个时间单位，日程里相邻的两次访视会变成同一个时间；换成更细的单位。",
});

/**
 * Where a scenario takes visit times (`visits`), the study's own schedule may be named instead of a list: `{ fromSoa: true, unit }`.
 * Answers the scenario with the elapsed times written in, or the refusal in words; a `visits` that is a list (or absent) is returned
 * as it is, and a scenario that names the schedule without the right keys is refused rather than guessed at.
 * @param {Record<string, any>} scenario
 * @param {() => Promise<{ visits: readonly any[] } | null>} readCurrent how the study's current schedule is read
 * @returns {Promise<{ ok: true, scenario: Record<string, any> } | { ok: false, message: string }>}
 */
export async function resolveVisitsRef(scenario, readCurrent) {
  const ref = scenario?.visits;
  if (ref == null || Array.isArray(ref)) return { ok: true, scenario };
  if (typeof ref !== "object" || ref.fromSoa !== true || Object.keys(ref).some((key) => key !== "fromSoa" && key !== "unit")) {
    return { ok: false, message: `visits 写成时间数组，或写成 { "fromSoa": true, "unit": "${VCR_SOA_TIME_UNITS.join("|")}" }，让平台按本研究的访视日程算出时间。` };
  }
  const schedule = await readCurrent();
  if (!schedule?.visits?.length) {
    return { ok: false, message: "本研究还没有访视日程：先用 vcr_write what: soa 写入（日程属于方案的当前版本），或直接在 visits 里写时间数组。" };
  }
  const times = soaVisitTimes(/** @type {any} */ (schedule.visits), String(ref.unit ?? ""));
  if ("reason" in times) return { ok: false, message: TIME_REFUSALS[times.reason] ?? "访视日程排不出访视时间。" };
  return { ok: true, scenario: { ...scenario, visits: times.times } };
}

/**
 * What the runtime reads of a schedule: the visits, what they add up to and the visit times a trajectory would take from them in each
 * unit that can carry them (elapsed from the baseline visit — see `soaVisitTimes`).
 * @param {{ protocol: { id: string, version: number, title: string } | null, visits: readonly any[] }} schedule
 */
export function readSchedule(schedule) {
  const visits = list(schedule.visits);
  /** @type {Record<string, number[]>} */
  const times = {};
  let baselineDay = null;
  for (const unit of VCR_SOA_TIME_UNITS) {
    const found = soaVisitTimes(/** @type {any} */ (visits), unit);
    if (found.ok) { times[unit] = found.times; baselineDay = found.baselineDay; }
  }
  return {
    protocol: schedule.protocol, visits, totals: soaSummary(visits),
    visitTimes: baselineDay === null ? null : { baselineDay, ...times },
  };
}

/** Whether a `YYYY-MM-DD` text is a day that exists (2026-02-30 and 2026-13-01 are not). @param {unknown} text */
export function isCalendarDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === text;
}

/**
 * A regulatory contact as a researcher's form or a run writes it, checked field by field with the field named: a real date, an agency,
 * bounded words, a short list of references. Never reads what the words say. Shared by the page's route and the runtime's writer, so
 * the two refuse the same things in the same words.
 * @param {Record<string, any>} row
 * @returns {{ ok: true, value: { date: string, agency: string, type: string, summary: string, outcome: string, attachments: string[] } }
 *   | { ok: false, issues: Array<{ field: string, message: string }> }}
 */
export function checkRegulatoryContact(row) {
  /** @type {Array<{ field: string, message: string }>} */
  const issues = [];
  /** @param {string} field @param {number} max @param {boolean} [required] */
  const words = (field, max, required = false) => {
    const raw = row[field];
    if (raw == null || raw === "") {
      if (required) issues.push({ field, message: `${field} 必填。` });
      return "";
    }
    if (typeof raw !== "string" || [...raw].length > max) {
      issues.push({ field, message: `${field} 是不超过 ${max} 个字符的文字。` });
      return "";
    }
    return raw.trim();
  };
  const date = row.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) issues.push({ field: "date", message: "date 必填，写成 2026-08-14 这样的年-月-日。" });
  else if (!isCalendarDate(date)) issues.push({ field: "date", message: `${date} 不是一个真实存在的日期。` });
  const agency = words("agency", VCR_REGULATORY_LIMITS.agency, true);
  const type = words("type", VCR_REGULATORY_LIMITS.type);
  const summary = words("summary", VCR_REGULATORY_LIMITS.summary);
  const outcome = words("outcome", VCR_REGULATORY_LIMITS.outcome);
  /** @type {string[]} */
  const attachments = [];
  if (row.attachments != null) {
    if (!Array.isArray(row.attachments) || row.attachments.length > VCR_REGULATORY_LIMITS.attachments) {
      issues.push({ field: "attachments", message: `attachments 是最多 ${VCR_REGULATORY_LIMITS.attachments} 条的列表。` });
    } else {
      for (const [at, entry] of row.attachments.entries()) {
        if (typeof entry !== "string" || !entry.trim() || [...entry].length > VCR_REGULATORY_LIMITS.attachment) {
          issues.push({ field: `attachments[${at}]`, message: `附件是一条说明它在哪儿的文字（文件名、路径或链接），不超过 ${VCR_REGULATORY_LIMITS.attachment} 个字符。` });
        } else attachments.push(entry.trim());
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { date, agency, type, summary, outcome, attachments } };
}

/** What a stored contact row is to a reader. @param {Record<string, any>} row */
export function contactFromRow(row) {
  return {
    id: String(row.id),
    date: row.occurred_text ?? (row.occurred_on == null ? null : new Date(row.occurred_on).toISOString().slice(0, 10)),
    agency: String(row.agency),
    type: String(row.meeting ?? ""),
    summary: String(row.summary ?? ""),
    outcome: String(row.conclusion ?? ""),
    attachments: list(row.attachments).length ? list(row.attachments).map(String) : (row.source_ref ? [String(row.source_ref)] : []),
    source: row.recorded_by === "ai_set" ? "ai_set" : "researcher",
    recordedAt: row.created_at == null ? null : new Date(row.created_at).toISOString(),
  };
}

/**
 * The log as a table of strings, for the package reader and the exported document.
 * @param {ReadonlyArray<ReturnType<typeof contactFromRow>>} contacts
 * @returns {{ columns: string[], rows: string[][] }}
 */
export function contactsTable(contacts) {
  return {
    columns: ["日期", "机构", "类型", "讨论摘要", "结论", "附件"],
    rows: list(contacts).map((contact) => [contact.date ?? "—", contact.agency, contact.type || "—", contact.summary || "—",
      contact.outcome || "—", contact.attachments.length ? contact.attachments.join("；") : "—"]),
  };
}

/**
 * The part of a report model the log is: every contact as it was recorded, latest first.
 * @param {ReadonlyArray<ReturnType<typeof contactFromRow>> | null | undefined} contacts
 */
export function reportContacts(contacts) {
  return list(contacts).map((contact) => ({
    id: contact.id, date: contact.date, agency: contact.agency, type: contact.type, summary: contact.summary,
    outcome: contact.outcome, attachments: contact.attachments,
  }));
}

/**
 * A table as markdown for the exported document: cells on one line, a pipe in a cell escaped.
 * @param {{ columns: readonly string[], rows: readonly (readonly string[])[] }} table
 */
export function markdownTable(table) {
  const cell = (/** @type {string} */ value) => String(value ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  return [`| ${table.columns.map(cell).join(" | ")} |`, `| ${table.columns.map(() => "---").join(" | ")} |`,
    ...table.rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}
