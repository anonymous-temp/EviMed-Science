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
  retireCapsuleEntry: vi.fn(), undoCapsuleEntry: vi.fn(), fetchMemorySources: vi.fn(),
}));
vi.mock("@/lib/memoryClient", () => client);
const sources = vi.hoisted(() => ({ getSource: vi.fn() }));
vi.mock("@/lib/sourceClient", () => sources);
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
  beforeEach(() => { vi.clearAllMocks(); client.fetchMemorySources.mockResolvedValue([]); });
  afterEach(cleanup);

  // Owner ruling of 2026-10-10 (review R9): whose words a memory is, is not said on the page — not for what the researcher said,
  // not for what was learned from a conversation. The drawer says what it is and since when.
  it("says what it is and since when, and nothing of whose words it is, and shows the sentence whole", () => {
    open(fact());
    const drawer = screen.getByRole("dialog", { name: "偏好" });
    expect(within(drawer).getByText("证据先用表格")).toBeInTheDocument();
    expect(within(drawer).getByText("9月12日")).toBeInTheDocument();
    cleanup();
    open(fact(inferred), { projectName: "疳证 Meta 文献检索" });
    expect(screen.getByText("疳证 Meta 文献检索 · 9月12日")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/你说的|你确认的|你改过的|从对话中学到|推断|助手|未经/);
  });

  // Eleven whole `<evimed-brief>` task briefs were once stored as durable
  // preferences and rendered verbatim, tag and all (2026-09-16 review, M1).
  it("shows a stored brief without the machine's envelope", () => {
    open(fact({ summary: "<evimed-brief> 请以《某某》为题完成证据评审。</evimed-brief>" }));
    expect(screen.getByText("请以《某某》为题完成证据评审。")).toBeInTheDocument();
  });

  it("shows the words it rests on, the versions it had, and a link to the conversation it came from — only here", async () => {
    open(fact({
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1",
        quote: "请用中文回答。", observedAt: "2026-09-12T08:00:00.000Z", weight: 1 }],
      revisions: [{ version: 1, value: "证据先用列表", summary: "证据先用列表", status: "active", changedAt: "2026-09-10T08:00:00.000Z", reason: "x", by: "user" }],
      version: 2,
    }));
    expect(screen.getByText("“请用中文回答。”")).toBeInTheDocument();
    // The earlier wording and when it changed; who made the change is not said (R11).
    expect(screen.getByText(/：证据先用列表/)).toBeInTheDocument();
    expect(screen.queryByText(/你改的|系统整理|从对话中学到/)).not.toBeInTheDocument();
    expect(screen.getByText("以前的版本")).toBeInTheDocument();
    // Never the store's own references.
    expect(screen.queryByText(/conversation_message|sessions\/ses_9/)).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/app/memory");
    // The conversation is dated by the observation that named it.
    await userEvent.click(screen.getByRole("button", { name: "来源对话（9月12日）" }));
    // A user-scope memory opens its conversation in the project the shell is in, and only when the link is clicked.
    expect(screen.getByTestId("where")).toHaveTextContent("/app/chat/ses_9");
    expect(navigation.select).not.toHaveBeenCalled();
  });

  it("moves the shell to the project a project's fact came from before opening its conversation", async () => {
    navigation.select.mockImplementation(async (_id: string, land: () => void) => { land(); });
    open(fact({ scope: "project", scopeId: "prj_9", kind: "project_fact",
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "q", observedAt: null, weight: 1 }] }));
    await userEvent.click(screen.getByRole("button", { name: /^来源对话/ }));
    expect(navigation.select).toHaveBeenCalledWith("prj_9", expect.any(Function));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/app/chat/ses_9"));
  });

  it("says so, and stays where it was, when the project of a conversation cannot be opened", async () => {
    navigation.select.mockRejectedValue(new Error("gone"));
    open(fact({ scope: "project", scopeId: "prj_gone", kind: "project_fact",
      evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "q", observedAt: null, weight: 1 }] }));
    await userEvent.click(screen.getByRole("button", { name: /^来源对话/ }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("原始研究暂不可用"));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/memory");
  });

  it("draws how long a memory held when there is something to say: a version behind it, or an end", () => {
    // Made today, never changed: the date under the title is all there is to say.
    open(fact({ createdAt: new Date().toISOString() }));
    expect(screen.queryByRole("img", { name: /^有效期/ })).not.toBeInTheDocument();
    cleanup();
    // Replaced on 10-03 after one change on 09-20: begun 09-12, ended 10-03, one tick between.
    open(fact({
      status: "superseded", invalidSince: "2026-10-03T02:00:00Z", version: 2,
      revisions: [{ version: 1, value: "旧", summary: "旧", status: "active", changedAt: "2026-09-20T02:00:00Z", reason: "x" }],
    }, []));
    const bar = screen.getByRole("img", { name: "有效期：9月12日起，10月3日止，中间改过 1 次" });
    expect(within(bar.parentElement!).getByText("9月12日")).toBeInTheDocument();
    expect(within(bar.parentElement!).getByText("10月3日")).toBeInTheDocument();
    expect(bar.querySelectorAll("span")).toHaveLength(2);
    cleanup();
    // Still holding, changed once: it runs to today.
    open(fact({ revisions: [{ version: 1, value: "旧", summary: "旧", status: "active", changedAt: "2026-09-20T02:00:00Z", reason: "x" }], version: 2 }));
    const holding = screen.getByRole("img", { name: /^有效期：9月12日起，至今/ });
    expect(within(holding.parentElement!).getByText("至今")).toBeInTheDocument();
  });

  it("names the knowledge-base documents a memory rests on and opens them on their own page", async () => {
    client.fetchMemorySources.mockResolvedValue([
      { type: "doi", id: "10.1000/x", state: "current" },
      { type: "knowledge_source", id: "src_abc", state: "current" },
      { type: "knowledge_source", id: "src_gone", state: "current" },
    ]);
    sources.getSource.mockImplementation(async (id: string) => {
      if (id === "src_gone") throw new Error("404");
      return { id, display: { title: "ARISTOTLE 试验全文" } };
    });
    open(fact({ evidence: [{ fingerprint: "f1", sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "q", observedAt: null, weight: 1 }] }));
    const link = await screen.findByRole("link", { name: "依据的资料：《ARISTOTLE 试验全文》" });
    expect(link).toHaveAttribute("href", "/app/files/src_abc");
    expect(client.fetchMemorySources).toHaveBeenCalledWith("mem_1");
    // A document the reader cannot open is not offered, and a published work is not a document of theirs.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(sources.getSource).toHaveBeenCalledTimes(2);
  });

  it("stands without the sources when they cannot be read", async () => {
    client.fetchMemorySources.mockRejectedValue(new Error("503"));
    open(fact());
    await waitFor(() => expect(client.fetchMemorySources).toHaveBeenCalled());
    expect(screen.getByText("证据先用表格")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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

  // Review R10: the item used to appear only on what was learned from a conversation, so having it said the memory was an inference.
  it("offers 「不再记这条」 in the 「⋯」 of every memory, so that having it says nothing about where the memory came from", async () => {
    open(fact(inferred));
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "不再记这条" })).toHaveClass("text-danger");
    cleanup();
    open(fact());
    const plain = await openMenu();
    expect(within(plain).getByRole("menuitem", { name: "不再记这条" })).toBeInTheDocument();
  });

  it("「不再记这条」 deletes only after asking, and says what the gentler option is", async () => {
    api.deleteStructuredMemory.mockResolvedValue(undefined);
    const { onClose } = open(fact(inferred));
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "不再记这条" }));
    const dialog = await screen.findByRole("alertdialog", { name: "不再记这条？" });
    expect(dialog).toHaveTextContent("删除后也不会再记下类似的内容");
    expect(dialog).toHaveTextContent("请选“忘记”");
    expect(dialog.textContent).not.toMatch(/推断/);
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
    // The 「⋯」 of a memory always holds 「不再记这条」; the undo is in it only once there is a change to take back.
    expect(within(await openMenu()).queryByRole("menuitem", { name: "撤销上次改动" })).not.toBeInTheDocument();
  });

  // Review R12 (owner ruling of 2026-10-10): the medicine-safety hold is retired, so what waits to be confirmed is a proposal an
  // outside agent made, and it says only that. A sensitive one still says what confirming does before it does it.
  it("shows what waits to be confirmed in plain words, and asks before a sensitive one takes effect, by either path", async () => {
    api.updateStructuredMemory.mockImplementation(async (value: object, update: object) => ({ ...value, ...update }));
    open(fact({ id: "mem_sensitive", summary: "我在服用某种药物。", status: "pending", sensitive: true }));
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/用药安全/);
    await userEvent.click(screen.getByRole("button", { name: "确认" }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认这条敏感记忆？" });
    // Both recall paths drop a sensitive record whatever its status.
    expect(dialog).toHaveTextContent("敏感记忆不会被自动用于后续研究");
    expect(dialog.textContent).not.toMatch(/隐私保护/);
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

  it("is the same drawer: its words, its date, 编辑 and 忘记", () => {
    open(note());
    const drawer = screen.getByRole("dialog", { name: "写作习惯" });
    expect(within(drawer).getByText("引用写到页码。")).toBeInTheDocument();
    expect(within(drawer).getByText("9月14日")).toBeInTheDocument();
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

  it("forgets it with an undo, and says nothing of whether it was the researcher's own word", async () => {
    client.retireCapsuleEntry.mockResolvedValue({ id: "entry_1", revision: 2 });
    client.undoCapsuleEntry.mockResolvedValue({ undone: "restored", entry: {} });
    const { onClose } = open(note({ payload: { capsuleId: "cap_1", factKind: "preference", layer: "profile", content: "偏好表格。", status: "approved", origin: "inferred", provenance: [] } }));
    expect(screen.getByText("9月14日")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/从对话中学到|你说的|推断/);
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
