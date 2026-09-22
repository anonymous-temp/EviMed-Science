import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChipTone } from "./frontierText";

/**
 * The small rounded label the feed uses for who said it, how hard the
 * evidence is and what to be careful about.
 *
 * Token pairs only — a `-soft` ground under its own text colour, the way the
 * knowledge base marks 「疑似重复」 — and always a word inside, so a tone is
 * never the only carrier (DESIGN.md: every status is said three times). The
 * danger tone keeps a border because it also sits on the danger-soft safety
 * card, where a soft ground alone would disappear. `text-caption` rather than
 * the 12 px rungs: `cn` would drop `text-meta` beside a text colour.
 */
const TONES: Record<ChipTone, string> = {
  neutral: "bg-surface-2 text-muted",
  outline: "border border-border bg-surface text-text",
  accent: "bg-accent-soft text-accent-strong",
  ok: "bg-ok-soft text-ok",
  info: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn-strong",
  danger: "border border-danger bg-surface text-danger-strong",
};

export function FrontierChip({ tone = "neutral", className, children }: { tone?: ChipTone; className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-caption", TONES[tone], className)}>
      {children}
    </span>
  );
}
