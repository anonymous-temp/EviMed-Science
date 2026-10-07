import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactDrawer, memorySource } from "./FactDrawer";
import type { FactItem } from "./memoryItems";

const api = vi.hoisted(() => ({ updateStructuredMemory: vi.fn(), deleteStructuredMemory: vi.fn() }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")),
  updateStructuredMemory: api.updateStructuredMemory,
  deleteStructuredMemory: api.deleteStructuredMemory,
  webErrorMessage: (_error: unknown, overrides?: { fallback?: string }) => overrides?.fallback ?? "操作未完成，请重试。",
}));
const client = vi.hoisted(() => ({
  announceMemoryChanged: vi.fn(), archiveMemoryRecord: vi.fn(), undoMemoryRecord: vi.fn(), settleMemoryConflict: vi.fn(),
  retireCapsuleEntry: vi.fn(), undoCapsuleEntry: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const product = vi.hoisted(() => ({ updateCapsuleEntry: vi.fn() }));
vi.mock("@/lib/productClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/productClient")>("@/lib/productClient")),
  updateCapsuleEntry: product.updateCapsuleEntry,
  productErrorMessage: () => "操作未完成，请重试。",
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));
const navigation = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/projects", () => ({ useProjectStore: { getState: () => ({ select: navigation.select }) } }));

/** A structured record with only the fields a drawer reads. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem_1", scope: "user", scopeId: "", kind: "preference", key: "preference.x",
    value: "", summary: "证据先用表格", status: "active", origin: "explicit",
    confidence: 1, importance: 0.5, sensitive: false, evidenceCount: 1,
    evidence: [], revisions: [], version: 1, createdAt: "2026-09-12T02:00:00Z", updatedAt: "2026-09-12T02:00:00Z", lastConfirmedAt: null, expiresAt: null,
    provenance: { basis: "stated", observations: 2, runs: 2, conversations: 1 },
    ...overrides,
  } as never;
}

function fact(overrides: Record<string, unknown> = {}, formerly: unknown[] = []): FactItem {
  const stored = record(overrides) as { summary: string };
  return { kind: "record", key: "record:mem_1", group: "self", section: "preference", projectId: null, at: "", text: stored.summary, record: stored, formerly } as never;
}

/** Where the router is, so a test can say where a click went. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function open(item: FactItem, props: Record<string, unknown> = {}) {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<MemoryRouter initialEntries={["/app/memory"]}><FactDrawer item={item} projectName={null} onClose={onClose} onChanged={onChanged} {...props} /><Where /></MemoryRouter>);
  return { onChanged, onClose };
}

const inferred = { provenance: { basis: "inferred", observations: 1, runs: 1, conversations: 1 } };

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: "更多" }));
  return screen.findByRole("menu");
}

describe("one memory, opened from its row", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  it("says what it is, whose words it is and since when — once, in a sentence — and shows the sentence whole", () => {
    open(fact());
    const drawer = screen.getByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText("证据先用表格")).toBeInTheDocument();
    expect(within(drawer).getByText("你说的 · 9月12日")).toBeInTheDocument();
    expect(within(drawer).queryByText("推断")).not.toBeInTheDocument();
    cleanup();
    open(fact(inferred), { projectName: "疳证 Meta 文献检索" });
    expect(screen.getByText("疳证 Meta 文献检索 · 从对话中学到 · 9月12日")).toBeInTheDocument();
  });

  // Eleven whole `<evimed-brief>` task briefs were once stored as durable
  // preferences and rendered verbatim, tag and all (2026-09-16 review, M1).
  it("shows a stored brief without the machine's envelope, and never as the researcher's word", () => {
    open(fact({ summary: "<evimed-brief> 请以《某某》为题完成证据评审。</evimed-brief>" }));
    expect(screen.getByText("请以《某某》为题完成证据评审。")).toBeInTheDocument();
    expect(screen.getByText(/从对话中学到/)).toBeInTheDocument();
  });

  it("shows the words it rests on, the versions it had, and a link to the conversation it came from — only here", async () => {
    open(fact({
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1",
        quote: "请用中文回答。", observedAt: "2026-09-12T08:00:00.000Z", weight: 1 }],
      revisions: [{ version: 1, value: "证据先用列表", summary: "证据先用列表", status: "active", changedAt: "2026-09-10T08:00:00.000Z", reason: "x", by: "user" }],
      version: 2,
    }));
    expect(screen.getByText("“请用中文回答。”")).toBeInTheDocument();
    expect(screen.getByText(/你改的：证据先用列表/)).toBeInTheDocument();
    expect(screen.getByText("以前的版本")).toBeInTheDocument();
    // Never the store's own references.
    expect(screen.queryByText(/conversation_message|sessions\/ses_9/)).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/memory");
    await userEvent.click(screen.getByRole("button", { name: "来源对话" }));
    // A user-scope memory opens its conversation in the project the shell is in, and only when the link is clicked.
    expect(screen.getByTestId("where")).toHaveTextContent("/app/chat/ses_9");
    expect(navigation.select).not.toHaveBeenCalled();
  });

  it("moves the shell to the project a project's fact came from before opening its conversation", async () => {
    navigation.select.mockImplementation(async (_id: string, land: () => void) => { land(); });
    open(fact({ scope: "project", scopeId: "prj_9", kind: "project_fact",
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "q", observedAt: null, weight: 1 }] }));
    await userEvent.click(screen.getByRole("button", { name: "来源对话" }));
    expect(navigation.select).toHaveBeenCalledWith("prj_9", expect.any(Function));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/chat/ses_9"));
  });

  it("says so, and stays where it was, when the project of a conversation cannot be opened", async () => {
    navigation.select.mockRejectedValue(new Error("gone"));
    open(fact({ scope: "project", scopeId: "prj_gone", kind: "project_fact",
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "q", observedAt: null, weight: 1 }] }));
    await userEvent.click(screen.getByRole("button", { name: "来源对话" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("原始研究暂不可用"));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/memory");
  });

  it("finds the conversation a memory came out of from its first evidence", () => {
    expect(memorySource(record({ evidence: [{ sourceRef: "sessions/ses_9/messages/m1", observedAt: "2026-09-12T08:00:00.000Z" }] }))).toEqual({ sessionId: "ses_9", at: "2026-09-12T08:00:00.000Z" });
    expect(memorySource(record({ evidence: [{ sourceRef: "tools/x", observedAt: null }] }))).toBeNull();
  });

  it("「忘记」 archives at once, closes, and the toast's 撤销 takes it back", async () => {
    client.archiveMemoryRecord.mockResolvedValue({ id: "mem_1", version: 2 });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    const { onChanged, onClose } = open(fact());
    await userEvent.click(screen.getByRole("button", { name: "忘记" }));
    expect(client.archiveMemoryRecord).toHaveBeenCalledWith("mem_1", 1);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const [message, options] = toasts.success.mock.calls.at(-1)!;
    expect(message).toBe("已忘记");
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 2));
  });

  it("「编辑」 changes it in place, in the drawer", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    open(fact());
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const field = screen.getByRole("textbox", { name: "编辑这条记忆" });
    await userEvent.clear(field);
    await userEvent.type(field, "证据先用森林图");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateStructuredMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem_1" }), { value: "证据先用森林图", summary: "证据先用森林图", status: "active" }));
    expect(toasts.success).toHaveBeenCalledWith("已保存");
  });

  it("offers 「这不对」 in the 「⋯」 of what EviMed learned, and not of what the researcher said", async () => {
    open(fact(inferred));
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "这不对" })).toHaveClass("text-danger");
    cleanup();
    open(fact({ revisions: [{ version: 1, value: "a", summary: "a", status: "active", changedAt: null, reason: "x" }] }));
    const plain = await openMenu();
    expect(within(plain).queryByRole("menuitem", { name: "这不对" })).not.toBeInTheDocument();
  });

  it("「这不对」 deletes only after asking, and says what the gentler option is", async () => {
    api.deleteStructuredMemory.mockResolvedValue(undefined);
    const { onClose } = open(fact(inferred));
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "这不对" }));
    const dialog = await screen.findByRole("alertdialog", { name: "这条推断不对？" });
    expect(dialog).toHaveTextContent("之后也不再推断出来");
    expect(dialog).toHaveTextContent("请选“忘记”");
    expect(api.deleteStructuredMemory).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.deleteStructuredMemory).toHaveBeenCalledWith("mem_1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("offers to undo the last change, in the 「⋯」, only where there is one", async () => {
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    open(fact({ version: 3, revisions: [{ version: 2, value: "表格优先", summary: "表格优先", status: "active", changedAt: null, reason: "x", by: "extraction" }] }));
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "撤销上次改动" }));
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_1", 3));
    expect(client.announceMemoryChanged).toHaveBeenCalled();
    cleanup();
    open(fact());
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();
  });

  it("keeps a medicine-safety hold visible, and asks before a sensitive one takes effect, by either path", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    open(fact({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true }));
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
    open(fact({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true }));
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("确认这条敏感记忆？")).toBeInTheDocument();
    expect(api.updateStructuredMemory).not.toHaveBeenCalled();
  });

  it("shows a fact another replaced as what it was, and does not offer to edit what is no longer in force", () => {
    open(fact({ status: "superseded", supersededBy: "mem_9", invalidSince: "2026-09-01T00:00:00Z", createdAt: "2026-03-02T00:00:00Z" }));
    expect(screen.getByText(/曾经如此：证据先用表格（3月2日～9月1日）/)).toBeInTheDocument();
    expect(screen.getByText("已被替代")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "忘记" })).toBeInTheDocument();
  });
});

// F1: what N13 recorded about a memory — a disagreement, an interval, a source
// that changed — is in its drawer, and a disagreement is the researcher's to settle.
describe("a memory that is uncertain says why, and a disagreement is settled by the researcher", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  const side = (patch: Record<string, unknown> = {}) => ({
    id: "mem_2", status: "active", scope: "user", scopeId: "", origin: "inferred", sensitive: false,
    text: "证据先用列表", createdAt: "2026-09-01T00:00:00Z", ...patch,
  });
  const relations = (patch: Record<string, unknown> = {}) => ({
    validity: { from: null, until: null }, caveats: [], conflicts: [], sources: [], ...patch,
  });

  it("says nothing on a memory with nothing to say", () => {
    open(fact({ relations: relations() }));
    expect(screen.queryByText("有冲突")).not.toBeInTheDocument();
    expect(screen.queryByText("和另一条说法不一致")).not.toBeInTheDocument();
  });

  it("labels each reason in a few words, and keeps the sentence", () => {
    open(fact({ relations: relations({ caveats: ["source_retracted", "source_expired", "source_changed", "not_yet_valid"],
      sources: [{ type: "doi", id: "10.1/a", state: "retracted" }] }) }));
    const drawer = screen.getByRole("dialog");
    for (const text of ["来源已撤回", "来源已过期", "来源已更改", "尚未生效"]) expect(within(drawer).getByText(text)).toBeInTheDocument();
    expect(within(drawer).getByText("证据先用表格")).toBeInTheDocument();
    // The interface does not explain the system: no identifier, no state name.
    expect(drawer.textContent).not.toMatch(/10\.1\/a|retracted|source_/);
  });

  it("shows the other statement of a disagreement and offers 「以这条为准」 on either side", async () => {
    client.settleMemoryConflict.mockResolvedValue({ kept: { id: "mem_1" }, superseded: { id: "mem_2", version: 5 } });
    client.undoMemoryRecord.mockResolvedValue({ undone: "restored", record: null, restored: [] });
    const { onChanged } = open(fact({ relations: relations({ caveats: ["conflict"], conflicts: [side()] }) }));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("有冲突")).toBeInTheDocument();
    expect(within(drawer).getByText("另一条：“证据先用列表”")).toBeInTheDocument();
    const choices = within(drawer).getAllByRole("button", { name: /^以这条为准/ });
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleName("以这条为准：证据先用表格");
    expect(choices[1]).toHaveAccessibleName("以这条为准：证据先用列表");

    // This statement holds: it is the one kept.
    await userEvent.click(choices[0]);
    await waitFor(() => expect(client.settleMemoryConflict).toHaveBeenCalledWith("mem_1", "mem_2"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The replaced statement is kept, and the toast takes the decision back.
    const [message, options] = toasts.success.mock.calls.at(-1)!;
    expect(message).toBe("已按这条为准");
    options.action.onClick();
    await waitFor(() => expect(client.undoMemoryRecord).toHaveBeenCalledWith("mem_2", 5));

    // The other statement holds: it is the one kept.
    await userEvent.click(choices[1]);
    await waitFor(() => expect(client.settleMemoryConflict).toHaveBeenLastCalledWith("mem_2", "mem_1"));
  });

  it("says so when it could not be settled, and changes nothing on the page", async () => {
    client.settleMemoryConflict.mockRejectedValue(new Error("refused"));
    const { onChanged } = open(fact({ relations: relations({ caveats: ["conflict"], conflicts: [side()] }) }));
    await userEvent.click(screen.getAllByRole("button", { name: /^以这条为准/ })[0]);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("操作未完成，请重试。"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not offer to settle against a memory still waiting for confirmation, nor show a sensitive one's words", () => {
    open(fact({ relations: relations({ caveats: ["conflict"], conflicts: [side({ status: "pending" })] }) }));
    expect(screen.getByText("另一条：“证据先用列表”")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^以这条为准/ })).not.toBeInTheDocument();
    cleanup();
    open(fact({ relations: relations({ caveats: ["conflict"], conflicts: [side({ sensitive: true, text: "" })] }) }));
    expect(screen.getByText("另一条：这是一条敏感记忆")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^以这条为准/ })).toHaveLength(2);
  });

  it("offers nothing to settle on a memory that is itself waiting", () => {
    open(fact({ status: "pending", relations: relations({ caveats: ["conflict"], conflicts: [side()] }) }));
    expect(screen.queryByRole("button", { name: /^以这条为准/ })).not.toBeInTheDocument();
  });
});

describe("a note of the researcher's own capsule, opened from its row", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(cleanup);

  function note(overrides: Record<string, unknown> = {}): FactItem {
    const entry = { id: "entry_1", revision: 1, createdAt: "2026-09-14T02:00:00Z", updatedAt: "2026-09-14T02:00:00Z", deletedAt: null, projectId: null,
      payload: { capsuleId: "cap_1", factKind: "writing_style", layer: "profile", content: "引用写到页码。", status: "approved", origin: "explicit", provenance: [] },
      ...overrides };
    return { kind: "entry", key: "entry:entry_1", group: "self", section: "habit", projectId: null, at: "", text: "引用写到页码。", entry } as never;
  }

  it("is the same drawer: its words, whose they are, 编辑 and 忘记", () => {
    open(note());
    const drawer = screen.getByRole("dialog", { name: "写作习惯" });
    expect(within(drawer).getByText("引用写到页码。")).toBeInTheDocument();
    expect(within(drawer).getByText("你说的 · 9月14日")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "忘记" })).toBeInTheDocument();
  });

  it("saves an edit through the capsule, with the revision it read", async () => {
    product.updateCapsuleEntry.mockResolvedValue({});
    open(note());
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const field = screen.getByRole("textbox", { name: "编辑这条记忆" });
    await userEvent.clear(field);
    await userEvent.type(field, "引用写到页码和行号。");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(product.updateCapsuleEntry).toHaveBeenCalledWith("cap_1", "entry_1", { content: "引用写到页码和行号。", expectedRevision: 1 }));
  });

  it("forgets it with an undo, and says it was inferred when it was not the researcher's own word", async () => {
    client.retireCapsuleEntry.mockResolvedValue({ id: "entry_1", revision: 2 });
    client.undoCapsuleEntry.mockResolvedValue({ undone: "restored", entry: {} });
    const { onClose } = open(note({ payload: { capsuleId: "cap_1", factKind: "preference", layer: "profile", content: "偏好表格。", status: "approved", origin: "inferred", provenance: [] } }));
    expect(screen.getByText("从对话中学到 · 9月14日")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "忘记" }));
    await waitFor(() => expect(client.retireCapsuleEntry).toHaveBeenCalledWith("cap_1", "entry_1", 1));
    expect(onClose).toHaveBeenCalled();
    const [, options] = toasts.success.mock.calls.at(-1)!;
    options.action.onClick();
    await waitFor(() => expect(client.undoCapsuleEntry).toHaveBeenCalledWith("cap_1", expect.objectContaining({ id: "entry_1", revision: 2 })));
  });

  it("offers to undo the last change only once it has had one", async () => {
    client.undoCapsuleEntry.mockResolvedValue({ undone: "restored", entry: {} });
    open(note({ revision: 3 }));
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "撤销上次改动" }));
    await waitFor(() => expect(client.undoCapsuleEntry).toHaveBeenCalled());
    cleanup();
    open(note());
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();
  });
});
