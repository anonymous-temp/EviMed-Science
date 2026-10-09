import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageTitle } from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/Button";
import { useProjectStore } from "@/lib/projects";
import { createResearchHandoff, handoffFromFragment, handoffIntent } from "@/lib/researchHandoff";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";

import { FrameSkeleton } from "./RuntimeUiFrame";

/**
 * `/app/handoff#<payload>`: a question handed over from EviMed's AI search
 * becomes a new research conversation (「转为深度研究」). The control plane binds
 * it and writes the first message with the 「来自 AI 搜索」 card; this page moves
 * the shell to the chosen project and opens the conversation with that message
 * in its composer, for the person to send. Nothing is sent from here.
 *
 * An address with no hand-off in it has one thing worth offering, the same
 * thing 「新对话」 in the sidebar does: a blank conversation. A fragment that is
 * there but cannot be read (cut short in a mail client, edited by hand) says
 * the link is no good instead of claiming there was no question: the question
 * lived only in that fragment, and the page that made it is another origin
 * this one knows nothing about, so there is no way back to offer.
 */
export function HandoffRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const payload = useMemo(() => handoffFromFragment(location.hash), [location.hash]);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  // One hand-off per attempt, however often the effect runs.
  const started = useRef(-1);

  useEffect(() => {
    if (!payload || started.current === attempt) return;
    started.current = attempt;
    void createResearchHandoff(payload)
      .then((created) => useProjectStore.getState().select(created.projectId, () => {
        navigate("/app/chat", { replace: true, flushSync: true, state: { runtimeUiIntent: handoffIntent(created) } });
      }))
      .catch(() => setFailed(true));
  }, [payload, attempt, navigate]);

  if (!payload) {
    const damaged = location.hash.length > 1;
    return (
      <>
        <PageTitle page="转为深度研究" />
        <EmptyState
          title={damaged ? "这条转入链接已失效" : "没有要转入的问题"}
          action={<Button onClick={() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } })}>开始新对话</Button>}
        />
      </>
    );
  }
  if (failed) {
    return (
      <>
        <PageTitle page="转为深度研究" />
        <div className="mx-auto w-full max-w-read px-4 py-12 md:px-6">
          <LoadError message="无法转入深度研究。" onRetry={() => { setFailed(false); setAttempt((value) => value + 1); }} />
        </div>
      </>
    );
  }
  return (
    <>
      <PageTitle page="转为深度研究" />
      <FrameSkeleton line="正在转入深度研究" />
    </>
  );
}
