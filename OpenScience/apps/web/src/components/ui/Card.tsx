import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one card container (P2-1, spec §7): rounded-card + border + surface +
 * shadow-card, a p-4/p-5 padding scale, and optional header (title + hint, or
 * a raw slot) / footer slots. Page sections compose from this instead of
 * re-declaring the same box classes.
 */
export function Card({
  title,
  hint,
  header,
  footer,
  padding = "p-5",
  className,
  children,
}: {
  /** Serif section title in the built-in header. */
  title?: ReactNode;
  /** Muted one-liner under the title. */
  hint?: ReactNode;
  /** Raw header content — replaces the title/hint block when given. */
  header?: ReactNode;
  /** Footer slot, separated by a top border. */
  footer?: ReactNode;
  /** Body padding: p-5 for page sections, p-4 for denser cards. */
  padding?: "p-4" | "p-5";
  className?: string;
  children: ReactNode;
}) {
  const hasHeader = header != null || title != null || hint != null;
  return (
    <section className={cn("rounded-card border border-border bg-surface shadow-card", className)}>
      {hasHeader && (
        <header className="border-b border-border px-5 py-3">
          {header ?? (
            <>
              {title != null && <h2 className="font-serif text-body text-text">{title}</h2>}
              {hint != null && <p className="mt-0.5 text-ui-sm text-muted">{hint}</p>}
            </>
          )}
        </header>
      )}
      <div className={padding}>{children}</div>
      {footer != null && <footer className="border-t border-border px-5 py-3">{footer}</footer>}
    </section>
  );
}
