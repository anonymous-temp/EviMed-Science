import { describe, expect, it } from "vitest";
import { readFrontierPosition } from "./frontierReadingState";

describe("frontier reading position", () => {
  it("rejects invalid or unbounded replay metadata", () => {
    for (const value of [null, {}, { query: "", pages: 10001, scroll: 0 }, { query: "", pages: 1.2, scroll: 0 }, { query: "", pages: 2, scroll: Infinity }, { query: "", pages: 2, scroll: -1 }]) {
      expect(readFrontierPosition(value)).toBeUndefined();
    }
  });
  it("caps a long reading history without discarding its scroll or expansion", () => {
    expect(readFrontierPosition({ query: "view=all", pages: 21, scroll: 50, expanded: ["one"] })).toEqual({ query: "view=all", pages: 20, scroll: 50, expanded: ["one"] });
  });
  it("preserves only bounded navigation metadata and deduplicates expanded identifiers", () => {
    expect(readFrontierPosition({ query: "view=all", pages: 2, scroll: 50, expanded: ["one", "one", 7, ""], items: [{ private: "data" }] })).toEqual({
      query: "view=all", pages: 2, scroll: 50, expanded: ["one"],
    });
  });
});
