import type { ReactNode } from "react";
import { PageTitle } from "@/components/layout/PageTitle";
import { cn } from "@/lib/cn";

/**
 * A page's header: one line. The title on the left — 20 px, 600 — optionally
 * followed by a grey count or update time; on the right the page's one primary
 * action and at most two icon buttons or a search box.
 *
 * No subtitle (2026-09-23 plan §4, §7 gate 2). Seven pages opened with a grey
 * sentence about how the system works — 「EviMed 每天替你读 314 个信源…」 — and
 * a reader who wanted any of it could not act on it. What a page needs to
 * explain goes into its empty state or the help, so this component has no
 * place to put a description: `description` is kept on the type only until the
 * last caller is gone, and renders nothing.
 */
export function PageHeader({
  title,
  meta,
  actions,
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
  /** The browser tab's name, when it should differ from the heading. */
  documentTitle?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex min-h-8 flex-wrap items-center justify-between gap-3", className)}>
      <PageTitle page={documentTitle ?? title} />
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
        {meta && <span className="text-caption tabular-nums text-text-3">{meta}</span>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The class every page H1 wears, for the few that cannot use `PageHeader`. */
export const PAGE_TITLE_CLASS = "text-title font-semibold text-text";
