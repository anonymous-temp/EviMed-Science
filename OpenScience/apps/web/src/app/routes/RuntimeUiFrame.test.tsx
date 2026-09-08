import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoute } from "./SessionRoute";
import { WebApiError } from "@/lib/apiClient";
import { apply as applyNativeBridge } from "../../../../../packages/harness-port/src/runtimeUiBridge.mjs";

vi.mock("@/components/run/RunSidePanel", () => ({ RunSidePanel: () => <aside>run panel</aside> }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), renew: vi.fn(), release: vi.fn(), projectId: "default", profile: { uiOrigin: "https://host.example:8443" } }));
// Only the four frame calls and the profile are stubbed. Everything else is the
// real module on purpose: `WebApiError` has to be the same class the component
// tests with `instanceof`, and `webErrorMessage` has to be the real projection
// over the real registry — a hand-written stub here would prove that a fake
// dictionary renders, which is the defect this change removes, not the fix.
vi.mock("@/lib/apiClient", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true, fetchWebMe: () => Promise.resolve({}), webRuntimeProfile: () => mocks.profile,
  getWebProjectId: () => mocks.projectId, createWebRuntimeUiFrame: mocks.create, releaseWebRuntimeUiFrame: mocks.release,
  renewWebRuntimeUiFrame: mocks.renew,
}));
const binding = { frameId: "frame-a", frameUrl: "https://host.example:8443/__evimed/f/frame-a/", expiresAt: Date.now() + 600_000, renewalToken: "renew-frame-a" };
function PathProbe() {
  const navigate = useNavigate();
  return <div><span data-testid="path">{useLocation().pathname}</span>
    <button onClick={() => navigate("/app/chat/session-b")}>Open B</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </div>;
}
function mount(state: unknown = null, path = "/app/chat") {
  return render(<MemoryRouter initialEntries={[{ pathname: path, state }]}><PathProbe /><Routes>
    <Route path="/app/chat" element={<SessionRoute />} /><Route path="/app/chat/:sessionId" element={<SessionRoute />} />
    <Route path="/app/account" element={<div>account and usage</div>} />
  </Routes></MemoryRouter>);
}
function emit(frame: HTMLIFrameElement, data: Record<string, unknown>, origin = mocks.profile.uiOrigin, source: MessageEventSource | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, origin,
    data: { version: 1, frameId: binding.frameId, projectId: "default", seq: 1, ...data } })));
}
beforeEach(() => {
  window.localStorage.clear(); mocks.create.mockReset(); mocks.renew.mockReset(); mocks.release.mockReset(); mocks.release.mockResolvedValue(undefined); mocks.projectId = "default";
  mocks.create.mockResolvedValue(binding);
  mocks.renew.mockImplementation(async () => ({ ...binding, expiresAt: Date.now() + 300_000 }));
  mocks.profile.uiOrigin = "https://host.example:8443";
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

  it("shows renewal failure without dropping native state and keeps recovery single-flight", async () => {
    const { container, frame } = await establishedClockFrame();
    let rejectRenew!: (reason: Error) => void;
    mocks.renew.mockImplementation(() => new Promise((_resolve, reject) => { rejectRenew = reject; }));
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    await act(async () => { rejectRenew(new Error("offline")); });
    expect(screen.getByRole("alert")).toHaveTextContent("连接");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.renew.mockResolvedValue({ ...binding, expiresAt: Date.now() + 300_000 });
    await act(async () => { screen.getByRole("button", { name: "重新连接" }).click(); await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.renew).toHaveBeenCalledTimes(2);
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
        parent, addEventListener: (_type: string, fn: typeof listener) => { listener = fn; }, removeEventListener() {},
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
    expect(screen.getByText("正在启动研究运行时…")).toBeInTheDocument();
    emit(frame, { type: "evimed.runtime-ui.ready" }, "https://evil.example");
    emit(frame, { type: "evimed.runtime-ui.ready" }, mocks.profile.uiOrigin, window);
    emit(frame, { type: "evimed.runtime-ui.ready", frameId: "frame-b" });
    expect(screen.getByText("正在启动研究运行时…")).toBeInTheDocument();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByText("正在打开研究任务…")).toBeInTheDocument();
    const command = post.mock.calls[0][0];
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: command.requestId, ok: true, sessionId: command.intent.sessionId });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(container.querySelector("iframe")).toBe(frame);
    unmount(); expect(mocks.release).toHaveBeenCalledWith("frame-a");
  });

  it("offers retry on frame failure without silently switching dispatchers", async () => {
    mocks.create.mockRejectedValueOnce(new Error("Unavailable")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("研究会话暂时无法连接");
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
    expect(alert).not.toHaveTextContent("研究会话暂时无法连接");
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
    expect(screen.getByText("正在打开研究任务…")).toBeInTheDocument();
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: "request-a", ok: true, sessionId: "session-canonical" });
    await waitFor(() => expect(screen.queryByText("正在打开研究任务…")).toBeNull());
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-canonical");
  });

  it("shows an explicit unavailable state when the deployment has no native surface", async () => {
    mocks.profile.uiOrigin = ""; mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("研究会话暂时无法连接");
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
    expect(await screen.findByRole("alert")).toHaveTextContent("研究任务暂时无法打开");
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/unknown-session");
  });

  it("recovers an established frame without recreating its document or navigation", async () => {
    const { container } = mount(null, "/app/chat/session-a");
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "wrong-session" });
    expect(screen.getByText("正在打开研究任务…")).toBeInTheDocument();
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
    const { unmount } = mount(); unmount();
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
  expect(await screen.findByRole("alert")).toHaveTextContent("研究任务暂时无法打开");
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
