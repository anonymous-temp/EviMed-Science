/**
 * How a stored memory is shown to the person it is about.
 *
 * The extractor's deterministic fallback stored whole task briefs as durable
 * `preference` records — eleven of them on the operator's account, each a
 * `<evimed-brief>` block of up to 4,000 characters, all `explicit / active /
 * confidence 100%`. The memory page rendered them verbatim, tag and all
 * (2026-09-16 review, M1). The extractor no longer does that, and those eleven
 * rows are archived; this is the display half, for a row that is already in the
 * database or arrives from an import.
 *
 * Two separate jobs, deliberately not one:
 *   - `looksInjected` says whether the text carries a machine marker, so the UI
 *     can tell the reader this was not something they said;
 *   - `readableMemory` strips the markers so the card shows the content rather
 *     than the envelope. It never invents a summary: what is left is what was
 *     stored, minus tags a person never typed.
 */

/** Closed markers the platform itself wraps around machine-supplied text. */
const INJECTION_MARKERS = [
  /<\/?evimed-brief>/gi,
  /<\/?system-reminder>/gi,
  /<\/?evimed-context>/gi,
  /<\/?evimed-memory>/gi,
];

export function looksInjected(text: string): boolean {
  return INJECTION_MARKERS.some((marker) => {
    marker.lastIndex = 0;
    return marker.test(text);
  });
}

export function readableMemory(text: string): string {
  let out = text;
  for (const marker of INJECTION_MARKERS) {
    marker.lastIndex = 0;
    out = out.replace(marker, "");
  }
  return out.trim();
}

/** A long stored value, shortened for a card without pretending to summarize. */
export function memoryExcerpt(text: string, max = 400): string {
  const readable = readableMemory(text);
  return readable.length > max ? `${readable.slice(0, max)}…` : readable;
}
