import { createContext, useContext } from "react";
import type { EvidenceClaim } from "@/lib/evidenceZoneClient";

/**
 * What a card's reader can open: a conclusion with the quotation it stands on, or a source with its excerpt — in a drawer, from a
 * row of the conclusions' list, a row of the sources' list, or any `[n]` on the page. The provider (`EvidenceInspector`) owns the
 * drawer; these are the doors to it, kept apart from it so the lists and `EvidenceReferences` need not import the component that
 * imports them.
 */
export interface EvidenceInspect {
  openClaim(key: string): void;
  /** A source by its 1-based position in the card's own list, the number a `[n]` names. */
  openSource(index: number): void;
}

export const EvidenceInspectContext = createContext<EvidenceInspect | null>(null);

/** The doors to the drawer, or null where nothing provides one (a bare `[n]` is then an anchor and nothing more). */
export function useEvidenceInspect(): EvidenceInspect | null {
  return useContext(EvidenceInspectContext);
}

/** A claim's identity in the page: its id, else its place in the card (a claim of an older card has no id). */
export const evidenceClaimKey = (claim: Pick<EvidenceClaim, "claimId">, position: number): string => claim.claimId ?? `claim-${position}`;

/** The anchor the header's ✓ n/m goes to: the start of the conclusions' list. */
export const evidenceClaimsAnchor = (cardId: string): string => `evidence-claims-${encodeURIComponent(cardId)}`;
