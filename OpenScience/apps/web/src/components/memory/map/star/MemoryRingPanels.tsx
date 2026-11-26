import { useMemo, type ReactNode } from "react";
import { formatClock, formatDate, formatDay, formatNumber } from "@/lib/format";
import type { MapEdge, MapEvent, MapNode } from "@/lib/memoryMapClient";
import { ringFigures, ringHeat, ringLog } from "./memoryRing";
import type { StarFamily } from "./starModel";

/** How many of the log's newest entries the panel lists. */
const LOG_ROWS = 40;

/** Literal, so the stylesheet's scan finds each colour. */
const TONE_BG: Readonly<Record<string, string>> = {
  about: "bg-star-about", preference: "bg-star-preference", correction: "bg-star-correction", fact: "bg-star-fact", decision: "bg-star-decision",
  method: "bg-star-method", document: "bg-star-document", entity: "bg-star-entity", hub: "bg-star-hub", you: "bg-star-you",
};
const FAMILY_BG: Readonly<Record<StarFamily, string>> = {
  person: "bg-star-entity", note: "bg-star-document", about: "bg-star-about", preference: "bg-star-preference", correction: "bg-star-correction", fact: "bg-star-fact",
  decision: "bg-star-decision", method: "bg-star-method", document: "bg-star-document", entity: "bg-star-entity",
};

/**
 * The full-screen ring's instrument (owner, 2026-11-26): the kinds it holds down the left, each a switch that hides or shows them; the last 24
 * hours by the hour and the memory's log on the right; the figures along the bottom. Every number and every row is counted from the map's own
 * document — the log says what the document says happened, a recall only its last time — so the panels show what is there and nothing that
 * was made up to look busy. A row of the log opens its memory's drawer.
 *
 * Anatomy: head with the title and controls, kinds, 24-hour activity, log, figures.
 * States: empty log and quiet day say so in one line each.
 * Theme: the ring's night window; its tokens answer for the dark ground.
 * Responsive: full screen only, on a screen wide enough for the ring between the columns.
 */
export function MemoryRingPanels({ nodes, edges, events, missing, documentTypes, now, counts, hidden, onToggle, title, controls, meta, onOpen }: {
  nodes: readonly MapNode[];
  edges: readonly MapEdge[];
  events: readonly MapEvent[];
  /** The map's sources that did not answer: a figure counted from one is “—”. */
  missing?: readonly string[];
  /** The knowledge base's own count of its documents, where the document carries it. */
  documentTypes?: ReadonlyArray<{ count: number }>;
  now: number;
  counts: ReadonlyArray<{ family: StarFamily; word: string; count: number }>;
  hidden: ReadonlySet<StarFamily>;
  onToggle: (family: StarFamily) => void;
  title: string;
  controls: ReactNode;
  meta?: ReactNode;
  onOpen: (cellId: string) => void;
}) {
  // The day's activity is counted from everything that happened in it; only the list shows the newest forty.
  const all = useMemo(() => ringLog(nodes, events, now), [nodes, events, now]);
  const log = useMemo(() => all.slice(0, LOG_ROWS), [all]);
  const heat = useMemo(() => ringHeat(all, now), [all, now]);
  const figures = useMemo(() => ringFigures({ nodes, edges, events, missing, documentTypes }, now), [nodes, edges, events, missing, documentTypes, now]);
  const today = formatDate(now);
  const peak = Math.max(1, ...heat.flatMap((row) => row.hours));
  const panel = "pointer-events-auto rounded-card border border-faint bg-star-panel backdrop-blur-md";
  return (
    <>
      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-caption tracking-widest text-text-3">MEMORY RING</div>
          <div className="truncate text-heading text-text">记忆星环 · {title}</div>
        </div>
        <div className="pointer-events-auto flex shrink-0 flex-wrap items-start justify-end gap-2">
          {meta && <div className="rounded-card border border-faint bg-star-panel px-2 backdrop-blur-md">{meta}</div>}
          {controls}
        </div>
      </div>

      <section aria-label="记忆类型" className={`${panel} absolute bottom-36 left-4 top-20 flex w-72 flex-col gap-2 overflow-y-auto p-3`}>
        <h3 className="text-caption text-text-3">记忆类型 · 按一下隐藏或显示</h3>
        {counts.map((entry) => (
          <button
            key={entry.family} type="button" aria-pressed={!hidden.has(entry.family)} onClick={() => onToggle(entry.family)}
            className={`flex min-h-10 items-center gap-2 rounded px-3 text-left text-ui transition-opacity duration-fast hover:bg-surface-2 ${hidden.has(entry.family) ? "opacity-disabled" : ""}`}
          >
            <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${FAMILY_BG[entry.family]}`} />
            <span className="min-w-0 flex-1 truncate text-text">{entry.word}</span>
            <span className="tabular-nums text-text-2">{formatNumber(entry.count)}</span>
          </button>
        ))}
      </section>

      <div className="pointer-events-none absolute bottom-36 right-4 top-20 flex w-80 flex-col gap-3">
        <section aria-label="近 24 小时" className={`${panel} p-3`}>
          <h3 className="text-caption text-text-3">近 24 小时 · 每格一小时</h3>
          {heat.length ? (
            <div className="mt-2 flex flex-col gap-1">
              {heat.map((row) => (
                <div key={row.word} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 truncate text-caption text-text-2">{row.word}</span>
                  <span className="flex min-w-0 flex-1 gap-px">
                    {row.hours.map((value, hour) => (
                      <i key={hour} className={`block h-2.5 flex-1 rounded-sm ${value ? TONE_BG[row.tone] ?? "bg-star-hub" : "bg-surface-2"}`} style={value ? { opacity: 0.25 + (0.75 * value) / peak } : undefined} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="mt-2 text-caption text-text-2">这一天很安静</p>}
        </section>
        <section aria-label="记忆日志" className={`${panel} flex min-h-0 flex-1 flex-col p-3`}>
          <h3 className="text-caption text-text-3">记忆日志 · 最近 {formatNumber(log.length)} 条{all.length > log.length ? `，共 ${formatNumber(all.length)} 条` : ""}</h3>
          {log.length ? (
            <ol className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
              {log.map((entry) => {
                const when = formatDate(entry.at) === today ? formatClock(new Date(entry.at).toISOString()) : formatDay(new Date(entry.at).toISOString());
                const row = (
                  <>
                    <span className="w-16 shrink-0 whitespace-nowrap font-mono tabular-nums text-text-3">{when}</span>
                    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${TONE_BG[entry.tone] ?? "bg-star-hub"}`} />
                    <span className="shrink-0 text-text">{entry.verb}</span>
                    <span className="min-w-0 flex-1 truncate text-text-2">{entry.word} · {entry.text}</span>
                  </>
                );
                return (
                  <li key={entry.key}>
                    {entry.cell ? (
                      <button type="button" onClick={() => onOpen(entry.cell as string)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-caption hover:bg-surface-2">{row}</button>
                    ) : <div className="flex items-center gap-2 px-1 py-0.5 text-caption">{row}</div>}
                  </li>
                );
              })}
            </ol>
          ) : <p className="mt-2 text-caption text-text-2">还没有记录</p>}
        </section>
      </div>

      <dl aria-label="记忆星环的数字" className={`${panel} absolute inset-x-4 bottom-4 grid h-28 grid-cols-3 lg:grid-cols-6`}>
        {figures.map((figure) => (
          <div key={figure.label} className="flex min-w-0 flex-col justify-center border-r border-faint px-4 last:border-r-0">
            <dt className="truncate text-caption text-text-3">{figure.label}</dt>
            <dd className="mt-1 tabular-nums text-metric text-text">{figure.value === null ? "—" : <>{formatNumber(figure.value)}<span className="ml-1 text-caption text-text-2">{figure.unit}</span></>}</dd>
            <dd className="truncate text-caption text-text-3">{figure.note}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
