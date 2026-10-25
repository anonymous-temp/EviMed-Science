import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { FrontierHideReason, FrontierItem } from "@/lib/frontierClient";
import { FilterChip } from "@/components/ui/FilterChips";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { INLINE_ACTION } from "./frontierText";
import { HIDE_REASONS, hideReasonLabel } from "./frontierHide";
import type { FrontierHideStripControls } from "./useFrontierHide";

/**
 * What stands where a card was hidden (owner, 2026-10-25): one line — 「已隐藏 · 说说原因（可不选）」, the reasons as small chips in the
 * domain's order, 「撤销」 at the end — in the card's own box, so the list does not jump when 不感兴趣 is chosen. A reason sends
 * and the line says 「已记下」 and closes; with no choice it closes by itself (`useFrontierHide` keeps the time) and the hide
 * stands without one; and it closes when it is scrolled out of sight, so a line left behind does not keep a place in the list.
 *
 * Keyboard: the first chip takes focus when the line appears (the card's ⋯ it came from is gone), Tab walks the chips to 撤销, and
 * Escape closes the line. It wraps on a phone, a chip whose source name is long keeps to its row and cuts it.
 */
export function FrontierHideStrip({ item, grouped = false, noted, onReason, onUndo, onClose }: FrontierHideStripControls & {
  item: FrontierItem;
  /** Inside a day group the clock's column is kept, as the card keeps it. */
  grouped?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);

  // Scrolled out of sight — after it was in sight — the line closes: the reader has gone on.
  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") return undefined;
    let seen = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen = true;
        else if (seen) close.current();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Escape, with focus on the line, closes it (a listener on the line itself: the line is a group, not a control with a key of its own).
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <li data-frontier-hidden={item.id} className="flex">
      {grouped && <div aria-hidden="true" className="hidden w-14 shrink-0 sm:block" />}
      {/* The card's own box (`-mx-3` where it has no clock column), so the words stand where the card's did. */}
      <div
        ref={box}
        role="group"
        aria-label="不感兴趣"
        className={cn("my-1 flex min-h-control min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1 rounded-card bg-surface-2 px-3 py-1.5 text-ui text-text-2", !grouped && "-mx-3")}
      >
        {noted ? (
          <span role="status" className="mr-1">已记下</span>
        ) : (
          <>
            <span className="mr-1">已隐藏 · 说说原因（可不选）</span>
            {HIDE_REASONS.map((reason, index) => (
              <FilterChip key={reason} ref={index === 0 ? first : undefined} className="max-w-full min-w-0 bg-surface hover:bg-surface-3" onClick={() => onReason(reason)}>
                <span className="truncate">{hideReasonLabel(reason, item)}</span>
              </FilterChip>
            ))}
          </>
        )}
        <button type="button" onClick={onUndo} className={cn(INLINE_ACTION, "px-2 text-link hover:bg-surface-3")}>撤销</button>
      </div>
    </li>
  );
}

/**
 * The reader page's reasons (owner, 2026-10-25): 「不感兴趣」 in its ⋯ asks why before it hides — the same words, as a small menu
 * that opens beside the actions, with 「不说原因，直接隐藏」 at its end. Closing it without a choice hides nothing: the reader pressed
 * 不感兴趣 on a page they are reading, and nothing has happened yet that a toast could take back.
 *
 * It opens a moment after it is mounted (`Menu`'s `defaultOpen`), anchored to an empty mark the page places by the actions; the page
 * gives it a new `key` each time 不感兴趣 is chosen, which opens it again. The moment is not for show: the ⋯ menu it was chosen from
 * gives focus back to its button a tick after it closes, and a menu already open by then would see that as a press outside it and
 * close — so this one waits for the tick (`REASONS_DELAY_MS`) to pass.
 */
export function FrontierHideReasonMenu({ item, onChoose, anchorClassName }: {
  item: FrontierItem;
  /** The reason, or `null` for 「不说原因，直接隐藏」. */
  onChoose: (reason: FrontierHideReason | null) => void;
  /** Where the menu opens: the mark's own place (absolute or fixed by the actions). */
  anchorClassName: string;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), REASONS_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const items: MenuEntry[] = [
    { heading: "说说原因（可不选）" },
    ...HIDE_REASONS.map((reason) => ({ label: hideReasonLabel(reason, item), onSelect: () => onChoose(reason) })),
    "separator",
    { label: "不说原因，直接隐藏", onSelect: () => onChoose(null) },
  ];
  const anchor = <span aria-hidden="true" className={cn("pointer-events-none block h-0 w-0", anchorClassName)} />;
  return ready ? <Menu label="不感兴趣的原因" defaultOpen items={items}>{anchor}</Menu> : anchor;
}

/** How long the reader's reasons wait for the menu they were chosen from to give its focus back (see `FrontierHideReasonMenu`). */
const REASONS_DELAY_MS = 80;
