import { PenLine } from "lucide-react";
import type { GeoAction } from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { ListRow } from "@/components/ui/ListRow";
import { SeverityBadge } from "@/components/ui/SeverityBadge";
import { engineName, GEO_ERROR_STATUS_WORDS } from "../geoText";
import { statusWord } from "./actionModel";
import { traceLine, type ClaimRow as ClaimRowModel } from "./errorModel";

/**
 * One wrong claim as a row (R19, audit C §2.3): how grave it is, the sentence, which engines tell it, where they took it from,
 * and where its correction stands. The row opens the claim's drawer; the one button on it starts a correction where none is under
 * way. Red is the badge alone — the sentence is body text (the old board was a wall of red).
 *
 * In the per-engine view the section already names the engine, so the row leaves the engines out (`showEngines={false}`).
 */
export function ClaimRow({
  claim,
  showEngines = true,
  corrections,
  selected,
  canRun,
  busy,
  onOpen,
  onCorrect,
}: {
  claim: ClaimRowModel;
  showEngines?: boolean;
  /** The actions that name this claim's rows. */
  corrections: readonly GeoAction[];
  selected: boolean;
  canRun: boolean;
  busy: boolean;
  onOpen: () => void;
  onCorrect: () => void;
}) {
  const lead = corrections[0] ?? null;
  const trace = traceLine(claim);
  const times = claim.count > claim.engines.length ? `共 ${claim.count} 次` : null;
  const meta = [
    showEngines ? claim.engines.map(engineName).join("、") : null,
    showEngines ? times : null,
    trace,
    GEO_ERROR_STATUS_WORDS[claim.status] ?? null,
    lead ? `纠错稿：${statusWord(lead.status)}${corrections.length > 1 ? `等 ${corrections.length} 条` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <ListRow
      title={<span className="line-clamp-2 max-w-measure">“{claim.statement}”</span>}
      titleProps={{ "data-geo-claim": claim.key }}
      leading={claim.severity ? <SeverityBadge level={claim.severity} /> : undefined}
      onOpen={onOpen}
      selected={selected}
      muted={claim.status === "closed"}
      meta={meta}
      actions={!lead && canRun && claim.status !== "closed" ? (
        <Button variant="secondary" size="sm" loading={busy} onClick={onCorrect}>
          {!busy && <PenLine size={16} aria-hidden="true" />}
          写纠错稿
        </Button>
      ) : undefined}
    />
  );
}
