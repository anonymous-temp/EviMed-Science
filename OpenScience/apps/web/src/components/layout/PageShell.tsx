import { useEffect, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { PAGE_CHROME_VAR } from "@/components/layout/chrome";
import { cn } from "@/lib/cn";
import { ActivityStrip, type ActivityStripProps } from "@/components/ui/ActivityStrip";
import { Headline, type HeadlineProps } from "@/components/ui/Headline";
import { ScopeMenu, type ScopeMenuProps } from "@/components/ui/ScopeMenu";
import { StepRail, type StepRailProps } from "@/components/ui/StepRail";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Toolbar, type ToolbarProps } from "@/components/ui/Toolbar";

/**
 * A page's one container, and the slots a page is composed of (R19, plan §2.1).
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
 * `width="read"` is the reading column (720): a report, an evidence card, an
 * event — prose that is read, not scanned. `width="full"` is for the page that
 * lays itself out (a split view) and still shares the gutter.
 *
 * The gutter is 16 px below 768 and 24 above (design reference §5.1, V-1): at
 * 390 px the body is 358 wide, not 342.
 *
 * ## Slots
 *
 * The shell used to have four (`title`, `meta`, `actions`, `back`), and a page
 * drew its tabs, its step rail and its filter row **in the body**, so they
 * scrolled away with it and could stand anywhere — under the content they
 * filter, in the middle of a 6,000 px page, on one tab of seven. The slots
 * below are rendered by the shell in a fixed order, and the page cannot
 * choose another:
 *
 * ```
 * back                                    ‹ 前沿动态
 * header   title · meta · scope ········· actions          (scrolls away)
 * ┌ band ────────────────────────────────────────────┐     (sticky, top 0)
 * │ steps    StepRail: 已完成 · 进行中 · 等你 …         │
 * │ activity ActivityStrip: ● 正在生成虚拟患者 · 计算 1,200 / 2,000 [取消] │
 * │ tabs     Tabs                                    │
 * │ toolbar  Toolbar: views · filters · search · actions │
 * └──────────────────────────────────────────────────┘
 * headline Headline: one sentence, its numbers links
 * body     children
 * ```
 *
 * The slots take **props, not elements**: `toolbar={{ filters, search }}`, so the
 * page cannot hand the band a hand-drawn row, and the only controls that exist
 * there are the ones the framework draws.
 *
 *  - `scope` (`ScopeMenuProps`) — whose things the page shows, after the title;
 *  - `titleVariant="document"` — the serif title of a reader;
 *  - `steps` (`StepRailProps`) — a module's program; present on **every** tab of
 *    the module and the same height on all of them;
 *  - `activity` (`ActivityStripProps`) — while work is going. The one thing in the
 *    band whose presence changes its height, and it follows the module's state,
 *    never the tab;
 *  - `tabs` — the module's views (config of `Tabs`; the shell also makes the body
 *    its tab panel). A page has **one** view-switch row: `tabs`, or `toolbar.views`
 *    for a list page whose views and filters share one row — never both;
 *  - `toolbar` (`ToolbarProps`) — the one row of controls. **The band's height
 *    must not depend on the tab**, so a page whose tabs differ in having a
 *    toolbar passes `toolbar={null}` for the tabs without one: the row keeps its
 *    44 px, and the band does not jump. Omitted (`undefined`) means no tab of
 *    the page has a toolbar, and no row is reserved;
 *  - `headline` (`HeadlineProps`) — the one sentence over a data page's body.
 *
 * The band is sticky at `top-0` of the page's scroll container, covers the
 * gutters (`-mx-4 px-4 md:-mx-6 md:px-6`) so content does not show at its sides,
 * and draws a hairline under itself, as wide as the content, once the header has
 * scrolled away (`data-stuck`; a tab list that is the band's last row has its own).
 * Its height is published as `--page-chrome-h` on the scroll container, which also
 * takes it as its `scroll-padding-top`: an anchor, a `scrollIntoView` and the
 * browser's scroll to a focused control stop below the band, not under it. A
 * sticky element in the body (the `Outline` column) adds its own offset to it.
 *
 * ## Markers
 *
 * The attributes the walk (`scripts/ops/ui-walk.mjs`) and
 * `pageComposition.test.tsx` read; they belong to the component, not to the page:
 *
 * | Attribute | On | Meaning |
 * |---|---|---|
 * | `data-page-header` | `PageHeader`'s `<header>` | the page's header line |
 * | `data-page-chrome` | the sticky band | steps, activity, tabs and toolbar live here |
 * | `data-step-rail` | `StepRail` | a module's rail; same step count on every tab |
 * | `data-activity` | `ActivityStrip` | `strip` or `chip` |
 * | `data-toolbar` | `Toolbar` | the one row of controls |
 * | `data-headline` | `Headline` | the data page's one sentence |
 * | `data-page-body` | the body wrapper | where content starts |
 * | `data-note` | `Note` | a sentence with an action or a number |
 * | `data-outline` | `Outline` | a table of contents (`column` or folded) |
 * | `data-empty` / `data-reason` | `EmptyState` | an empty state; `data-reason` when it says why it has no action |
 * | `data-step-state` | `StepState` | `empty`, `queued`, `running`, `failed`, `credits` |
 * | `data-tag` | `Tag` | a label; never inside a control |
 * | `data-chart-grid` / `data-chart-row` | `ChartGrid` | a grid whose rows are full |
 * | `data-fact-list` | `FactList` | the one key / value list |
 * | `data-state-screen` | `StateScreen` | a whole page's failure or wrong address |
 * | `data-master-detail` | `MasterDetail` | `split` or `single` |
 * | `data-prose` | `MarkdownViewer` | a document's own text; the walk does not call it an orphan sentence |
 * | `data-show-more` | `ShowMore` | a long list read a page at a time |
 *
 * ```tsx
 * <PageShell title="知识库" scope={…} actions={<Button…/>} toolbar={{ views, filters, search }}>
 *   …
 * </PageShell>
 * ```
 */

/**
 * `read` (720) is the reading column, `page` (1040) the list column, `wide`
 * (1200) the dashboard column, `full` lets a page lay itself out.
 */
export type PageWidth = "read" | "page" | "wide" | "full";

const COLUMN: Readonly<Record<PageWidth, string>> = {
  read: "max-w-read",
  page: "max-w-page",
  wide: "max-w-wide",
  full: "max-w-none",
};

/** The module's tabs, as `Tabs` takes them. */
export interface PageTabs<V extends string = string> {
  /** The tab list's accessible name (「项目视图」). */
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange(value: V): void;
  /** Makes the body this tab list's panel (`role="tabpanel"`, labelled by the open tab). */
  panelId?: string;
}

export interface PageShellProps<V extends string = string> {
  title: string;
  /** @deprecated Pages carry no subtitle; ignored. */
  description?: ReactNode;
  /** A grey count or update time after the title. */
  meta?: ReactNode;
  /** The page's primary action and at most two icon buttons or a search box. */
  actions?: ReactNode;
  /** The way back, over the title (「‹ 前沿动态」): a page that is one step down from another. */
  back?: ReactNode;
  /** The browser tab's name, when it should differ from the heading. */
  documentTitle?: string;
  width?: PageWidth;
  /** Classes for the scroll container (the page ground). */
  className?: string;
  /** Classes for the inner column — spacing between the header and the body. */
  contentClassName?: string;
  /** Whose things the page shows, after the title. */
  scope?: ScopeMenuProps;
  /** `document` is the reader's serif title. */
  titleVariant?: "page" | "document";
  /** The module's program, on every tab. */
  steps?: StepRailProps;
  /** Work in progress, under the rail. */
  activity?: ActivityStripProps;
  /** The module's views. */
  tabs?: PageTabs<V>;
  /** The one row of controls; `null` reserves its height on a tab that has none. */
  toolbar?: ToolbarProps | null;
  /** The one sentence over a data page's body. */
  headline?: HeadlineProps;
  children: ReactNode;
}

/** A toolbar row: 28 px of controls between two 8 px paddings. Reserved as-is where a tab has none. */
const TOOLBAR_ROW = "min-h-11";

export function PageShell<V extends string = string>({
  title,
  meta,
  actions,
  back,
  documentTitle,
  width = "page",
  className,
  contentClassName,
  scope,
  titleVariant,
  steps,
  activity,
  tabs,
  toolbar,
  headline,
  children,
}: PageShellProps<V>) {
  const scroller = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  // The band has a hairline under it once the header has scrolled out from over it.
  const [stuck, setStuck] = useState(false);
  const hasBand = Boolean(steps || activity || tabs || toolbar !== undefined);

  useEffect(() => {
    const element = band.current;
    const holder = scroller.current;
    if (!hasBand || !element || !holder) return undefined;
    const publish = () => holder.style.setProperty(PAGE_CHROME_VAR, `${element.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      holder.style.removeProperty(PAGE_CHROME_VAR);
    };
  }, [hasBand]);

  // Stuck: the band is held at the top of the scroll container, which is when a 1 px shrunken root no longer holds all of it.
  // (The band itself is observed, so the page has no marker element between its header and the band.)
  useEffect(() => {
    const element = band.current;
    if (!hasBand || !element || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top <= (entry.rootBounds?.top ?? 0));
      },
      { root: scroller.current, rootMargin: "-1px 0px 0px 0px", threshold: [1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasBand]);

  if (import.meta.env.DEV && tabs && toolbar?.views) {
    console.warn("PageShell: a page has one view-switch row — `tabs` and `toolbar.views` are both set.");
  }

  // The tab list's own hairline closes the band when it is the last row; otherwise the band draws one once it is stuck.
  const lastRowRuled = toolbar ? Boolean(toolbar.views) : toolbar === null ? false : Boolean(tabs);
  const panel = tabs ?? toolbar?.views;

  return (
    // `scroll-pt`: an anchor, a `scrollIntoView` and the browser's scroll to a focused control all stop below the band, not under it.
    <div ref={scroller} className={cn("h-full min-h-0 overflow-y-auto bg-bg scroll-pt-[var(--page-chrome-h,0px)]", className)}>
      {/* One box: the page gutter (16 px, 24 from `md`) and the one column, so
          the header and the body cannot disagree about where the left edge is. */}
      <div className={cn("mx-auto w-full px-4 py-6 md:px-6", COLUMN[width])}>
        {back && <div className="mb-2">{back}</div>}
        <PageHeader
          title={title}
          meta={meta}
          actions={actions}
          scope={scope && <ScopeMenu {...scope} />}
          titleVariant={titleVariant}
          documentTitle={documentTitle}
        />
        {hasBand && (
          <div
            ref={band}
            data-page-chrome=""
            data-stuck={stuck ? "" : undefined}
            className={cn(
              "sticky top-0 z-sticky -mx-4 bg-bg px-4 md:-mx-6 md:px-6",
              // The hairline is as wide as the content, not the band: it is drawn only once the header has gone from over it.
              !lastRowRuled && "after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border after:opacity-0 after:transition-opacity after:duration-fast data-[stuck]:after:opacity-100 md:after:inset-x-6",
            )}
          >
            {steps && <StepRail {...steps} />}
            {activity && <div className="pb-2"><ActivityStrip {...activity} /></div>}
            {tabs && <Tabs label={tabs.label} items={tabs.items} value={tabs.value} onChange={tabs.onChange} panelId={tabs.panelId} />}
            {toolbar === null && <div aria-hidden="true" className={TOOLBAR_ROW} />}
            {toolbar && <div className={toolbar.views ? undefined : cn(TOOLBAR_ROW, "py-2")}><Toolbar {...toolbar} inBand /></div>}
          </div>
        )}
        {headline && <Headline {...headline} className={cn("mt-4", headline.className)} />}
        <div
          data-page-body=""
          id={panel?.panelId}
          role={panel?.panelId ? "tabpanel" : undefined}
          aria-labelledby={panel?.panelId ? `${panel.panelId}-tab-${panel.value}` : undefined}
          className={cn("mt-6", contentClassName)}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
