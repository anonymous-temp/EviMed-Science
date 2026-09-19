import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { fetchWebMe, listWebAgentRuns, warmWebRuntime, webRuntimeProfile } from "@/lib/apiClient";
import { FrameWaiting, RuntimeUiFrame } from "./RuntimeUiFrame";
import { Button } from "@/components/ui/Button";
import { PageTitle } from "@/components/layout/PageTitle";
import { SessionMemoryBar } from "@/components/memory/SessionMemoryBar";

/**
 * The session surface is the kernel's own application, and nothing else.
 *
 * It used to be the kernel's application plus a shell-owned run panel on the
 * right, and the shell's navigation on the left, inside which the kernel drew
 * its own left column and its own right pane. Four columns, three of which
 * listed the same work under three names — 任务, 会话, 运行 (2026-09-15 walk,
 * A1/A6). The panel is gone rather than moved: the same rows are under each
 * project in the sidebar and on the run ledger, and a third copy beside them
 * was the surplus.
 *
 * The design spec chose the opposite arrangement (§18.1 option C: keep a
 * self-built session page, do not embed the kernel's client) and the
 * implementation went the other way on 2026-09-09 without the shell being
 * re-cut around it. This file is that re-cut; the spec records the reversal.
 */
export function SessionRoute() {
  const [uiOrigin, setUiOrigin] = useState(() => webRuntimeProfile().uiOrigin);
  const [loading, setLoading] = useState(() => !webRuntimeProfile().uiOrigin);
  const [attempt, setAttempt] = useState(0);
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  // Whether this arrival is a deliberate new task. 「新任务」 — the sidebar
  // row, the palette entry, a capability card — carries an intent in the
  // navigation state; a plain visit to /app/chat does not.
  // Presence, not validity: `RuntimeUiFrame` validates the intent against the
  // current project. What this decides is only whether the arrival was
  // deliberate, and an intent for another project is still a deliberate one.
  const wantsNewTask = Boolean((location.state as { runtimeUiIntent?: unknown } | null)?.runtimeUiIntent);
  // While the lookup below is out, the frame is not mounted. Mounted, it would
  // start creating a session of its own and the lookup's answer would arrive
  // after it — one more empty task per visit (2026-09-16 review, U9).
  const [resolving, setResolving] = useState(() => !sessionId && !wantsNewTask);

  // Land on the conversation you were last in, not on a new empty one.
  //
  // Arriving without a session id used to mean `kind: "create"`, so every visit
  // to /app/chat — the post-login landing route, the 「/」 redirect, a reload —
  // minted another session, and the kernel's own list filled with empty
  // 「新会话」 rows (2026-09-15 walk, A7). Creating is now what 「新任务」 does
  // and only that; an ordinary visit resumes, and resumes nothing only when
  // there is nothing to resume.
  useEffect(() => {
    if (sessionId || wantsNewTask) { setResolving(false); return; }
    let active = true;
    setResolving(true);
    // The lookup below decides which task the frame opens, not whether it
    // needs a runtime; starting that now overlaps the two waits instead of
    // queueing the runtime behind the lookup.
    warmWebRuntime();
    // A ledger that cannot be read, or does not answer, falls through to
    // creating a session, which is the behaviour this replaced: never a
    // blocked session page.
    const giveUp = setTimeout(() => { if (active) setResolving(false); }, 8_000);
    const resume = (candidate: unknown) => {
      if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(candidate)) return false;
      navigate(`/app/chat/${encodeURIComponent(candidate)}`, { replace: true });
      return true;
    };
    // The account's own answer first (C4): `/api/me` names the conversation
    // last opened in this project, and it is fetched for this page anyway —
    // the ledger walk below is one more round trip, and it finds a run's
    // session, not the conversation the reader was in. Read defensively: a
    // control plane that predates the field answers without it.
    void fetchWebMe()
      .then((me) => {
        if (!active) return null;
        if (resume((me as { lastSessionId?: unknown } | null)?.lastSessionId)) return null;
        return listWebAgentRuns().then((runs) => {
          if (!active) return;
          const recent = runs.find((run) => /^[A-Za-z0-9_-]{1,160}$/.test(run.sessionId));
          if (!recent || !resume(recent.sessionId)) setResolving(false);
        });
      })
      .catch(() => { if (active) setResolving(false); })
      .finally(() => clearTimeout(giveUp));
    return () => { active = false; clearTimeout(giveUp); };
  }, [sessionId, wantsNewTask, navigate]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => { if (active) setLoading(false); }, 15_000);
    void fetchWebMe().then(() => { if (active) setUiOrigin(webRuntimeProfile().uiOrigin); })
      .catch(() => { /* The visible unavailable state offers retry when no profile was loaded. */ })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); };
  }, [attempt]);

  // Exclusive by construction: a frame, a wait, or a refusal — never a loading
  // sentence rendered over a page that is already saying something else, which
  // is how 「正在启动研究运行时…」 came to sit on top of the kernel's own
  // 「内核界面暂时不可用」 (A3).
  // The tab is named the same in all three states — a page that renames itself
  // while it loads makes the browser's tab strip flicker.
  if (uiOrigin && resolving) {
    return (
      <div className="relative h-full w-full">
        <PageTitle page="研究会话" />
        <FrameWaiting stage={0} line="正在打开最近的任务…" />
      </div>
    );
  }
  // The conversation's memory controls sit above it once it has an id: the
  // incognito switch and 「本次用到的背景」 (SessionMemoryBar).
  if (uiOrigin) {
    return (
      <div className="flex h-full w-full flex-col">
        <PageTitle page="研究会话" />
        {sessionId && <SessionMemoryBar sessionId={sessionId} />}
        <div className="min-h-0 flex-1"><RuntimeUiFrame /></div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="relative h-full w-full">
        <PageTitle page="研究会话" />
        <FrameWaiting stage={0} />
      </div>
    );
  }
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-ui-sm text-error">
      <PageTitle page="研究会话" />
      <p>研究会话暂时无法连接</p>
      <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>
    </div>
  );
}
