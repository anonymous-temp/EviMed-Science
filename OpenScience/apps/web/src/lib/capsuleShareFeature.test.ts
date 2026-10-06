import { describe, expect, it } from "vitest";
import type { WebMe } from "./apiClient";
import { capsuleShareOffered } from "./capsuleShareFeature";

const me = (features?: unknown) => ({ features } as unknown as WebMe);

describe("whether this deployment shares capsules between accounts", () => {
  it("is on only when /api/me says so, and a missing or odd answer is off", () => {
    expect(capsuleShareOffered(me({ capsuleShare: true }))).toBe(true);
    for (const answer of [undefined, null, {}, { capsuleShare: false }, { capsuleShare: "yes" }, { frontier: true }, [true]]) {
      expect(capsuleShareOffered(me(answer))).toBe(false);
    }
    expect(capsuleShareOffered(null)).toBe(false);
  });
});
