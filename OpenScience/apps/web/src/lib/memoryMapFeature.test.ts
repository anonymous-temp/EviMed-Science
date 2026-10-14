import { describe, expect, it } from "vitest";
import type { WebMe } from "./apiClient";
import { memoryMapOffered } from "./memoryMapFeature";

const me = (features?: unknown) => ({ features } as unknown as WebMe);

describe("whether this deployment draws the memory map", () => {
  it("is on only when /api/me says so, and a missing or odd answer is off", () => {
    expect(memoryMapOffered(me({ memoryMap: true }))).toBe(true);
    for (const answer of [undefined, null, {}, { memoryMap: false }, { memoryMap: "yes" }, { geo: true }, [true]]) {
      expect(memoryMapOffered(me(answer))).toBe(false);
    }
    expect(memoryMapOffered(null)).toBe(false);
  });
});
