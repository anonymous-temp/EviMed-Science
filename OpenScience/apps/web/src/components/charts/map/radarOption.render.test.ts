// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SVGRenderer } from "echarts/renderers";
import type { MapDimension } from "@/lib/memoryMapClient";
import { echarts } from "../echartsBase";
import "./register";
import { TEST_PALETTE } from "./palette";
import { dimensionBarOption } from "./radarOption";

function tickLabels(scale: MapDimension["scale"]): string[] {
  echarts.use([SVGRenderer]);
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 390, height: 330 });
  try {
    chart.setOption(dimensionBarOption({
      id: "memory", title: "Recorded aspects", previous: "Previous", scale, total: 1, previousTotal: 0,
      axes: [{ id: "project", label: "Project facts", value: scale === "share" ? 0.5 : 1, previousValue: 0, count: 1 }],
    }, TEST_PALETTE));
    // Numeric x-axis labels are centred; category and end-of-bar labels are not.
    return [...chart.renderToSVGString().matchAll(/<text\b[^>]*text-anchor="middle"[^>]*>([\d.%]+)<\/text>/gu)]
      .map((match) => match[1]!);
  } finally {
    chart.dispose();
  }
}

describe("rendered sparse dimension scales", () => {
  it("does not round fractional count ticks into repeated zeroes and ones for a single memory", () => {
    expect(tickLabels("count")).toEqual(["0", "1"]);
  });

  it("retains intermediate percentage ticks for a proportional dimension", () => {
    const labels = tickLabels("share");
    expect(labels).toContain("0%");
    expect(labels).toContain("100%");
    expect(labels.some((label) => Number.parseFloat(label) > 0 && Number.parseFloat(label) < 100)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
