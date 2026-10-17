import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollBlockToTop } from "./geoScroll";

/** A page ground with a block in it, the geometry stated: jsdom lays nothing out. */
function page({ groundTop, blockTop, scrollTop, padding }: { groundTop: number; blockTop: number; scrollTop: number; padding: string }) {
  const ground = document.createElement("div");
  ground.className = "overflow-y-auto";
  ground.style.scrollPaddingTop = padding;
  ground.scrollTop = scrollTop;
  const block = document.createElement("section");
  ground.append(block);
  document.body.append(ground);
  vi.spyOn(ground, "getBoundingClientRect").mockReturnValue({ top: groundTop } as DOMRect);
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue({ top: blockTop } as DOMRect);
  const scrollTo = vi.fn();
  ground.scrollTo = scrollTo as unknown as typeof ground.scrollTo;
  const intoView = vi.spyOn(block, "scrollIntoView").mockImplementation(() => {});
  return { ground, block, scrollTo, intoView };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("scrolling to a block of a GEO tab", () => {
  it("moves the page's ground so the block stops below the band, and nothing else", () => {
    // The block is 1,000 px into the content (it sits at 700 on the screen with the ground scrolled by 300); the band is 124 px,
    // and 12 px are left between it and the block.
    const { block, scrollTo, intoView } = page({ groundTop: 0, blockTop: 700, scrollTop: 300, padding: "124px" });
    scrollBlockToTop(block);
    expect(scrollTo).toHaveBeenCalledWith({ top: 864 });
    // `scrollIntoView` also scrolls the shell's clipped root: it is what carried the sidebar and the band off the screen.
    expect(intoView).not.toHaveBeenCalled();
  });

  it("measures from the ground's own top, not the screen's", () => {
    const { block, scrollTo } = page({ groundTop: 48, blockTop: 400, scrollTop: 0, padding: "124px" });
    scrollBlockToTop(block);
    expect(scrollTo).toHaveBeenCalledWith({ top: 216 });
  });

  it("never scrolls above the top, and takes no band as none", () => {
    const { block, scrollTo } = page({ groundTop: 0, blockTop: 60, scrollTop: 0, padding: "auto" });
    scrollBlockToTop(block);
    expect(scrollTo).toHaveBeenCalledWith({ top: 48 });
    const { block: near, scrollTo: nearTo } = page({ groundTop: 0, blockTop: 40, scrollTop: 0, padding: "124px" });
    scrollBlockToTop(near);
    expect(nearTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("falls back to the browser's own scroll where the block is in no page ground", () => {
    const block = document.createElement("section");
    document.body.append(block);
    const intoView = vi.spyOn(block, "scrollIntoView").mockImplementation(() => {});
    scrollBlockToTop(block);
    expect(intoView).toHaveBeenCalledWith({ block: "start" });
  });
});
