import { describe, expect, it } from "vitest";
import type { MapDimension } from "@/lib/memoryMapClient";
import { TEST_PALETTE } from "./palette";
import { RADAR_MIN_AXES, radarMax, radarOption, radarState, radarValue } from "./radarOption";

const axis = (id: string, value: number, previousValue: number, count = value) => ({ id, label: id, value, previousValue, count });
const memory = (axes: ReturnType<typeof axis>[]): MapDimension => ({ id: "memory", title: "各方面记了多少", previous: "30 天前", scale: "count", total: axes.reduce((sum, entry) => sum + entry.count, 0), previousTotal: 5, axes });
const work = (axes: ReturnType<typeof axis>[], total: number): MapDimension => ({ id: "work", title: "在做什么", previous: "前 30 天", scale: "share", total, previousTotal: 8, axes });

describe("when a radar is drawn", () => {
  it("needs enough counted and enough axes with something on them", () => {
    expect(radarState(memory([axis("a", 3, 2), axis("b", 2, 2), axis("c", 1, 0)])).drawable).toBe(true);
    expect(radarState(memory([axis("a", 3, 2), axis("b", 2, 2)])).drawable).toBe(false);
    expect(radarState(memory([axis("a", 1, 0), axis("b", 1, 1), axis("c", 1, 0)])).sentence).toContain("再多聊几次");
    expect(RADAR_MIN_AXES).toBe(3);
  });
  it("says why a needle is not drawn, in the page's words", () => {
    const needle = work([axis("普通问答", 0.9, 0.9, 9), axis("写作与传播", 0.1, 0.1, 1), axis("研究设计与数据", 0, 0, 0)], 10);
    expect(radarState(needle)).toEqual({ drawable: false, sentence: "最近 30 天的对话大多是同一类事，画出来只是一根针，这里先不画图。" });
    expect(radarState(work([axis("a", 1, 0, 1)], 2)).sentence).toBe("最近 30 天的对话还不多，这里先不画图。");
  });
});

describe("the polygon", () => {
  const dimension = memory([axis("背景", 4, 2), axis("偏好", 12, 9), axis("习惯", 3, 3), axis("纠正", 1, 0)]);
  it("keeps both periods on one scale, so a changed shape is a changed account", () => {
    expect(radarMax(dimension)).toBe(14);
    const option: any = radarOption(dimension, TEST_PALETTE);
    expect(option.radar.indicator.map((entry: any) => entry.max)).toEqual([14, 14, 14, 14]);
    expect(option.radar.triggerEvent).toBe(true);
  });
  it("prints the number at every vertex of the current polygon and none on the ghost", () => {
    const option: any = radarOption(dimension, TEST_PALETTE);
    const [ghost, now] = option.series[0].data;
    expect(ghost.value).toEqual([2, 9, 3, 0]);
    expect(ghost.label.show).toBe(false);
    expect(ghost.lineStyle.type).toBe("dashed");
    expect(now.value).toEqual([4, 12, 3, 1]);
    expect(now.label.show).toBe(true);
    expect(now.label.formatter({ value: 12 })).toBe("12");
  });
  it("prints a share as a percent, and scales it to the larger period", () => {
    const shares = work([axis("普通问答", 0.5, 0.25), axis("写作与传播", 0.3, 0.5), axis("研究设计与数据", 0.2, 0.25)], 10);
    expect(radarValue("share", 0.3333)).toBe("33%");
    expect(radarMax(shares)).toBe(0.6);
    expect((radarOption(shares, TEST_PALETTE) as any).series[0].data[1].label.formatter({ value: 0.5 })).toBe("50%");
  });
  it("escapes the axis names in the tooltip", () => {
    const hostile = memory([{ ...axis("<script>", 3, 1), label: "<script>alert(1)</script>" }, axis("b", 2, 1), axis("c", 2, 1)]);
    const html = (radarOption(hostile, TEST_PALETTE) as any).tooltip.formatter();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("uses only the three hues", () => {
    const used = JSON.stringify(radarOption(dimension, TEST_PALETTE)).match(/#[a-z0-9]+/gu) ?? [];
    expect(new Set(used)).toEqual(new Set(["#grid", "#text", "#grey", "#blue"]));
  });
});
