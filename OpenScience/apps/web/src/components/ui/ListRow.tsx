import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
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
 * still lands on a real control. Secondary actions — two quiet controls at
 * most — and a 「⋯」 `menu` are always visible.
 * Anything fixed-width goes in `leading` (an icon, a dot, a time column) so
 * every title in the list starts on one vertical line; variable-width
 * metadata goes under the title (`meta`) or at the end (`trailing`).
 *
 * A row that can be pressed says so (R13 V-10; the owner's 「点不进去」):
 *
 * - **Hover** is `surface-2` and **selected** (`selected`, a master/detail list's
 *   open item) is `accent-soft` with `aria-current`. Hover on the page ground
 *   (`surface-1`) was a step the eye could not see.
 * - **A trailing mark**, drawn by the row itself, in `text-3`, from what the row does:
 *   「›」 when it opens something (`to`, or `onOpen` without `expanded`: a drawer, a
 *   page, a conversation), 「⌄」 turned over while open when it expands in place
 *   (`onOpen` with `expanded` defined), 「↗」 when it leaves for an outside address
 *   (`href`, a new tab: a different arrow, because the reader does not stay).
 *   A page does not draw its own arrow; `chevron={false}` is for the row whose press
 *   is not an opening (a 「返回上级」 row).
 * - **`trailing` does not swallow the press.** Text, a time or a Tag there lets the
 *   click through to the row; a real control placed there (a switch, a button) stays
 *   clickable. `actions` and `menu` are the places a control belongs.
 * - **What a row opens answers what the row says** (page-structure rule 6): a row
 *   with a count opens the things counted; a row that has nothing to open is not given
 *   `onOpen`.
 *
 * Numbers that belong to one measure down the list — a count of citations, of errors —
 * are `columns`: right-aligned, tabular, 96 px each, with a `ListHeader` above the list
 * naming them (and sorting by them) in the same widths. They sit at the row's end, after
 * `trailing`, so a wider `trailing` never moves a column. A cell with `onOpen` is a
 * button of its own (a red count that opens the thing counted); a cell without one lets
 * the press through to the row. Under 640 px the header becomes a line of sort buttons
 * and each row's cells wrap under its title, each with its label.
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

/** One numeric column of a list: what it counts, named in the header and for a screen reader. */
export interface ListColumn {
  key: string;
  label: string;
  /** The header makes this column a sort control. */
  sortable?: boolean;
}

/** A row's value in one column. */
export interface ListCell {
  key: string;
  /** What the column counts, as the header says it. */
  label: string;
  value: ReactNode;
  /** `danger` for a count of what went wrong: red, and the one red thing on the row. */
  tone?: "danger";
  /** The value is a button of its own: it opens what it counts. */
  onOpen?: () => void;
}

/** A column is 96 px wide, in the header and in every row, so they line up (「讲错的回答」 and the sort arrow fit). */
const COLUMN_WIDTH = "w-24";
/** Where a row's mark stands; a list with columns keeps the room when a row has no mark, so the columns stay in line. */
const MARK_WIDTH = "w-4";
/** What stays pressable inside content that lets the press through. */
const CONTROLS = "[&_:is(a,button,input,select,textarea,label,[role=switch],[role=button],[role=menuitem])]:pointer-events-auto";

/**
 * The header of a list with `columns`: the same widths as the rows, each sortable column a button. The active one
 * carries an arrow (shape, not only colour) and `aria-pressed`; pressing the active column again reverses it.
 * The page owns the order — this only reports which column was pressed.
 */
export function ListHeader({
  columns,
  sort,
  onSort,
  label = "排序",
  className,
}: {
  columns: ReadonlyArray<ListColumn>;
  /** The active sort: a column's key and whether it runs from most to least. */
  sort?: { key: string; descending: boolean };
  onSort?: (key: string) => void;
  /** The group's accessible name. */
  label?: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex items-center gap-3 px-2 pb-1 text-caption text-text-3 max-sm:flex-wrap max-sm:gap-x-4", className)}>
      <div className="min-w-0 flex-1 max-sm:hidden" />
      {columns.map((column) => {
        const active = sort?.key === column.key;
        const Arrow = active && !sort.descending ? ArrowUp : ArrowDown;
        const name = active ? `按${column.label}排序，当前${sort.descending ? "从多到少" : "从少到多"}` : `按${column.label}排序`;
        return (
          <div key={column.key} className={cn(COLUMN_WIDTH, "flex justify-end max-sm:w-auto")}>
            {column.sortable && onSort ? (
              <button
                type="button"
                aria-pressed={active}
                aria-label={name}
                onClick={() => onSort(column.key)}
                className={cn("inline-flex items-center gap-0.5 rounded px-1 hover:bg-surface-2", active && "text-text")}
              >
                {column.label}
                {active && <Arrow size={16} aria-hidden="true" />}
              </button>
            ) : <span className="px-1">{column.label}</span>}
          </div>
        )
      })}
      <div className={cn(MARK_WIDTH, "shrink-0 max-sm:hidden")} />
    </div>
  );
}

export function ListRow({
  title,
  to,
  href,
  onOpen,
  expanded,
  selected = false,
  chevron,
  columns,
  leading,
  meta,
  trailing,
  actions,
  menu,
  unread = false,
  muted = false,
  titleProps,
  className,
}: {
  title: ReactNode;
  /** An in-app route the row opens. */
  to?: string;
  /** An outside address the row opens in a new tab. */
  href?: string;
  /**
   * Opens the row, when it is neither a route nor an address. Beside `to` or
   * `href` it runs as the row is followed: a notice marks itself read on the
   * way to the conversation it names.
   */
  onOpen?: () => void;
  /** A row that opens in place (its detail under the title): whether it is open now. */
  expanded?: boolean;
  /** The open item of a master/detail list: `accent-soft`, and `aria-current` on the title. */
  selected?: boolean;
  /**
   * Whether the row draws its trailing mark (›, ⌄ or ↗, from what it does). On by default for a row that can be pressed;
   * `false` for a row whose press is not an opening.
   */
  chevron?: boolean;
  /** Numeric columns, right-aligned and in line down the list; the page draws a `ListHeader` over them. */
  columns?: ReadonlyArray<ListCell>;
  /** Fixed-width content before the title. */
  leading?: ReactNode;
  /** The line under the title. */
  meta?: ReactNode;
  /** Right-aligned, always visible: a time, a score, a switch. */
  trailing?: ReactNode;
  /**
   * At most two quiet controls, always shown: an action that appears only
   * under the pointer reads as missing (owner, 2026-09-24).
   */
  actions?: ReactNode;
  /** A `Menu`, always visible. */
  menu?: ReactNode;
  /**
   * Unread: the title is set in 600. Not 500 — Microsoft YaHei has no 500 cut,
   * so on Windows a 500 title renders at 400 and unread looked read (spec
   * §5.3, appendix E #27).
   */
  unread?: boolean;
  /** Read or inactive: the title steps down to the secondary colour. */
  muted?: boolean;
  /** A `data-*` hook or `aria-current` on the title control — what a test or a master/detail page addresses a row by. */
  titleProps?: { [attribute: `data-${string}`]: string | undefined; "aria-current"?: "true" | "page" | undefined };
  className?: string;
}) {
  // The global focus ring stays on the title itself; the stretched pseudo
  // element only widens where a pointer can press it.
  const stretched = "after:absolute after:inset-0 after:rounded after:content-['']";
  const titleClass = cn(
    "min-w-0 text-left text-ui",
    unread ? "font-semibold text-text" : muted ? "text-text-2" : "text-text",
  );
  // `aria-current` follows `selected`; an explicit one in `titleProps` (a page that says `page`) wins.
  const current = selected ? { "aria-current": "true" as const } : {};
  // `data-row-title` is what the release walk measures: every title in a
  // list must start on one left edge (scripts/ops/ui-walk.mjs).
  const heading = to ? (
    <Link to={to} onClick={onOpen} data-row-title className={cn(titleClass, stretched)} {...current} {...titleProps}>{title}</Link>
  ) : href ? (
    <a href={href} target="_blank" rel="noreferrer" onClick={onOpen} data-row-title className={cn(titleClass, stretched)} {...current} {...titleProps}>{title}</a>
  ) : onOpen ? (
    <button type="button" onClick={onOpen} aria-expanded={expanded} data-row-title className={cn(titleClass, stretched)} {...current} {...titleProps}>{title}</button>
  ) : (
    <span data-row-title className={titleClass} {...current} {...titleProps}>{title}</span>
  );
  const interactive = Boolean(to || href || onOpen);
  // What the row does decides its mark: a route or a drawer opens something (›), an in-place row folds (⌄, turned over while
  // open), an outside address leaves (↗). A row with nothing to press has none.
  const mark = chevron === false || !interactive ? null
    : to ? "open"
      : href ? "away"
        : expanded !== undefined ? "fold" : "open";
  const MarkIcon = mark === "away" ? ArrowUpRight : mark === "fold" ? ChevronDown : ChevronRight;
  const aligned = mark !== null || (columns?.length ?? 0) > 0;
  return (
    <li
      className={cn(
        "relative flex items-start gap-3 rounded px-2 py-3",
        selected ? "bg-accent-soft" : interactive && "hover:bg-surface-2",
        columns?.length && "max-sm:flex-wrap",
        className,
      )}
    >
      {leading && <div className="flex shrink-0 items-center self-stretch">{leading}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {heading}
        {meta && <div className="min-w-0 text-caption text-text-3">{meta}</div>}
      </div>
      {(trailing || actions || menu) && (
        // Above the stretched title, so a control stays clickable; what is only text lets the press through to the row.
        // An open row keeps its controls on its first line, beside the title.
        <div className={cn("pointer-events-none relative z-sticky flex shrink-0 items-center gap-1", expanded ? "self-start" : "self-center")}>
          {actions && <div className="pointer-events-auto flex items-center gap-1">{actions}</div>}
          {trailing && <div className={cn("flex items-center gap-2 text-caption text-text-3", CONTROLS)}>{trailing}</div>}
          {menu && <div className="pointer-events-auto flex">{menu}</div>}
        </div>
      )}
      {columns && columns.length > 0 && (
        <div className="pointer-events-none relative z-sticky flex shrink-0 items-start gap-3 text-ui tabular-nums max-sm:order-last max-sm:basis-full max-sm:gap-4">
          {columns.map((cell) => {
            // The name is in the cell for a screen reader, and for a phone, where the header gives way: a button reads 「讲错的回答 14」.
            const body = (
              <>
                <span className="mr-1 text-caption text-text-3 sm:sr-only">{cell.label}</span>
                <span data-list-value="">{cell.value}</span>
              </>
            );
            return (
              <div key={cell.key} className={cn(COLUMN_WIDTH, "text-right max-sm:w-auto max-sm:text-left", !cell.tone && "text-text-2")}>
                {cell.onOpen ? (
                  <button
                    type="button"
                    onClick={cell.onOpen}
                    data-list-cell={cell.key}
                    className={cn("pointer-events-auto rounded px-1 hover:bg-surface-2", cell.tone === "danger" ? "text-danger" : "text-text")}
                  >
                    {body}
                  </button>
                ) : <span data-list-cell={cell.key} className={cn("px-1", cell.tone === "danger" && "text-danger")}>{body}</span>}
              </div>
            );
          })}
        </div>
      )}
      {aligned && (
        <span aria-hidden="true" className={cn(MARK_WIDTH, "flex shrink-0 justify-end text-text-3", expanded ? "self-start pt-0.5" : "self-center", "max-sm:order-2")}>
          {mark && <MarkIcon size={16} className={cn("transition-transform duration-fast motion-reduce:transition-none", mark === "fold" && expanded && "rotate-180")} />}
        </span>
      )}
    </li>
  );
}
