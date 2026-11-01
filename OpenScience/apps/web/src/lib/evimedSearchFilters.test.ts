import { afterEach, describe, expect, it, vi } from "vitest";
import { evimedSearchFilterPatch, parseEvimedSearchFilters, writeEvimedSearchFilters } from "./evimedSearchFilters";

afterEach(() => vi.useRealTimers());

describe("catalogue filter URLs", () => {
  it("canonicalizes legacy recent-year links and retains navigation fields", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
    const params = new URLSearchParams({ q: "diabetes", page: "3", years: "5", language: "en", sort: "newest", articleType: '["Review","Trial","Review"]' });
    const filters = parseEvimedSearchFilters("literature", params);
    expect(filters).toEqual({ language: "en", sort: "newest", startYear: 2022, endYear: 2026, articleType: ["Review", "Trial"] });
    const written = writeEvimedSearchFilters("literature", params, filters);
    expect(written.get("years")).toBeNull();
    expect(written.get("startYear")).toBe("2022");
    expect(written.get("q")).toBe("diabetes");
    expect(written.get("page")).toBe("3");
    expect(parseEvimedSearchFilters("literature", written)).toEqual(filters);
  });

  it("keeps comma-bearing labels whole and makes equivalent selections share one cache identity", () => {
    const left = parseEvimedSearchFilters("trials", new URLSearchParams({ source: "1", recruitmentStatus: '["Active, not recruiting/活跃，但未招募","Completed/完成"]' }));
    const right = parseEvimedSearchFilters("trials", new URLSearchParams({ source: "1", recruitmentStatus: '["Completed/完成","Active, not recruiting/活跃，但未招募"]' }));
    expect(left).toEqual(right);
    expect(left.recruitmentStatus).toHaveLength(2);
    expect(evimedSearchFilterPatch("recruitmentStatus", left.recruitmentStatus)).toEqual({ page: null, recruitmentStatus: JSON.stringify(left.recruitmentStatus) });
  });

  it("drops filters incompatible with the catalogue, language, and registry", () => {
    const params = new URLSearchParams({ source: "2", language: "zh", sort: "impact-high", articleType: '["Review"]', jcrPartition: '["Q1"]',
      studyType: '["Trial"]', testPhase: '["Phase 1"]', recruitmentStatus: '["Completed"]', associatedArticles: '["1"]', minSampleSize: "20", clinicalSourceDb: "PubMed" });
    expect(parseEvimedSearchFilters("literature", params)).toEqual({ language: "zh", sort: "comprehensive", articleType: ["Review"] });
    expect(parseEvimedSearchFilters("trials", params)).toEqual({ source: "2", clinicalSourceDb: "PubMed" });
    expect(parseEvimedSearchFilters("drugs", params)).toEqual({ source: "" });
  });

  it("rejects inverted or non-finite ranges without generating API requests with invalid bounds", () => {
    expect(parseEvimedSearchFilters("literature", new URLSearchParams({ startYear: "2026", endYear: "2020", smallJcr: "NaN", bidJcr: "-2" })))
      .toEqual({ language: "", sort: "comprehensive" });
    expect(parseEvimedSearchFilters("trials", new URLSearchParams({ minSampleSize: "0.5", maxSampleSize: "Infinity", startYear: "2020.5", endYear: "2024" })))
      .toEqual({ source: "0", endYear: 2024 });
    expect(parseEvimedSearchFilters("literature", new URLSearchParams({ smallJcr: "0", bidJcr: "5.5", startYear: "1800" })))
      .toEqual({ language: "", sort: "comprehensive", startYear: 1800, smallJcr: 0, bidJcr: 5.5 });
  });

  it("ignores malformed arrays and caps decoded strings before calling the service", () => {
    expect(parseEvimedSearchFilters("literature", new URLSearchParams({ articleType: '{"bad":"shape"}', keyWords: '[null,3,"","valid"]' })))
      .toEqual({ language: "", sort: "comprehensive", keyWords: ["valid"] });
    expect(parseEvimedSearchFilters("guidelines", new URLSearchParams({ words: ` ${"a".repeat(300)} ` })).words).toHaveLength(200);
  });

  it("retains impact ordering only for English literature and strips all empty filter markers", () => {
    expect(parseEvimedSearchFilters("literature", new URLSearchParams({ language: "en", sort: "impact-low" })).sort).toBe("impact-low");
    expect(parseEvimedSearchFilters("guidelines", new URLSearchParams({ language: "en", sort: "relevance" })).sort).toBe("comprehensive");
    const next = writeEvimedSearchFilters("trials", new URLSearchParams({ q: "trial", years: "3", articleType: '["stale"]' }), { source: "0", words: "" });
    expect(next.toString()).toBe("q=trial");
    expect(evimedSearchFilterPatch("articleType", [])).toEqual({ articleType: null, page: null });
  });
});
