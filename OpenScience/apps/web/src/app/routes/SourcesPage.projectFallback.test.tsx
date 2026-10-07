import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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

const EMPTY = "把文献、指南、方案、数据表、网页或笔记放进来，对话里会读它们并标出处。";
const nothing = { items: [], nextCursor: null, counts: { all: 0, literature: 0, table: 0, document: 0, page: 0, note: 0, image: 0 } };
/** The scope a page lists: the project it is in, until the researcher chooses another. */
const projectScope = (projectId: string) => ({ kind: "project", projectId });

beforeEach(() => {
  vi.clearAllMocks();
  setWebProjectId("deleted-project");
  useProjectStore.getState().clear();
  api.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
  // The page asks `/api/me` on mount, for whether to offer the drive and the two modules' groups.
  api.fetchWebMe.mockResolvedValue(null);
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
      .mockResolvedValueOnce(nothing);
    render(<MemoryRouter><SourcesPage /></MemoryRouter>);
    expect(api.listSources).toHaveBeenCalledWith(projectScope("deleted-project"), { q: "", limit: 50 });

    await act(async () => { await useProjectStore.getState().load(); });
    expect(getWebProjectId()).toBe("default");
    expect(useProjectStore.getState().currentId).toBe("default");
    expect(api.listSources).toHaveBeenLastCalledWith(projectScope("default"), { q: "", limit: 50 });
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();

    await act(async () => { resolveDeleted({ items: [{ id: "obsolete", projectId: "deleted-project", payload: { paths: ["obsolete.txt"] }, display: { title: "obsolete.txt" } }], nextCursor: null, counts: nothing.counts }); });
    expect(screen.queryByText("obsolete.txt")).not.toBeInTheDocument();
    // The repair is not a project switch: a switch proves its project on
    // `/api/me` first (`fetchWebMe({ projectId })`). The page's own read of
    // what it may offer names no project and is not one.
    expect(api.fetchWebMe).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: expect.anything() }));
  });

  it("keeps a newer tab selection when a pending project list resolves", async () => {
    let resolveProjects!: (value: Array<{ id: string; name: string }>) => void;
    let rejectDeleted!: (reason: Error) => void;
    api.listWebProjects.mockReturnValueOnce(new Promise(resolve => { resolveProjects = resolve; }));
    api.listSources.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDeleted = reject; }))
      .mockResolvedValueOnce(nothing);
    render(<MemoryRouter><SourcesPage /></MemoryRouter>);
    let loading!: Promise<void>;
    act(() => { loading = useProjectStore.getState().load(); });
    setWebProjectId("new-project");
    await act(async () => {
      resolveProjects([{ id: "default", name: "Default" }, { id: "new-project", name: "New project" }]);
      await loading;
    });
    expect(getWebProjectId()).toBe("new-project");
    expect(api.listSources).toHaveBeenLastCalledWith(projectScope("new-project"), { q: "", limit: 50 });
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    await act(async () => { rejectDeleted(new Error("Old project unavailable")); });
    expect(screen.queryByText(/无法加载资料/)).not.toBeInTheDocument();
    expect(api.listSources).not.toHaveBeenCalledWith(projectScope("default"), expect.anything());
  });

  it("lists the project the tab is in even when the account's project list has not answered", async () => {
    // A scope whose project is not in the list yet is kept: the fallback applies only once the list is known.
    api.listWebProjects.mockReturnValueOnce(new Promise(() => {}));
    api.listSources.mockResolvedValue(nothing);
    render(<MemoryRouter><SourcesPage /></MemoryRouter>);
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    expect(api.listSources).toHaveBeenCalledTimes(1);
  });
});
