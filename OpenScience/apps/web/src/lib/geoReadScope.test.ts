import { describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => ({ productRequest: vi.fn().mockResolvedValue({}) }));
vi.mock("./productClient", () => ({ productRequest: network.productRequest }));
import { geoReadScopeFromSearch, geoReadScopeQuery, geoSearchWithScope } from "./geoReadScope";
import { getGeoProject, getGeoQuestions, getGeoDiagnosis, getGeoMonitoring, getGeoSources, getGeoSource, getGeoClusters, getGeoCluster } from "./geoClient";

describe("one GEO observation range at the browser boundary", () => {
  it("canonicalizes the existing business filters without sending navigation or drawer state to the API", () => {
    const scope = geoReadScopeFromSearch("?engine=kimi&cluster=g2&pool=P1&from=2026-10-01&to=2026-10-03&session=s1&step=diagnosis&on=deepseek&group=g9&source=x&view=claims");
    expect(scope).toEqual({ engines: ["kimi"], groupIds: ["g2"], pools: ["P1"], from: "2026-10-01", to: "2026-10-03" });
    expect(geoReadScopeQuery(scope)).toBe("?from=2026-10-01&to=2026-10-03&engines=kimi&groupIds=g2&pools=P1");
  });
  it("gives equivalent multi-selections one cache key and keeps commas inside a client label", () => {
    const a = geoReadScopeFromSearch("?engines=kimi,deepseek&engines=kimi&clientTags=病程,长期&clientTags=老年&questionVersion=3");
    const b = geoReadScopeFromSearch("?engines=deepseek&engines=kimi&clientTags=老年&clientTags=病程,长期&questionVersion=3");
    expect(geoReadScopeQuery(a)).toBe(geoReadScopeQuery(b));
    expect(a.clientTags).toEqual(["病程,长期", "老年"]);
    expect(a.questionVersion).toBe(3);
    expect(geoReadScopeQuery(geoReadScopeFromSearch("?step=monitoring&session=s1"))).toBe("");
  });
  it("matches preserved client category labels exactly, including their original whitespace", () => {
    const query = geoReadScopeQuery({ clientTags: [" 高龄 ", "病程,长期"], engines: [" kimi "] });
    expect(geoReadScopeFromSearch(query)).toEqual({ clientTags: [" 高龄 ", "病程,长期"], engines: ["kimi"] });
  });
  it("replaces a range atomically without losing the conversation, and resets stale selection/page references", () => {
    const next = new URLSearchParams(geoSearchWithScope("?session=s1&view=claims&engine=kimi&selectionRef=sel1&errorOffset=100&from=2026-10-01", { engines: ["deepseek"], from: "2026-10-02" }));
    expect(next.get("session")).toBe("s1");
    expect(next.get("view")).toBe("claims");
    expect(next.get("engines")).toBe("deepseek");
    expect(next.has("engine")).toBe(false);
    expect(next.has("selectionRef")).toBe(false);
    expect(next.has("errorOffset")).toBe(false);
  });
  it("sends the exact same scope to every measured view, with page filters isolated from aggregate filters", async () => {
    const scope = { from: "2026-10-01", to: "2026-10-02", engines: ["kimi"], clientTags: ["病程,长期"] };
    const query = geoReadScopeQuery(scope);
    for (const [read, path] of [
      [() => getGeoProject("g", scope), ""], [() => getGeoDiagnosis("g", scope), "/diagnosis"],
      [() => getGeoMonitoring("g", scope), "/monitoring"], [() => getGeoSources("g", scope), "/sources"],
      [() => getGeoClusters("g", scope), "/clusters"], [() => getGeoCluster("g", "q", scope), "/clusters/q"],
      [() => getGeoQuestions("g", scope), "/questions"],
    ] as const) {
      await read();
      expect(network.productRequest).toHaveBeenLastCalledWith(`/geo/projects/g${path}${query}`);
    }
    await getGeoSource("g", "domain", { selectionRef: "sel1" }, { answerOffset: 200, answerLimit: 50 });
    expect(network.productRequest).toHaveBeenLastCalledWith("/geo/projects/g/sources/domain?selectionRef=sel1&answerLimit=50&answerOffset=200");
    await getGeoDiagnosis("g", "round_old");
    expect(network.productRequest).toHaveBeenLastCalledWith("/geo/projects/g/diagnosis?round=round_old");
  });
});
