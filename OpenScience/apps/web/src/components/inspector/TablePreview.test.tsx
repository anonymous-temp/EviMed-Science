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

  it("scrolls in a labelled region a keyboard reaches when it is wider than its box", () => {
    overflowing(() => {
      render(<TablePreview table={table(3, false)} />);
      const region = screen.getByRole("region", { name: "表格预览" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(region).toContainElement(screen.getByRole("table"));
    });
  });
});

/** A box narrower than its content, as a wide table is in a phone's column; jsdom lays nothing out by itself. */
function overflowing(run: () => void): void {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
  try {
    run();
  } finally {
    if (scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  }
}
