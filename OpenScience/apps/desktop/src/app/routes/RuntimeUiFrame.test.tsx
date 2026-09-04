import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRoute } from "./SessionRoute";

vi.mock("./LiveSessionPage", () => ({ LiveSessionPage: () => <div>legacy session view</div> }));
vi.mock("./RunStreamSessionPage", () => ({ RunStreamSessionPage: () => <div>built-in session view</div> }));

const profile = { sessionView: "run-stream" as const, uiOrigin: "https://host.example:8443" };
vi.mock("@/lib/apiClient", () => ({
  hasWebApi: true,
  fetchWebMe: () => Promise.resolve({}),
  webRuntimeProfile: () => profile,
  getWebProjectId: () => "default",
}));

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
});
