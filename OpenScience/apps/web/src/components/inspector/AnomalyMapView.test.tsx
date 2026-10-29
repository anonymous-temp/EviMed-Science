import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnomalyMapView } from "./AnomalyMapView";

const CSV = [
  "lat,lon,anomaly",
  "-45,-90,-2.0",
  "-45,90,1.0",
  "45,-90,0.5",
  "45,90,2.5",
].join("\n");

describe("AnomalyMapView", () => {
  it("renders the map with grid dims, unit, a canvas, and graticule labels", () => {
    const { container } = render(<AnomalyMapView filename="temp.anom" text={CSV} />);
    expect(container.textContent).toContain("temp.anom");
    expect(container.textContent).toContain("2×2 网格");
    expect(container.textContent).toContain("anomaly");
    expect(container.querySelector("canvas")).not.toBeNull();
    // graticule labels use hemisphere suffixes
    expect(container.textContent).toMatch(/°[NSEW]|0°/);
  });

  it("shows a friendly error for a non-grid file", () => {
    render(<AnomalyMapView filename="bad.anom" text="hello\nworld" />);
    expect(screen.getByText(/无法读取此异常网格/)).toBeInTheDocument();
  });
});

it("exposes latitude and longitude selection without hovering", () => {
  render(<AnomalyMapView filename="temp.anom" text={CSV} />);
  expect(screen.getByRole("combobox", { name: "网格纬度" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "网格经度" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "读取网格" }));
  expect(screen.getByRole("status")).toHaveTextContent("45°S, 90°W");
  fireEvent.keyDown(screen.getByRole("region", { name: "异常网格视图" }), { key: "ArrowRight" });
  expect(screen.getByRole("status")).toHaveTextContent("45°S, 90°E");
});

it("keeps explicit keyboard selection through passive pointer motion, and Escape restores hover", () => {
  render(<AnomalyMapView filename="temp.anom" text={CSV} />);
  const view = screen.getByRole("region", { name: "异常网格视图" });
  Object.defineProperty(view, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
  fireEvent.keyDown(view, { key: "ArrowRight" });
  fireEvent(view, new MouseEvent("pointermove", { bubbles: true, clientX: 0, clientY: 100 }));
  expect(screen.getByRole("status")).toHaveTextContent("45°S, 90°E");
  fireEvent.keyDown(view, { key: "Escape" });
  fireEvent(view, new MouseEvent("pointermove", { bubbles: true, clientX: 0, clientY: 100 }));
  expect(screen.getByRole("status")).toHaveTextContent("45°S, 90°W");
});
