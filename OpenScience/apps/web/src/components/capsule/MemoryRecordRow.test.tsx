import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRecordRow } from "./MemoryRecordRow";

const api = vi.hoisted(() => ({ updateStructuredMemory: vi.fn(), deleteStructuredMemory: vi.fn() }));
vi.mock("@/lib/apiClient", () => ({
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
      <ul><MemoryRecordRow record={record(overrides)} onChanged={onChanged} {...props} /></ul>
    </MemoryRouter>,
  );
  return onChanged;
}

describe("one memory, as a line of the list", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("says where it came from, how established it is and how often it was used — counted, never a percentage", () => {
    row({}, { usage: { count: 7, lastUsedAt: "2026-09-18T00:00:00.000Z" } });
    expect(screen.getByText("证据先用表格")).toBeInTheDocument();
    expect(screen.getByText("你说的")).toBeInTheDocument();
    expect(screen.getByText("你说过 2 次")).toBeInTheDocument();
    expect(screen.getByText(/用过 7 次，上次/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("says plainly when a memory has never been used", () => {
    row();
    expect(screen.getByText("还没用过")).toBeInTheDocument();
  });

  it("links back to the conversation it came out of, with that conversation's own words", () => {
    row(
      { evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1",
        quote: "请用中文回答。", observedAt: "2026-09-12T08:00:00.000Z", weight: 1 }] },
      { conversationTitle: "阿司匹林一级预防" },
    );
    const link = screen.getByRole("link", { name: /来自 9月12日《阿司匹林一级预防》/ });
    expect(link).toHaveAttribute("href", "/app/chat/ses_9");
  });

  // Eleven whole `<evimed-brief>` task briefs were once stored as durable
  // preferences and rendered verbatim, tag and all (2026-09-16 review, M1).
  it("shows a stored brief without the machine's envelope, and says what it is", () => {
    row({ summary: "<evimed-brief> 请以《某某》为题完成证据评审。</evimed-brief>", provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } });
    expect(screen.getByText("请以《某某》为题完成证据评审。")).toBeInTheDocument();
    expect(screen.getByText("疑似任务题面，非你的陈述")).toBeInTheDocument();
  });

  it("shows the words a memory rests on, never the store's own references", async () => {
    row({ evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1",
      quote: "请用中文回答。", observedAt: "2026-09-16T08:00:00.000Z", weight: 1 }] });
    await userEvent.click(screen.getByText("依据与改动"));
    expect(screen.getByText("“请用中文回答。”")).toBeInTheDocument();
    expect(screen.queryByText(/conversation_message/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sessions\/s1/)).not.toBeInTheDocument();
  });

  it("「忘记」 archives at once, and the toast's 撤销 takes it back", async () => {
    client.archiveMemoryRecord.mockResolvedValue({ id: "mem_1", version: 2 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    const onChanged = row();
    await userEvent.click(screen.getByRole("button", { name: "忘记" }));
    expect(client.archiveMemoryRecord).toHaveBeenCalledWith("mem_1", 1);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 2));
  });

  it("offers 「不对」 on an inference and on nothing the researcher said", () => {
    row({ provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } });
    expect(screen.getByRole("button", { name: "不对" })).toBeInTheDocument();
    cleanup();
    row();
    expect(screen.queryByRole("button", { name: "不对" })).not.toBeInTheDocument();
  });

  it("a forgotten row is struck through and offers only the way back", () => {
    api.updateStructuredMemory.mockResolvedValue({});
    row({ status: "archived" });
    expect(screen.getByRole("button", { name: /恢复/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "忘记" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改" })).not.toBeInTheDocument();
  });

  it("offers to undo the last change only where there is one, and asks nothing first", async () => {
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    row({ version: 3, revisions: [{ version: 2, value: "表格优先", summary: "表格优先", status: "active", changedAt: null, reason: "x", by: "extraction" }] });
    await userEvent.click(screen.getByRole("button", { name: "撤销上次改动" }));
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 3));
    expect(client.announceMemoryChanged).toHaveBeenCalled();
    cleanup();
    row();
    expect(screen.queryByRole("button", { name: "撤销上次改动" })).not.toBeInTheDocument();
  });

  it("asks before a sensitive record held for a safety check takes effect, by either path, and tells the truth", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    row({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true });
    expect(screen.getByText("涉及用药安全，等你看过")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "是这样" }));
    expect(await screen.findByText("确认这条敏感记忆？")).toBeInTheDocument();
    // Both recall paths drop a sensitive record whatever its status.
    expect(screen.getByText(/敏感记忆不会被自动调取到后续研究中/)).toBeInTheDocument();
    expect(api.updateStructuredMemory).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "确认保留" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem_sensitive" }), expect.objectContaining({ status: "active" })));

    // 改 goes through the same dialog.
    cleanup();
    vi.clearAllMocks();
    row({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true });
    await userEvent.click(screen.getByRole("button", { name: "改" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("确认这条敏感记忆？")).toBeInTheDocument();
    expect(api.updateStructuredMemory).not.toHaveBeenCalled();
  });

  it("「不对」 deletes only after saying what goes, what stays, and what the gentler option is", async () => {
    api.deleteStructuredMemory.mockResolvedValue(undefined);
    row({ provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } });
    await userEvent.click(screen.getByRole("button", { name: "不对" }));
    expect(screen.getByText(/EviMed 也不会再凭推断把它记回来/)).toBeInTheDocument();
    expect(screen.getByText(/想只是先不用，选「忘记」/)).toBeInTheDocument();
    expect(api.deleteStructuredMemory).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("button", { name: "删除" }).at(-1)!);
    await waitFor(() => expect(api.deleteStructuredMemory).toHaveBeenCalledWith("mem_1"));
  });
});
