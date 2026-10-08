import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { fetchWebMe, listWebAgentRuns, warmWebRuntime, webRuntimeProfile } from "@/lib/apiClient";
import { conversationTitle } from "@/lib/conversationTitles";
import { useProjectStore } from "@/lib/projects";
import { chatPath, chatSessionId, isChatPath } from "@/lib/runLocation";
import { isTaskPath } from "@/lib/taskLocation";
import { useTaskPane } from "@/lib/taskPane";

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
 * How long a released surface is waited for before the next project's
 * runtime starts anyway. The control plane answers a release once the
 * frame's connections have closed, bounded on its side at two seconds; this
 * covers the round trip. Past it the frame's own start still makes room
 * (`makeRoomFor` lets an opening take an idle runtime a tab holds), so a
 * release that never answers costs a few seconds, not the conversation.
 */
const RELEASE_WAIT_MS = 5_000;

/** The kept project shown longest ago (one never shown counts as oldest). */
function leastRecentlyShown(kept: readonly string[], shown: ReadonlyMap<string, number>): string {
  return kept.reduce((oldest, id) => ((shown.get(id) ?? 0) < (shown.get(oldest) ?? 0) ? id : oldest));
}

/** Resolves once every release has answered, or after `ms`. */
function releasesSettled(pending: readonly Promise<void>[], ms: number): Promise<void> {
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    const bound = setTimeout(resolve, ms);
    void Promise.allSettled(pending).then(() => { clearTimeout(bound); resolve(); });
  });
}

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
 *
 * THE OTHER PLACE IT SHOWS (2026-10-08, 定时任务). A task's page (`/app/autopilot/:taskId`) is a conversation too: the task bar over
 * the kernel's conversation of one execution. The page cannot render the frame — moving an iframe in the tree reloads it, the
 * cost this component exists to avoid — so it renders an empty pane and registers it (`registerTaskPane`), and this places the
 * same resident frame over that pane: positioned and sized to the pane's rectangle, kept in step as the pane, the window, the
 * scroll or the sidebar changes it. Switching pages, switching projects and collapsing the sidebar are all moves of the pane, never
 * of the frame's place in the tree.
 *
 * What `/app/chat` shows after the frame was on an execution's conversation. The frame follows the address, never the other way
 * round: on the chat surface the conversation is the one the address names, and a bare `/app/chat` resumes the one the researcher
 * last worked in (`/api/me` `lastSessionId`, which is read from researcher runs only: an execution is a machine's run and is never
 * "last open"), or opens a new one. So going back to 新对话 or to a chat from a task never leaves the researcher in the execution:
 * the frame is asked to open the chat's conversation, and the task's own conversation stays what it was, one click away on its page.
 */
export function SessionFrameHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentProjectId = useProjectStore((state) => state.currentId);
  const onChat = isChatPath(location.pathname);
  // A task's page asking for the frame over its pane: the execution's conversation, in this project.
  const taskPane = useTaskPane();
  const onTask = isTaskPath(location.pathname);
  const taskSession = onTask && taskPane && taskPane.projectId === currentProjectId ? taskPane.sessionId : null;
  // The frame is on screen: as the chat surface, or placed over a task's pane.
  const onSurface = onChat || taskSession !== null;
  const sessionId = onChat ? chatSessionId(location.pathname) : taskSession;
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

  // The projects whose surfaces are kept alive, in the order they were
  // mounted — never reordered: React moves a keyed element by reinserting it,
  // and an iframe reinserted into the document loads its page again, which is
  // the rebuild keeping it was for. Recency is kept beside it (`lastShown`).
  const [cached, setCached] = useState<string[]>(() => (onSurface ? [currentProjectId] : []));
  // When each kept project was last the one on the conversation surface.
  const lastShown = useRef(new Map<string, number>());
  const shownSeq = useRef(0);
  // The project whose runtime may start now: the current one, once the
  // surface it displaced, if any, has been released.
  const [admitted, setAdmitted] = useState(currentProjectId);
  // This shell's frame releases still in flight, by project.
  const releases = useRef(new Map<string, Promise<void>>());
  // The project a surface was just let go of for: its warm-up follows a release.
  const evictedFor = useRef<string | null>(null);
  const trackRelease = useCallback((projectId: string, released: Promise<void>) => {
    releases.current.set(projectId, released);
    const forget = () => {
      if (releases.current.get(projectId) === released) releases.current.delete(projectId);
    };
    void released.finally(forget);
    // A release that never answers is waited on for its bound once, not by
    // every switch that comes after it.
    setTimeout(forget, RELEASE_WAIT_MS);
  }, []);

  // Release first, then start (UI plan §2.2). A project with no surface here,
  // when the shell already keeps as many as a person may run, used to have
  // its runtime started while the least recently used surface was still
  // connected: the control plane refused (429) until that connection closed,
  // and the retry came seven seconds later. Now the surface goes first — its
  // frame unmounts, and the release it hands over answers once the control
  // plane has closed its connections — and only then is the next project
  // admitted: its warm-up sent, its frame mounted.
  useEffect(() => {
    if (admitted === currentProjectId) return;
    if (!cached.includes(currentProjectId) && cached.length >= CACHED_PROJECTS) {
      // The unmount happens in this render's commit, before this effect runs
      // again on the shorter list and finds the release to wait for.
      const oldest = leastRecentlyShown(cached, lastShown.current);
      evictedFor.current = currentProjectId;
      lastShown.current.delete(oldest);
      setCached((kept) => kept.filter((id) => id !== oldest));
      return;
    }
    let live = true;
    void releasesSettled([...releases.current.values()], RELEASE_WAIT_MS).then(() => {
      if (live) setAdmitted(currentProjectId);
    });
    return () => { live = false; };
  }, [admitted, currentProjectId, cached]);

  // The admitted project's surface is kept, and is now the most recently shown.
  useEffect(() => {
    if (!onSurface || admitted !== currentProjectId) return;
    lastShown.current.set(currentProjectId, ++shownSeq.current);
    // Room was made above; the bound is only ever reached if that was skipped.
    setCached((kept) => (kept.includes(currentProjectId) ? kept
      : [...(kept.length < CACHED_PROJECTS ? kept : kept.filter((id) => id !== leastRecentlyShown(kept, lastShown.current))), currentProjectId]));
  }, [onSurface, admitted, currentProjectId]);

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

  // The runtime a conversation needs, started ahead of it — on whatever page
  // the shell loads, not only the conversation: someone who opens 知识库 or
  // 科研工具 first finds the conversation already running when they get there
  // (2026-09-22; a cold start is six to eight seconds, a warm one under half
  // a second). Only once the project is admitted, so never against a surface
  // still being released. On the conversation surface itself the frame starts
  // its own — as the opening, which may make room where a warm-up may not —
  // so a warm-up beside it would only race that start.
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    if (warmed.current === admitted) return;
    warmed.current = admitted;
    const afterRelease = evictedFor.current === admitted;
    evictedFor.current = null;
    if (onSurface && uiOrigin) return;
    warmWebRuntime(admitted, { afterRelease });
  }, [admitted, onSurface, uiOrigin]);

  // Where the task page's pane is, in this host's own coordinates, kept current. A pane moves with the window, the sidebar, the task
  // bar growing a line, a scroll: its size is observed, and so are the window and every scroll, and the host re-reads it each render.
  const root = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const measure = useRef<() => void>(() => undefined);
  const paneElement = !onChat && taskSession !== null ? taskPane?.element ?? null : null;
  useLayoutEffect(() => {
    const host = root.current;
    if (!paneElement || !host) { setPlacement(null); measure.current = () => undefined; return undefined; }
    const read = () => {
      const pane = paneElement.getBoundingClientRect();
      const origin = host.getBoundingClientRect();
      const next = { left: Math.round(pane.left - origin.left), top: Math.round(pane.top - origin.top), width: Math.round(pane.width), height: Math.round(pane.height) };
      setPlacement((previous) => (previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height ? previous : next));
    };
    measure.current = read;
    read();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    observer?.observe(paneElement);
    observer?.observe(host);
    window.addEventListener("resize", read);
    document.addEventListener("scroll", read, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
      document.removeEventListener("scroll", read, true);
      measure.current = () => undefined;
    };
  }, [paneElement]);
  useLayoutEffect(() => { measure.current(); });

  if (!uiOrigin) {
    if (!onChat) return null;
    if (originLoading) return <FrameSkeleton title={conversationTitle(sessionId)} />;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-ui text-error">
        <p>对话暂时无法连接</p>
        <Button variant="ghost" onClick={() => setOriginAttempt((value) => value + 1)}>重试</Button>
      </div>
    );
  }

  // Over a task's pane the host itself takes no room and no clicks; only the frame's box, at the pane's rectangle, does.
  const placed = !onChat && taskSession !== null;
  const box = placed && placement ? { left: placement.left, top: placement.top, width: placement.width, height: placement.height } : undefined;
  return (
    // Hidden rather than unmounted: see the note above.
    <div ref={root} className={cn(onChat ? "relative h-full w-full" : placed ? "pointer-events-none absolute inset-0" : "hidden")}
      data-session-surface={onChat ? "visible" : placed ? "task" : "hidden"}>
      {cached.map((projectId) => {
        const here = projectId === currentProjectId;
        return (
          <div key={projectId} data-task-frame={placed && here ? "" : undefined}
            className={cn("absolute", !placed && "inset-0", (!here || (placed && !box)) && "hidden", placed && "pointer-events-auto")} style={here ? box : undefined}>
            <RuntimeUiFrame
              projectId={projectId}
              origin={uiOrigin}
              sessionId={sessionId}
              active={onSurface && here}
              mirrorAddress={onChat}
              suspended={onChat && resolving}
              onRelease={(released) => trackRelease(projectId, released)}
            />
          </div>
        );
      })}
      {/* This project has no surface yet: the one it displaces is still being released. */}
      {onSurface && !cached.includes(currentProjectId) && (placed
        ? box && <div className="pointer-events-auto absolute" style={box}><FrameSkeleton title={conversationTitle(sessionId)} /></div>
        : <FrameSkeleton title={conversationTitle(sessionId)} />)}
    </div>
  );
}
