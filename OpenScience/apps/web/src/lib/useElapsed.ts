import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

/**
 * How long ago `startedAt` was, in the product's two-unit duration (「2 分 30 秒」), re-read every 15 seconds while `live`.
 * Empty before the start is known, when it is not a date, and in the first second: a strip shows no elapsed time rather than
 * 「0 秒」.
 */
export function useElapsed(startedAt: string | number | Date | null | undefined, live = true): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt == null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [live, startedAt]);
  if (startedAt == null) return "";
  const since = new Date(startedAt).getTime();
  return Number.isFinite(since) && now - since >= 1000 ? formatDuration(now - since) : "";
}
