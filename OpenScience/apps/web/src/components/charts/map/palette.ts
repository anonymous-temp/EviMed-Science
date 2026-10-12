import { resolvedColor } from "../echartsBase";

/**
 * The map's colours: three hues at most — the brand blue for what is in force, the amber for what needs a second look, a grey for
 * what was replaced — and the type of a mark is told by its shape and its words, never its hue (spec §2). Every colour is a token
 * resolved to a literal for the canvas, which cannot read `var()`.
 */
export interface MapPalette {
  current: string;
  check: string;
  replaced: string;
  line: string;
  text: string;
  textFaint: string;
  surface: string;
  grid: string;
  /** Six steps of one hue, empty to busiest. */
  heat: readonly [string, string, string, string, string, string];
}

/** Read from the live document: build the option again whenever the scheme changes. */
export function mapPalette(): MapPalette {
  return {
    current: resolvedColor("var(--chart-own)"),
    check: resolvedColor("var(--warn)"),
    replaced: resolvedColor("var(--chart-rival-2)"),
    line: resolvedColor("var(--chart-rival-3)"),
    text: resolvedColor("var(--text-2)"),
    textFaint: resolvedColor("var(--text-3)"),
    surface: resolvedColor("var(--surface)"),
    grid: resolvedColor("var(--chart-grid)"),
    heat: [0, 1, 2, 3, 4, 5].map((step) => resolvedColor(`var(--heat-${step})`)) as unknown as MapPalette["heat"],
  };
}

/** Plain strings for a test, which has no stylesheet to read. */
export const TEST_PALETTE: MapPalette = {
  current: "#blue", check: "#amber", replaced: "#grey", line: "#line", text: "#text", textFaint: "#faint", surface: "#surface", grid: "#grid",
  heat: ["#h0", "#h1", "#h2", "#h3", "#h4", "#h5"],
};
