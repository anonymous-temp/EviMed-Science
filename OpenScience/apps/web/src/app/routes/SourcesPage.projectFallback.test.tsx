import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebProjectId, setWebProjectId } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { SourcesPage } from "./SourcesPage";

const api = vi.hoisted(() => ({ listWebProjects: vi.fn(), fetchWebMe: vi.fn(), listSources: vi.fn() }));
vi.mock("@/lib/apiClient", async original => ({
  ...await original<typeof import("@/lib/apiClient")>(),
  listWebProjects: api.listWebProjects,
  fetchWebMe: api.fetchWebMe,
  hasWebApi: true,
}));
vi.mock("@/lib/sourceClient", async original => ({
  ...await original<typeof import("@/lib/sourceClient")>(),
  listSources: api.listSources,
}));

beforeEach(() => {
  vi.clearAllMocks();
  setWebProjectId("deleted-project");
  useProjectStore.getState().clear();
  api.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  useProjectStore.getState().clear();
});

describe("SourcesPage automatic project fallback", () => {
  it("reloads the mounted page after the real store repairs a deleted project", async () => {
    let resolveDeleted!: (value: unknown) => void;
    api.listSources.mockReturnValueOnce(new Promise(resolve => { resolveDeleted = resolve; }))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<SourcesPage />);
    expect(api.listSources).toHaveBeenCalledWith("deleted-project", { status: "" });

    await act(async () => { await useProjectStore.getState().load(); });
    expect(getWebProjectId()).toBe("default");
    expect(useProjectStore.getState().currentId).toBe("default");
    expect(api.listSources).toHaveBeenLastCalledWith("default", { status: "" });
    expect(await screen.findByText("还没有进入分析流程的资料")).toBeInTheDocument();

    await act(async () => { resolveDeleted({ items: [{ id: "obsolete", projectId: "deleted-project", payload: { paths: ["obsolete.txt"] } }], nextCursor: null }); });
    expect(screen.queryByText("obsolete.txt")).not.toBeInTheDocument();
    expect(api.fetchWebMe).not.toHaveBeenCalled();
  });

  it("keeps a newer tab selection when a pending project list resolves", async () => {
    let resolveProjects!: (value: Array<{ id: string; name: string }>) => void;
    let rejectDeleted!: (reason: Error) => void;
    api.listWebProjects.mockReturnValueOnce(new Promise(resolve => { resolveProjects = resolve; }));
    api.listSources.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDeleted = reject; }))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    render(<SourcesPage />);
    let loading!: Promise<void>;
    act(() => { loading = useProjectStore.getState().load(); });
    setWebProjectId("new-project");
    await act(async () => {
      resolveProjects([{ id: "default", name: "Default" }, { id: "new-project", name: "New project" }]);
      await loading;
    });
    expect(getWebProjectId()).toBe("new-project");
    expect(api.listSources).toHaveBeenLastCalledWith("new-project", { status: "" });
    expect(await screen.findByText("还没有进入分析流程的资料")).toBeInTheDocument();
    await act(async () => { rejectDeleted(new Error("Old project unavailable")); });
    expect(screen.queryByText(/无法加载资料状态/)).not.toBeInTheDocument();
    expect(api.listSources).not.toHaveBeenCalledWith("default", { status: "" });
  });
});
