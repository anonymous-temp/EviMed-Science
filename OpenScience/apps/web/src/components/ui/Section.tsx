import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one block heading of a page or a tab (R19, plan §3): the heading at 18 / 600, a count after it and, at the far end, a
 * slot for the controls of that block alone — a `Toolbar` over one table, a 「下载」 button. It replaces `TabSection` (geo),
 * `VcrSection` (vcr) and the `Panel` title that outsized its box; the same heading drawn four ways was four chances at a type
 * size of its own.
 *
 * `level="sub"` is the nested case: a block inside a block takes the 14 / 600 rung and the next heading level, so the outline
 * still reads page title, block, part — and a section never adds a size beyond the four a page may hold.
 *
 * ```tsx
 * <Section title="试验先例" count={12} toolbar={<Toolbar filters={…} />}>
 *   <DataTable … />
 * </Section>
 * ```
 */
export function Section({ title, count, toolbar, level = "section", className, children }: {
  title: string;
  /** A grey count at the heading's end: 12, or 「3 / 12」. */
  count?: number | string;
  /** The controls of this block alone, at the heading's far end. */
  toolbar?: ReactNode;
  level?: "section" | "sub";
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const Heading = level === "sub" ? "h3" : "h2";
  return (
    <section aria-labelledby={headingId} className={cn(level === "sub" ? "mt-6 first:mt-0" : "mt-8 first:mt-0", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <Heading id={headingId} className={cn("min-w-0 font-semibold text-text", level === "sub" ? "text-ui" : "text-section")}>{title}</Heading>
          {count !== undefined && <span className="shrink-0 text-caption tabular-nums text-text-3">{count}</span>}
        </div>
        {toolbar}
      </div>
      {children}
    </section>
  );
}
