import type { ReactNode } from "react";
import { PageTitle } from "@/components/layout/PageTitle";
import { cn } from "@/lib/cn";

/**
 * A page's header: one line. The title on the left — 24 px, 600, the `title`
 * rung (spec §6.6; the comment said 20, appendix E #24) — optionally
 * followed by a grey count or update time and the page's scope (「范围▾」); on
 * the right the page's one primary action and at most two icon buttons or a
 * search box.
 *
 * No subtitle (2026-09-23 plan §4, §7 gate 2). Seven pages opened with a grey
 * sentence about how the system works — 「EviMed 每天替你读 314 个信源…」 — and
 * a reader who wanted any of it could not act on it. What a page needs to
 * explain goes into its empty state or the help, so this component has no
 * place to put a description: `description` is kept on the type only until the
 * last caller is gone, and renders nothing.
 *
 * The title takes the room the actions leave (`min-w-0 line-clamp-2`) and the
 * actions never shrink (`shrink-0`): a long title used to be as wide as its
 * text and pushed 「问这条证据」 under itself, at the left (R19, audit D C5). The
 * title's basis is 12 rem, so the actions drop to a row of their own only when a
 * phone has not even that much left beside them.
 *
 * `titleVariant="document"` is the reader's title: the serif rung (24 / 600,
 * `text-doc-title`), one of the three places the serif is allowed (an evidence
 * card, an event, a report — `DESIGN.md`).
 */
export function PageHeader({
  title,
  meta,
  actions,
  scope,
  titleVariant = "page",
  documentTitle,
  className,
}: {
  title: string;
  /** @deprecated Pages carry no subtitle; ignored. */
  description?: ReactNode;
  /** A grey count or update time after the title (「29 条」「22:40 更新」). */
  meta?: ReactNode;
  /** The page's primary action and at most two icon buttons or a search box. */
  actions?: ReactNode;
  /** The page's scope after the title: a `ScopeMenu` (whose things the page shows). */
  scope?: ReactNode;
  titleVariant?: "page" | "document";
  /**
   * The browser tab's name, when it should differ from the heading; `false` when the page names its tab elsewhere (a split view, whose
   * list column and open record each draw a header, names its tab once, from the record that is open).
   */
  documentTitle?: string | false;
  className?: string;
}) {
  return (
    <header data-page-header="" className={cn("flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {documentTitle !== false && <PageTitle page={documentTitle ?? title} />}
      {/* `flex-wrap`: a count or a scope that does not fit beside the title goes under it; the title is never squeezed into two lines to make room. */}
      <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1 className={cn(titleVariant === "document" ? DOCUMENT_TITLE_CLASS : PAGE_TITLE_CLASS, "min-w-0 line-clamp-2")}>{title}</h1>
        {meta && <span className="shrink-0 text-caption tabular-nums text-text-3">{meta}</span>}
        {scope && <div className="shrink-0 self-center">{scope}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The class every page H1 wears, for the few that cannot use `PageHeader`. */
export const PAGE_TITLE_CLASS = "text-title font-semibold text-text";

/** The serif title of a document: an evidence card, an event, a report. */
export const DOCUMENT_TITLE_CLASS = "text-doc-title font-semibold text-text";
