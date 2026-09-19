import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { AppShell } from "./AppShell";

const NativeRequest = globalThis.Request;

class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: undefined } : init);
  }
}

const mocks = vi.hoisted(() => ({ fetchWebMe: vi.fn(), mounts: [] as string[] }));

// The real project store and the real tab binding; only `/api/me` answers
// from here — the shell's sign-in check and a switch's proof alike.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  fetchWebMe: mocks.fetchWebMe,
}));
vi.mock("@/components/sidebar/Sidebar", () => ({ Sidebar: () => <aside>Sidebar</aside> }));
vi.mock("@/components/command-palette/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));

/** A page that records, on mount, which project it mounted under. */
function Page({ name }: { name: string }) {
  useEffect(() => {
    mocks.mounts.push(`${name}@${getWebProjectId()}`);
  }, [name]);
  return <main>{name} page</main>;
}

function renderShell(path: string) {
  const router = createMemoryRouter(
    [{
      path: "/app",
      element: <AppShell />,
      children: [
        { path: "files", element: <Page name="files" /> },
        { path: "chat/:sessionId", element: <Page name="chat" /> },
      ],
    }],
    { initialEntries: [path] },
  );
  // The DOM provider, as `main.tsx` mounts it: it is what lets a navigation
  // asked with `flushSync` join the switch's render.
  render(<RouterProvider router={router} />);
  return router;
}

describe("AppShell project switch", () => {
  beforeAll(() => {
    vi.stubGlobal("Request", SignalCompatibleRequest);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mounts = [];
    window.sessionStorage.clear();
    window.localStorage.clear();
    useProjectStore.getState().clear();
    mocks.fetchWebMe.mockImplementation(async ({ projectId }: { projectId?: string } = {}) => {
      const id = projectId ?? getWebProjectId();
      return { user: { id: "alice", name: "Alice" }, project: { id, name: id }, projects: [] };
    });
  });

  // Every page reads the project when it mounts and none listens for a
  // change, so an in-place switch has to mount them again — which the reload
  // it replaced did by discarding the document.
  it("mounts the page on screen again under the new project, without a reload", async () => {
    renderShell("/app/files");
    // The mount effect, not the text: a page can be on screen a tick before
    // its effects have run.
    await waitFor(() => expect(mocks.mounts).toEqual(["files@default"]));

    await act(async () => { await useProjectStore.getState().select("paper1"); });

    expect(mocks.mounts).toEqual(["files@default", "files@paper1"]);
    expect(screen.getByText("files page")).toBeInTheDocument();
  });

  // Without landing in the same render, the router's navigation (a
  // transition) would render after the store's update: the knowledge base of
  // project B would mount, fetch and flash before B's task — or a task of A
  // would open in B's runtime.
  it("lands on the page a switch was for in the same render: the old address never mounts under the new project", async () => {
    const router = renderShell("/app/files");
    await waitFor(() => expect(mocks.mounts).toEqual(["files@default"]));

    await act(async () => {
      await useProjectStore.getState().select("paper1", () => { void router.navigate("/app/chat/ses-p1", { flushSync: true }); });
    });

    expect(mocks.mounts).toEqual(["files@default", "chat@paper1"]);
    expect(screen.getByText("chat page")).toBeInTheDocument();
  });

  it("leaves the page alone when a switch is refused", async () => {
    mocks.fetchWebMe.mockImplementation(async () => ({ user: { id: "alice", name: "Alice" }, project: { id: "default", name: "我的研究" }, projects: [] }));
    renderShell("/app/files");
    await waitFor(() => expect(mocks.mounts).toEqual(["files@default"]));

    await act(async () => {
      await expect(useProjectStore.getState().select("paper1")).rejects.toThrow("该项目当前不可用。");
    });

    expect(mocks.mounts).toEqual(["files@default"]);
  });
});
