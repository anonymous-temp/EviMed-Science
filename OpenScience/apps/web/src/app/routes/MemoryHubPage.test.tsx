import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebStructuredMemory } from "@/lib/apiClient";
import { MemoryHubPage } from "./MemoryHubPage";

const fetchMemoryProfile = vi.fn();
const searchMemories = vi.fn();
const fetchMemorySettings = vi.fn();
const fetchMemoryTimeline = vi.fn();
const fetchMyCapsule = vi.fn();
const listMethods = vi.fn();

vi.mock("@/lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient");
  return {
    ...actual,
    getWebProjectId: () => "prj_1",
    fetchMemoryProfile: (...args: unknown[]) => fetchMemoryProfile(...args),
    searchMemories: (...args: unknown[]) => searchMemories(...args),
    fetchMemorySettings: (...args: unknown[]) => fetchMemorySettings(...args),
    updateMemorySettings: vi.fn(),
    resetMemory: vi.fn(),
  };
});
vi.mock("@/lib/memoryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient");
  return {
    ...actual,
    ensureMyCapsule: () => Promise.resolve(null),
    fetchMyCapsule: (...args: unknown[]) => fetchMyCapsule(...args),
    fetchMemoryTimeline: (...args: unknown[]) => fetchMemoryTimeline(...args),
  };
});
vi.mock("@/lib/methodsClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient");
  return { ...actual, listMethods: (...args: unknown[]) => listMethods(...args) };
});
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("@/components/capsule/ReceivedShelf", () => ({ ReceivedShelf: () => null }));
vi.mock("./CapsuleTransferPanel", () => ({ CapsuleTransferPanel: () => <p>transfer</p> }));

const record = (patch: Partial<WebStructuredMemory> = {}): WebStructuredMemory => ({
  id: "rec_1", scope: "user", scopeId: "", kind: "profile", key: "profile.who",
  value: "临床药师，主攻抗凝治疗", summary: "临床药师，主攻抗凝治疗",
  origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  evidenceCount: 1, version: 2, createdAt: "2026-09-12T02:00:00Z", updatedAt: "2026-09-12T02:00:00Z",
  lastConfirmedAt: null, expiresAt: null,
  provenance: { basis: "stated", observations: 1, runs: 1, conversations: 1 },
  evidence: [{ sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/u1", quote: "我是临床药师",
    observedAt: "2026-09-12T02:00:00Z", weight: 1, fingerprint: "f1" }],
  revisions: [],
  ...patch,
});

function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory${search}`]}>
      <Routes><Route path="/app/memory" element={<MemoryHubPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe("记忆胶囊", () => {
  beforeEach(() => {
    fetchMemoryProfile.mockResolvedValue({
      records: [
        record(),
        record({ id: "rec_2", kind: "preference", key: "preference.grade", value: "Meta 分析先报 GRADE 再报效应量",
          summary: "Meta 分析先报 GRADE 再报效应量" }),
        record({ id: "rec_3", kind: "project_fact", scope: "project", scopeId: "prj_1",
          key: "project.fact.cohort", value: "队列限定 65 岁以上", summary: "队列限定 65 岁以上",
          origin: "inferred", provenance: { basis: "inferred", observations: 2, runs: 2, conversations: 1 } }),
        record({ id: "rec_4", kind: "behavior", key: "behavior.gone", value: "已忘记的一条", summary: "已忘记的一条", status: "archived" }),
      ],
      groups: {}, activeCount: 3, pendingCount: 0, episodeCount: 0,
      conversations: { ses_9: "阿司匹林一级预防" },
      usage: { rec_1: { count: 7, lastUsedAt: "2026-09-18T00:00:00Z" } },
    });
    fetchMemorySettings.mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
    fetchMemoryTimeline.mockResolvedValue({ items: [], nextBefore: null, density: [], timeZone: "Asia/Shanghai", missing: [] });
    fetchMyCapsule.mockResolvedValue({ capsule: null, capsules: [], entries: [] });
    listMethods.mockResolvedValue({ items: [], nextCursor: null });
    searchMemories.mockResolvedValue({ items: [], query: "", semantic: 0, conversations: {}, usage: {} });
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("is one page with the two nouns printed under its title, and no tabs at all", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "记忆胶囊", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/EviMed 自己记下的/)).toBeInTheDocument();
    expect(screen.getByText(/资料本身在「知识库」/)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toEqual([]);
    // What the six tabs used to be named, and what the page no longer asks for.
    for (const gone of ["总览", "项目档案", "时间轴", "写一个方法", "你写下的笔记", "放进胶囊", "逐个管理胶囊", "还缺"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("merges the three switches into one, beside 「本项目不使用记忆」 and a reset", async () => {
    open();
    expect(await screen.findByRole("switch", { name: "让 EviMed 记住并使用" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "本项目不使用记忆" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: /重置全部记忆/ })).toBeInTheDocument();
    // The two halves it replaced are gone as separate controls.
    expect(screen.queryByRole("switch", { name: "从对话中学习新记忆" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "回答时参考记忆" })).toBeNull();
  });

  it("writes a portrait only out of sentences that have rows, and each one filters the list to them", async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByRole("heading", { name: "EviMed 眼中的你" })).toBeInTheDocument();
    expect(screen.getByText("你和你的研究方向")).toBeInTheDocument();
    expect(screen.getByText("你的做法")).toBeInTheDocument();
    // 「这个项目」 has a row, so it is said; a group with no rows never appears.
    expect(screen.getByText("这个项目")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /临床药师，主攻抗凝治疗。/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Meta 分析先报 GRADE 再报效应量。/ }));
    expect(screen.getByRole("radio", { name: "我的做法" })).toBeChecked();
    expect(screen.getByText("Meta 分析先报 GRADE 再报效应量")).toBeInTheDocument();
    expect(screen.queryByText("临床药师，主攻抗凝治疗")).toBeNull();
  });

  it("gives every row its origin, the conversation it came from, and how often it was used", async () => {
    open();
    expect(await screen.findByText("临床药师，主攻抗凝治疗")).toBeInTheDocument();
    expect(screen.getAllByText("你说的").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /来自 9月12日《阿司匹林一级预防》/ })[0]).toHaveAttribute("href", "/app/chat/ses_9");
    expect(screen.getByText("用过 7 次，上次 9月18日")).toBeInTheDocument();
    // A count, never a percentage.
    expect(screen.queryByText(/置信度|%/)).toBeNull();
    // 「不对」 is offered on an inference and on nothing else.
    expect(screen.getAllByRole("button", { name: "不对" })).toHaveLength(1);
  });

  it("searches on the server, over more than the rows on screen", async () => {
    const user = userEvent.setup();
    searchMemories.mockResolvedValue({
      items: [record({ id: "rec_far", kind: "run_summary", scope: "project", scopeId: "prj_1",
        key: "run.session.ses_far", value: "{}", summary: "阿司匹林一级预防还值得做吗" })],
      query: "阿司匹林", semantic: 1, conversations: { ses_9: "阿司匹林一级预防" }, usage: {},
    });
    open();
    await screen.findByText("临床药师，主攻抗凝治疗");
    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "阿司匹林");
    await waitFor(() => expect(searchMemories).toHaveBeenCalledWith("阿司匹林"));
    expect(await screen.findByText("阿司匹林一级预防还值得做吗")).toBeInTheDocument();
  });

  it("keeps forgotten rows behind their own filter, out of everything else", async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText("临床药师，主攻抗凝治疗");
    expect(screen.queryByText("已忘记的一条")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "已忘记" }));
    expect(screen.getByText("已忘记的一条")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /恢复/ })).toBeInTheDocument();
  });

  it("collapses sharing and importing into one action at the foot of the page", async () => {
    open();
    await screen.findByText("临床药师，主攻抗凝治疗");
    expect(screen.getByText("分享我的做法 / 导入胶囊")).toBeInTheDocument();
  });

  it("says what will fill an empty page, without giving anyone a chore", async () => {
    fetchMemoryProfile.mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0, conversations: {}, usage: {} });
    open();
    expect(await screen.findByText(/还没有可写的内容/)).toBeInTheDocument();
    expect(screen.getByText(/不需要你填表/)).toBeInTheDocument();
    expect(screen.getByText(/EviMed 会在你和它做研究的过程中自己记下，不需要你填写/)).toBeInTheDocument();
  });

  it("says so and offers a retry when the page cannot be read", async () => {
    fetchMemoryProfile.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时读不到记忆。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
