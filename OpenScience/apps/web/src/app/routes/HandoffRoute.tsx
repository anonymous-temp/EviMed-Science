import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageTitle } from "@/components/layout/PageTitle";
import { useProjectStore } from "@/lib/projects";
import { createResearchHandoff, handoffFromFragment, handoffIntent } from "@/lib/researchHandoff";

import { FrameSkeleton } from "./RuntimeUiFrame";

/**
 * `/app/handoff#<payload>`: a question handed over from EviMed's AI search
 * becomes a new research conversation (「转为深度研究」). The control plane binds
 * it and writes the first message with the 「来自 AI 搜索」 card; this page moves
 * the shell to the chosen project and opens the conversation with that message
 * in its composer, for the person to send. Nothing is sent from here.
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
    return (
      <>
        <PageTitle page="转为深度研究" />
        <EmptyState title="没有要转入的问题" />
      </>
    );
  }
  if (failed) {
    return (
      <>
        <PageTitle page="转为深度研究" />
        <div className="mx-auto w-full max-w-read px-6 py-12">
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
