import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { VcrAttritionChart } from "./VcrDiagrams";

it("states the sequential denominator and does not count excluded unknowns as kept", () => {
  render(<VcrAttritionChart steps={[{ key: "first", label: "年龄", denominator: 80, grain: "subject", remaining: 52, removed: 21, unknown: 7, indeterminateTreatment: "exclude" }]} />);
  expect(screen.getByText("本步分母 80 人；无法判断 7，未计入保留")).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", "年龄：本步分母 80，保留 52，无法判断 7");
});

it("labels included unknowns as part of the remaining count", () => {
  render(<VcrAttritionChart steps={[{ key: "first", label: "年龄", denominator: 80, grain: "subject", remaining: 59, removed: 21, unknown: 7, indeterminateTreatment: "include" }]} />);
  expect(screen.getByText("本步分母 80 人；无法判断 7，计入保留")).toBeInTheDocument();
  expect(screen.getByRole("img")).toHaveAttribute("aria-label", "年龄：本步分母 80，保留 59，无法判断 7");
});
