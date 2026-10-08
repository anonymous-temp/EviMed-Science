import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sparkline } from "./Sparkline";

const points = (values: Array<number | null>) => values.map((heat, index) => ({ at: `2026-10-0${index + 1}T00:00:00Z`, heat }));

describe("the trend line", () => {
  it("draws a gap as two segments, with no stroke across it", () => {
    const { container } = render(<Sparkline points={points([10, 20, null, 30, 40])} />);
    const path = container.querySelector("svg[data-sparkline] path");
    expect(path?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(path?.getAttribute("d")).toBe("M2 26 L25 18 M71 10 L94 2");
    expect(container.querySelectorAll("svg[data-sparkline] circle")).toHaveLength(1);
  });

  it("marks a reading that stands alone between gaps with a dot and strokes nothing for it", () => {
    const { container } = render(<Sparkline points={points([10, null, 30])} />);
    expect(container.querySelector("svg[data-sparkline] path")).toBeNull();
    // Both readings are marked: the lone first one as a dot, the last as the hollow ring.
    expect(container.querySelectorAll("svg[data-sparkline] circle")).toHaveLength(3);
  });

  it("says 暂无走势 below two readings, however many points are missing", () => {
    render(<Sparkline points={points([null, 12, null, null])} />);
    expect(screen.getByText("暂无走势")).toBeInTheDocument();
  });
});
