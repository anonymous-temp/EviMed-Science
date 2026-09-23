import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { errorCodeMessage, errorCodeOutcome } from "@evimed/domain";
import { createWebRuntimeUiFrame, fetchWebRuntimeStatus, listWebResearchAgents, renewWebRuntimeUiFrame, releaseWebRuntimeUiFrame, startWebRuntime, webErrorMessage, WebApiError, type WebRuntimeStartStatus, type WebRuntimeUiFrame } from "@/lib/apiClient";
import { newRuntimeUiIntent, runtimeUiIntentFromState, type RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { bindConversationCapability, conversationCapability } from "@/lib/dispatch";
import { provideFrameSessionSearch, searchKnowledgeSources, useFrameRunBinding, type FrameSessionSearchResult } from "@/lib/runtimeUiBridge";
import { useFrameReplyChecks } from "@/lib/replyChecks";
import { Button } from "@/components/ui/Button";
import { SHORTCUT_HELP_TOGGLE_EVENT } from "@/components/ui/ShortcutHelp";
import { useUiStore } from "@/lib/store";

/** Why this surface is showing an alert instead of the conversation. */
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
   *  stopping a conversation that is already running, not raising a quota, so
   *  the account page is not offered. */
  concurrency?: boolean;
  /** A specific conversation could not be opened: offer a new one beside the
   *  retry, which would only ask for the same conversation again. */
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
 * one sentence about the connection — five distinct causes
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
  const text = webErrorMessage(error, { fallback: "对话暂时无法连接，请重试。" });
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
 * codes worth acting on differently are the ceilings: a conversation refused
 * because the deployment is already at its runtime limit is waited out or
 * freed, and no quota page can lift it.
 */
/** The slot cap, said as what it is. On 2026-09-15 the only runtime slot of
 *  the deployment was taken and the shell told the second reader that "cold
 *  starts sometimes take longer" — a retry loop against a limit that no wait
 *  could lift. What helps is a running conversation ending, or stopping one —
 *  which is done in the conversation itself, from its own composer or from the
 *  menu on its row in the sidebar. */
const RUNTIME_SLOT_CAP_TEXT = "同时运行的研究环境已达本部署上限，这次没有为你新开一个。等正在进行的对话结束，或在侧栏里停掉一个，再重试。";

function noticedFrame(code: string, detail: string): FrameFailure {
  const text = detail || (code === "runtime_limit_exceeded" ? RUNTIME_SLOT_CAP_TEXT : errorCodeMessage(code));
  const capped = errorCodeOutcome(code) === "capped";
  return { text, retryable: true, capped, concurrency: capped };
}

/**
 * The refusal of this opening's own start, when it is one a wait will not lift.
 *
 * Read from the start call the opening makes itself rather than from a status
 * snapshot: a refusal recorded by an earlier attempt must not fail the retry
 * the reader pressed after freeing a slot.
 */
function refusedStart(error: unknown): FrameFailure | null {
  if (!(error instanceof WebApiError) || errorCodeOutcome(error.code ?? "") !== "capped") return null;
  if (error.code === "runtime_limit_exceeded") return { text: RUNTIME_SLOT_CAP_TEXT, retryable: true, capped: true, concurrency: true };
  return refusedFrame(error);
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

/**
 * The moments of opening a conversation, in the order they happen. The first three are
 * the runtime's own start as the control plane reports it (plan §3.1 #8):
 * 准备环境, 同步文件 and 启动内核. A local container mounts the project's
 * files, so only a remote session has the second one, and the Docker provider
 * never shows it.
 */
export type OpenStep = "environment" | "sync" | "kernel" | "interface" | "task";
const OPEN_STEP_LABELS: Record<OpenStep, string> = {
  environment: "准备环境", sync: "同步文件", kernel: "启动内核", interface: "载入界面", task: "打开对话",
};
/** What each moment is doing, said once it has taken five seconds. */
const OPEN_STEP_NOTES: Record<OpenStep, string> = {
  environment: "正在为这个项目准备研究环境；已在运行的环境会直接复用。",
  sync: "正在把项目文件同步到研究环境；文件较多时会久一些。",
  kernel: "研究环境已就绪，正在启动研究内核。",
  interface: "研究内核已启动，正在载入对话界面；网络较慢时会多等一会儿。",
  task: "正在读取这条对话的完整记录；进行了很久的对话，记录会大一些。",
};
/** The steps a provider goes through. */
export function openSteps(provider: string | null): OpenStep[] {
  return provider === "agentbay"
    ? ["environment", "sync", "kernel", "interface", "task"]
    : ["environment", "kernel", "interface", "task"];
}

/**
 * How long a moment may take before this surface stops waiting, counted from
 * the last sign of progress rather than from the click.
 *
 * One 30 s deadline used to cover everything, and on 2026-09-19 it fired on a
 * start that was working: a cold runtime, then 4.5 MB of application over the
 * researcher's link, then the kernel's first calls, each on time and together
 * over 30 s (the owner's screenshot, 10:43). The runtime's three moments share
 * one allowance that each new moment restarts (preparing may include retiring
 * an idle runtime of the same account first, `makeRoomFor`); loading the
 * interface is the download, and the frame reporting that its bridge booted
 * restarts the count. Opening the task has its own 20 s deadline below.
 */
const OPEN_STEP_DEADLINES_MS: Record<Exclude<OpenStep, "task">, number> = {
  environment: 90_000, sync: 90_000, kernel: 90_000, interface: 60_000,
};
const OPEN_STEP_TIMEOUTS: Record<Exclude<OpenStep, "task">, string> = {
  environment: "研究环境 90 秒内没有准备好；重试会重新建立连接。",
  sync: "项目文件 90 秒内没有同步完成；重试会重新建立连接。",
  kernel: "研究内核 90 秒内没有启动完成；重试会重新建立连接。",
  interface: "对话界面 60 秒内没有载入完成，可能是网络较慢；重试会重新建立连接。",
};

/**
 * How a renewal that failed is retried: silently, and at widening intervals.
 *
 * On 2026-09-20 one renewal that threw in the browser covered a working
 * conversation with a blocking alert — all 52 renewals of that day reached the
 * server and all 52 answered 200, so the one the reader saw was a local
 * network blip. A blip is waited out, not announced, and the lease it renews
 * lasts far longer than this ladder.
 */
const RENEW_RETRY_MS = [1_000, 3_000, 10_000, 30_000] as const;

/**
 * The wait before a conversation is on screen, drawn as what it is: the composer the
 * reader is about to type into, and the moments the opening goes through, each
 * advanced by the event that ends it — the control plane's account of the
 * runtime start, the kernel's page booting and reporting ready, the task's
 * acknowledgement. A single sentence used to stand for all of them, so a slow
 * kernel, a slot the deployment had run out of and a slow read looked the
 * same, and none said which it was. After five seconds in one moment a line
 * says what that moment is doing.
 */
export function FrameWaiting({ step, provider = null, line }: { step: OpenStep; provider?: string | null; line?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 5_000);
    return () => clearTimeout(timer);
  }, [step]);
  const steps = openSteps(provider);
  const current = Math.max(0, steps.indexOf(step));
  return (
    <div role="status" aria-live="polite" data-open-stage={current} data-open-step={step} className="absolute inset-0 z-10 flex flex-col bg-bg">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <ol aria-label="打开进度" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-ui-sm">
          {steps.map((key, index) => (
            <li
              key={key}
              aria-current={index === current ? "step" : undefined}
              className={index < current ? "text-ok" : index === current ? "font-medium text-text" : "text-muted"}
            >
              {index < current ? `✓ ${OPEN_STEP_LABELS[key]}` : OPEN_STEP_LABELS[key]}
            </li>
          ))}
        </ol>
        <p className="text-ui-sm text-muted">{line ?? `正在${OPEN_STEP_LABELS[step]}…`}</p>
        {slow && <p className="max-w-content-narrow text-caption text-muted">{OPEN_STEP_NOTES[step]}</p>}
      </div>
      <div aria-hidden="true" className="mx-auto mb-6 w-full max-w-content px-4">
        <div className="h-24 animate-pulse rounded-card border border-border bg-surface" />
      </div>
    </div>
  );
}

/**
 * A wait with nothing to say about it.
 *
 * Shown when the frame's own document is loading: the four moments above
 * describe a runtime starting, and a reader who has one running reads them as
 * a cold start that is not happening (plan §3.11).
 */
export function FrameSkeleton({ line = "正在打开对话…" }: { line?: string }) {
  return (
    <div role="status" aria-live="polite" data-frame-skeleton="" className="absolute inset-0 z-10 flex flex-col bg-bg">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-ui-sm text-muted">{line}</p>
      </div>
      <div aria-hidden="true" className="mx-auto mb-6 w-full max-w-content px-4">
        <div className="h-24 animate-pulse rounded-card border border-border bg-surface" />
      </div>
    </div>
  );
}

/**
 * The kernel's own application, on its own origin and immutable project frame.
 *
 * Rendered by the shell rather than by the chat route (`SessionFrameHost`), so
 * that leaving the conversation for any other page hides this rather than
 * unmounting it. An unmount DELETEs the binding, and the next visit paid for a
 * new container document, a new websocket and a fresh kernel handshake — seven
 * times in twenty-five minutes on production (2026-09-20 walk, fact 1).
 *
 * `active` is the conversation surface being on screen in this project:
 * inactive frames keep their document and their lease and send nothing.
 */
export function RuntimeUiFrame({ projectId, origin, sessionId = null, active = true, suspended = false }: {
  projectId: string;
  origin: string;
  /** The conversation this surface should be showing, from the address. */
  sessionId?: string | null;
  active?: boolean;
  /** The address does not yet name a conversation and the shell is finding
   *  one: hold the opening request, but let the runtime warm up meanwhile. */
  suspended?: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
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
  // The catalogue, for turning a capability id into the {id, version} pair a
  // binding needs. Read once per surface; a tool the deployment does not offer
  // is a choice this shell refuses rather than binds.
  const capabilityAgents = useRef(new Map<string, { agentId: string; agentVersion: string }>());
  const theme = useUiStore((state) => state.theme);
  const [pending, setPending] = useState(false);
  const [navigated, setNavigated] = useState(false);
  const [error, setError] = useState<FrameFailure | null>(null);
  /** A renewal that failed, kept while it is retried underneath. */
  const [leaseFailure, setLeaseFailure] = useState<{ text: string; final: boolean } | null>(null);
  /** The lease this frame holds has run out. Timed rather than polled. */
  const [leaseExpired, setLeaseExpired] = useState(false);
  /** The kernel's own page said it cannot reconnect — a different fact from a
   *  renewal failing, and the one the reader can do nothing silent about. */
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The control plane's account of the runtime start this opening waits on.
  const [startStatus, setStartStatus] = useState<WebRuntimeStartStatus | null>(null);
  const incoming = useRef(0);
  const outgoing = useRef(0);
  // Conversation searches waiting for the frame's answer, by request id.
  const searches = useRef(new Map<string, (result: FrameSessionSearchResult) => void>());
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
    // A frame the reader is not looking at holds its document and its lease
    // and commands nothing: two cached projects must not both open a session.
    if (!active || suspended) return null;
    const explicit = runtimeUiIntentFromState(location.state, projectId);
    if (explicit) return explicit;
    // URL updates acknowledged by the native application do not command it
    // to open itself again. Browser back/forward still yields a fresh intent.
    if (sessionId && mirroredSession.current?.sessionId === sessionId && mirroredSession.current?.attempt === attempt) return null;
    return { kind: sessionId ? "open" : "create", projectId, requestId: crypto.randomUUID(),
      sessionId: sessionId ?? crypto.randomUUID() } satisfies RuntimeUiIntent;
  }, [active, suspended, location.state, projectId, sessionId, attempt]);

  const navigationKey = `${location.pathname}:${runtimeUiIntentFromState(location.state, projectId)?.requestId ?? ""}`;
  const previousNavigation = useRef(navigationKey);
  useEffect(() => {
    const changed = previousNavigation.current !== navigationKey;
    previousNavigation.current = navigationKey;
    // Errors release the old cookie and document. A different target is a new
    // navigation, so recreate its binding rather than leaving the prior error
    // sticky. Only for the frame on screen: a hidden one would rebuild itself
    // on every navigation the shell makes elsewhere.
    if (changed && error && active) setAttempt(value => value + 1);
  }, [navigationKey, error, active]);

  useEffect(() => {
    let live = true;
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
    setBinding(null); setReady(false); setBooted(0); setFrameTask(null); setPending(false); setNavigated(false); setError(null);
    setLeaseFailure(null); setLeaseExpired(false); setNativeError(null); setRenewing(false); setStartStatus(null);
    recoveryAttempted.current = false;
    nativeReady.current = false;
    incoming.current = 0; outgoing.current = 0; lastSent.current = ""; currentRequest.current = null;
    void createWebRuntimeUiFrame(projectId).then(value => {
      if (!live) { release(value.frameId); return; }
      frameId = value.frameId;
      releaseBinding.current = () => release(value.frameId);
      const url = new URL(value.frameUrl);
      if (url.origin !== origin || url.pathname !== `/__evimed/f/${value.frameId}/` || url.search || url.hash
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
        || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid frame binding");
      setBinding(value);
    }).catch((cause: unknown) => { if (live) setError(refusedFrame(cause)); });
    return () => { live = false; if (frameId) release(frameId); };
  }, [projectId, origin, attempt]);

  useEffect(() => {
    if (!frameId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;
    /** Consecutive failed renewals, which is what widens the retry interval. */
    let failures = 0;
    const after = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => { void renew(); }, Math.max(1_000, delay));
    };
    // Halfway through what is left, so a renewal has the whole second half of
    // the lease to succeed in before anything is lost, and a background tab's
    // throttled timers still have room.
    const schedule = (expiresAt: number) => after((expiresAt - Date.now()) * 0.5);
    const renew = (): Promise<void> => {
      if (inFlight) return inFlight;
      const prior = currentBinding.current;
      if (!live || !prior || prior.frameId !== frameId) return Promise.resolve();
      clearTimeout(timer);
      setRenewing(true);
      inFlight = renewWebRuntimeUiFrame(prior).then(value => {
        if (!live) { void releaseWebRuntimeUiFrame(prior.frameId).catch(() => {}); return; }
        if (value.frameId !== prior.frameId || value.frameUrl !== prior.frameUrl
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
          || typeof value.renewalToken !== "string" || !value.renewalToken) throw new Error("Invalid renewed binding");
        failures = 0;
        currentBinding.current = value;
        setBinding(value);
        setLeaseFailure(null);
        schedule(value.expiresAt);
        if (!nativeReady.current) iframe.current?.contentWindow?.postMessage({
          type: "evimed.runtime-ui.resume", version: 1, frameId, projectId, seq: ++outgoing.current,
        }, origin);
      }).catch((cause: unknown) => {
        if (!live) return;
        // An expired login is the one failure retrying cannot fix: the shell is
        // already moving to the login route on the same answer. Everything else
        // is retried underneath, and the lease outlives the whole ladder.
        const expiredLogin = cause instanceof WebApiError && cause.status === 401;
        failures += 1;
        // The renewal answers with the same envelope the creation does, so an
        // expired login or a revoked project says so instead of arriving as a
        // sentence about the connection.
        setLeaseFailure({ text: webErrorMessage(cause, { fallback: "研究连接暂时无法续期，正在自动重连" }), final: expiredLogin });
        if (!expiredLogin) after(RENEW_RETRY_MS[Math.min(failures - 1, RENEW_RETRY_MS.length - 1)]);
      }).finally(() => {
        inFlight = null;
        if (live) setRenewing(false);
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
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("online", resume);
      if (renewBinding.current === resume) renewBinding.current = null;
    };
  }, [frameId, origin, projectId]);

  // When this frame's lease runs out, timed from the lease itself. Only a
  // failure that is still standing at that moment is worth covering the
  // conversation for; before it, a retry is still ahead of the reader.
  useEffect(() => {
    if (!binding) { setLeaseExpired(false); return; }
    const remaining = binding.expiresAt - Date.now();
    if (remaining <= 0) { setLeaseExpired(true); return; }
    setLeaseExpired(false);
    const timer = setTimeout(() => setLeaseExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [binding]);

  useEffect(() => {
    if (error) releaseBinding.current?.();
  }, [error, binding]);

  // The runtime is up once the control plane says so or the kernel's own page
  // has booted inside the frame, whichever is heard first.
  const runtimeUp = navigated || ready || booted > 0 || startStatus?.running === true;
  // Whether this opening had to start a runtime, decided once and kept: it is
  // what says which cover the reader gets, and a cover that changed its mind
  // halfway would be the cold-start theatre this removes (plan §3.11).
  const [coldStart, setColdStart] = useState<boolean | null>(null);
  useEffect(() => { setColdStart(null); }, [projectId, attempt]);
  useEffect(() => {
    // Only once there is an answer: a runtime already running reports so on
    // the first status read, and a frame whose page boots proves it too.
    setColdStart((known) => (known !== null || (!startStatus && !runtimeUp) ? known : !runtimeUp));
  }, [startStatus, runtimeUp]);
  const runtimeStep: OpenStep = startStatus?.startStage ?? "environment";
  // Which moment the opening is in, for its deadline; opening the task (a
  // request in flight) is timed by its own deadline further down.
  const deadlineStep: Exclude<OpenStep, "task"> | null = navigated || pending || ready ? null
    : runtimeUp && binding ? "interface" : runtimeStep === "sync" || runtimeStep === "kernel" ? runtimeStep : "environment";
  const displayStep: OpenStep = pending || ready ? "task" : runtimeUp ? "interface" : runtimeStep;
  useEffect(() => {
    if (error || deadlineStep === null) return;
    // A slow start is not a failure while it is moving: each moment the
    // control plane reports, and the frame's bridge booting, restarts the
    // count (see OPEN_STEP_DEADLINES_MS).
    const timeout = setTimeout(() => setError(frameFailure(OPEN_STEP_TIMEOUTS[deadlineStep])), OPEN_STEP_DEADLINES_MS[deadlineStep]);
    return () => clearTimeout(timeout);
  }, [error, attempt, deadlineStep, booted]);

  // This opening's own start. The frame document starts the runtime too, and
  // the two join one start on the server; this call is made because its answer
  // can be read — a start refused into a frame is a page this shell cannot see
  // the status of — and because it belongs to this attempt, a refusal from an
  // earlier one cannot fail the retry.
  useEffect(() => {
    let live = true;
    void startWebRuntime().catch((cause: unknown) => {
      const refusal = live ? refusedStart(cause) : null;
      if (refusal) setError(refusal);
    });
    return () => { live = false; };
  }, [projectId, attempt]);

  // The moment the start is in, asked while the runtime is not up yet. A
  // status read that fails changes nothing: the deadline stays in charge.
  useEffect(() => {
    if (error || runtimeUp) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      void fetchWebRuntimeStatus()
        .then((status) => { if (live) setStartStatus(status); })
        .catch(() => {})
        .finally(() => { if (live) timer = setTimeout(poll, 1_500); });
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [error, runtimeUp, attempt, projectId]);

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
        setNativeError(null);
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
          else setNativeError("研究连接暂时无法恢复，请重试");
        } else setError(frameFailure("对话没有完成初始化，请重试。"));
      } else if (message.type === "evimed.runtime-ui.shell-navigate") {
        // The rail inside the frame asking the shell to move. A closed
        // vocabulary, mapped here: the frame runs third-party-composed code on
        // its own origin, so a destination it could spell freely would be a
        // redirect it could choose.
        const routes: Record<string, string> = {
          "new-task": "/app/chat", knowledge: "/app/files",
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
      } else if (message.type === "evimed.runtime-ui.search-result" && typeof message.requestId === "string" && searches.current.has(message.requestId)) {
        incoming.current = message.seq;
        const settle = searches.current.get(message.requestId)!;
        searches.current.delete(message.requestId);
        const raw: unknown[] = Array.isArray(message.items) ? message.items : [];
        const items = raw
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .filter((item) => typeof item.sessionId === "string" && SESSION_ID.test(item.sessionId))
          .slice(0, 20)
          .map((item) => ({ sessionId: String(item.sessionId), title: String(item.title ?? "").slice(0, 200), snippet: String(item.snippet ?? "").slice(0, 240) }));
        settle(message.ok === true
          ? { ok: true, items, hasMore: message.hasMore === true }
          : { ok: false, items: [], hasMore: false, error: typeof message.error === "string" ? message.error.slice(0, 80) : "search_failed" });
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
      } else if (message.type === "evimed.runtime-ui.bind-capability") {
        // The frame's tool grid, tool page or `/工具` command choosing which
        // research tool this conversation runs. The frame shows the choice; the
        // control plane is what makes it true — a bound session is the route
        // the router does not re-decide. A binding cannot change once its
        // session has run, so the answer may be a fresh conversation, and the
        // draft the researcher had already typed travels with it.
        incoming.current = message.seq;
        const capabilityId = typeof message.capabilityId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(message.capabilityId)
          ? message.capabilityId : null;
        const draft = typeof message.draft === "string" && message.draft.length <= 100_000 ? message.draft : "";
        const agent = capabilityId ? capabilityAgents.current.get(capabilityId) ?? null : null;
        if (capabilityId && !agent) return;
        const from = typeof message.sessionId === "string" && SESSION_ID.test(message.sessionId) ? message.sessionId : null;
        void bindConversationCapability(from, agent)
          .then((bound) => {
            if (!bound.rebound) { postToFrame("capability", { capabilityId, sessionId: bound.sessionId }); return; }
            navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(draft || undefined, bound.sessionId), capabilityId } });
          })
          .catch(() => { postToFrame("capability", { capabilityId: null, sessionId: from }); });
      } else if (message.type === "evimed.runtime-ui.ack") {
        const request = currentRequest.current;
        if (!request || message.requestId !== request.requestId || typeof message.ok !== "boolean"
          || (message.ok && (typeof message.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(message.sessionId)
            || (request.kind === "open" && message.sessionId !== request.sessionId)))) return;
        incoming.current = message.seq;
        if (!message.ok) { setError({ ...frameFailure("这条对话暂时无法打开"), newTask: request.kind === "open" }); return; }
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
        // A branch of a finished turn (`session/fork`) is a task of its own —
        // the control plane takes it into the ledger — and says where it came
        // from, for whatever renders the task.
        else navigate(`/app/chat/${encodeURIComponent(message.sessionId)}`, {
          state: typeof message.forkedFrom === "string" && SESSION_ID.test(message.forkedFrom) ? { forkedFrom: message.forkedFrom } : null,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [binding, origin, projectId, intent, location, navigate, navigated, attempt, postToFrame]);

  useEffect(() => {
    if (!ready || error || !binding || !intent || !iframe.current?.contentWindow) return;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)) { setError(frameFailure("这条对话暂时无法打开")); return; }
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

  // The kernel's full-text conversation search, offered to the shell's task
  // list while the frame is ready: only the frame holds the connection that
  // can ask. Each question is answered by request id or given up after 8 s.
  useEffect(() => {
    if (!ready || error || !frameId) return undefined;
    const pending = searches.current;
    const release = provideFrameSessionSearch((query, signal) => new Promise<FrameSessionSearchResult>((resolve) => {
      const trimmed = query.trim().slice(0, 200);
      if (!trimmed) { resolve({ ok: true, items: [], hasMore: false }); return; }
      const requestId = `s${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const finish = (result: FrameSessionSearchResult) => { clearTimeout(timer); pending.delete(requestId); resolve(result); };
      const timer = setTimeout(() => finish({ ok: false, items: [], hasMore: false, error: "search_timeout" }), 8000);
      pending.set(requestId, finish);
      signal?.addEventListener("abort", () => finish({ ok: false, items: [], hasMore: false, error: "aborted" }), { once: true });
      postToFrame("search", { requestId, query: trimmed });
    }));
    return () => {
      release();
      for (const settle of [...pending.values()]) settle({ ok: false, items: [], hasMore: false, error: "search_unavailable" });
      pending.clear();
    };
  }, [ready, error, frameId, postToFrame]);

  // The run bound to the task on screen, for the frame's cards and panels
  // (C9 `run-state`, plus the claims and sources of its report). Only once the
  // frame's bridge is listening and a task is open; cleared when the task
  // changes or has no run.
  useEffect(() => {
    let active = true;
    void listWebResearchAgents()
      .then((agents) => {
        if (!active) return;
        capabilityAgents.current = new Map(agents.map((agent) => [agent.id, { agentId: agent.id, agentVersion: agent.version }]));
      })
      .catch(() => { /* a catalogue that did not load costs the tool chip, never the conversation */ });
    return () => { active = false; };
  }, []);

  // Which tool the conversation on screen runs, as the control plane holds it.
  // The frame draws the chip and the tool's page from this; it never decides it.
  useEffect(() => {
    if (!booted || error || !frameId) return undefined;
    let active = true;
    if (!frameTask) { postToFrame("capability", { capabilityId: null, sessionId: null }); return undefined; }
    void conversationCapability(frameTask)
      .then((capabilityId) => { if (active) postToFrame("capability", { capabilityId, sessionId: frameTask }); })
      .catch(() => { /* the chip stays absent rather than wrong */ });
    return () => { active = false; };
  }, [booted, error, frameId, frameTask, postToFrame]);

  const postRunState = useCallback((state: object) => postToFrame("run-state", state), [postToFrame]);
  const postEvidence = useCallback((evidence: object | null) => postToFrame("evidence", evidence ?? { runId: null }), [postToFrame]);
  useFrameRunBinding({ sessionId: frameTask, enabled: booted > 0 && !error && Boolean(frameId), postRunState, postEvidence });
  // The independent reviewer's checks of this conversation's answers (L1): a
  // row under each checked answer, drawn by the frame from what the shell reads.
  const postReplyChecks = useCallback((payload: object) => postToFrame("reply-check", payload), [postToFrame]);
  useFrameReplyChecks({ projectId, sessionId: frameTask, enabled: booted > 0 && !error && Boolean(frameId), post: postReplyChecks });

  // Focus goes where the next keystroke belongs (U8): into the conversation
  // once it is open — unless the reader already put focus somewhere else in the
  // shell — and onto 「重试」 when opening failed, instead of staying on
  // whatever had it before the page changed under it.
  useEffect(() => {
    if (!navigated || pending || error || !ready) return;
    const focused = document.activeElement;
    if (!focused || focused === document.body) iframe.current?.focus();
  }, [navigated, pending, error, ready]);
  useEffect(() => {
    if (error?.retryable) retryButton.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!pending || error) return;
    const timeout = setTimeout(() => setError(frameFailure("这条对话暂时无法打开")), 20_000);
    return () => clearTimeout(timeout);
  }, [pending, error, attempt, intent?.requestId]);

  // What covers the conversation, and when.
  //
  // The four moments belong to a runtime that is actually starting, so they
  // are shown only for an opening that had to start one. When it was already
  // running, a document still loading gets a neutral skeleton; and once this
  // frame has opened a conversation at all, switching to another one shows
  // nothing — the kernel is on screen and keeps its own composer. Until
  // 2026-09-20 every opening got the four steps, so a conversation switch
  // inside a live runtime read as a cold start that was not happening (walk,
  // 「每次点会话都要冷启动」).
  const opening = !navigated || pending;
  const cover = !opening ? null
    : coldStart ? <FrameWaiting step={displayStep} provider={startStatus?.provider ?? null} />
      : !navigated ? <FrameSkeleton />
        : null;
  // A renewal that failed is only worth saying once the lease it renews has
  // actually run out — or when it is an expired login, which no retry fixes.
  const leaseAlert = leaseFailure && (leaseFailure.final || leaseExpired) ? leaseFailure.text : null;
  const connectionNotice = nativeError ?? leaseAlert;

  return (
    <div className="relative h-full w-full">
      {error ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-error">
          <p>{error.text}</p>
          {error.retryable && <Button ref={retryButton} variant="ghost" onClick={() => setAttempt(value => value + 1)}>重试</Button>}
          {error.newTask && <Button variant="ghost" onClick={() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } })}>新建对话</Button>}
          {error.capped && !error.concurrency && <Button variant="ghost" onClick={() => navigate("/app/account")}>查看账户与额度</Button>}
        </div>
      ) : (
        <>
          {navigated && (connectionNotice || !ready) && (
            <div role={connectionNotice ? "alert" : "status"} className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg text-ui-sm text-muted">
              <p>{connectionNotice ?? "正在恢复研究连接…"}</p>
              {connectionNotice && <Button variant="ghost" onClick={() => renewBinding.current?.()} disabled={renewing}>重新连接</Button>}
            </div>
          )}
          {cover}
          {binding && <iframe
            key={binding.frameId} ref={iframe} src={binding.frameUrl} title="对话"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
            allow="clipboard-read; clipboard-write"
          />}
        </>
      )}
    </div>
  );
}
