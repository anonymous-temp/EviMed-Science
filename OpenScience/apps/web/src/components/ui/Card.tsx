import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one card container (P2-1, spec §7): `rounded-card` (12) + a hairline +
 * the surface, no shadow — a static card's border is its whole edge — 16 px
 * padding, and optional header (title + hint, or a raw slot) / footer slots.
 * Page sections compose from this instead of re-declaring the same box.
 *
 * The title is the sans `ui` rung at 600, not a serif heading: a card is a
 * grouping, not a document, and the shell has one type ladder now.
 */
export function Card({
  title,
  hint,
  header,
  footer,
  padding = "p-4",
  className,
  children,
}: {
  /** Section title in the built-in header. */
  title?: ReactNode;
  /** Quiet one-liner under the title. */
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
  const hasHeader = header != null || title != null || hint != null;
  return (
    <section className={cn("rounded-card border border-border bg-surface", className)}>
      {hasHeader && (
        <header className="border-b border-border px-4 py-3">
          {header ?? (
            <>
              {title != null && <h2 className="text-ui font-semibold text-text">{title}</h2>}
              {hint != null && <p className="mt-1 text-caption text-muted">{hint}</p>}
            </>
          )}
        </header>
      )}
      <div className={padding}>{children}</div>
      {footer != null && <footer className="border-t border-border px-4 py-3">{footer}</footer>}
    </section>
  );
}
