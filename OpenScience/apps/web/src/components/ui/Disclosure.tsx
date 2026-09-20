import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The one collapse (the sibling platform's §6 rule: folding has one
 * implementation). A native `<details>`: keyboard, Enter/Space and the
 * expanded state come from the browser rather than from a hand-rolled button
 * that each page got slightly wrong. The chevron turns with the state and is
 * decoration; the summary text is the control's name.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  return (
    <details className={cn("group", className)} open={defaultOpen || undefined}>
      <summary
        className={cn(
          "flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-ui text-muted hover:text-text [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <ChevronRight size={16} className="shrink-0 transition-transform duration-fast group-open:rotate-90" aria-hidden="true" />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
