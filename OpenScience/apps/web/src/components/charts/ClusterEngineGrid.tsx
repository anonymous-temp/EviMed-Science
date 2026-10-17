import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { countText, engineStance, type EngineStance, type EngineTally } from "@/components/geo/spine/clusterModel";

/**
 * Question group against engine, as counts (R19, audit C §2.7 class 5: the group × engine matrix, the one picture the owner's
 * questions need — "which groups does which engine name us in?").
 *
 * **A cell is a count and one of three states, never a rate.** About a dozen answers fall to a group on an engine in a round; the
 * platform's own floor for a rate is thirty. So the cell prints `k/n` — answers that named us over answers — and its ground says
 * which of three things that is: every answer named us, some did, none did; an engine that was not asked is a hatched cell. A wrong
 * statement is a ✗ and its count on the same cell, in the one red of the page (said three times: colour, shape, words).
 *
 * The ramp is the heat grid's single hue (`bg-heat-*`), so the matrix reads with the engine × metric grid above it and never as a
 * traffic light. Wider than its box it scrolls in a labelled region and the group's name stays at the left edge.
 *
 * Every cell with answers is a button: it opens what it counts — the group's drawer, resting on that engine.
 */

export interface ClusterGridRow {
  key: string;
  /** The group's name, as a link or plain: the grid places it in the frozen first column. */
  header: ReactNode;
  /** The group's name as text, for the cells' accessible names. */
  name: string;
  tallies: Readonly<Record<string, EngineTally | null | undefined>>;
  /** A grey word after the name (「对照」). */
  note?: ReactNode;
}

const STANCE_CLASSES: Record<Exclude<EngineStance, "unmeasured">, string> = {
  all: "bg-heat-4 text-accent-fg",
  some: "bg-heat-2 text-text",
  none: "bg-surface-2 text-text-2",
};

const STANCE_WORDS: Record<EngineStance, string> = {
  all: "每个回答都提到了",
  some: "部分回答提到了",
  none: "都没有提到",
  unmeasured: "没有测",
};

/** A hatched ground for 「未测」, built from the surface tokens rather than a colour (the heat grid's). */
const HATCH = "repeating-linear-gradient(135deg, var(--surface-1) 0 6px, var(--surface-2) 6px 12px)";

export function ClusterEngineGrid({
  label,
  engines,
  engineName,
  rows,
  onOpen,
  legend = true,
  ground = "surface",
  className,
}: {
  /** The grid's accessible name. */
  label: string;
  engines: readonly string[];
  engineName: (engine: string) => string;
  rows: readonly ClusterGridRow[];
  /** What a cell opens: the group's drawer on that engine. */
  onOpen?: (rowKey: string, engine: string) => void;
  legend?: boolean;
  /** What the grid is drawn on, for the frozen names: a card (`surface`) or the page (`bg`). */
  ground?: "bg" | "surface";
  className?: string;
}) {
  const groundClass = ground === "bg" ? "bg-bg" : "bg-surface";
  return (
    <div data-cluster-grid="" className={cn("min-w-0", className)}>
      {legend && (
        <div className="mb-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-meta text-text-3">
          {(["all", "some", "none"] as const).map((stance) => (
            <span key={stance} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" data-forced-colors="preserve" className={cn("h-2.5 w-3.5 rounded-tag", STANCE_CLASSES[stance])} />
              {STANCE_WORDS[stance]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" data-forced-colors="preserve" className="h-2.5 w-3.5 rounded-tag" style={{ background: HATCH }} />
            没有测
          </span>
          <span className="inline-flex items-center gap-1">
            <X size={16} aria-hidden="true" className="text-danger" />
            有讲错
          </span>
        </div>
      )}
      <ScrollRegion label={label}>
        <table className="w-full min-w-[28rem] border-separate border-spacing-1">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn("sticky left-0 z-sticky w-44 text-left text-meta font-normal text-text-3", groundClass)}>
                <span className="sr-only">问题群</span>
              </th>
              {engines.map((engine) => (
                <th key={engine} scope="col" className="px-1 pb-1 text-center text-meta font-normal text-text-3">{engineName(engine)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-cluster-row={row.key}>
                <th scope="row" className={cn("sticky left-0 z-page w-44 max-w-44 text-left text-compact font-normal text-text", groundClass)}>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate">{row.header}</span>
                    {row.note}
                  </span>
                </th>
                {engines.map((engine) => {
                  const tally = row.tallies[engine] ?? null;
                  const stance = engineStance(tally);
                  if (!tally || stance === "unmeasured") {
                    return (
                      <td key={engine} data-cluster-cell={engine} data-stance="unmeasured" className="h-8 rounded text-center text-compact text-text-3" style={{ background: HATCH }}>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{`${row.name}，${engineName(engine)}：${STANCE_WORDS.unmeasured}`}</span>
                      </td>
                    );
                  }
                  const wrong = tally.wrong > 0;
                  const text = countText(tally.mentioned, tally.answered);
                  const spoken = `${row.name}，${engineName(engine)}：${tally.answered} 个回答里 ${tally.mentioned} 个提到了${wrong ? `，${tally.wrong} 个讲错` : ""}`;
                  return (
                    <td key={engine} data-cluster-cell={engine} data-stance={stance} data-wrong={wrong ? "" : undefined} data-forced-colors="preserve"
                      className={cn("h-8 rounded p-0 text-center text-compact tabular-nums", STANCE_CLASSES[stance])}>
                      {onOpen ? (
                        <button type="button" onClick={() => onOpen(row.key, engine)} aria-label={spoken}
                          className="flex h-8 w-full items-center justify-center gap-1 rounded px-2 hover:underline hover:underline-offset-4">
                          {text}
                          {wrong && <X size={16} aria-hidden="true" className={stance === "all" ? "text-accent-fg" : "text-danger"} />}
                        </button>
                      ) : (
                        <span className="flex h-8 items-center justify-center gap-1 px-2" aria-label={spoken}>
                          {text}
                          {wrong && <X size={16} aria-hidden="true" className="text-danger" />}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
