import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A card, for content unlike its neighbours (a hot list above a feed, a tool
 * in a grid): `rounded-card` (12) + a hairline + the surface, no shadow — a
 * static card's border is its whole edge — 16 px padding. A list of like
 * things is a `List` of rows, and a settings group is a `Panel`.
 *
 * The header draws no rule under itself and carries no hint line (2026-09-23
 * plan §4): a card whose title needs a sentence of explanation is explaining
 * the system, and a divider under a card's title was a second edge inside
 * the first. `hint` is kept for the pages not yet rewritten and renders
 * nothing.
 */
export function Card({
  title,
  header,
  footer,
  padding = "p-4",
  className,
  children,
}: {
  /** Section title in the built-in header. */
  title?: ReactNode;
  /** @deprecated Cards carry no explanatory hint; ignored. */
  hint?: ReactNode;
  /** Raw header content — replaces the title/hint block when given. */
  header?: ReactNode;
  /** Footer slot, separated by a top border. */
  footer?: ReactNode;
  /** Body padding: 16 (the card padding) or 12 for a dense list card. */
  padding?: "p-3" | "p-4";
  className?: string;
  children: ReactNode;
}) {
  const hasHeader = header != null || title != null;
  return (
    <section className={cn("rounded-card border border-border bg-surface", className)}>
      {hasHeader && (
        <header className="px-4 pt-4">
          {header ?? <h2 className="text-ui font-semibold text-text">{title}</h2>}
        </header>
      )}
      <div className={padding}>{children}</div>
      {footer != null && <footer className="px-4 pb-4">{footer}</footer>}
    </section>
  );
}
