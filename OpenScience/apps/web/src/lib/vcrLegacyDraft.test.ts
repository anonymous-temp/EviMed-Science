import { beforeEach, describe, expect, it } from "vitest";
import { discardLegacyVcrDraft, readLegacyVcrDrafts } from "./vcrLegacyDraft";

const key = (user = "u", tenant = "t", study = "new") => `evimed.study-brief.v1:${tenant}:${user}:${study}`;
describe("retired brief recovery", () => {
  beforeEach(() => localStorage.clear());
  it("preserves exact text and attachment standing without reading another account or removing storage", () => {
    const value = JSON.stringify({ fields: { question: "  我的问题\n第二行  ", population: " 成人 " }, remote: { id: "s", projectId: "p" },
      attachments: [{ name: "data.csv", state: "uploaded" }, { name: "pending.csv", state: "selected" }] });
    localStorage.setItem(key(), value); localStorage.setItem(key("other"), value); localStorage.setItem(key("u", "other"), value);
    const drafts = readLegacyVcrDrafts("u", "t");
    expect(drafts).toHaveLength(1); expect(drafts[0].text.startsWith("  我的问题\n第二行  ")).toBe(true);
    expect(drafts[0].text).toContain("目标人群： 成人 "); expect(drafts[0].text).toContain("data.csv（已上传）");
    expect(localStorage.getItem(key())).toBe(value); expect(drafts[0].state).toBe("recoverable");
  });
  it("excludes submitted work and retains confirming or unknown submission as uncertain", () => {
    for (const [state, study] of [["accepted", "a"], ["confirming", "b"], ["unexpected", "c"]]) {
      localStorage.setItem(key("u", "t", study), JSON.stringify({ fields: { question: state }, request: { state } }));
    }
    expect(readLegacyVcrDrafts("u", "t").map(row => [row.studyId, row.state])).toEqual([["b", "uncertain"], ["c", "uncertain"]]);
    expect(readLegacyVcrDrafts("u", "t", { studyId: "b" })).toHaveLength(1);
    expect(localStorage.length).toBe(3);
  });
  it("never discards another scope or a draft edited since recovery was offered", () => {
    localStorage.setItem(key(), JSON.stringify({ fields: { question: "original" } })); const [draft] = readLegacyVcrDrafts("u", "t");
    expect(discardLegacyVcrDraft(draft, "other", "t")).toBe(false);
    localStorage.setItem(key(), JSON.stringify({ fields: { question: "changed" } })); expect(discardLegacyVcrDraft(draft, "u", "t")).toBe(false);
    const [current] = readLegacyVcrDrafts("u", "t"); expect(discardLegacyVcrDraft(current, "u", "t")).toBe(true);
  });
});
