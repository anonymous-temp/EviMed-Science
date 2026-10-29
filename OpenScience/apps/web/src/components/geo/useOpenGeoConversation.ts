import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { listGeoProjects } from "@/lib/geoClient";
import { geoChatPath, geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { openGeoConversation } from "@/lib/geoNativeClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { resolveGeoTab } from "./geoTabs";
import { toast } from "@/lib/toast";

/** Where a GEO conversation opens: the control-plane project and, when there is one, its conversation. */
export interface GeoConversationTarget {
  projectId: string;
  geoId?: string;
  /** A conversation to open by name; none is the one the page holds (`GeoFrameApi.conversation`), else the project's own. */
  sessionId?: string | null;
  resultRevision?: { referenceId: string };
  geoPlanContext?: { referenceId: string };
  /** A versioned handling attempt resumes its own native session even while another is selected in the page URL. */
  exactSession?: boolean;
}

/** Open an exact module descriptor in the existing native composer. Drafts remain unsent. */
export function useOpenGeoConversation() {
  const navigate = useNavigate();
  const location = useLocation();
  const arrival = useRef(location.key);
  arrival.current = location.key;
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current += 1; }; }, []);
  return useCallback(async (target: GeoConversationTarget, draft?: string): Promise<boolean> => {
    if (!live.current || arrival.current !== location.key) return false;
    const request = ++generation.current;
    const from = location.key;
    const current = () => live.current && generation.current === request && arrival.current === from;
    try {
      if (target.exactSession && !target.sessionId) throw new Error("The selected GEO conversation is unavailable.");
      const matches = target.geoId ? [] : (await listGeoProjects()).filter(project => project.projectId === target.projectId);
      const geoId = target.geoId ?? (matches.length === 1 ? matches[0].id : undefined);
      if (!current()) return false;
      if (!geoId) throw new Error("GEO project unavailable");
      const sameProject = location.pathname.startsWith(`/app/geo/${encodeURIComponent(geoId)}/`) || location.pathname === `/app/geo/${encodeURIComponent(geoId)}`;
      const selectedSession = sameProject ? geoSessionIdFromChatPath(location.pathname) || new URLSearchParams(location.search).get("session") : null;
      const exactSession = ((target.geoPlanContext || target.resultRevision || target.exactSession) ? target.sessionId || selectedSession : selectedSession || target.sessionId);
      const descriptor = await openGeoConversation(geoId, exactSession ? { kind: "session", sessionId: exactSession } : { kind: "primary" });
      if (!current()) return false;
      if (descriptor.projectId !== target.projectId || descriptor.scope.geoProjectId !== geoId || descriptor.sessionId !== descriptor.scope.sessionId
        || exactSession && exactSession !== descriptor.sessionId) throw new Error("GEO conversation mismatch");
      const intent = newRuntimeUiIntent(draft, descriptor.sessionId, { projectId: descriptor.projectId, scope: descriptor.scope });
      intent.kind = "open";
      if (target.geoPlanContext) intent.geoPlanContext = target.geoPlanContext;
      if (target.resultRevision) intent.resultRevision = target.resultRevision;
        const params = new URLSearchParams(sameProject ? location.search : "");
        if (sameProject && !location.pathname.includes("/chat")) {
          const part = location.pathname.split("/")[4];
          params.set("result", part === "answers" ? "questions" : resolveGeoTab(part).tab);
        }
        const search = params.toString();
        navigate(`${geoChatPath(geoId, intent.sessionId)}${search ? `?${search}` : ""}`, {
          state: { runtimeUiIntent: intent },
          flushSync: true,
        });
      return true;
    } catch (error: unknown) {
      if (!current()) return false;
      toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" }));
      return false;
    }
  }, [navigate, location.key, location.pathname, location.search]);
}
