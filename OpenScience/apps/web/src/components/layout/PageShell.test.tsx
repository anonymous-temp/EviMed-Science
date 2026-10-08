import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageShell, type PageWidth } from "./PageShell";

/**
 * A page's one container: the gutter and the column are classes the stylesheet answers to, so those are what a unit test can see.
 * (jsdom resolves no media query; the 358 px body at 390 px is measured in a browser against the gallery build.)
 */
function column(width?: PageWidth) {
  const { container } = render(<PageShell title="记忆" width={width}><p>内容</p></PageShell>);
  const heading = screen.getByRole("heading", { level: 1, name: "记忆" });
  return { box: container.querySelector(".mx-auto") as HTMLElement, heading, container };
}

describe("PageShell", () => {
  it("keeps a 16 px gutter on a phone and 24 px from 768 up, on one box that holds the title and the body", () => {
    const { box, heading } = column();
    expect(box).toHaveClass("px-4", "md:px-6");
    expect(box).not.toHaveClass("px-6");
    // One left edge: the header and the body are in the same box.
    expect(box).toContainElement(heading);
    expect(box).toContainElement(screen.getByText("内容"));
  });

  it.each([
    ["read", "max-w-read"],
    ["page", "max-w-page"],
    ["wide", "max-w-wide"],
    ["full", "max-w-none"],
  ] as const)("the %s column is %s", (width, expected) => {
    expect(column(width).box).toHaveClass(expected);
  });

  it("is the list column unless it is told otherwise", () => {
    expect(column().box).toHaveClass("max-w-page");
  });
});
