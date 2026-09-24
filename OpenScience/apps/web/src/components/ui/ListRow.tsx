import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";

/**
 * A list of like things — notices, memories, sources, schedules, projects —
 * as rows without a box (2026-09-23 plan §4). A card is for unlike content;
 * a list of six notifications drawn as six bordered cards with two buttons
 * each was the loudest thing on the inbox.
 *
 * A row opens with a click anywhere on it: its title is the link or button,
 * stretched over the row, so the whole row is one target and a keyboard user
 * still lands on a real control. Secondary actions — two icon buttons at
 * most — appear on hover or focus; a 「⋯」 `menu` stays visible, quietly.
 * Anything fixed-width goes in `leading` (an icon, a dot, a time column) so
 * every title in the list starts on one vertical line; variable-width
 * metadata goes under the title (`meta`) or at the end (`trailing`).
 */
export function List({
  label,
  divided = false,
  className,
  children,
}: {
  /** The list's accessible name, when the heading above it does not give one. */
  label?: string;
  /** Hairlines between rows; otherwise spacing alone separates them. */
  divided?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    // A divided list's rule is each row's top border, and a row's 8 px corner
    // bent both ends of it; rows between rules are square.
    <ul aria-label={label} className={cn("flex flex-col", divided && "divide-y divide-border [&>li]:rounded-none", className)}>
      {children}
    </ul>
  );
}

export function ListRow({
  title,
  to,
  href,
  onOpen,
  leading,
  meta,
  trailing,
  actions,
  menu,
  unread = false,
  muted = false,
  className,
}: {
  title: ReactNode;
  /** An in-app route the row opens. */
  to?: string;
  /** An outside address the row opens in a new tab. */
  href?: string;
  /** Opens the row, when it is neither a route nor an address. */
  onOpen?: () => void;
  /** Fixed-width content before the title. */
  leading?: ReactNode;
  /** The line under the title. */
  meta?: ReactNode;
  /** Right-aligned, always visible: a time, a score, a switch. */
  trailing?: ReactNode;
  /** At most two icon buttons, shown on hover or focus. */
  actions?: ReactNode;
  /** A `Menu`, always visible. */
  menu?: ReactNode;
  /** Unread: the title is set in the medium weight. */
  unread?: boolean;
  /** Read or inactive: the title steps down to the secondary colour. */
  muted?: boolean;
  className?: string;
}) {
  // The global focus ring stays on the title itself; the stretched pseudo
  // element only widens where a pointer can press it.
  const stretched = "after:absolute after:inset-0 after:rounded after:content-['']";
  const titleClass = cn(
    "min-w-0 text-left text-ui",
    unread ? "font-medium text-text" : muted ? "text-text-2" : "text-text",
  );
  // `data-row-title` is what the release walk measures: every title in a
  // list must start on one left edge (scripts/ops/ui-walk.mjs).
  const heading = to ? (
    <Link to={to} data-row-title className={cn(titleClass, stretched)}>{title}</Link>
  ) : href ? (
    <a href={href} target="_blank" rel="noreferrer" data-row-title className={cn(titleClass, stretched)}>{title}</a>
  ) : onOpen ? (
    <button type="button" onClick={onOpen} data-row-title className={cn(titleClass, stretched)}>{title}</button>
  ) : (
    <span data-row-title className={titleClass}>{title}</span>
  );
  const interactive = Boolean(to || href || onOpen);
  return (
    <li className={cn("group/row relative flex items-start gap-3 rounded px-2 py-3", interactive && "hover:bg-surface-1", className)}>
      {leading && <div className="flex shrink-0 items-center self-stretch">{leading}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {heading}
        {meta && <div className="min-w-0 text-caption text-text-3">{meta}</div>}
      </div>
      {(trailing || actions || menu) && (
        // Above the stretched title, so its own controls stay clickable.
        <div className="relative z-10 flex shrink-0 items-center gap-1 self-center">
          {actions && (
            <div className="flex items-center gap-1 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-focus-within/row:opacity-100 max-lg:opacity-100">
              {actions}
            </div>
          )}
          {trailing && <div className="flex items-center gap-2 text-caption text-text-3">{trailing}</div>}
          {menu}
        </div>
      )}
    </li>
  );
}
