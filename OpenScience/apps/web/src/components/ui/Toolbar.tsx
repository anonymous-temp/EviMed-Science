import { useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";
import { FilterChip, FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { useNarrow } from "@/lib/useMediaQuery";

/**
 * The one row of controls above the content they control (R19, plan §2.2 rule 1; audit D C1, §3.1).
 *
 * Four pages each made their own: geo's `FilterRow`, vcr's `VcrToolbar`, the memory map's `MapFilters` and `Tabs trailing`
 * (the frontier's), and a fifth shape — chips written straight into the body — put 12 of them under the content they filter
 * or in the middle of a 6,000 px page. This is the one component for all of them, and `PageShell`'s `toolbar` slot is where it
 * stands: above the body, inside the sticky band, so it neither scrolls away nor sinks.
 *
 * What a toolbar may hold is the list below, in this order, left to right (and top to bottom on a phone):
 *
 *  - `views` — the page's views as underlined tabs (a single row; a page has one: with `PageShell`'s `tabs` slot there is no
 *    `views` here);
 *  - `filters` — declared, not drawn: a `select` (one dimension as a menu chip), `chips` (a short single choice as a row of
 *    chips) and a `toggle` (an on/off chip, or a narrowing mark that lets go with a press). The toolbar draws them, so a page
 *    cannot reach for `FilterChips` and put its own row somewhere else; and below 640 px it folds them into one 「筛选」 chip
 *    that opens a menu, so a phone is never given four rows of chips;
 *  - at the far end `search`, `summary` (the count of what is listed) and `actions` (buttons for this list: 下载, 管理关注).
 *
 * In the sticky band (`inBand`, which `PageShell` sets) the row is one row, always: a module's band is the same height on every tab
 * (DESIGN.md rule 9), and a tab whose real data gave its filters, its search and its count more width than the row has made its band a
 * line taller (the walk's `module-chrome`, 循证 GEO's 问题与回答, 2026-10-18). When the controls do not fit one line the filters fold into
 * the one 「筛选」 chip, as on a phone, and unfold when the row has grown past the width where they did not fit; the page's own views
 * (`pinned`) and the search, count and actions stay where they are.
 *
 * `onClear` makes a 「清除筛选」 chip appear while any filter or the search is on, and lets go of all of them.
 * `data-toolbar` is what the walk and `pageComposition.test.tsx` read: the first toolbar must come before the body in the
 * document, and a page has at most one in the band.
 */
export interface ToolbarViews {
  /** The tab list's accessible name (「动态视图」). */
  label: string;
  items: readonly TabItem[];
  value: string;
  onChange(value: string): void;
  panelId?: string;
}

export interface ToolbarSelect {
  kind: "select";
  /** The dimension's name: the chip's text while nothing is chosen, the folded menu's heading. */
  label: string;
  options: readonly FilterOption[];
  value: string | null;
  onChange(value: string | null): void;
  /** The option that clears the choice (「全部栏目」). Absent: the choice cannot be cleared. */
  allLabel?: string;
  /** A contextual View selector stays explicit when other filters fold. */
  pinned?: boolean;
}

export interface ToolbarChips {
  kind: "chips";
  label: string;
  options: readonly FilterOption[];
  value: string;
  onChange(value: string): void;
  /** The value that is not filtering anything, for the folded chip's count. Default: the first option's. */
  neutral?: string;
  /** Chips drawn inline; the rest go under 「更多」. Default 6. */
  maxVisible?: number;
  /** A grey word after the chips (the time a ranking was taken). */
  note?: string;
  /**
   * Stays on the row on a phone, where every other filter folds into the one 「筛选」 chip: the page's own views (the memory map's five,
   * the knowledge graph's two), which a person has to reach without opening a menu. A few short chips; a long row does not fit a phone.
   */
  pinned?: boolean;
}

export interface ToolbarToggle {
  kind: "toggle";
  label: string;
  pressed: boolean;
  onChange(pressed: boolean): void;
  icon?: LucideIcon;
}

export type ToolbarFilter = ToolbarSelect | ToolbarChips | ToolbarToggle;

export interface ToolbarSearch {
  label: string;
  value: string;
  onChange(value: string): void;
  onClear?: () => void;
  placeholder?: string;
  maxLength?: number;
  /** What the input needs besides: IME composition handlers, a `name`. */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size" | "value" | "onChange" | "className" | "placeholder" | "maxLength">;
}

export interface ToolbarProps {
  /** The group's accessible name. */
  label?: string;
  views?: ToolbarViews;
  filters?: readonly ToolbarFilter[];
  /** Lets go of every filter and the search; its chip shows only while one is on. */
  onClear?: () => void;
  search?: ToolbarSearch;
  /** What the list holds, as a short count (「38 条结论」). A number that can be opened is a link of the caller's. */
  summary?: ReactNode;
  /** Buttons for this list. */
  actions?: ReactNode;
  className?: string;
  /** The toolbar stands in the sticky band, so its row never wraps: what does not fit folds (`PageShell` sets it). */
  inBand?: boolean;
}

function isActive(filter: ToolbarFilter): boolean {
  if (filter.kind === "select") return filter.value !== null;
  if (filter.kind === "toggle") return filter.pressed;
  return filter.value !== (filter.neutral ?? filter.options[0]?.value);
}

function Inline({ filter }: { filter: ToolbarFilter }) {
  if (filter.kind === "select") {
    return <FilterSelect label={filter.label} allLabel={filter.allLabel} options={filter.options} value={filter.value} onChange={filter.onChange} />;
  }
  if (filter.kind === "chips") {
    return (
      <FilterChips
        label={filter.label}
        options={filter.options}
        value={filter.value}
        onChange={filter.onChange}
        maxVisible={filter.maxVisible}
        trailing={filter.note ? <span className="text-caption text-text-3">{filter.note}</span> : undefined}
      />
    );
  }
  return <FilterChip pressed={filter.pressed} icon={filter.icon} onClick={() => filter.onChange(!filter.pressed)}>{filter.label}</FilterChip>;
}

/** The filters as one menu: a group per dimension under its name, the toggles as checkable items. */
function foldedEntries(filters: readonly ToolbarFilter[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const filter of filters) {
    if (filter.kind === "toggle") {
      entries.push({ label: filter.label, icon: filter.icon, toggle: true, checked: filter.pressed, onSelect: () => filter.onChange(!filter.pressed) });
      continue;
    }
    if (entries.length > 0) entries.push("separator");
    entries.push({ heading: filter.label });
    if (filter.kind === "select") {
      if (filter.allLabel) entries.push({ label: filter.allLabel, checked: filter.value === null, onSelect: () => filter.onChange(null) });
      for (const option of filter.options) entries.push({ label: option.label, checked: option.value === filter.value, onSelect: () => filter.onChange(option.value) });
    } else {
      for (const option of filter.options) entries.push({ label: option.label, checked: option.value === filter.value, onSelect: () => filter.onChange(option.value) });
    }
  }
  return entries;
}

/** A row of one line is 28 px of controls; a wrapped one is at least two of them and a gap. */
const ONE_LINE_MAX = 44;

/**
 * Whether the row's controls take more than one line, and so must fold — in the band only. Measured from the layout, so a test without
 * one (jsdom) never folds. Unfolding is tried again when the row has grown past the width at which it last wrapped.
 */
function useCrowded(row: RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const [crowded, setCrowded] = useState(false);
  // The width of the row when the unfolded controls last wrapped: unfolding is only tried above it.
  const failedAt = useRef(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!enabled || !element) { if (crowded) setCrowded(false); return undefined; }
    const check = () => {
      const width = element.clientWidth;
      if (!crowded) {
        if (element.offsetHeight > ONE_LINE_MAX) { failedAt.current = width; setCrowded(true); }
      } else if (width > failedAt.current + 8) {
        setCrowded(false);
      }
    };
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [row, enabled, crowded]);
  return enabled && crowded;
}

export function Toolbar({ label = "筛选与操作", views, filters: declared = [], onClear, search, summary, actions, className, inBand = false }: ToolbarProps) {
  const narrow = useNarrow();
  const row = useRef<HTMLDivElement>(null);
  // A row with views is the tab row, which lays its own trailing controls out (`Tabs`); only a toolbar of its own can be crowded.
  const crowded = useCrowded(row, inBand && !views && !narrow);
  const fold = narrow || crowded;
  // On a phone, and where the band's row is full, the filters fold into one chip — all but the pinned views, which stay as the chips they are.
  const kept = fold ? declared.filter((filter) => (filter.kind === "chips" || filter.kind === "select") && filter.pinned) : [];
  const filters = fold ? declared.filter((filter) => !kept.includes(filter)) : declared;
  const folded = filters.filter(isActive).length;
  // What 「清除筛选」 lets go of is every filter that is on, the pinned ones too.
  const active = folded + kept.filter(isActive).length;
  const searching = Boolean(search?.value);
  const shrinkSummary = inBand && summary != null;
  // Under the tabs (a phone) the folded chip is the row's first thing, and its text is 12 px in from its ground: it steps out so the
  // text stands on the page's left edge. Without views the whole row does (below).
  const controls = (
    <>
      {/* Keep pinned controls in the same child slot when late filters fold or unfold the row, including an open menu's focus. */}
      {declared.map((filter, index) => !fold || kept.includes(filter) ? <Inline key={`${filter.kind}-${filter.label}-${index}`} filter={filter} /> : null)}
      {fold && filters.length > 0 && (
        <Menu label="筛选" align="start" items={foldedEntries(filters)}>
          <FilterChip menu className={views ? "-ml-3" : undefined} pressed={folded > 0} aria-label={folded > 0 ? `筛选，已选 ${folded} 项` : "筛选"}>
            {folded > 0 ? `筛选 · ${folded}` : "筛选"}
          </FilterChip>
        </Menu>
      )}
      {onClear && (active > 0 || searching) && <FilterChip onClick={onClear}>清除筛选</FilterChip>}
    </>
  );
  // On a phone the search takes what the row has left, in the same row: it used to take a row of its own, and a module's band was
  // 36 px taller on the tabs with a search than on the others (the walk's module-chrome, 循证 GEO at 390 px, r19-guards2).
  const end = (search || summary != null || actions) && (
    <div className={cn("ml-auto flex min-w-0 items-center gap-2", (search || shrinkSummary) && "max-sm:flex-1")}>
      {search && (
        <SearchInput
          size="sm"
          label={search.label}
          value={search.value}
          maxLength={search.maxLength}
          placeholder={search.placeholder}
          onChange={(event) => search.onChange(event.target.value)}
          onClear={search.onClear}
          {...search.inputProps}
          className="min-w-0 flex-1 max-sm:min-w-28 sm:w-56 sm:flex-none"
        />
      )}
      {/* In the band or beside a search, the count gives way before the mobile controls do; its full text remains accessible. */}
      {summary != null && <span title={shrinkSummary && typeof summary === "string" ? summary : undefined} className={cn("text-caption tabular-nums text-text-3 sm:shrink-0", search || shrinkSummary ? "min-w-0 truncate max-sm:flex-1 sm:flex-none" : "shrink-0")}>{summary}</span>}
      {actions}
    </div>
  );
  return (
    <div data-toolbar="" role="group" aria-label={label} className={className}>
      {views ? (
        <Tabs label={views.label} items={views.items} value={views.value} onChange={views.onChange} panelId={views.panelId} trailing={(
          <>
            {controls}
            {end}
          </>
        )} />
      ) : (
        // A chip's text is 12 px in from its ground: the row steps out by that much so the text stands on the page's left edge.
        <div ref={row} className="-ml-3 flex min-h-sm flex-wrap items-center gap-x-1 gap-y-2">
          {controls}
          {end}
        </div>
      )}
    </div>
  );
}
