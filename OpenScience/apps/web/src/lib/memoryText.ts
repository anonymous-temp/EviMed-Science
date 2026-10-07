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
 * Two separate jobs, deliberately not one:
 *   - `looksInjected` says whether the text carries a machine marker, so the UI
 *     can tell the reader this was not something they said;
 *   - `readableMemory` strips the markers so the card shows the content rather
 *     than the envelope. It never invents a summary: what is left is what was
 *     stored, minus tags a person never typed.
 *
 * The markers are the domain's own list of every tag the platform writes
 * (`PLATFORM_CONTEXT_TAGS`, held complete by a test that walks the emitters):
 * this list used to know four of eighteen.
 */
import { PLATFORM_CONTEXT_TAGS } from "@evimed/domain";
import type { WebMemoryProvenance } from "./apiClient";

/** `system-reminder` is not ours; older transcripts carry it and it is just as
 *  much machine text. */
const HARNESS_MARKERS = ["system-reminder"];

function markerPattern(names: readonly string[]): RegExp {
  const alternatives = [...names].sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`</?(?:${alternatives.join("|")})(?=[\\s>/])[^>]*>`, "gi");
}

/** Machine text: a block someone other than the reader wrote. */
const INJECTED = markerPattern([
  ...PLATFORM_CONTEXT_TAGS.filter((entry) => entry.role === "injected").map((entry) => entry.tag),
  ...HARNESS_MARKERS,
]);
/** Every envelope, including the one we put around the reader's own words. */
const ANY_MARKER = markerPattern([...PLATFORM_CONTEXT_TAGS.map((entry) => entry.tag), ...HARNESS_MARKERS]);

export function looksInjected(text: string): boolean {
  INJECTED.lastIndex = 0;
  return INJECTED.test(text);
}

export function readableMemory(text: string): string {
  return text.replace(ANY_MARKER, "").trim();
}

/**
 * Where a piece of evidence came from, in the reader's words. The stored value
 * is the store's enum (`conversation_message`, `agent_run`), which the memory
 * page used to print as-is (2026-09-16 review, M6). An enum this table does not
 * know yet still reads as a sentence rather than as an identifier.
 */
const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  conversation_message: "对话中的原话",
  agent_run: "一次运行的记录",
};

export function evidenceSourceLabel(sourceType: string): string {
  return EVIDENCE_SOURCE_LABELS[sourceType] ?? "其他来源";
}

/** A long stored value, shortened for a card without pretending to summarize. */
export function memoryExcerpt(text: string, max = 400): string {
  const readable = readableMemory(text);
  return readable.length > max ? `${readable.slice(0, max)}…` : readable;
}

/**
 * Where a memory came from, in the words the drawer says it in — the one place
 * the page tells the researcher whose words a memory is (principle 18; it was a
 * grey 「推断」 on every row until 2026-10-07, which said nothing on a page where
 * most rows are learned). What they said, confirmed or changed is theirs;
 * everything else is what EviMed learned from their conversations.
 */
export function memoryOrigin(record: {
  provenance?: WebMemoryProvenance;
  origin?: string;
  summary?: string;
  value?: string;
}): string {
  if (looksInjected(record.summary || record.value || "")) return "从对话中学到";
  const basis = record.provenance?.basis
    ?? (record.origin === "explicit" ? "stated" : record.origin === "manual" ? "edited" : "inferred");
  return basis === "stated" ? "你说的" : basis === "confirmed" ? "你确认的" : basis === "edited" ? "你改过的" : "从对话中学到";
}
