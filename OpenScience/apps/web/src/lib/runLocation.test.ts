import { beforeEach, describe, expect, it, vi } from "vitest";
import { findRunProject, openRunProject } from "./runLocation";

const mocks = vi.hoisted(() => ({
  listWebProjects: vi.fn(),
  listWebAgentRuns: vi.fn(),
  select: vi.fn(),
}));

vi.mock("./apiClient", () => ({
  getWebProjectId: () => "p-current",
  listWebProjects: mocks.listWebProjects,
  listWebAgentRuns: mocks.listWebAgentRuns,
}));
vi.mock("./projects", () => ({ useProjectStore: { getState: () => ({ select: mocks.select }) } }));

const PROJECTS = [
  { id: "p-current", name: "当前", runCount: 4, lastActivityAt: "2026-09-19T08:00:00Z" },
  { id: "p-old", name: "去年的课题", runCount: 2, lastActivityAt: "2026-03-01T00:00:00Z" },
  { id: "p-empty", name: "空项目", runCount: 0, lastActivityAt: null },
  { id: "p-recent", name: "肿瘤免疫", runCount: 7, lastActivityAt: "2026-09-18T00:00:00Z" },
];

function ledgers(byProject: Record<string, Array<{ id: string; sessionId: string }> | Error>) {
  mocks.listWebAgentRuns.mockImplementation(async ({ projectId }: { projectId: string }) => {
    const value = byProject[projectId] ?? [];
    if (value instanceof Error) throw value;
    return value;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listWebProjects.mockResolvedValue(PROJECTS);
  mocks.select.mockResolvedValue(undefined);
});

describe("findRunProject", () => {
  it("asks the other projects most recently active first, never the tab's own or an empty one", async () => {
    ledgers({ "p-old": [{ id: "run-x", sessionId: "ses-x" }] });
    expect(await findRunProject("run-x")).toBe("p-old");
    expect(mocks.listWebAgentRuns.mock.calls.map(([options]) => options.projectId)).toEqual(["p-recent", "p-old"]);
  });

  it("stops at the first project that has the run, by its id or its session", async () => {
    ledgers({ "p-recent": [{ id: "run-y", sessionId: "ses-y" }], "p-old": [{ id: "run-y2", sessionId: "ses-y2" }] });
    expect(await findRunProject("ses-y")).toBe("p-recent");
    expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(1);
  });

  it("passes over a ledger that cannot be read, and answers null when nobody has the run", async () => {
    ledgers({ "p-recent": new Error("offline"), "p-old": [] });
    expect(await findRunProject("run-z")).toBeNull();
    expect(mocks.listWebAgentRuns).toHaveBeenCalledTimes(2);
  });
});

describe("openRunProject", () => {
  it("moves the shell to the project that holds the run", async () => {
    ledgers({ "p-recent": [{ id: "run-x", sessionId: "ses-x" }] });
    expect(await openRunProject("run-x")).toBe(true);
    expect(mocks.select).toHaveBeenCalledWith("p-recent");
  });

  it("stays put when no other project has it", async () => {
    ledgers({});
    expect(await openRunProject("run-gone")).toBe(false);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("rejects when the project cannot be opened, leaving the shell where it was", async () => {
    ledgers({ "p-recent": [{ id: "run-x", sessionId: "ses-x" }] });
    mocks.select.mockRejectedValue(new Error("该项目当前不可用。"));
    await expect(openRunProject("run-x")).rejects.toThrow("该项目当前不可用。");
  });
});
