import type { FrontierFact, FrontierItem } from "@/lib/frontierClient";

/**
 * The enrichment keys this build names, in the order a card lists them. Any
 * other key a later plugin sends is listed after them by its own name (plan
 * §14.6: new fields reach the card without a platform release).
 */
const FACT_LABELS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["journal", "期刊"],
  ["authors_short", "作者"],
  ["impact_factor", "影响因子"],
  ["core_journal_tags", "核心期刊"],
  ["affiliation_countries", "作者单位"],
  ["trial_facts", "试验"],
]);
const LABELS: ReadonlyMap<string, string> = new Map(FACT_LABELS);
const CHINA_REGIONS: Readonly<Record<string, string>> = Object.freeze({ HK: "中国香港", MO: "中国澳门", TW: "中国台湾" });
const LIST_MAX = 6;

let regionNames: Intl.DisplayNames | null | undefined;

/** A country code in Chinese (「美国」); the code itself where the runtime has no names. */
function region(code: string): string {
  if (CHINA_REGIONS[code]) return CHINA_REGIONS[code];
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(["zh-Hans"], { type: "region" }); } catch { regionNames = null; }
  }
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

function list(values: string[]): string {
  return values.length > LIST_MAX ? `${values.slice(0, LIST_MAX).join("、")} 等 ${values.length} 项` : values.join("、");
}

function scalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function trial(facts: Record<string, string | number | boolean>): string {
  const parts = [
    ...(facts.phase !== undefined ? [scalar(facts.phase)] : []),
    ...(facts.status !== undefined ? [scalar(facts.status)] : []),
    ...(typeof facts.enrollment === "number" ? [`入组 ${facts.enrollment}`] : []),
    ...(facts.sponsor !== undefined ? [`申办方 ${scalar(facts.sponsor)}`] : []),
  ];
  return parts.join(" · ");
}

function factText(key: string, value: FrontierFact): string {
  if (key === "impact_factor" && typeof value === "number") return value.toFixed(1);
  if (key === "affiliation_countries" && Array.isArray(value)) {
    const names = value.map(region);
    return names.length > LIST_MAX ? `${names.slice(0, LIST_MAX).join("、")} 等 ${names.length} 个国家和地区` : names.join("、");
  }
  if (key === "trial_facts" && !Array.isArray(value) && typeof value === "object") return trial(value);
  if (Array.isArray(value)) return list(value);
  if (typeof value === "object") return Object.entries(value).map(([name, part]) => `${name}：${scalar(part)}`).join("；");
  return scalar(value);
}

/**
 * An item's facts as the card lists them: the named ones first, then any
 * other in the order it came. The journal is left out where the source is
 * the journal itself; a fact with nothing to show is dropped.
 */
export function cardFacts(item: Pick<FrontierItem, "facts" | "sourceType">): Array<{ key: string; label: string; text: string }> {
  const keys = [
    ...FACT_LABELS.map(([key]) => key).filter((key) => Object.hasOwn(item.facts, key)),
    ...Object.keys(item.facts).filter((key) => !LABELS.has(key)),
  ];
  return keys.flatMap((key) => {
    if (key === "journal" && item.sourceType === "journal") return [];
    const value = item.facts[key];
    const text = value === undefined ? "" : factText(key, value);
    return text ? [{ key, label: LABELS.get(key) ?? key.replace(/_/g, " "), text }] : [];
  });
}
