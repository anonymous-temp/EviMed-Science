import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { TOOLTIP_DELAYS } from "@evimed/design-tokens";
import { cn } from "@/lib/cn";

/**
 * A score as a small pill — its name small, a hairline, the number in tabular figures (AIHOT's `Score`, MIT) — and the parts it is
 * made of, as thin bars (前沿动态's 「AI 评分」, owner 2026-10-23: a lone grey 「● 84」 told a reader neither what it was nor what made it).
 *
 * The tier is the pill's ground and ink: `high` the accent's pale tint, `medium` grey with the accent's number, `low` grey with grey (`surface-3`, so it stands on a hovered card; one look for all three: a list of cards spends one kind of control on it) — so the
 * number is read first and the colour only says how high it sits. With `parts` the pill opens them under it: on hover and on keyboard
 * focus (after the tooltip's delays, and the pointer may move onto it), and on a tap; Escape and a press outside close it. Without
 * parts it is a label and not a control.
 */
export type ScoreTier = "high" | "medium" | "low";

export interface ScorePart {
  key: string;
  label: string;
  value: number;
  max: number;
}

const TIER: Readonly<Record<ScoreTier, string>> = {
  // No tier is the accent's solid ground: that is a primary action's look (the walk reads `bg-accent` as one, 2026-10-23), and a
  // list of cards is not a row of buttons to press first.
  high: "bg-accent-soft text-accent",
  medium: "bg-surface-3 text-accent",
  low: "bg-surface-3 text-text-3",
};

function PillFace({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span className="text-meta">{label}</span>
      <span aria-hidden="true" className="h-2.5 w-px bg-current" />
      <span className="sr-only"> </span>
      <span className="text-ui tabular-nums">{value}</span>
    </>
  );
}

const PILL = "inline-flex h-tag shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2";

/** The parts as one row each: the name, a thin bar of its share, and 「x/30」. */
export function ScoreBars({ parts, className }: { parts: readonly ScorePart[]; className?: string }) {
  return (
    <dl className={cn("space-y-1.5", className)}>
      {parts.map((part) => (
        <div key={part.key} className="flex items-center gap-2 text-caption">
          <dt className="w-16 shrink-0 text-text-2">{part.label}</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-2">
            <span aria-hidden="true" className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, (part.value / part.max) * 100))}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums text-text">{part.value}/{part.max}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ScorePill({ label, value, tier, parts, note, className }: {
  /** The score's name (「AI 评分」), on the pill and in its accessible name. */
  label: string;
  value: number;
  tier: ScoreTier;
  /** What it is made of; without them the pill opens nothing. */
  parts?: readonly ScorePart[] | null;
  /** One line under the bars: what the score measures. */
  note?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pointer = useRef<string>("");
  // A press focuses the pill before its click: the click decides, not the focus.
  const pressing = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const name = `${label} ${value}`;
  if (!parts?.length) {
    return <span data-score={tier} className={cn(PILL, TIER[tier], className)}><PillFace label={label} value={value} /></span>;
  }
  const schedule = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  };
  const hover = (event: PointerEvent, next: boolean) => {
    pointer.current = event.pointerType;
    if (event.pointerType === "mouse" || event.pointerType === "pen") schedule(next, next ? TOOLTIP_DELAYS.show : TOOLTIP_DELAYS.hide);
  };
  const focus = (event: FocusEvent<HTMLButtonElement>) => {
    if (pressing.current) return;
    let keyboard = true;
    try { keyboard = event.currentTarget.matches(":focus-visible"); } catch { /* an engine without the selector: the keyboard's */ }
    if (keyboard) { window.clearTimeout(timer.current); setOpen(true); }
  };
  const press = (event: MouseEvent) => {
    pressing.current = false;
    // The press opened by the pointer resting on it keeps it open; a tap (or a second press) toggles it.
    if (open && (pointer.current === "mouse" || pointer.current === "pen")) event.preventDefault();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${name}，查看构成`}
          onPointerEnter={(event) => hover(event, true)}
          onPointerLeave={(event) => hover(event, false)}
          onPointerDown={(event) => { pointer.current = event.pointerType; pressing.current = true; }}
          onFocus={focus}
          onBlur={() => { window.clearTimeout(timer.current); setOpen(false); }}
          onClick={press}
          data-score={tier}
          className={cn(PILL, "relative z-sticky cursor-pointer outline-none", TIER[tier], className)}
        >
          <PillFace label={label} value={value} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={`${label}构成`}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onPointerLeave={(event) => hover(event, false)}
          className="z-popover w-64 rounded-card border border-border bg-surface p-3 shadow-e2 outline-none animate-menu-in"
        >
          <ScoreBars parts={parts} />
          {note && <p className="mt-2.5 border-t border-border pt-2 text-caption text-text-3">{note}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
