import { afterEach, expect, it, vi } from "vitest";
import { scrollBlockToTop } from "./vcrScroll";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function page(padding = "40px") {
  const ground = document.createElement("div");
  ground.className = "overflow-y-auto";
  ground.style.scrollPaddingTop = padding;
  const block = document.createElement("section");
  ground.append(block);
  document.body.append(ground);
  vi.spyOn(ground, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue({ top: 700 } as DOMRect);
  ground.scrollTop = 0;
  return { ground, block };
}

// The jump must move the page's own ground and nothing else: a scroll of the app shell took the sidebar and the band off the screen.
it("moves the page's own ground to the block, below the band and its room, and never calls the browser's scrollIntoView", () => {
  const { ground, block } = page();
  const scrollTo = vi.fn(); ground.scrollTo = scrollTo as unknown as typeof ground.scrollTo;
  const intoView = vi.fn(); block.scrollIntoView = intoView;
  scrollBlockToTop(block);
  expect(scrollTo).toHaveBeenCalledWith({ top: 600 - 40 - 12 });
  expect(intoView).not.toHaveBeenCalled();
});

it("does not scroll above the top of the page", () => {
  const { ground, block } = page("80px");
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue({ top: 120 } as DOMRect);
  const scrollTo = vi.fn(); ground.scrollTo = scrollTo as unknown as typeof ground.scrollTo;
  scrollBlockToTop(block);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
});

it("falls back to the browser's own scroll for a block that is in no page, and does nothing for no block", () => {
  const block = document.createElement("section"); document.body.append(block);
  const intoView = vi.fn(); block.scrollIntoView = intoView;
  scrollBlockToTop(block);
  expect(intoView).toHaveBeenCalledWith({ block: "start" });
  expect(() => scrollBlockToTop(null)).not.toThrow();
});
