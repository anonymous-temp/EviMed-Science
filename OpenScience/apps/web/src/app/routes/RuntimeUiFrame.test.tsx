import { useLayoutEffect, useRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFrameHost } from "../layout/SessionFrameHost";
import { SessionRoute } from "./SessionRoute";
import { WebApiError, type WebAgentRun } from "@/lib/apiClient";
import { rememberConversationTitles } from "@/lib/conversationTitles";
import { apply as applyNativeBridge } from "../../../../../packages/harness-port/src/runtimeUiBridge.mjs";
import { createFrameKit } from "../../../../../packages/harness-port/src/runtimeUiKit.mjs";
import { FRAME_VOCABULARY } from "../../../../../packages/harness-port/src/runtimeUiFrame.mjs";
import { apply as applyFrameTheme } from "../../../../../packages/harness-port/src/runtimeUiTheme.mjs";
import { useUiStore } from "@/lib/store";
import { registerTaskPane } from "@/lib/taskPane";
import { forgetResearchBilling } from "@/lib/useResearchBilling";
import { useRuntimeSessionSearch } from "@/lib/runtimeUiBridge";
import { renderHook } from "@testing-library/react";
import { kernelThemeTokens } from "@evimed/design-tokens/kernel";
import { errorCodeMessage, SIMULATED_WALLET_PAGES } from "@evimed/domain";

const mocks = vi.hoisted(() => ({ saveToKnowledgeBase: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn(), create: vi.fn(), renew: vi.fn(), release: vi.fn(), listRuns: vi.fn(), subscribe: vi.fn(), listSources: vi.fn(), me: vi.fn(), warm: vi.fn(), start: vi.fn(), status: vi.fn(), listAgents: vi.fn(), listSessions: vi.fn(), putSession: vi.fn(), allowance: vi.fn(), connectors: vi.fn(), saveConnector: vi.fn(), dispatch: vi.fn(), projectId: "default", profile: { uiOrigin: "https://host.example:8443" } }));
vi.mock("@/lib/sourceClient", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/sourceClient")>()), listSources: mocks.listSources, saveToKnowledgeBase: mocks.saveToKnowledgeBase }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
// The run's event stream, held by the test: the frame's run view follows it.
vi.mock("@/lib/runEvents", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/runEvents")>()), subscribeRunEvents: mocks.subscribe }));
// Only the four frame calls and the profile are stubbed. Everything else is the
// real module on purpose: `WebApiError` has to be the same class the component
// tests with `instanceof`, and `webErrorMessage` has to be the real projection
// over the real registry — a hand-written stub here would prove that a fake
// dictionary renders, which is the defect this change removes, not the fix.
vi.mock("@/lib/apiClient", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true, fetchWebMe: () => mocks.me(), webRuntimeProfile: () => mocks.profile,
  getWebProjectId: () => mocks.projectId, createWebRuntimeUiFrame: mocks.create, releaseWebRuntimeUiFrame: mocks.release,
  renewWebRuntimeUiFrame: mocks.renew, listWebAgentRuns: mocks.listRuns, warmWebRuntime: mocks.warm,
  startWebRuntime: mocks.start, fetchWebRuntimeStatus: mocks.status,
  listWebResearchAgents: mocks.listAgents, listWebResearchSessions: mocks.listSessions, putWebResearchSession: mocks.putSession,
  fetchWebResearchAllowance: mocks.allowance,
  // The strip for a data source a run went without reads the account's connectors, saves one, and posts the follow-up.
  fetchWebConnectors: mocks.connectors, saveWebConnectorCredential: mocks.saveConnector, dispatchWebAgentRun: mocks.dispatch,
}));
// 循证 GEO's two calls: which GEO project this is, and writing an option to it.
const geo = vi.hoisted(() => ({ listGeoProjects: vi.fn(), patchGeoProject: vi.fn() }));
vi.mock("@/lib/geoClient", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  listGeoProjects: geo.listGeoProjects, patchGeoProject: geo.patchGeoProject,
}));
// 虚拟临床研究's two calls: the study this project is and what the chip needs of it (a draft included), and writing an option to it.
// The home list is mocked too, only to say that the frame never reads it: the list leaves out a draft.
const vcr = vi.hoisted(() => ({ getVcrHome: vi.fn(), getVcrStudyOfProject: vi.fn(), patchVcrStudy: vi.fn() }));
vi.mock("@/lib/vcrClient", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/vcrClient")>()),
  getVcrHome: vcr.getVcrHome, getVcrStudyOfProject: vcr.getVcrStudyOfProject, patchVcrStudy: vcr.patchVcrStudy,
}));
/** `/api/account/allowance` on a deployment that does not bill research (every deployment today), and on one that does. */
const billing = (enabled: boolean) => ({
  enabled, currency: "CNY", status: enabled ? "ready" : "disabled", available: enabled ? 20 : null, held: null, balances: null, membership: null,
  month: { since: "2026-10-01T00:00:00.000Z", paid: 0, pending: 0 },
  commerce: { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null },
});
const binding = { frameId: "frame-a", frameUrl: "https://host.example:8443/__evimed/f/frame-a/", expiresAt: Date.now() + 600_000, renewalToken: "renew-frame-a" };
function PathProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return <div><span data-testid="path">{location.pathname}</span><span data-testid="search">{location.search}</span><span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
    <button onClick={() => navigate("/app/chat/session-b")}>Open B</button>
    <button onClick={() => navigate("/app/files")}>Knowledge</button>
    <button onClick={() => navigate("/app/autopilot/agenda-one")}>Task</button>
    <button onClick={() => navigate("/app/chat")}>Bare chat</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </div>;
}
/**
 * What a task's page does for the frame: an empty pane at a place, and a request for the frame over it. The test sets where the
 * pane is and which conversation it wants (none, for an execution a bounded runtime is still running) before it navigates there.
 */
const taskPane = { sessionId: "session-exec" as string | null, rect: { left: 300, top: 60, width: 700, height: 500 } };
function TaskPaneProbe() {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = element.current!;
    pane.getBoundingClientRect = () => ({ ...taskPane.rect, x: taskPane.rect.left, y: taskPane.rect.top, right: taskPane.rect.left + taskPane.rect.width, bottom: taskPane.rect.top + taskPane.rect.height, toJSON: () => ({}) }) as DOMRect;
    return taskPane.sessionId ? registerTaskPane({ element: pane, projectId: mocks.projectId, sessionId: taskPane.sessionId }) : undefined;
  }, []);
  return <div ref={element} data-testid="task-pane">task bar and pane</div>;
}
/**
 * The shell as the conversation surface sees it: the frame host above the
 * router (where `AppShell` puts it, so a route change cannot unmount it) and
 * the chat route, which is a placeholder beside it.
 */
function mount(state: unknown = null, path = "/app/chat") {
  return render(<MemoryRouter initialEntries={[{ pathname: path, state }]}><PathProbe /><SessionFrameHost /><Routes>
    <Route path="/app/chat/:sessionId?" element={<SessionRoute />} />
    <Route path="/app/account" element={<div>account and usage</div>} />
    <Route path="/app/account/simulated/:page" element={<div>simulated wallet</div>} />
    <Route path="/app/files" element={<div>knowledge base</div>} />
    <Route path="/app/autopilot" element={<div>scheduled tasks</div>} />
    <Route path="/app/autopilot/:taskId" element={<TaskPaneProbe />} />
    <Route path="/app/runs/:runId/files/*" element={<div>run file reader</div>} />
  </Routes></MemoryRouter>);
}
function emit(frame: HTMLIFrameElement, data: Record<string, unknown>, origin = mocks.profile.uiOrigin, source: MessageEventSource | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, origin,
    data: { version: 1, frameId: binding.frameId, projectId: "default", seq: 1, ...data } })));
}
beforeEach(() => {
  window.localStorage.clear(); mocks.create.mockReset(); mocks.renew.mockReset(); mocks.release.mockReset(); mocks.release.mockResolvedValue(undefined); mocks.projectId = "default";
  mocks.create.mockResolvedValue(binding);
  mocks.listRuns.mockReset(); mocks.listRuns.mockResolvedValue([]);
  mocks.subscribe.mockReset(); mocks.subscribe.mockReturnValue(() => {});
  mocks.me.mockReset(); mocks.me.mockResolvedValue({});
  mocks.renew.mockImplementation(async () => ({ ...binding, expiresAt: Date.now() + 300_000 }));
  mocks.profile.uiOrigin = "https://host.example:8443";
  // A warm runtime unless a test says otherwise: the usual opening.
  mocks.start.mockReset(); mocks.start.mockResolvedValue(undefined);
  mocks.status.mockReset(); mocks.status.mockResolvedValue({ running: true, provider: "docker", startStage: null, startError: null });
  mocks.listAgents.mockReset(); mocks.listAgents.mockResolvedValue([{ id: "adr-analysis", version: "1.0.0" }]);
  mocks.listSessions.mockReset(); mocks.listSessions.mockResolvedValue([]);
  mocks.putSession.mockReset(); mocks.putSession.mockImplementation(async (sessionId: string, selection: object) => ({ sessionId, ...selection }));
  // Research billing is off unless a test says otherwise: every deployment today.
  mocks.allowance.mockReset(); mocks.allowance.mockResolvedValue(billing(false)); forgetResearchBilling();
  mocks.connectors.mockReset(); mocks.connectors.mockResolvedValue([]);
  mocks.saveConnector.mockReset(); mocks.dispatch.mockReset(); window.sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native frame identity and readiness", () => {
  async function establishedClockFrame() {
    vi.useFakeTimers();
    mocks.create.mockResolvedValue({ ...binding, expiresAt: Date.now() + 300_000 });
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const command = post.mock.calls[0][0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: "session-a" });
    return { ...view, frame, post };
  }

  it("renews the five-minute lease without replacing the native document or replaying navigation", async () => {
    const { container, frame, post } = await establishedClockFrame();
    await act(async () => { await vi.advanceTimersByTimeAsync(270_000); });
    expect(mocks.renew).toHaveBeenCalledWith(expect.objectContaining({ frameId: binding.frameId, renewalToken: binding.renewalToken }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(post).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("renews on foreground recovery after the old lease expired, preserving the native document", async () => {
    const { container, frame, post } = await establishedClockFrame();
    vi.setSystemTime(Date.now() + 360_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => { emit(frame, { type: "evimed.runtime-ui.error", seq: 3, error: "NATIVE_NOT_READY" }); });
    expect(container.querySelector("iframe")).toBe(frame);
  });

  // A renewal that fails is a network blip until the lease it renews is
  // actually gone. On 2026-09-20 one local failure covered a working
  // conversation with a blocking alert, while all 52 renewals that day reached
  // the server and all 52 answered 200 (walk, fact 2).
  it("retries a failed renewal silently, and says nothing while the lease still stands", async () => {
    const { container, frame } = await establishedClockFrame();
    mocks.renew.mockRejectedValue(new Error("offline"));
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    // 1 s, 3 s, 10 s, 30 s — and the conversation is never covered meanwhile.
    for (const [index, delay] of [1_000, 3_000, 10_000, 30_000].entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(mocks.renew).toHaveBeenCalledTimes(index + 2);
      expect(screen.queryByRole("alert")).toBeNull();
    }
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("covers the conversation only once the lease has expired and a retry has failed, and clears itself", async () => {
    const { container, frame } = await establishedClockFrame();
    mocks.renew.mockRejectedValue(new Error("offline"));
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("alert")).toBeNull();
    // Past the five minutes this binding was minted for.
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("连接");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.release).not.toHaveBeenCalled();
    // The ladder is still running underneath: the next success clears it with
    // no click, and the button is only there for someone who will not wait.
    mocks.renew.mockResolvedValue({ ...binding, expiresAt: Date.now() + 300_000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("iframe")).toBe(frame);
  });

  it("recovers failed readiness through the real native bridge without a new generation or fabricated ready", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const origin = "https://shell.example";
    let listener = (_event: unknown) => {};
    let generation = {};
    let generationChanged = () => {};
    let dispose = () => {};
    const refresh = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn(); const draft = vi.fn(); const openSession = vi.fn();
    const parent = { postMessage: (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: mocks.profile.uiOrigin, data }));
    } };
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(data => listener({ data, origin, source: parent }));
    await act(async () => {
      applyNativeBridge({
        loader: { await: async () => {} },
        connection: { generation: { getSnapshot: () => generation, subscribe: (fn: () => void) => { generationChanged = fn; return () => {}; } } },
        // 0.1.7: the session on screen is the row the main view retains, and
        // opening one is the workspace UI's.
        sessions: { refresh, create, scope: () => ({}),
          list: { getSnapshot: () => ({ byId: { "session-a": { id: "session-a", retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
        uiWorkspace: { openSession },
        workspaces: { create: vi.fn(), list: { getSnapshot: () => ({ items: [] }) } },
        conversation: { input: { for: () => ({ setDraft: draft }) } },
        effect: (setup: () => () => void) => { dispose = setup(); },
      }, {}, {
        __EVIMED_FRAME__: { version: 1, frameId: binding.frameId, projectId: "default", shellOrigin: origin, cwd: "/workspace" },
        // Keyed by type, as a browser is: the bridge listens for keys as well as messages.
        parent, addEventListener: (type: string, fn: typeof listener) => { if (type === "message") listener = fn; }, removeEventListener() {},
      });
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(1);
    expect(openSession).toHaveBeenCalledWith("session-a");
    refresh.mockRejectedValueOnce(new Error("temporary unary 401"));
    await act(async () => { generation = {}; generationChanged(); });
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post.mock.calls.some(([data]) => data.type === "evimed.runtime-ui.resume")).toBe(true);
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(1);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(create).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    refresh.mockRejectedValueOnce(new Error("still unavailable")).mockRejectedValueOnce(new Error("still unavailable"));
    await act(async () => { generation = {}; generationChanged(); });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("恢复"));
    expect(container.querySelector("iframe")).toBe(frame);
    mocks.start.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(1);
    expect(create).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled();
    // The reader asking for the conversation back is an opening: its runtime
    // may have yielded to a project opened in another tab.
    expect(mocks.start).toHaveBeenCalledWith({ projectId: "default", opening: true });
    dispose();
  });

  it("says so when 重新连接 is refused because the runtime went to a project opened elsewhere and none is idle", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    // The kernel's page cannot reconnect: its runtime yielded to a project
    // opened in another tab. The first loss is renewed silently; the second
    // is said, with the button.
    emit(frame, { type: "evimed.runtime-ui.error", seq: 3, error: "NATIVE_NOT_READY" });
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.error", seq: 4, error: "NATIVE_NOT_READY" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("研究连接暂时无法恢复，请重试"));
    mocks.start.mockRejectedValueOnce(new WebApiError("Too many running runtimes for this user; limit is 2.", { status: 429, code: "runtime_limit_exceeded" }));
    await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("你同时进行的研究已达上限，先结束一个再试。"));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("creates an immutable frame and waits for verified native readiness rather than iframe load", async () => {
    const { container, unmount } = mount();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    expect(mocks.create).toHaveBeenCalledWith("default"); expect(frame.src).toBe(binding.frameUrl);
    act(() => frame.dispatchEvent(new Event("load")));
    // One quiet line while the document loads, never the machinery behind it.
    await waitFor(() => expect(screen.getByText("正在打开")).toBeInTheDocument());
    expect(screen.queryByText(/内核|准备环境|载入界面/)).toBeNull();
    emit(frame, { type: "evimed.runtime-ui.ready" }, "https://evil.example");
    emit(frame, { type: "evimed.runtime-ui.ready" }, mocks.profile.uiOrigin, window);
    emit(frame, { type: "evimed.runtime-ui.ready", frameId: "frame-b" });
    expect(screen.getByText("正在打开")).toBeInTheDocument();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByText("正在打开")).toBeInTheDocument();
    const command = post.mock.calls[0][0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: command.intent.sessionId });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(container.querySelector("iframe")).toBe(frame);
    unmount(); expect(mocks.release).toHaveBeenCalledWith("frame-a");
  });

  it("runs the shell's own shortcuts when the frame forwards them, and puts focus in the opened conversation", async () => {
    // 2026-09-16 review, U8: with focus inside the cross-origin frame the
    // shell's window listeners hear no key, so the bridge forwards a closed set.
    const { useUiStore } = await import("@/lib/store");
    const { SHORTCUT_HELP_TOGGLE_EVENT } = await import("@/components/ui/ShortcutHelp");
    useUiStore.setState({ sidebarCollapsed: false });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const command = post.mock.calls[0][0];
    const focus = vi.spyOn(frame, "focus");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: command.intent.sessionId });
    await waitFor(() => expect(focus).toHaveBeenCalled());

    const help = vi.fn();
    window.addEventListener(SHORTCUT_HELP_TOGGLE_EVENT, help);
    // The palette this used to open is gone (2026-09-22); its name is now just
    // an unknown shortcut, dropped like any other.
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 3, shortcut: "command-palette" });
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 4, shortcut: "sidebar" });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 5, shortcut: "shortcuts" });
    expect(help).toHaveBeenCalledTimes(1);
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 6, shortcut: "navigate-anywhere" });
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 7, shortcut: "sidebar" }, "https://evil.example");
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(help).toHaveBeenCalledTimes(1);
    window.removeEventListener(SHORTCUT_HELP_TOGGLE_EVENT, help);
  });

  it("forwards a shell shortcut from the frame only as far as the single-character switch allows: ? is off, the sidebar chord is not", async () => {
    // WCAG 2.2 SC 2.1.4: the frame's `?` is the same single-character shortcut as the shell's own, so turning it off silences both.
    const { useUiStore } = await import("@/lib/store");
    const { SHORTCUT_HELP_TOGGLE_EVENT } = await import("@/components/ui/ShortcutHelp");
    useUiStore.setState({ sidebarCollapsed: false, singleKeyShortcuts: false });
    try {
      const { container } = mount();
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      emit(frame, { type: "evimed.runtime-ui.ready" });
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const command = post.mock.calls[0][0];
      emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: command.intent.sessionId });
      const help = vi.fn();
      window.addEventListener(SHORTCUT_HELP_TOGGLE_EVENT, help);
      emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 3, shortcut: "shortcuts" });
      expect(help).not.toHaveBeenCalled();
      emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 4, shortcut: "sidebar" });
      expect(useUiStore.getState().sidebarCollapsed).toBe(true);
      useUiStore.setState({ singleKeyShortcuts: true });
      emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 5, shortcut: "shortcuts" });
      expect(help).toHaveBeenCalledTimes(1);
      window.removeEventListener(SHORTCUT_HELP_TOGGLE_EVENT, help);
    } finally {
      useUiStore.setState({ singleKeyShortcuts: true });
    }
  });

  describe("a conversation opened while the project's runtime settings are being applied", () => {
    // 2026-10-04: the first conversation after a release met 423
    // `plugin_apply_in_progress` for the ten to forty seconds an apply took, and
    // the notice page said 「对话暂时打不开」. The control plane waits for the
    // apply itself; what is left is said quietly and opened again by itself.
    const notice = (frame: HTMLIFrameElement, code: string) => emit(frame, { type: "evimed.runtime-ui.notice", code,
      title: "对话暂时打不开", detail: "正在为这个项目准备运行环境，通常半分钟内完成。完成后再试一次即可。" });

    it("says it is preparing, shows no alert, and opens the conversation again by itself", async () => {
      vi.useFakeTimers();
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      notice(container.querySelector("iframe")!, "plugin_apply_in_progress");
      expect(screen.getByText("正在准备运行环境")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(mocks.create).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      // Once the conversation opens the line is gone with the cover.
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      emit(frame, { type: "evimed.runtime-ui.ready" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
      expect(screen.queryByText("正在准备运行环境")).toBeNull();
    });

    it("gives up after five tries and says so with the retry, never the usage page", async () => {
      vi.useFakeTimers();
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      for (let tried = 1; tried <= 5; tried++) {
        notice(container.querySelector("iframe")!, "plugin_apply_in_progress");
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
        expect(mocks.create).toHaveBeenCalledTimes(tried + 1);
      }
      notice(container.querySelector("iframe")!, "plugin_apply_in_progress");
      expect(screen.getByRole("alert")).toHaveTextContent("正在为这个项目准备运行环境");
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /用量|额度/ })).toBeNull();
    });

    it("leaves every other notice as the alert it was", async () => {
      const { container } = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      notice(container.querySelector("iframe")!, "runtime_limit_exceeded");
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByText("正在准备运行环境")).toBeNull();
    });

    it("does not fail the opening when its own start is refused for an apply under way", async () => {
      mocks.start.mockRejectedValue(new WebApiError("Plugin settings are being applied; retry shortly.", { status: 423, code: "plugin_apply_in_progress" }));
      const { container } = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(mocks.start).toHaveBeenCalled());
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("a conversation opened while every research environment of the deployment is taken", () => {
    // 2026-10-05, live acceptance: the host's four slots (shared with other
    // products) were taken and the researcher was shown a refusal. A full house is
    // a place in line: one plain line, asked again by itself with a backoff that
    // honours the control plane's `Retry-After`, started when a slot frees. The
    // researcher's own ceiling (`runtime_limit_exceeded`) stays an honest refusal.
    const FULL = "所有研究环境都在使用中，空出后会自动开始。";
    const full = (retryAfterSeconds: number | null = 5) => new WebApiError("Every runtime slot of the server is taken; limit is 4.", { status: 429, code: "runtime_capacity_full", retryAfterSeconds });

    it("says one plain line, no alert and no retry button, and starts by itself once a slot frees", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValueOnce(full());
      mocks.start.mockRejectedValueOnce(full());
      mocks.start.mockResolvedValue(undefined);
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText(FULL)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
      expect(mocks.start).toHaveBeenCalledTimes(1);
      // Asked again at the control plane's pace (five seconds), then a little slower.
      await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
      expect(mocks.start).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(screen.getByText(FULL)).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(7_700); });
      expect(mocks.start).toHaveBeenCalledTimes(2);
      const bindings = mocks.create.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      // The third ask finds room: the conversation opens again, against a runtime that is up.
      expect(mocks.start.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mocks.create.mock.calls.length).toBeGreaterThan(bindings);
      expect(screen.queryByText(FULL)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      emit(frame, { type: "evimed.runtime-ui.ready" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("waits past the opening's own deadline: nothing has stalled while it stands in line", async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.start.mockRejectedValue(full(15));
      mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: null, startError: null });
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(screen.getByText(FULL)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // Never faster than the hint, and not unbounded: one ask per fifteen seconds at most.
      expect(mocks.start.mock.calls.length).toBeLessThanOrEqual(1 + 300 / 15);
      expect(mocks.start.mock.calls.length).toBeGreaterThan(10);
    });

    it("takes the frame document's own notice as the same wait, with one timer", async () => {
      vi.useFakeTimers();
      mocks.start.mockResolvedValue(undefined);
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "runtime_capacity_full", title: "对话暂时打不开", detail: FULL });
      emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "runtime_capacity_full", title: "对话暂时打不开", detail: FULL });
      expect(screen.getByText(FULL)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      const asked = mocks.start.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      // One ask, which found room, and the opening's own start again against the runtime that is up.
      expect(mocks.start.mock.calls.length).toBe(asked + 2);
    });

    it("stops asking when the reader leaves, and does not ask for a hidden conversation", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(full());
      const { unmount } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const asked = mocks.start.mock.calls.length;
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.start.mock.calls.length).toBe(asked);
    });

    it("turns to an honest refusal when a later ask meets the researcher's own ceiling or another refusal", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValueOnce(full());
      mocks.start.mockRejectedValue(new WebApiError("Too many running runtimes for this user; limit is 2.", { status: 429, code: "runtime_limit_exceeded" }));
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText(FULL)).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(screen.getByRole("alert")).toHaveTextContent("你同时进行的研究已达上限，先结束一个再试。");
      expect(screen.queryByText(FULL)).toBeNull();
    });
  });

  describe("a conversation opened while the previous task's runtime is still being cleaned up", () => {
    // 2026-10-07, audit B03 (P0): one stuck cleanup refused every start of a project for hours, and the
    // page offered 「查看科研额度」 and nothing else — the refusal was classed as a ceiling and every
    // ceiling read as a spending one. The refusal is said for what it is: a wait, on the cover; and
    // when the wait is long, the retry and the way to what the project already holds.
    const WAIT_LINE = "正在清理上一次任务的运行环境，完成后自动继续";
    const GAVE_UP = "运行环境还没有清理完成，暂时不能继续这个对话。稍后再试，已有成果可以先阅读。";
    const cleaning = (status = 503, code = "runtime_cleanup_required") => new WebApiError("The previous runtime needs cleanup.", { status, code, retryAfterSeconds: 5 });
    const noQuotaPage = () => {
      expect(screen.queryByRole("button", { name: /额度|用量/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "去模拟充值" })).toBeNull();
    };

    it("covers the conversation with its title and one line, asks again by itself, and opens when the cleanup is done", async () => {
      vi.useFakeTimers();
      rememberConversationTitles([{ sessionId: "session-a", title: "ASPREE试验主要结论" } as WebAgentRun]);
      mocks.start.mockRejectedValueOnce(cleaning());
      mocks.start.mockRejectedValueOnce(cleaning());
      mocks.start.mockResolvedValue(undefined);
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const cover = screen.getByRole("status");
      expect(cover).toHaveTextContent("ASPREE试验主要结论");
      expect(cover).toHaveTextContent(WAIT_LINE);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: /重试|已有成果/ })).toBeNull();
      noQuotaPage();
      expect(mocks.start).toHaveBeenCalledTimes(1);
      // At the pace the control plane named (five seconds), not before.
      await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
      expect(mocks.start).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(mocks.start).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      const bindings = mocks.create.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      // The third ask finds the cleanup done: the conversation opens again, against a runtime that is up.
      expect(mocks.start.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mocks.create.mock.calls.length).toBeGreaterThan(bindings);
      expect(screen.queryByText(WAIT_LINE)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      emit(frame, { type: "evimed.runtime-ui.ready" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("says it for a runtime that is still stopping the same way", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(new WebApiError("The runtime is stopping; retry shortly.", { status: 409, code: "runtime_busy" }));
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      expect(screen.queryByRole("alert")).toBeNull();
      noQuotaPage();
    });

    it("says it before the start is refused, when the status already reports a cleanup under way", async () => {
      vi.useFakeTimers();
      mocks.create.mockImplementation(() => new Promise(() => {}));
      mocks.start.mockImplementation(() => new Promise(() => {}));
      mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: null, startError: null, cleanupPending: true });
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: "environment", startError: null, cleanupPending: false });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
      expect(screen.getByRole("status")).toHaveTextContent("正在打开");
      expect(screen.getByRole("status")).not.toHaveTextContent(WAIT_LINE);
    });

    it("takes the frame document's own notice as the same wait", async () => {
      vi.useFakeTimers();
      mocks.start.mockResolvedValue(undefined);
      const { container } = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const detail = errorCodeMessage("runtime_cleanup_required");
      emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "runtime_cleanup_required", title: "对话暂时打不开", detail });
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      expect(screen.queryByRole("alert")).toBeNull();
      noQuotaPage();
      const bindings = mocks.create.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
      // One ask found the cleanup done and the conversation is opened again.
      expect(mocks.create.mock.calls.length).toBeGreaterThan(bindings);
      expect(screen.queryByText(WAIT_LINE)).toBeNull();
    });

    it("after two minutes says it is taking long, with 重试 and the way to what the project holds — never the quota page", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(cleaning());
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(GAVE_UP);
      expect(screen.getByRole("button", { name: "重试" })).toHaveFocus();
      expect(screen.getByRole("button", { name: "查看已有成果" })).toBeInTheDocument();
      noQuotaPage();
      expect(screen.queryByText(WAIT_LINE)).toBeNull();
      // Not asked without end: the allowance of waiting is spent.
      const asked = mocks.start.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(mocks.start.mock.calls.length).toBe(asked);
    });

    it("重试 gives it a fresh allowance, and the brief the reader came with is sent when it opens", async () => {
      vi.useFakeTimers();
      const intent = { kind: "create", sessionId: "session-new", draft: "我的草稿：司美格鲁肽的心血管获益", requestId: "request-draft", projectId: "default" };
      mocks.start.mockRejectedValue(cleaning());
      const { container } = mount({ runtimeUiIntent: intent }, "/app/chat");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      expect(screen.getByRole("alert")).toHaveTextContent(GAVE_UP);
      // The cleanup finished meanwhile.
      mocks.start.mockReset(); mocks.start.mockResolvedValue(undefined);
      const bindings = mocks.create.mock.calls.length;
      await act(async () => { screen.getByRole("button", { name: "重试" }).click(); await vi.advanceTimersByTimeAsync(0); });
      expect(mocks.create.mock.calls.length).toBe(bindings + 1);
      expect(screen.queryByRole("alert")).toBeNull();
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      emit(frame, { type: "evimed.runtime-ui.ready" });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(post.mock.calls[0][0]).toMatchObject({ type: "evimed.runtime-ui.navigate", requestId: "request-draft", intent: { sessionId: "session-new", draft: intent.draft } });
    });

    it("重试 after the give-up waits again for a fresh two minutes if the cleanup is still not done", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(cleaning());
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      expect(screen.getByRole("alert")).toHaveTextContent(GAVE_UP);
      await act(async () => { screen.getByRole("button", { name: "重试" }).click(); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
      expect(screen.getByRole("alert")).toHaveTextContent(GAVE_UP);
    });

    it("查看已有成果 opens the report this conversation delivered, read without a runtime", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(cleaning());
      mocks.listRuns.mockResolvedValue([
        { id: "run_other", sessionId: "session-other", createdAt: "2026-10-07T09:00:00.000Z", artifacts: ["deliverables/other.md"] },
        { id: "run_old", sessionId: "session-a", createdAt: "2026-10-06T09:00:00.000Z", artifacts: ["deliverables/old.md"] },
        { id: "run_new", sessionId: "session-a", createdAt: "2026-10-07T09:00:00.000Z", artifacts: ["deliverables/notes.md", "deliverables/clinical-evidence-report.md"] },
      ]);
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      await act(async () => { screen.getByRole("button", { name: "查看已有成果" }).click(); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("path")).toHaveTextContent("/app/runs/run_new/files/deliverables/clinical-evidence-report.md");
      expect(screen.getByText("run file reader")).toBeInTheDocument();
    });

    it("查看已有成果 opens the project's files when the conversation delivered nothing, or the ledger cannot be read", async () => {
      vi.useFakeTimers();
      mocks.start.mockRejectedValue(cleaning());
      mocks.listRuns.mockResolvedValue([{ id: "run_a", sessionId: "session-a", createdAt: "2026-10-07T09:00:00.000Z", artifacts: [] }]);
      const first = mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      await act(async () => { screen.getByRole("button", { name: "查看已有成果" }).click(); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("path")).toHaveTextContent("/app/files");
      first.unmount();

      mocks.listRuns.mockRejectedValue(new Error("ledger down"));
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000); });
      await act(async () => { screen.getByRole("button", { name: "查看已有成果" }).click(); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId("path")).toHaveTextContent("/app/files");
    });

    it("says the same for a binding refused for the cleanup, and waits for it the same way", async () => {
      vi.useFakeTimers();
      mocks.create.mockRejectedValueOnce(cleaning());
      mount(null, "/app/chat/session-a");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("status")).toHaveTextContent(WAIT_LINE);
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(mocks.create.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.queryByText(WAIT_LINE)).toBeNull();
    });
  });

  describe("every other refusal of a start is said for its own cause", () => {
    it("tells the project's own scheduled research from a quota: its own sentence, a retry, and the scheduled tasks — no usage page", async () => {
      mocks.start.mockRejectedValue(new WebApiError("This project runtime is completing bounded proactive research.", { status: 423, code: "runtime_reserved_for_autopilot" }));
      mount(null, "/app/chat/session-a");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("这个项目正在执行你设定的定时研究，结束后即可继续。");
      expect(alert).not.toHaveTextContent("主动研究");
      expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /额度|用量/ })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "查看定时任务" }));
      expect(screen.getByTestId("path")).toHaveTextContent("/app/autopilot");
      expect(screen.getByText("scheduled tasks")).toBeInTheDocument();
    });

    it("reads the autopilot hold on the frame document's notice page the same way", async () => {
      const { container } = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "runtime_reserved_for_autopilot", title: "对话暂时打不开", detail: errorCodeMessage("runtime_reserved_for_autopilot") });
      expect(await screen.findByRole("alert")).toHaveTextContent("这个项目正在执行你设定的定时研究，结束后即可继续。");
      expect(screen.getByRole("button", { name: "查看定时任务" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /额度|用量/ })).toBeNull();
    });

    it("does not call a rate limit, or a lock of another cause, a quota problem: a retry and nothing else", async () => {
      for (const refusal of [
        new WebApiError("Too many requests.", { status: 429, code: "rate_limited" }),
        new WebApiError("Locked.", { status: 423, code: "some_future_lock" }),
      ]) {
        mocks.create.mockRejectedValueOnce(refusal);
        const view = mount();
        const alert = await screen.findByRole("alert");
        expect(alert).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /额度|用量|已有成果|定时任务/ })).toBeNull();
        view.unmount();
      }
    });

    it("keeps the spending refusals to the allowance page whichever way they arrive", async () => {
      // The start call, the binding and the notice page agree: a spend refusal is the one cause the page lifts.
      mocks.start.mockRejectedValueOnce(new WebApiError("This request would exceed the usage limit.", { status: 402, code: "usage_budget_exceeded" }));
      const view = mount(null, "/app/chat/session-a");
      expect(await screen.findByRole("alert")).toHaveTextContent(errorCodeMessage("usage_budget_exceeded"));
      expect(screen.getByRole("button", { name: "查看用量" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
      view.unmount();

      const { container } = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "credits_exhausted", title: "对话暂时打不开", detail: errorCodeMessage("credits_exhausted") });
      expect(await screen.findByRole("alert")).toHaveTextContent(errorCodeMessage("credits_exhausted"));
      expect(await screen.findByRole("button", { name: "查看用量" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    });
  });

  it("offers retry on frame failure without silently switching dispatchers", async () => {
    mocks.create.mockRejectedValueOnce(new Error("Unavailable")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("对话暂时无法连接");
    // Focus lands on the one thing to do next (U8).
    await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  // Every frame refusal used to arrive as 「研究会话暂时无法连接」 with a retry
  // button beside it. Both halves were wrong for a ceiling: the sentence named
  // a cause the code contradicts, and the only offered action is the one action
  // that cannot work while the window is full.
  const dailyLimit = () => new WebApiError("This account reached its daily spending limit.", {
    status: 402, code: "credits_daily_limit_reached", requestId: "req_402", retryAfterSeconds: 11_520,
  });

  it("names the ceiling that refused the frame, says when it frees, and offers the usage page instead of a retry", async () => {
    mocks.create.mockRejectedValueOnce(dailyLimit());
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("今日额度上限已到");
    expect(alert).toHaveTextContent("约 3 小时 12 分后额度开始释放");
    expect(alert).toHaveTextContent("不是整点清零");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    // This deployment does not bill research, so the page is 用量 and so is the button.
    await userEvent.click(await screen.findByRole("button", { name: "查看用量" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/app/account");
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=usage");
    expect(screen.queryByRole("button", { name: "查看科研额度" })).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  // The page behind the button is named by the deployment: 科研额度 only where
  // research is billed (`useResearchBilling`), and the button says what the
  // page is called.
  it("calls the usage page 科研额度 on a deployment that bills research, and goes to the same address", async () => {
    mocks.allowance.mockResolvedValue(billing(true));
    mocks.create.mockRejectedValueOnce(dailyLimit());
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("今日额度上限已到");
    await userEvent.click(await screen.findByRole("button", { name: "查看科研额度" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/app/account");
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=usage");
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
  });

  it("says 查看用量 until the deployment has said it bills research, and offers the way to the page at once", async () => {
    let answer!: (value: object) => void;
    mocks.allowance.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mocks.create.mockRejectedValueOnce(dailyLimit());
    mount();
    expect(await screen.findByRole("button", { name: "查看用量" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看科研额度" })).toBeNull();
    await act(async () => { answer(billing(true)); });
    expect(screen.getByRole("button", { name: "查看科研额度" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
  });

  it("says 查看用量 when the deployment's answer cannot be read, and still offers the way", async () => {
    mocks.allowance.mockRejectedValue(new Error("network"));
    mocks.create.mockRejectedValueOnce(dailyLimit());
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("今日额度上限已到");
    await waitFor(() => expect(mocks.allowance).toHaveBeenCalled());
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "查看用量" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=usage");
    expect(screen.queryByRole("button", { name: "查看科研额度" })).toBeNull();
  });

  it("reads the allowance only when a ceiling refused the conversation, not for every conversation that opens", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    await act(async () => {});
    expect(mocks.allowance).not.toHaveBeenCalled();
  });

  // A deployment whose wallet is simulated refuses under its own code. What
  // lifts that refusal is a simulated top-up, so the action offered is the
  // simulated recharge page rather than the allowance page — and the code says
  // which wallet it is, so nothing has to be read to name the button.
  const simulatedExhausted = () => new WebApiError("The simulated allowance is too low.", {
    status: 402, code: "simulated_credits_exhausted", requestId: "req_402_sim",
  });

  it("offers the simulated recharge page, not the allowance page or a retry, when the simulated allowance refused the conversation", async () => {
    mocks.allowance.mockResolvedValue(billing(true));
    mocks.create.mockRejectedValueOnce(simulatedExhausted());
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorCodeMessage("simulated_credits_exhausted"));
    expect(alert).toHaveTextContent("模拟额度不足");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看科研额度" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "去模拟充值" }));
    expect(screen.getByTestId("path")).toHaveTextContent(SIMULATED_WALLET_PAGES.recharge);
    expect(screen.getByText("simulated wallet")).toBeInTheDocument();
    await act(async () => {});
    expect(mocks.allowance).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("offers the same way when it is the runtime's start that the simulated allowance refused", async () => {
    mocks.start.mockRejectedValueOnce(simulatedExhausted());
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("模拟额度不足");
    expect(screen.getByRole("button", { name: "去模拟充值" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
  });

  it("offers the same way when the frame's own notice page names the simulated allowance", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const detail = errorCodeMessage("simulated_credits_exhausted");
    emit(frame, { type: "evimed.runtime-ui.notice", code: "simulated_credits_exhausted", title: "对话暂时打不开", detail });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(detail);
    // Neither a wait nor ending another conversation lifts it: no retry, and the recharge page.
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "去模拟充值" }));
    expect(screen.getByTestId("path")).toHaveTextContent(SIMULATED_WALLET_PAGES.recharge);
    expect(screen.getByText("simulated wallet")).toBeInTheDocument();
  });

  // The other ceilings are untouched: a concurrency notice still offers a
  // retry and no page, and a real wallet's refusal still leads to the allowance.
  it("keeps a concurrency notice and a real wallet's refusal as they were", async () => {
    const { container, unmount } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    emit(container.querySelector("iframe")!, { type: "evimed.runtime-ui.notice", code: "runtime_limit_exceeded", title: "对话暂时打不开", detail: "" });
    // Said as the cap it is, whatever the page titled itself: the code decides what the refusal is.
    expect(await screen.findByRole("alert")).toHaveTextContent("你同时进行的研究已达上限，先结束一个再试。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "去模拟充值" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
    unmount();

    mocks.allowance.mockResolvedValue(billing(true));
    mocks.create.mockRejectedValueOnce(new WebApiError("Out of credits.", { status: 402, code: "credits_exhausted" }));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(errorCodeMessage("credits_exhausted"));
    expect(await screen.findByRole("button", { name: "查看科研额度" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "去模拟充值" })).toBeNull();
  });

  // A refusal that is not a ceiling keeps its retry, but stops claiming the
  // cause was the connection.
  it("renders a disabled surface as the reason it gave rather than as a connection fault", async () => {
    mocks.create.mockRejectedValueOnce(new WebApiError("The native UI is not enabled.", {
      status: 404, code: "runtime_ui_not_enabled", requestId: "req_404",
    }));
    mount();
    const alert = await screen.findByRole("alert");
    // The registry's `^runtime_` family sentence, reaching a pixel for the
    // first time: this build has held it since the registry existed.
    expect(alert).toHaveTextContent("运行时出现问题，稍后重试。");
    expect(alert).not.toHaveTextContent("对话暂时无法连接");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  // An ended session is already being handled — `fetchWithWebAuth` announces it
  // and the shell moves to the login route — so a retry here races that instead
  // of fixing anything.
  it("tells an expired login to log in again and does not offer a retry", async () => {
    mocks.create.mockRejectedValueOnce(new WebApiError("Session expired.", {
      status: 401, code: "authentication_required", requestId: "req_401",
    }));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("登录已失效，请重新登录。");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看用量" })).toBeNull();
    expect(screen.queryByRole("button", { name: "查看科研额度" })).toBeNull();
    expect(mocks.allowance).not.toHaveBeenCalled();
  });

  it("passes a persisted revision reference to the existing native draft without submitting it", async () => {
    const referenceId = `rr_${"a".repeat(64)}`;
    const intent = { kind: "open", sessionId: "session-a", draft: "Frozen selection:\n", requestId: "request-revision", projectId: "default", resultRevision: { referenceId } };
    const { container } = mount({ runtimeUiIntent: intent });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({ type: "evimed.runtime-ui.navigate", intent: { draft: intent.draft, resultRevision: { referenceId } } });
    expect(post.mock.calls[0][0].type).not.toContain("prompt");
  });

  it("keeps a capability intent pending until a matching success acknowledgement", async () => {
    const intent = { kind: "create", sessionId: "session-new", draft: "Evidence brief", requestId: "request-a", projectId: "default" };
    const { container } = mount({ runtimeUiIntent: intent });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({ type: "evimed.runtime-ui.navigate", requestId: "request-a", frameId: "frame-a", intent: { sessionId: "session-new", draft: "Evidence brief" } });
    expect(post.mock.calls[0][1]).toBe(mocks.profile.uiOrigin);
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: "wrong", ok: true, sessionId: "session-new" });
    expect(screen.getByText("正在打开")).toBeInTheDocument();
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: "request-a", ok: true, sessionId: "session-canonical" });
    await waitFor(() => expect(screen.queryByText("正在打开")).toBeNull());
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-canonical");
  });

  it("shows an explicit unavailable state when the deployment has no native surface", async () => {
    mocks.profile.uiOrigin = ""; mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("对话暂时无法连接");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("opens deep links and back navigation in the same frame, and mirrors native session selection", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0].intent).toEqual({ kind: "open", sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    await userEvent.click(screen.getByText("Open B"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0].intent.sessionId).toBe("session-b");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: post.mock.calls[1][0].requestId, ok: true, sessionId: "session-b" });
    await userEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][0].intent.sessionId).toBe("session-a");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 4, requestId: post.mock.calls[2][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.session", seq: 5, sessionId: "session-native" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-native"));
    expect(post).toHaveBeenCalledTimes(3); expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("surfaces unknown sessions without changing the URL or starting a second prompt path", async () => {
    const { container } = mount(null, "/app/chat/unknown-session");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: false, error: "NAVIGATION_FAILED" });
    expect(await screen.findByRole("alert")).toHaveTextContent("这条对话暂时无法打开");
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/unknown-session");
    // Retrying asks for the same task again; a new task is the other way out (U9).
    await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/chat$/));
  });

  it("opens no conversation until it knows whether there is one to resume, while the runtime warms underneath", async () => {
    // U9: the lookup and the frame used to race, and a frame that won created
    // an empty conversation the lookup then navigated away from. The frame is
    // no longer withheld for it — the runtime it needs is the same either way,
    // so warming under the lookup is free — but it is told to open nothing.
    let answer!: (runs: unknown[]) => void;
    mocks.listRuns.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const navigations = () => post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await act(async () => {});
    expect(navigations()).toHaveLength(0);
    await act(async () => { answer([{ sessionId: "session-recent" }]); });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-recent"));
    await waitFor(() => expect(navigations()).toHaveLength(1));
    expect(navigations()[0][0].intent).toEqual({ kind: "open", sessionId: "session-recent" });
    // The same document throughout: the lookup cost no rebuild.
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("makes a task chosen inside the frame a history entry that Back returns from", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.session", seq: 3, sessionId: "session-native" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-native"));
    await userEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a"));
  });

  it("recovers an established frame without recreating its document or navigation", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "wrong-session" });
    expect(screen.getByText("正在打开")).toBeInTheDocument();
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.error", seq: 4, error: "NATIVE_NOT_READY" });
    await waitFor(() => expect(mocks.renew).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBe(frame);
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 5 });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(1);
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.resume")).toHaveLength(1);
  });

  it("releases late frame cookies without mounting a disposed response", async () => {
    let resolveFrame!: (value: typeof binding) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { resolveFrame = resolve; }));
    const { unmount } = mount(null, "/app/chat/session-a"); unmount();
    await act(async () => resolveFrame(binding));
    expect(mocks.release).toHaveBeenCalledWith("frame-a");
  });

  it("turns a native clear into a fresh task while keeping the same frame", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.session", seq: 3, sessionId: null });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0].intent.kind).toBe("create");
    expect(screen.getByTestId("path").textContent).toBe("/app/chat");
    expect(container.querySelector("iframe")).toBe(frame);
  });

  it("retains navigation during reconnect and retransmits the same identity after ready", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const navigations = () => post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.connecting", seq: 3 });
    await userEvent.click(screen.getByText("Open B"));
    expect(navigations()).toHaveLength(1);
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 4 });
    await waitFor(() => expect(navigations()).toHaveLength(2));
    const request = navigations()[1][0];
    expect(request.intent).toEqual({ kind: "open", sessionId: "session-b" });
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 5 });
    await waitFor(() => expect(navigations()).toHaveLength(3));
    expect(navigations()[2][0]).toMatchObject({ requestId: request.requestId, intent: request.intent });
    expect(navigations()[2][0].seq).toBeGreaterThan(request.seq);
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 6, requestId: request.requestId, ok: true, sessionId: "session-b" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-b");
    expect(container.querySelector("iframe")).toBe(frame);
  });

});

describe("the shell's theme in the frame", () => {
  // jsdom has no matchMedia; the shell asks it only while the preference is
  // "system", to say which scheme that resolves to.
  function stubScheme(dark: boolean) {
    const listeners = new Set<() => void>();
    const media = { matches: dark, addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn) };
    const original = window.matchMedia;
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
    return { flip(next: boolean) { media.matches = next; act(() => { for (const fn of [...listeners]) fn(); }); }, listeners,
      restore() { window.matchMedia = original; } };
  }
  // Unmounted first: the store is shared by every test in this file, and a
  // reset while the frame is still mounted re-renders it outside act().
  afterEach(() => { cleanup(); useUiStore.setState({ theme: "system" }); });

  it("answers the frame's first word with the shell's choice, and follows every change", async () => {
    const scheme = stubScheme(false);
    try {
      useUiStore.setState({ theme: "dark" });
      const { container } = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const frame = container.querySelector("iframe")!;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      const themes = () => post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.theme").map(([data, origin]) => ({ ...data, origin }));
      // A bridge that never said it was listening is told nothing: an older
      // frame document has no use for the message.
      emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(themes()).toHaveLength(0);
      emit(frame, { type: "evimed.runtime-ui.booted", seq: 3 });
      await waitFor(() => expect(themes()).toHaveLength(1));
      expect(themes()[0]).toMatchObject({ version: 1, frameId: "frame-a", projectId: "default", preference: "dark", resolved: "dark", origin: mocks.profile.uiOrigin });
      expect(themes()[0].seq).toBeGreaterThan(post.mock.calls[0][0].seq);
      act(() => useUiStore.getState().setTheme("system"));
      await waitFor(() => expect(themes()).toHaveLength(2));
      expect(themes()[1]).toMatchObject({ preference: "system", resolved: "light" });
      // Under "system" an OS flip is news too; under an explicit choice it is not.
      scheme.flip(true);
      await waitFor(() => expect(themes()).toHaveLength(3));
      expect(themes()[2]).toMatchObject({ preference: "system", resolved: "dark" });
      act(() => useUiStore.getState().setTheme("light"));
      await waitFor(() => expect(themes()).toHaveLength(4));
      expect(scheme.listeners.size).toBe(0);
      scheme.flip(false);
      expect(themes()).toHaveLength(4);
      expect(themes().map(entry => entry.seq)).toEqual([...themes().map(entry => entry.seq)].sort((a, b) => a - b));
    } finally { scheme.restore(); }
  });

  it("reaches the kernel's theme runtime through the real bridge and the frame's theme body", async () => {
    useUiStore.setState({ theme: "dark" });
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const origin = "https://shell.example";
    let listener = (_event: unknown) => {};
    const parent = { postMessage: (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: mocks.profile.uiOrigin, data }));
    } };
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(data => listener({ data, origin, source: parent }));
    const setTheme = vi.fn();
    const overrideTokens = vi.fn(() => () => {});
    const disposers: Array<() => void> = [];
    const ctx: Record<string, unknown> = {
      loader: { await: () => new Promise(() => {}) },
      connection: { generation: { getSnapshot: () => ({}), subscribe: () => () => {} } },
      sessions: { refresh: vi.fn(), create: vi.fn(), scope: () => ({}), list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
      uiWorkspace: { openSession: vi.fn() },
      workspaces: { create: vi.fn(), list: { getSnapshot: () => ({ items: [] }) } },
      conversation: { input: { for: () => ({ setDraft: vi.fn() }) } },
      theme: { setTheme, overrideTokens },
      effect: (setup: () => (() => void) | void) => { const dispose = setup(); if (typeof dispose === "function") disposers.push(dispose); },
      on: () => () => {},
    };
    ctx.inject = (_names: string[], callback: (scope: unknown) => void) => callback(ctx);
    const target = {
      __EVIMED_FRAME__: { version: 1, frameId: binding.frameId, projectId: "default", shellOrigin: origin, cwd: "/workspace" },
      parent, addEventListener: (type: string, fn: typeof listener) => { if (type === "message") listener = fn; }, removeEventListener() {},
      setTimeout, clearTimeout, console,
    };
    // The real vocabulary: the palette the theme body applies is the product's
    // one token module, inlined into it at build time.
    const kit = createFrameKit(ctx, target, () => undefined, FRAME_VOCABULARY);
    await act(async () => {
      applyNativeBridge(ctx, {}, target, undefined, kit);
      applyFrameTheme(ctx, {}, target, undefined, kit);
    });
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"));
    // Derived, not typed: the send button's glyph is a hard-coded #fff in the
    // kernel, so this fill is the one token that must carry white in both
    // schemes, and a literal here would have gone stale when the brand changed.
    expect(overrideTokens).toHaveBeenCalledWith(
      "@evimed/dsh-socket",
      expect.objectContaining({ "--dsw-alias-button-info-fill": kernelThemeTokens()["--dsw-alias-button-info-fill"] }),
    );
    act(() => useUiStore.getState().setTheme("light"));
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light"));
    for (const dispose of disposers.reverse()) dispose();
  });
});

describe("the run behind the task, in the frame", () => {
  async function openTask() {
    const view = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    return { ...view, frame, post, sent: (type: string) => post.mock.calls.filter(([data]) => data.type === `evimed.runtime-ui.${type}`).map(([data]) => data) };
  }
  const run = { id: "run-1", sessionId: "session-a", status: "running", startedAt: "2026-09-18T01:00:00.000Z", createdAt: "2026-09-18T01:00:00.000Z",
    artifacts: [], unverifiedArtifacts: [], planItems: [{ id: "evidence", title: "证据综述", status: "delegated", attempts: 0 }] };

  it("reaches the frame once its bridge listens, and follows the run's stream", async () => {
    mocks.listRuns.mockResolvedValue([run]);
    let onEvent: (event: Record<string, unknown>) => void = () => {};
    mocks.subscribe.mockImplementation((_id: string, handler: typeof onEvent) => { onEvent = handler; return () => {}; });
    const { frame, sent } = await openTask();
    expect(mocks.listRuns).not.toHaveBeenCalled();
    emit(frame, { type: "evimed.runtime-ui.booted", seq: 3 });
    await waitFor(() => expect(sent("run-state").at(-1)).toMatchObject({ runId: "run-1", sessionId: "session-a", state: "running", frameId: "frame-a", projectId: "default" }));
    act(() => onEvent({ seq: 1, time: "2026-09-18T01:01:00.000Z", type: "run/progress", currentPhase: "search", phaseCounts: { search: 2 }, children: [] }));
    await waitFor(() => expect(sent("run-state").at(-1)).toMatchObject({ progress: { currentPhase: "search" } }));
    const seqs = sent("run-state").map((data) => data.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  describe("a data source the run went without", () => {
    const connector = (source: "none" | "user") => ({ id: "umls", title: "UMLS", kind: "api-key", unlocks: "", obtainUrl: "https://example.test/umls",
      capabilities: [], keyless: false, validityDays: null, source, own: null, needsAttention: source === "none" });
    const finished = { ...run, status: "succeeded", finishedAt: "2026-09-18T01:05:00.000Z", mode: "open-domain", effectiveAgentId: "open-domain-answer", connectorNeeds: ["umls"], availableActions: [{ kind: "continue", scope: "session", targetId: "session-a" }] };

    it("shows a strip above the frame, opens the credential form in place, and asks for the skipped part in the same conversation", async () => {
      mocks.listRuns.mockResolvedValue([finished]);
      mocks.connectors.mockResolvedValue([connector("none")]);
      mocks.saveConnector.mockResolvedValue({ expiresAt: null, check: "verified" });
      mocks.dispatch.mockResolvedValue({ ...finished, id: "run-2", status: "running", connectorNeeds: undefined });
      const user = userEvent.setup();
      const { frame, container } = await openTask();
      emit(frame, { type: "evimed.runtime-ui.booted", seq: 3 });
      const strip = await screen.findByText("UMLS 还没有配置，相关部分已跳过。");
      // Outside the kernel's frame, ahead of it: the strip is not part of the iframe's page.
      const bar = strip.closest("[data-connector-need]") as HTMLElement;
      expect(bar).not.toBeNull();
      expect(bar.contains(frame)).toBe(false);
      expect(bar.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.querySelectorAll("iframe")).toHaveLength(1);

      // The strip is there before the connector list is: until it is read 去配置
      // is a link to the settings page, and the button in place comes with it.
      await user.click(await screen.findByRole("button", { name: "去配置" }));
      await user.type(screen.getByLabelText("UMLS 凭据"), "umls-secret-key-123");
      mocks.connectors.mockResolvedValue([connector("user")]);
      await user.click(screen.getByRole("button", { name: "保存 UMLS 凭据" }));
      await waitFor(() => expect(mocks.saveConnector).toHaveBeenCalledWith("umls", "umls-secret-key-123"));
      await user.click(await screen.findByRole("button", { name: "继续" }));
      await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
      // The same conversation, on the line the run was on, as one turn.
      expect(mocks.dispatch).toHaveBeenCalledWith("session-a", expect.stringContaining("UMLS"), expect.stringMatching(/^web-/), "answer");
      // The strip is about the last turn; the follow-up is a new one, so it goes away.
      await waitFor(() => expect(document.querySelector("[data-connector-need]")).toBeNull());
      expect(document.body.textContent).not.toContain("umls-secret-key-123");
    });

    it("is not shown for a conversation whose run left nothing out, and asks the server nothing then", async () => {
      mocks.listRuns.mockResolvedValue([{ ...finished, connectorNeeds: undefined }]);
      const { frame } = await openTask();
      emit(frame, { type: "evimed.runtime-ui.booted", seq: 3 });
      await waitFor(() => expect(mocks.listRuns).toHaveBeenCalled());
      expect(document.querySelector("[data-connector-need]")).toBeNull();
      expect(mocks.connectors).not.toHaveBeenCalled();
    });
  });

  it("keeps the task when the reader opens a delegated child's view inside the frame", async () => {
    mocks.listRuns.mockResolvedValue([run]);
    const { frame } = await openTask();
    emit(frame, { type: "evimed.runtime-ui.booted", seq: 3 });
    await waitFor(() => expect(mocks.listRuns).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.session", seq: 4, sessionId: "child-1", subagent: true, rootSessionId: "session-a" });
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a");
    // Another task inside the frame is a navigation, and its run is looked up.
    emit(frame, { type: "evimed.runtime-ui.session", seq: 5, sessionId: "session-b" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-b"));
  });

  it("answers the frame's @ menu with the project's parsed sources, by the request's id", async () => {
    mocks.listSources.mockResolvedValue({ items: [{ id: "src_kb1", revision: 1, projectId: "default", createdAt: "", updatedAt: "", deletedAt: null,
      payload: { paths: ["文献/老年房颤.pdf"], status: "complete", outputs: {} } }], nextCursor: null });
    const { frame, sent } = await openTask();
    emit(frame, { type: "evimed.runtime-ui.kb-query", seq: 3, requestId: "r1", query: "房颤" });
    await waitFor(() => expect(sent("kb-result")).toHaveLength(1));
    expect(sent("kb-result")[0]).toMatchObject({ requestId: "r1", ok: true, items: [{ id: "src_kb1", title: "老年房颤.pdf" }], frameId: "frame-a" });
    // A request id the frame could not have minted is not answered.
    emit(frame, { type: "evimed.runtime-ui.kb-query", seq: 4, requestId: "bad id!", query: "x" });
    mocks.listSources.mockRejectedValue(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent("kb-result")).toHaveLength(1);
  });

  it("offers the kernel's conversation search to the shell while the frame is ready, answered by request id", async () => {
    const hook = renderHook(() => useRuntimeSessionSearch());
    expect(hook.result.current.available).toBe(false);
    expect(await hook.result.current.search("阿司匹林")).toEqual({ ok: false, items: [], hasMore: false, error: "search_unavailable" });
    const { frame, sent, unmount } = await openTask();
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    const pending = hook.result.current.search("  阿司匹林  ");
    await waitFor(() => expect(sent("search")).toHaveLength(1));
    const request = sent("search")[0];
    expect(request).toMatchObject({ query: "阿司匹林", frameId: "frame-a" });
    emit(frame, { type: "evimed.runtime-ui.search-result", seq: 3, requestId: "someone-else", ok: true, items: [] });
    emit(frame, { type: "evimed.runtime-ui.search-result", seq: 4, requestId: request.requestId, ok: true, hasMore: true, items: [
      { sessionId: "session-b", title: "老年房颤抗凝", snippet: "……阿司匹林……" }, { sessionId: "bad id!", title: "x", snippet: "y" },
    ] });
    expect(await pending).toEqual({ ok: true, hasMore: true, items: [{ sessionId: "session-b", title: "老年房颤抗凝", snippet: "……阿司匹林……" }] });
    const waiting = hook.result.current.search("华法林");
    unmount();
    expect(await waiting).toMatchObject({ ok: false, error: "search_unavailable" });
    await waitFor(() => expect(hook.result.current.available).toBe(false));
  });

  it("follows a branch of a finished turn as a task of its own, saying where it came from", async () => {
    const { frame } = await openTask();
    emit(frame, { type: "evimed.runtime-ui.session", seq: 3, sessionId: "session-fork", forkedFrom: "session-a" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-fork"));
    expect(screen.getByTestId("state")).toHaveTextContent('{"forkedFrom":"session-a"}');
  });

  it("opens a file the frame names in the shell's reader, and nothing it could spell as an escape", async () => {
    const { frame } = await openTask();
    emit(frame, { type: "evimed.runtime-ui.open-artifact", seq: 3, runId: "run-1", path: "../../etc/passwd" });
    emit(frame, { type: "evimed.runtime-ui.open-artifact", seq: 4, runId: "run-1", path: "/etc/passwd" });
    emit(frame, { type: "evimed.runtime-ui.open-artifact", seq: 5, runId: "run 1", path: "deliverables/a.md" });
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a");
    emit(frame, { type: "evimed.runtime-ui.open-artifact", seq: 6, runId: "run-1", path: "deliverables/evidence/clinical-evidence-report.md", anchor: "CLM-002" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/runs/run-1/files/deliverables/evidence/clinical-evidence-report.md"));
    expect(screen.getByText("run file reader")).toBeInTheDocument();
  });

  // 2026-10-07 plan §2.3: the frame's file card names a run's file; the shell has it copied into this project's knowledge base and says what happened.
  it("has the control plane copy the file the frame names, and says so — and copies nothing the frame could spell as an escape", async () => {
    mocks.saveToKnowledgeBase.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.saveToKnowledgeBase.mockResolvedValue({ path: "knowledge-base/chat/report-1a2b3c4d.md", duplicate: false, sourceId: "src_a" });
    const { frame } = await openTask();
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 3, runId: "run-1", path: "../../etc/passwd" });
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 4, runId: "run-1", path: "/etc/passwd" });
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 5, runId: "run 1", path: "deliverables/a.md" });
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 6, runId: "run-1", path: "a\\b.md" });
    expect(mocks.saveToKnowledgeBase).not.toHaveBeenCalled();
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 7, runId: "run-1", path: "deliverables/evidence/clinical-evidence-report.md", destination: "somewhere" });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("已存入知识库，正在读取"));
    expect(mocks.saveToKnowledgeBase).toHaveBeenCalledTimes(1);
    // Only the path reaches the control plane: the frame's own idea of a destination is never read.
    expect(mocks.saveToKnowledgeBase).toHaveBeenCalledWith("deliverables/evidence/clinical-evidence-report.md");
    // The same file again is not a second document, and a refusal says why.
    mocks.saveToKnowledgeBase.mockResolvedValueOnce({ path: "knowledge-base/chat/report-1a2b3c4d.md", duplicate: true, sourceId: "src_a" });
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 8, runId: "run-1", path: "deliverables/evidence/clinical-evidence-report.md" });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("这份文件已经在知识库里"));
    mocks.saveToKnowledgeBase.mockRejectedValueOnce(new WebApiError("x", { status: 415, code: "source_format_unsupported" }));
    emit(frame, { type: "evimed.runtime-ui.save-to-knowledge-base", seq: 9, runId: "run-1", path: "deliverables/data.sav" });
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining("没能存入知识库：")));
  });
});

describe("opening a task", () => {
  // 2026-09-23 UI plan §2.2 #3: the step list (准备环境 · 启动内核 · 载入界面 ·
  // 打开对话) and its five-second sentences described the machinery, named the
  // kernel, and made every project switch read as a restart.
  it("opens quietly: the conversation's title and one line, whatever the runtime is doing, then simply the conversation", async () => {
    vi.useFakeTimers();
    rememberConversationTitles([{ sessionId: "session-a", title: "ASPREE试验主要结论" } as WebAgentRun]);
    let resolveFrame!: (value: typeof binding) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { resolveFrame = resolve; }));
    // A cold runtime: the control plane reports the environment, then the kernel.
    let reported: Record<string, unknown> = { running: false, provider: "docker", startStage: "environment", startError: null };
    mocks.status.mockImplementation(async () => reported);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const cover = () => screen.getByRole("status");
    const machinery = /准备环境|同步文件|启动内核|载入界面|打开对话|内核|研究环境/;
    expect(cover()).toHaveTextContent("ASPREE试验主要结论");
    expect(cover()).toHaveTextContent("正在打开");
    expect(cover()).not.toHaveTextContent(machinery);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    reported = { running: false, provider: "agentbay", startStage: "sync", startError: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    // Still the same two lines: nothing is added after a while, or per moment.
    expect(cover().querySelectorAll("p")).toHaveLength(2);
    expect(cover()).not.toHaveTextContent(machinery);
    await act(async () => { resolveFrame(binding); await vi.advanceTimersByTimeAsync(0); });
    const frame = view.container.querySelector("iframe")!;
    emit(frame, { type: "evimed.runtime-ui.booted" });
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(cover()).toHaveTextContent("正在打开");
    const navigateCommand = post.mock.calls.find(([data]) => data.type === "evimed.runtime-ui.navigate")![0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: navigateCommand.requestId, ok: true, sessionId: "session-a" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
  });

  it("opens a conversation it has no name for with the one line alone", async () => {
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mount(null, "/app/chat/session-unlisted");
    const cover = await screen.findByRole("status");
    expect(cover).toHaveTextContent(/^正在打开$/);
  });

  it("says a slot cap is a slot cap, with the action that frees one, never as a slow start", async () => {
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: null, startError: null });
    mocks.start.mockRejectedValue(new WebApiError("Too many running runtimes for this user; limit is 2.", { status: 429, code: "runtime_limit_exceeded" }));
    mount(null, "/app/chat/session-a");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("你同时进行的研究已达上限，先结束一个再试。");
    expect(alert).not.toHaveTextContent(/冷启动|90 秒/);
    // A concurrency ceiling: no quota page lifts it, so none is offered, and
    // the run ledger it used to point at is gone. Freeing a slot is done in
    // the conversation that holds it, which the sentence says.
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /额度|用量/ })).toBeNull();
  });

  it("does not fail a retry on a refusal an earlier attempt left on the status", async () => {
    // The status still reports the earlier refusal; this attempt's own start
    // is what answers, and it succeeded.
    mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: null,
      startError: { code: "runtime_limit_exceeded", status: 429, at: new Date().toISOString() } });
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits out a slow start that keeps moving, and gives up only on a moment that stalls", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolveFrame!: (value: typeof binding) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { resolveFrame = resolve; }));
    let reported: Record<string, unknown> = { running: false, provider: "docker", startStage: "environment", startError: null };
    mocks.status.mockImplementation(async () => reported);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // A cold runtime past the old single 30 s deadline is still a start.
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    // A new moment restarts the count. (Each advance is its own act scope: a
    // state update inside one lands only when the scope exits.)
    reported = { running: false, provider: "docker", startStage: "kernel", startError: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { resolveFrame(binding); await vi.advanceTimersByTimeAsync(0); });
    const frame = view.container.querySelector("iframe")!;
    // The download: the bridge booting is progress and restarts the count.
    emit(frame, { type: "evimed.runtime-ui.booted" });
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    emit(frame, { type: "evimed.runtime-ui.booted", seq: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing more for a whole minute: that moment has stalled.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("打开超时，请重试");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    // The reader gets one sentence; which moment stalled goes to the console.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"interface"'), { projectId: "default" });
    view.unmount();
  });

  it("gives up on a runtime that does not start within its own allowance, in one sentence", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.start.mockImplementation(() => new Promise(() => {}));
    mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: "kernel", startError: null });
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(89_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("打开超时，请重试");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/内核|90 秒/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"kernel"'), { projectId: "default" });
    view.unmount();
  });

  it("resumes the conversation the account last had open, without walking the ledger", async () => {
    mocks.me.mockResolvedValue({ lastSessionId: "session-last" });
    mocks.listRuns.mockResolvedValue([{ sessionId: "session-from-ledger" }]);
    mocks.warm.mockReset();
    mount();
    // The runtime starts while the lookup decides which task to open: the
    // frame, mounted and told to open nothing yet, starts it itself — as the
    // opening, which is the start that may make room — so no warm-up races it.
    expect(mocks.start).toHaveBeenCalledWith({ projectId: "default", opening: true });
    expect(mocks.warm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-last"));
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });

  it("starts the project's runtime from any page, so the conversation is warm when it is opened", async () => {
    // 2026-09-22: a cold start is six to eight seconds, and a researcher who
    // lands on 知识库 or 科研工具 first used to pay it on reaching the chat.
    mocks.warm.mockReset();
    mount(null, "/app/files");
    expect(screen.getByText("knowledge base")).toBeInTheDocument();
    expect(mocks.warm).toHaveBeenCalledTimes(1);
  });

  it("walks the ledger when the account's answer has no usable last conversation", async () => {
    mocks.me.mockResolvedValue({ lastSessionId: "not a session id!" });
    mocks.listRuns.mockResolvedValue([{ sessionId: "session-from-ledger" }]);
    mount();
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-from-ledger"));
  });
});

it("a new valid navigation recovers automatically after an unknown-session error", async () => {
  const nextBinding = { ...binding, frameId: "frame-b", frameUrl: "https://host.example:8443/__evimed/f/frame-b/" };
  mocks.create.mockResolvedValueOnce(binding).mockResolvedValueOnce(nextBinding);
  const { container } = mount(null, "/app/chat/session-missing");
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const oldFrame = container.querySelector("iframe")!;
  const sent = vi.spyOn(oldFrame.contentWindow!, "postMessage");
  emit(oldFrame, { type: "evimed.runtime-ui.ready" });
  await waitFor(() => expect(sent).toHaveBeenCalled());
  emit(oldFrame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: sent.mock.calls[0][0].requestId, ok: false });
  expect(await screen.findByRole("alert")).toHaveTextContent("这条对话暂时无法打开");
  await userEvent.click(screen.getByRole("button", { name: "Open B" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(container.querySelector("iframe")?.src).toBe(nextBinding.frameUrl));
  const nextFrame = container.querySelector("iframe")!;
  const nextSent = vi.spyOn(nextFrame.contentWindow!, "postMessage");
  emit(nextFrame, { type: "evimed.runtime-ui.ready", frameId: "frame-b" });
  await waitFor(() => expect(nextSent).toHaveBeenCalled());
  const command = nextSent.mock.calls[0][0];
  expect(command.intent).toMatchObject({ kind: "open", sessionId: "session-b" });
  emit(nextFrame, { type: "evimed.runtime-ui.ack", frameId: "frame-b", seq: 2, requestId: command.requestId, ok: true, sessionId: "session-b" });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

/**
 * WP1: the conversation surface is mounted once, by the shell, and leaving it
 * hides it. Production rebuilt it seven times in twenty-five minutes because
 * it sat inside the route, and every rebuild is a container document, a
 * websocket and a kernel handshake (2026-09-20 walk, fact 1).
 */
describe("the conversation surface outlives the route", () => {
  /** An open conversation, and everything the test needs to watch it. */
  async function openConversation(path = "/app/chat/session-a") {
    const view = mount(null, path);
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    const command = post.mock.calls[0][0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: "session-a" });
    return { ...view, frame, post };
  }

  it("keeps the same document and binding across a visit to another page", async () => {
    const { container, frame } = await openConversation();
    await userEvent.click(screen.getByText("Knowledge"));
    await waitFor(() => expect(screen.getByText("knowledge base")).toBeInTheDocument());
    // Hidden, not unmounted: same node, no release, no second binding.
    expect(container.querySelector("iframe")).toBe(frame);
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "hidden");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a"));
    expect(container.querySelector("iframe")).toBe(frame);
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "visible");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  // `/app/chat` and `/app/chat/:id` were two route objects, so the redirect
  // the surface performs on arrival cost a remount of its own (review B §C 3).
  it("opens the resumed conversation on the same route, without a second binding", async () => {
    mocks.me.mockResolvedValue({ lastSessionId: "session-last" });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-last"));
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  // One frame per project, two at most — the same ceiling a person has on
  // running runtimes (`OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER`).
  it("keeps one surface per project, at most two, and releases the least recently used", async () => {
    const { useProjectStore } = await import("@/lib/projects");
    const bindings = ["frame-a", "frame-b", "frame-c"].map((frameId) => ({
      ...binding, frameId, frameUrl: `https://host.example:8443/__evimed/f/${frameId}/`,
    }));
    mocks.create.mockReset();
    for (const value of bindings) mocks.create.mockResolvedValueOnce(value);
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    const first = container.querySelector("iframe")!;

    await act(async () => { useProjectStore.setState({ currentId: "project-b" }); });
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(2));
    // The first project's surface is still there, holding its binding.
    expect(container.querySelectorAll("iframe")[0]).toBe(first);
    expect(mocks.release).not.toHaveBeenCalled();

    await act(async () => { useProjectStore.setState({ currentId: "project-c" }); });
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith("frame-a"));
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(2));
    expect(container.querySelector("iframe")).not.toBe(first);
    useProjectStore.setState({ currentId: "default" });
  });

  // 2026-09-23 UI plan §2.2: the third project's runtime used to be started
  // while the surface it displaced was still connected, so the control plane
  // refused it (429) and the retry came seven seconds later.
  describe("a project beyond the two kept", () => {
    afterEach(async () => {
      const { useProjectStore } = await import("@/lib/projects");
      useProjectStore.setState({ currentId: "default" });
    });

    /** Two projects' surfaces kept — the default project's, then project B's, which is on screen. */
    async function twoSurfaces() {
      const { useProjectStore } = await import("@/lib/projects");
      mocks.create.mockReset();
      mocks.create.mockImplementation(async (projectId: string) => ({
        ...binding, frameId: `frame-${projectId}`, frameUrl: `https://host.example:8443/__evimed/f/frame-${projectId}/`,
      }));
      const view = mount(null, "/app/chat/session-a");
      await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(1));
      // A switch, and the admission that follows it a promise later, inside act.
      const switchTo = async (projectId: string) => {
        await act(async () => {
          useProjectStore.setState({ currentId: projectId });
          await settle();
        });
      };
      await switchTo("project-b");
      await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(2));
      return { ...view, switchTo };
    }
    /** Lets promise chains and the timers they set run out (real timers only). */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    /** The cover the host draws while no surface of the current project exists yet. */
    const hostCover = (container: HTMLElement) => container.querySelector("[data-session-surface] > [data-frame-skeleton]");

    it("lets the least recently used surface go and waits for its release before the next project's runtime starts", async () => {
      const { container, switchTo } = await twoSurfaces();
      let confirm!: () => void;
      mocks.release.mockImplementation(() => new Promise<void>((resolve) => { confirm = resolve; }));
      await switchTo("project-c");
      await waitFor(() => expect(mocks.release).toHaveBeenCalledWith("frame-default"));
      // Released, not yet confirmed: nothing of project C has started, and the
      // conversation area says it is opening.
      expect(container.querySelectorAll("iframe")).toHaveLength(1);
      expect(mocks.create).not.toHaveBeenCalledWith("project-c");
      expect(mocks.start).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-c" }));
      expect(hostCover(container)).toHaveTextContent("正在打开");

      await act(async () => { confirm(); await settle(); });
      await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ projectId: "project-c", opening: true }));
      expect(mocks.create).toHaveBeenCalledWith("project-c");
      const startedC = mocks.start.mock.calls.findIndex(([options]) => options?.projectId === "project-c");
      expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[startedC]);
      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(2));
      expect(hostCover(container)).toBeNull();
    });

    it("does not wait on a release that never answers for longer than its bound", async () => {
      await twoSurfaces();
      mocks.release.mockImplementation(() => new Promise<void>(() => {}));
      // Fake from here, so the bound can be walked up to; `switchTo` waits on
      // a real timer and cannot be used past this line.
      vi.useFakeTimers();
      const { useProjectStore } = await import("@/lib/projects");
      await act(async () => { useProjectStore.setState({ currentId: "project-c" }); await vi.advanceTimersByTimeAsync(0); });
      expect(mocks.release).toHaveBeenCalledWith("frame-default");
      await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
      expect(mocks.create).not.toHaveBeenCalledWith("project-c");
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(mocks.create).toHaveBeenCalledWith("project-c");
      expect(mocks.start).toHaveBeenCalledWith({ projectId: "project-c", opening: true });

      // Waited on once: the next switch — back to a project it keeps, off the
      // conversation — is admitted at once rather than behind it again.
      await act(async () => { screen.getByText("Knowledge").click(); await vi.advanceTimersByTimeAsync(0); });
      mocks.warm.mockReset();
      await act(async () => { useProjectStore.setState({ currentId: "project-b" }); await vi.advanceTimersByTimeAsync(0); });
      expect(mocks.warm).toHaveBeenCalledWith("project-b", { afterRelease: false });
    });

    it("switching project off the conversation also lets a surface go first, then warms the new project past an earlier refusal", async () => {
      const { container, switchTo } = await twoSurfaces();
      await userEvent.click(screen.getByText("Knowledge"));
      await waitFor(() => expect(screen.getByText("knowledge base")).toBeInTheDocument());
      mocks.warm.mockReset();
      await switchTo("project-c");
      await waitFor(() => expect(mocks.warm).toHaveBeenCalledWith("project-c", { afterRelease: true }));
      expect(mocks.release).toHaveBeenCalledWith("frame-default");
      expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.warm.mock.invocationCallOrder[0]);
      // Off the conversation no frame is built for it; the one kept is B's.
      expect(container.querySelectorAll("iframe")).toHaveLength(1);
      expect(mocks.create).not.toHaveBeenCalledWith("project-c");
    });

    it("lets go of the surface shown longest ago, which is not always the first one mounted", async () => {
      const { container, switchTo } = await twoSurfaces();
      await switchTo("default");
      await waitFor(() => expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "visible"));
      await switchTo("project-c");
      await waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
      expect(mocks.release).toHaveBeenCalledWith("frame-project-b");
      await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("project-c"));
    });

    it("goes back to a project it still keeps at once: nothing let go, and no frame moved in the document (a moved iframe reloads)", async () => {
      const { container, switchTo } = await twoSurfaces();
      const kept = [...container.querySelectorAll("iframe")];
      await switchTo("default");
      await waitFor(() => expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "visible"));
      expect([...container.querySelectorAll("iframe")]).toEqual(kept);
      expect(mocks.release).not.toHaveBeenCalled();
      expect(hostCover(container)).toBeNull();
    });
  });

  // Switching conversation inside a live runtime is not a cold start, and
  // saying so was the whole of 「每次点会话都要冷启动」.
  it("shows no opening cover when only the conversation changes", async () => {
    const { container, frame, post } = await openConversation();
    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.click(screen.getByText("Open B"));
    await waitFor(() => expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(2));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("正在打开")).toBeNull();
    expect(container.querySelector("iframe")).toBe(frame);
  });
});

describe("which research tool a conversation runs", () => {
  it("tells the frame what the control plane holds, and binds what the frame picks", async () => {
    mocks.listSessions.mockResolvedValue([{ sessionId: "session-a", mode: "specialist", agentId: "adr-analysis", agentVersion: "1.0.0" }]);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.booted" });
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
    const command = post.mock.calls.map(call => call[0]).find(data => data.type === "evimed.runtime-ui.navigate");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: command.requestId, ok: true, sessionId: "session-a" });
    // The bound tool reaches the frame, which is what draws the chip.
    await waitFor(() => expect(post.mock.calls.map(call => call[0]).some(data =>
      data.type === "evimed.runtime-ui.capability" && data.capabilityId === "adr-analysis")).toBe(true));

    // The frame picking a different tool binds a fresh conversation, because a
    // binding cannot change once its session has run — and the typed question
    // travels with it.
    emit(frame, { type: "evimed.runtime-ui.bind-capability", seq: 4, capabilityId: "adr-analysis", sessionId: "session-a", draft: "老年房颤该不该抗凝？" });
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalled());
    // A tool this deployment does not offer is refused rather than bound.
    mocks.putSession.mockClear();
    emit(frame, { type: "evimed.runtime-ui.bind-capability", seq: 5, capabilityId: "not-a-tool", sessionId: "session-a" });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.putSession).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("循证 GEO in the conversation", () => {
  const project = {
    id: "geo_1", projectId: "default", name: "玛仕度肽注射液", product: { brandName: "信尔美", genericName: "玛仕度肽注射液" },
    coverageDays: 90, engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"], status: "active", steps: {},
    headline: { gvi: { value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "not_measurable", dataType: "measured", target: null, trend: [] },
      mention: { value: null, numerator: null, denominator: null, ciLow: null, ciHigh: null, status: "not_measurable", dataType: "measured" } },
    alert: { wrongOurs: 0, severe: 0, safety: 0 }, updatedAt: "2026-09-25T00:00:00Z",
  };

  async function openGeoConversation(capability = "geo-insight") {
    geo.listGeoProjects.mockReset(); geo.listGeoProjects.mockResolvedValue([project]);
    geo.patchGeoProject.mockReset(); geo.patchGeoProject.mockResolvedValue({});
    mocks.listSessions.mockResolvedValue([{ sessionId: "session-a", mode: "specialist", agentId: capability, agentVersion: "1.0.0" }]);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.booted" });
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
    const command = post.mock.calls.map(call => call[0]).find(data => data.type === "evimed.runtime-ui.navigate");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: command.requestId, ok: true, sessionId: "session-a" });
    const geoPosts = () => post.mock.calls.map(call => call[0]).filter(data => data.type === "evimed.runtime-ui.geo");
    return { view, frame, post, geoPosts };
  }

  it("tells the chip the project's coverage window, engines and single-step starters", async () => {
    const { view, geoPosts } = await openGeoConversation("geo-strategy");
    await waitFor(() => expect(geoPosts()).toHaveLength(1));
    const [options] = geoPosts();
    expect(options).toMatchObject({ sessionId: "session-a", controls: true, coverageDays: 90, coverageOptions: [30, 60, 90, 180],
      engines: ["doubao", "qianwen", "deepseek", "yuanbao", "kimi"] });
    expect(options.offered.map((engine: { name: string }) => engine.name)).toEqual(["豆包", "千问", "DeepSeek", "元宝", "Kimi"]);
    expect(options.starters.map((starter: { label: string }) => starter.label))
      .toEqual(["完整方案", "AI 怎么说我的产品", "信源分析与预期", "优化已有稿件", "去 AI 味", "持续监测"]);
    expect(options.starters[0].draft).toMatch(/产品是信尔美。$/);
    view.unmount();
  });

  it("writes a changed option to the project and tells the chip what the project now holds", async () => {
    const { view, frame, geoPosts } = await openGeoConversation();
    await waitFor(() => expect(geoPosts()).toHaveLength(1));
    emit(frame, { type: "evimed.runtime-ui.geo-options", seq: 4, sessionId: "session-a", coverageDays: 180 });
    await waitFor(() => expect(geo.patchGeoProject).toHaveBeenCalledWith("geo_1", { coverageDays: 180 }));
    await waitFor(() => expect(geoPosts().at(-1)).toMatchObject({ coverageDays: 180 }));
    emit(frame, { type: "evimed.runtime-ui.geo-options", seq: 5, sessionId: "session-a", engines: ["kimi", "doubao", "not-an-engine"] });
    await waitFor(() => expect(geo.patchGeoProject).toHaveBeenLastCalledWith("geo_1", { engines: ["kimi", "doubao"] }));
    // A refused write puts the project's value back in the chip.
    geo.patchGeoProject.mockRejectedValueOnce(new WebApiError("no", { status: 503, code: "geo_unavailable" }));
    emit(frame, { type: "evimed.runtime-ui.geo-options", seq: 6, sessionId: "session-a", coverageDays: 30 });
    await waitFor(() => expect(geoPosts().at(-1)).toMatchObject({ coverageDays: 180 }));
    // Another conversation's change is not this project's to write.
    geo.patchGeoProject.mockClear();
    emit(frame, { type: "evimed.runtime-ui.geo-options", seq: 7, sessionId: "session-z", coverageDays: 60 });
    await act(async () => { await Promise.resolve(); });
    expect(geo.patchGeoProject).not.toHaveBeenCalled();
    view.unmount();
  });

  it("sends a conversation that is not a GEO one no GEO options", async () => {
    const { view, post, geoPosts } = await openGeoConversation("adr-analysis");
    await waitFor(() => expect(post.mock.calls.map(call => call[0]).some(data => data.type === "evimed.runtime-ui.capability")).toBe(true));
    expect(geoPosts()).toHaveLength(0);
    expect(geo.listGeoProjects).not.toHaveBeenCalled();
    view.unmount();
  });

  it("opens this project's GEO tab when the frame asks for one", async () => {
    const { view, frame } = await openGeoConversation();
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 4, destination: "geo", tab: "diagnosis" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/geo/geo_1/diagnosis"));
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 5, destination: "geo", tab: "../../account" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/geo\/geo_1$/));
    view.unmount();
  });

  it("opens 虚拟临床研究 when the frame asks for it, instead of dropping the destination", async () => {
    const { view, frame } = await openGeoConversation();
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 4, destination: "virtual-research" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/virtual-research$/));
    view.unmount();
  });
});

describe("a scheduled task's card in the conversation", () => {
  // `schedule_task` and `update_task` draw a card whose 「打开」 asks the shell for the `autopilot` destination, carrying the task's id.
  async function openConversationWithCard() {
    const view = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    return { view, frame };
  }

  it("opens that task's page, and the list when the frame names no task or one that is not an id", async () => {
    const { view, frame } = await openConversationWithCard();
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 4, destination: "autopilot", taskId: "agenda-0123abcd-0000-4000-8000-000000000001" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/autopilot\/agenda-0123abcd-0000-4000-8000-000000000001$/));
    await userEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a"));
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 5, destination: "autopilot", taskId: "../../account" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/autopilot$/));
    await userEvent.click(screen.getByText("Back"));
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 6, destination: "autopilot" });
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/autopilot$/));
    view.unmount();
  });

  it("leaves the destination `runs` alone: the ledger page it named is gone, and nothing sends it", async () => {
    const { view, frame } = await openConversationWithCard();
    emit(frame, { type: "evimed.runtime-ui.shell-navigate", seq: 4, destination: "runs" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a");
    view.unmount();
  });
});

describe("虚拟临床研究 in the conversation", () => {
  const requested = (...steps: string[]) => Object.fromEntries(
    ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"].map(step => [step, { status: "none", requested: steps.includes(step) }]));
  const lead = ["read", "write", "run", "export", "manage_members", "manage_study", "manage_data", "review_any", "contact_patients", "read_patient_level"];
  const study = (over: Record<string, unknown> = {}) => ({
    id: "std_1", projectId: "default", name: "EV-201", intendedUse: "exploratory", abilities: lead,
    steps: requested("definition", "evidence", "population", "patients", "comparator", "trial", "matching"), ...over,
  });

  /** `held`: what the project's study reads as; `null` for a project that is no study (the module answers 404). */
  async function openVcrConversation(capability = "vcr-protocol", held: Record<string, unknown> | null = study()) {
    vcr.getVcrHome.mockReset(); vcr.getVcrHome.mockResolvedValue({ studies: [] });
    vcr.getVcrStudyOfProject.mockReset();
    if (held) vcr.getVcrStudyOfProject.mockResolvedValue(held);
    else vcr.getVcrStudyOfProject.mockRejectedValue(new WebApiError("no", { status: 404, code: "vcr_study_not_found" }));
    vcr.patchVcrStudy.mockReset(); vcr.patchVcrStudy.mockResolvedValue({});
    mocks.listSessions.mockResolvedValue([{ sessionId: "session-a", mode: "specialist", agentId: capability, agentVersion: "1.0.0" }]);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.booted" });
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
    const command = post.mock.calls.map(call => call[0]).find(data => data.type === "evimed.runtime-ui.navigate");
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: command.requestId, ok: true, sessionId: "session-a" });
    const vcrPosts = () => post.mock.calls.map(call => call[0]).filter(data => data.type === "evimed.runtime-ui.vcr");
    return { view, frame, post, vcrPosts };
  }

  it("tells the chip where the study starts, what it is for, and the six starting points of a new study", async () => {
    const { view, vcrPosts } = await openVcrConversation("vcr-analysis");
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    const [options] = vcrPosts();
    expect(options).toMatchObject({ sessionId: "session-a", controls: true, canSetUse: true, start: "auto", intendedUse: "exploratory" });
    expect(options.startOptions.map((choice: { label: string }) => choice.label)).toEqual(["自动", "队列", "患者", "对照", "试验"]);
    expect(options.useOptions.map((choice: { label: string }) => choice.label)).toEqual(["探索", "研究设计支持", "指定研究分析", "申报准备"]);
    expect(options.starters.map((starter: { label: string }) => starter.label))
      .toEqual(["估算样本量", "生成合成人群", "外部对照可行性", "模拟试验方案", "找先例与参数", "匹配患者"]);
    view.unmount();
  });

  it("reads a study that was created from one action card as starting there", async () => {
    const { view, vcrPosts } = await openVcrConversation("vcr-protocol", study({ steps: requested("comparator") }));
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    expect(vcrPosts()[0]).toMatchObject({ start: "comparator" });
    view.unmount();
  });

  it("writes a changed option to the study and tells the chip what the study then holds", async () => {
    const { view, frame, vcrPosts } = await openVcrConversation();
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    vcr.getVcrStudyOfProject.mockResolvedValue(study({ steps: requested("trial") }));
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 4, sessionId: "session-a", start: "trial" });
    await waitFor(() => expect(vcr.patchVcrStudy).toHaveBeenCalledWith("std_1", { action: "trial" }));
    await waitFor(() => expect(vcrPosts().at(-1)).toMatchObject({ start: "trial" }));

    vcr.getVcrStudyOfProject.mockResolvedValue(study({ steps: requested("trial"), intendedUse: "design_support" }));
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 5, sessionId: "session-a", intendedUse: "design_support" });
    await waitFor(() => expect(vcr.patchVcrStudy).toHaveBeenLastCalledWith("std_1", { intendedUse: "design_support" }));
    await waitFor(() => expect(vcrPosts().at(-1)).toMatchObject({ intendedUse: "design_support", start: "trial" }));

    // A value that is not one of the choices is never sent.
    vcr.patchVcrStudy.mockClear();
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 6, sessionId: "session-a", start: "everything", intendedUse: "approved" });
    await act(async () => { await Promise.resolve(); });
    expect(vcr.patchVcrStudy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("puts the study's own value back in the chip when the write is refused", async () => {
    const { view, frame, vcrPosts } = await openVcrConversation();
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    vcr.patchVcrStudy.mockRejectedValueOnce(new WebApiError("no", { status: 403, code: "vcr_forbidden" }));
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 4, sessionId: "session-a", intendedUse: "submission_preparation" });
    await waitFor(() => expect(vcrPosts().at(-1)).toMatchObject({ intendedUse: "exploratory" }));
    // Another conversation's change is not this study's to write.
    vcr.patchVcrStudy.mockClear();
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 5, sessionId: "session-z", start: "cohort" });
    await act(async () => { await Promise.resolve(); });
    expect(vcr.patchVcrStudy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("offers a reader only the controls their roles allow, and writes nothing else", async () => {
    const { view, frame, vcrPosts } = await openVcrConversation("vcr-protocol", study({ abilities: ["read", "write"] }));
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    expect(vcrPosts()[0]).toMatchObject({ controls: true, canSetUse: false });
    expect(vcrPosts()[0].startOptions).toHaveLength(5);
    emit(frame, { type: "evimed.runtime-ui.vcr-options", seq: 4, sessionId: "session-a", intendedUse: "design_support" });
    await act(async () => { await Promise.resolve(); });
    expect(vcr.patchVcrStudy).not.toHaveBeenCalled();
    view.unmount();

    const viewer = await openVcrConversation("vcr-protocol", study({ abilities: ["read"] }));
    await waitFor(() => expect(viewer.vcrPosts()).toHaveLength(1));
    expect(viewer.vcrPosts()[0]).toMatchObject({ controls: true, canSetUse: false, startOptions: [] });
    viewer.view.unmount();
  });

  it("gives a project that is not a study the starters alone, with nothing to write options to", async () => {
    const { view, vcrPosts } = await openVcrConversation("vcr-protocol", null);
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    expect(vcrPosts()[0]).toMatchObject({ controls: false, startOptions: [] });
    expect(vcrPosts()[0].starters).toHaveLength(6);
    expect(vcr.patchVcrStudy).not.toHaveBeenCalled();
    view.unmount();
  });

  it("finds the study that 「新建研究」 has just made — a draft the home list leaves out — by its project, so the six starters and the chip's options are there", async () => {
    // The study a conversation belongs to is read by the project; the list (which has no draft in it) is never asked.
    const { view, vcrPosts } = await openVcrConversation("vcr-protocol", study({ status: "draft", name: "未命名研究" }));
    await waitFor(() => expect(vcrPosts()).toHaveLength(1));
    expect(vcr.getVcrStudyOfProject).toHaveBeenCalledWith("default");
    expect(vcr.getVcrHome).not.toHaveBeenCalled();
    expect(vcrPosts()[0]).toMatchObject({ sessionId: "session-a", controls: true, canSetUse: true, start: "auto", intendedUse: "exploratory" });
    expect(vcrPosts()[0].starters.map((starter: { label: string }) => starter.label))
      .toEqual(["估算样本量", "生成合成人群", "外部对照可行性", "模拟试验方案", "找先例与参数", "匹配患者"]);
    view.unmount();
  });

  it("sends a conversation that is not a 虚拟临床研究 one no options, and asks the module nothing", async () => {
    const { view, post, vcrPosts } = await openVcrConversation("adr-analysis");
    await waitFor(() => expect(post.mock.calls.map(call => call[0]).some(data => data.type === "evimed.runtime-ui.capability")).toBe(true));
    expect(vcrPosts()).toHaveLength(0);
    expect(vcr.getVcrStudyOfProject).not.toHaveBeenCalled();
    view.unmount();
  });
});

// 2026-10-08 (定时任务): the task's page is the other place the resident frame is shown. The page draws an empty pane and asks for the
// frame over it; the shell's host places the same iframe there. These are the properties that make that safe: the document is never
// reloaded, the address is never rewritten under the page, and going back to a chat does not leave the researcher in an execution.
describe("the frame over a task's pane", () => {
  const navigations = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.map(([data]) => data as { type: string; requestId: string; intent: { kind: string; sessionId: string } }).filter(data => data.type === "evimed.runtime-ui.navigate");
  async function openedChat() {
    const view = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: navigations(post)[0].requestId, ok: true, sessionId: "session-a" });
    return { ...view, frame, post };
  }
  beforeEach(() => { taskPane.sessionId = "session-exec"; taskPane.rect = { left: 300, top: 60, width: 700, height: 500 }; });

  it("places the one resident frame over the pane, and opens the execution's conversation without writing it into the address", async () => {
    const { container, frame, post } = await openedChat();
    await userEvent.click(screen.getByText("Task"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/autopilot/agenda-one"));
    // The same document, in the same place in the tree, at the pane's rectangle; the host takes no room and no clicks of its own.
    expect(container.querySelector("iframe")).toBe(frame);
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "task");
    await waitFor(() => expect(container.querySelector("[data-task-frame]")).not.toBeNull());
    const box = container.querySelector<HTMLElement>("[data-task-frame]")!;
    expect(box.contains(frame)).toBe(true);
    await waitFor(() => expect(box).toHaveStyle({ left: "300px", top: "60px", width: "700px", height: "500px" }));
    expect(box).not.toHaveClass("hidden");
    expect(container.querySelector("[data-session-surface]")).toHaveClass("pointer-events-none");
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.release).not.toHaveBeenCalled();
    // The frame is asked for that execution's conversation, and the acknowledgement leaves the task's address where it is.
    await waitFor(() => expect(navigations(post)).toHaveLength(2));
    const request = navigations(post)[1];
    expect(request.intent).toEqual({ kind: "open", sessionId: "session-exec" });
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: request.requestId, ok: true, sessionId: "session-exec" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("path")).toHaveTextContent("/app/autopilot/agenda-one");
    expect(screen.getByTestId("state")).toHaveTextContent("null");
  });

  it("follows the pane when it moves or changes size, with the same document", async () => {
    const { container, frame } = await openedChat();
    await userEvent.click(screen.getByText("Task"));
    await waitFor(() => expect(container.querySelector("[data-task-frame]")).not.toBeNull());
    const box = container.querySelector<HTMLElement>("[data-task-frame]")!;
    await waitFor(() => expect(box).toHaveStyle({ left: "300px", width: "700px" }));
    // The sidebar closes: the pane is wider and starts further left.
    taskPane.rect = { left: 40, top: 100, width: 960, height: 460 };
    act(() => { window.dispatchEvent(new Event("resize")); });
    await waitFor(() => expect(box).toHaveStyle({ left: "40px", top: "100px", width: "960px", height: "460px" }));
    expect(container.querySelector("iframe")).toBe(frame); expect(mocks.create).toHaveBeenCalledTimes(1);
    // A scroll of anything the pane sits in is heard too.
    taskPane.rect = { left: 40, top: 20, width: 960, height: 460 };
    act(() => { document.dispatchEvent(new Event("scroll")); });
    await waitFor(() => expect(box).toHaveStyle({ top: "20px" }));
  });

  it("hides the frame, without unmounting it, when the page leaves, and is the chat surface again on a chat", async () => {
    const { container, frame, post } = await openedChat();
    await userEvent.click(screen.getByText("Task"));
    await waitFor(() => expect(navigations(post)).toHaveLength(2));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: navigations(post)[1].requestId, ok: true, sessionId: "session-exec" });
    await waitFor(() => expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "task"));
    await userEvent.click(screen.getByText("Knowledge"));
    await waitFor(() => expect(screen.getByText("knowledge base")).toBeInTheDocument());
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "hidden");
    expect(container.querySelector("iframe")).toBe(frame);
    await userEvent.click(screen.getByText("Back"));
    await userEvent.click(screen.getByText("Back"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-a"));
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "visible");
    expect(container.querySelector("iframe")).toBe(frame); expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.release).not.toHaveBeenCalled();
    // The chat's own conversation is asked for again: the frame is not left on the execution.
    await waitFor(() => expect(navigations(post).at(-1)!.intent).toEqual({ kind: "open", sessionId: "session-a" }));
  });

  it("is not shown at all while the page asks for no conversation: an execution still running in a bounded runtime", async () => {
    taskPane.sessionId = null;
    const { container } = mount(null, "/app/autopilot/agenda-one");
    await waitFor(() => expect(screen.getByTestId("task-pane")).toBeInTheDocument());
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "hidden");
    expect(container.querySelector("iframe")).toBeNull(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("opens the frame when the page first asks for it, on a task page that was the first page of the visit", async () => {
    const { container } = mount(null, "/app/autopilot/agenda-one");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(navigations(post)).toHaveLength(1));
    expect(navigations(post)[0].intent).toEqual({ kind: "open", sessionId: "session-exec" });
    expect(container.querySelector("[data-session-surface]")).toHaveAttribute("data-session-surface", "task");
  });

  // A bare /app/chat resumes what the researcher last worked in. That is the ledger's researcher runs, which an execution never is.
  it("goes back to the researcher's last conversation, not the execution, when 新对话 resumes one", async () => {
    mocks.me.mockResolvedValue({ lastSessionId: "session-last" });
    const { container, frame, post } = await openedChat();
    await userEvent.click(screen.getByText("Task"));
    await waitFor(() => expect(navigations(post)).toHaveLength(2));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: navigations(post)[1].requestId, ok: true, sessionId: "session-exec" });
    await userEvent.click(screen.getByText("Bare chat"));
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-last"));
    await waitFor(() => expect(navigations(post).at(-1)!.intent).toEqual({ kind: "open", sessionId: "session-last" }));
    expect(container.querySelector("iframe")).toBe(frame); expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("is not held suspended by a chat that was still looking for its conversation when the researcher left it", async () => {
    let finish!: (value: unknown) => void;
    mocks.me.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { container } = mount(null, "/app/chat");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await userEvent.click(screen.getByText("Task"));
    await waitFor(() => expect(navigations(post)).toHaveLength(1));
    expect(navigations(post)[0].intent).toEqual({ kind: "open", sessionId: "session-exec" });
    finish({});
  });
});
