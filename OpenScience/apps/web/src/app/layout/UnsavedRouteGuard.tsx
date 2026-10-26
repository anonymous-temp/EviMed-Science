import { createPortal } from "react-dom";
import { useContext, useEffect } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import { dirtyRouteState, useDirtyRouteState } from "@/lib/useUnsavedGuard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

function DataRouteGuard() {
  const state = useDirtyRouteState();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRouteState() !== "clean" && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (state === "local-confirm" && blocker.state === "blocked") blocker.reset();
  }, [state, blocker]);
  if (state === "local-confirm" || blocker.state !== "blocked") return null;
  return createPortal(<ConfirmDialog title="离开并放弃未保存的修改？" body="此页面中的修改尚未保存。" confirmLabel="放弃修改并离开" busy={state === "busy"}
    onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />, document.body);
}

/** One blocker per host router; lightweight story/test routers have no transitions to block. */
export function UnsavedRouteGuard() {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <DataRouteGuard /> : null;
}
