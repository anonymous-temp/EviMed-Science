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

/** The researcher's own word, as opposed to the platform's observation. */
export const STATED_BASES: ReadonlySet<string> = new Set(["stated", "confirmed", "edited"]);

/**
 * Whether a memory is EviMed's inference rather than something the researcher
 * said, confirmed or corrected (principle 18). It is the one annotation a
 * memory row keeps — a small grey 「推断」 after the sentence (2026-09-23 plan
 * §5.6). The origin pill (「你说的」「EviMed 推断」), the counted strength
 * (「你说过 3 次」「在 4 次研究中观察到」) and the usage line (「用过 7 次」)
 * were the back office's account of a memory and are gone with their helpers.
 *
 * A record from a control plane older than `provenance` is read by its origin;
 * a record whose text carries a machine envelope is never the researcher's
 * word, whatever it was filed as.
 */
export function isInference(record: {
  provenance?: WebMemoryProvenance;
  origin?: string;
  summary?: string;
  value?: string;
}): boolean {
  const basis = record.provenance?.basis
    ?? (record.origin === "explicit" || record.origin === "manual" ? "stated" : "inferred");
  return !STATED_BASES.has(basis) || looksInjected(record.summary || record.value || "");
}

/** The memory kinds, in the researcher's words. */
export const MEMORY_KIND_LABELS: Record<string, string> = {
  profile: "画像",
  preference: "偏好",
  behavior: "工作习惯",
  correction: "你做过的纠正",
  project_fact: "项目事实",
  analysis: "分析口径",
  decision: "已定的决策",
  follow_up: "待跟进",
  run_summary: "做过的研究",
};

export function memoryKindLabel(kind: string): string {
  return MEMORY_KIND_LABELS[kind] ?? "记忆";
}
