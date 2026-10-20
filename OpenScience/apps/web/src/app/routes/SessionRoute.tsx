import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useGeoAssociation } from "@/components/geo/useGeoProjectIds";
import { getGeoProject } from "@/lib/geoClient";
import { geoChatPath } from "@/lib/geoLocation";
import { chatSessionId } from "@/lib/runLocation";
import { listWebAgentRuns } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { scopedConversationPath, conversationNavigationState, conversationProjectFromLocation, newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { Button } from "@/components/ui/Button";
import { FrameSkeleton } from "./RuntimeUiFrame";
import { PageTitle } from "@/components/layout/PageTitle";

/**
 * The conversation surface is the kernel's own application, and nothing else.
 *
 * It used to be the kernel's application plus a shell-owned run panel on the
 * right, and the shell's navigation on the left, inside which the kernel drew
 * its own left column and its own right pane. Four columns, three of which
 * listed the same work under three names — 任务, 会话, 运行 (2026-09-15 walk,
 * A1/A6). The panel is gone rather than moved: the same rows are under each
 * project in the sidebar, and a second copy beside them was the surplus.
 *
 * This route is now a placeholder, and that is the point: the frame it used to
 * mount lives in the shell (`SessionFrameHost`), above the router, so that
 * navigating to any other page hides it instead of tearing its document,
 * websocket and binding down (2026-09-20 plan, WP1). Everything this route
 * once decided — which conversation to open, the opening cover, the errors —
 * is decided there from the address, so there is nothing left to render but
 * the browser tab's name.
 *
 * The design spec chose the opposite arrangement (§18.1 option C: keep a
 * self-built session page, do not embed the kernel's client) and the
 * implementation went the other way on 2026-09-09 without the shell being
 * re-cut around it. This file is that re-cut; the spec records the reversal.
 */
export function SessionRoute() {
  const projectId = useProjectStore((state) => state.currentId);
  const association = useGeoAssociation(projectId);
  const location = useLocation();
  const navigate = useNavigate();
  const addressedProject = conversationProjectFromLocation(location) ?? ((location.state as { globalAssistant?: boolean } | null)?.globalAssistant ? "default" : null);
  useEffect(() => {
    if (addressedProject) return;
    navigate(scopedConversationPath(`${location.pathname}${location.search}${location.hash}`, projectId), { replace: true, state: { ...location.state, conversationProjectId: projectId } });
  }, [addressedProject, association, location.pathname, location.search, location.hash, location.state, projectId, navigate]);
  useEffect(() => {
    if (!addressedProject || addressedProject !== projectId || !association || (location.state as { globalAssistant?: boolean } | null)?.globalAssistant) return undefined;
    let live = true;
    // The listing is a hint only. The current authorized project response proves identity.
    void getGeoProject(association.id).then(async (project) => {
      if (!live || project.projectId !== projectId || useProjectStore.getState().currentId !== projectId) return;
      const intent = (location.state as { runtimeUiIntent?: { projectId?: string; sessionId?: string } } | null)?.runtimeUiIntent;
      const sessionId = chatSessionId(location.pathname) ?? (intent?.projectId === projectId ? intent.sessionId : null) ?? project.sessionId;
      if (sessionId && sessionId !== project.sessionId && intent?.projectId !== projectId) {
        const runs = await listWebAgentRuns({ projectId });
        if (!runs.some(run => run.sessionId === sessionId)) return;
      }
      if (!live || useProjectStore.getState().currentId !== projectId) return;
      navigate(`${geoChatPath(project.id, sessionId)}${location.search}${location.hash}`, { replace: true, state: location.state });
    }).catch(() => { /* A stale module listing cannot redirect an ordinary conversation. */ });
    return () => { live = false; };
  }, [addressedProject, association, projectId, location.pathname, location.search, location.hash, location.state, navigate]);
  if (addressedProject && projectId !== addressedProject) return <GlobalHomeRoute projectId={addressedProject} restore />;
  return <PageTitle page="对话" />;
}

/** A global entry resolves the general workspace before creating any native intent. */
export function GlobalHomeRoute({ projectId = "default", restore = false }: { projectId?: string; restore?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setError(false);
    // Leave the current commit before select's atomic store/navigation update.
    void Promise.resolve().then(() => {
      if (!live) return;
      return useProjectStore.getState().select(projectId, () => {
        if (!live) return;
        const restoring = restore || (location.state as { globalAssistant?: boolean } | null)?.globalAssistant;
        navigate(restoring ? `${location.pathname}${location.search}${location.hash}` : scopedConversationPath("/app/chat", "default"), { replace: true, flushSync: true, state: restoring ? location.state : {
          ...conversationNavigationState(null, "default"), globalAssistant: true, runtimeUiIntent: newRuntimeUiIntent(),
        } });
      }, controller.signal);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; controller.abort(); };
  }, [location.key, location.pathname, location.search, location.hash, location.state, navigate, attempt, projectId, restore]);
  return error ? <div role="alert" className="flex h-full items-center justify-center gap-3">
    <span>对话暂时无法打开</span>
    <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>
  </div> : <FrameSkeleton title="对话" />;
}
