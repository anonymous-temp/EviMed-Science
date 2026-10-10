import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeViewer } from "./CodeViewer";

describe("CodeViewer", () => {
  it("is not a stop in the tab order while the code fits", () => {
    render(<CodeViewer code={"x = 1"} language="python" />);
    expect(screen.queryByRole("region", { name: "代码" })).not.toBeInTheDocument();
  });

  it("scrolls in a labelled region a keyboard reaches when a line is wider than its box", () => {
    overflowing(() => {
      render(<CodeViewer code={"x = 1"} language="python" />);
      const region = screen.getByRole("region", { name: "代码" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(region).toHaveTextContent("x = 1");
    });
  });
});

/** A box narrower than its content; jsdom lays nothing out by itself. */
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
