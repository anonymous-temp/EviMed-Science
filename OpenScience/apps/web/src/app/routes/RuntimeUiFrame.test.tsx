import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFrameHost } from "../layout/SessionFrameHost";
import { SessionRoute } from "./SessionRoute";
import { WebApiError } from "@/lib/apiClient";
import { apply as applyNativeBridge } from "../../../../../packages/harness-port/src/runtimeUiBridge.mjs";
import { createFrameKit } from "../../../../../packages/harness-port/src/runtimeUiKit.mjs";
import { FRAME_VOCABULARY } from "../../../../../packages/harness-port/src/runtimeUiFrame.mjs";
import { apply as applyFrameTheme } from "../../../../../packages/harness-port/src/runtimeUiTheme.mjs";
import { useUiStore } from "@/lib/store";
import { useRuntimeSessionSearch } from "@/lib/runtimeUiBridge";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ create: vi.fn(), renew: vi.fn(), release: vi.fn(), listRuns: vi.fn(), subscribe: vi.fn(), listSources: vi.fn(), me: vi.fn(), warm: vi.fn(), start: vi.fn(), status: vi.fn(), projectId: "default", profile: { uiOrigin: "https://host.example:8443" } }));
vi.mock("@/lib/sourceClient", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/sourceClient")>()), listSources: mocks.listSources }));
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
}));
const binding = { frameId: "frame-a", frameUrl: "https://host.example:8443/__evimed/f/frame-a/", expiresAt: Date.now() + 600_000, renewalToken: "renew-frame-a" };
function PathProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return <div><span data-testid="path">{location.pathname}</span><span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
    <button onClick={() => navigate("/app/chat/session-b")}>Open B</button>
    <button onClick={() => navigate("/app/files")}>Knowledge</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </div>;
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
    <Route path="/app/files" element={<div>knowledge base</div>} />
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
    const create = vi.fn(); const draft = vi.fn();
    const parent = { postMessage: (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: mocks.profile.uiOrigin, data }));
    } };
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(data => listener({ data, origin, source: parent }));
    await act(async () => {
      applyNativeBridge({
        loader: { await: async () => {} },
        connection: { generation: { getSnapshot: () => generation, subscribe: (fn: () => void) => { generationChanged = fn; return () => {}; } } },
        sessions: { refresh, create, open: vi.fn(), scope: () => ({}),
          list: { getSnapshot: () => ({ current: "session-a" }), subscribe: () => () => {} } },
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
    await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(1);
    expect(create).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled();
    dispose();
  });

  it("creates an immutable frame and waits for verified native readiness rather than iframe load", async () => {
    const { container, unmount } = mount();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    expect(mocks.create).toHaveBeenCalledWith("default"); expect(frame.src).toBe(binding.frameUrl);
    act(() => frame.dispatchEvent(new Event("load")));
    // The runtime was already running, so this opening is a document load and
    // gets the neutral skeleton, not the runtime's four moments (WP1).
    await waitFor(() => expect(screen.getByText("正在打开对话…")).toBeInTheDocument());
    expect(screen.queryByText("✓ 启动内核")).toBeNull();
    emit(frame, { type: "evimed.runtime-ui.ready" }, "https://evil.example");
    emit(frame, { type: "evimed.runtime-ui.ready" }, mocks.profile.uiOrigin, window);
    emit(frame, { type: "evimed.runtime-ui.ready", frameId: "frame-b" });
    expect(screen.getByText("正在打开对话…")).toBeInTheDocument();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByText("正在打开对话…")).toBeInTheDocument();
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
    useUiStore.setState({ paletteOpen: false, sidebarCollapsed: false });
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
    emit(frame, { type: "evimed.runtime-ui.shell-shortcut", seq: 3, shortcut: "command-palette" });
    expect(useUiStore.getState().paletteOpen).toBe(true);
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
  it("names the ceiling that refused the frame, says when it frees, and offers the account page instead of a retry", async () => {
    mocks.create.mockRejectedValueOnce(new WebApiError("This account reached its daily spending limit.", {
      status: 402, code: "credits_daily_limit_reached", requestId: "req_402", retryAfterSeconds: 11_520,
    }));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("今日额度上限已到");
    expect(alert).toHaveTextContent("约 3 小时 12 分钟后额度开始释放");
    expect(alert).toHaveTextContent("不是整点清零");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看账户与额度" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/app/account");
    expect(mocks.create).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByRole("button", { name: "查看账户与额度" })).toBeNull();
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
    expect(screen.getByText("正在打开对话…")).toBeInTheDocument();
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: "request-a", ok: true, sessionId: "session-canonical" });
    await waitFor(() => expect(screen.queryByText("正在打开对话…")).toBeNull());
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
    expect(screen.getByText("正在打开对话…")).toBeInTheDocument();
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
      sessions: { refresh: vi.fn(), create: vi.fn(), open: vi.fn(), scope: () => ({}), list: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } },
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
    expect(overrideTokens).toHaveBeenCalledWith("@evimed/dsh-socket", expect.objectContaining({ "--dsw-alias-button-info-fill": { light: "#00756b", dark: "#00756b" } }));
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
});

describe("opening a task", () => {
  it("names the moment it is in, advanced by the event that ends each one, and says more after five seconds", async () => {
    vi.useFakeTimers();
    let resolveFrame!: (value: typeof binding) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { resolveFrame = resolve; }));
    // A cold Docker runtime: the control plane reports the environment, then
    // the kernel; a local container has no files to carry over.
    let reported: Record<string, unknown> = { running: false, provider: "docker", startStage: "environment", startError: null };
    mocks.status.mockImplementation(async () => reported);
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-open-step", "environment");
    expect(status).toHaveAttribute("data-open-stage", "0");
    // The composer the reader is about to type into is drawn from the start.
    expect(status.querySelector('[aria-hidden="true"] .animate-pulse')).not.toBeNull();
    expect(screen.getByText("正在准备环境…")).toBeInTheDocument();
    expect(screen.queryByText("同步文件")).toBeNull();
    expect(screen.queryByText(/正在为这个项目准备研究环境/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(/正在为这个项目准备研究环境/)).toBeInTheDocument();
    reported = { running: false, provider: "docker", startStage: "kernel", startError: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getByRole("status")).toHaveAttribute("data-open-step", "kernel");
    expect(screen.getByText("✓ 准备环境")).toBeInTheDocument();
    expect(screen.getByText("正在启动内核…")).toBeInTheDocument();
    await act(async () => { resolveFrame(binding); await vi.advanceTimersByTimeAsync(0); });
    const frame = view.container.querySelector("iframe")!;
    // The kernel's page booting inside the frame is the runtime being up.
    emit(frame, { type: "evimed.runtime-ui.booted" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveAttribute("data-open-step", "interface");
    expect(screen.getByText("✓ 启动内核")).toBeInTheDocument();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveAttribute("data-open-step", "task");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText(/正在读取这条对话的完整记录/)).toBeInTheDocument();
    const navigateCommand = post.mock.calls.find(([data]) => data.type === "evimed.runtime-ui.navigate")![0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: navigateCommand.requestId, ok: true, sessionId: "session-a" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
  });

  it("names the file sync a remote session goes through, and never a moment the provider does not have", async () => {
    vi.useFakeTimers();
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.status.mockResolvedValue({ running: false, provider: "agentbay", startStage: "sync", startError: null });
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveAttribute("data-open-step", "sync");
    expect(screen.getByText("✓ 准备环境")).toBeInTheDocument();
    expect(screen.getByText("正在同步文件…")).toBeInTheDocument();
    expect(screen.getByText("启动内核")).toBeInTheDocument();
    view.unmount();
  });

  it("says a slot cap is a slot cap, with the action that frees one, never as a slow start", async () => {
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: null, startError: null });
    mocks.start.mockRejectedValue(new WebApiError("Too many running runtimes for this user; limit is 2.", { status: 429, code: "runtime_limit_exceeded" }));
    mount(null, "/app/chat/session-a");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("同时运行的研究环境已达本部署上限");
    expect(alert).not.toHaveTextContent(/冷启动|90 秒/);
    // A concurrency ceiling: no quota page lifts it, so none is offered, and
    // the run ledger it used to point at is gone. Freeing a slot is done in
    // the conversation that holds it, which the sentence says.
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /额度/ })).toBeNull();
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
    expect(screen.getByRole("alert")).toHaveTextContent("对话界面 60 秒内没有载入完成");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    view.unmount();
  });

  it("gives up on a runtime that does not start within its own allowance, naming the moment that stalled", async () => {
    vi.useFakeTimers();
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.start.mockImplementation(() => new Promise(() => {}));
    mocks.status.mockResolvedValue({ running: false, provider: "docker", startStage: "kernel", startError: null });
    const view = mount(null, "/app/chat/session-a");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(89_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("研究内核 90 秒内没有启动完成");
    view.unmount();
  });

  it("resumes the conversation the account last had open, without walking the ledger", async () => {
    mocks.me.mockResolvedValue({ lastSessionId: "session-last" });
    mocks.listRuns.mockResolvedValue([{ sessionId: "session-from-ledger" }]);
    mocks.warm.mockReset();
    mount();
    // The runtime starts while the lookup decides which task to open.
    expect(mocks.warm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-last"));
    expect(mocks.listRuns).not.toHaveBeenCalled();
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
    expect(container.querySelectorAll("iframe")).toHaveLength(2);
    expect(container.querySelector("iframe")).not.toBe(first);
    useProjectStore.setState({ currentId: "default" });
  });

  // Switching conversation inside a live runtime is not a cold start, and
  // saying so was the whole of 「每次点会话都要冷启动」.
  it("shows no opening cover when only the conversation changes", async () => {
    const { container, frame, post } = await openConversation();
    expect(screen.queryByRole("status")).toBeNull();
    await userEvent.click(screen.getByText("Open B"));
    await waitFor(() => expect(post.mock.calls.filter(([data]) => data.type === "evimed.runtime-ui.navigate")).toHaveLength(2));
    expect(screen.queryByText("准备环境")).toBeNull();
    expect(screen.queryByText("正在打开对话…")).toBeNull();
    expect(container.querySelector("iframe")).toBe(frame);
  });
});
