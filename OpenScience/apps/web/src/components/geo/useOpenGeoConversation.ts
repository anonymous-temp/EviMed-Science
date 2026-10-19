import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { getGeoProject, listGeoProjects } from "@/lib/geoClient";
import { geoChatPath } from "@/lib/geoLocation";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { resolveGeoTab } from "./geoTabs";
import { toast } from "@/lib/toast";

/** Where a GEO conversation opens: the control-plane project and, when there is one, its conversation. */
export interface GeoConversationTarget {
  projectId: string;
  geoId?: string;
  sessionId?: string | null;
}

/**
 * Open a GEO project's conversation, optionally with a draft in the composer.
 *
 * A GEO project is an ordinary control-plane project, and a conversation
 * belongs to the project the shell is in — the intent names it. So the shell
 * switches to the GEO project first (in place, `useProjectStore.select`) and
 * mints the intent only once it is there, in the same render as the
 * navigation, as the project list does. The draft is never sent: it waits in
 * the composer for the reader.
 *
 * The project list is re-read first when the project is not in it yet — a
 * project created a moment ago — so the sidebar shows the project it lands in.
 *
 * It never rejects. A project that cannot be proved or opened (the network, a
 * project deleted in another tab) is said in a toast, once, here, and the
 * answer is `false`: every button that calls this gives its spinner back and
 * nothing is left to swallow at the call site. `true` is a conversation that
 * was opened.
 */
export function useOpenGeoConversation() {
  const navigate = useNavigate();
  const location = useLocation();
  const arrival = useRef(location.key);
  arrival.current = location.key;
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  return useCallback(async (target: GeoConversationTarget, draft?: string): Promise<boolean> => {
    const request = ++generation.current;
    const from = arrival.current;
    let superseded = false;
    const unsubscribe = useProjectStore.subscribe((state, previous) => {
      if (state.currentId !== previous.currentId || state.switching !== previous.switching) superseded = true;
    });
    const current = () => !superseded && generation.current === request && arrival.current === from;
    try {
      const store = useProjectStore.getState();
      if (!store.projects.some((project) => project.id === target.projectId)) await store.load();
      if (!current()) return false;
      const geoId = target.geoId ?? (await listGeoProjects()).find((project) => project.projectId === target.projectId)?.id;
      if (!current()) return false;
      if (!geoId) throw new Error("GEO project unavailable");
      const project = await getGeoProject(geoId);
      if (!current()) return false;
      if (project.projectId !== target.projectId) throw new Error("GEO project mismatch");
      const sessionId = target.sessionId ?? project.sessionId ?? undefined;
      unsubscribe();
      let opened = false;
      await useProjectStore.getState().select(target.projectId, () => {
        opened = true;
        const intent = newRuntimeUiIntent(draft, sessionId);
        const sameProject = location.pathname.startsWith(`/app/geo/${encodeURIComponent(geoId)}/`) || location.pathname === `/app/geo/${encodeURIComponent(geoId)}`;
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
      });
      return opened;
    } catch (error: unknown) {
      if (!current()) return false;
      toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" }));
      return false;
    } finally { unsubscribe(); }
  }, [navigate, location.pathname, location.search]);
}
