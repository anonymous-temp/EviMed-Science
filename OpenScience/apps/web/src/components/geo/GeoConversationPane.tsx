import { useLayoutEffect, useRef } from "react";
import { registerTaskPane } from "@/lib/taskPane";

/** The shell places its resident native conversation over this pane. */
export function GeoConversationPane({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pane.current) return undefined;
    const element = pane.current;
    const withdraw = registerTaskPane({ element, projectId, sessionId });
    let scroller: HTMLElement = document.documentElement;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (["auto", "scroll"].includes(getComputedStyle(parent).overflowY)) { scroller = parent; break; }
    }
    const fit = () => {
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      element.style.height = `${Math.max(360, Math.floor(scroller.clientHeight - top - 24))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(scroller);
    for (const part of scroller.querySelectorAll("[data-page-header], [data-page-chrome]")) observer?.observe(part);
    window.addEventListener("resize", fit);
    return () => { withdraw(); observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [projectId, sessionId]);
  return <div ref={pane} aria-label="项目对话" className="min-h-96 flex-1" />;
}
