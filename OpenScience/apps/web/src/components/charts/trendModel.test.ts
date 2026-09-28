import { describe, expect, it } from "vitest";
import { CHART_STROKES } from "@evimed/design-tokens";
import { decalOption } from "./echartsBase";
import { heatStep } from "./HeatGrid";
import { chartOption, ruleLabelPlaces } from "./TrendChart";
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

describe("a trend's labels and lines (E8)", () => {
  type Mark = { yAxis?: number; xAxis?: number; label: { position?: string; formatter?: string; distance?: number; show?: boolean }; lineStyle: { width: number } };
  type Series = { name?: string; lineStyle?: { width?: number }; markLine?: { data: Mark[] }; data?: Array<{ label?: unknown } | null | number> };
  const format = (value: number) => String(value);
  const drawn = (input: Parameters<typeof trendModel>[0]) => chartOption(trendModel(input), format) as unknown as { series: Series[] };

  it("labels a single reading by a reference line at the plot's right end, never on the point over the axis", () => {
    const model = trendModel({ labels: ["9/25"], own: { name: "信尔美", values: [44] }, target: 65, nextLabel: "10/2 复测" });
    expect(model.baseline).toEqual({ index: 0, value: 44 });
    const option = drawn({ labels: ["9/25"], own: { name: "信尔美", values: [44] }, target: 65, nextLabel: "10/2 复测" });
    const own = option.series.find((series) => series.name === "信尔美")!;
    const rules = own.markLine!.data;
    const baseline = rules.find((rule) => rule.label.formatter === "基线 44")!;
    expect(baseline.yAxis).toBe(44);
    expect(baseline.label.position).toMatch(/^insideEnd/);
    expect(baseline.label.distance).toBeGreaterThanOrEqual(8);
    // The point itself carries no label: it sits on the y axis.
    expect(own.data!.filter((point) => point && typeof point === "object" && point.label)).toHaveLength(0);
    // The target moves to the other end, so the two labels never meet.
    const target = rules.find((rule) => rule.label.formatter === "目标 65")!;
    expect(target.label.position).toMatch(/^insideStart/);
  });

  it("drops the baseline rule once there are two readings, and labels the latest", () => {
    const model = trendModel({ labels, own: { name: "信尔美", values: [44, 50, 61] }, target: 65 });
    expect(model.baseline).toBeNull();
    const own = drawn({ labels, own: { name: "信尔美", values: [44, 50, 61] }, target: 65 }).series.find((series) => series.name === "信尔美")!;
    expect(own.markLine!.data.some((rule) => String(rule.label.formatter).startsWith("基线"))).toBe(false);
    expect(own.data!.filter((point) => point && typeof point === "object" && point.label)).toHaveLength(1);
  });

  it("puts the target label at the right end, and at the left once rivals are named there", () => {
    expect(ruleLabelPlaces(trendModel({ labels, own: { name: "x", values: [1, 2, 3] }, target: 5 })).target).toBe("insideEndTop");
    expect(ruleLabelPlaces(trendModel({ labels, own: { name: "x", values: [1, 2, 3] }, target: 5, rivals: [{ name: "y", values: [2, 3, 4] }] })).target)
      .toBe("insideStartTop");
    // With both rules drawn, the lower writes under its line.
    expect(ruleLabelPlaces(trendModel({ labels: ["a"], own: { name: "x", values: [70] }, target: 65 }))).toEqual({ target: "insideStartBottom", baseline: "insideEndTop" });
  });

  it("draws with the token table's line weights", () => {
    const option = drawn({ labels, own: { name: "信尔美", values: [44, 50, 61] }, rivals: [{ name: "诺和盈", values: [70, 71, 72] }], target: 65 });
    expect(option.series.find((series) => series.name === "信尔美")!.lineStyle!.width).toBe(CHART_STROKES.own);
    expect(option.series.find((series) => series.name === "诺和盈")!.lineStyle!.width).toBe(CHART_STROKES.other);
    const target = option.series.find((series) => series.name === "信尔美")!.markLine!.data.find((rule) => rule.yAxis === 65)!;
    expect(target.lineStyle.width).toBe(1);
  });

  it("under patterns keeps ours solid with circles and gives each rival its own dash and marker (spec §32.13 rule 4)", () => {
    const option = chartOption(trendModel({
      labels,
      own: { name: "信尔美", values: [44, 50, 61] },
      rivals: [{ name: "诺和盈", values: [70, 71, 72] }, { name: "司美", values: [30, 32, 35] }],
      band: 3,
    }), format);
    type Drawn = Series & { symbol?: string; silent?: boolean; lineStyle?: { type?: unknown; width?: number; opacity?: number } };
    const series = (decalOption(option, true) as unknown as { series: Drawn[] }).series;
    const byName = (name: string) => series.find((entry) => entry.name === name)!;
    expect([byName("信尔美").lineStyle?.type, byName("信尔美").symbol]).toEqual(["solid", "circle"]);
    expect([byName("诺和盈").lineStyle?.type, byName("诺和盈").symbol]).toEqual(["dashed", "rect"]);
    expect([byName("司美").lineStyle?.type, byName("司美").symbol]).toEqual(["dotted", "triangle"]);
    // The band's two helper lines draw no stroke and take no pattern.
    expect(series.filter((entry) => entry.silent).every((entry) => entry.lineStyle?.type === undefined && entry.symbol === "none")).toBe(true);
    // The weights are still the token table's.
    expect(byName("信尔美").lineStyle?.width).toBe(CHART_STROKES.own);
  });

  it("steps a count's axis by whole numbers, and leaves every other axis to the library", () => {
    const model = trendModel({ labels, own: { name: "记忆", values: [0, 1, 2] } });
    const axis = (option: unknown) => (option as { yAxis: { minInterval?: number } }).yAxis;
    expect(axis(chartOption(model, format, { integer: true })).minInterval).toBe(1);
    expect(axis(chartOption(model, format)).minInterval).toBeUndefined();
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
