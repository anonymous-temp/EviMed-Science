import { describe, expect, it } from "vitest";
import { geoPathWithContext } from "./useGeoPath";
describe("GEO record navigation keeps the selected observations", () => {
  const from = { pathname: "/app/geo/g/sources", search: "?from=2026-10-01&engines=kimi&engines=deepseek&clientTags=病程,长期&session=s1&source=site" };
  it("carries repeated scope and session fields without leaving an unrelated drawer open", () => {
    const next = new URL(geoPathWithContext("/app/geo/g/answers/snap", from), "https://example.test");
    expect(next.searchParams.getAll("engines")).toEqual(["deepseek", "kimi"]);
    expect(next.searchParams.get("from")).toBe("2026-10-01");
    expect(next.searchParams.getAll("clientTags")).toEqual(["病程,长期"]);
    expect(next.searchParams.get("session")).toBe("s1");
    expect(next.searchParams.has("source")).toBe(false);
  });
  it("lets a destination narrow a dimension and never carries one product's scope into another", () => {
    const next = new URL(geoPathWithContext("/app/geo/g/questions?engine=doubao#detail", from), "https://example.test");
    expect(next.searchParams.get("engine")).toBe("doubao"); expect(next.searchParams.has("engines")).toBe(false);
    expect(next.hash).toBe("#detail");
    expect(geoPathWithContext("/app/geo/other", from)).toBe("/app/geo/other");
  });
});
