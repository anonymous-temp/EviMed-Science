import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/cn";

/**
 * A page's one container.
 *
 * Every page sits in one of the three columns with the same gutter, so the
 * title, the filter row, the first letter of every list and the empty state
 * share one left edge across the whole product (2026-09-23 plan §4, §5.1).
 * Measured before: the inbox sat 126 px right of every other page because it
 * chose 748 where the rest chose 1000, and a page whose `<h1>` and body were
 * in two containers stepped sideways as it scrolled.
 *
 * `width="wide"` is the dashboard column (1200, DESIGN.md): a data page
 * squeezed into a document column is half of why 循证 GEO looked cheap.
 * `width="full"` is for the page that lays itself out (a split view) and
 * still shares the gutter. The retired names `narrow` and `content` resolve
 * to the list column.
 *
 * ```tsx
 * <PageShell title="知识库" actions={<Button…/>}>
 *   …
 * </PageShell>
 * ```
 */

/**
 * `page` (1040) is the list column, `wide` (1200) the dashboard column, `full`
 * lets a page lay itself out. `narrow` and `content` are retired names of
 * `page`.
 */
export type PageWidth = "page" | "wide" | "full" | "narrow" | "content";

export function PageShell({
  title,
  meta,
  actions,
  documentTitle,
  width = "page",
  className,
  contentClassName,
  children,
}: {
  title: string;
  /** @deprecated Pages carry no subtitle; ignored. */
  description?: ReactNode;
  /** A grey count or update time after the title. */
  meta?: ReactNode;
  /** The page's primary action and at most two icon buttons or a search box. */
  actions?: ReactNode;
  /** The browser tab's name, when it should differ from the heading. */
  documentTitle?: string;
  width?: PageWidth;
  /** Classes for the scroll container (the page ground). */
  className?: string;
  /** Classes for the inner column — spacing between the header and the body. */
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("h-full min-h-0 overflow-y-auto bg-bg", className)}>
      {/* One box: the page gutter (24 px) and the one column, so the header
          and the body cannot disagree about where the left edge is. */}
      <div className={cn("mx-auto w-full px-6 py-6", width === "full" ? "max-w-none" : width === "wide" ? "max-w-wide" : "max-w-page")}>
        <PageHeader title={title} meta={meta} actions={actions} documentTitle={documentTitle} />
        <div className={cn("mt-6", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
