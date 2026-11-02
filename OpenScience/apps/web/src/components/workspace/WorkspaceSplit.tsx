import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { PanelRightClose } from "lucide-react";
import { Link } from "react-router";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { buttonClasses } from "@/components/ui/Button";

/** From here the results keep room beside a 432 px conversation; under it the conversation covers them, and 收起 brings them back. */
const SPLIT_FROM = "(min-width: 1180px)";

/**
 * A module's open conversation and the results it is about (DESIGN.md, 模块工作台): results on the left, the conversation on the right with
 * its composer at the bottom of the column. The address says it is open and which result is beside it (`…/chat/<session>?result=…`), so
 * it can be linked and reloaded, and collapsing is only leaving that address: the resident frame stays alive either way.
 *
 * The results are not drawn where they would not be seen: a page under the breakpoint does not read eight tabs behind a cover.
 */
export function useWorkspaceSplit(): boolean {
  return useMediaQuery(SPLIT_FROM);
}

/**
 * Anatomy: Results beside a conversation paper with a title and collapse link.
 * Variants: Split results/conversation or conversation covering the results.
 * States: Media query selects the composition; the caller owns conversation and result state.
 * Hit area: Collapse link uses the existing small text-button geometry.
 * Keyboard: Native collapse link; no added focus interception or keyboard handler.
 * Long content: Results can shrink; supplied content retains its own scrolling and overflow behavior.
 * Theme: Existing surface paper, hairline outline and faint header separator; no elevation.
 * Responsive: At 1180px the sticky conversation has 432px content width; below it the conversation fills the available width.
 * Verification: GeoProjectPage.test.tsx covers split/cover and navigation behavior. Native rendering, browser geometry and real AT require separate checks.
 */
export function WorkspaceSplit({ results, conversation, collapseTo }: { results: ReactNode; conversation: ReactNode; collapseTo: string }) {
  const split = useWorkspaceSplit();
  return (
    <div data-workspace={split ? "split" : "cover"} className="flex min-w-0 items-start gap-6">
      {split && <div data-workspace-results="" className="min-w-0 flex-1">{results}</div>}
      <section aria-label="对话" data-workspace-conversation=""
        className={split ? "rounded-panel outline outline-1 outline-border-hairline bg-surface sticky top-[calc(var(--page-chrome-h,0px)+8px)] w-[432px] flex-none" : "w-full min-w-0 rounded-panel outline outline-1 outline-border-hairline bg-surface"}>
        <div className="flex h-9 items-center justify-between border-b border-border-faint px-3">
          <h2 className="text-ui font-normal text-text-2">对话</h2>
          <Link className={buttonClasses({ variant: "text", size: "sm" })} to={collapseTo}>
            <PanelRightClose size={16} aria-hidden="true" />{split ? "收起对话" : "回到结果"}
          </Link>
        </div>
        {conversation}
      </section>
    </div>
  );
}

/**
 * Keeps a conversation pane down to the bottom of the page's scroll box, wherever a scroll has taken it. The column is sticky, so what is
 * above it changes as the header scrolls away: measured from the pane's own place, and not from a scrolled offset, the composer at its
 * foot is never below the window.
 */
export function useFitToScroller(pane: RefObject<HTMLElement | null>, active: boolean, minHeight = 360) {
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !active) return undefined;
    let scroller: HTMLElement = document.documentElement;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (["auto", "scroll"].includes(getComputedStyle(parent).overflowY)) { scroller = parent; break; }
    }
    const fit = () => {
      const bottom = scroller === document.documentElement ? window.innerHeight : scroller.getBoundingClientRect().bottom;
      element.style.height = `${Math.max(minHeight, Math.floor(bottom - element.getBoundingClientRect().top - 16))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(scroller);
    for (const part of scroller.querySelectorAll("[data-page-header], [data-page-chrome]")) observer?.observe(part);
    scroller.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); scroller.removeEventListener("scroll", fit); window.removeEventListener("resize", fit); };
  }, [pane, active, minHeight]);
}
