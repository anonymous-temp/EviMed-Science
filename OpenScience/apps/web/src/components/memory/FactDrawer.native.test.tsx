import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { FactDrawer, memorySource } from "./FactDrawer";
import { factItems } from "./memoryItems";
import { nativeFile, nativeProfile, nativeProfileLine } from "./__fixtures__/memoryProfiles";

const api = vi.hoisted(() => ({ updateStructuredMemory: vi.fn(), deleteStructuredMemory: vi.fn() }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  updateStructuredMemory: api.updateStructuredMemory,
  deleteStructuredMemory: api.deleteStructuredMemory,
}));
const client = vi.hoisted(() => ({
  announceMemoryChanged: vi.fn(), archiveMemoryRecord: vi.fn(), undoMemoryRecord: vi.fn(), settleMemoryConflict: vi.fn(),
  retireCapsuleEntry: vi.fn(), undoCapsuleEntry: vi.fn(), fetchMemorySources: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
vi.mock("@/lib/sourceClient", () => ({ getSource: vi.fn() }));
vi.mock("@/lib/productClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/productClient")>("@/lib/productClient")), updateCapsuleEntry: vi.fn(), productErrorMessage: () => "操作未完成，请重试。" }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: vi.fn() }) } }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div data-testid="file-text">{children}</div> }));
vi.mock("./RelatedSection", () => ({ RelatedSection: () => null }));

function show(record: ReturnType<typeof nativeFile>, props: Record<string, unknown> = {}) {
  const [item] = factItems([record], []);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<MemoryRouter><FactDrawer item={item} projectName={null} onClose={onClose} onChanged={onChanged} {...props} /></MemoryRouter>);
  return { onChanged, onClose, record };
}

describe("a memory kept as a file, opened from its row", () => {
  beforeEach(() => { vi.clearAllMocks(); client.fetchMemorySources.mockResolvedValue([]); });
  afterEach(cleanup);

  it("shows the file as it is written, edits all of it and sends the words with the version, never a summary", async () => {
    const file = nativeFile("回答结构", "- 先给结论，再给依据。\n- 表格不超过五列。");
    api.updateStructuredMemory.mockResolvedValue({ ...file, id: file.id });
    const { onChanged } = show(file);
    expect(screen.getByRole("dialog", { name: "偏好" })).toBeInTheDocument();
    expect(screen.getByTestId("file-text").textContent).toBe("- 先给结论，再给依据。\n- 表格不超过五列。");
    // The topic leads, as a line of its own, so the file is read as what it is about.
    expect(within(screen.getByRole("dialog")).getByText("回答结构")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const box = screen.getByRole("textbox", { name: "编辑这条记忆" });
    expect(box).toHaveValue("- 先给结论，再给依据。\n- 表格不超过五列。");
    await userEvent.clear(box);
    await userEvent.type(box, "- 先给结论。");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledTimes(1));
    const [record, update] = api.updateStructuredMemory.mock.calls[0];
    expect(record).toBe(file);
    expect(update.value).toBe("- 先给结论。");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("says a save raced a change in one sentence, and reads the list again so the next try starts from what the memory says now", async () => {
    api.updateStructuredMemory.mockRejectedValue(new WebApiError("changed", { status: 409, code: "memory_conflict" }));
    const { onChanged } = show(nativeFile("回答结构", "- 先给结论。"));
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByRole("textbox", { name: "编辑这条记忆" }), "再补一条");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("这条记忆刚刚被更新过，已按最新内容刷新，请再改一次。"));
    expect(onChanged).toHaveBeenCalled();
    // The words typed are still in the box.
    expect(screen.getByRole("textbox", { name: "编辑这条记忆" })).toHaveValue("- 先给结论。再补一条");
  });

  it("forgets with the version the file has now, and the toast's undo names the version the forget returned", async () => {
    const file = nativeFile("回答结构", "- 先给结论。");
    client.archiveMemoryRecord.mockResolvedValue({ ...file, status: "archived", version: 99 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: file, restored: [] });
    const { onClose } = show(file);
    await userEvent.click(screen.getByRole("button", { name: "忘记" }));
    await waitFor(() => expect(client.archiveMemoryRecord).toHaveBeenCalledWith(file.id, file.version));
    expect(onClose).toHaveBeenCalled();
    const [, options] = toasts.success.mock.calls[0];
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith(file.id, 99));
  });

  it("names the conversation a memory came out of, without a quotation the engine never kept", () => {
    const file = nativeFile("回答结构", "- 先给结论。", { evidence: [
      { sourceType: "conversation", sourceRef: "sessions/session_ab12/commits/archive_001", quote: "", observedAt: "2026-10-12T02:00:00Z", weight: 1, fingerprint: "revision:7", projectId: "prj_7" },
    ], evidenceCount: 1 });
    show(file, { conversations: { session_ab12: "三期临床试验方案" } });
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("button", { name: /^来源对话：《三期临床试验方案》（\d+月\d+日）$/ })).toBeInTheDocument();
    expect(within(drawer).queryByText("“”")).not.toBeInTheDocument();
    expect(drawer.textContent).not.toMatch(/commits|archive_|session_ab12|revision/);
    // A conversation the control plane could not name is still the link back to it.
    cleanup();
    show(file);
    expect(screen.getByRole("button", { name: /^来源对话（/ })).toBeInTheDocument();
    // And a memory with no conversation has no such line.
    cleanup();
    show(nativeFile("回答结构", "- 先给结论。"));
    expect(screen.queryByRole("button", { name: /^来源对话/ })).not.toBeInTheDocument();
  });

  it("opens the conversation in the project it was held in, even for a memory that belongs to no project", () => {
    const file = nativeFile("回答结构", "- 先给结论。", { evidence: [
      { sourceType: "conversation", sourceRef: "sessions/session_ab12/commits/archive_001", quote: "", observedAt: "2026-10-12T02:00:00Z", weight: 1, fingerprint: "revision:7", projectId: "prj_7" },
    ], evidenceCount: 1 });
    expect(memorySource(file)).toEqual({ sessionId: "session_ab12", at: "2026-10-12T02:00:00Z", projectId: "prj_7" });
    expect(memorySource(nativeFile("回答结构", "- 先给结论。"))).toBeNull();
  });

  it("shows nothing of the engine: no address, no file name, no kind of account", () => {
    show(nativeFile("回答结构", "- 先给结论。"));
    expect(document.body.textContent).not.toMatch(/viking|\.md|native|legacy|OpenViking|engine|uri/i);
  });
});

describe("a line of the profile, opened from its row", () => {
  beforeEach(() => { vi.clearAllMocks(); client.fetchMemorySources.mockResolvedValue([]); });
  afterEach(cleanup);

  it("shows the line, and the other lines of the document it is a line of, each opening in this drawer", async () => {
    const lines = nativeProfile.records.filter((record) => record.document);
    const onOpenRecord = vi.fn();
    show(lines[0], { siblings: nativeProfile.records, onOpenRecord, canOpenRecord: () => true });
    const drawer = screen.getByRole("dialog", { name: "背景" });
    expect(within(drawer).getAllByText("临床药师，关注老年人慢病管理。")).toHaveLength(1);
    const others = within(drawer).getByText("个人档案里的其他内容").closest("section")!;
    expect(within(others).getAllByRole("button")).toHaveLength(2);
    await userEvent.click(within(others).getByRole("button", { name: "所在科室是临床药学部。" }));
    expect(onOpenRecord).toHaveBeenCalledWith(lines[1].id);
    // A file has no such section.
    cleanup();
    show(nativeFile("回答结构", "- 先给结论。"), { siblings: nativeProfile.records });
    expect(screen.queryByText("个人档案里的其他内容")).not.toBeInTheDocument();
  });

  it("follows an edited line to its new name: the drawer reopens on the line the save answered with", async () => {
    const [line] = nativeProfile.records.filter((record) => record.document);
    const renamed = nativeProfileLine("临床药师，关注抗栓治疗。");
    api.updateStructuredMemory.mockResolvedValue(renamed);
    const onOpenRecord = vi.fn();
    show(line, { onOpenRecord });
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const box = screen.getByRole("textbox", { name: "编辑这条记忆" });
    await userEvent.clear(box);
    await userEvent.type(box, "临床药师，关注抗栓治疗。");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenRecord).toHaveBeenCalledWith(renamed.id));
    expect(api.updateStructuredMemory.mock.calls[0][1].value).toBe("临床药师，关注抗栓治疗。");
  });
});
