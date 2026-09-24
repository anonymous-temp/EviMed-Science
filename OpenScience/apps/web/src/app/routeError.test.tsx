import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const NativeRequest = globalThis.Request;

// A data router builds a fetch `Request` with an AbortSignal jsdom's does not
// satisfy (the same stub as AppShell.web.test.tsx).
class SignalCompatibleRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init ? { ...init, signal: undefined } : init);
  }
}

const mocks = vi.hoisted(() => ({
  pageError: null as unknown,
  reloadForNewRelease: vi.fn<() => boolean>(),
  reloadPage: vi.fn(),
}));

// The real route table and the real shell; what is replaced is what the shell
// would reach over the network, and the page that fails.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  fetchWebMe: async () => ({ user: { id: "alice", name: "Alice" }, project: { id: "default", name: "我的研究" }, projects: [] }),
}));
vi.mock("@/components/sidebar/Sidebar", () => ({ Sidebar: () => <aside>侧栏</aside> }));
vi.mock("@/app/layout/SessionFrameHost", () => ({ SessionFrameHost: () => null }));
vi.mock("@/components/ui/Toaster", () => ({ Toaster: () => null }));
vi.mock("@/lib/staleChunk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staleChunk")>()),
  reloadForNewRelease: mocks.reloadForNewRelease,
  reloadingForNewRelease: () => false,
  reloadPage: mocks.reloadPage,
}));
// A lazily loaded page whose code fails the moment it renders — the same place
// a rejected `import()` surfaces through React.lazy.
vi.mock("./routes/InboxPage", () => ({
  InboxPage: () => {
    throw mocks.pageError;
  },
}));

const { routes } = await import("./router");

function open(path: string) {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);
}

describe("a page that fails", () => {
  beforeAll(() => { vi.stubGlobal("Request", SignalCompatibleRequest); });
  afterAll(() => { vi.unstubAllGlobals(); });
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mocks.reloadForNewRelease.mockReset();
    mocks.reloadPage.mockReset();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { consoleError.mockRestore(); });

  it("is replaced by one sentence and a reload, inside the shell, with the sidebar still there", async () => {
    mocks.pageError = new Error("Cannot read properties of undefined (reading 'map')");
    open("/app/inbox");
    expect(await screen.findByText("出了点问题")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("出了点问题");
    expect(screen.getByText("侧栏")).toBeInTheDocument();
    // No English, no stack: that is the console's (React Router logs it).
    expect(screen.queryByText(/Unexpected Application Error|Cannot read properties/)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.reloadForNewRelease).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "重新载入" }));
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
  });

  it("says the page was updated and reloads once, when its code is from a release that has since been replaced", async () => {
    mocks.reloadForNewRelease.mockReturnValue(true);
    mocks.pageError = new TypeError("Failed to fetch dynamically imported module: https://science.example/assets/InboxPage-0ld4a5h.js");
    open("/app/inbox");
    expect(await screen.findByText("页面已更新，正在刷新…")).toBeInTheDocument();
    expect(screen.getByText("侧栏")).toBeInTheDocument();
    expect(mocks.reloadForNewRelease).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重新载入" })).toBeInTheDocument();
  });

  it("says it failed when a reload a minute ago did not cure it", async () => {
    mocks.reloadForNewRelease.mockReturnValue(false);
    mocks.pageError = new TypeError("Failed to fetch dynamically imported module: https://science.example/assets/InboxPage-0ld4a5h.js");
    open("/app/inbox");
    expect(await screen.findByText("出了点问题")).toBeInTheDocument();
    expect(screen.queryByText("页面已更新，正在刷新…")).toBeNull();
    expect(screen.getByText("侧栏")).toBeInTheDocument();
  });
});

describe("where the error elements are", () => {
  it("guards every page from inside the shell, and each route outside it", () => {
    const shell = routes.find((route) => route.path === "/app");
    expect(shell?.errorElement).toBeTruthy();
    const [layout, ...rest] = shell?.children ?? [];
    expect(rest).toHaveLength(0);
    // Pathless, so it matches every page and adds nothing to any address.
    expect(layout?.path).toBeUndefined();
    expect(layout?.errorElement).toBeTruthy();
    expect(layout?.children?.some((route) => route.path === "inbox")).toBe(true);
    for (const path of ["/login", "*"]) {
      expect(routes.find((route) => route.path === path)?.errorElement, path).toBeTruthy();
    }
  });
});
