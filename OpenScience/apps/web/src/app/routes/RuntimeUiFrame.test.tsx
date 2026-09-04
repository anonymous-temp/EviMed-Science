import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRoute } from "./SessionRoute";

vi.mock("./RunStreamSessionPage", () => ({ RunStreamSessionPage: () => <div>built-in session view</div> }));
vi.mock("@/components/run/RunSidePanel", () => ({
  RunSidePanel: ({ onClose }: { onClose: () => void }) => (
    <aside>
      run panel
      <button onClick={onClose}>关闭运行面板</button>
    </aside>
  ),
}));

const profile = { uiOrigin: "https://host.example:8443" };
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  fetchWebMe: () => Promise.resolve({}),
  webRuntimeProfile: () => profile,
  getWebProjectId: () => "default",
}));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  profile.uiOrigin = "https://host.example:8443";
});

describe("the session surface when the kernel's origin cannot be reached", () => {
  it("falls back to the built-in view instead of framing an origin that answers nothing", async () => {
    // The origin is a second port, and a port is what a cloud firewall or a
    // corporate proxy refuses without either side being broken. An iframe
    // cannot report that -- `onerror` does not fire for a network failure --
    // so without this the page shows its loading line forever and reads as the
    // product being broken.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<SessionRoute />);
    await waitFor(() => expect(screen.getByText("built-in session view")).toBeInTheDocument());
  });

  it("keeps the frame when the origin answers", async () => {
    // A real opaque response has status 0, which `new Response` refuses to
    // construct; what the probe reads is only whether the promise resolved.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    const { container } = render(<SessionRoute />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByText("built-in session view")).toBeNull();
  });

  it("renders its own view when the deployment serves no kernel application", async () => {
    profile.uiOrigin = "";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    const { container } = render(<SessionRoute />);
    await waitFor(() => expect(screen.getByText("built-in session view")).toBeInTheDocument());
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("the run panel beside the session", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
  });

  it("is open by default, because the gate's verdict is the product", () => {
    render(<SessionRoute />);
    expect(screen.getByText("run panel")).toBeInTheDocument();
  });

  it("closes on request and stays closed on the next visit", async () => {
    const { unmount } = render(<SessionRoute />);
    await userEvent.click(screen.getByRole("button", { name: "关闭运行面板" }));
    expect(screen.queryByText("run panel")).toBeNull();
    unmount();

    render(<SessionRoute />);
    expect(screen.queryByText("run panel")).toBeNull();
    expect(screen.getByRole("button", { name: "打开运行面板" })).toBeInTheDocument();
  });

  it("reopens from the button the closed state leaves behind", async () => {
    window.localStorage.setItem("evimed.chat.runPanel", "0");
    render(<SessionRoute />);
    await userEvent.click(screen.getByRole("button", { name: "打开运行面板" }));
    expect(screen.getByText("run panel")).toBeInTheDocument();
  });
});
