import type { ReactNode } from "react";
import { PageTitle } from "@/components/layout/PageTitle";
import { cn } from "@/lib/cn";

/**
 * A page's title, said once, at one size.
 *
 * 「运行记录」 was 26 px and 「收件箱」 20 px for no reason a reader could infer
 * (review B §2.5): half the pages used the display rung and half the title
 * rung. Every page H1 is the title rung now; `display` is kept for the login
 * page and empty states, which is what the scale always said it was for. No
 * letter-spacing — tracking on Chinese breaks the character grid.
 */
export function PageHeader({
  title,
  description,
  actions,
  documentTitle,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** The page's primary action and at most two secondary ones. */
  actions?: ReactNode;
  /** The browser tab's name, when it should differ from the heading. */
  documentTitle?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <PageTitle page={documentTitle ?? title} />
      <div className="min-w-0">
        <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-ui text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The class every page H1 wears, for the few that cannot use `PageHeader`. */
export const PAGE_TITLE_CLASS = "font-serif text-title font-semibold text-text";
