import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";

const mocks = vi.hoisted(() => ({
  projectId: "default",
  listWebProjects: vi.fn(),
  createWebProject: vi.fn(),
  renameWebProject: vi.fn(),
  fetchWebMe: vi.fn(),
  assign: vi.fn(),
  reload: vi.fn(),
  warmWebRuntime: vi.fn(),
  clearScrollMemory: vi.fn(),
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
  renameWebProject: mocks.renameWebProject,
  fetchWebMe: mocks.fetchWebMe,
}));

vi.mock("@/lib/runtimeWarm", () => ({ warmWebRuntime: mocks.warmWebRuntime }));
vi.mock("@/lib/scrollMemory", () => ({ clearScrollMemory: mocks.clearScrollMemory }));

async function freshStore() {
  vi.resetModules();
  const { useProjectStore } = await import("./projects");
  return useProjectStore;
}

/** What `/api/me` answers when it resolved `projectId`. */
function me(projectId: string) {
  return { user: { id: "alice", name: "Alice" }, project: { id: projectId, name: projectId }, projects: [] };
}

/** A promise the test settles by hand, to hold a switch at its proof. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectId = "default";
  // A reload is what switching used to be; stubbed so a regression to it is
  // observable instead of a jsdom navigation error.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: mocks.assign, reload: mocks.reload, pathname: "/app/chat", search: "", hash: "" },
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
  // was deleted from another device. Showing a list whose current entry is
  // absent from it is how that becomes a puzzle instead of a fact.
  it("falls back to default, in place, when the remembered project is gone", async () => {
    mocks.projectId = "deleted-elsewhere";
    mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "Default" }]);
    const store = await freshStore();

    await store.getState().load();

    expect(store.getState().currentId).toBe("default");
    expect(mocks.projectId).toBe("default");
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.clearScrollMemory).toHaveBeenCalled();
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

  // Two reads racing — the sidebar's on mount, the account page's after a
  // create — must not end on the older list, which lacks the new project.
  it("keeps the newer list when an older read answers last", async () => {
    const older = deferred<Array<{ id: string; name: string }>>();
    mocks.listWebProjects
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce([{ id: "default", name: "我的研究" }, { id: "p-new", name: "新项目" }]);
    const store = await freshStore();

    const first = store.getState().load();
    await store.getState().load();
    older.resolve([{ id: "default", name: "我的研究" }]);
    await first;

    expect(store.getState().projects.map((p) => p.id)).toEqual(["default", "p-new"]);
  });

  // The switch used to end in `window.location.assign("/app/chat")`: the
  // whole shell, its chunks and the kernel frame fetched again to change one
  // header (2026-09-19, 「点一个切换的话就得重新刷新一遍」).
  it("switches in place: proves the project on its own request, then moves the tab, without a reload", async () => {
    const proof = deferred<ReturnType<typeof me>>();
    mocks.fetchWebMe.mockReturnValue(proof.promise);
    const store = await freshStore();

    const switching = store.getState().select("paper1");

    // While the proof is out the tab has not moved: every page still on screen
    // keeps sending the project it is showing.
    expect(mocks.fetchWebMe).toHaveBeenCalledWith({ projectId: "paper1" });
    expect(mocks.projectId).toBe("default");
    expect(store.getState().currentId).toBe("default");
    expect(store.getState().switching).toBe("paper1");

    proof.resolve(me("paper1"));
    await switching;

    expect(mocks.projectId).toBe("paper1");
    expect(store.getState().currentId).toBe("paper1");
    expect(store.getState().switching).toBeNull();
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("lands in the same step as the move, with the new project already the tab's", async () => {
    mocks.fetchWebMe.mockResolvedValue(me("paper1"));
    const store = await freshStore();
    const seen: Array<{ currentId: string; header: string }> = [];

    await store.getState().select("paper1", () => {
      seen.push({ currentId: store.getState().currentId, header: mocks.projectId });
    });

    expect(seen).toEqual([{ currentId: "paper1", header: "paper1" }]);
  });

  // A project the account cannot open never becomes the tab's project, so a
  // refusal has nothing to roll back and the page on screen keeps working.
  it("stays on the previous project when the new one does not resolve", async () => {
    mocks.fetchWebMe.mockResolvedValue(me("default"));
    const land = vi.fn();
    const store = await freshStore();

    await expect(store.getState().select("paper1", land)).rejects.toThrow("该项目当前不可用。");

    expect(mocks.projectId).toBe("default");
    expect(store.getState().currentId).toBe("default");
    expect(store.getState().switching).toBeNull();
    expect(land).not.toHaveBeenCalled();
    expect(mocks.warmWebRuntime).not.toHaveBeenCalled();
  });

  it("stays on the previous project when the check itself fails", async () => {
    mocks.fetchWebMe.mockRejectedValue(new Error("offline"));
    const store = await freshStore();

    await expect(store.getState().select("paper1")).rejects.toThrow("offline");

    expect(mocks.projectId).toBe("default");
    expect(store.getState().currentId).toBe("default");
    expect(store.getState().switching).toBeNull();
  });

  // Two clicks before the first answer: the later one is the one meant.
  it("lets a later switch overtake an earlier one still waiting on its answer", async () => {
    const slow = deferred<ReturnType<typeof me>>();
    mocks.fetchWebMe.mockImplementation(({ projectId }: { projectId: string }) => (
      projectId === "paper1" ? slow.promise : Promise.resolve(me(projectId))
    ));
    const landedFirst = vi.fn();
    const landedSecond = vi.fn();
    const store = await freshStore();

    const first = store.getState().select("paper1", landedFirst);
    await store.getState().select("paper2", landedSecond);
    slow.resolve(me("paper1"));
    await first;

    expect(store.getState().currentId).toBe("paper2");
    expect(mocks.projectId).toBe("paper2");
    expect(landedSecond).toHaveBeenCalledTimes(1);
    expect(landedFirst).not.toHaveBeenCalled();
  });

  it("stands a waiting switch down when the current project is chosen again", async () => {
    const slow = deferred<ReturnType<typeof me>>();
    mocks.fetchWebMe.mockReturnValue(slow.promise);
    const land = vi.fn();
    const store = await freshStore();

    const away = store.getState().select("paper1");
    await store.getState().select("default", land);
    expect(land).toHaveBeenCalledTimes(1);
    expect(store.getState().switching).toBeNull();
    slow.resolve(me("paper1"));
    await away;

    expect(store.getState().currentId).toBe("default");
    expect(mocks.projectId).toBe("default");
  });

  it("does not ask the server when the selected project is already current, and still lands", async () => {
    const land = vi.fn();
    const store = await freshStore();

    await store.getState().select("default", land);

    expect(mocks.fetchWebMe).not.toHaveBeenCalled();
    expect(land).toHaveBeenCalledTimes(1);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  // Remembered scroll offsets are keyed by a path relative to the project's
  // workspace, so one project's `outputs/report.md` would reopen at another's
  // offset; and the runtime of the project just entered is started at once.
  it("forgets scroll offsets and warms the new project's runtime after a switch", async () => {
    mocks.fetchWebMe.mockResolvedValue(me("paper1"));
    const store = await freshStore();

    await store.getState().select("paper1");

    expect(mocks.clearScrollMemory).toHaveBeenCalledTimes(1);
    expect(mocks.warmWebRuntime).toHaveBeenCalledWith("paper1");
  });

  it("drops a switch still waiting when the session ends", async () => {
    const slow = deferred<ReturnType<typeof me>>();
    mocks.fetchWebMe.mockReturnValue(slow.promise);
    const store = await freshStore();

    const away = store.getState().select("paper1");
    store.getState().clear();
    slow.resolve(me("paper1"));
    await away;

    expect(store.getState().currentId).toBe("default");
    expect(store.getState().switching).toBeNull();
  });

  it("creates a project from its trimmed name and adds it in name order", async () => {
    mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "我的研究" }]);
    mocks.createWebProject.mockResolvedValue({ id: "alpha", name: "Alpha" });
    const store = await freshStore();
    await store.getState().load();

    await store.getState().create("  Alpha ");

    expect(mocks.createWebProject).toHaveBeenCalledWith("Alpha");
    expect(store.getState().projects.map((p) => p.id)).toEqual(["default", "alpha"]);
  });

  it("lists the account's own project first, then by name as a Chinese reader sorts", async () => {
    mocks.listWebProjects.mockResolvedValue([
      { id: "p2", name: "心衰" },
      { id: "p1", name: "房颤" },
      { id: "default", name: "我的研究" },
    ]);
    const store = await freshStore();
    await store.getState().load();

    // Pinyin order: 房 (fang) before 心 (xin).
    expect(store.getState().projects.map((p) => p.name)).toEqual(["我的研究", "房颤", "心衰"]);
  });

  it("renames a project in the list without moving the selection", async () => {
    mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "我的研究" }, { id: "paper1", name: "Paper 1" }]);
    mocks.renameWebProject.mockResolvedValue({ id: "paper1", name: "论文一" });
    const store = await freshStore();
    await store.getState().load();

    await store.getState().rename("paper1", " 论文一 ");

    expect(mocks.renameWebProject).toHaveBeenCalledWith("paper1", "论文一");
    expect(store.getState().projects.find((p) => p.id === "paper1")?.name).toBe("论文一");
    expect(store.getState().currentId).toBe("default");
  });
});
