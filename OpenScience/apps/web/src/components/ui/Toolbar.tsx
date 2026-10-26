import { isComposingKey, isSubmitKey } from "@/lib/compositionKeys";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { FilterChip, FilterChips, FilterSelect, type FilterOption } from "@/components/ui/FilterChips";
import { IconButton, iconButtonClasses } from "@/components/ui/IconButton";
import { SearchInput } from "@/components/ui/SearchInput";
import { Switch } from "@/components/ui/Switch";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Tooltip, isTruncated } from "@/components/ui/Tooltip";
import * as Popover from "@radix-ui/react-popover";
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
 *  - `filters` — declared, not drawn: a `select` (one dimension as a menu chip), `chips` (a short single choice as a row of chips), a
 *    `toggle` (an on/off chip, or a narrowing mark that lets go with a press) and a `panel` (a chip that opens labelled groups of those,
 *    where a group of chips may also take several values, `multi`: 「专科 ▾」, 「更多筛选 ▾」). The toolbar draws them, so a page cannot
 *    reach for `FilterChips` and put its own row somewhere else;
 *  - at the far end `search`, `summary` (the count of what is listed) and `actions` (buttons for this list: 下载, 管理关注).
 *
 * **Folding** (owner, 2026-10-23: 「发现一个问题解决一类问题」). Below 640 px, and in the band when the row does not fit, the filters fold
 * into one 「筛选」 chip — all but the `pinned` ones, which stay as they are. What it opens is a filter panel and never a menu: every
 * folded dimension is a labelled group of chips (one choice or several, as declared), a panel's groups are its own groups, and the
 * toggles are switches; on a phone it rises from the bottom (「重置」, 「查看结果」), on a wide screen it drops under the chip. It used to
 * be one long menu that stacked 全部栏目 over 全部专科 as one list of thirty-odd lines.
 *
 * In the sticky band (`inBand`, which `PageShell` sets) a row is one row, always: a module's band is the same height on every tab
 * (DESIGN.md rule 9). A `scroll` chip group gives way to the rest of its row by scrolling sideways rather than folding.
 *
 * **One row with a filter button** (`oneRow`, 前沿动态; owner, 2026-10-25: 「不要横着罗列着，顶上弄好几行」). The views at the left and,
 * at the right of the same row, the open view's controls, then what is applied, 「筛选」 and the search last. A filter declared
 * `folded` stays inside 「筛选」 at every width; what is on in it is said on the row as tokens — each a press that lets go of it, at
 * most two and then 「+N」, which opens the panel, and none once the row is short, when the chip's count (「筛选 · 2」, with the accent
 * mark) says it alone. The page's own applied things (`tokens`: a chosen tag with its 「关注」) are tokens of the same kind. On a phone
 * the row is the scrolling views with 「筛选」 and the search as icons — the search opens over the row, the keyboard up — and one more
 * line under it only while something narrows the list (the tokens) or a `pinned` control has to stay in sight; the rest is the
 * sheet, whose first section may be the page's (`sheetLead`). 「/」 puts the cursor in the search (`searchShortcut`).
 *
 * `onClear` makes a 「清除筛选」 chip appear while any filter or the search is on, and lets go of all of them; `onReset` (or `onClear`)
 * is the folded panel's 「重置」. `data-toolbar` is what the walk and `pageComposition.test.tsx` read: the first toolbar must come
 * before the body in the document, and a page has at most one in the band.
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
  /** The dimension's name: the chip's text while nothing is chosen, the folded group's heading. */
  label: string;
  options: readonly FilterOption[];
  value: string | null;
  onChange(value: string | null): void;
  /** The option that clears the choice (「全部栏目」). Absent: the choice cannot be cleared. */
  allLabel?: string;
  /** A contextual View selector stays explicit when other filters fold. */
  pinned?: boolean;
  /** Inside 「筛选」 at every width (`oneRow`). */
  folded?: boolean;
  /** The chip's text while nothing is chosen, where it is not the dimension's name (「全部专区 ▾」). Default `label`. */
  emptyText?: string;
}

interface ToolbarChipsBase {
  kind: "chips";
  label: string;
  options: readonly FilterOption[];
  /** Chips drawn inline; the rest go under 「更多」. Default 6. Ignored by a `scroll` group, which draws them all. */
  maxVisible?: number;
  /** A grey word after the chips (the time a ranking was taken). */
  note?: string;
  /**
   * Stays on the row on a phone, where every other filter folds into the one 「筛选」 chip: the page's own views (the memory map's five,
   * the knowledge graph's two), which a person has to reach without opening a menu.
   */
  pinned?: boolean;
  /** Every chip drawn, in a row that scrolls sideways when its row has no room for them all (前沿动态's nine 栏目). */
  scroll?: boolean;
  /** In a panel: the options under sub-headings, by value (专科's 内科 / 外科 / …); an option in none is drawn after them. */
  sections?: readonly { label: string; values: readonly string[] }[];
  /** In a panel: what the group says while it has no options (「暂无热门标签」). Without it an empty group is not drawn. */
  placeholder?: string;
  /** Inside 「筛选」 at every width (`oneRow`). */
  folded?: boolean;
  /**
   * Not counted on 「筛选」 and no token of its own: what it chooses the page says elsewhere (热门标签 sets the chosen tag, which is the
   * page's own token).
   */
  quiet?: boolean;
}

/** One value. Pressing the chosen chip again lets go of it where no option stands for 「全部」 (a tag). */
export interface ToolbarChips extends ToolbarChipsBase {
  multi?: false;
  value: string;
  onChange(value: string): void;
  /** The value that is not filtering anything, for the folded chip's count. Default: the first option's. */
  neutral?: string;
}

/**
 * Several values at once (专科): each chip is pressed or not, and `onChange` receives the whole new choice. A group of a panel (or of the
 * folded sheet), not a row of its own: a row of chips that several can be pressed in reads as a row of toggles.
 */
export interface ToolbarMultiChips extends ToolbarChipsBase {
  multi: true;
  value: readonly string[];
  onChange(value: string[]): void;
  /** In a panel: a small button beside each chosen value, under the chips (「肿瘤 关注」, 「心血管 已关注」). */
  chosenAction?: (value: string) => ToolbarAction | null;
}

/** Either kind of chip group, as the toolbar draws them. */
type AnyChips = ToolbarChips | ToolbarMultiChips;

/** A small text button beside a chip or a token (「关注」 a chosen tag). */
export interface ToolbarAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
}

export interface ToolbarToggle {
  kind: "toggle";
  label: string;
  pressed: boolean;
  onChange(pressed: boolean): void;
  icon?: LucideIcon;
  /** The icon after the words: a mark a press lets go of (「#肝细胞癌 ×」). */
  iconEnd?: boolean;
  /** Stays on the row when the others fold (a chosen tag, 「#肝细胞癌 ×」). */
  pinned?: boolean;
  /** Inside 「筛选」 at every width (`oneRow`), as a switch. */
  folded?: boolean;
  /** A small text button beside the chip (「关注」 a chosen tag). */
  action?: ToolbarAction;
}

/** A group inside a panel: a choice, several, or an on/off switch. */
export type ToolbarPanelGroup = ToolbarSelect | ToolbarChips | ToolbarMultiChips | ToolbarToggle;

/** A chip that opens labelled groups of filters (「专科 ▾」, 「更多筛选 ▾」): every group applies at once. */
export interface ToolbarPanel {
  kind: "panel";
  /** The chip's text while nothing in it is chosen, and the panel's name. */
  label: string;
  /** What the chip says while something is chosen (「肿瘤 等 3 个」); by default 「label · N」, N the groups that are on. */
  chosen?: string;
  groups: readonly ToolbarPanelGroup[];
  /** Lets go of everything in the panel at once (its 「清除」). Without it each group is let go of in turn. */
  onClear?: () => void;
  pinned?: boolean;
  /** Its groups inside 「筛选」 at every width (`oneRow`). */
  folded?: boolean;
}

export type ToolbarFilter = ToolbarSelect | ToolbarChips | ToolbarToggle | ToolbarPanel;

/**
 * Something applied to the list that the row says as a token (`oneRow`), beside the tokens of what is on in 「筛选」: a press lets go
 * of it. The page's own — a chosen tag with its 「关注」, the one follow a list is narrowed to.
 */
export interface ToolbarToken {
  /** What it says (「#肝细胞癌」, 「只看：肿瘤」); the press is named 「移除筛选：…」. */
  label: string;
  onRemove(): void;
  action?: ToolbarAction;
  /** One of the filters `onReset` lets go of (a chosen tag), so 「清除」 takes it with the others. */
  filter?: boolean;
}

/** The words a search box offers to complete (前沿动态's tags): a list under the box while it is typed in. */
export interface ToolbarSuggestions {
  /** The list's accessible name (「标签建议」). */
  label: string;
  items: readonly { value: string; label: string }[];
  onPick(value: string): void;
}

export interface ToolbarSearch {
  label: string;
  value: string;
  onChange(value: string): void;
  onClear?: () => void;
  /** Enter in the box with no suggestion chosen: search now. */
  onSubmit?: () => void;
  suggestions?: ToolbarSuggestions;
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
  /** Lets go of every filter (not the search): the folded panel's 「重置」. Default `onClear`. */
  onReset?: () => void;
  search?: ToolbarSearch;
  /** What the list holds, as a short count (「38 条结论」). A number that can be opened is a link of the caller's. */
  summary?: ReactNode;
  /** Buttons for this list. */
  actions?: ReactNode;
  className?: string;
  /** The toolbar stands in the sticky band, so its row never wraps: what does not fit folds (`PageShell` sets it). */
  inBand?: boolean;
  /** With `views`: one row at every width, with a filter button that holds the `folded` filters (see the module note). */
  oneRow?: boolean;
  /** `oneRow`: the page's own applied things, said as tokens before 「筛选」. */
  tokens?: readonly ToolbarToken[];
  /** `oneRow`: the first section of the phone's 「筛选」 sheet (关注's followed things); `close` closes the sheet. */
  sheetLead?: (close: () => void) => ReactNode;
  /** How many items the filters leave, where the list says it: the panel's 「共 N 条」 and the sheet's 「查看 N 条」. Never guessed. */
  resultCount?: number;
  /** 「/」 anywhere outside a text field puts the cursor in the search. */
  searchShortcut?: boolean;
}

/* ---------------------------------------------------------------- state */

function chipsNeutral(filter: ToolbarChips): string {
  return filter.neutral ?? filter.options[0]?.value ?? "";
}

/** Whether a group is filtering anything. */
function groupActive(filter: ToolbarPanelGroup): boolean {
  if (filter.kind === "select") return filter.value !== null;
  if (filter.kind === "toggle") return filter.pressed;
  if (filter.multi) return filter.value.length > 0;
  return filter.value !== chipsNeutral(filter);
}

/** Whether a group is on and says so: a `quiet` group's choice is the page's to say. */
function groupCounted(filter: ToolbarPanelGroup): boolean {
  return groupActive(filter) && !(filter.kind === "chips" && filter.quiet);
}

/** How many of a filter's dimensions are on: a panel counts its groups. */
function activeCount(filter: ToolbarFilter): number {
  if (filter.kind === "panel") return filter.groups.filter(groupCounted).length;
  return groupCounted(filter) ? 1 : 0;
}

/** A filter's groups: a panel's own, or the filter itself. */
function groupsOf(filters: readonly ToolbarFilter[]): ToolbarPanelGroup[] {
  return filters.flatMap((filter) => (filter.kind === "panel" ? filter.groups : [filter]));
}

function optionLabel(options: readonly FilterOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** What a group that is on says as a token, and how it lets go: 「临床证据」, 「肿瘤 等 3 个」, 「只看收藏」. */
function groupToken(filter: ToolbarPanelGroup): ToolbarToken | null {
  if (!groupCounted(filter)) return null;
  const onRemove = () => clearGroup(filter);
  if (filter.kind === "toggle") return { label: filter.label, onRemove, filter: true };
  if (filter.kind === "select") return { label: optionLabel(filter.options, filter.value ?? ""), onRemove, filter: true };
  if (filter.multi) {
    const first = optionLabel(filter.options, filter.value[0] ?? "");
    return { label: filter.value.length > 1 ? `${first} 等 ${filter.value.length} 个` : first, onRemove, filter: true };
  }
  return { label: optionLabel(filter.options, filter.value), onRemove, filter: true };
}

/** Lets go of one group. */
function clearGroup(filter: ToolbarPanelGroup): void {
  if (filter.kind === "select") filter.onChange(null);
  else if (filter.kind === "toggle") filter.onChange(false);
  else if (filter.multi) filter.onChange([]);
  else filter.onChange(chipsNeutral(filter));
}

/** Lets go of a panel: its own 「清除」, or each group that is on. */
function clearPanel(panel: ToolbarPanel): void {
  if (panel.onClear) panel.onClear();
  else panel.groups.filter(groupActive).forEach(clearGroup);
}

/** A panel's chip: its name, what is chosen, or how many of its groups are on. */
function panelText(panel: ToolbarPanel): string {
  const on = activeCount(panel);
  if (on === 0) return panel.label;
  return panel.chosen ?? `${panel.label} · ${on}`;
}

/* ---------------------------------------------------------------- chips */

/** A row of chips too wide for its room fades out at the end that still has chips, as a tab row does. */
const END_FADE = "linear-gradient(to right, black calc(100% - 2rem), transparent)";
const FADED: CSSProperties = { maskImage: END_FADE, WebkitMaskImage: END_FADE };

/** A row of every chip of a dimension that scrolls sideways when its room is short: it gives way to the rest of the row. */
function ScrollChips({ filter }: { filter: AnyChips }) {
  const list = useRef<HTMLDivElement>(null);
  const [ahead, setAhead] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const measure = () => setAhead(element.scrollWidth - element.clientWidth - element.scrollLeft > 1);
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => { element.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, [filter.options.length]);
  return (
    <div ref={list} role="group" aria-label={filter.label} style={ahead ? FADED : undefined}
      className="flex min-w-24 flex-initial items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ChipButtons filter={filter} />
    </div>
  );
}

/** The chips of one dimension, one pressed (or several, with `multi`). */
function ChipButtons({ filter, values }: { filter: AnyChips; values?: readonly string[] }) {
  const options = values ? filter.options.filter((option) => values.includes(option.value)) : filter.options;
  return (
    <>
      {options.map((option) => {
        const pressed = filter.multi ? filter.value.includes(option.value) : filter.value === option.value;
        const press = () => {
          if (filter.multi) {
            filter.onChange(pressed ? filter.value.filter((value) => value !== option.value) : [...filter.value, option.value]);
            return;
          }
          const neutral = chipsNeutral(filter);
          // A chosen chip lets go when no chip stands for 「全部」 (a tag); a row with a 全部 is a radio row.
          if (pressed && !filter.options.some((entry) => entry.value === neutral)) filter.onChange(neutral);
          else filter.onChange(option.value);
        };
        return (
          <FilterChip key={option.value} pressed={pressed} onClick={press}>
            {option.label}
            {option.count !== undefined && <span className="tabular-nums text-text-3">{option.count}</span>}
          </FilterChip>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------------- panel */

/** A group's heading inside a panel: 12 / 400 grey, as every block of a panel names itself. */
const GROUP_LABEL = "text-caption text-text-3";

/** A select as the chips a panel draws: its 「全部」 first (value ""), then its options. */
function selectAsChips(filter: ToolbarSelect): ToolbarChips {
  return {
    kind: "chips",
    label: filter.label,
    // 「全部栏目」 is 「全部」 under its own heading.
    options: [...(filter.allLabel ? [{ value: "", label: /^(全部|不限)/.exec(filter.allLabel)?.[1] ?? filter.allLabel }] : []), ...filter.options],
    value: filter.value ?? "",
    neutral: "",
    onChange: (value) => filter.onChange(value === "" ? null : value),
  };
}

function ChipGroup({ filter }: { filter: AnyChips }) {
  const id = useId();
  if (filter.options.length === 0 && !filter.placeholder) return null;
  const placed = new Set((filter.sections ?? []).flatMap((section) => section.values));
  const rest = filter.options.filter((option) => !placed.has(option.value)).map((option) => option.value);
  return (
    <div role="group" aria-labelledby={id} className="space-y-2">
      <p id={id} className={GROUP_LABEL}>{filter.label}</p>
      {filter.options.length === 0 ? (
        <p className="text-ui text-text-3">{filter.placeholder}</p>
      ) : filter.sections?.length ? (
        <div className="space-y-2">
          {filter.sections.map((section) => (
            <div key={section.label} role="group" aria-label={section.label} className="flex items-start gap-2">
              <span aria-hidden="true" className="w-16 shrink-0 pt-1 text-caption text-text-3">{section.label}</span>
              <div className="-ml-1 flex min-w-0 flex-1 flex-wrap gap-1"><ChipButtons filter={filter} values={section.values} /></div>
            </div>
          ))}
          {rest.length > 0 && <div className="-ml-1 flex flex-wrap gap-1"><ChipButtons filter={filter} values={rest} /></div>}
        </div>
      ) : (
        <div className="-ml-3 flex flex-wrap gap-1"><ChipButtons filter={filter} /></div>
      )}
      {filter.multi && filter.chosenAction && filter.value.length > 0 && <ChosenActions filter={filter} />}
    </div>
  );
}

/** Under a group of several: each chosen value with its own small button (「肿瘤 关注」, 「心血管 已关注」). */
function ChosenActions({ filter }: { filter: ToolbarMultiChips }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={GROUP_LABEL}>已选</span>
      {filter.value.map((value) => {
        const label = optionLabel(filter.options, value);
        const action = filter.chosenAction?.(value) ?? null;
        return (
          <span key={value} className="inline-flex items-center gap-1 text-ui text-text">
            {label}
            {action && (
              <Button variant="text" size="sm" className="text-accent" disabled={action.disabled} aria-label={`${action.label}：${label}`}
                onClick={action.onClick}>{action.label}</Button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** A panel's groups: each dimension a labelled group of chips, the on/off ones switches; a panel's own groups in its place. */
function PanelGroups({ filters }: { filters: readonly ToolbarFilter[] }) {
  const groups = filters.flatMap((filter) => (filter.kind === "panel" ? filter.groups : [filter]));
  const toggles = groups.filter((group): group is ToolbarToggle => group.kind === "toggle");
  return (
    <div className="space-y-5">
      {groups.map((group, index) => {
        if (group.kind === "toggle") return null;
        const chips = group.kind === "select" ? selectAsChips(group) : group;
        return <ChipGroup key={`${group.label}-${index}`} filter={chips} />;
      })}
      {toggles.length > 0 && (
        <div className="space-y-1">
          {toggles.map((toggle) => (
            <Switch key={toggle.label} showLabel label={toggle.label} checked={toggle.pressed} onChange={toggle.onChange} className="flex h-8 w-full justify-between" />
          ))}
        </div>
      )}
    </div>
  );
}

/** The floating layer a panel opens in on a wide screen: a card under its chip, on the popover tier. */
const POPOVER = "z-popover w-[min(36rem,calc(100vw-2rem))] max-h-[min(32rem,calc(100vh-8rem))] overflow-y-auto rounded-card border border-border bg-surface p-4 shadow-e2 outline-none animate-menu-in";
/** `oneRow`'s 「筛选」 holds every dimension of the list (the thirty specialties among them): as tall as the window allows, so its last groups are not hidden under a scroll. */
const POPOVER_TALL = cn(POPOVER, "max-h-[min(48rem,calc(100vh-7rem))]");

/** 「专科 ▾」: a chip that opens its groups under it; every choice applies at once, and 「清除」 lets go of all of them. */
function PanelChip({ panel }: { panel: ToolbarPanel }) {
  const on = activeCount(panel) > 0;
  const text = panelText(panel);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <FilterChip menu pressed={on} aria-haspopup="dialog" aria-label={on ? `${panel.label}：${text}` : panel.label}>{text}</FilterChip>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label={panel.label} align="start" side="bottom" sideOffset={4} collisionPadding={8} className={POPOVER}
          onEscapeKeyDown={(event) => event.stopPropagation()}>
          <PanelGroups filters={[panel]} />
          {on && (
            <div className="mt-4 flex justify-end border-t border-border pt-3">
              <Button variant="text" size="sm" onClick={() => clearPanel(panel)}>清除</Button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * 「筛选」: what folded. On a phone a sheet from the bottom with every folded dimension, 「重置」 and 「查看结果」 (the choices apply at
 * once; it only closes); where a wide band's row ran out of room, the same groups in a card under the chip.
 *
 * With `oneRow` the chip carries the accent mark while anything in it is on, the phone's trigger is an icon, the sheet may begin with
 * the page's own section (`lead`) and end with the view's buttons (`extra`), and the open state is the toolbar's, so 「+N」 opens it.
 */
function FoldChip({ filters, count, resettable = count, narrow, onReset, stepOut, open, onOpenChange, mark = false, icon = false, align = "start", lead, extra, resultCount }: {
  filters: readonly ToolbarFilter[];
  count: number;
  /** How many of what is counted 「重置」 / 「清除」 lets go of (a narrowed follow is not a filter). Default `count`. */
  resettable?: number;
  narrow: boolean;
  onReset: () => void;
  stepOut: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mark?: boolean;
  icon?: boolean;
  align?: "start" | "end";
  lead?: (close: () => void) => ReactNode;
  extra?: ReactNode;
  resultCount?: number;
}) {
  const name = count > 0 ? `筛选，已选 ${count} 项` : "筛选";
  const close = () => onOpenChange(false);
  const chip = icon ? (
    <button type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={name} onClick={() => onOpenChange(true)}
      className={iconButtonClasses({ size: "sm", active: count > 0 })}>
      <SlidersHorizontal size={16} aria-hidden="true" />
      {mark && count > 0 && <span aria-hidden="true" data-filter-mark="" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
    </button>
  ) : (
    <FilterChip menu className={stepOut ? "-ml-3" : undefined} pressed={count > 0} aria-haspopup="dialog" aria-expanded={open}
      aria-label={name} onClick={narrow ? () => onOpenChange(true) : undefined}>
      {mark && count > 0 && <span aria-hidden="true" data-filter-mark="" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      {count > 0 ? `筛选 · ${count}` : "筛选"}
    </FilterChip>
  );
  if (narrow) {
    return (
      <>
        {chip}
        {open && (
          <Drawer title="筛选" placement="bottom" onClose={close} footer={(
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" disabled={resettable === 0} onClick={onReset}>重置</Button>
              <Button className="flex-1" onClick={close}>{resultCount !== undefined ? `查看 ${resultCount.toLocaleString("zh-CN")} 条` : "查看结果"}</Button>
            </div>
          )}>
            {lead || extra ? (
              <div className="space-y-5">
                {lead?.(close)}
                {filters.length > 0 && <PanelGroups filters={filters} />}
                {extra && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">{extra}</div>}
              </div>
            ) : <PanelGroups filters={filters} />}
          </Drawer>
        )}
      </>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{chip}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="筛选" align={align} side="bottom" sideOffset={4} collisionPadding={8} className={mark ? POPOVER_TALL : POPOVER}
          onEscapeKeyDown={(event) => event.stopPropagation()}>
          <PanelGroups filters={filters} />
          {(resettable > 0 || resultCount !== undefined) && (
            <div className={cn("mt-4 flex items-center border-t border-border pt-3", resultCount !== undefined ? "justify-between" : "justify-end")}>
              {resettable > 0 ? <Button variant="text" size="sm" onClick={onReset}>清除</Button> : <span />}
              {resultCount !== undefined && <span className="text-caption tabular-nums text-text-3">共 {resultCount.toLocaleString("zh-CN")} 条</span>}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A token: what is applied, as the selected chip's look with a ×, a press letting go of it; and its own small button after it. */
function TokenChip({ token }: { token: ToolbarToken }) {
  return (
    <span className="inline-flex shrink-0 items-center">
      {/* A press removes it: a button, not a toggle, so it has no pressed state of its own. */}
      <FilterChip pressed aria-pressed={undefined} icon={X} iconEnd aria-label={`移除筛选：${token.label}`} className="max-w-48" onClick={token.onRemove}>
        <span className="min-w-0 truncate">{token.label}</span>
      </FilterChip>
      {token.action && (
        <Button variant="text" size="sm" className="shrink-0 text-accent" disabled={token.action.disabled} aria-label={`${token.action.label}：${token.label}`}
          onClick={token.action.onClick}>{token.action.label}</Button>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- inline */

function Inline({ filter }: { filter: ToolbarFilter }) {
  if (filter.kind === "select") {
    return <FilterSelect label={filter.label} emptyText={filter.emptyText} allLabel={filter.allLabel} options={filter.options} value={filter.value} onChange={filter.onChange} />;
  }
  if (filter.kind === "panel") return <PanelChip panel={filter} />;
  if (filter.kind === "chips") {
    const note = filter.note ? <span className="text-caption text-text-3">{filter.note}</span> : null;
    if (filter.scroll) {
      return (
        <>
          <ScrollChips filter={filter} />
          {note}
        </>
      );
    }
    return (
      <FilterChips
        label={filter.label}
        options={filter.options}
        value={filter.value}
        onChange={filter.onChange}
        maxVisible={filter.maxVisible}
        trailing={note ?? undefined}
      />
    );
  }
  return (
    <>
      {/* A mark that lets go (a chosen tag) is cut short on a phone rather than pushing its row past the screen; its name stays whole. */}
      <FilterChip pressed={filter.pressed} icon={filter.icon} iconEnd={filter.iconEnd} aria-label={filter.iconEnd ? filter.label : undefined}
        className={filter.iconEnd ? "max-w-40 sm:max-w-none" : undefined} onClick={() => filter.onChange(!filter.pressed)}>
        {filter.iconEnd ? <span className="min-w-0 truncate">{filter.label}</span> : filter.label}
      </FilterChip>
      {filter.action && (
        <Button variant="text" size="sm" className="shrink-0 text-accent" disabled={filter.action.disabled} onClick={filter.action.onClick}>{filter.action.label}</Button>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- search */

/**
 * The search box, and under it — while it holds words and there are some — the words it offers to complete (a combobox and its
 * list): the arrow keys move through them, Enter takes the one marked or, with none marked, searches the words now; Escape closes
 * the list first and empties the box after.
 */
function SearchBox({ search, inputRef, focusOnMount = false, shortcut = false, onEscapeEmpty }: {
  search: ToolbarSearch;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Opened over a phone's row by a press on its icon: the cursor in it at once, the keyboard up. */
  focusOnMount?: boolean;
  /** 「/」 reaches it (said to assistive technology). */
  shortcut?: boolean;
  /** Escape in an empty box (the phone's search over the row closes). */
  onEscapeEmpty?: () => void;
}) {
  const listId = useId();
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount, input]);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const items = search.suggestions?.items ?? [];
  const open = Boolean(search.suggestions) && focused && !dismissed && search.value.trim() !== "" && items.length > 0;
  const pick = (value: string) => {
    setActive(-1);
    setDismissed(true);
    search.suggestions?.onPick(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    search.inputProps?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setActive((at) => (at + 1) % items.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive((at) => (at <= 0 ? items.length - 1 : at - 1));
    } else if (isSubmitKey(event)) {
      if (open && active >= 0 && items[active]) {
        event.preventDefault();
        pick(items[active].value);
      } else if (search.onSubmit) {
        event.preventDefault();
        setDismissed(true);
        search.onSubmit();
      }
    } else if (event.key === "Escape" && !isComposingKey(event) && open) {
      // The list closes first; the box keeps its words until the next Escape.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    } else if (event.key === "Escape" && !isComposingKey(event) && onEscapeEmpty && search.value === "") {
      event.preventDefault();
      event.stopPropagation();
      onEscapeEmpty();
    }
  };
  const combobox = search.suggestions ? {
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": open && active >= 0 ? `${listId}-${active}` : undefined,
  } : {};
  return (
    <div className="relative flex min-w-0 flex-1 sm:w-56 sm:flex-none">
      <SearchInput
        ref={input}
        size="sm"
        aria-keyshortcuts={shortcut ? "/" : undefined}
        label={search.label}
        value={search.value}
        maxLength={search.maxLength}
        placeholder={search.placeholder}
        onChange={(event) => { setDismissed(false); setActive(-1); search.onChange(event.target.value); }}
        onClear={search.onClear}
        {...search.inputProps}
        {...combobox}
        onKeyDown={onKeyDown}
        onFocus={(event) => { setFocused(true); search.inputProps?.onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); setActive(-1); search.inputProps?.onBlur?.(event); }}
        className="min-w-0 flex-1 max-sm:min-w-28 sm:w-56 sm:flex-none"
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={search.suggestions!.label}
          className="absolute inset-x-0 top-full z-popover mt-1 rounded-card border border-border bg-surface p-1 shadow-e2">
          {items.map((item, index) => (
            // The keyboard is the box's (the arrow keys, Enter, `aria-activedescendant`): an option takes a press of the pointer only.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <li
              key={item.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // The press must not take the focus from the box first: its blur would close the list under the pointer.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(item.value)}
              className={cn("flex h-8 cursor-pointer items-center truncate rounded px-2 text-ui text-text", index === active ? "bg-surface-2" : "hover:bg-surface-2")}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- crowding */

/** A row of one line is 28 px of controls; a wrapped one is at least two of them and a gap. */
const ONE_LINE_MAX = 44;

/**
 * Whether the row does not fit. A row of controls of its own wraps to a second line (or, one that never wraps, runs past its edge);
 * a row beside the page's views (`Tabs`, which keeps its trailing controls whole and lets the tab list scroll) pushes views out of
 * sight — the 前沿动态 band lost 关注 and 简报 behind its filters on a 1512 px screen once 全部渠道 joined them (fr-web, 2026-10-22).
 */
function overflows(element: HTMLElement, beside: boolean, nowrap: boolean): boolean {
  if (nowrap) return element.scrollWidth > element.clientWidth + 1;
  if (!beside) return element.offsetHeight > ONE_LINE_MAX;
  const list = element.querySelector<HTMLElement>('[role="tablist"]');
  return Boolean(list && list.scrollWidth > list.clientWidth + 1);
}

/**
 * Whether the row's controls do not fit (`overflows`), and so must fold — in the band only. Measured from the layout, so a test without
 * one (jsdom) never folds. Unfolding is tried again when the row has grown past the width at which it last did not fit.
 */
function useCrowded(row: RefObject<HTMLDivElement | null>, enabled: boolean, besideViews = false, nowrap = false): boolean {
  const [crowded, setCrowded] = useState(false);
  // The width of the row when the unfolded controls last wrapped: unfolding is only tried above it.
  const failedAt = useRef(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!enabled || !element) { if (crowded) setCrowded(false); return undefined; }
    const check = () => {
      const width = element.clientWidth;
      if (!crowded) {
        if (overflows(element, besideViews, nowrap)) { failedAt.current = width; setCrowded(true); }
      } else if (width > failedAt.current + 8) {
        setCrowded(false);
      }
    };
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [row, enabled, crowded, besideViews, nowrap]);
  return enabled && crowded;
}

/**
 * `oneRow`: whether the views beside the row's controls no longer all show (the tab list scrolls), measured from the layout — so a test
 * without one (jsdom) never says so. Both the row and the tab list are watched (a token joining the row shrinks the list, not the row);
 * a change of what the row holds (`resetKey`) tries again from the start, and otherwise only a row grown past the width at which it last
 * did not fit does.
 */
function useViewsCrowded(root: RefObject<HTMLDivElement | null>, enabled: boolean, resetKey: string): boolean {
  const [crowded, setCrowded] = useState(false);
  const failedAt = useRef(0);
  const lastKey = useRef(resetKey);
  useLayoutEffect(() => {
    const element = root.current;
    if (!enabled || !element) { if (crowded) setCrowded(false); return undefined; }
    if (lastKey.current !== resetKey) { lastKey.current = resetKey; failedAt.current = 0; }
    const list = element.querySelector<HTMLElement>('[role="tablist"]');
    const check = () => {
      const width = element.clientWidth;
      if (!crowded) {
        if (list && list.scrollWidth > list.clientWidth + 1) { failedAt.current = width; setCrowded(true); }
      } else if (width > failedAt.current + 8) {
        setCrowded(false);
      }
    };
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [root, enabled, crowded, resetKey]);
  return enabled && crowded;
}

/** A clipped count stays on one line; keyboard/hover and touch can read its complete text without changing the band's height. */
function BandSummary({ text, className }: { text: string; className: string }) {
  const line = useRef<HTMLSpanElement | HTMLButtonElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return undefined;
    const check = () => setClipped(isTruncated(element));
    check();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, clipped]);
  if (!clipped) return <span ref={element => { line.current = element; }} className={className}>{text}</span>;
  return <Popover.Root>
    <Tooltip content={text} whenTruncated>
      <Popover.Trigger asChild><button ref={element => { line.current = element; }} type="button" className={cn(className, "h-sm rounded px-0 text-left outline-none focus-visible:outline-focus")}>{text}</button></Popover.Trigger>
    </Tooltip>
    <Popover.Portal><Popover.Content aria-label="完整摘要" side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-popover max-w-xs break-words rounded-card border border-border bg-surface p-3 text-ui text-text shadow-e2 outline-none">{text}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}

/* ---------------------------------------------------------------- toolbar */

/**
 * Component: Toolbar; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: Declared view/filter/search/summary/action row with responsive filter panel.
 * Variants: Band, oneRow, pinned/folded controls and custom sheetLead.
 * States: Controlled query/filter choices; local panel/search expansion; reset calls owner.
 * Hit area: Shared Tabs, FilterChip, Menu, Switch, SearchInput and Button targets.
 * Keyboard: Child keyboard behavior; composition-safe search; scoped / shortcut.
 * Long content: Overflow chips fold or scroll; applied tokens collapse with counts.
 * Theme: Shared semantic controls; no additional palette.
 * Responsive: Narrow filter sheet; measured band overflow folds filters; oneRow has phone search overlay.
 * Verification: Toolbar.test.tsx and Composition.test.tsx; /__gallery is visual evidence; real AT/touch and browser reflow require manual checks.
 */
export function Toolbar({ label = "筛选与操作", views, filters: declared = [], onClear, onReset, search, summary, actions, className, inBand = false,
  oneRow = false, tokens: given = [], sheetLead, resultCount, searchShortcut = false }: ToolbarProps) {
  const narrow = useNarrow();
  const row = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const one = oneRow && Boolean(views);
  // A row of its own is crowded when it wraps; the tab row (`Tabs` lays its trailing controls out) when its views no longer all show.
  const crowded = useCrowded(views ? root : row, inBand && !narrow && !one, Boolean(views));
  // `oneRow`: the tokens give way first — two, then one, then none and the chip's count alone — and then the controls that are not
  // pinned fold as well.
  const declaredKey = declared.map((filter) => `${filter.kind}:${filter.label}`).join("|");
  const tokenKey = `${declaredKey}#${given.map((token) => token.label).join("|")}#${groupsOf(declared.filter((filter) => filter.folded)).filter(groupCounted).length}`;
  const twoCrowded = useViewsCrowded(root, one && inBand && !narrow, tokenKey);
  const tokensCrowded = useViewsCrowded(root, one && inBand && !narrow && twoCrowded, tokenKey);
  const controlsCrowded = useViewsCrowded(root, one && inBand && !narrow && tokensCrowded, tokenKey);
  const fold = one ? narrow || controlsCrowded : narrow || crowded;
  // On a phone, and where the band's row is full, the filters fold into one chip — all but the pinned ones, which stay as they are; a
  // `folded` one is in it at every width.
  const isFolded = (filter: ToolbarFilter) => Boolean(filter.folded) || (fold && !filter.pinned);
  const kept = declared.filter((filter) => !isFolded(filter));
  const filters = declared.filter(isFolded);
  const folded = filters.reduce((sum, filter) => sum + activeCount(filter), 0);
  // What 「清除筛选」 lets go of is every filter that is on, the pinned ones too.
  const active = folded + kept.reduce((sum, filter) => sum + activeCount(filter), 0);
  const searching = Boolean(search?.value);
  const reset = onReset ?? onClear ?? (() => filters.forEach((filter) => (filter.kind === "panel" ? clearPanel(filter) : clearGroup(filter))));
  const shrinkSummary = inBand && summary != null;
  const summaryClass = cn("text-caption tabular-nums text-text-3 sm:shrink-0", search || shrinkSummary ? "min-w-0 truncate max-sm:flex-1 sm:flex-none" : "shrink-0");

  const hasSearch = Boolean(search);
  useEffect(() => {
    if (!searchShortcut || !hasSearch) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // A dialog over the page has the keyboard.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (one && narrow) setSearchOpen(true);
      else searchInput.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [searchShortcut, hasSearch, one, narrow]);

  if (one && views) {
    // What is applied: the page's own tokens, then what is on in 「筛选」 (those of the `folded` filters, and on a phone whatever folded).
    const applied = [...given, ...groupsOf(filters).map(groupToken).filter((token): token is ToolbarToken => token !== null)];
    const count = folded + given.length;
    // On a phone the line under the row scrolls sideways, so it holds two; on a wide row as many as fit of two.
    const shown = applied.slice(0, !narrow && twoCrowded ? 1 : 2);
    const hidden = applied.length - shown.length;
    const clearable = applied.length >= 2 && applied.some((token) => token.filter) && !(twoCrowded && !narrow);
    const searchToken: ToolbarToken | null = narrow && !searchOpen && search?.value
      ? { label: `搜索：${search.value}`, onRemove: () => (search.onClear ? search.onClear() : search.onChange("")) } : null;
    const tokenNodes = (
      <>
        {searchToken && <TokenChip token={searchToken} />}
        {shown.map((token, index) => <TokenChip key={`${token.label}-${index}`} token={token} />)}
        {hidden > 0 && <FilterChip className="shrink-0 tabular-nums" aria-label={`另有 ${hidden} 项筛选，打开筛选`} onClick={() => setFoldOpen(true)}>+{hidden}</FilterChip>}
        {clearable && <FilterChip className="shrink-0" onClick={reset}>清除</FilterChip>}
      </>
    );
    const inline = kept.map((filter, index) => <Fragment key={`${filter.kind}-${filter.label}-${index}`}><Inline filter={filter} /></Fragment>);
    // On a phone the view's buttons and its count are in the sheet, after the filters.
    const extra = narrow && (summary != null || actions) ? <>{summary != null && <span className="text-caption tabular-nums text-text-3">{summary}</span>}{actions}</> : undefined;
    const trigger = (filters.length > 0 || (narrow && (sheetLead || extra))) && (
      <FoldChip filters={filters} count={count} resettable={folded + given.filter((token) => token.filter).length} narrow={narrow} onReset={reset} stepOut={false} open={foldOpen} onOpenChange={setFoldOpen}
        mark icon={narrow} align="end" lead={narrow ? sheetLead : undefined} extra={extra} resultCount={resultCount} />
    );
    if (!narrow) {
      return (
        <div ref={root} data-toolbar="" role="group" aria-label={label} className={className}>
          <Tabs label={views.label} items={views.items} value={views.value} onChange={views.onChange} panelId={views.panelId} trailing={(
            <>
              {inline}
              {!tokensCrowded && tokenNodes}
              {trigger}
              {summary != null && (typeof summary === "string" ? <BandSummary text={summary} className={summaryClass} /> : <span className={summaryClass}>{summary}</span>)}
              {actions}
              {search && <SearchBox search={search} inputRef={searchInput} shortcut={searchShortcut} />}
            </>
          )} />
        </div>
      );
    }
    const second = kept.length > 0 || applied.length > 0 || Boolean(searchToken);
    return (
      <div ref={root} data-toolbar="" role="group" aria-label={label} className={className}>
        <div className="flex items-end gap-2 border-b border-border">
          {/* The views stay in the document while the search is open over them: the page's panel is named by its tab. */}
          <div className={cn("min-w-0 flex-1", searchOpen && "hidden")}>
            <Tabs label={views.label} items={views.items} value={views.value} onChange={views.onChange} panelId={views.panelId} className="border-b-0" />
          </div>
          {searchOpen && search ? (
            // As tall as the views' row: 40 px, the last of them over the row's rule, as a tab's underline is.
            <div className="-mb-px flex h-10 min-w-0 flex-1 items-center gap-2">
              <SearchBox search={search} inputRef={searchInput} focusOnMount shortcut={searchShortcut} onEscapeEmpty={() => setSearchOpen(false)} />
              <Button variant="text" size="sm" className="shrink-0" onClick={() => setSearchOpen(false)}>取消</Button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center gap-1 pb-1.5">
              {trigger}
              {search && <IconButton icon={Search} label={search.label} size="sm" aria-keyshortcuts={searchShortcut ? "/" : undefined} onClick={() => setSearchOpen(true)} />}
            </div>
          )}
        </div>
        {second && (
          // One line, only while something narrows the list or a pinned control has to stay in sight: it scrolls sideways rather than wrap.
          <div data-toolbar-row="" className="-ml-3 flex min-h-11 flex-nowrap items-center gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {inline}
            {tokenNodes}
          </div>
        )}
      </div>
    );
  }

  const controls = (
    <>
      {/* Keep pinned controls in the same child slot when late filters fold or unfold the row, including an open menu's focus. */}
      {declared.map((filter, index) => (!isFolded(filter)
        ? <Fragment key={`${filter.kind}-${filter.label}-${index}`}><Inline filter={filter} /></Fragment> : null))}
      {filters.length > 0 && (
        // Under the tabs (a phone) the folded chip is the row's first thing, and its text is 12 px in from its ground: it steps out so
        // the text stands on the page's left edge. Without views (or on a row of its own) the whole row does (below).
        <FoldChip filters={filters} count={folded} narrow={narrow} onReset={reset} open={foldOpen} onOpenChange={setFoldOpen}
          stepOut={Boolean(views) && narrow && declared.every((filter) => isFolded(filter))} />
      )}
      {onClear && (active > 0 || searching) && <FilterChip className="shrink-0" onClick={onClear}>清除筛选</FilterChip>}
    </>
  );
  const searchBox = search && <SearchBox search={search} inputRef={searchInput} shortcut={searchShortcut} />;
  // On a phone the search takes what the row has left, in the same row: it used to take a row of its own, and a module's band was
  // 36 px taller on the tabs with a search than on the others (the walk's module-chrome, 循证 GEO at 390 px, r19-guards2).
  const end = (search || summary != null || actions) && (
    <div className={cn("ml-auto flex min-w-0 items-center gap-2", (search || shrinkSummary) && "max-sm:flex-1")}>
      {searchBox}
      {/* In the band or beside a search, the count gives way before the mobile controls do; its full text remains accessible. */}
      {summary != null && (shrinkSummary && typeof summary === "string" ? <BandSummary text={summary} className={summaryClass} /> : <span className={summaryClass}>{summary}</span>)}
      {actions}
    </div>
  );
  return (
    <div ref={root} data-toolbar="" role="group" aria-label={label} className={className}>
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
