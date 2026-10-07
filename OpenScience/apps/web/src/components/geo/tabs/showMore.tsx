import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * A long list shown a page at a time: the first rows, then 「显示更多 · 还有 N 个」.
 *
 * The rows are already in the browser (the routes ship them whole), so this is a window over an array, not a request. The window
 * goes back to its first size whenever `resetKey` changes — a new query, a new filter — so a reader who narrows the list never
 * finds it still scrolled down a thousand rows.
 */
export function useShowMore<T>(rows: readonly T[], { first, step, resetKey }: { first: number; step: number; resetKey: string }) {
  const [window, setWindow] = useState<{ key: string; size: number }>({ key: resetKey, size: first });
  const size = window.key === resetKey ? window.size : first;
  return {
    visible: rows.slice(0, size),
    remaining: Math.max(0, rows.length - size),
    more: () => setWindow({ key: resetKey, size: size + step }),
  };
}

/** The button under a paged list; nothing when everything is shown. `unit` is the counter word (个, 篇, 条). */
export function ShowMore({ remaining, unit, onMore }: { remaining: number; unit: string; onMore: () => void }) {
  if (remaining <= 0) return null;
  return (
    <div className="mt-2 flex justify-center">
      <Button variant="text" size="sm" onClick={onMore}>{`显示更多 · 还有 ${remaining.toLocaleString("zh-CN")} ${unit}`}</Button>
    </div>
  );
}
