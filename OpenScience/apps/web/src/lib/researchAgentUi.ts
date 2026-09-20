import { CAPABILITY_DISPLAY, capabilityTitle as domainCapabilityTitle } from "@evimed/domain";
import type { WebResearchAgent } from "./apiClient";


/**
 * A catalogue entry as a researcher sees it: the control plane's record
 * (`GET /api/agents` — id, version, inputs, the files it writes) under the
 * capability's reader-facing `display:` block.
 */
export interface CapabilityUi extends WebResearchAgent {
  /** What the researcher receives, in their words; the file paths stay in `outputs`. */
  deliverables: string[];
  knownLimits: string[];
  /** What to provide before starting, for a capability that works on the researcher's material. */
  materials: string | null;
}

/**
 * The display table lives in `@evimed/domain`, generated from each capability's
 * `display:` block. Two surfaces outside this bundle need it: the run ledger
 * names the capability that produced a row, and the kernel's own hero renders
 * the capability cards inside an iframe on another origin, from a catalogue
 * the server hands it. A second copy here is how the two would drift into
 * disagreeing about what a capability is called.
 *
 * An agent the table does not know keeps its own (English) record rather than
 * vanishing: a capability shown in the wrong language can still be used.
 */
export function researchAgentUi(agent: WebResearchAgent): CapabilityUi {
  const display = CAPABILITY_DISPLAY[agent.id];
  if (!display) return { ...agent, deliverables: [], knownLimits: [], materials: null };
  return {
    ...agent,
    title: display.title,
    category: display.category,
    description: display.description,
    starterPrompts: display.starterPrompts,
    // The reader's "usually", not the orchestrator's planning budget the
    // control plane serves under the same name.
    estimatedMinutes: [display.estimatedMinutes.min, display.estimatedMinutes.max],
    deliverables: display.outputs,
    knownLimits: display.knownLimits,
    materials: display.materials ?? null,
  };
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

