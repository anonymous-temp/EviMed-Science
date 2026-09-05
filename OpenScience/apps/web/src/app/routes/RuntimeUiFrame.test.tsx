import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoute } from "./SessionRoute";

vi.mock("./RunStreamSessionPage", () => ({ RunStreamSessionPage: () => <div>built-in session view</div> }));
vi.mock("@/components/run/RunSidePanel", () => ({ RunSidePanel: () => <aside>run panel</aside> }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn(), projectId: "default", profile: { uiOrigin: "https://host.example:8443" } }));
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true, fetchWebMe: () => Promise.resolve({}), webRuntimeProfile: () => mocks.profile,
  getWebProjectId: () => mocks.projectId, createWebRuntimeUiFrame: mocks.create, releaseWebRuntimeUiFrame: mocks.release,
}));
const binding = { frameId: "frame-a", frameUrl: "https://host.example:8443/__evimed/f/frame-a/", expiresAt: Date.now() + 600_000 };
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
  </Routes></MemoryRouter>);
}
function emit(frame: HTMLIFrameElement, data: Record<string, unknown>, origin = mocks.profile.uiOrigin, source: MessageEventSource | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, origin,
    data: { version: 1, frameId: binding.frameId, projectId: "default", seq: 1, ...data } })));
}
beforeEach(() => {
  window.localStorage.clear(); mocks.create.mockReset(); mocks.release.mockReset(); mocks.release.mockResolvedValue(undefined); mocks.projectId = "default";
  mocks.create.mockResolvedValue(binding);
  mocks.profile.uiOrigin = "https://host.example:8443";
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native frame identity and readiness", () => {
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
    expect(screen.queryByText("built-in session view")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
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
    expect(screen.queryByText("built-in session view")).toBeNull();
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
    expect(screen.queryByText("built-in session view")).toBeNull();
  });

  it("retries a failed established frame by reopening the exact current URL", async () => {
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
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    const fresh = container.querySelector("iframe")!;
    expect(fresh).not.toBe(frame);
    const freshPost = vi.spyOn(fresh.contentWindow!, "postMessage");
    emit(fresh, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(freshPost).toHaveBeenCalledTimes(1));
    expect(freshPost.mock.calls[0][0].intent).toEqual({ kind: "open", sessionId: "session-a" });
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
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 2, requestId: post.mock.calls[0][0].requestId, ok: true, sessionId: "session-a" });
    emit(frame, { type: "evimed.runtime-ui.connecting", seq: 3 });
    await userEvent.click(screen.getByText("Open B"));
    expect(post).toHaveBeenCalledTimes(1);
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 4 });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const request = post.mock.calls[1][0];
    expect(request.intent).toEqual({ kind: "open", sessionId: "session-b" });
    emit(frame, { type: "evimed.runtime-ui.ready", seq: 5 });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][0]).toMatchObject({ requestId: request.requestId, intent: request.intent });
    expect(post.mock.calls[2][0].seq).toBeGreaterThan(request.seq);
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 6, requestId: request.requestId, ok: true, sessionId: "session-b" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByTestId("path")).toHaveTextContent("/app/chat/session-b");
    expect(container.querySelector("iframe")).toBe(frame);
  });

});
