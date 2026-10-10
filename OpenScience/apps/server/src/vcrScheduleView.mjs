/**
 * What a schedule of activities is to a reader and to the runtime, as pure functions: the rows of a table, the part of a report model
 * it is, the visit times a scenario takes from it. No store, no clock — the store that keeps it is `vcrSchedule.mjs`; this module is what
 * the report model (`vcrRender.mjs`), the package reader (`vcrViews.mjs`), the exported document (`vcrDocumentExport.mjs`) and the
 * gateway share, and it imports only the domain.
 *
 * @module vcrScheduleView
 */

import { VCR_SOA_TIME_UNITS, soaDayText, soaSummary, soaVisitTimes, soaWindowText } from "@evimed/domain";

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

/**
 * A table as markdown for the exported document: cells on one line, a pipe in a cell escaped.
 * @param {{ columns: readonly string[], rows: readonly (readonly string[])[] }} table
 */
export function markdownTable(table) {
  const cell = (/** @type {string} */ value) => String(value ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  return [`| ${table.columns.map(cell).join(" | ")} |`, `| ${table.columns.map(() => "---").join(" | ")} |`,
    ...table.rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}
