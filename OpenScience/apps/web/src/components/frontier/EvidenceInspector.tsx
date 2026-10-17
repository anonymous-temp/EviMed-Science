import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import type { EvidenceCard } from "@/lib/evidenceZoneClient";
import type { EvidenceChallengeView } from "@/lib/evidenceUpkeepClient";
import { ClaimDetail, SourceDetail, claimSourceIndexes } from "./EvidenceClaimDetail";
import { EvidenceInspectContext, evidenceClaimKey, type EvidenceInspect } from "./evidenceInspect";

/** What the drawer holds: a conclusion, or a source — and, for a source opened from a conclusion, the conclusion to go back to. */
type Open = { kind: "claim"; key: string } | { kind: "source"; index: number; from: string | null };

/**
 * The one drawer of an evidence card (R19, audit D C2 and §3.6 #5): a conclusion's quotation, or a source's excerpt, opened from
 * a row of either list or from any `[n]` on the page — the same claim id and source number whichever door was used, so a claim,
 * the source it names and its quotation are one thing read from three places. A source opened from a conclusion has 「回到这条结论」.
 *
 * It wraps the page's article and everything after it that can name a source (the discussion's `[n]`), and holds nothing but
 * which record is open; the card is the caller's.
 */
export function EvidenceInspector({ evidence, challenges, children }: { evidence: EvidenceCard; challenges?: EvidenceChallengeView[]; children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  // The claim open now, for a source opened from inside it to remember where it came from.
  const current = useRef<Open | null>(null);
  current.current = open;
  const api = useMemo<EvidenceInspect>(() => ({
    openClaim: (key) => setOpen({ kind: "claim", key }),
    openSource: (index) => setOpen({ kind: "source", index, from: current.current?.kind === "claim" ? current.current.key : null }),
  }), []);

  const claims = useMemo(() => evidence.claims.map((claim, position) => ({ claim, key: evidenceClaimKey(claim, position) })), [evidence.claims]);
  const close = () => setOpen(null);
  let drawer: ReactNode = null;
  if (open?.kind === "claim") {
    const found = claims.find((entry) => entry.key === open.key);
    if (found) {
      drawer = (
        <Drawer title="结论的依据" onClose={close}>
          <ClaimDetail evidence={evidence} claim={found.claim} challenges={challenges} />
        </Drawer>
      );
    }
  } else if (open?.kind === "source") {
    const source = evidence.sources[open.index - 1];
    if (source) {
      const citedBy = claims.filter((entry) => claimSourceIndexes(entry.claim).includes(open.index)).map((entry) => ({ key: entry.key, text: entry.claim.text }));
      const origin = open.from;
      drawer = (
        <Drawer title={`来源 ${open.index}`} description={source.title} onClose={close}>
          {origin && (
            <Button variant="text" size="sm" className="-ml-2 mb-3" onClick={() => setOpen({ kind: "claim", key: origin })}>
              <ChevronLeft size={16} aria-hidden="true" />回到这条结论
            </Button>
          )}
          <SourceDetail source={source} citedBy={citedBy} onOpenClaim={(key) => setOpen({ kind: "claim", key })} />
        </Drawer>
      );
    }
  }

  return (
    <EvidenceInspectContext.Provider value={api}>
      {children}
      {drawer}
    </EvidenceInspectContext.Provider>
  );
}
