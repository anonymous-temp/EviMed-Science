import { useCallback, useEffect, useRef, useState } from "react";
import { isStatisticalWorkspaceProjectId } from "@evimed/domain";
import { useNavigate } from "react-router";
import { createWebStatisticalWorkspace, getWebProjectId, putWebResearchSession, webErrorMessage } from "@/lib/apiClient";
import { bindConversationCapability, newResearchSessionId } from "@/lib/dispatch";
import type { CapabilityUi } from "@/lib/researchAgentUi";
import { newRuntimeUiIntent, scopedConversationPath } from "@/lib/runtimeUiNavigation";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";

/**
 * Choosing a curated research tool: the conversation that runs it is opened with the tool bound before the conversation exists, so the
 * router honours the choice and does not re-decide it with a classifier. 科研工具 and 插件与技能 both list the tools and both did this,
 * each with its own copy.
 *
 * A binding the control plane refused is said, as a toast, and the reader stays where they are. The page used to open a conversation
 * with no tool on it, and the reader believed the tool was chosen and asked their question of the general assistant. Pressing again
 * is the retry.
 */
export function useOpenTool() {
  const navigate = useNavigate();
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  // Retained on failure: the server may have created the project before the binding response was lost.
  const statisticalRequestId = useRef<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = useCallback((agent: CapabilityUi) => {
    if (busy.current) return;
    busy.current = true;
    setOpening(agent.id);
    const allocate = async () => {
      if (agent.id === "statistical-analysis") {
        statisticalRequestId.current ??= crypto.randomUUID();
        const bound = await createWebStatisticalWorkspace({ requestId: statisticalRequestId.current });
        await useProjectStore.getState().load();
        if (!alive.current) return;
        navigate(scopedConversationPath("/app/chat", bound.projectId), { state: {
          runtimeUiIntent: { ...newRuntimeUiIntent(undefined, bound.sessionId), projectId: bound.projectId }, capabilityId: agent.id,
        } });
        statisticalRequestId.current = null;
        return;
      }
      if (isStatisticalWorkspaceProjectId(getWebProjectId())) {
        const sessionId = newResearchSessionId();
        await putWebResearchSession(sessionId, { mode: "specialist", agentId: agent.id, agentVersion: agent.version }, { projectId: "default" });
        if (alive.current) navigate(scopedConversationPath("/app/chat", "default"), { state: {
          runtimeUiIntent: { ...newRuntimeUiIntent(undefined, sessionId), projectId: "default" }, capabilityId: agent.id,
        } });
        return;
      }
      const bound = await bindConversationCapability(null, { agentId: agent.id, agentVersion: agent.version });
      if (alive.current) navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(undefined, bound.sessionId), capabilityId: agent.id } });
    };
    void allocate()
      .catch((error: unknown) => toast.error(`没能选定“${agent.title}”，对话没有打开。${webErrorMessage(error, { fallback: "请稍后重试。" })}`))
      .finally(() => { busy.current = false; if (alive.current) setOpening(null); });
  }, [navigate]);
  return { opening, open };
}
