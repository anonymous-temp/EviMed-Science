import { vi } from "vitest";

// jsdom has no layout boxes. This bypass is test-only; CSS display/geometry
// visibility must be verified separately in Chromium, not inferred from it.
vi.mock("tabbable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tabbable")>();
  return { ...actual, tabbable: (node: Parameters<typeof actual.tabbable>[0], options?: Parameters<typeof actual.tabbable>[1]) => actual.tabbable(node, { ...options, displayCheck: "none" }) };
});

import "@testing-library/jest-dom/vitest";

// DOM stubs — only in a browser-like (jsdom) environment. The node-env tests
// (e.g. the runtime-client integration test) skip these.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom has no 2D context and shouts about it through the virtual console
  // on every chart render. A quiet `null` is the same answer, and `null` is
  // exactly what `canPaintChart()` reads to decide not to paint.
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}
