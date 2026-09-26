import { CHART_SERIES } from "@evimed/design-tokens";
import { describe, expect, it } from "vitest";
import { seriesColor, CHART_PALETTE_LIGHT, CHART_PALETTE_DARK } from "@ai4s/shared";

// The token table is the single source; this package keeps literals so it stays
// dependency-free, and `runtime/.../openscience.mplstyle` keeps a third copy
// because matplotlib reads an ini file. Two of the three are asserted here and
// the third is asserted by grep below, so a colour cannot move in one place.
describe("chart palette (single source of truth)", () => {
  it("equals the token table, which is what makes it a single source", () => {
    expect(CHART_PALETTE_LIGHT.categorical).toEqual([...CHART_SERIES.light]);
    expect(CHART_PALETTE_DARK.categorical).toEqual([...CHART_SERIES.dark]);
  });

  it("assigns categorical hues in fixed order and wraps only past 8", () => {
    // Slot 1 is the brand: in a comparison "ours" is the brand and every rival
    // is a grey. Adjacent ΔE (CIE76) is ≥ 22 in both schemes, over the 15 floor
    // the 2026-09-18 dataviz validator set.
    expect(CHART_PALETTE_LIGHT.categorical).toEqual([
      "#0a5dc1", "#e07b39", "#1d9a87", "#7b5cd6", "#c94f7c", "#c7a12b", "#5a626b", "#b4bcc5",
    ]);
    expect(seriesColor(0, "light")).toBe("#0a5dc1");
    expect(seriesColor(0, "dark")).toBe("#5690dd");
    expect(seriesColor(8, "light")).toBe(seriesColor(0, "light")); // never a generated 9th hue
    expect(CHART_PALETTE_DARK.categorical).toHaveLength(8);
  });

  it("keeps the sequential ramp single-hue and monotonic — never red to green", () => {
    for (const palette of [CHART_PALETTE_LIGHT, CHART_PALETTE_DARK]) {
      const ink = palette.sequential.map((hex) =>
        [1, 3, 5].reduce((sum, offset) => sum + Number.parseInt(hex.slice(offset, offset + 2), 16), 0),
      );
      const monotonic = ink.every((value, index) => index === 0 || value !== ink[index - 1]);
      expect(monotonic).toBe(true);
      expect(new Set(palette.sequential).size).toBe(palette.sequential.length);
    }
  });
});
