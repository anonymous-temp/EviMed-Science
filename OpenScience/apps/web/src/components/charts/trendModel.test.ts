import { describe, expect, it } from "vitest";
import { heatStep } from "./HeatGrid";
import { MAX_RIVALS, OWN_COLOR, RIVAL_COLORS, rivalColor, trendModel } from "./trendModel";

const labels = ["9/25", "10/2", "10/9"];

describe("a trend's model", () => {
  it("draws a baseline rather than calling one measurement empty", () => {
    const model = trendModel({ labels: ["9/25"], own: { name: "信尔美", values: [44] }, target: 65, nextLabel: "10/2 复测" });
    expect(model.mode).toBe("baseline");
    expect(model.readings).toBe(1);
    expect(model.baselineIndex).toBe(0);
    // The next measurement is a slot of its own, so the chart reads as a plan.
    expect(model.labels).toEqual(["9/25", "10/2 复测"]);
    expect(model.nextIndex).toBe(1);
    expect(model.target).toBe(65);
  });

  it("is empty only when nothing was measured at all", () => {
    expect(trendModel({ labels, own: { name: "信尔美", values: [null, null, null] } }).mode).toBe("empty");
    expect(trendModel({ labels, own: { name: "信尔美", values: [44, null, 61] } }).mode).toBe("series");
  });

  it("never draws a rival in the brand colour", () => {
    const model = trendModel({
      labels,
      own: { name: "信尔美", values: [44, 50, 61] },
      rivals: [
        { name: "诺和盈", values: [70, 71, 72] },
        { name: "穆峰达", values: [64, 65, 65] },
        { name: "诺和力", values: [40, 41, 42] },
        { name: "谊生泰", values: [20, 21, 22] },
      ],
    });
    expect(model.own.color).toBe(OWN_COLOR);
    expect(model.rivals).toHaveLength(MAX_RIVALS);
    for (const rival of model.rivals) {
      expect(rival.color).not.toBe(OWN_COLOR);
      expect(RIVAL_COLORS).toContain(rival.color);
    }
    // Darkest for the highest rank, in the order they were handed over.
    expect(model.rivals.map((rival) => rival.color)).toEqual([...RIVAL_COLORS]);
    expect(rivalColor(9)).toBe(RIVAL_COLORS[RIVAL_COLORS.length - 1]);
  });

  it("leaves out a rival with nothing measured rather than drawing it at zero", () => {
    const model = trendModel({
      labels,
      own: { name: "信尔美", values: [44, 50, 61] },
      rivals: [{ name: "诺和盈", values: [null, null, null] }, { name: "穆峰达", values: [64, 65, 65] }],
    });
    expect(model.rivals.map((rival) => rival.name)).toEqual(["穆峰达"]);
  });

  it("keeps a marker only where it lands on a reading", () => {
    const model = trendModel({
      labels,
      own: { name: "信尔美", values: [44, 50, 61] },
      markers: [{ index: 1, label: "首批稿件上线" }, { index: 9, label: "越界" }, { index: 0, label: "" }],
    });
    expect(model.markers).toEqual([{ index: 1, label: "首批稿件上线" }]);
  });

  it("ignores a noise band that is not a band", () => {
    expect(trendModel({ labels, own: { name: "x", values: [1, 2, 3] }, band: 0 }).band).toBeNull();
    expect(trendModel({ labels, own: { name: "x", values: [1, 2, 3] }, band: 3 }).band).toBe(3);
  });
});

describe("a heat grid's steps", () => {
  it("spreads the grid's own range over one hue", () => {
    expect(heatStep(0, 0, 50)).toBe(0);
    expect(heatStep(50, 0, 50)).toBe(5);
    expect(heatStep(25, 0, 50)).toBe(3);
  });

  it("does not colour a flat grid by accident", () => {
    expect(heatStep(7, 7, 7)).toBe(0);
  });
});
