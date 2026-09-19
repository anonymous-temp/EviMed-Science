import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMemoryBar } from "./SessionMemoryBar";

const client = vi.hoisted(() => ({
  MEMORY_CHANGED_EVENT: "evimed.memory.changed",
  announceMemoryChanged: vi.fn(),
  archiveMemoryRecord: vi.fn(),
  bringBackForSession: vi.fn(),
  fetchMemoryChanges: vi.fn(),
  fetchSessionBackground: vi.fn(),
  fetchSessionMemory: vi.fn(),
  restoreLearnedMethod: vi.fn(),
  retireCapsuleEntry: vi.fn(),
  retireLearnedMethod: vi.fn(),
  setAsideForSession: vi.fn(),
  setSessionIncognito: vi.fn(),
  undoCapsuleEntry: vi.fn(),
  undoMemoryRecord: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const background = {
  sessionId: "ses_1",
  incognito: false,
  excluded: [],
  runs: [{ id: "run_1", status: "succeeded", startedAt: "2026-09-20T01:00:00Z" }],
  memories: [
    { type: "memory", id: "rec_1", kind: "preference", scope: "user", summary: "证据先用表格", available: true,
      runIds: ["run_1", "run_2"], setAside: false, basis: "stated", provenance: { basis: "stated", observations: 2, runs: 2, conversations: 1 }, version: 3 },
    { type: "capsule", id: "fact_1", kind: "method_preference", scope: "capsule", summary: "先查肾功能", available: true,
      runIds: ["run_1"], setAside: true, capsuleId: "cap_1", revision: 4 },
    { type: "memory", id: "rec_gone", kind: "profile", scope: "user", summary: "", available: false, runIds: ["run_1"], setAside: false },
  ],
  methods: [
    { name: "renal-dosing", label: "renal-dosing", source: "learned", methodId: "mth_1", revision: 2, description: "肾功能分层给药",
      used: true, runIds: ["run_1"], setAside: false, available: true },
  ],
  written: [
    { id: "rec_2", key: "k", kind: "preference", scope: "user", scopeId: "", summary: "回答用中文", status: "active",
      change: "created", changedAt: "2026-09-20T01:05:00Z", version: 1 },
  ],
};

describe("the conversation's memory bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.fetchSessionMemory.mockResolvedValue({ incognito: false, excluded: [] });
    client.fetchMemoryChanges.mockResolvedValue([]);
    client.fetchSessionBackground.mockResolvedValue(structuredClone(background));
  });
  afterEach(cleanup);

  it("switches the conversation to incognito and says so while it is on", async () => {
    client.setSessionIncognito.mockResolvedValue({ incognito: true, excluded: [] });
    render(<SessionMemoryBar sessionId="ses_1" />);
    const toggle = await screen.findByRole("switch", { name: "无痕对话" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/不会记住这段对话/)).toBeNull();

    await userEvent.click(toggle);
    expect(client.setSessionIncognito).toHaveBeenCalledWith("ses_1", true);
    await waitFor(() => expect(screen.getByRole("switch", { name: "无痕对话" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("无痕对话：不会记住这段对话，也不调取记忆");
  });

  it("is absent, not broken, when the conversation's memory cannot be read", async () => {
    client.fetchSessionMemory.mockRejectedValue(new Error("memory_disabled"));
    render(<SessionMemoryBar sessionId="ses_1" />);
    await waitFor(() => expect(client.fetchSessionMemory).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("session-memory-bar")).toBeNull());
  });

  it("tells the researcher when this conversation wrote a memory, with the undo on the same line", async () => {
    const change = { ...background.written[0] };
    client.fetchMemoryChanges.mockResolvedValue([change]);
    render(<SessionMemoryBar sessionId="ses_1" />);
    await screen.findByRole("switch", { name: "无痕对话" });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(client.fetchMemoryChanges).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_1" }));
    const [message, options] = toasts.success.mock.calls[0];
    expect(message).toBe("刚记住了 1 条：「回答用中文」");
    expect(options.action.label).toBe("撤销");
    expect(await screen.findByRole("button", { name: /本次用到的背景 · 新记下 1/ })).toBeInTheDocument();
    // The same change is announced once.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(client.fetchMemoryChanges).toHaveBeenCalledTimes(2));
    expect(toasts.success).toHaveBeenCalledTimes(1);
  });
});

describe("本次用到的背景", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.fetchSessionMemory.mockResolvedValue({ incognito: false, excluded: [] });
    client.fetchMemoryChanges.mockResolvedValue([]);
  });
  afterEach(cleanup);

  async function openPanel() {
    render(<SessionMemoryBar sessionId="ses_1" />);
    const button = await screen.findByRole("button", { name: /本次用到的背景/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    return screen.findByRole("dialog", { name: "本次用到的背景" });
  }

  it("lists what the conversation was handed, and says it when an item is gone or set aside", async () => {
    client.fetchSessionBackground.mockResolvedValue(structuredClone(background));
    const dialog = await openPanel();
    expect(await within(dialog).findByText("证据先用表格")).toBeInTheDocument();
    expect(within(dialog).getByText(/偏好 · 你说过 2 次 · 本次对话中用过 2 次/)).toBeInTheDocument();
    expect(within(dialog).getByText(/研究方法 · 来自记忆胶囊 · 本次对话中用过 · 本次不用/)).toBeInTheDocument();
    expect(within(dialog).getByText("这条记忆之后已被删除。")).toBeInTheDocument();
    expect(within(dialog).getByText(/学到的方法 · 本次对话中用过/)).toBeInTheDocument();
    expect(within(dialog).getByText("回答用中文")).toBeInTheDocument();
    // A gone memory offers no 「不对」: there is nothing left to stop.
    expect(within(dialog).getAllByRole("button", { name: "不对" })).toHaveLength(3);
  });

  it("「本次不用」 sets an item aside for this conversation only, and 「恢复使用」 brings it back", async () => {
    client.fetchSessionBackground.mockResolvedValue(structuredClone(background));
    client.setAsideForSession.mockResolvedValue({ incognito: false, excluded: [{ type: "memory", id: "rec_1", label: "证据先用表格" }] });
    client.bringBackForSession.mockResolvedValue({ incognito: false, excluded: [] });
    const dialog = await openPanel();
    await within(dialog).findByText("证据先用表格");
    const [first] = within(dialog).getAllByRole("button", { name: "本次不用" });
    await userEvent.click(first);
    expect(client.setAsideForSession).toHaveBeenCalledWith("ses_1", { type: "memory", id: "rec_1", label: "证据先用表格" });
    await userEvent.click(within(dialog).getByRole("button", { name: "恢复使用" }));
    expect(client.bringBackForSession).toHaveBeenCalledWith("ses_1", { type: "capsule", id: "fact_1", label: "先查肾功能" });
    const methodAside = within(dialog).getAllByRole("button", { name: "本次不用" }).at(-1)!;
    await userEvent.click(methodAside);
    expect(client.setAsideForSession).toHaveBeenLastCalledWith("ses_1", { type: "method", id: "renal-dosing", label: "" });
  });

  it("「不对」 stops the memory everywhere as a revision, and the toast's 撤销 takes it back", async () => {
    client.fetchSessionBackground.mockResolvedValue(structuredClone(background));
    client.archiveMemoryRecord.mockResolvedValue({ id: "rec_1", version: 4 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    client.retireLearnedMethod.mockResolvedValue({ id: "mth_1", revision: 3 });
    client.restoreLearnedMethod.mockResolvedValue({ id: "mth_1", revision: 4 });
    const dialog = await openPanel();
    await within(dialog).findByText("证据先用表格");
    const [memoryWrong, , methodWrong] = within(dialog).getAllByRole("button", { name: "不对" });
    await userEvent.click(memoryWrong);
    expect(client.archiveMemoryRecord).toHaveBeenCalledWith("rec_1", 3);
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("rec_1", 4));

    await userEvent.click(methodWrong);
    expect(client.retireLearnedMethod).toHaveBeenCalledWith("mth_1", 2);
    toasts.success.mock.calls.at(-1)![1].action.onClick();
    await waitFor(() => expect(client.restoreLearnedMethod).toHaveBeenCalledWith("mth_1", 3, 2));
  });

  it("undoes what this conversation wrote down, in one click", async () => {
    client.fetchSessionBackground.mockResolvedValue(structuredClone(background));
    client.undoMemoryRecord.mockResolvedValue({ undone: "removed", record: null, restored: [] });
    const dialog = await openPanel();
    await userEvent.click(await within(dialog).findByRole("button", { name: "撤销" }));
    expect(client.undoMemoryRecord).toHaveBeenCalledWith("rec_2", 1);
    await waitFor(() => expect(toasts.success).toHaveBeenLastCalledWith("已撤销：这条没有记下"));
  });

  it("has four states: loading, a failure with a retry, empty, and the lists", async () => {
    let fail = true;
    client.fetchSessionBackground.mockImplementation(async () => {
      if (fail) throw new Error("down");
      return { ...structuredClone(background), memories: [], methods: [], written: [] };
    });
    const dialog = await openPanel();
    expect(await within(dialog).findByText("暂时读不到这段对话的背景。对话本身不受影响。")).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(await within(dialog).findByText("这段对话还没有用到记忆或方法，也没有记下新内容。")).toBeInTheDocument();
  });
});
