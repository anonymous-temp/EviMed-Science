import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TablePreview } from "./TablePreview";

const table = (rows: number, truncated: boolean) => ({
  columns: ["样本", "值"],
  rows: Array.from({ length: rows }, (_, index) => [`s${index}`, String(index)]),
  truncated,
});

describe("TablePreview", () => {
  it("says in Chinese how many rows a cut-off table shows, the number grouped as the rest of the product groups it", () => {
    render(<TablePreview table={table(1200, true)} />);
    expect(screen.getByText("只显示前 1,200 行")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Showing|rows/);
  });

  it("says nothing about rows for a table that fits", () => {
    render(<TablePreview table={table(3, false)} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByText(/只显示前/)).not.toBeInTheDocument();
  });
});
