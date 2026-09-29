import { describe, expect, it } from "vitest";
import { bandPath, linePath, niceStep, posX, posY, scaleOf, share, stepPath } from "./vcrScale";

describe("a scale over values", () => {
  it("rounds its ends outwards and steps on 1, 2 or 5", () => {
    const scale = scaleOf([3.0, 4.1, 5.6]);
    expect(scale).not.toBeNull();
    expect(scale!.low).toBeLessThanOrEqual(3);
    expect(scale!.high).toBeGreaterThanOrEqual(5.6);
    expect(scale!.ticks[0]).toBe(scale!.low);
    expect(scale!.ticks.at(-1)).toBe(scale!.high);
  });

  it("covers a domain the data do not reach, so a curve is not drawn against its own minimum", () => {
    const scale = scaleOf([0.42, 0.4, 0.2], [0, 1]);
    expect(scale!.low).toBeLessThanOrEqual(0);
    expect(scale!.high).toBeGreaterThanOrEqual(1);
  });

  it("is nothing at all when nothing is finite, rather than a scale over zero", () => {
    expect(scaleOf([null, undefined, Number.NaN])).toBeNull();
  });

  it("opens a range around a single value rather than collapsing", () => {
    const scale = scaleOf([5, 5]);
    expect(scale!.high).toBeGreaterThan(scale!.low);
  });

  it("steps on 1, 2 or 5 times a power of ten", () => {
    for (const span of [0.3, 3, 7, 30, 900]) {
      const step = niceStep(span);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5, 10]).toContain(Math.round(mantissa));
    }
  });
});

describe("placing a value in the box", () => {
  const scale = scaleOf([0, 100], [0, 100])!;

  it("puts the low end at the left and the top at the high value", () => {
    expect(posX(scale.low, scale)).toBe(0);
    expect(posX(scale.high, scale)).toBe(100);
    // SVG's y grows downwards, so the high value is at the top.
    expect(posY(scale.high, scale)).toBe(0);
    expect(posY(scale.low, scale)).toBe(100);
  });
});

describe("a series' path", () => {
  const x = scaleOf([0, 10], [0, 10])!;
  const y = scaleOf([0, 10], [0, 10])!;

  it("breaks at a missing reading rather than joining across it", () => {
    const path = linePath([{ x: 0, y: 0 }, { x: 5, y: null }, { x: 10, y: 10 }], x, y);
    // Two moves: the gap is a fact about the data, not a guess to draw over.
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("draws a survival estimate as steps, not as a smooth line", () => {
    const path = stepPath([{ x: 0, y: 10 }, { x: 5, y: 5 }], x, y);
    // A horizontal run to the event time, then the drop at it.
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it("closes a band between its two edges, and draws none from one point", () => {
    const band = bandPath([{ x: 0, y: null, low: 1, high: 9 }, { x: 10, y: null, low: 2, high: 8 }], x, y);
    expect(band.endsWith("Z")).toBe(true);
    expect(bandPath([{ x: 0, y: null, low: 1, high: 9 }], x, y)).toBe("");
  });
});

describe("a share of a whole", () => {
  it("is zero when the whole is zero, rather than a division by it", () => {
    expect(share(3, 0)).toBe(0);
    expect(share(null, 10)).toBe(0);
  });

  it("never leaves the bar", () => {
    expect(share(20, 10)).toBe(100);
    expect(share(-5, 10)).toBe(0);
  });
});
