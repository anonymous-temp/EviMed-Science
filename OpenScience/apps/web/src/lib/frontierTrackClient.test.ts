import { afterEach, describe, expect, it, vi } from "vitest";
import { rawFrontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { parseFrontierApprovals, parseFrontierCongressHub, parseFrontierGuidelines } from "./frontierClient";

afterEach(() => vi.restoreAllMocks());

describe("追踪's answers are read field by field", () => {
  it("reads an approval row with its item, day, kind, agency, product and indication; a row without a day or a product is not a row", () => {
    const page = parseFrontierApprovals({
      items: [
        { item: rawFrontierItem({ id: "ap1" }), at: "2026-10-24", approval: "new-drug", approvalLabel: "首次获批", agency: { key: "fda", label: "FDA" }, drug: "Hibsago（bepirovirsen）", indication: "慢性乙型肝炎", editorModel: "x" },
        { item: rawFrontierItem({ id: "ap2" }), at: "yesterday", approval: "new-drug", drug: "No day" },
        { item: rawFrontierItem({ id: "ap3" }), at: "2026-10-23", approval: "new-drug" },
        { item: null, at: "2026-10-23", drug: "No item" },
      ],
      nextCursor: "abc", from: "2026-07-27",
      agencies: [{ key: "fda", label: "FDA", region: "us", regionLabel: "美国", count: 7 }, { key: "", label: "x", count: 1 }],
      ytd: { year: 2026, since: "2026-09-22", total: 12, byAgency: [{ key: "fda", label: "FDA", count: 7 }] }, listId: "list-1",
    });
    expect(page.items.map((row) => row.item.id)).toEqual(["ap1"]);
    expect(page.items[0]).toMatchObject({ at: "2026-10-24", approvalLabel: "首次获批", agency: { key: "fda", label: "FDA" }, drug: "Hibsago（bepirovirsen）", indication: "慢性乙型肝炎" });
    expect(page.items[0]).not.toHaveProperty("editorModel");
    expect(page.nextCursor).toBe("abc");
    expect(page.agencies).toEqual([{ key: "fda", label: "FDA", region: "us", regionLabel: "美国", count: 7 }]);
    expect(page.ytd).toEqual({ year: 2026, since: "2026-09-22", total: 12, byAgency: [{ key: "fda", label: "FDA", count: 7 }] });
    expect(page.listId).toBe("list-1");
  });

  it("reads nothing from a body that is not an object", () => {
    expect(parseFrontierApprovals(null)).toMatchObject({ items: [], nextCursor: null, agencies: [], ytd: { total: 0, since: null } });
    expect(parseFrontierGuidelines("x")).toMatchObject({ items: [], specialties: [] });
    expect(parseFrontierCongressHub(null)).toBeNull();
    expect(parseFrontierCongressHub({ congress: { id: "x" } })).toBeNull();
  });

  it("reads a guideline row with at most five recommendations and their grades", () => {
    const page = parseFrontierGuidelines({
      items: [{ item: rawFrontierItem({ id: "g1" }), at: "2026-10-24", body: "美国内科医师学会", scope: "绝经症状",
        recommendations: Array.from({ length: 7 }, (_, index) => ({ text: `推荐 ${index}`, grade: index === 0 ? "强推荐" : null })).concat([{ text: "", grade: null }]) }],
      specialties: [{ key: "oncology", label: "肿瘤", count: 3 }],
    });
    expect(page.items[0].recommendations).toHaveLength(5);
    expect(page.items[0].recommendations[0]).toEqual({ text: "推荐 0", grade: "强推荐" });
    expect(page.specialties).toEqual([{ key: "oncology", label: "肿瘤", count: 3 }]);
  });

  it("reads a congress hub: its days, a recap with its references, a conference result's caveat; an unsafe link is dropped", () => {
    const hub = parseFrontierCongressHub({
      congress: { id: "esmo-2026", code: "ESMO 2026", name: "欧洲肿瘤内科学会年会", nameEn: "ESMO Congress 2026", start: "2026-10-23", end: "2026-10-27", city: "Madrid",
        specialty: "oncology", specialtyLabel: "肿瘤", status: "ongoing", sourceUrl: "javascript:alert(1)", abstractsAt: null },
      itemCount: 2,
      days: [
        { day: "2026-10-24", recap: { text: "药物 A 公布[1]。", at: "2026-10-24T10:00:00Z", refs: [{ n: 1, itemId: "i1", title: "药物 A", sourceName: "医脉通" }, { n: 0, itemId: "bad" }] },
          items: [{ item: rawFrontierItem({ id: "i1" }), caveat: "期中分析" }, { item: rawFrontierItem({ id: "i2" }), caveat: null }] },
        { day: "someday", recap: null, items: [] },
      ],
      listId: "l",
    });
    expect(hub?.congress).toMatchObject({ id: "esmo-2026", code: "ESMO 2026", status: "ongoing", sourceUrl: null });
    expect(hub?.days).toHaveLength(1);
    expect(hub?.days[0].recap?.refs).toEqual([{ n: 1, itemId: "i1", title: "药物 A", sourceName: "医脉通" }]);
    expect(hub?.days[0].items.map((row) => row.caveat)).toEqual(["期中分析", null]);
  });
});
