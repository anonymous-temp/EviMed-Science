import { describe, expect, it } from "vitest";
import { concentrationFacts, concentrationTitle } from "@/components/charts/SourceConcentration";
import type { GeoActionSource } from "@/lib/geoClient";
import { actionFixture, G_BRAND, G_EFFECT } from "../__fixtures__/geoSpine";
import { candidatesOf, conditionsVerified, domainsOfGroup, groupsOfDomain, isPlaceable, kindCounts, kindOf } from "./sourceModel";

const site = (overrides: Partial<GeoActionSource> & Pick<GeoActionSource, "domain">): GeoActionSource => ({
  channel: null, name: null, kind: null, layer: null, why: null, citedFor: {}, conditions: {}, price: null, available: null,
  unavailableBecause: [], route: "waiting_market", origin: "cited", chosen: "recommended", orderId: null, articleIds: [], ...overrides,
});
const group = (id: string, name: string) => ({ id, name, pool: "P2" as const, journeyStage: null, journeyStageNo: null, weight: 0.05, isControl: false as const });

describe("kinds of site", () => {
  it("counts the answers that cited each kind, the most first, and puts a server kind with no word under 其他", () => {
    const sources = [{ kind: "news" }, { kind: "news" }, { kind: "encyclopedia" }, { kind: null }, { kind: "百科" }];
    const cited = [3, 4, 2, 1, 6];
    const counts = kindCounts(sources, (source) => cited[sources.indexOf(source)]);
    // 「encyclopedia」 and 「百科」 are one reader's word: one bar
    expect(counts.map((entry) => [entry.label, entry.sites, entry.citations])).toEqual([["百科", 2, 8], ["新闻媒体", 2, 7], ["其他", 1, 1]]);
    expect(kindOf({ kind: null })).toEqual({ key: "other", label: "其他" });
  });
});

describe("what the server says of a site", () => {
  it("a site is placeable when the market lists it or it is the brand's own", () => {
    expect(isPlaceable({ market: { price: 10, resourceId: "r" }, layer: "coverage" })).toBe(true);
    expect(isPlaceable({ market: null, layer: "owned" })).toBe(true);
    expect(isPlaceable({ market: null, layer: "coverage" })).toBe(false);
  });

  it("the three conditions are verified only when all are met; one not checked is not met", () => {
    expect(conditionsVerified({ conditions: { icp: true, newsIndexed: true, medical: true } })).toBe(true);
    expect(conditionsVerified({ conditions: { icp: true, newsIndexed: null, medical: true } })).toBe(false);
    expect(conditionsVerified({ conditions: { icp: true, newsIndexed: true, medical: false } })).toBe(false);
  });
});

describe("candidatesOf", () => {
  const brand = actionFixture({ key: "a", kind: "fill_gap", group: group(G_BRAND, "品牌"), sources: [
    site({ domain: "dxy.cn", name: "丁香园", citedFor: { deepseek: 2 }, route: "waiting_market" }),
    site({ domain: null, channel: "wechat_mp", name: "微信公众号", route: "own", available: true }),
  ] });
  const effect = actionFixture({ key: "b", kind: "win_cluster", group: group(G_EFFECT, "效果"), sources: [
    site({ domain: "dxy.cn", name: "丁香园", citedFor: { doubao: 1 }, route: "market", available: true, price: 90 }),
    site({ domain: "x.cn", route: "not_in_market", available: false, unavailableBecause: ["refuses_medical"] }),
  ] });
  const skipped = actionFixture({ key: "c", kind: "fill_gap", group: group("g3", "三"), choice: { skipped: true, sourceDomain: null, updatedAt: null }, sources: [site({ domain: "gone.cn" })] });

  it("merges the same place across actions, keeps the better statement of it, and the groups and engines it serves", () => {
    const places = candidatesOf([brand, effect, skipped]);
    const dxy = places.find((place) => place.domain === "dxy.cn")!;
    expect(dxy.actions).toBe(2);
    expect(dxy.engines.sort()).toEqual(["deepseek", "doubao"]);
    expect(dxy.groups.map((entry) => entry.id)).toEqual([G_BRAND, G_EFFECT]);
    // available in one action, waiting in the other: it can be ordered
    expect(dxy.available).toBe(true);
    expect(dxy.route).toBe("market");
    expect(dxy.price).toBe(90);
    expect(places.some((place) => place.domain === "gone.cn")).toBe(false);
  });

  it("lists the market's places first, the brand's own next, then what waits and what is refused", () => {
    expect(candidatesOf([brand, effect]).map((place) => place.key)).toEqual(["dxy.cn", "channel:wechat_mp", "x.cn"]);
  });

  it("knows a group's sites and a site's groups", () => {
    expect([...domainsOfGroup([brand, effect], G_BRAND)]).toEqual(["dxy.cn"]);
    expect(groupsOfDomain([brand, effect], "dxy.cn").map((entry) => entry.id)).toEqual([G_BRAND, G_EFFECT]);
    expect(groupsOfDomain([brand, effect], "x.cn").map((entry) => entry.id)).toEqual([G_EFFECT]);
  });
});

describe("concentration", () => {
  it("titles the share of the busiest sites alone; the sites cited once are the legend's fact", () => {
    const facts = concentrationFacts([40, 20, 10, 5, 1, 1, 1, 1, 1, 1], 3);
    expect(concentrationTitle(facts)).toBe("前 3 个站占了 86% 的引用");
    expect(facts.once).toBe(6);
    expect(concentrationTitle(concentrationFacts([]))).toBe("这一轮还没有回答引用任何站点");
  });
});
