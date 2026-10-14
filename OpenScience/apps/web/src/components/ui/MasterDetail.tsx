import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Drawer } from "@/components/ui/Drawer";

/**
 * A list on the left and one record on the right (R19, plan §2.1 T2) — the scheduled tasks, the method library, the assumption
 * cards. Extracted from `AutopilotPage`, which was the one page that did it right: the split is decided by the room *the page
 * itself* has (the shell's sidebar takes up to 340 px of the window), not by the window, and the list column and the detail
 * each have their own scroll.
 *
 * Below the room for both, the page is one of them:
 *
 *  - `narrow="drawer"` (the default for a record): the list stays the page and the record opens in the right-hand `Drawer`;
 *  - `narrow="swap"`: the record replaces the list, and the way back is the page's own (a conversation needs the whole width,
 *    and a drawer never holds a conversation — `DESIGN.md` 「页面结构」 rule 2).
 *
 * `list` and `detail` may be functions of `{ split }`, for the page that words something differently beside the list than
 * without it (a 「回到定时任务」 link that is only needed when the list is not beside the record).
 *
 * `modeAttribute` names a data attribute that carries `split` / `single` on the root, for pages whose tests and walk probes
 * already address the layout by their own name (`data-autopilot-layout`). `data-master-detail` is always there.
 *
 * ```tsx
 * <MasterDetail
 *   listLabel="假设卡" detailLabel="假设" selected={Boolean(id)}
 *   list={<List …/>} detail={<Record …/>}
 *   detailTitle="假设" onCloseDetail={() => navigate(listPath)}
 * />
 * ```
 */
export type MasterDetailMode = "split" | "single";

export interface MasterDetailState {
  /** The list and the detail are side by side. */
  split: boolean;
}

type Region = ReactNode | ((state: MasterDetailState) => ReactNode);
type DataAttributes = { [name: `data-${string}`]: string | undefined };

type Collapse =
  | { narrow: "swap"; detailTitle?: undefined; onCloseDetail?: undefined }
  | { narrow?: "drawer"; detailTitle: string; onCloseDetail: () => void };

export function MasterDetail({
  list,
  detail,
  selected,
  listLabel,
  detailLabel,
  listWidth = 340,
  detailMin = 684,
  modeAttribute,
  listAttributes,
  detailAttributes,
  className,
  children,
  ...collapse
}: {
  list: Region;
  detail: Region;
  /** A record is chosen. Beside the list it only decides what the detail is; below it, whether the page shows it. */
  selected: boolean;
  /** The two regions' accessible names. */
  listLabel: string;
  detailLabel: string;
  /**
   * The list column's width, 320–360 px, and the least the detail is given: the two together are the page's own width from which
   * they sit side by side — 340 + 684 = 1024 by default. (A conversation needs 640 beside a 300 list: `AutopilotPage` says so.)
   */
  listWidth?: number;
  detailMin?: number;
  modeAttribute?: `data-${string}`;
  listAttributes?: DataAttributes;
  detailAttributes?: DataAttributes;
  className?: string;
  /** What belongs to the page and floats over it (a dialog, a drawer of its own, the page's title element). */
  children?: ReactNode;
} & Collapse) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Beside the list or instead of it, by what the page itself has room for.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (typeof next === "number") setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const split = width >= listWidth + detailMin;
  const swap = collapse.narrow === "swap";
  const showList = split || !swap || !selected;
  const showDetail = split || (swap && selected);
  const drawer = !split && !swap && selected;
  const state: MasterDetailState = { split };
  const draw = (region: Region) => (typeof region === "function" ? region(state) : region);
  const mode: MasterDetailMode = split ? "split" : "single";

  return (
    <div
      ref={root}
      data-master-detail={mode}
      {...(modeAttribute ? { [modeAttribute]: mode } : {})}
      className={cn("flex h-full min-h-0 bg-bg", className)}
    >
      {showList && (
        <section
          key="list"
          aria-label={listLabel}
          {...listAttributes}
          className={cn("flex min-h-0 flex-col", split ? "shrink-0 border-r border-border" : "min-w-0 flex-1")}
          style={split ? { width: listWidth } : undefined}
        >
          {draw(list)}
        </section>
      )}
      {showDetail && (
        <section key="main" aria-label={detailLabel} {...detailAttributes} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {draw(detail)}
        </section>
      )}
      {drawer && <Drawer title={collapse.detailTitle ?? detailLabel} onClose={collapse.onCloseDetail ?? (() => undefined)}>{draw(detail)}</Drawer>}
      {children}
    </div>
  );
}
