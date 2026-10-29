import { useCallback, useRef } from "react";
import { useLocation } from "react-router";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { getGeoProject, stageGeoPlanContext, type GeoProject } from "@/lib/geoClient";
import { geoSessionIdFromChatPath } from "@/lib/geoLocation";
import { toast } from "@/lib/toast";
import { ensureGeoConversationSession } from "../geoConversationSession";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { correctionDraft, type ClaimRow } from "./errorModel";

type HandoffClaim = Pick<ClaimRow, "engines" | "statement" | "evidenceQuote"> & Partial<Pick<ClaimRow, "rows">>;

/**
 * 「写纠错稿」: hand a wrong claim to the project's conversation.
 *
 * The errors the claim is made of are staged as the conversation's context (`stageGeoPlanContext`, as 方案 and the diagnosis review
 * do) and the composer receives only the person's sentence (`correctionDraft`) — the records' identities are what the platform knows,
 * never text the person would send as their own words. An error outside the staged range is left to the conversation's own reads
 * rather than refusing the hand-off. A request key is kept for a retry of the same selection so a second click stages nothing new.
 *
 * Resolves `true` when the conversation was opened, `false` when it was not; a failure is said in a toast (the caller only gives its
 * spinner back).
 */
export function useCorrectionHandoff(geoId: string, project: Pick<GeoProject, "projectId" | "sessionId" | "selection"> | null | undefined) {
  const open = useOpenGeoConversation();
  const location = useLocation();
  const key = useRef<{ signature: string; key: string } | null>(null);
  const projectId = project?.projectId;
  const projectSession = project?.sessionId;
  const selectionRef = project?.selection?.reference ?? null;
  return useCallback(async (claim: HandoffClaim, product: string, action: "article" | "conclusion" | "treatment" = "article"): Promise<boolean> => {
    if (!projectId) return false;
    try {
      const current = await getGeoProject(geoId);
      const sessionId = await ensureGeoConversationSession(geoId, projectId,
        geoSessionIdFromChatPath(location.pathname) || new URLSearchParams(location.search).get("session") || current.sessionId || projectSession, current.sessionId || projectSession);
      const focus = { sessionId, mode: "strategy" as const, ...(selectionRef ? { selectionRef } : {}) };
      const stage = async (input: typeof focus & { errorIds?: string[] }) => {
        const signature = JSON.stringify(input);
        const requestKey = key.current?.signature === signature ? key.current.key : crypto.randomUUID();
        key.current = { signature, key: requestKey };
        return stageGeoPlanContext(geoId, { ...input, requestKey });
      };
      const errorIds = [...new Set((claim.rows ?? []).map(row => row.id))];
      const context = await (errorIds.length ? stage({ ...focus, errorIds }) : stage(focus)).catch((cause: unknown) => {
        if (errorIds.length && cause instanceof WebApiError && cause.code === "geo_plan_focus_invalid") return stage(focus);
        throw cause;
      });
      const opened = await open({ projectId, geoId, sessionId: context.sessionId, geoPlanContext: { referenceId: context.referenceId } }, correctionDraft(claim, product, action));
      if (opened) key.current = null;
      return opened;
    } catch (cause) {
      toast.error(webErrorMessage(cause, { fallback: "对话暂时无法打开，请稍后重试。" }));
      return false;
    }
  }, [geoId, projectId, projectSession, selectionRef, open, location.pathname, location.search]);
}
