/**
 * The bodies the browser posts to the data-intake routes
 * (`/api/vcr/studies/:id/data/*`) — one plain function per write, each returning
 * exactly the keys the route's allow-list takes and nothing else, the same rule
 * `vcrBodies.ts` keeps for the rest of the module (contract 2026-09-29 §5).
 *
 * Plain functions, no imports, erasable TypeScript only: the server's composed
 * -application test loads this file under Node and posts every builder's output
 * to the real routes, so a route that changes its allow-list turns a test red
 * instead of a button quietly failing in a browser.
 *
 * An upload is not a JSON body: the file itself is the request body and its name
 * and role ride in the query (`uploadQuery`).
 */

/** What a column is for (the closed list the field-map editor offers). */
export type VcrFieldRole =
  | "subject_key" | "arm" | "covariate" | "outcome_time" | "outcome_event" | "time_zero" | "measurement" | "visit_date" | "other";

/** One column of a field map, as the route reads it. */
export interface VcrFieldMapEntry {
  table?: string;
  column: string;
  role?: VcrFieldRole;
  concept?: string;
  unit?: string | null;
  codingSystem?: string | null;
  timeKind?: "occurred_at" | "recorded_at" | "visible_at" | null;
  missingReason?: string | null;
  identifier?: boolean;
  parameter?: string | null;
  alias?: string | null;
  type?: "integer" | "number" | "date" | "text" | null;
  range?: [number, number] | null;
  required?: boolean;
  outcome?: boolean;
  codes?: { event?: string[]; censored?: string[]; treated?: string[]; control?: string[] };
  /** Where this column's values come from: a fact the source recorded, a transcription, a computation or an imputation. */
  valueSource?: "observed" | "extracted" | "calculated" | "imputed";
}

export interface VcrSourceBody {
  name: string;
  ownerParty?: string;
  allowedUses?: string[];
  visibleWindow?: { start?: string; end?: string };
  retention?: { until?: string; note?: string };
  valueSource?: "observed" | "extracted" | "calculated" | "imputed";
}

export interface VcrGrantBody {
  grantee: string;
  role?: string;
  fields?: string[];
  fieldMode?: "allow" | "deny";
  windowStart?: string;
  windowEnd?: string;
  purposes?: string[];
}

/** The keys a field-map entry may carry: an unknown one is refused whole, so it is never sent. */
const ENTRY_KEYS = [
  "table", "column", "role", "concept", "unit", "codingSystem", "timeKind", "missingReason", "identifier", "parameter", "alias",
  "type", "range", "required", "outcome", "codes", "valueSource",
] as const;

/** `null` and empty text are left out: the route reads an absent key as 「没有」. */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function fieldMapEntryBody(entry: VcrFieldMapEntry): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const source = entry as unknown as Record<string, unknown>;
  for (const key of ENTRY_KEYS) {
    const value = source[key];
    if (key === "identifier" || key === "required" || key === "outcome") {
      if (value === true) body[key] = true;
    } else if (present(value)) body[key] = typeof value === "string" ? value.trim() : value;
  }
  return body;
}

export function sourceBody(input: VcrSourceBody): Record<string, unknown> {
  return {
    name: input.name.trim(),
    ...(present(input.ownerParty) ? { ownerParty: input.ownerParty!.trim() } : {}),
    ...(present(input.allowedUses) ? { allowedUses: input.allowedUses } : {}),
    ...(present(input.visibleWindow) ? { visibleWindow: input.visibleWindow } : {}),
    ...(present(input.retention) ? { retention: input.retention } : {}),
    ...(input.valueSource ? { valueSource: input.valueSource } : {}),
  };
}

export function fieldMapBody(columns: readonly VcrFieldMapEntry[], reason?: string): Record<string, unknown> {
  return { columns: columns.map(fieldMapEntryBody), ...(present(reason) ? { reason: reason!.trim().slice(0, 300) } : {}) };
}

export function confirmFieldMapBody(hash: string): Record<string, unknown> {
  return { hash };
}

export function freezeBody(input: { fileIds?: readonly string[]; asOf?: string } = {}): Record<string, unknown> {
  return {
    ...(present(input.fileIds) ? { fileIds: [...input.fileIds!] } : {}),
    ...(present(input.asOf) ? { asOf: input.asOf } : {}),
  };
}

export function grantBody(input: VcrGrantBody): Record<string, unknown> {
  return {
    grantee: input.grantee.trim(),
    ...(present(input.role) ? { role: input.role } : {}),
    ...(present(input.fields) ? { fields: input.fields } : {}),
    ...(input.fieldMode ? { fieldMode: input.fieldMode } : {}),
    ...(present(input.windowStart) ? { windowStart: input.windowStart } : {}),
    ...(present(input.windowEnd) ? { windowEnd: input.windowEnd } : {}),
    ...(present(input.purposes) ? { purposes: input.purposes } : {}),
  };
}

/** The query a standard-format import carries: the file's name and the standard it is declared to be. */
export function importQuery(input: { name: string; format: VcrImportFormat }): string {
  return new URLSearchParams({ name: input.name, format: input.format }).toString();
}

/** The standards a source may be imported from. */
export type VcrImportFormat = "fhir" | "omop" | "adam";

/** The query an upload carries: the file's name, its role and the options that role takes. */
export function uploadQuery(input: { name: string; role?: "data" | "dictionary" | "document"; subject?: string; visibleAt?: string; sheet?: string }): string {
  const query = new URLSearchParams({ name: input.name });
  if (input.role && input.role !== "data") query.set("role", input.role);
  if (present(input.subject)) query.set("subject", input.subject!.trim());
  if (present(input.visibleAt)) query.set("visibleAt", input.visibleAt!.trim());
  if (present(input.sheet)) query.set("sheet", input.sheet!.trim());
  return query.toString();
}
