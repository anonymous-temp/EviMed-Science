/**
 * The people of a generated table, as a list (R19, plan §5.3; `GET /api/vcr/studies/:id/{patients,population}/rows` and
 * `GET …/patients/:patient`, `vcrRows.mjs`).
 *
 * Hidden knowledge:
 *
 *  - **The server pages, sorts and filters.** A table of two million cells is never in the browser: a page is at most 5,000 rows,
 *    `total` is what passed the filters and `all` the table's own count. `sort=col` runs ascending, `sort=-col` descending; a number
 *    column takes `a..b` (either end may be left out) or one number, a text column a comma list.
 *  - **A column's `label` is null where the engine knows no word for it** — a variable the study named. The page joins
 *    `columns[].key` to the tab's `profile[].variable` for the study's own label (`labelOf`); it never prints a bare key to a reader
 *    when the study said what it was called.
 *  - **A population has no id column.** Its rows are addressed by their position; only a patient set has a record to open.
 *  - Every refusal is a named code (`vcr_records_not_synthetic`, `vcr_records_unavailable`, `vcr_rows_too_large`, …) that
 *    `webErrorMessage` words; a reader is told, and nothing is drawn half.
 */
import { productRequest } from "./productClient";

/** A cell: a number for a number column, the text otherwise, null for a missing one. */
export type VcrRowCell = string | number | null;

export interface VcrRowColumn {
  key: string;
  /** The engine's own word for it (「分组」「时间」), or null when it is the study's variable and the tab's profile names it. */
  label: string | null;
  kind: "id" | "number" | "text";
  /** What a value says, for a column the engine writes as 0 / 1 (`arm`: 对照 / 试验). */
  values?: Record<string, string>;
}

export interface VcrRowArm {
  value: string;
  label: string;
  n: number;
}

export interface VcrRowsPage {
  /** The result this table belongs to. */
  result: string;
  kind: "patient_set" | "population";
  columns: VcrRowColumn[];
  rows: Array<Record<string, VcrRowCell>>;
  /** Rows that pass the filters, and the table's own count. */
  total: number;
  all: number;
  offset: number;
  limit: number;
  sort: { column: string; descending: boolean } | null;
  arms: VcrRowArm[];
}

export interface VcrRowsQuery {
  result?: string | null;
  offset?: number;
  limit?: number;
  /** `age` ascending, `-age` descending. */
  sort?: string | null;
  /** `1`, `0`, `treatment`, `control`, `试验`, `对照`. */
  arm?: string | null;
  /** Column → filter text: `60..70`, `1`, `a,b`. At most eight. */
  filters?: Record<string, string>;
}

export type VcrRowsSource = "patients" | "population";

/** One baseline or outcome fact of one patient. */
export interface VcrRecordFact {
  key: string;
  label: string | null;
  value: string | number | null;
  /** The word for a coded value (「发生事件」), when the engine has one. */
  text?: string | null;
}

/** Where the patient stands in their arm, said as numbers (`vcrRows.recordOf`); the page writes the sentence. */
export type VcrRecordPosition =
  | { kind: "time_to_event"; arm: string; time: number; event: boolean; survival: number | null; stillFollowed: number | null; armSize: number | null; armMedian: number | null }
  | { kind: "continuous"; arm: string; value: number; percentile: number | null; armMean: number | null; armSize: number | null }
  | { kind: "binary"; arm: string; value: number; armRate: number | null; armSize: number | null };

export interface VcrPatientRecord {
  result: string;
  id: string;
  arm: { value: string; label: string } | null;
  baseline: VcrRecordFact[];
  outcome: VcrRecordFact[];
  position: VcrRecordPosition | null;
  /** The patient under each assumption — only where the table holds one outcome for each; the engine writes one today, so null. */
  trajectories: Array<{ arm: string; label: string; values: Record<string, number | null> }> | null;
}

const root = (studyId: string) => `/vcr/studies/${encodeURIComponent(studyId)}`;

type Loose = Record<string, unknown>;
const obj = (value: unknown): Loose => (value && typeof value === "object" && !Array.isArray(value) ? value as Loose : {});
const arr = (value: unknown): Loose[] => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Loose[] : []);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function cell(value: unknown): VcrRowCell {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? value : null;
}

export function readVcrRowsPage(raw: unknown): VcrRowsPage {
  const value = obj(raw);
  const sort = obj(value.sort);
  return {
    result: text(value.result) ?? "",
    kind: value.kind === "population" ? "population" : "patient_set",
    columns: arr(value.columns).filter((column) => typeof column.key === "string" && column.key).map((column) => ({
      key: String(column.key),
      label: text(column.label),
      kind: column.kind === "id" ? "id" : column.kind === "text" ? "text" : "number",
      ...(column.values && typeof column.values === "object" ? { values: Object.fromEntries(Object.entries(obj(column.values)).map(([key, word]) => [key, String(word)])) } : {}),
    })),
    rows: arr(value.rows).map((row) => Object.fromEntries(Object.entries(row).map(([key, item]) => [key, cell(item)]))),
    total: finite(value.total) ?? 0,
    all: finite(value.all) ?? 0,
    offset: finite(value.offset) ?? 0,
    limit: finite(value.limit) ?? 0,
    sort: typeof sort.column === "string" ? { column: sort.column, descending: sort.descending === true } : null,
    arms: arr(value.arms).filter((arm) => typeof arm.value === "string").map((arm) => ({ value: String(arm.value), label: text(arm.label) ?? String(arm.value), n: finite(arm.n) ?? 0 })),
  };
}

/** One page of the table: sorted and filtered by the server. */
export async function getVcrRows(studyId: string, source: VcrRowsSource, query: VcrRowsQuery = {}): Promise<VcrRowsPage> {
  const search = new URLSearchParams();
  if (query.result) search.set("result", query.result);
  if (query.offset) search.set("offset", String(query.offset));
  if (query.limit) search.set("limit", String(query.limit));
  if (query.sort) search.set("sort", query.sort);
  if (query.arm) search.set("arm", query.arm);
  for (const [column, filter] of Object.entries(query.filters ?? {})) if (filter) search.set(`filter[${column}]`, filter);
  const suffix = search.toString();
  return readVcrRowsPage(await productRequest<unknown>(`${root(studyId)}/${source}/rows${suffix ? `?${suffix}` : ""}`));
}

function readFact(raw: Loose): VcrRecordFact {
  const value = raw.value;
  return { key: text(raw.key) ?? "", label: text(raw.label), value: typeof value === "number" || typeof value === "string" ? value : null, text: text(raw.text) };
}

function readPosition(raw: unknown): VcrRecordPosition | null {
  const value = obj(raw);
  const arm = text(value.arm) ?? "";
  if (value.kind === "time_to_event" && finite(value.time) !== null) {
    return {
      kind: "time_to_event", arm, time: Number(value.time), event: value.event === true, survival: finite(value.survival),
      stillFollowed: finite(value.stillFollowed), armSize: finite(value.armSize), armMedian: finite(value.armMedian),
    };
  }
  if (value.kind === "continuous" && finite(value.value) !== null) {
    return { kind: "continuous", arm, value: Number(value.value), percentile: finite(value.percentile), armMean: finite(value.armMean), armSize: finite(value.armSize) };
  }
  if (value.kind === "binary" && finite(value.value) !== null) {
    return { kind: "binary", arm, value: Number(value.value), armRate: finite(value.armRate), armSize: finite(value.armSize) };
  }
  return null;
}

export function readVcrPatientRecord(raw: unknown): VcrPatientRecord {
  const value = obj(raw);
  const arm = obj(value.arm);
  return {
    result: text(value.result) ?? "",
    id: text(value.id) ?? "",
    arm: typeof arm.value === "string" ? { value: arm.value, label: text(arm.label) ?? arm.value } : null,
    baseline: arr(value.baseline).map(readFact),
    outcome: arr(value.outcome).map(readFact),
    position: readPosition(value.position),
    trajectories: Array.isArray(value.trajectories)
      ? arr(value.trajectories).map((entry) => ({
        arm: text(entry.arm) ?? "",
        label: text(entry.label) ?? "",
        values: Object.fromEntries(Object.entries(obj(entry.values)).map(([key, number]) => [key, finite(number)])),
      }))
      : null,
  };
}

/** One patient's own record: baseline, arm, where they stand on the curve, and — when the table holds them — both assumptions. */
export async function getVcrPatientRecord(studyId: string, patientId: string, result?: string | null): Promise<VcrPatientRecord> {
  const query = result ? `?result=${encodeURIComponent(result)}` : "";
  return readVcrPatientRecord(await productRequest<unknown>(`${root(studyId)}/patients/${encodeURIComponent(patientId)}${query}`));
}
