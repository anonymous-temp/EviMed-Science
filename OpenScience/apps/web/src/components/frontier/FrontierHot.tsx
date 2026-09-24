import { Link } from "react-router";
import { Flame } from "lucide-react";
import { cn } from "@/lib/cn";
import { FRONTIER_HOT_WINDOWS, type FrontierHotBoard, type FrontierHotEvent, type FrontierHotWindow } from "@/lib/frontierClient";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { Sparkline } from "./Sparkline";
import { HEAT_METHOD_ZH, INLINE_ACTION, hotBoardStamp, hotRowMeta, rankChangeLabel, rankLabel, rankTone } from "./frontierText";

const eventPath = (id: string) => `/app/frontier/events/${encodeURIComponent(id)}`;

const WINDOW_OPTIONS = FRONTIER_HOT_WINDOWS.map((value) => ({ value, label: value === "current" ? "当前" : value === "week" ? "本周" : "本月" }));

/**
 * 当前热点, at the top of 精选 (plan 2026-09-23 §6.2): the five hottest
 * events, each one line — the rank in the rank colours, the title, the heat
 * in grey and how the rank moved (「↑2」, 「新」). The whole line opens the
 * event. Nothing hot, no card: an empty 「当前热点」 box is a promise the page
 * cannot keep.
 */
export function HotCard({ events, onOpenAll }: { events: readonly FrontierHotEvent[]; onOpenAll: () => void }) {
  const top = events.slice(0, 5);
  if (top.length === 0) return null;
  return (
    <Card
      padding="p-3"
      header={(
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-body font-semibold leading-6 text-text">当前热点</h2>
          <button type="button" onClick={onOpenAll} className={cn(INLINE_ACTION, "-mr-1.5 px-1.5 text-accent")}>完整热榜 ›</button>
        </div>
      )}
    >
      <ol aria-label="当前热点" className="px-1">
        {top.map((event) => {
          const change = rankChangeLabel(event.rankChange);
          return (
            <li key={event.id}>
              <Link to={eventPath(event.id)} className="group flex h-10 items-center gap-3 text-ui">
                <span className={cn("w-5 shrink-0 text-right font-semibold tabular-nums", rankTone(event.rank))}>{event.rank}</span>
                <span data-row-title className="min-w-0 flex-1 truncate font-medium text-text group-hover:text-accent">{event.title}</span>
                {event.heat !== null && <span className="shrink-0 text-caption text-text-3"><span className="tabular-nums">{event.heat}</span> 热度</span>}
                {change && <span className="shrink-0 text-caption text-text-2">{change}</span>}
              </Link>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** The hot view's ranking: still being read, unreadable, or read (`board: null` is a server without the route). */
export type HotState = { board: FrontierHotBoard | null; error: string | null } | null;

/**
 * 热榜 (plan 2026-09-23 §6.2; research B §8 #1–#7): ten events, each with its
 * rank, an optional 「新」 or 「升温」, the title, how many institutions reported
 * it and whether the parties' own texts are among them, and on the right the
 * heat — the one number — over its 24-hour trend. 当前 · 本周 · 本月 above,
 * when the ranking was taken at the right, and 「热度怎么算」 folded below.
 *
 * The window chips appear once the server stamps its rankings (`windows`,
 * from a `takenAt` it sent): a server without them answers every window with
 * the current list, and a chip that changed nothing would say something
 * false. They stay while another window's ranking is read.
 */
export function HotBoard({ state, window, windows, onWindow, onRetry }: {
  state: HotState;
  window: FrontierHotWindow;
  windows: boolean;
  onWindow: (window: FrontierHotWindow) => void;
  onRetry: () => void;
}) {
  const board = state?.board ?? null;
  const body = !state ? <FrontierSkeleton />
    : state.error && !board ? <LoadError message={state.error} onRetry={onRetry} />
      : !board ? <EmptyState icon={Flame} title="热榜还在准备" />
        : board.events.length === 0 ? <EmptyState icon={Flame} title="暂无热点" />
          : (
            <ol aria-label="热榜" className="mt-1">
              {board.events.map((event) => <HotRow key={event.id} event={event} />)}
            </ol>
          );
  return (
    <div>
      {windows && (
        <FilterChips
          label="时间范围"
          options={WINDOW_OPTIONS}
          value={window}
          onChange={onWindow}
          trailing={board?.takenAt ? <span className="text-caption text-text-3">{hotBoardStamp(board.window, board.takenAt)}</span> : undefined}
        />
      )}
      {body}
      {board?.events.some((event) => event.heat !== null) && (
        <Disclosure className="mt-4" summary={<span className="text-caption">热度怎么算</span>}>
          <div className="max-w-measure space-y-2 text-caption text-text-2">
            {HEAT_METHOD_ZH.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/**
 * One row of 热榜. The title line is one 40 px link — the rank beside it, a
 * badge before it — and the whole title is its tooltip where it is cut. The
 * heat and its trend are shown only where the server sends a heat: a week's
 * or a month's ranking is by institutions, and says so in its line instead.
 */
function HotRow({ event }: { event: FrontierHotEvent }) {
  return (
    <li className="flex gap-3 border-b border-border py-4">
      <span className={cn("w-10 shrink-0 text-body font-semibold leading-10 tabular-nums", rankTone(event.rank))}>{rankLabel(event.rank)}</span>
      <div className="min-w-0 flex-1">
        <Link to={eventPath(event.id)} title={event.title} data-row-title className="group flex h-10 min-w-0 items-center gap-1.5 text-ui">
          {event.badge && <Tag tone={event.badge === "new" ? "accent" : "warn"}>{event.badge === "new" ? "新" : "升温"}</Tag>}
          <span className="min-w-0 truncate text-body font-semibold text-text group-hover:text-accent">{event.title}</span>
        </Link>
        <p className="text-caption text-text-3">{hotRowMeta(event)}</p>
      </div>
      {event.heat !== null && (
        <div className="w-28 shrink-0">
          <p className="flex h-10 items-center justify-end gap-0.5">
            <span className="text-title font-semibold tabular-nums text-text">{event.heat}</span>
            <span className="text-caption text-text-3">热度</span>
          </p>
          <div className="flex h-7 justify-end"><Sparkline points={event.trend} /></div>
        </div>
      )}
    </li>
  );
}

/** Whether a query value names one of the hot rankings. */
export function isHotWindow(value: string | null): value is FrontierHotWindow {
  return FRONTIER_HOT_WINDOWS.includes(value as FrontierHotWindow);
}
