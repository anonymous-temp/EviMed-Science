import { useEffect, useState } from "react";
import { useRouteError } from "react-router";
import { AlertCircle, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/cards/EmptyState";
import { Button } from "@/components/ui/Button";
import { isStaleChunkError, reloadForNewRelease, reloadingForNewRelease, reloadPage } from "@/lib/staleChunk";

/**
 * What a page that failed shows: one sentence and one button, in place of the
 * page and nothing more.
 *
 * The router puts it on the pathless route that holds every workbench page,
 * so the sidebar and the conversation frame outlive the failure, and on the
 * routes outside the shell. Until 2026-09-23 no route had one, and React
 * Router's default — 「Unexpected Application Error!」, the message and its
 * stack, in English — replaced the whole shell (UI plan §2.1, mockup m13).
 * The stack stays where an operator looks for it: React Router logs every
 * error it catches to the console.
 *
 * A chunk the last release replaced is the common case, and its cure is the
 * reload the tab takes on its own (`reloadForNewRelease`, the same guarded
 * path as `vite:preloadError`). A failure the guard will not reload again is
 * said as a failure.
 */
export function RouteError() {
  const error = useRouteError();
  const stale = reloadingForNewRelease() || isStaleChunkError(error);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (stale && !reloadForNewRelease()) setRefused(true);
  }, [stale]);
  const updating = stale && !refused;

  return (
    // Opaque and clickable: on the conversation surface the page slot floats
    // over the frame and lets pointer events through (`AppShell`).
    <div role={updating ? "status" : "alert"} className="pointer-events-auto flex h-full items-center justify-center bg-bg">
      <EmptyState
        icon={updating ? RefreshCw : AlertCircle}
        title={updating ? "页面已更新，正在刷新…" : "出了点问题"}
        action={<Button variant="ghost" onClick={reloadPage}>重新载入</Button>}
      />
    </div>
  );
}
