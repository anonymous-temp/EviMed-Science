import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";

/**
 * 「在对话中使用」 for a page or a mark of the graph: the conversation opens in the file's own project with the question left in
 * the composer, unsent, and the documents the file cites attached as references (the same mechanism a selection of documents uses).
 */
export function useKnowledgeConversation(projectId: string) {
  const navigate = useNavigate();
  const select = useProjectStore((state) => state.select);
  return useCallback((draft: string, references: Array<{ id: string; title: string }>) => {
    void select(projectId, () => {
      navigate("/app/chat", { flushSync: true, state: { runtimeUiIntent: { ...newRuntimeUiIntent(draft), references } } });
    }).catch((failure) => toast.error(webErrorMessage(failure)));
  }, [navigate, projectId, select]);
}

/** Whether the window is a phone's width, kept current: the picture is drawn in smaller marks there. */
export function useCompactScreen(): boolean {
  const query = "(max-width: 639px)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
