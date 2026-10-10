import {
  DATA_CHECK_FAMILY_LABELS_ZH,
  DATA_CHECK_NOT_CHECKED_REASONS,
  DATA_CHECK_OUTCOMES,
  DATA_FACET_LABELS_ZH,
  DATA_JOIN_CARDINALITY_LABELS_ZH,
  DATA_VARIABLE_ROLE_LABELS_ZH,
  SEMANTIC_BASIS_LABELS_ZH,
  VCR_MISSING_REASON_LABELS_ZH,
  VCR_TIME_KIND_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH,
} from "@evimed/domain";

export { DATA_CHECK_OUTCOMES };

/** The part of a stored fact a page shows. */
export interface SemanticFactSummary {
  value: unknown;
  basis: string;
  statement?: string;
  statedIn?: { path: string };
  inferredFrom?: string[];
  contested?: Array<{ value: unknown; basis: string }>;
  supersedes?: { value: unknown; basis: string };
}

const TYPE_LABELS: Record<string, string> = { integer: "整数", number: "数值", date: "日期", text: "文本" };
const label = (table: Readonly<Record<string, string>>, key: unknown, fallback = "未登记") => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : fallback);

export const facetLabel = (facet: string) => label(DATA_FACET_LABELS_ZH, facet, "其他");
export const basisLabel = (basis: string) => label(SEMANTIC_BASIS_LABELS_ZH, basis, "未登记");
export const outcomeLabel = (outcome: string) => (Object.hasOwn(DATA_CHECK_OUTCOMES, outcome) ? (DATA_CHECK_OUTCOMES as Record<string, { zh: string }>)[outcome].zh : "未登记的检查结果");
export const familyLabel = (family: string) => label(DATA_CHECK_FAMILY_LABELS_ZH, family, "检查");
export const notCheckedLabel = (reason: string) => label(DATA_CHECK_NOT_CHECKED_REASONS as Readonly<Record<string, string>>, reason, "没有运行");

const list = (items: unknown[], cap = 12) => `${items.slice(0, cap).join("、")}${items.length > cap ? ` 等 ${items.length} 项` : ""}`;

/** A fact's value in the researcher's words. */
export function factText(facet: string, value: unknown): string {
  if (value === null) return facet === "unit" ? "没有单位" : "无";
  if (facet === "type") return label(TYPE_LABELS, value, String(value));
  if (facet === "role") return label(DATA_VARIABLE_ROLE_LABELS_ZH, value, String(value));
  if (facet === "valueSource") return label(VCR_VALUE_SOURCE_LABELS_ZH, value, String(value));
  if (facet === "cardinality") return label(DATA_JOIN_CARDINALITY_LABELS_ZH, value, String(value));
  if (facet === "allowedValues" && Array.isArray(value)) {
    return list(value.map((item) => (item && typeof item === "object" && "label" in item ? `${(item as { code: string }).code}（${(item as { label: string }).label}）` : String((item as { code: string }).code))));
  }
  if (facet === "range" && Array.isArray(value)) return `${value[0]} 到 ${value[1]}`;
  if (facet === "missingness" && value && typeof value === "object") {
    const { tokens, reason } = value as { tokens?: string[]; reason?: string | null };
    return [tokens?.length ? `记作 ${list(tokens)}` : "", reason ? label(VCR_MISSING_REASON_LABELS_ZH, reason, "") : ""].filter(Boolean).join("，") || "按空白处理";
  }
  if (facet === "measuredAt" && value && typeof value === "object") {
    const { column, timeKind } = value as { column: string; timeKind?: string };
    return `${column}${timeKind ? `（${label(VCR_TIME_KIND_LABELS_ZH, timeKind, "")}）` : ""}`;
  }
  if (facet === "timeWindow" && value && typeof value === "object") {
    const { start, end, note } = value as { start?: string; end?: string; note?: string };
    return [`${start ?? "不详"} 至 ${end ?? "不详"}`, note].filter(Boolean).join("，");
  }
  if (Array.isArray(value)) return list(value);
  return String(value);
}

/**
 * What a fact rests on, as the line under it says it, in plain words (owner ruling 2026-10-10: not a tag beside every fact, not a count):
 * 「依据：你的说明“…”」, 「依据：数据字典（文件）」, 「依据：AI 判断（它读到的）」.
 */
export function factSource(fact: SemanticFactSummary): string {
  const basis = basisLabel(fact.basis);
  if (fact.basis === "researcher_confirmed") return `依据：${basis}${fact.statement ? `“${fact.statement}”` : "（在文件页确认）"}`;
  if (fact.basis === "dictionary_stated") return `依据：${basis}${fact.statedIn ? `（${fact.statedIn.path.split("/").pop()}）` : ""}`;
  return `依据：${basis}${fact.inferredFrom?.length ? `（${fact.inferredFrom.join("；")}）` : ""}`;
}

/** A finding's subject: the column, the table, the step — never an id. */
export function findingSubject(subject: Record<string, string>): string {
  return [subject.table, subject.column ?? subject.predictor ?? subject.step ?? subject.join].filter(Boolean).join(" · ");
}
