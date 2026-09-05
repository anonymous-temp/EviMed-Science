import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoute } from "./SessionRoute";

vi.mock("./RunStreamSessionPage", () => ({ RunStreamSessionPage: () => <div>built-in session view</div> }));
vi.mock("@/components/run/RunSidePanel", () => ({ RunSidePanel: () => <aside>run panel</aside> }));
const mocks = vi.hoisted(() => ({ create: vi.fn(), profile: { uiOrigin: "https://host.example:8443" } }));
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true, fetchWebMe: () => Promise.resolve({}), webRuntimeProfile: () => mocks.profile,
  getWebProjectId: () => "default", createWebRuntimeUiFrame: mocks.create,
}));
const binding = { frameId: "frame-a", frameUrl: "https://host.example:8443/frames/frame-a/", expiresAt: Date.now() + 600_000 };
function mount(state: unknown = null) {
  return render(<MemoryRouter initialEntries={[{ pathname: "/app/chat", state }]}><SessionRoute /></MemoryRouter>);
}
function emit(frame: HTMLIFrameElement, data: Record<string, unknown>, origin = mocks.profile.uiOrigin, source: MessageEventSource | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, origin,
    data: { version: 1, frameId: binding.frameId, projectId: "default", seq: 1, ...data } })));
}
beforeEach(() => {
  window.localStorage.clear(); mocks.create.mockReset();
  mocks.create.mockResolvedValue(binding);
  mocks.profile.uiOrigin = "https://host.example:8443";
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
    emit(frame, { type: "evimed.runtime-ui.ready" });
    await waitFor(() => expect(screen.queryByText("正在启动研究运行时…")).toBeNull());
    unmount();
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
    emit(frame, { type: "evimed.runtime-ui.ack", seq: 3, requestId: "request-a", ok: true, sessionId: "session-new" });
    await waitFor(() => expect(screen.queryByText("正在打开研究任务…")).toBeNull());
  });

  it("uses the built-in view only when the deployment has no native surface", async () => {
    mocks.profile.uiOrigin = ""; mount();
    expect(await screen.findByText("built-in session view")).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
