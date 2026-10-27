import { createPortal } from "react-dom";
import { useContext, useEffect, useRef } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import { dirtyRouteShouldBlock, discardDirtyRoutes, useDirtyRouteState, resolveProjectExit, useProjectExitPending } from "@/lib/useUnsavedGuard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Whether the open dialog was raised by a request alone: it stays that kind of dialog after the request settles, instead of turning into a warning about changes that never existed. */
function useRaisedByRequest(state: string, open: boolean): boolean {
  const raised = useRef(false);
  if (!open) raised.current = false; else if (state === "pending") raised.current = true; else if (state !== "clean") raised.current = false;
  return raised.current;
}

function DataRouteGuard({ projectPending }: { projectPending: boolean }) {
  const state = useDirtyRouteState();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRouteShouldBlock(currentLocation, nextLocation));
  const pending = useRaisedByRequest(state, blocker.state === "blocked");
  useEffect(() => {
    if ((state === "local-confirm" || projectPending) && blocker.state === "blocked") blocker.reset();
  }, [state, blocker, projectPending]);
  if (projectPending || state === "local-confirm" || blocker.state !== "blocked") return null;
  return createPortal(pending
    ? <ConfirmDialog title="页面还在处理请求" body="有请求还没有完成，现在离开可能看不到它的结果。可以留在此页面等待。" confirmLabel="仍然离开" tone="primary" cancellable
      onCancel={() => blocker.reset()} onConfirm={() => { discardDirtyRoutes(); blocker.proceed(); }} />
    : <ConfirmDialog title="离开并放弃未保存的修改？" body="此页面中的修改尚未保存。" confirmLabel="放弃修改并离开" busy={state === "busy"} cancellable
      onCancel={() => blocker.reset()} onConfirm={() => { discardDirtyRoutes(); blocker.proceed(); }} />, document.body);
}

/** One blocker per host router; lightweight story/test routers have no transitions to block. */
export function UnsavedRouteGuard() {
  const router = useContext(UNSAFE_DataRouterContext);
  const pendingProject = useProjectExitPending(), state = useDirtyRouteState();
  const raisedByRequest = useRaisedByRequest(state, pendingProject);
  useEffect(() => () => resolveProjectExit(false), []);
  return <>{pendingProject && createPortal(raisedByRequest
    ? <ConfirmDialog title="页面还在处理请求" body="有请求还没有完成，现在切换项目可能看不到它的结果。可以留在当前项目等待。" confirmLabel="仍然切换" tone="primary" cancellable
      onCancel={() => resolveProjectExit(false)} onConfirm={() => resolveProjectExit(true)} />
    : <ConfirmDialog title="切换项目并放弃未保存的修改？" body={state === "busy" ? "请求仍在进行中，请等待结果后再切换项目。" : "当前项目中的未保存修改将被放弃。已保存的迁移可从原项目的未完成记录继续。"} confirmLabel="放弃修改并切换" busy={state === "busy"} cancellable
      onCancel={() => resolveProjectExit(false)} onConfirm={() => resolveProjectExit(true)} />, document.body)}{router ? <DataRouteGuard projectPending={pendingProject} /> : null}</>;
}
