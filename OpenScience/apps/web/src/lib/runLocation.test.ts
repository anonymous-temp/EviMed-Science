import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatPath, chatSessionId, findRunProject, findRunSession, isChatPath, openRunProject } from "./runLocation";

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
  // Called without options for the tab's own project, and with one for another.
  mocks.listWebAgentRuns.mockImplementation(async (options?: { projectId: string }) => {
    const value = byProject[options?.projectId ?? "p-current"] ?? [];
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

// One route for a conversation, with or without its id: two route objects made
// `/app/chat` → `/app/chat/:id` a remount (2026-09-20 review B §C item 3).
describe("the conversation's address", () => {
  it("names a conversation, and falls back to the bare surface for anything unusable", () => {
    expect(chatPath("ses-1")).toBe("/app/chat/ses-1");
    expect(chatPath("ses 1")).toBe("/app/chat");
    expect(chatPath(null)).toBe("/app/chat");
    expect(chatPath("")).toBe("/app/chat");
  });

  it("recognises the surface, with and without a conversation, and nothing else", () => {
    expect(isChatPath("/app/chat")).toBe(true);
    expect(isChatPath("/app/chat/ses-1")).toBe(true);
    expect(isChatPath("/app/chats")).toBe(false);
    expect(isChatPath("/app/files")).toBe(false);
  });

  it("reads the conversation out of an address, and refuses one it did not write", () => {
    expect(chatSessionId("/app/chat/ses-1")).toBe("ses-1");
    expect(chatSessionId("/app/chat/" + encodeURIComponent("ses-1"))).toBe("ses-1");
    expect(chatSessionId("/app/chat")).toBeNull();
    expect(chatSessionId("/app/chat/a/b")).toBeNull();
    expect(chatSessionId("/app/chat/%E2%80%")).toBeNull();
    expect(chatSessionId("/app/files")).toBeNull();
  });
});

// Notifications, Feishu cards and old bookmarks name a run; the product has
// one surface for it now, and only the ledger knows which conversation it is.
describe("findRunSession", () => {
  it("answers from the tab's own project without asking another", async () => {
    ledgers({ "p-current": [{ id: "run-x", sessionId: "ses-x" }] });
    expect(await findRunSession("run-x")).toBe("ses-x");
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("moves to the project that has it, and answers from there", async () => {
    ledgers({ "p-current": [], "p-recent": [{ id: "run-y", sessionId: "ses-y" }] });
    mocks.select.mockImplementation(async () => { ledgers({ "p-current": [{ id: "run-y", sessionId: "ses-y" }] }); });
    expect(await findRunSession("run-y")).toBe("ses-y");
    expect(mocks.select).toHaveBeenCalledWith("p-recent");
  });

  it("answers null for a run no project has, and for one with no addressable conversation", async () => {
    ledgers({});
    expect(await findRunSession("run-gone")).toBeNull();
    ledgers({ "p-current": [{ id: "run-z", sessionId: "not a session id" }] });
    expect(await findRunSession("run-z")).toBeNull();
  });
});
