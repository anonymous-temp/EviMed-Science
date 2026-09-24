import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebStructuredMemory } from "@/lib/apiClient";
import { useProjectStore } from "@/lib/projects";
import { MemoryHubPage } from "./MemoryHubPage";

const fetchMemoryProfile = vi.fn();
const searchMemories = vi.fn();
const fetchMemorySettings = vi.fn();
const updateMemorySettings = vi.fn();
const resetMemory = vi.fn();
const fetchMyCapsule = vi.fn();
const listMethods = vi.fn();
const archiveMemoryRecord = vi.fn();

vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return {
    ...actual,
    getWebProjectId: () => "prj_1",
    fetchMemoryProfile: (...args: unknown[]) => fetchMemoryProfile(...args),
    searchMemories: (...args: unknown[]) => searchMemories(...args),
    fetchMemorySettings: (...args: unknown[]) => fetchMemorySettings(...args),
    updateMemorySettings: (...args: unknown[]) => updateMemorySettings(...args),
    resetMemory: (...args: unknown[]) => resetMemory(...args),
  };
});
vi.mock("@/lib/memoryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient");
  return {
    ...actual,
    ensureMyCapsule: () => Promise.resolve(null),
    fetchMyCapsule: (...args: unknown[]) => fetchMyCapsule(...args),
    archiveMemoryRecord: (...args: unknown[]) => archiveMemoryRecord(...args),
  };
});
vi.mock("@/lib/methodsClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient");
  return { ...actual, listMethods: (...args: unknown[]) => listMethods(...args) };
});
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("@/components/capsule/ReceivedShelf", () => ({ ReceivedShelf: () => <p>received shelf</p> }));
vi.mock("./CapsuleTransferPanel", () => ({ CapsuleTransferPanel: () => <p>transfer</p> }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

const record = (patch: Partial<WebStructuredMemory> = {}): WebStructuredMemory => ({
  id: "rec_1", scope: "user", scopeId: "", kind: "profile", key: "profile.who",
  value: "药学背景，关注老年人用药安全与抗栓治疗。", summary: "药学背景，关注老年人用药安全与抗栓治疗。",
  origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  evidenceCount: 1, version: 2, createdAt: "2026-09-12T02:00:00Z", updatedAt: "2026-09-12T02:00:00Z",
  lastConfirmedAt: null, expiresAt: null,
  provenance: { basis: "stated", observations: 3, runs: 1, conversations: 2 },
  evidence: [{ sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/u1", quote: "我是临床药师",
    observedAt: "2026-09-12T02:00:00Z", weight: 1, fingerprint: "f1" }],
  revisions: [],
  ...patch,
});

const method = {
  id: "method:learned:freeze", projectId: null, revision: 2, name: "pre-submission-freeze-check",
  description: "Runs the last guards.", whenToUse: "", title: "提交前给成品做最后把关",
  summary: "先留改动前的副本，再逐项确认每道检查真的能报错。", status: "approved", statusReason: null, origin: "inferred",
  counts: { eligible: 1, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 }, evaluations: [],
  promotion: { status: "approved", reasons: [], missing: [] }, body: "1. 先复制一份。\n2. 再逐项检查。",
  statusChangedAt: "2026-09-22T02:00:00Z", trajectories: 3, createdAt: "2026-09-21T06:00:00Z", updatedAt: "2026-09-22T06:00:00Z",
};

function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory${search}`]}>
      <Routes><Route path="/app/memory" element={<MemoryHubPage />} /></Routes>
    </MemoryRouter>,
  );
}

const rowOf = (text: string | RegExp) => screen.getByText(text).closest("li")!;

describe("记忆胶囊", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [{ id: "prj_1", name: "疳证 Meta 文献检索" }] });
    fetchMemoryProfile.mockResolvedValue({
      records: [
        record(),
        record({ id: "rec_2", kind: "preference", key: "preference.style", value: "偏好结论先行的回答。", summary: "偏好结论先行的回答。",
          origin: "inferred", provenance: { basis: "inferred", observations: 2, runs: 2, conversations: 1 } }),
        record({ id: "rec_3", kind: "project_fact", scope: "project", scopeId: "prj_1",
          key: "project.fact.scope", value: "纳入范围覆盖疳证与小儿厌食症。", summary: "纳入范围覆盖疳证与小儿厌食症。" }),
        record({ id: "rec_4", kind: "behavior", key: "behavior.gone", value: "已忘记的一条", summary: "已忘记的一条", status: "archived" }),
        record({ id: "rec_5", kind: "run_summary", scope: "project", scopeId: "prj_1", key: "run.session.ses_x", value: "{}", summary: "做过的一次研究" }),
      ],
      groups: {}, activeCount: 3, pendingCount: 0, episodeCount: 1,
      conversations: { ses_9: "阿司匹林一级预防" },
      usage: { rec_1: { count: 7, lastUsedAt: "2026-09-18T00:00:00Z" } },
    });
    fetchMemorySettings.mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
    updateMemorySettings.mockImplementation(async (patch: object) => ({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null, ...patch }));
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [] });
    listMethods.mockResolvedValue({ items: [method], nextCursor: null });
    searchMemories.mockResolvedValue({ items: [], query: "", semantic: 0, conversations: {}, usage: {} });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); useProjectStore.setState({ projects: [] }); });

  it("is one page: a title with nothing under it, one switch and one 「⋯」 in the header", async () => {
    open();
    const heading = await screen.findByRole("heading", { name: "记忆胶囊", level: 1 });
    const banner = screen.getByRole("banner");
    expect(banner).toContainElement(heading);
    expect(screen.queryByText(/EviMed 自己记下的/)).not.toBeInTheDocument();
    expect(await within(banner).findByRole("switch", { name: "记忆" })).toHaveAttribute("aria-checked", "true");
    expect(within(banner).getByRole("button", { name: "记忆设置" })).toBeInTheDocument();
    // Four controls in four styles became the switch and the menu.
    expect(within(banner).queryByRole("button", { name: /重置全部记忆|分享与导入/ })).toBeNull();
    expect(within(banner).queryByRole("switch", { name: /本项目/ })).toBeNull();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    for (const gone of ["最近变化", "记下的内容", "收到的胶囊", "EviMed 眼中的你"]) expect(screen.queryByText(gone)).toBeNull();
  });

  it("keeps 本项目除外, the reset, sharing and forgotten memories in the header's 「⋯」", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByRole("switch", { name: "记忆" });
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    const menu = await screen.findByRole("menu", { name: "记忆设置" });
    expect([...menu.querySelectorAll("[role^=menuitem]")].map((item) => item.textContent)).toEqual(["本项目除外", "重置全部记忆", "分享与导入", "已忘记的内容"]);
    const project = within(menu).getByRole("menuitemcheckbox", { name: "本项目除外" });
    expect(project).toHaveAttribute("aria-checked", "false");
    // The other items stay actions, not a single choice.
    expect(within(menu).getByRole("menuitem", { name: "分享与导入" })).toBeInTheDocument();
    await user.click(project);
    await waitFor(() => expect(updateMemorySettings).toHaveBeenCalledWith({ pausedProjects: ["prj_1"] }));
  });

  it("asks before the reset deletes anything", async () => {
    const user = userEvent.setup();
    resetMemory.mockResolvedValue({ structured: 3 });
    open();
    await screen.findByRole("switch", { name: "记忆" });
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "重置全部记忆" }));
    const dialog = await screen.findByRole("alertdialog", { name: "重置全部记忆？" });
    expect(dialog).toHaveTextContent("将永久删除全部记忆，不可撤销；对话、报告、知识库不受影响。");
    expect(resetMemory).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "全部删除" }));
    await waitFor(() => expect(resetMemory).toHaveBeenCalledTimes(1));
  });

  it("pauses memory with the one switch, as one decision over both halves", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("switch", { name: "记忆" }));
    await waitFor(() => expect(updateMemorySettings).toHaveBeenCalledWith({ learningPaused: true, recallPaused: true }));
  });

  it("filters 全部 / 关于你 / 做法 / 项目 in one row, with the search box beside them", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/药学背景/);
    const group = screen.getByRole("group", { name: "筛选记忆" });
    expect(within(group).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "关于你", "做法", "项目"]);
    expect(screen.getByRole("searchbox", { name: "搜索记忆" })).toHaveAttribute("placeholder", "搜索记忆");
    await user.click(within(group).getByRole("button", { name: "做法" }));
    expect(screen.getByText(/提交前给成品做最后把关/)).toBeInTheDocument();
    expect(screen.queryByText(/药学背景/)).toBeNull();
    await user.click(within(group).getByRole("button", { name: "项目" }));
    expect(screen.getByText("纳入范围覆盖疳证与小儿厌食症。")).toBeInTheDocument();
    expect(screen.queryByText(/提交前给成品做最后把关/)).toBeNull();
  });

  it("gives each memory one row: where it belongs on the left, one sentence on the right", async () => {
    open();
    await screen.findByText(/药学背景/);
    const self = rowOf(/药学背景/);
    expect(within(self).getByText("关于你")).toBeInTheDocument();
    expect(within(rowOf(/提交前给成品做最后把关/)).getByText("做法")).toBeInTheDocument();
    // A project's memory says the project's own name.
    expect(within(rowOf("纳入范围覆盖疳证与小儿厌食症。")).getByText("疳证 Meta 文献检索")).toBeInTheDocument();
    // 关于你 first, then 做法, then the project, as the mockup has them.
    const items = within(screen.getByRole("list", { name: "记忆" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.slice(0, 4))).toEqual(["关于你药", "关于你偏", "做法提交", "疳证 M"]);
    // A run summary is the timeline's, not a memory in force.
    expect(screen.queryByText("做过的一次研究")).toBeNull();
  });

  it("marks an inference, and only an inference, with a small grey 「推断」", async () => {
    open();
    await screen.findByText(/药学背景/);
    expect(within(rowOf(/偏好结论先行的回答/)).getByText("推断")).toHaveClass("text-text-3");
    expect(within(rowOf(/提交前给成品做最后把关/)).getByText("推断")).toBeInTheDocument();
    expect(within(rowOf(/药学背景/)).queryByText("推断")).toBeNull();
    expect(within(rowOf("纳入范围覆盖疳证与小儿厌食症。")).queryByText("推断")).toBeNull();
  });

  it("says nothing else about a memory: no 新, no 起生效, no 用过 N 次, no origin pill, no buttons under it", async () => {
    open();
    await screen.findByText(/药学背景/);
    for (const gone of [/^新$/, /起生效/, /用过 \d+ 次/, /还没用过/, /你说过 \d+ 次/, /看看具体怎么做/, /^你说的$/, /EviMed 推断/, /来自 9月12日/, /我的做法/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
    expect(screen.queryByRole("button", { name: /回到上一版/ })).toBeNull();
  });

  it("offers 编辑 and 忘记 as the row's two hover icons, and 忘记 archives with an undo", async () => {
    const user = userEvent.setup();
    archiveMemoryRecord.mockResolvedValue({ id: "rec_1", version: 3 });
    open();
    await screen.findByText(/药学背景/);
    const row = rowOf(/药学背景/);
    const edit = within(row).getByRole("button", { name: "编辑" });
    const forget = within(row).getByRole("button", { name: "忘记" });
    // On every row, not only under the pointer (owner, 2026-09-24).
    expect(edit.parentElement).not.toHaveClass("opacity-0");
    expect(forget).toHaveClass("h-6", "w-6");
    await user.click(forget);
    await waitFor(() => expect(archiveMemoryRecord).toHaveBeenCalledWith("rec_1", 2));
  });

  it("opens a method's full steps from its row, and keeps 历史版本, 回到上一版 and 停用 in its 「⋯」", async () => {
    const user = userEvent.setup();
    open();
    const title = await screen.findByRole("button", { name: /提交前给成品做最后把关/ });
    expect(title).toHaveAttribute("aria-expanded", "false");
    await user.click(title);
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/先复制一份/)).toBeInTheDocument();
    await user.click(within(rowOf(/提交前给成品做最后把关/)).getByRole("button", { name: "更多" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["历史版本", "回到上一版", "停用"]);
    await user.click(screen.getByRole("menuitem", { name: "历史版本" }));
    expect(screen.getByText(/9月21日 学到/)).toBeInTheDocument();
  });

  it("keeps a medicine-safety hold visible and confirmable", async () => {
    fetchMemoryProfile.mockResolvedValue({
      records: [record({ id: "rec_pending", kind: "profile", summary: "长期服用华法林。", value: "长期服用华法林。", status: "pending" })],
      groups: {}, activeCount: 0, pendingCount: 1, conversations: {}, usage: {},
    });
    open();
    const row = (await screen.findByText(/长期服用华法林/)).closest("li")!;
    expect(within(row).getByText("待确认（用药安全）")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "确认" })).toBeInTheDocument();
  });

  it("searches on the server, over more than the rows on screen", async () => {
    const user = userEvent.setup();
    searchMemories.mockResolvedValue({
      items: [record({ id: "rec_far", kind: "run_summary", scope: "project", scopeId: "prj_1",
        key: "run.session.ses_far", value: "{}", summary: "阿司匹林一级预防还值得做吗" })],
      query: "阿司匹林", semantic: 1, conversations: {}, usage: {},
    });
    open();
    await screen.findByText(/药学背景/);
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "阿司匹林");
    await waitFor(() => expect(searchMemories).toHaveBeenCalledWith("阿司匹林"));
    expect(await screen.findByText("阿司匹林一级预防还值得做吗")).toBeInTheDocument();
    expect(screen.queryByText(/药学背景/)).toBeNull();
    expect(screen.queryByText(/搜索结果按相关度排序/)).toBeNull();
  });

  it("keeps forgotten memories out of the list, under 已忘记的内容, each with 恢复", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/药学背景/);
    expect(screen.queryByText("已忘记的一条")).toBeNull();
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "已忘记的内容" }));
    const drawer = await screen.findByRole("dialog", { name: "已忘记的内容" });
    const row = within(drawer).getByText("已忘记的一条").closest("li")!;
    expect(within(row).getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "忘记" })).toBeNull();
  });

  it("opens sharing and importing, and the capsules received, from the header's 「⋯」", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText(/药学背景/);
    expect(screen.queryByText("transfer")).toBeNull();
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "分享与导入" }));
    const drawer = await screen.findByRole("dialog", { name: "分享与导入" });
    expect(within(drawer).getByText("transfer")).toBeInTheDocument();
    expect(within(drawer).getByText("received shelf")).toBeInTheDocument();
    // No description line under the drawer's title either.
    expect(within(drawer).queryByText(/原始资料、账户标识和对话记录不会随包导出/)).toBeNull();
  });

  it("says one sentence on an empty page", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, conversations: {}, usage: {} });
    listMethods.mockResolvedValue({ items: [], nextCursor: null });
    open();
    expect(await screen.findByText("还没有记忆")).toBeInTheDocument();
    expect(screen.queryByText(/不需要你填写/)).toBeNull();
  });

  it("says so and offers a retry when the page cannot be read", async () => {
    fetchMemoryProfile.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时读不到记忆。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("opens the memory an inbox notice names, where it is", async () => {
    open("?record=rec_2");
    const title = await screen.findByRole("button", { name: /偏好结论先行的回答/ });
    expect(title.closest("li")).toHaveClass("bg-accent-soft");
    expect(title).toHaveAttribute("aria-expanded", "true");
  });
});
