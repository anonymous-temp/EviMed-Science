import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";

const mocks = vi.hoisted(() => ({
  projectId: "default",
  listWebProjects: vi.fn(),
  createWebProject: vi.fn(),
  fetchWebMe: vi.fn(),
  assign: vi.fn(),
}));

// The error dictionary (`webErrorMessage`) lives in this module and the code
// under test calls it, so the real exports come through and only the calls
// this test drives are replaced.
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  getWebProjectId: () => mocks.projectId,
  setWebProjectId: (id: string) => {
    mocks.projectId = id;
  },
  listWebProjects: mocks.listWebProjects,
  createWebProject: mocks.createWebProject,
  fetchWebMe: mocks.fetchWebMe,
}));

async function freshStore() {
  vi.resetModules();
  const { useProjectStore } = await import("./projects");
  return useProjectStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectId = "default";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: mocks.assign },
  });
});

describe("project store", () => {
  it("loads the account's projects", async () => {
    mocks.listWebProjects.mockResolvedValue([
      { id: "default", name: "Default" },
      { id: "paper1", name: "Paper 1" },
    ]);
    const store = await freshStore();

    await store.getState().load();

    expect(store.getState().projects.map((p) => p.id)).toEqual(["default", "paper1"]);
    expect(store.getState().currentId).toBe("default");
  });

  // A browser keeps its project id in local storage, so it can name one that
  // was deleted from another device. Showing a switcher whose current entry is
  // absent from its own menu is how that becomes a puzzle instead of a fact.
  it("falls back to default when the remembered project is gone", async () => {
    mocks.projectId = "deleted-elsewhere";
    mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
    const store = await freshStore();

    await store.getState().load();

    expect(store.getState().currentId).toBe("default");
    expect(mocks.projectId).toBe("default");
  });

  it("keeps the list readable as an error rather than as an empty account", async () => {
    // What the refusal *says* comes from the one dictionary, not from the
    // control plane's English `Error.message` — a researcher reading
    // "gateway down" learns nothing they can act on (2026-09-16 walk, U4).
    mocks.listWebProjects.mockRejectedValue(
      new WebApiError("gateway down", { status: 503, code: "runtime_unavailable" }),
    );
    const store = await freshStore();

    await store.getState().load();

    expect(store.getState().error).toBe("运行时出现问题，稍后重试。");
    expect(store.getState().projects).toEqual([]);
    expect(store.getState().loading).toBe(false);
  });

  it("switches by proving the project resolves, then reloading the document", async () => {
    mocks.fetchWebMe.mockResolvedValue({ project: { id: "paper1", name: "Paper 1" } });
    const store = await freshStore();

    await store.getState().select("paper1");

    expect(mocks.projectId).toBe("paper1");
    expect(mocks.assign).toHaveBeenCalledWith("/app/chat");
  });

  // Committing the browser to a project it cannot open would leave every
  // subsequent request failing with no way back to one that works.
  it("puts the previous project back when the new one does not resolve", async () => {
    mocks.fetchWebMe.mockResolvedValue({ project: { id: "default", name: "Default" } });
    const store = await freshStore();

    await expect(store.getState().select("paper1")).rejects.toThrow("该项目当前不可用。");
    expect(mocks.projectId).toBe("default");
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("puts the previous project back when the check itself fails", async () => {
    mocks.fetchWebMe.mockRejectedValue(new Error("offline"));
    const store = await freshStore();

    await expect(store.getState().select("paper1")).rejects.toThrow("offline");
    expect(mocks.projectId).toBe("default");
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("does nothing when the selected project is already current", async () => {
    const store = await freshStore();

    await store.getState().select("default");

    expect(mocks.fetchWebMe).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("adds a created project to the list in name order", async () => {
    mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
    mocks.createWebProject.mockResolvedValue({ id: "alpha", name: "Alpha" });
    const store = await freshStore();
    await store.getState().load();

    await store.getState().create("alpha");

    expect(store.getState().projects.map((p) => p.id)).toEqual(["alpha", "default"]);
  });
});
