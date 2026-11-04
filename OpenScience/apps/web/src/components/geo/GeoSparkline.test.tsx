import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { GeoSparkline } from "./GeoSparkline";
it("keeps unknown-scope history as visible points without implying a comparable trend", () => {
  const { container, rerender } = render(<GeoSparkline values={[30, 35]} connectLines={false} />);
  expect(container.querySelectorAll("circle")).toHaveLength(2);
  expect(container.querySelector("path")).toBeNull();
  rerender(<GeoSparkline values={[30, 35]} connectLines />);
  expect(container.querySelector("path")).not.toBeNull();
});
