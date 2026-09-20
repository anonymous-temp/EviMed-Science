import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/cn";

/**
 * A page's one container.
 *
 * Measured on production (2026-09-20): three pages had five different left
 * edges — 327, 356, 388, 440 and 461 px — because each page chose its own
 * gutter and its own `max-w-*`, and because a page's `<h1>` and its body were
 * in two different containers. A reader scrolling one page saw the text step
 * sideways.
 *
 * So the width is not a page's decision to make twice: `PageShell` puts the
 * title, the description, the actions and the body inside the *same*
 * `mx-auto max-w-…` box, and a page picks the box by name. Anything that needs
 * to escape it — a full-bleed table, a split view — takes `width="full"` and
 * lays itself out, rather than adding a sixth left edge to a page that already
 * has one.
 *
 * ```tsx
 * <PageShell title="知识库" description="上传或导入的资料" actions={<Button…/>}>
 *   …
 * </PageShell>
 * ```
 */

/** The container a page sits in. `content` is the reading measure. */
export type PageWidth = "narrow" | "content" | "wide" | "full";

const widthClasses: Record<PageWidth, string> = {
  narrow: "max-w-content-narrow", // settings and forms
  content: "max-w-content", // reading: a conversation, a report, the inbox
  wide: "max-w-content-wide", // catalogues, ledgers, the evidence matrix
  full: "max-w-none", // the page lays itself out; it still shares the gutter
};

export function PageShell({
  title,
  description,
  actions,
  documentTitle,
  width = "wide",
  className,
  contentClassName,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** The page's primary action and at most two secondary ones. */
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
      {/* One box. The gutter is the page gutter (24 px) and the width is the
          named container, so the header and the body cannot disagree. */}
      <div className={cn("mx-auto w-full px-6 py-6", widthClasses[width])}>
        <PageHeader title={title} description={description} actions={actions} documentTitle={documentTitle} />
        <div className={cn("mt-6", contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
