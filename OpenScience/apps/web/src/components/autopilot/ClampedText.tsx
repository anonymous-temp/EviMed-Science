import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const CLAMP: Record<3 | 4, string> = { 3: "line-clamp-3", 4: "line-clamp-4" };

/**
 * A paragraph that may be long — the researcher's own pasted message, a conclusion the independent check could not make — held to
 * a few lines with 「展开」 when it does not fit, rather than hidden or pushing the run's results off the screen. Not translated and
 * not cut: it is the whole text, folded. A text that fits shows no button; whether it fits is measured, so a wide drawer and a
 * phone each decide for themselves.
 */
export function ClampedText({ text, lines, className }: { text: string; lines: 3 | 4; className?: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || expanded) return undefined;
    const measure = () => setOverflows(element.scrollHeight - element.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <>
    <p ref={box} className={cn("whitespace-pre-wrap break-words", !expanded && CLAMP[lines], className)}>{text}</p>
    {(overflows || expanded) && <Button variant="text" size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</Button>}
  </>;
}
