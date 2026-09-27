import { describe, expect, it } from "vitest";
import { embedRequested, isEmbeddedShell } from "./embed";

const page = (search: string, extra: Record<string, unknown> = {}) =>
  ({ location: { search }, ...extra }) as unknown as Window;

describe("isEmbeddedShell", () => {
  it("reads embed=1 from the router's address, then from the page's own", () => {
    expect(isEmbeddedShell("?embed=1", page(""))).toBe(true);
    expect(isEmbeddedShell("", page("?embed=1"))).toBe(true);
    expect(isEmbeddedShell("?tab=all", page(""))).toBe(false);
  });

  it("lets embed=0 win over the sub-application container's flag", () => {
    expect(isEmbeddedShell("?embed=0", page("", { __POWERED_BY_WUJIE__: true }))).toBe(false);
    expect(isEmbeddedShell("", page("", { __POWERED_BY_WUJIE__: true }))).toBe(true);
  });

  it("parses only the values that ask for it", () => {
    expect(embedRequested("?embed=true")).toBe(true);
    expect(embedRequested("?embed=yes")).toBe(false);
    expect(embedRequested("?other=1")).toBeNull();
  });
});
