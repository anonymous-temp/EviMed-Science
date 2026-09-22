import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { fetchWebMe, listWebAgentRuns, warmWebRuntime, webRuntimeProfile } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { chatPath, chatSessionId, isChatPath } from "@/lib/runLocation";

import { Button } from "@/components/ui/Button";
import { FrameSkeleton, RuntimeUiFrame } from "@/app/routes/RuntimeUiFrame";

/**
 * How many projects' surfaces stay alive at once.
 *
 * One per project, because one runtime is one project's container, and two
 * because that is what a person may have running at a time
 * (`OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER`). A third would hold a binding
 * against a runtime the deployment will not give it.
 */
const CACHED_PROJECTS = 2;

/**
 * The conversation surface, mounted once for the whole shell.
 *
 * WHY IT LIVES HERE and not in the chat route: the kernel's application is an
 * iframe holding a document, a websocket and a kernel handshake, and React
 * unmounting it DELETEs the binding behind all three. With the surface inside
 * the route, every visit to any other page threw that away and paid for it
 * again on the way back — measured as seven rebuilds in twenty-five minutes on
 * production (2026-09-20 walk, fact 1). Off the conversation surface this is
 * `display: none`, never unmounted and never `visibility: hidden` — a hidden
 * iframe keeps its document, an unmounted one does not, and `visibility` would
 * keep it occupying the page's layout.
 *
 * The chat route (`SessionRoute`) is therefore a placeholder: this decides
 * which conversation is open, from the address alone.
 */
export function SessionFrameHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentId);
  const onChat = isChatPath(location.pathname);
  const sessionId = chatSessionId(location.pathname);
  // Whether this arrival is a deliberate new conversation. 「新对话」 — the
  // sidebar row, the palette entry, a capability card — carries an intent in
  // the navigation state; a plain visit to /app/chat does not.
  // Presence, not validity: `RuntimeUiFrame` validates the intent against the
  // current project. What this decides is only whether the arrival was
  // deliberate, and an intent for another project is still a deliberate one.
  const wantsNew = Boolean((location.state as { runtimeUiIntent?: unknown } | null)?.runtimeUiIntent);

  const [uiOrigin, setUiOrigin] = useState(() => webRuntimeProfile().uiOrigin);
  const [originLoading, setOriginLoading] = useState(() => !webRuntimeProfile().uiOrigin);
  const [originAttempt, setOriginAttempt] = useState(0);
  // While the lookup below is out, the frame is mounted — the runtime it needs
  // is the same one either way, so warming it under the lookup costs nothing —
  // but it is told to open nothing, or it would mint an empty conversation the
  // lookup then navigates away from (2026-09-16 review, U9).
  const [resolving, setResolving] = useState(() => onChat && !sessionId && !wantsNew);

  // The projects whose surfaces are kept alive, most recently used last.
  const [cached, setCached] = useState<string[]>(() => (onChat ? [currentProjectId] : []));
  useEffect(() => {
    if (!onChat) return;
    setCached((kept) => {
      if (kept.at(-1) === currentProjectId) return kept;
      const next = [...kept.filter((id) => id !== currentProjectId), currentProjectId];
      // Evicting unmounts that project's frame, which releases its binding.
      return next.slice(-CACHED_PROJECTS);
    });
  }, [onChat, currentProjectId]);

  // Land on the conversation you were last in, not on a new empty one.
  //
  // Arriving without a conversation id used to mean 「create」, so every visit
  // to /app/chat — the post-login landing route, the 「/」 redirect, a reload —
  // minted another conversation and the kernel's own list filled with empty
  // rows (2026-09-15 walk, A7). Creating is what 「新对话」 does and only that.
  useEffect(() => {
    if (!onChat) return;
    if (sessionId || wantsNew) { setResolving(false); return; }
    let live = true;
    setResolving(true);
    // A ledger that cannot be read, or does not answer, falls through to
    // creating a conversation, which is the behaviour this replaced: never a
    // blocked conversation surface.
    const giveUp = setTimeout(() => { if (live) setResolving(false); }, 8_000);
    const resume = (candidate: unknown) => {
      if (typeof candidate !== "string") return false;
      const to = chatPath(candidate);
      if (to === "/app/chat") return false;
      navigate(to, { replace: true });
      return true;
    };
    // The account's own answer first (C4): `/api/me` names the conversation
    // last opened in this project, and it is fetched for this surface anyway —
    // the ledger walk below is one more round trip, and it finds a run's
    // conversation, not the one the reader was in. Read defensively: a control
    // plane that predates the field answers without it.
    void fetchWebMe()
      .then((me) => {
        if (!live) return null;
        if (resume((me as { lastSessionId?: unknown } | null)?.lastSessionId)) return null;
        return listWebAgentRuns().then((runs) => {
          if (!live) return;
          const recent = runs.find((run) => chatPath(run.sessionId) !== "/app/chat");
          if (!recent || !resume(recent.sessionId)) setResolving(false);
        });
      })
      .catch(() => { if (live) setResolving(false); })
      .finally(() => clearTimeout(giveUp));
    return () => { live = false; clearTimeout(giveUp); };
  }, [onChat, sessionId, wantsNew, navigate]);

  // The frame's origin comes from the account's profile; a deployment without
  // one has no surface to show, which is a refusal rather than a wait.
  useEffect(() => {
    let live = true;
    setOriginLoading(true);
    const timer = setTimeout(() => { if (live) setOriginLoading(false); }, 15_000);
    void fetchWebMe().then(() => { if (live) setUiOrigin(webRuntimeProfile().uiOrigin); })
      .catch(() => { /* The visible unavailable state offers retry when no profile was loaded. */ })
      .finally(() => { clearTimeout(timer); if (live) setOriginLoading(false); });
    return () => { live = false; clearTimeout(timer); };
  }, [originAttempt]);

  // The runtime a conversation needs, started under the lookup above rather
  // than behind it — and on whatever page the shell loads, not only the
  // conversation: someone who opens 知识库 or 科研工具 first finds the
  // conversation already running when they get there (2026-09-22; a cold
  // start is six to eight seconds, a warm one under half a second).
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    if (warmed.current === currentProjectId) return;
    warmed.current = currentProjectId;
    warmWebRuntime(currentProjectId);
  }, [currentProjectId]);

  if (!uiOrigin) {
    if (!onChat) return null;
    if (originLoading) return <FrameSkeleton line="正在准备对话界面…" />;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-ui text-error">
        <p>对话暂时无法连接</p>
        <Button variant="ghost" onClick={() => setOriginAttempt((value) => value + 1)}>重试</Button>
      </div>
    );
  }

  return (
    // Hidden rather than unmounted: see the note above.
    <div className={cn("relative h-full w-full", !onChat && "hidden")} data-session-surface={onChat ? "visible" : "hidden"}>
      {cached.map((projectId) => (
        <div key={projectId} className={cn("absolute inset-0", projectId !== currentProjectId && "hidden")}>
          <RuntimeUiFrame
            projectId={projectId}
            origin={uiOrigin}
            sessionId={sessionId}
            active={onChat && projectId === currentProjectId}
            suspended={resolving}
          />
        </div>
      ))}
    </div>
  );
}
