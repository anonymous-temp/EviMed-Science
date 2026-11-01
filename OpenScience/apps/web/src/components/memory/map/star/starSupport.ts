import { useMediaQuery, useNarrow } from "@/lib/useMediaQuery";

let ready: boolean | null = null;

/**
 * Whether this browser draws WebGL on a real GPU. `failIfMajorPerformanceCaveat` refuses a software renderer, which would run the picture at a few frames a
 * second, so a remote desktop or a machine with no GPU gets the relation graph instead of a slideshow. Asked once: the answer does not change while a page
 * is open, and the throwaway context is given back at once because a browser allows only about sixteen.
 */
export function webglReady(): boolean {
  if (ready !== null) return ready;
  try {
    if (typeof WebGL2RenderingContext === "undefined") return (ready = false);
    const gl = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    ready = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    ready = false;
  }
  return ready;
}

/** For a test: forget the answer. */
export function resetWebglReady(): void {
  ready = null;
}

/** The three things that make the star map the wrong picture here: no real GPU, a person who asked for less motion, and a phone's width. */
export function starAllowed({ webgl, reducedMotion, narrow }: { webgl: boolean; reducedMotion: boolean; narrow: boolean }): boolean {
  return webgl && !reducedMotion && !narrow;
}

/** Whether this reader gets the star map, kept current as they turn a phone or change the setting. */
export function useStarAllowed(): boolean {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const narrow = useNarrow();
  return starAllowed({ webgl: webglReady(), reducedMotion, narrow });
}
