import { VCR_SCENARIO_SCHEMAS, VCR_LONGITUDINAL_SCHEMAS, VCR_ROW_RULE_OPS, VCR_ROW_RULE_COMPARATORS } from "@evimed/domain";
import { WEB_SESSION_ENDED_EVENT } from "./apiClient";
import type { VcrQualityBasis } from "./vcrClient";
export interface MethodDraftScope { userId: string; tenantId: string; projectId: string; studyId: string; method: string; jobId?: string; modelId?: string; modelVersion?: string | null; launchId?: string }
export interface MethodFormDraft {
  studyId: string; method: string; scenario: Record<string, unknown>; seed: string; replicates: string; snapshots: string[];
  subjectId: string | null; model: { id: string; version: string | null; studyId?: string | null } | null;
  reconstructionResultId: string | null; qualityBasis: VcrQualityBasis | null;
}
export interface MethodDraftRecord { active: MethodFormDraft; modes: MethodFormDraft[] }
const PREFIX = "evimed.method-draft.v1:";
const LIMIT = 131_072;
const CAPACITY = 16;
const PATIENT_METHODS = ["patients.binary", "patients.continuous", "patients.time_to_event", "patients.longitudinal"];
const fallback = new Map<string, string>();
let activeOwner: string | null = null;
const ownerOf = (scope: Pick<MethodDraftScope, "userId" | "tenantId">) => JSON.stringify([scope.tenantId, scope.userId]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length <= max;
const reference = (value: unknown): value is string => text(value) && /^[A-Za-z0-9_.:@/-]+$/.test(value);
const nullableId = (value: unknown) => value === null || reference(value);
export const methodDraftKey = (scope: MethodDraftScope): string => PREFIX + encodeURIComponent(JSON.stringify([scope.tenantId, scope.userId, scope.projectId, scope.studyId, scope.method, scope.jobId ?? "", scope.modelId ?? "", scope.modelVersion ?? "", scope.launchId ?? ""]));
export function clearMethodDrafts(): void {
  activeOwner = null; fallback.clear();
  try { for (const key of Object.keys(window.sessionStorage)) if (key.startsWith(PREFIX)) window.sessionStorage.removeItem(key); } catch { /* The tab's in-memory copies are cleared too. */ }
}
export function activateMethodDraftOwner(userId: string, tenantId: string): void {
  const next = ownerOf({ userId, tenantId });
  if (activeOwner !== null && activeOwner !== next) clearMethodDrafts();
  activeOwner = next;
}
if (typeof window !== "undefined") window.addEventListener(WEB_SESSION_ENDED_EVENT, clearMethodDrafts);

type Shape = { t: string; fields?: Record<string, Shape>; items?: Shape; values?: string[] | Shape; variants?: Record<string, Record<string, Shape>>; on?: string; default?: unknown; max?: number; maxLength?: number };
function cleanRule(value: unknown, depth: number): unknown {
  if (depth > 8) throw new Error("rule depth");
  const raw = object(value), op = String(raw.op ?? "");
  if (!(VCR_ROW_RULE_OPS as readonly string[]).includes(op)) throw new Error("rule kind");
  const result: Record<string, unknown> = { op };
  if (op === "all" || op === "any") {
    if (!Array.isArray(raw.operands) || raw.operands.length > 100) throw new Error("rule size");
    result.operands = raw.operands.map(row => cleanRule(row, depth + 1));
  } else if (op === "not") result.operand = cleanRule(raw.operand, depth + 1);
  else {
    if (raw.column !== undefined) { if (!text(raw.column, 128)) throw new Error("rule column"); result.column = raw.column; }
    if (op === "compare") {
      if (raw.comparator !== undefined) { if (!(VCR_ROW_RULE_COMPARATORS as readonly string[]).includes(String(raw.comparator))) throw new Error("rule comparator"); result.comparator = raw.comparator; }
      if (raw.value !== undefined) result.value = scalar(raw.value);
    }
    if (op === "between") for (const key of ["low", "high"]) if (raw[key] !== undefined) result[key] = scalar(raw[key]);
    if (op === "in" || op === "not_in") {
      if (!Array.isArray(raw.values) || raw.values.length > 100) throw new Error("rule values");
      result.values = raw.values.map(scalar);
    }
  }
  return result;
}
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || text(value, 2_000)) return value as string | number | boolean | null;
  throw new Error("scalar");
}
function cleanScenario(method: string, value: unknown): Record<string, unknown> {
  let budget = 25_000;
  const walk = (schema: Shape, input: unknown, depth = 0): unknown => {
    if (--budget < 0 || depth > 16) throw new Error("configuration size");
    if (input === null) return null;
    if (schema.t === "rule") return cleanRule(input, 0);
    if (schema.t === "rules") {
      if (!Array.isArray(input) || input.length > 100) throw new Error("rules size");
      return input.map(value => { const row = object(value); if (!text(row.name, 160)) throw new Error("rule name"); return { name: row.name, rule: cleanRule(row.rule, 0), ...(row.unknownAs === "include" || row.unknownAs === "exclude" ? { unknownAs: row.unknownAs } : {}) }; });
    }
    if (schema.t === "object" || schema.t === "variant") {
      const raw = object(input), discriminator = schema.on ?? "type";
      const fields = schema.t === "variant" ? schema.variants?.[String(raw[discriminator] ?? schema.default ?? Object.keys(schema.variants ?? {})[0])] ?? {} : schema.fields ?? {};
      const entries = Object.entries(fields).filter(([key]) => raw[key] !== undefined).map(([key, child]) => [key, walk(child, raw[key], depth + 1)]);
      if (schema.t === "variant" && raw[discriminator] !== undefined) { if (!text(raw[discriminator], 128)) throw new Error("variant"); entries.push([discriminator, raw[discriminator]]); }
      return Object.fromEntries(entries);
    }
    if (schema.t === "array" || schema.t === "matrix") {
      if (!Array.isArray(input) || input.length > (schema.t === "matrix" ? 500 : Math.min(schema.max ?? 500, 500))) throw new Error("array size");
      const child: Shape = schema.t === "matrix" ? { t: "array", items: { t: "number" } } : schema.items ?? { t: "string" };
      return input.map(row => walk(child, row, depth + 1));
    }
    if (schema.t === "map") return Object.fromEntries(Object.entries(object(input)).map(([key, row]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("map key");
      return [key, walk(schema.values as Shape, row, depth + 1)];
    }));
    if (schema.t === "boolean" && typeof input !== "boolean") throw new Error("boolean");
    if (schema.t === "string" && !text(input, Math.min(schema.maxLength ?? 2_000, 2_000))) throw new Error("string");
    if (["number", "integer"].includes(schema.t) && input !== "" && !(typeof input === "number" && Number.isFinite(input))) throw new Error("number");
    return scalar(input);
  };
  const schema = (VCR_SCENARIO_SCHEMAS as unknown as Record<string, Shape>)[method];
  if (schema) return walk(schema, value) as Record<string, unknown>;
  const forecast = (VCR_LONGITUDINAL_SCHEMAS as Record<string, { required: string[]; optional: string[] }>)[method];
  if (!forecast) throw new Error("method");
  const raw = object(value), result: Record<string, unknown> = {};
  for (const key of [...forecast.required, ...forecast.optional]) {
    if (raw[key] === undefined || key === "scenario") continue;
    if (key === "endpoint") { const endpoint = object(raw[key]); result[key] = Object.fromEntries(["code", "unit", "type"].filter(key => endpoint[key] !== undefined).map(key => [key, scalar(endpoint[key])])); }
    else if (["horizonsDays", "eventCodes"].includes(key)) { if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).length > 100) throw new Error("forecast array"); result[key] = (raw[key] as unknown[]).map(scalar); }
    else result[key] = scalar(raw[key]);
  }
  return result;
}
function cleanForm(value: unknown, scope: MethodDraftScope): MethodFormDraft {
  const raw = object(value), method = String(raw.method ?? "");
  if (raw.studyId !== scope.studyId || method !== scope.method && !(PATIENT_METHODS.includes(scope.method) && PATIENT_METHODS.includes(method))) throw new Error("form scope");
  if (!text(raw.seed, 32) || !text(raw.replicates, 32) || !Array.isArray(raw.snapshots) || raw.snapshots.length > 100 || !raw.snapshots.every(reference) || !nullableId(raw.subjectId) || !nullableId(raw.reconstructionResultId)) throw new Error("form fields");
  const source = raw.model === null ? null : object(raw.model);
  if (source && (!reference(source.id) || source.version !== null && !text(source.version, 128) || source.studyId != null && !reference(source.studyId))) throw new Error("source");
  let qualityBasis: VcrQualityBasis | null = null;
  if (raw.qualityBasis != null) {
    const basis = object(raw.qualityBasis);
    if (!["populationId", "resultId", "inputId"].every(key => reference(basis[key])) || !Number.isSafeInteger(basis.populationVersion) || Number(basis.populationVersion) < 1 || !["population", "synthetic-population"].includes(String(basis.table)) || typeof basis.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(basis.sha256)) throw new Error("generation basis");
    qualityBasis = { populationId: String(basis.populationId), resultId: String(basis.resultId), inputId: String(basis.inputId), populationVersion: Number(basis.populationVersion), table: basis.table as VcrQualityBasis["table"], sha256: basis.sha256 };
  }
  return { studyId: scope.studyId, method, scenario: cleanScenario(method, raw.scenario), seed: raw.seed, replicates: raw.replicates, snapshots: [...raw.snapshots] as string[], subjectId: raw.subjectId as string | null, reconstructionResultId: raw.reconstructionResultId as string | null, qualityBasis,
    model: source ? { id: String(source.id), version: source.version as string | null, ...(source.studyId == null ? {} : { studyId: String(source.studyId) }) } : null };
}
function normalize(value: unknown, scope: MethodDraftScope): MethodDraftRecord {
  const raw = object(value);
  if (!Array.isArray(raw.modes) || raw.modes.length > 4) throw new Error("mode drafts");
  const selectedStudy = object(raw.active).studyId;
  if (!scope.studyId && selectedStudy !== "" && !reference(selectedStudy)) throw new Error("selected study");
  const target = scope.studyId ? scope : { ...scope, studyId: String(selectedStudy) };
  return { active: cleanForm(raw.active, target), modes: raw.modes.map(mode => cleanForm(mode, target)) };
}
export function readMethodDraft(scope: MethodDraftScope): MethodDraftRecord | null {
  if (activeOwner !== ownerOf(scope)) return null;
  const key = methodDraftKey(scope);
  let saved: string | null;
  try { saved = fallback.get(key) ?? window.sessionStorage.getItem(key); } catch { saved = fallback.get(key) ?? null; }
  if (!saved || saved.length > LIMIT) return null;
  try { const raw = object(JSON.parse(saved)); return raw.schema === 1 && raw.scope === key ? normalize(raw, scope) : null; } catch { return null; }
}
export function writeMethodDraft(scope: MethodDraftScope, value: unknown): boolean {
  if (activeOwner !== ownerOf(scope)) return false;
  try {
    const key = methodDraftKey(scope), record = normalize(value, scope);
    const saved = JSON.stringify({ schema: 1, scope: key, savedAt: Date.now(), ...record });
    if (saved.length > LIMIT) return false;
    fallback.delete(key); fallback.set(key, saved);
    while (fallback.size > CAPACITY) fallback.delete(fallback.keys().next().value!);
    try {
      window.sessionStorage.setItem(key, saved);
      const keys = Object.keys(window.sessionStorage).filter(key => key.startsWith(PREFIX));
      const age = (key: string) => { try { return Number(JSON.parse(window.sessionStorage.getItem(key) ?? "{}").savedAt) || 0; } catch { return 0; } };
      keys.sort((a, b) => age(a) - age(b));
      while (keys.length > CAPACITY) { const old = keys.shift()!; window.sessionStorage.removeItem(old); fallback.delete(old); }
    } catch { /* The bounded current-tab copy still survives route navigation. */ }
    return true;
  } catch { return false; }
}
