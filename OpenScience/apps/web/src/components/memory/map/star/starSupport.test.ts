import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWebglReady, starAllowed, webglReady } from "./starSupport";

afterEach(() => { resetWebglReady(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("who gets the star map", () => {
  it("asks for a real GPU, a wide screen and no wish for less motion", () => {
    expect(starAllowed({ webgl: true, reducedMotion: false, narrow: false })).toBe(true);
    expect(starAllowed({ webgl: false, reducedMotion: false, narrow: false })).toBe(false);
    expect(starAllowed({ webgl: true, reducedMotion: true, narrow: false })).toBe(false);
    expect(starAllowed({ webgl: true, reducedMotion: false, narrow: true })).toBe(false);
  });

  it("a browser with no WebGL2 answers no without asking for a context", () => {
    expect(webglReady()).toBe(false);
  });

  it("refuses a software renderer by asking for a context that would be refused there, and gives the context back", () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    const loseContext = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getExtension: () => ({ loseContext }) } as never);
    expect(webglReady()).toBe(true);
    expect(getContext).toHaveBeenCalledWith("webgl2", { failIfMajorPerformanceCaveat: true });
    expect(loseContext).toHaveBeenCalledOnce();
    resetWebglReady();
    getContext.mockReturnValue(null);
    expect(webglReady()).toBe(false);
  });

  it("a browser that throws is one without", () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => { throw new Error("blocked"); });
    expect(webglReady()).toBe(false);
  });
});
