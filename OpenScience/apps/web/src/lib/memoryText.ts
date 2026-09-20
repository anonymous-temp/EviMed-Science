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
 * The label a memory keeps for good (principle 18): who it came from. An
 * inference is 「EviMed 推断」 however often it is seen; only its owner makes it
 * anything else.
 *
 * The page's whole vocabulary of origins is 你说的 / EviMed 推断 / 来自研究 /
 * 来自资料 / 来自 X 的胶囊; the last two belong to a capsule entry, which
 * carries its own label. 「来自工具结果」 and 「来自对话中的分析」 were the same
 * thing said twice — both mean the platform saw it while doing the work — and
 * the difference was not one a reader could act on.
 */
export const MEMORY_BASIS_LABELS: Record<WebMemoryProvenance["basis"], string> = {
  stated: "你说的",
  confirmed: "你确认过",
  edited: "你改过",
  inferred: "EviMed 推断",
  tool: "来自研究",
  assistant: "来自研究",
};

/** The researcher's own word, as opposed to the platform's observation: what
 *  the 关于我 filter keeps, and what 「不对」 is never offered on. */
export const STATED_BASES: ReadonlySet<string> = new Set(["stated", "confirmed", "edited"]);

/**
 * How established a memory is, counted — never a percentage. The page used
 * to print 「置信度 85%」, a number the extractor typed, over records with one
 * piece of evidence (49 of 52 on the acceptance account, 2026-09-19).
 */
export function memoryStrength(provenance: WebMemoryProvenance | undefined, evidenceCount = 0): string {
  if (!provenance) return evidenceCount > 0 ? `${evidenceCount} 处依据` : "";
  const times = Math.max(provenance.observations, 1);
  const spread = provenance.conversations > 1 ? ` · ${provenance.conversations} 次对话` : "";
  switch (provenance.basis) {
    case "stated": return `你说过 ${times} 次${spread}`;
    case "confirmed": return `你确认过 · 观察到 ${times} 次`;
    case "edited": return "你改过";
    case "inferred": return `在 ${Math.max(provenance.runs, 1)} 次研究中观察到`;
    case "tool":
    case "assistant": return `${times} 处依据`;
  }
}

/**
 * 「用过 7 次，上次 9月18日」 — how often this memory actually reached a run.
 *
 * A count, never a share: a percentage here would be a number nobody measured,
 * which is the mistake 「置信度 85%」 was. A memory with no usage row has never
 * been used, and says so rather than showing a zero to interpret.
 */
export function memoryUsage(
  usage: { count: number; lastUsedAt: string | null } | undefined,
  when: (value: string) => string,
): string {
  if (!usage || usage.count <= 0) return "还没用过";
  const last = usage.lastUsedAt ? when(usage.lastUsedAt) : "";
  return last ? `用过 ${usage.count} 次，上次 ${last}` : `用过 ${usage.count} 次`;
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
