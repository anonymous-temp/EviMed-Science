import { createPortal } from "react-dom";
import { useContext, useEffect } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import { dirtyRouteShouldBlock, discardDirtyRoutes, useDirtyRouteState, resolveProjectExit, useProjectExitPending } from "@/lib/useUnsavedGuard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

function DataRouteGuard({ projectPending }: { projectPending: boolean }) {
  const state = useDirtyRouteState();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRouteShouldBlock(currentLocation, nextLocation));
  useEffect(() => {
    if ((state === "local-confirm" || projectPending) && blocker.state === "blocked") blocker.reset();
  }, [state, blocker, projectPending]);
  if (projectPending || state === "local-confirm" || blocker.state !== "blocked") return null;
  return createPortal(<ConfirmDialog title="离开并放弃未保存的修改？" body="此页面中的修改尚未保存。" confirmLabel="放弃修改并离开" busy={state === "busy"} cancellable
    onCancel={() => blocker.reset()} onConfirm={() => { discardDirtyRoutes(); blocker.proceed(); }} />, document.body);
}

/** One blocker per host router; lightweight story/test routers have no transitions to block. */
export function UnsavedRouteGuard() {
  const router = useContext(UNSAFE_DataRouterContext);
  const pendingProject = useProjectExitPending(), state = useDirtyRouteState();
  useEffect(() => () => resolveProjectExit(false), []);
  return <>{pendingProject && createPortal(<ConfirmDialog title="切换项目并放弃未保存的修改？" body={state === "busy" ? "请求仍在进行中，请等待结果后再切换项目。" : "当前项目中的未保存修改将被放弃。已保存的迁移可从原项目的未完成记录继续。"} confirmLabel="放弃修改并切换" busy={state === "busy"} cancellable
    onCancel={() => resolveProjectExit(false)} onConfirm={() => resolveProjectExit(true)} />, document.body)}{router ? <DataRouteGuard projectPending={pendingProject} /> : null}</>;
}
