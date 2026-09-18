import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { errorCodeMessage, errorCodeOutcome } from "@evimed/domain";
import { createWebRuntimeUiFrame, renewWebRuntimeUiFrame, releaseWebRuntimeUiFrame, getWebProjectId, webErrorMessage, WebApiError, webRuntimeProfile, type WebRuntimeUiFrame } from "@/lib/apiClient";
import { newRuntimeUiIntent, runtimeUiIntentFromState, type RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { searchKnowledgeSources, useFrameRunBinding } from "@/lib/runtimeUiBridge";
import { Button } from "@/components/ui/Button";
import { SHORTCUT_HELP_TOGGLE_EVENT } from "@/components/ui/ShortcutHelp";
import { useUiStore } from "@/lib/store";

/** Why this surface is showing an alert instead of the research session. */
interface FrameFailure {
  text: string;
  /** Whether building the binding again could plausibly succeed right now. A
   *  retry button offered against a spent budget is a button that is guaranteed
   *  to fail, which is the over-refusal pattern: an unexplained refusal costs
   *  less trust than one whose only offered action cannot work. */
  retryable: boolean;
  /** A ceiling or a hold. The account page is where the position is stated and
   *  where the ceiling is raised, so it is the offered action instead. */
  capped: boolean;
  /** A concurrency ceiling rather than a spend one: the action that helps is
   *  stopping a session that is already running, not raising a quota. */
  ledger?: boolean;
  /** A specific task could not be opened: offer a new one beside the retry,
   *  which would only ask for the same task again. */
  newTask?: boolean;
}

/** A failure this surface observed itself — a timer, a native error frame —
 *  where no control-plane refusal exists to explain. */
function frameFailure(text: string): FrameFailure {
  return { text, retryable: true, capped: false };
}

/**
 * A refusal the control plane explained, rendered instead of discarded.
 *
 * `createWebRuntimeUiFrame` rejects with a `WebApiError` carrying the code, the
 * declared amounts and the reset moment, and every one of them used to end in
 * `.catch(() => setError("研究会话暂时无法连接"))` — five distinct causes
 * (an expired login, a project that is gone, a disabled surface, a CSRF
 * mismatch, a network fault) collapsed into one sentence that suggests the
 * fault is transient and invites an immediate retry.
 *
 * SCOPE, stated because the gap is easy to mistake for a bug here: the spend
 * cap and the autopilot hold are NOT enforced on this call. `authorizeMethod`
 * (runtimeUiServer.mjs) checks them only for `session/prompt`, i.e. when the
 * researcher presses Send inside the kernel's own application, and that refusal
 * is delivered as a JSON error frame on the mux to third-party code we do not
 * own (runtimeUiMuxProxy.mjs `rejectStream`). No React component is on that
 * path. This function renders what does reach us.
 */
function refusedFrame(error: unknown): FrameFailure {
  const text = webErrorMessage(error, { fallback: "研究会话暂时无法连接，请重试。" });
  if (!(error instanceof WebApiError)) return frameFailure(text);
  const capped = errorCodeOutcome(error.code ?? "") === "capped" || [402, 423, 429].includes(error.status);
  // A 401 is already being handled elsewhere — `fetchWithWebAuth` announces the
  // ended session and the shell moves to the login route — so a retry here
  // would race that, not fix it.
  return { text, retryable: !capped && error.status !== 401, capped };
}

/**
 * A refusal the frame's own document announced.
 *
 * The runtime-UI origin serves a notice page when the session cannot be
 * opened, and that page now posts the code and the sentence it rendered. The
 * codes worth acting on differently are the ceilings: a session refused
 * because the deployment is already at its runtime limit is waited out or
 * freed, and pointing at the run ledger is the only action that helps.
 */
function noticedFrame(code: string, detail: string): FrameFailure {
  const text = detail || errorCodeMessage(code);
  const capped = errorCodeOutcome(code) === "capped";
  return { text, retryable: true, capped, ledger: capped };
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * A delivered file's path as the frame names it, or null. The frame is
 * third-party-composed code on another origin: the path becomes part of a
 * route here, so it is held to a workspace-relative shape — no leading slash,
 * no backslash, no `.` or `..` segment — before it is used.
 */
function artifactPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 1024 || value.startsWith("/") || value.includes("\\")) return null;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..") ? value : null;
}

/** The native application stays on its own origin and immutable project frame. */
export function RuntimeUiFrame() {
  const projectId = getWebProjectId();
  const origin = webRuntimeProfile().uiOrigin;
  // A project switch replaces the entire binding and all message state.
  return <BoundRuntimeUiFrame key={`${origin}:${projectId}`} projectId={projectId} origin={origin} />;
}

function BoundRuntimeUiFrame({ projectId, origin }: { projectId: string; origin: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const mirroredSession = useRef<{ sessionId: string; attempt: number } | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const [binding, setBinding] = useState<WebRuntimeUiFrame | null>(null);
  const [ready, setReady] = useState(false);
  const [readyGeneration, setReadyGeneration] = useState(0);
  // Counts the frame documents that announced themselves: the bridge inside
  // posts `booted` as soon as it runs, before the kernel's application is
  // ready, and that is the earliest moment it can receive anything.
  const [booted, setBooted] = useState(0);
  // The task the frame shows: the session it opened, or — while the reader is
  // in a delegated child's view — that child's root task. The run bound to it
  // is what the frame's cards and panels draw.
  const [frameTask, setFrameTask] = useState<string | null>(null);
  const theme = useUiStore((state) => state.theme);
  const [pending, setPending] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const [error, setError] = useState<FrameFailure | null>(null);
  const [leaseError, setLeaseError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const incoming = useRef(0);
  const outgoing = useRef(0);
  const currentRequest = useRef<RuntimeUiIntent | null>(null);
  const lastSent = useRef("");
  const releaseBinding = useRef<(() => void) | null>(null);
  const currentBinding = useRef<WebRuntimeUiFrame | null>(null);
  const renewBinding = useRef<(() => void) | null>(null);
  const recoveryAttempted = useRef(false);
  const nativeReady = useRef(false);
  currentBinding.current = binding;
  const frameId = binding?.frameId;
  const intent = useMemo(() => {
    const explicit = runtimeUiIntentFromState(location.state, projectId);
    if (explicit) return explicit;
    // URL updates acknowledged by the native application do not command it
    // to open itself again. Browser back/forward still yields a fresh intent.
    if (sessionId && mirroredSession.current?.sessionId === sessionId && mirroredSession.current?.attempt === attempt) return null;
    return { kind: sessionId ? "open" : "create", projectId, requestId: crypto.randomUUID(),
      sessionId: sessionId ?? crypto.randomUUID() } satisfies RuntimeUiIntent;
  }, [location.state, projectId, sessionId, attempt]);

  const navigationKey = `${location.pathname}:${runtimeUiIntentFromState(location.state, projectId)?.requestId ?? ""}`;
  const previousNavigation = useRef(navigationKey);
  useEffect(() => {
    const changed = previousNavigation.current !== navigationKey;
    previousNavigation.current = navigationKey;
    // Errors release the old cookie and document. A different target is a new
    // navigation, so recreate its binding rather than leaving the prior error sticky.
    if (changed && error) setAttempt(value => value + 1);
  }, [navigationKey, error]);

  useEffect(() => {
    let active = true;
    let frameId: string | null = null;
    const released = new Set<string>();
    releaseBinding.current = null;
    const release = (id: string) => {
      if (released.has(id)) return;
      released.add(id);
      void releaseWebRuntimeUiFrame(id).catch(() => {
        // Cookie cleanup is best effort; login expiry and revocation remain authoritative.
      });
    };
    setBinding(null); setReady(false); setBooted(0); setFrameTask(null); setPending(false); setNavigated(false); setError(null); setLeaseError(null); setRenewing(false);
    recoveryAttempted.current = false;
    nativeReady.current = false;
    incoming.current = 0; outgoing.current = 0; lastSent.current = ""; currentRequest.current = null;
    void createWebRuntimeUiFrame(projectId).then(value => {
      if (!active) { release(value.frameId); return; }
      frameId = value.frameId;
      releaseBinding.current = () => release(value.frameId);
      const url = new URL(value.frameUrl);
      if (url.origin !== origin || url.pathname !== `/__evimed/f/${value.frameId}/` || url.search || url.hash
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
        || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid frame binding");
      setBinding(value);
    }).catch((cause: unknown) => { if (active) setError(refusedFrame(cause)); });
    return () => { active = false; if (frameId) release(frameId); };
  }, [projectId, origin, attempt]);

  useEffect(() => {
    if (!frameId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;
    const schedule = (expiresAt: number) => {
      clearTimeout(timer);
      // Renew with enough margin for a background browser's throttled timers.
      timer = setTimeout(() => { void renew(); }, Math.max(1000, Math.min(120_000, (expiresAt - Date.now()) * 0.6)));
    };
    const renew = (): Promise<void> => {
      if (inFlight) return inFlight;
      const prior = currentBinding.current;
      if (!active || !prior || prior.frameId !== frameId) return Promise.resolve();
      clearTimeout(timer);
      setRenewing(true);
      inFlight = renewWebRuntimeUiFrame(prior).then(value => {
        if (!active) { void releaseWebRuntimeUiFrame(prior.frameId).catch(() => {}); return; }
        if (value.frameId !== prior.frameId || value.frameUrl !== prior.frameUrl
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
          || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid renewed binding");
        currentBinding.current = value;
        setBinding(value);
        setLeaseError(null);
        schedule(value.expiresAt);
        if (!nativeReady.current) iframe.current?.contentWindow?.postMessage({
          type: "evimed.runtime-ui.resume", version: 1, frameId, projectId, seq: ++outgoing.current,
        }, origin);
      }).catch((cause: unknown) => {
        // The renewal answers with the same envelope the creation does, so an
        // expired login or a revoked project says so instead of arriving as a
        // sentence about the connection.
        if (active) setLeaseError(webErrorMessage(cause, { fallback: "研究连接暂时无法续期，请重试" }));
      }).finally(() => {
        inFlight = null;
        if (active) setRenewing(false);
      });
      return inFlight;
    };
    const resume = () => { void renew(); };
    const foreground = () => { if (document.visibilityState === "visible") resume(); };
    renewBinding.current = resume;
    schedule(currentBinding.current?.expiresAt ?? Date.now());
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", resume);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", resume);
      if (renewBinding.current === resume) renewBinding.current = null;
    };
  }, [frameId, origin, projectId]);

  useEffect(() => {
    if (error) releaseBinding.current?.();
  }, [error, binding]);

  useEffect(() => {
    if (navigated || error) return;
    // A slow cold start is not a failure, and the old sentence
    // (「研究会话暂时无法连接」) named a cause this timer cannot know.
    const timeout = setTimeout(() => setError(frameFailure("研究运行时在 30 秒内没有就绪。冷启动有时需要更久；重试会重新建立连接。")), 30_000);
    return () => clearTimeout(timeout);
  }, [navigated, error, attempt]);

  /** One message to the frame's bridge, in the envelope and sequence it checks. */
  const postToFrame = useCallback((type: string, fields: object) => {
    if (!frameId) return;
    iframe.current?.contentWindow?.postMessage({
      ...fields, type: `evimed.runtime-ui.${type}`, version: 1, frameId, projectId, seq: ++outgoing.current,
    }, origin);
  }, [frameId, projectId, origin]);

  useLayoutEffect(() => {
    if (!binding) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
      const message = event.data;
      // A notice page carries no frame claims and no sequence: it is served
      // INSTEAD of the kernel's application, so the bridge that owns those
      // never loaded. Origin and source are the check; the payload only
      // selects which sentence is shown. Before this existed the shell learned
      // nothing from a refusal and waited out its own 30 s deadline, which
      // then blamed a slow cold start for a ceiling the server had already
      // named (2026-09-15 walk, A8).
      if (message?.type === "evimed.runtime-ui.notice" && message.version === 1 && typeof message.code === "string") {
        setError(noticedFrame(message.code, typeof message.detail === "string" ? message.detail : ""));
        return;
      }
      if (!message || message.version !== 1 || message.frameId !== binding.frameId || message.projectId !== projectId
        || !Number.isSafeInteger(message.seq) || message.seq <= incoming.current) return;
      if (message.type === "evimed.runtime-ui.booted") {
        incoming.current = message.seq;
        setBooted(value => value + 1);
      } else if (message.type === "evimed.runtime-ui.ready") {
        nativeReady.current = true;
        recoveryAttempted.current = false;
        setLeaseError(null);
        incoming.current = message.seq; lastSent.current = ""; setReady(true);
        setReadyGeneration(value => value + 1);
      } else if (message.type === "evimed.runtime-ui.connecting") {
        nativeReady.current = false;
        incoming.current = message.seq; setReady(false);
        if (navigated && !recoveryAttempted.current) { recoveryAttempted.current = true; renewBinding.current?.(); }
      } else if (message.type === "evimed.runtime-ui.error") {
        nativeReady.current = false;
        incoming.current = message.seq;
        if (navigated) {
          setReady(false);
          if (!recoveryAttempted.current) { recoveryAttempted.current = true; renewBinding.current?.(); }
          else setLeaseError("研究连接暂时无法恢复，请重试");
        } else setError(frameFailure("研究会话没有完成初始化，请重试。"));
      } else if (message.type === "evimed.runtime-ui.shell-navigate") {
        // The rail inside the frame asking the shell to move. A closed
        // vocabulary, mapped here: the frame runs third-party-composed code on
        // its own origin, so a destination it could spell freely would be a
        // redirect it could choose.
        const routes: Record<string, string> = {
          "new-task": "/app/chat", runs: "/app/runs", knowledge: "/app/files",
          memory: "/app/memory", capabilities: "/app/capabilities", account: "/app/account",
        };
        const to = routes[String(message.destination)];
        if (!to) return;
        // A brief from a capability card in the kernel's hero. Bounded here as
        // well as in the frame: this is a message from another origin, and
        // `newRuntimeUiIntent` hands whatever it is to the composer.
        const draft = typeof message.draft === "string" && message.draft && message.draft.length <= 100_000
          ? message.draft : undefined;
        incoming.current = message.seq;
        navigate(to, to === "/app/chat" ? { state: { runtimeUiIntent: newRuntimeUiIntent(draft) } } : undefined);
      } else if (message.type === "evimed.runtime-ui.shell-shortcut") {
        // A shell shortcut pressed while focus was inside the frame (U8). The
        // same closed set the bridge forwards; anything else is dropped.
        const ui = useUiStore.getState();
        const shortcuts: Record<string, () => void> = {
          "command-palette": () => ui.setPaletteOpen(!ui.paletteOpen),
          sidebar: () => ui.toggleSidebar(),
          shortcuts: () => window.dispatchEvent(new Event(SHORTCUT_HELP_TOGGLE_EVENT)),
        };
        const run = shortcuts[String(message.shortcut)];
        if (!run) return;
        incoming.current = message.seq;
        run();
      } else if (message.type === "evimed.runtime-ui.open-artifact") {
        // A file the frame's 交付物 or 依据 tab asked to read. It opens in the
        // shell's reader, behind the control plane's own file boundary; the
        // frame never reads a file itself.
        const runId = typeof message.runId === "string" && SESSION_ID.test(message.runId) ? message.runId : null;
        const path = artifactPath(message.path);
        if (!runId || !path) return;
        incoming.current = message.seq;
        const anchor = typeof message.anchor === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(message.anchor) ? `#${message.anchor}` : "";
        navigate(`/app/runs/${encodeURIComponent(runId)}/files/${path.split("/").map(encodeURIComponent).join("/")}${anchor}`);
      } else if (message.type === "evimed.runtime-ui.kb-query"
        && typeof message.requestId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(message.requestId)) {
        // The frame's `@` menu asking for the project's parsed sources. The
        // answer carries ids and names only; the run reads the text from its
        // own synced knowledge base.
        incoming.current = message.seq;
        const requestId = message.requestId;
        const query = typeof message.query === "string" ? message.query.slice(0, 200) : "";
        void searchKnowledgeSources(projectId, query).then(
          (items) => postToFrame("kb-result", { requestId, ok: true, items }),
          () => postToFrame("kb-result", { requestId, ok: false, items: [] }),
        );
      } else if (message.type === "evimed.runtime-ui.ack") {
        const request = currentRequest.current;
        if (!request || message.requestId !== request.requestId || typeof message.ok !== "boolean"
          || (message.ok && (typeof message.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(message.sessionId)
            || (request.kind === "open" && message.sessionId !== request.sessionId)))) return;
        incoming.current = message.seq;
        if (!message.ok) { setError({ ...frameFailure("研究任务暂时无法打开"), newTask: request.kind === "open" }); return; }
        currentRequest.current = null; setPending(false); setNavigated(true);
        mirroredSession.current = { sessionId: message.sessionId, attempt };
        setFrameTask(message.sessionId);
        // Remove only this acknowledged request. A later navigation intent
        // must survive an acknowledgement from the previous operation.
        if (intent?.requestId === request.requestId) {
          const nextState = { ...location.state };
          delete nextState.runtimeUiIntent;
          navigate(`/app/chat/${encodeURIComponent(message.sessionId)}`, { replace: true, state: nextState });
        }
      } else if (message.type === "evimed.runtime-ui.session" && message.subagent === true
        && typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId)
        && typeof message.rootSessionId === "string" && SESSION_ID.test(message.rootSessionId)) {
        // A delegated child's view. Its address is its parent's — the kernel
        // refuses to open a child by its own id — so it is not a task of its
        // own: the URL stays on the task, and the run bound to the task keeps
        // drawing in the frame.
        incoming.current = message.seq;
        if (!currentRequest.current && navigated) setFrameTask(message.rootSessionId);
      } else if (message.type === "evimed.runtime-ui.session" && (message.sessionId === null
        || (typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId)))) {
        incoming.current = message.seq;
        if (!currentRequest.current && navigated) setFrameTask(message.sessionId);
        if (currentRequest.current || !navigated || mirroredSession.current?.sessionId === message.sessionId) return;
        mirroredSession.current = message.sessionId === null ? null : { sessionId: message.sessionId, attempt };
        // Pushed, not replaced: choosing another task inside the frame is a
        // navigation the reader expects Back to undo (U9). A native clear is a
        // deliberate new task, and says so, so the route does not go looking
        // for a recent task to resume instead.
        if (message.sessionId === null) navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } });
        else navigate(`/app/chat/${encodeURIComponent(message.sessionId)}`, { state: null });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [binding, origin, projectId, intent, location, navigate, navigated, attempt, postToFrame]);

  useEffect(() => {
    if (!ready || error || !binding || !intent || !iframe.current?.contentWindow) return;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)) { setError(frameFailure("研究任务暂时无法打开")); return; }
    const key = `${binding.frameId}:${intent.requestId}`;
    if (lastSent.current === key) return;
    lastSent.current = key; currentRequest.current = intent; setPending(true);
    iframe.current.contentWindow.postMessage({
      type: "evimed.runtime-ui.navigate", version: 1, frameId: binding.frameId, projectId,
      requestId: intent.requestId, seq: ++outgoing.current,
      intent: { kind: intent.kind, sessionId: intent.sessionId, ...(intent.draft === undefined ? {} : { draft: intent.draft }) },
    }, origin);
  }, [ready, readyGeneration, error, binding, intent, projectId, origin]);

  // The shell's light/dark/system choice, in the frame (C9 `theme`). The
  // kernel's page has no channel of its own for it — no parameter, no storage
  // key — so the bridge applies it with the theme runtime's `setTheme`. Sent
  // the moment the frame's bridge is listening, which is before the kernel's
  // application is ready: the flip happens under the waiting cover, not in
  // front of the reader. `resolved` follows the system scheme while the
  // preference is `system`.
  useEffect(() => {
    if (!booted || error || !frameId) return;
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const post = () => {
      const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
      postToFrame("theme", { preference: theme, resolved });
    };
    post();
    if (theme !== "system" || !media) return;
    media.addEventListener("change", post);
    return () => media.removeEventListener("change", post);
  }, [booted, error, frameId, theme, postToFrame]);

  // The run bound to the task on screen, for the frame's cards and panels
  // (C9 `run-state`, plus the claims and sources of its report). Only once the
  // frame's bridge is listening and a task is open; cleared when the task
  // changes or has no run.
  const postRunState = useCallback((state: object) => postToFrame("run-state", state), [postToFrame]);
  const postEvidence = useCallback((evidence: object | null) => postToFrame("evidence", evidence ?? { runId: null }), [postToFrame]);
  useFrameRunBinding({ sessionId: frameTask, enabled: booted > 0 && !error && Boolean(frameId), postRunState, postEvidence });

  // Focus goes where the next keystroke belongs (U8): into the conversation
  // once it is open — unless the reader already put focus somewhere else in the
  // shell — and onto 「重试」 when opening failed, instead of staying on
  // whatever had it before the page changed under it.
  useEffect(() => {
    if (!navigated || pending || error || !ready) return;
    const active = document.activeElement;
    if (!active || active === document.body) iframe.current?.focus();
  }, [navigated, pending, error, ready]);
  useEffect(() => {
    if (error?.retryable) retryButton.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!pending || error) return;
    const timeout = setTimeout(() => setError(frameFailure("研究任务暂时无法打开")), 20_000);
    return () => clearTimeout(timeout);
  }, [pending, error, attempt, intent?.requestId]);

  return (
    <div className="relative h-full w-full">
      {error ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-error">
          <p>{error.text}</p>
          {error.retryable && <Button ref={retryButton} variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>}
          {error.newTask && <Button variant="ghost" onClick={() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } })}>新建任务</Button>}
          {error.ledger
            ? <Button variant="ghost" onClick={() => navigate("/app/runs")}>去运行记录</Button>
            : error.capped && <Button variant="ghost" onClick={() => navigate("/app/account")}>查看账户与额度</Button>}
        </div>
      ) : (
        <>
          {navigated && (leaseError || !ready || (renewing && binding && binding.expiresAt <= Date.now())) && (
            <div role={leaseError ? "alert" : "status"} className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg text-ui-sm text-muted">
              <p>{leaseError ?? "正在恢复研究连接…"}</p>
              {leaseError && <Button variant="ghost" onClick={() => renewBinding.current?.()} disabled={renewing}>重新连接</Button>}
            </div>
          )}
          {(!navigated || pending) && <div role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-bg text-ui-sm text-muted">
            {pending ? "正在打开研究任务…" : "正在启动研究运行时…"}
          </div>}
          {binding && <iframe
            key={binding.frameId} ref={iframe} src={binding.frameUrl} title="研究会话"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
            allow="clipboard-read; clipboard-write"
          />}
        </>
      )}
    </div>
  );
}
