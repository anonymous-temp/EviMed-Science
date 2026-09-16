import { CAPABILITY_DISPLAY, capabilityTitle as domainCapabilityTitle } from "@evimed/domain";
import type { WebResearchAgent } from "./apiClient";

/**
 * The display table moved to `@evimed/domain` on 2026-09-15.
 *
 * Two surfaces outside this bundle need it: the run ledger names the
 * capability that produced a row, and the kernel's own hero renders the
 * capability cards inside an iframe on another origin, from a catalogue the
 * server hands it. A second copy here is how the two would drift into
 * disagreeing about what a capability is called.
 */
const translations = CAPABILITY_DISPLAY;

export function researchAgentUi(agent: WebResearchAgent): WebResearchAgent & { code: string } {
  const translation = translations[agent.id];
  return translation ? { ...agent, ...translation } : { ...agent, code: agent.title.slice(0, 2).toUpperCase() };
}

/**
 * The product name of a capability, from its id alone.
 *
 * The catalog is fetched, and the run ledger is not: a run row names the
 * capability that produced it and has no title to show for it, which is why
 * the ledger, the sidebar and the run panel each displayed
 * `clinical-evidence-synthesis` — and `CLINICAL-EVIDENCE-SYNTHESIS` upper-cased
 * beside it — where a reader expected 「临床证据深度分析」 (2026-09-15 walk,
 * D1/D2). Re-exported rather than reimplemented: one table, one answer.
 *
 * Returns null for an id this build has no name for, so the caller decides
 * whether an untranslated id is better shown raw or hidden — an id silently
 * rendered as a title is the failure being fixed here.
 */
export function capabilityTitle(id: string | null | undefined): string | null {
  return domainCapabilityTitle(id);
}

