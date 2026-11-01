import type { EvimedSearchCategory, EvimedSearchFilters } from "./evimedSearchClient";

const ARRAY_KEYS = ["articleType", "keyWords", "p", "ic", "jcrPartition", "journalPartition", "zdzs", "keywords", "sType",
  "firstLevelDepartment", "secondLevelDepartment", "studyType", "testPhase", "recruitmentStatus", "associatedArticles"] as const;
const NUMBER_KEYS = ["startYear", "endYear", "smallJcr", "bidJcr", "minSampleSize", "maxSampleSize"] as const;
const STRING_KEYS = ["words", "language", "source", "sort", "clinicalSourceDb"] as const;
export const EVIMED_SEARCH_FILTER_KEYS = [...ARRAY_KEYS, ...NUMBER_KEYS, ...STRING_KEYS, "years"] as const;

const CATEGORY_ARRAYS: Record<EvimedSearchCategory, readonly typeof ARRAY_KEYS[number][]> = {
  literature: ["articleType", "keyWords", "p", "ic", "jcrPartition", "journalPartition"],
  guidelines: ["zdzs", "keywords", "sType", "firstLevelDepartment", "secondLevelDepartment"],
  drugs: [], trials: ["studyType", "testPhase", "recruitmentStatus", "associatedArticles"],
};

function arrayValue(value: string | null): string[] {
  if (!value || value.length > 12000) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 200))].slice(0, 50).sort();
  } catch { return []; }
}

function numberValue(value: string | null, max: number, min = 0, integer = false): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed)) ? parsed : undefined;
}

/** The URL admits only filters the active catalogue understands; ignored fields never reach the API or cache key. */
export function parseEvimedSearchFilters(category: EvimedSearchCategory, params: URLSearchParams): EvimedSearchFilters {
  const filters: EvimedSearchFilters = {};
  const scholarly = category === "literature" || category === "guidelines";
  const words = params.get("words")?.trim().slice(0, 200);
  if (words) filters.words = words;
  if (scholarly) {
    filters.language = ["zh", "en"].includes(params.get("language") ?? "") ? params.get("language") as "zh" | "en" : "";
    const sort = params.get("sort") ?? "comprehensive";
    const allowedSorts = category === "guidelines" ? ["comprehensive", "newest", "oldest"]
      : ["comprehensive", "relevance", "newest", "oldest", ...(filters.language === "en" ? ["impact-high", "impact-low"] : [])];
    filters.sort = (allowedSorts.includes(sort) ? sort : "comprehensive") as EvimedSearchFilters["sort"];
  } else filters.source = category === "drugs"
    ? ["NMPA", "FDA", "EMA", "PMDA"].includes(params.get("source") ?? "") ? params.get("source")! : ""
    : ["1", "2"].includes(params.get("source") ?? "") ? params.get("source")! : "0";

  if (category !== "drugs") {
    let startYear = numberValue(params.get("startYear"), 2200, 1800, true);
    let endYear = numberValue(params.get("endYear"), 2200, 1800, true);
    if (startYear === undefined && endYear === undefined && ["1", "3", "5", "10"].includes(params.get("years") ?? "")) {
      endYear = new Date().getFullYear(); startYear = endYear - Number(params.get("years")) + 1;
    }
    if (startYear === undefined || endYear === undefined || startYear <= endYear) {
      if (startYear !== undefined) filters.startYear = startYear;
      if (endYear !== undefined) filters.endYear = endYear;
    }
  }
  for (const key of CATEGORY_ARRAYS[category]) {
    if (key === "jcrPartition" && filters.language !== "en") continue;
    if (category === "trials" && (filters.source === "2" || key === "studyType" && filters.source !== "0"
      || ["recruitmentStatus", "associatedArticles"].includes(key) && filters.source !== "1")) continue;
    const values = arrayValue(params.get(key)).filter((value) => key === "sType" ? /^\d{1,4}$/.test(value)
      : key === "associatedArticles" ? ["0", "1"].includes(value) : true);
    if (values.length) filters[key] = values;
  }
  const ranges = category === "literature" ? [["smallJcr", "bidJcr", 1000]] as const
    : category === "trials" && filters.source !== "2" ? [["minSampleSize", "maxSampleSize", 99999999]] as const : [];
  for (const [minKey, maxKey, limit] of ranges) {
    const min = numberValue(params.get(minKey), limit, 0, category === "trials");
    const max = numberValue(params.get(maxKey), limit, 0, category === "trials");
    if (min !== undefined && max !== undefined && min > max) continue;
    if (min !== undefined) filters[minKey] = min;
    if (max !== undefined) filters[maxKey] = max;
  }
  if (category === "trials" && filters.source === "2") {
    const value = params.get("clinicalSourceDb")?.trim().slice(0, 200);
    if (value) filters.clinicalSourceDb = value;
  }
  return filters;
}

/** Keep q/page and other navigation fields; canonicalize arrays and explicit years once. */
export function writeEvimedSearchFilters(category: EvimedSearchCategory, params: URLSearchParams, filters: EvimedSearchFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of EVIMED_SEARCH_FILTER_KEYS) next.delete(key);
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "" || key === "sort" && value === "comprehensive" || key === "source" && value === "0") continue;
    if (Array.isArray(value)) { if (value.length) next.set(key, JSON.stringify(value)); }
    else next.set(key, String(value));
  }
  const canonical = parseEvimedSearchFilters(category, next);
  for (const key of EVIMED_SEARCH_FILTER_KEYS) next.delete(key);
  for (const [key, value] of Object.entries(canonical)) {
    if (value === "" || key === "sort" && value === "comprehensive" || key === "source" && value === "0") continue;
    next.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  return next;
}

export function evimedSearchFilterPatch(key: keyof EvimedSearchFilters, value: string | number | readonly string[] | null | undefined): Record<string, string | null> {
  return { [key]: value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0 ? null
    : Array.isArray(value) ? JSON.stringify(value) : String(value), page: null };
}
