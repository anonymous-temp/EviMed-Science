import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRecordRow } from "./MemoryRecordRow";

const api = vi.hoisted(() => ({ updateStructuredMemory: vi.fn(), deleteStructuredMemory: vi.fn() }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  updateStructuredMemory: api.updateStructuredMemory,
  deleteStructuredMemory: api.deleteStructuredMemory,
  webErrorMessage: (_error: unknown, overrides?: { fallback?: string }) => overrides?.fallback ?? "操作未完成，请重试。",
}));
const client = vi.hoisted(() => ({ announceMemoryChanged: vi.fn(), archiveMemoryRecord: vi.fn(), undoMemoryRecord: vi.fn() }));
vi.mock("@/lib/memoryClient", () => client);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

/** A structured record with only the fields a row reads. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem_1", scope: "user", scopeId: "", kind: "preference", key: "preference.x",
    value: "", summary: "证据先用表格", status: "active", origin: "explicit",
    confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 1,
    evidence: [], revisions: [], version: 1, createdAt: null, updatedAt: null, lastConfirmedAt: null, expiresAt: null,
    provenance: { basis: "stated", observations: 2, runs: 2, conversations: 1 },
    ...overrides,
  } as never;
}

function row(overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ul><MemoryRecordRow record={record(overrides)} origin="关于你" onChanged={onChanged} {...props} /></ul>
    </MemoryRouter>,
  );
  return onChanged;
}

const inferred = { provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } };

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: "更多" }));
  return screen.findByRole("menu");
}

describe("one memory, as one row", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("is where it belongs and one sentence, and nothing about how often it was seen or used", () => {
    row({}, { usage: { count: 7, lastUsedAt: "2026-09-18T00:00:00.000Z" } });
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("关于你")).toBeInTheDocument();
    expect(within(item).getByText("证据先用表格")).toBeInTheDocument();
    expect(item.textContent).toBe("关于你证据先用表格");
  });

  it("ends an inference with a small grey 「推断」, and a statement with nothing", () => {
    row(inferred);
    expect(screen.getByText("推断")).toHaveClass("text-meta", "text-text-3");
    cleanup();
    row();
    expect(screen.queryByText("推断")).not.toBeInTheDocument();
  });

  // Eleven whole `<evimed-brief>` task briefs were once stored as durable
  // preferences and rendered verbatim, tag and all (2026-09-16 review, M1).
  it("shows a stored brief without the machine's envelope, and never as the researcher's word", () => {
    row({ summary: "<evimed-brief> 请以《某某》为题完成证据评审。</evimed-brief>" });
    expect(screen.getByText("请以《某某》为题完成证据评审。")).toBeInTheDocument();
    expect(screen.getByText("推断")).toBeInTheDocument();
  });

  it("opens to the words it rests on, the versions it had and the conversation it came from", async () => {
    row({
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1",
        quote: "请用中文回答。", observedAt: "2026-09-12T08:00:00.000Z", weight: 1 }],
      revisions: [{ version: 1, value: "证据先用列表", summary: "证据先用列表", status: "active", changedAt: "2026-09-10T08:00:00.000Z", reason: "x", by: "user" }],
      version: 2,
    });
    const title = screen.getByRole("button", { name: /证据先用表格/ });
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("“请用中文回答。”")).not.toBeInTheDocument();
    await userEvent.click(title);
    expect(screen.getByText("“请用中文回答。”")).toBeInTheDocument();
    expect(screen.getByText(/你改的：证据先用列表/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "来源对话" })).toHaveAttribute("href", "/app/chat/ses_9");
    // Never the store's own references.
    expect(screen.queryByText(/conversation_message|sessions\/ses_9/)).not.toBeInTheDocument();
  });

  // One memory, one line (2026-09-23 plan §5.6): a row that opens shows the
  // first line of its sentence until it is opened; a row with nothing to open
  // is never cut, since nothing else would show the rest.
  it("shows one line of a sentence it opens to, and the whole of one it cannot open", async () => {
    const long = "排除标准第 3 条在题录层级无法判定时记为待定，不硬判；全文阶段再由两名评审独立判定。";
    row({ summary: long, evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "原话", observedAt: null, weight: 1 }] });
    const sentence = screen.getByText(long);
    expect(sentence).toHaveClass("line-clamp-2");
    expect(sentence).not.toHaveClass("sm:line-clamp-1");
    await userEvent.click(screen.getByRole("button", { name: /排除标准第 3 条/ }));
    expect(sentence).not.toHaveClass("line-clamp-2");
    cleanup();
    row({ summary: long });
    expect(screen.getByText(long)).not.toHaveClass("line-clamp-2");
  });

  it("「忘记」 archives at once, and the toast's 撤销 takes it back", async () => {
    client.archiveMemoryRecord.mockResolvedValue({ id: "mem_1", version: 2 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    const onChanged = row();
    await userEvent.click(screen.getByRole("button", { name: "忘记" }));
    expect(client.archiveMemoryRecord).toHaveBeenCalledWith("mem_1", 1);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [message, options] = toasts.success.mock.calls.at(-1)!;
    expect(message).toBe("已忘记");
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 2));
  });

  it("「编辑」 changes it in place", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    row();
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const field = screen.getByRole("textbox", { name: "编辑这条记忆" });
    await userEvent.clear(field);
    await userEvent.type(field, "证据先用森林图");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem_1" }), { value: "证据先用森林图", summary: "证据先用森林图", status: "active" }));
    expect(toasts.success).toHaveBeenCalledWith("已保存");
  });

  it("offers 「不对」 in the 「⋯」 of an inference and of nothing the researcher said", async () => {
    row(inferred);
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "不对" })).toHaveClass("text-danger");
    cleanup();
    row({ evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/s/messages/m", quote: "q", observedAt: null, weight: 1 }] });
    const plain = await openMenu();
    expect(within(plain).queryByRole("menuitem", { name: "不对" })).not.toBeInTheDocument();
  });

  it("「不对」 deletes only after asking, and says what the gentler option is", async () => {
    api.deleteStructuredMemory.mockResolvedValue(undefined);
    row(inferred);
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "不对" }));
    const dialog = await screen.findByRole("alertdialog", { name: "这条推断不对？" });
    expect(dialog).toHaveTextContent("之后也不再推断出来");
    expect(dialog).toHaveTextContent("请选「忘记」");
    expect(api.deleteStructuredMemory).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.deleteStructuredMemory).toHaveBeenCalledWith("mem_1"));
  });

  it("offers to undo the last change, in the 「⋯」, only where there is one", async () => {
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    row({ version: 3, revisions: [{ version: 2, value: "表格优先", summary: "表格优先", status: "active", changedAt: null, reason: "x", by: "extraction" }] });
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "撤销上次改动" }));
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 3));
    expect(client.announceMemoryChanged).toHaveBeenCalled();
    cleanup();
    row();
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();
  });

  it("a forgotten row offers only the way back", async () => {
    api.updateStructuredMemory.mockResolvedValue({});
    row({ status: "archived" });
    expect(screen.queryByRole("button", { name: "忘记" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledWith(expect.objectContaining({ id: "mem_1" }), { status: "active" }));
  });

  it("keeps a medicine-safety hold visible, and asks before a sensitive one takes effect, by either path", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    row({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true });
    expect(screen.getByText("待确认（用药安全）")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认这条敏感记忆？" });
    // Both recall paths drop a sensitive record whatever its status.
    expect(dialog).toHaveTextContent("敏感记忆不会被自动调取到后续研究中");
    expect(api.updateStructuredMemory).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "确认保留" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem_sensitive" }), expect.objectContaining({ status: "active" })));

    // 编辑 goes through the same dialog.
    cleanup();
    vi.clearAllMocks();
    row({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true });
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("确认这条敏感记忆？")).toBeInTheDocument();
    expect(api.updateStructuredMemory).not.toHaveBeenCalled();
  });
});
