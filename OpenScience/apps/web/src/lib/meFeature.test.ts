import { describe, expect, it } from "vitest";
import type { WebMe } from "./apiClient";
import { featureOffered } from "./meFeature";

const me = (features: unknown) => ({ features } as unknown as WebMe);

describe("featureOffered", () => {
  it("is yes only for a true under the module's own name", () => {
    expect(featureOffered(me({ zoneSubscription: true }), "zoneSubscription")).toBe(true);
    expect(featureOffered(me({ zoneSubscription: true }), "evidenceCommunity")).toBe(false);
    for (const answer of [undefined, null, [], "yes", { zoneSubscription: "true" }, { zoneSubscription: 1 }]) {
      expect(featureOffered(me(answer), "zoneSubscription")).toBe(false);
    }
    expect(featureOffered(null, "zoneSubscription")).toBe(false);
  });
});
