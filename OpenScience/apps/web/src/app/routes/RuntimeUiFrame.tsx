import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { errorCodeMessage, runtimeStartRecovery, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import { createWebRuntimeUiFrame, fetchWebRuntimeStatus, listWebAgentRuns, listWebResearchAgents, renewWebRuntimeUiFrame, releaseWebRuntimeUiFrame, startWebRuntime, webErrorMessage, WebApiError, type WebAgentRun, type WebRuntimeStartStatus, type WebRuntimeUiFrame } from "@/lib/apiClient";
import { newRuntimeUiIntent, runtimeUiIntentFromState, type RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { bindConversationCapability, conversationCapability } from "@/lib/dispatch";
import { TASKS_PATH, taskPath } from "@/lib/taskLocation";
import { saveToKnowledgeBase } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { provideFrameSessionSearch, reportPathOf, searchKnowledgeSources, useFrameRunBinding, type FrameSessionSearchResult } from "@/lib/runtimeUiBridge";
import { useFrameReplyChecks } from "@/lib/replyChecks";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { conversationTitle } from "@/lib/conversationTitles";
import { Button } from "@/components/ui/Button";
import { ConnectorNeedNotice } from "@/components/runs/ConnectorNeedNotice";
import { SHORTCUT_HELP_TOGGLE_EVENT } from "@/components/ui/ShortcutHelp";
import { useUiStore } from "@/lib/store";
import { isGeoTab } from "@/components/geo/geoTabs";
import { geoProjectPath, useFrameGeoOptions } from "@/components/geo/useFrameGeoOptions";
import { useFrameVcrOptions } from "@/components/vcr/useFrameVcrOptions";

/** What a refused start asks of the reader (`runtimeStartRecovery`). */
type StartRecovery = ReturnType<typeof runtimeStartRecovery>;

/** Why this surface is showing an alert instead of the conversation. */
interface FrameFailure {
  text: string;
  /** Whether building the binding again could plausibly succeed right now. A
   *  retry button offered against a spent budget is a button that is guaranteed
   *  to fail, which is the over-refusal pattern: an unexplained refusal costs
   *  less trust than one whose only offered action cannot work. */
  retryable: boolean;
  /** A specific conversation could not be opened: offer a new one beside the
   *  retry, which would only ask for the same conversation again. */
  newTask?: boolean;
  /** The code the control plane refused with, when it named one. The sentence
   *  comes from the dictionary; the code is kept because one refusal has an
   *  action of its own (`SIMULATED_CREDITS_EXHAUSTED`). */
  code?: string | null;
  /**
   * What the refusal asks of the reader, which decides the action beside the
   * retry: `spend` is the one cause the allowance page can lift, `wait` the
   * results the project already holds, `autopilot` the page of scheduled
   * tasks. Absent for a failure this surface observed itself, which has no
   * cause to act on but a retry. Until 2026-10-07 every refusal the control
   * plane classed as a ceiling or a hold read as a spending one, and a
   * conversation held by a cleanup offered only 「查看科研额度」 (audit B03).
   */
  recovery?: StartRecovery;
}

/**
 * The refusal of a deployment whose wallet is simulated: the allowance is below
 * what the task needs, or empty. What lifts it is a simulated top-up, so the
 * action offered is the simulated recharge page — not the allowance page, which
 * only states the position.
 */
const SIMULATED_CREDITS_EXHAUSTED = "simulated_credits_exhausted";

/** A failure this surface observed itself — a timer, a native error frame —
 *  where no control-plane refusal exists to explain. */
function frameFailure(text: string): FrameFailure {
  return { text, retryable: true };
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
  // A 401 is already being handled elsewhere — `fetchWithWebAuth` announces the
  // ended session and the shell moves to the login route — so a retry here
  // would race that, not fix it.
  return failureFor(runtimeStartRecovery(error.code, error.status), text, error.code, error.status !== 401);
}

/**
 * The failure a refusal is shown as, by what it asks of the reader
 * (`runtimeStartRecovery`; one table for the start call, the binding and the
 * frame's own notice page, which used to disagree). The sentence is the
 * dictionary's except for the three causes whose dictionary sentence points at
 * something this page does not offer or offers differently: the cleanup that
 * outlasted the wait, the autopilot hold, and the slot cap.
 */
function failureFor(recovery: StartRecovery, text: string, code: string | null | undefined, retryable = true): FrameFailure {
  switch (recovery) {
    // A spending ceiling is lifted on the allowance page, not by asking again; the simulated
    // allowance has a page of its own (`SIMULATED_CREDITS_EXHAUSTED`).
    case "spend": return { text, retryable: false, recovery, code };
    case "wait": return { text: CLEANUP_GAVE_UP_TEXT, retryable, recovery, code };
    case "autopilot": return { text: AUTOPILOT_HOLD_TEXT, retryable, recovery, code };
    case "slots": return { text: RUNTIME_SLOT_CAP_TEXT, retryable, recovery, code };
    default: return { text, retryable, recovery, code };
  }
}

/** The slot cap, said as what it is. On 2026-09-15 the only runtime slot of
 *  the deployment was taken and the shell told the second reader that "cold
 *  starts sometimes take longer" — a retry loop against a limit that no wait
 *  could lift. What helps is a running conversation ending, or stopping one —
 *  which is done in the conversation itself, from its own composer or from the
 *  menu on its row in the sidebar. The frame's own notice page says the same
 *  words (`runtimeUiServer.mjs`). */
const RUNTIME_SLOT_CAP_TEXT = "你同时进行的研究已达上限，先结束一个再试。";

/**
 * The previous task's runtime is still being cleaned up (`runtime_cleanup_required`), or is stopping
 * (`runtime_busy`): the platform is finishing something, and the control plane retries it by itself.
 * Said on the cover, never as an alert: nothing has failed. The opening asks again by itself, at the pace
 * the control plane named and then 3, 5, 8 and 15 seconds, for two minutes; past that the cleanup is taking
 * longer than a wait is worth, and the alert says so with 重试 and the way to what the project already holds.
 * Until 2026-10-07 this arrived as 「查看科研额度」 and nothing else, for as long as the hold stood (audit B03).
 */
const CLEANUP_LINE = "正在清理上一次任务的运行环境，完成后自动继续";
const CLEANUP_RETRY_MS = [3_000, 5_000, 8_000, 15_000] as const;
const CLEANUP_WAIT_MS = 120_000;
const CLEANUP_GAVE_UP_TEXT = "运行环境还没有清理完成，暂时不能继续这个对话。稍后再试，已有成果可以先阅读。";

/** The project's own scheduled research holds its runtime: it ends by itself, and the page that lists it is 定时任务. */
const AUTOPILOT_HOLD_TEXT = "这个项目正在执行你设定的定时研究，结束后即可继续。";

/**
 * Every research environment of the deployment is taken (2026-10-05).
 *
 * Not the researcher's own ceiling above — that one is theirs to lift and stays
 * a refusal — but the host's: its slots are shared with other products and are
 * not raised, so a start that finds them all taken is a place in line. The
 * cover says so in one plain line and the opening asks again by itself, at the
 * pace the control plane named (`Retry-After`) and widening to the last rung
 * here, for as long as the reader stays on this conversation; it starts when a
 * slot frees. Said on the cover, never as an alert: nothing has failed.
 */
const ROOM_FULL_LINE = "所有研究环境都在使用中，空出后会自动开始。";
const ROOM_RETRY_MS = [5_000, 8_000, 12_000, 15_000] as const;

/** Which wait a refused start is, when it is one: the code decides (`runtimeStartRecovery`). */
function startRefusal(error: unknown): "room" | "cleanup" | null {
  if (!(error instanceof WebApiError)) return null;
  const recovery = runtimeStartRecovery(error.code, error.status);
  return recovery === "room" ? "room" : recovery === "wait" ? "cleanup" : null;
}

/**
 * A start refused because the project's runtime settings are being applied.
 *
 * The control plane waits for an apply itself before it refuses (20 s,
 * `PluginService.withAdmission`), so this is what is left when the wait ran
 * out. It is not a failure and not a ceiling: the first conversation after a
 * release met it for the ten to forty seconds the apply took, and the page
 * said 「对话暂时打不开」 (2026-10-04). The shell says what is happening and
 * opens the conversation again by itself, a few times, before it calls it one.
 */
const PREPARING_CODE = "plugin_apply_in_progress";
const PREPARING_LINE = "正在准备运行环境";
const PREPARING_RETRY_MS = 2_000;
const PREPARING_RETRY_LIMIT = 5;

/**
 * A refusal the frame's own document announced.
 *
 * The runtime-UI origin serves a notice page when the session cannot be
 * opened, and that page now posts the code and the sentence it rendered. It is
 * read through the same table as the start call (`runtimeStartRecovery`), so
 * one cause is one screen: a conversation refused because the deployment is
 * already at its runtime limit is freed, a spending ceiling goes to the page
 * that states it, and neither is a retry loop.
 */
function noticedFrame(code: string, detail: string, title: string): FrameFailure {
  // A notice whose title says it all sends no detail (「项目正忙，请稍后再试」).
  const text = detail || title || (code === "runtime_limit_exceeded" ? RUNTIME_SLOT_CAP_TEXT : errorCodeMessage(code));
  return failureFor(runtimeStartRecovery(code), text, code);
}

/**
 * The refusal of this opening's own start, when it is one a wait will not lift.
 *
 * Read from the start call the opening makes itself rather than from a status
 * snapshot: a refusal recorded by an earlier attempt must not fail the retry
 * the reader pressed after freeing a slot. What is a wait goes to the cover
 * (`waitToStart`) before it gets here, and what is no refusal of the start
 * (a rate limit, a slow answer) is left to the frame's own document to show.
 */
function refusedStart(error: unknown): FrameFailure | null {
  if (!(error instanceof WebApiError)) return null;
  const recovery = runtimeStartRecovery(error.code, error.status);
  // The opening goes on: the frame's own start waits for the apply (and the
  // notice page retries the opening if it does not end in time).
  if (recovery === "preparing" || recovery === "retry" || recovery === "room") return null;
  return failureFor(recovery, webErrorMessage(error, { fallback: "对话暂时无法连接，请重试。" }), error.code);
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
 * The moments of opening a conversation that have a deadline of their own.
 * The first three are the runtime's start as the control plane reports it
 * (`startStage`: preparing, carrying a remote session's files over, the
 * kernel coming up); `interface` is the kernel's application loading in the
 * frame. They time the wait and are never shown: the reader sees one quiet
 * line, not the machinery (UI plan §2.2 #3).
 */
type OpenMoment = "environment" | "sync" | "kernel" | "interface";

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
const OPEN_DEADLINES_MS: Record<OpenMoment, number> = {
  environment: 90_000, sync: 90_000, kernel: 90_000, interface: 60_000,
};
/** One sentence for every stalled moment: which one stalled goes to the console, for whoever diagnoses it. */
const OPEN_TIMEOUT_TEXT = "打开超时，请重试";

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
 * What covers the conversation area while a conversation opens: its title,
 * when the shell knows it, and one quiet line. When it is ready the
 * conversation simply appears.
 *
 * Until 2026-09-23 a cold start showed its moments as a checklist — 准备环境 ·
 * 启动内核 · 载入界面 · 打开对话 — with a sentence about each after five
 * seconds. That described the machinery rather than the conversation, named
 * the kernel, and made every project switch read as a restart (UI plan §2.2
 * #3); how long each moment may take still decides when this gives up.
 */
export function FrameSkeleton({ title = null, line = "正在打开" }: { title?: string | null; line?: string }) {
  return (
    <div role="status" aria-live="polite" data-frame-skeleton="" className="absolute inset-0 z-sticky flex flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
      {title && <p className="line-clamp-2 max-w-content-narrow text-ui font-medium text-text">{title}</p>}
      <p className="text-ui text-muted">{line}</p>
    </div>
  );
}

/**
 * The way from a refused conversation to the page that states the ceiling:
 * 设置's usage section, which a deployment that bills research calls 科研额度
 * and every other calls 用量, so the button says what the page is called
 * (`useResearchBilling`; unknown reads as the usage wording, which is true
 * everywhere). Its own component so that the allowance is read only when a
 * ceiling has actually refused a conversation, not by every one that opens.
 */
function UsageButton() {
  const navigate = useNavigate();
  const { enabled } = useResearchBilling();
  return <Button variant="ghost" onClick={() => navigate("/app/account?tab=usage")}>{enabled ? "查看科研额度" : "查看用量"}</Button>;
}

/**
 * The way from a conversation the simulated allowance refused to the page that
 * lifts the refusal. The refusal's own code says the wallet is simulated, so
 * this needs no allowance read to know what to call itself.
 */
function SimulatedRechargeButton() {
  const navigate = useNavigate();
  return <Button variant="ghost" onClick={() => navigate(SIMULATED_WALLET_PAGES.recharge)}>去模拟充值</Button>;
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
export function RuntimeUiFrame({ projectId, origin, sessionId = null, active = true, mirrorAddress = true, suspended = false, onRelease }: {
  projectId: string;
  origin: string;
  /** The conversation this surface should be showing: the chat address's, or the one a task's page asks for. */
  sessionId?: string | null;
  active?: boolean;
  /**
   * Whether the conversation on screen is the page's address. On the chat surface it is, and the address follows the kernel (an opened
   * conversation is written to the URL). Placed over a task's pane it is not — the address is the task's, and the conversation is an
   * execution of it — so an acknowledged opening must leave the address where it is.
   */
  mirrorAddress?: boolean;
  /** The address does not yet name a conversation and the shell is finding
   *  one: hold the opening request, but let the runtime warm up meanwhile. */
  suspended?: boolean;
  /** Handed each release of this frame's binding as it goes out. The control
   *  plane answers once the frame's connections are closed, which is when its
   *  runtime's slot is free for another project (`SessionFrameHost`). */
  onRelease?: (released: Promise<void>) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;
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
  // The capability the task on screen is bound to, as the control plane said
  // it: what decides whether the 「循证 GEO」 chip carries its options.
  const [frameCapability, setFrameCapability] = useState<string | null>(null);
  // The latest `geo-options` handler, read by the message listener.
  const geoOptionsHandler = useRef<((change: { sessionId?: unknown; coverageDays?: unknown; engines?: unknown }) => void) | null>(null);
  // The latest `vcr-options` handler, read by the message listener.
  const vcrOptionsHandler = useRef<((change: { sessionId?: unknown; start?: unknown; intendedUse?: unknown }) => void) | null>(null);
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
  // The runtime's settings are being applied, so the opening is tried again by
  // itself (`PREPARING_CODE`): said on the cover instead of an alert, until the
  // conversation opens or the tries run out.
  const [preparing, setPreparing] = useState(false);
  const preparingRetries = useRef(0);
  const preparingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The opening is standing in line, and for what: every research environment is
  // taken (`runtime_capacity_full`) or the previous task's is still being cleaned up
  // (`CLEANUP_LINE`). The cover says so and the opening asks again by itself until
  // it can start. One timer serves both, `waitKind` is its reference copy, and a
  // cleanup is waited for only so long (`CLEANUP_WAIT_MS`).
  const [waiting, setWaiting] = useState<"room" | "cleanup" | null>(null);
  const waitKind = useRef<"room" | "cleanup" | null>(null);
  const waitAsks = useRef(0);
  const waitSince = useRef(0);
  const roomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roomHold = useRef({ active, suspended });
  roomHold.current = { active, suspended };
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

  // Another project is another opening: nothing of the last one's preparing carries over.
  useEffect(() => {
    preparingRetries.current = 0;
    setPreparing(false);
    waitKind.current = null;
    waitAsks.current = 0;
    setWaiting(null);
    return () => { clearTimeout(preparingTimer.current); clearTimeout(roomTimer.current); roomTimer.current = undefined; };
  }, [projectId]);

  // The conversation is part of what the frame was asked for: on a task's page the address stays while the execution changes.
  const navigationKey = `${location.pathname}:${sessionId ?? ""}:${runtimeUiIntentFromState(location.state, projectId)?.requestId ?? ""}`;
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

  // Standing in line (`runtime_capacity_full`, `CLEANUP_LINE`): one timer, whoever noticed first — this
  // opening's own start or the frame document's notice — and one more ask each
  // time it fires. A frame the reader is not looking at asks nothing; the timer
  // keeps its pace and asks again once it is on screen. A full house is waited
  // out for as long as the reader stays; a cleanup for two minutes, then it is
  // an alert with the retry and the results the project already holds.
  const endWait = useCallback(() => {
    clearTimeout(roomTimer.current);
    roomTimer.current = undefined;
    waitKind.current = null;
    waitAsks.current = 0;
    setWaiting(null);
  }, []);
  const waitToStart = useCallback((kind: "room" | "cleanup", retryAfterSeconds: number | null) => {
    if (waitKind.current !== kind) { waitKind.current = kind; waitAsks.current = 0; waitSince.current = Date.now(); }
    if (kind === "cleanup" && Date.now() - waitSince.current >= CLEANUP_WAIT_MS) {
      endWait();
      setError(failureFor("wait", "", null));
      return;
    }
    setWaiting(kind);
    if (roomTimer.current !== undefined) return;
    const ladder = kind === "room" ? ROOM_RETRY_MS : CLEANUP_RETRY_MS;
    const rung = ladder[Math.min(waitAsks.current, ladder.length - 1)];
    waitAsks.current += 1;
    const delay = Math.max(rung, retryAfterSeconds ? retryAfterSeconds * 1_000 : 0);
    const ask = () => {
      roomTimer.current = undefined;
      if (!roomHold.current.active || roomHold.current.suspended) { waitToStart(kind, null); return; }
      void startWebRuntime({ projectId, opening: true }).then(() => {
        // A slot was free, or the cleanup is done: the opening begins again, and finds its runtime up.
        endWait();
        setAttempt(value => value + 1);
      }).catch((cause: unknown) => {
        const refused = startRefusal(cause);
        if (refused === "room" || refused === "cleanup") { waitToStart(refused, cause instanceof WebApiError ? cause.retryAfterSeconds : null); return; }
        endWait();
        setError(refusedStart(cause) ?? refusedFrame(cause));
      });
    };
    roomTimer.current = setTimeout(ask, delay);
  }, [projectId, endWait]);
  // What a refused start of the opening is to the opening: a wait, or something to show.
  const meetStartRefusal = useCallback((cause: unknown) => {
    const refused = startRefusal(cause);
    if (refused) { waitToStart(refused, cause instanceof WebApiError ? cause.retryAfterSeconds : null); return; }
    const refusal = refusedStart(cause);
    if (refusal) setError(refusal);
  }, [waitToStart]);

  useEffect(() => {
    let live = true;
    let frameId: string | null = null;
    const released = new Set<string>();
    releaseBinding.current = null;
    const release = (id: string) => {
      if (released.has(id)) return;
      released.add(id);
      const done = releaseWebRuntimeUiFrame(id).catch((cause: unknown) => {
        // Not the authority boundary — login expiry and revocation are — and
        // the browser closes the frame's connections itself once its document
        // is gone. What a failure can cost is the next project's start being
        // refused while the server still counts them, which that start says.
        console.warn("EviMed: a conversation frame's release was not confirmed", cause);
      });
      onReleaseRef.current?.(done);
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
    }).catch((cause: unknown) => {
      if (!live) return;
      // A binding refused for a cleanup that has not finished is the same wait as the start's.
      const wait = startRefusal(cause);
      if (wait) waitToStart(wait, cause instanceof WebApiError ? cause.retryAfterSeconds : null);
      else setError(refusedFrame(cause));
    });
    return () => { live = false; if (frameId) release(frameId); };
  }, [projectId, origin, attempt, waitToStart]);

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
        setLeaseFailure({ text: webErrorMessage(cause, { fallback: "连接中断，正在重连" }), final: expiredLogin });
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
  // Which moment the opening is in, for its deadline; opening the task (a
  // request in flight) is timed by its own deadline further down.
  const runtimeMoment = startStatus?.startStage ?? "environment";
  const deadlineMoment: OpenMoment | null = navigated || pending || ready || waiting !== null ? null
    : runtimeUp && binding ? "interface" : runtimeMoment;
  useEffect(() => {
    if (error || deadlineMoment === null) return;
    // A slow start is not a failure while it is moving: each moment the
    // control plane reports, and the frame's bridge booting, restarts the
    // count (see OPEN_DEADLINES_MS).
    const timeout = setTimeout(() => {
      console.warn(`EviMed: opening a conversation stalled at "${deadlineMoment}" for ${OPEN_DEADLINES_MS[deadlineMoment] / 1000} s`, { projectId });
      setError(frameFailure(OPEN_TIMEOUT_TEXT));
    }, OPEN_DEADLINES_MS[deadlineMoment]);
    return () => clearTimeout(timeout);
  }, [error, attempt, deadlineMoment, booted, projectId]);

  // This opening's own start. The frame document starts the runtime too, and
  // the two join one start on the server; this call is made because its answer
  // can be read — a start refused into a frame is a page this shell cannot see
  // the status of — and because it belongs to this attempt, a refusal from an
  // earlier one cannot fail the retry. It is the opening (`startWebRuntime`):
  // the shell has already let go of the surface it chose to let go of, and an
  // idle runtime of this researcher that a tab still holds yields to it.
  useEffect(() => {
    let live = true;
    void startWebRuntime({ projectId, opening: true }).catch((cause: unknown) => {
      if (live) meetStartRefusal(cause);
    });
    return () => { live = false; };
  }, [projectId, attempt, meetStartRefusal]);

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

  // 重新连接: the reader asking for this conversation back. Its runtime may
  // have yielded to a project opened in another tab, and the frame's own
  // reconnects may not take a runtime back (`makeRoomFor`), so the button is
  // an opening as well as a renewal; a start still refused says why.
  const reconnect = useCallback(() => {
    void startWebRuntime({ projectId, opening: true }).catch(meetStartRefusal);
    renewBinding.current?.();
  }, [projectId, meetStartRefusal]);

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
        if (message.code === PREPARING_CODE && preparingRetries.current < PREPARING_RETRY_LIMIT) {
          // An apply under way: open the conversation again once it has had a moment.
          preparingRetries.current += 1;
          setPreparing(true);
          clearTimeout(preparingTimer.current);
          preparingTimer.current = setTimeout(() => setAttempt(value => value + 1), PREPARING_RETRY_MS);
          return;
        }
        const wait = runtimeStartRecovery(message.code);
        if (wait === "room" || wait === "wait") { waitToStart(wait === "room" ? "room" : "cleanup", null); return; }
        setError(noticedFrame(message.code, typeof message.detail === "string" ? message.detail.slice(0, 200) : "",
          typeof message.title === "string" ? message.title.slice(0, 200) : ""));
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
        preparingRetries.current = 0;
        setPreparing(false);
        endWait();
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
          geo: "/app/geo", "virtual-research": "/app/virtual-research", autopilot: TASKS_PATH,
        };
        const to = routes[String(message.destination)];
        if (!to) return;
        if (message.destination === "geo") {
          // 「循证 GEO」, at one of this project's tabs when the frame names
          // one (a run's report linking to 诊断): the tab is a closed
          // vocabulary, and the project is the tab's own, never the frame's word.
          incoming.current = message.seq;
          const tab = isGeoTab(typeof message.tab === "string" ? message.tab : null) ? message.tab as string : null;
          void geoProjectPath(projectId, tab).then((path) => navigate(path));
          return;
        }
        if (message.destination === "autopilot") {
          // 「打开」 on the card of a task a conversation made: that task's page, in the project on screen. The id is the control
          // plane's own shape, bounded here as the session ids are; anything else opens the list, where the task is, if it is anywhere.
          incoming.current = message.seq;
          navigate(taskPath(typeof message.taskId === "string" && SESSION_ID.test(message.taskId) ? message.taskId : null));
          return;
        }
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
          // `?` is a single-character shortcut and has an off switch (设置 · 外观, WCAG 2.2 SC 2.1.4): off, the key the frame
          // forwarded does nothing here either. The chord (sidebar) is not a character key and is never switched off.
          shortcuts: () => { if (ui.singleKeyShortcuts) window.dispatchEvent(new Event(SHORTCUT_HELP_TOGGLE_EVENT)); },
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
      } else if (message.type === "evimed.runtime-ui.save-to-knowledge-base") {
        // 「存入知识库」 on a delivered file's card: a copy of the run's file in this project's knowledge base. The frame
        // names a file of a run and nothing else; the control plane reads it through its own guarded file boundary and
        // writes it under the project's knowledge base. The answer is the toast: the frame is another origin and has
        // no way to show it.
        const runId = typeof message.runId === "string" && SESSION_ID.test(message.runId) ? message.runId : null;
        const path = artifactPath(message.path);
        if (!runId || !path) return;
        incoming.current = message.seq;
        void saveToKnowledgeBase(path).then(
          (saved) => toast.success(saved.duplicate ? "这份文件已经在知识库里" : "已存入知识库，正在读取"),
          (failure) => toast.error(`没能存入知识库：${webErrorMessage(failure)}`),
        );
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
      } else if (message.type === "evimed.runtime-ui.geo-options") {
        // 覆盖周期 or AI 引擎 changed beside the 「循证 GEO」 chip; the handler
        // validates it again and writes it to this project's GEO row.
        incoming.current = message.seq;
        geoOptionsHandler.current?.({ sessionId: message.sessionId, coverageDays: message.coverageDays, engines: message.engines });
      } else if (message.type === "evimed.runtime-ui.vcr-options") {
        // 起点 or 预期用途 changed beside the 「虚拟临床研究」 chip; the handler
        // validates it again and writes it to this project's study.
        incoming.current = message.seq;
        vcrOptionsHandler.current?.({ sessionId: message.sessionId, start: message.start, intendedUse: message.intendedUse });
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
        if (mirrorAddress && intent?.requestId === request.requestId) {
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
  }, [binding, origin, projectId, intent, location, navigate, navigated, attempt, postToFrame, waitToStart, endWait, mirrorAddress]);

  useEffect(() => {
    if (!ready || error || !binding || !intent || !iframe.current?.contentWindow) return;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(intent.sessionId)) { setError(frameFailure("这条对话暂时无法打开")); return; }
    const key = `${binding.frameId}:${intent.requestId}`;
    if (lastSent.current === key) return;
    lastSent.current = key; currentRequest.current = intent; setPending(true);
    iframe.current.contentWindow.postMessage({
      type: "evimed.runtime-ui.navigate", version: 1, frameId: binding.frameId, projectId,
      requestId: intent.requestId, seq: ++outgoing.current,
      intent: { kind: intent.kind, sessionId: intent.sessionId, ...(intent.draft === undefined ? {} : { draft: intent.draft }), ...(intent.resultRevision ? { resultRevision: intent.resultRevision } : {}) },
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
    if (!frameTask) { postToFrame("capability", { capabilityId: null, sessionId: null }); setFrameCapability(null); return undefined; }
    void conversationCapability(frameTask)
      .then((capabilityId) => {
        if (!active) return;
        postToFrame("capability", { capabilityId, sessionId: frameTask });
        setFrameCapability(capabilityId);
      })
      .catch(() => { /* the chip stays absent rather than wrong */ });
    return () => { active = false; };
  }, [booted, error, frameId, frameTask, postToFrame]);

  // 循证 GEO's options beside its chip, for a conversation bound to one of the
  // module's capabilities (`useFrameGeoOptions`).
  const postGeo = useCallback((payload: object) => postToFrame("geo", payload), [postToFrame]);
  geoOptionsHandler.current = useFrameGeoOptions({
    projectId, sessionId: frameTask, capabilityId: frameCapability, enabled: booted > 0 && !error && Boolean(frameId), post: postGeo,
  });
  // 虚拟临床研究's options beside its chip, for a conversation bound to one of the
  // module's capabilities (`useFrameVcrOptions`).
  const postVcr = useCallback((payload: object) => postToFrame("vcr", payload), [postToFrame]);
  vcrOptionsHandler.current = useFrameVcrOptions({
    projectId, sessionId: frameTask, capabilityId: frameCapability, enabled: booted > 0 && !error && Boolean(frameId), post: postVcr,
  });

  const postRunState = useCallback((state: object) => postToFrame("run-state", state), [postToFrame]);
  const postEvidence = useCallback((evidence: object | null) => postToFrame("evidence", evidence ?? { runId: null }), [postToFrame]);
  // The run bound to the conversation on screen, as the ledger holds it, for
  // what the shell shows beside the frame: a data source that run went without
  // (`ConnectorNeedNotice`). Kept only when what the strip reads has changed, so
  // the ledger's twenty-second polls of an idle conversation re-render nothing.
  const [boundRun, setBoundRun] = useState<WebAgentRun | null>(null);
  const onBoundRun = useCallback((run: WebAgentRun | null) => {
    setBoundRun((previous) => (previous?.id === run?.id && previous?.status === run?.status
      && JSON.stringify(previous?.connectorNeeds ?? null) === JSON.stringify(run?.connectorNeeds ?? null) ? previous : run));
  }, []);
  useFrameRunBinding({ sessionId: frameTask, enabled: booted > 0 && !error && Boolean(frameId), postRunState, postEvidence, onRun: onBoundRun });
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

  // What covers the conversation, and when: until this frame has opened one,
  // the conversation's title and 「正在打开…」, cold start or warm alike. Once
  // it has, switching to another shows nothing — the kernel is on screen and
  // keeps its own composer (a switch inside a live runtime used to read as a
  // cold start: walk of 2026-09-20, 「每次点会话都要冷启动」).
  //
  // The line says what the opening is waiting for when it is something other than a start: a full
  // house, or the previous task's runtime still being cleaned up — which the control plane
  // reports (`cleanupPending`) before the start that will be refused for it has even been asked.
  const cleaning = waiting === "cleanup" || (startStatus?.cleanupPending === true && !runtimeUp);
  const waitLine = waiting === "room" ? ROOM_FULL_LINE : cleaning ? CLEANUP_LINE : null;
  const cover = navigated ? null : <FrameSkeleton title={active ? conversationTitle(sessionId) : null} line={waitLine ?? (preparing ? PREPARING_LINE : undefined)} />;
  // A renewal that failed is only worth saying once the lease it renews has
  // actually run out — or when it is an expired login, which no retry fixes.
  const leaseAlert = leaseFailure && (leaseFailure.final || leaseExpired) ? leaseFailure.text : null;
  const connectionNotice = nativeError ?? leaseAlert;
  // 重试: another opening with a fresh allowance of waiting, on the same intent — a brief handed over by a
  // capability card or a hand-off lives in the address's state and is sent again with it.
  const retry = () => { endWait(); setAttempt(value => value + 1); };
  // 查看已有成果: what the control plane holds of this conversation reads without a runtime — its delivered
  // report when the ledger has one, else the project's files. The conversation's own text lives in the kernel's
  // session store and is not faked from the ledger, which keeps no reply text.
  const openExistingResults = async () => {
    let target = "/app/files";
    try {
      const runs = (await listWebAgentRuns({ projectId })).filter((run) => sessionId && run.sessionId === sessionId);
      for (const run of runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
        const file = reportPathOf({ runId: run.id, artifacts: run.artifacts, unverifiedArtifacts: run.unverifiedArtifacts }) ?? run.artifacts?.[0] ?? null;
        const path = artifactPath(file);
        if (path) { target = `/app/runs/${encodeURIComponent(run.id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`; break; }
      }
    } catch {
      // The ledger could not be read: the project's files are still the honest place.
    }
    navigate(target);
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* A source this conversation's last run went without: a strip above the
          kernel's frame, never inside it, with the credential form in place and
          a 继续 that asks for the skipped part in the same conversation. */}
      {active && !error && <ConnectorNeedNotice run={boundRun} />}
      {/* The frame's container keeps the device's bottom inset (E-17). The composer
          inside the frame leaves at least max(16px, env(safe-area-inset-bottom))
          under its card, but `env()` is the browser's to fill and a frame on
          another origin is not promised an inset of its own (it reads 0 unless
          the top-level page asks for the full screen, and this page does not),
          so the inset is this container's: padding the frame never draws into,
          and no second 16 px, because the frame already adds its own. */}
      <div className="min-h-0 flex-1" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="relative h-full w-full">
          {error ? (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-ui text-error">
              <p>{error.text}</p>
              {error.retryable && <Button ref={retryButton} variant="ghost" onClick={retry}>重试</Button>}
              {error.newTask && <Button variant="ghost" onClick={() => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent() } })}>新建对话</Button>}
              {/* A cleanup that outlasted the wait: what the project already holds needs no runtime. */}
              {error.recovery === "wait" && <Button variant="ghost" onClick={() => { void openExistingResults(); }}>查看已有成果</Button>}
              {error.recovery === "autopilot" && <Button variant="ghost" onClick={() => navigate("/app/autopilot")}>查看定时任务</Button>}
              {/* The usage section of settings, where a spend ceiling is stated — or,
                  for a simulated allowance that ran out, the page that tops it up. */}
              {error.recovery === "spend" && (error.code === SIMULATED_CREDITS_EXHAUSTED ? <SimulatedRechargeButton /> : <UsageButton />)}
            </div>
          ) : (
            <>
              {navigated && (connectionNotice || !ready) && (
                <div role={connectionNotice ? "alert" : "status"} className="absolute inset-0 z-sticky flex flex-col items-center justify-center gap-3 bg-bg text-ui text-muted">
                  <p>{waiting === "cleanup" ? CLEANUP_LINE : connectionNotice ?? "正在重连"}</p>
                  {connectionNotice && waiting !== "cleanup" && <Button variant="ghost" onClick={reconnect} disabled={renewing}>重新连接</Button>}
                </div>
              )}
              {cover}
              {binding && <iframe
                key={binding.frameId} ref={iframe} src={binding.frameUrl} title="对话"
                className="absolute inset-0 h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
                allow="clipboard-read; clipboard-write"
              />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
