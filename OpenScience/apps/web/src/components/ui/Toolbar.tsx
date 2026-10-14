import type { InputHTMLAttributes, ReactNode } from "react";
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

export function Toolbar({ label = "筛选与操作", views, filters = [], onClear, search, summary, actions, className }: ToolbarProps) {
  const narrow = useNarrow();
  const active = filters.filter(isActive).length;
  const searching = Boolean(search?.value);
  const controls = (
    <>
      {narrow && filters.length > 0 ? (
        <Menu label="筛选" align="start" items={foldedEntries(filters)}>
          <FilterChip menu pressed={active > 0} aria-label={active > 0 ? `筛选，已选 ${active} 项` : "筛选"}>
            {active > 0 ? `筛选 · ${active}` : "筛选"}
          </FilterChip>
        </Menu>
      ) : filters.map((filter, index) => <Inline key={`${filter.kind}-${filter.label}-${index}`} filter={filter} />)}
      {onClear && (active > 0 || searching) && <FilterChip onClick={onClear}>清除筛选</FilterChip>}
    </>
  );
  const end = (search || summary != null || actions) && (
    <div className="ml-auto flex min-w-0 max-sm:basis-full items-center gap-2">
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
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      )}
      {summary != null && <span className="shrink-0 text-caption tabular-nums text-text-3">{summary}</span>}
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
        <div className="flex min-h-sm flex-wrap items-center gap-x-1 gap-y-2">
          {controls}
          {end}
        </div>
      )}
    </div>
  );
}
