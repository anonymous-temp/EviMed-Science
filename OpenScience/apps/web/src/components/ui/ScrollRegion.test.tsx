import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollRegion } from "./ScrollRegion";

/** jsdom has no layout: the box's measures are said by the test. */
function measures(box: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  const define = (name: string, value: number) => Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  define("scrollWidth", box.scrollWidth);
  define("clientWidth", box.clientWidth);
  define("scrollLeft", box.scrollLeft ?? 0);
}

afterEach(() => {
  for (const name of ["scrollWidth", "clientWidth", "scrollLeft"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  vi.restoreAllMocks();
});

describe("ScrollRegion", () => {
  it("is a plain box while its content fits: no region, no tab stop, no cue", () => {
    measures({ scrollWidth: 300, clientWidth: 300 });
    const { container } = render(<ScrollRegion label="表"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("[data-scroll-cue]")).toBeNull();
  });

  it("is a labelled region that takes focus while it overflows, and a fade at the right edge says there is more", () => {
    measures({ scrollWidth: 576, clientWidth: 320 });
    const { container } = render(<ScrollRegion label="各引擎的读数"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    const region = screen.getByRole("region", { name: "各引擎的读数" });
    expect(region).toHaveAttribute("tabindex", "0");
    const cue = container.querySelector("[data-scroll-cue]") as HTMLElement;
    expect(cue).not.toBeNull();
    // The fade is out of the way of everything: not a tab stop, not announced, not hit by the pointer.
    expect(cue).toHaveAttribute("aria-hidden", "true");
    expect(cue.className).toContain("pointer-events-none");
    expect(region.contains(cue)).toBe(false);
  });

  it("takes the fade away once the box has been scrolled to its end", () => {
    measures({ scrollWidth: 576, clientWidth: 320 });
    const { container } = render(<ScrollRegion label="表"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    expect(container.querySelector("[data-scroll-cue]")).not.toBeNull();
    measures({ scrollWidth: 576, clientWidth: 320, scrollLeft: 256 });
    act(() => { screen.getByRole("region").dispatchEvent(new Event("scroll")); });
    expect(container.querySelector("[data-scroll-cue]")).toBeNull();
  });

  it("keeps the caller's classes on the scroller itself, whose border and corner it draws", () => {
    measures({ scrollWidth: 400, clientWidth: 200 });
    render(<ScrollRegion label="预览" className="rounded-input border border-border"><p>x</p></ScrollRegion>);
    expect(screen.getByRole("region")).toHaveClass("overflow-x-auto", "rounded-input", "border");
  });
});
