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
 *
 * The built-in title is a block heading of a data page and is set as the others are (`ChartCard`, `Section`: 18 / 600). A card that
 * stood among them with a 14 / 600 title made a page carry a heading size more than the four it may hold (R19.2).
 */
/**
 * Component: Card; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Section with optional h2/header, padded body and footer.
 * Variants: p-3 or p-4 body; raw header replaces title.
 * States: Static grouping; children own read/mutation states.
 * Hit area: No built-in action target; supplied child controls own their geometry.
 * Keyboard: No focus stop or key handler added; child controls keep native semantics.
 * Long content: Content is not truncated; callers own oversized children.
 * Theme: Surface and hairline border; no shadow.
 * Responsive: Fluid section with caller-owned width.
 * Verification: Card.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
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
  /** Footer slot below the padded body; no built-in separator. */
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
          {header ?? <h2 className="text-section font-semibold text-text">{title}</h2>}
        </header>
      )}
      <div className={padding}>{children}</div>
      {footer != null && <footer className="px-4 pb-4">{footer}</footer>}
    </section>
  );
}
