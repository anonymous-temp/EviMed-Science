/**
 * The reply checks of the conversation on screen (L1), handed to the kernel's
 * page — where each one is drawn as a row under the answer it is about.
 *
 * Why the shell: the page on the runtime origin has no session of the control
 * plane's and must not get one. The shell reads `/api/review/replies` for the
 * open conversation and posts what it read into the frame (`reply-check`),
 * the way it posts the bound run's state and evidence.
 *
 * Hidden knowledge:
 *
 *  - A check arrives after its answer: a typed turn is adopted by the control
 *    plane's sweep (every 15 s), then checked (seconds). So the conversation
 *    is asked again every ten seconds while it is open, and the frame is sent
 *    the list only when it changed — the frame redraws on every message.
 *  - A deployment without the review module answers 404 `review_not_enabled`;
 *    the shell stops asking for this mount, and the frame draws nothing.
 */
import { useEffect, useRef } from "react";
import { productRequest } from "./productClient";

/** One checked answer, as the control plane returns it. */
export interface ReplyCheck {
  id: string;
  runId: string;
  sessionId: string;
  turnSeq: number | null;
  status: "queued" | "running" | "done" | "failed";
  counts: Record<string, number>;
  medicines: string[];
  cautions: { ruleId?: string; title: string; message: string }[];
  verdicts: {
    sentence: string;
    verdict: "supported" | "partial" | "unsupported" | "unresolvable" | "uncertain";
    warning: boolean;
    reason: string;
    evidence: string;
    safety: "none" | "consistent" | "contradicted";
    source: { number: number; title: string; url: string } | null;
  }[];
}

/** The checks of one conversation, or null when this deployment does not check replies. */
export async function listReplyChecks(projectId: string, sessionId: string): Promise<ReplyCheck[] | null> {
  const query = new URLSearchParams({ projectId, sessionId });
  try {
    const data = await productRequest<{ checks: ReplyCheck[] }>(`/review/replies?${query}`);
    return Array.isArray(data?.checks) ? data.checks : [];
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 404) return null;
    throw error;
  }
}

export interface FrameReplyCheckOptions {
  projectId: string;
  /** The root session of the conversation on screen; null while none is open. */
  sessionId: string | null;
  /** Off until the frame's bridge is listening. */
  enabled: boolean;
  post: (payload: { sessionId: string; checks: ReplyCheck[] }) => void;
  pollMs?: number;
}

/** Keeps the frame's reply checks current for the conversation on screen. */
export function useFrameReplyChecks({ projectId, sessionId, enabled, post, pollMs = 10_000 }: FrameReplyCheckOptions): void {
  const poster = useRef(post);
  poster.current = post;
  useEffect(() => {
    if (!enabled || !sessionId || !projectId) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = "";
    const read = async () => {
      try {
        const checks = await listReplyChecks(projectId, sessionId);
        if (!active) return;
        if (checks === null) return; // Not enabled here: stop asking.
        const key = JSON.stringify(checks.map((check) => [check.id, check.status, check.verdicts.length, check.cautions.length]));
        if (key !== last) {
          last = key;
          poster.current({ sessionId, checks });
        }
      } catch { /* the next tick asks again */ }
      if (active) timer = setTimeout(() => { void read(); }, pollMs);
    };
    void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, sessionId, enabled, pollMs]);
}
