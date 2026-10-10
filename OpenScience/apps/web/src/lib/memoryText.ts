/**
 * How a stored memory is shown to the person it is about.
 *
 * The extractor's deterministic fallback stored whole task briefs as durable
 * `preference` records — eleven of them on the operator's account, each a
 * `<evimed-brief>` block of up to 4,000 characters, all `explicit / active /
 * confidence 100%`. The memory page rendered them verbatim, tag and all
 * (2026-09-16 review, M1). The fallback is gone and those rows are archived;
 * this is the display half, for a row that is already in the database or
 * arrives from an import.
 *
 * `readableMemory` strips the markers so the card shows the content rather than
 * the envelope. It never invents a summary: what is left is what was stored,
 * minus tags a person never typed. (Saying on the card whose words a memory is
 * is not this file's job and no screen's: that is the model's to know and the
 * operator's, owner ruling of 2026-10-10.)
 *
 * The markers are the domain's own list of every tag the platform writes
 * (`PLATFORM_CONTEXT_TAGS`, held complete by a test that walks the emitters):
 * this list used to know four of eighteen.
 */
import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";

/** `system-reminder` is not ours; older transcripts carry it and it is just as
 *  much machine text. */
const HARNESS_MARKERS = ["system-reminder"];

function markerPattern(names: readonly string[]): RegExp {
  const alternatives = [...names].sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`</?(?:${alternatives.join("|")})(?=[\\s>/])[^>]*>`, "gi");
}

/** Every envelope, including the one we put around the reader's own words. */
const ANY_MARKER = markerPattern([...PLATFORM_CONTEXT_TAGS.map((entry) => entry.tag), ...HARNESS_MARKERS]);

export function readableMemory(text: string): string {
  return text.replace(ANY_MARKER, "").trim();
}

/** A long stored value, shortened for a card without pretending to summarize. */
export function memoryExcerpt(text: string, max = 400): string {
  const readable = readableMemory(text);
  return readable.length > max ? `${readable.slice(0, max)}…` : readable;
}
