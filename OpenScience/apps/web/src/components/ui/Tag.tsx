import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one metadata tag: 20 px high, 12 px text, a 4 px corner, a quiet ground
 * and no border. It is not clickable — a clickable chip is a filter
 * (`FilterChips`).
 *
 * Colour is for safety: `safety` is the only tone a page uses as a matter of
 * course. `accent` and `warn` exist for the two state badges of the frontier
 * hot list (「新」 and 「升温」) and nothing else. There were about seventeen tag
 * recipes, five of them on one frontier card (2026-09-23 inventory §2.1); a
 * screen now carries at most two kinds — this one, and a filter chip.
 */
export type TagTone = "neutral" | "safety" | "accent" | "warn";

const toneClasses: Record<TagTone, string> = {
  neutral: "bg-surface-2 text-text-2",
  safety: "bg-danger-soft text-danger-strong",
  accent: "bg-accent-soft text-accent-strong",
  warn: "bg-warn-soft text-warn-strong",
};

export function tagClasses({ tone = "neutral", className }: { tone?: TagTone; className?: string } = {}): string {
  return cn(
    "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-tag px-1.5 text-meta font-normal",
    toneClasses[tone],
    className,
  );
}

export function Tag({
  tone = "neutral",
  title,
  className,
  children,
}: {
  tone?: TagTone;
  /** A tooltip, only when the tag abbreviates something. */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={tagClasses({ tone, className })}>
      {children}
    </span>
  );
}
