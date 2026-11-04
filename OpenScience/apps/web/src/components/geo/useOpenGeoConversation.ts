import { sessionOwner } from "@/lib/sessionLifecycle";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { listGeoProjects } from "@/lib/geoClient";
import { geoChatPath, geoIdFromChatPath, geoPanePath, geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { openGeoConversation } from "@/lib/geoNativeClient";
import { prepareRuntimeUiIntent, newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";

/** Where a GEO conversation opens: the control-plane project and, when there is one, its conversation. */
export interface GeoConversationTarget {
  projectId: string;
  geoId?: string;
  /** A conversation to open by name; none is the one the page holds (`GeoFrameApi.conversation`), else the project's own. */
  sessionId?: string | null;
  /**
   * The project's own conversation as the page last read it (`GeoProject.sessionId`). Opening it is the `primary` open, not an exact
   * one: the server repairs a primary the kernel no longer lists (for the owner) and answers with the session that now stands, while
   * an exact open of a missing session is only refused. An addressed conversation stays exact and is never swapped.
   */
  primarySessionId?: string | null;
  resultRevision?: { referenceId: string };
  geoPlanContext?: { referenceId: string };
  /** A versioned handling attempt resumes its own native session even while another is selected in the page URL. */
  exactSession?: boolean;
  /** The project work surface is reopening its default session, rather than an explicitly addressed historical one. */
  implicitPrimary?: boolean;
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
    const owner = sessionOwner();
    const request = ++generation.current;
    const from = location.key;
    const current = () => live.current && owner === sessionOwner() && generation.current === request && arrival.current === from;
    try {
      if (target.exactSession && !target.sessionId) throw new Error("The selected GEO conversation is unavailable.");
      const matches = target.geoId ? [] : (await listGeoProjects()).filter(project => project.projectId === target.projectId);
      const geoId = target.geoId ?? (matches.length === 1 ? matches[0].id : undefined);
      if (!current()) return false;
      if (!geoId) throw new Error("GEO project unavailable");
      const sameProject = location.pathname.startsWith(`/app/geo/${encodeURIComponent(geoId)}/`) || location.pathname === `/app/geo/${encodeURIComponent(geoId)}`;
      const selectedSession = sameProject ? geoSessionIdFromChatPath(location.pathname) || new URLSearchParams(location.search).get("session") : null;
      const named = ((target.geoPlanContext || target.resultRevision || target.exactSession) ? target.sessionId || selectedSession : selectedSession || target.sessionId);
      const isPrimary = Boolean(named) && !target.exactSession && !target.geoPlanContext && !target.resultRevision && named === target.primarySessionId;
      const exactSession = isPrimary ? null : named;
      const descriptor = await openGeoConversation(geoId, exactSession ? { kind: "session", sessionId: exactSession } : { kind: "primary" });
      if (!current()) return false;
      if (descriptor.projectId !== target.projectId || descriptor.scope.geoProjectId !== geoId || descriptor.sessionId !== descriptor.scope.sessionId
        || exactSession && exactSession !== descriptor.sessionId) throw new Error("GEO conversation mismatch");
      const intent = newRuntimeUiIntent(draft, descriptor.sessionId, { projectId: descriptor.projectId, scope: descriptor.scope });
      intent.kind = "open";
      if (target.geoPlanContext) intent.geoPlanContext = target.geoPlanContext;
      if (target.resultRevision) intent.resultRevision = target.resultRevision;
      const legacyChat = sameProject && geoIdFromChatPath(location.pathname) === geoId;
      const path = legacyChat
        ? `${geoChatPath(geoId, intent.sessionId)}${location.search}${location.hash}`
        : geoPanePath(sameProject ? location.pathname : `/app/geo/${encodeURIComponent(geoId)}`, sameProject ? location.search : "", sameProject ? location.hash : "", intent.sessionId);
      // Opening a pane is not a new answer/list visit: Back should leave the object, not just close its conversation.
      navigate(path, { replace: sameProject && (!legacyChat || !geoSessionIdFromChatPath(location.pathname)), state: {
        runtimeUiIntent: prepareRuntimeUiIntent(intent), ...(target.implicitPrimary ? { geoImplicitPrimary: descriptor.sessionId } : {}),
      }, flushSync: true });
      return true;
    } catch (error: unknown) {
      if (!current()) return false;
      toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" }));
      return false;
    }
  }, [navigate, location.key, location.pathname, location.search, location.hash]);
}
