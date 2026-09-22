import { describe, expect, it } from "vitest";
import { frontierItem } from "./__fixtures__/frontierItems";
import { cardFacts } from "./frontierFacts";

describe("the card's facts", () => {
  it("lists the named facts in Chinese, first, and any key a later plugin adds by its own name", () => {
    const item = frontierItem({
      sourceType: "media",
      facts: {
        evidence_grade: "B",
        impact_factor: 78.456,
        journal: "The New England journal of medicine",
        affiliation_countries: ["US", "CN", "HK"],
        trial_facts: { phase: "PHASE3", status: "RECRUITING", enrollment: 500, sponsor: "Novo Nordisk" },
        core_journal_tags: ["中华医学会系列", "北大核心"],
        guideline_listed: true,
      },
    });
    expect(cardFacts(item)).toEqual([
      { key: "journal", label: "期刊", text: "The New England journal of medicine" },
      { key: "impact_factor", label: "影响因子", text: "78.5" },
      { key: "core_journal_tags", label: "核心期刊", text: "中华医学会系列、北大核心" },
      { key: "affiliation_countries", label: "作者单位", text: "美国、中国、中国香港" },
      { key: "trial_facts", label: "试验", text: "PHASE3 · RECRUITING · 入组 500 · 申办方 Novo Nordisk" },
      { key: "evidence_grade", label: "evidence grade", text: "B" },
      { key: "guideline_listed", label: "guideline listed", text: "是" },
    ]);
  });

  it("leaves the journal out where the source is the journal, and shortens long lists", () => {
    const item = frontierItem({ sourceType: "journal", facts: { journal: "NEJM", affiliation_countries: ["US", "GB", "DE", "FR", "JP", "CA", "AU"] } });
    expect(cardFacts(item)).toEqual([
      { key: "affiliation_countries", label: "作者单位", text: "美国、英国、德国、法国、日本、加拿大 等 7 个国家和地区" },
    ]);
    expect(cardFacts(frontierItem({ facts: {} }))).toEqual([]);
  });
});
