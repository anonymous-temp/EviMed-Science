import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyRecord } from "@/components/memory/__fixtures__/memoryProfiles";
import { handoverEntries, livedIn, ownerFirstDay, receivedPack, TODAY } from "@/components/memory/overview/__fixtures__/overviewDocs";
import type { MemoryMap } from "@/lib/memoryMapClient";
import { expectComposed } from "@/test/expectComposed";
import { MemoryOverviewPage } from "./MemoryOverviewPage";

const reads = vi.hoisted(() => ({
  fetchMemoryMap: vi.fn(), fetchReceivedCapsules: vi.fn(), fetchMyCapsule: vi.fn(), previewCapsuleExport: vi.fn(), fetchProjectOverview: vi.fn(),
  fetchMemorySettings: vi.fn(), fetchMemoryProfile: vi.fn(), enableReceivedCapsule: vi.fn(), disableCapsule: vi.fn(), feature: { value: "on" as "on" | "off" | "loading" },
}));
vi.mock("@/lib/memoryMapClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")), fetchMemoryMap: reads.fetchMemoryMap }));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")),
  fetchReceivedCapsules: reads.fetchReceivedCapsules, fetchMyCapsule: reads.fetchMyCapsule, fetchProjectOverview: reads.fetchProjectOverview,
  enableReceivedCapsule: reads.enableReceivedCapsule, disableCapsule: reads.disableCapsule,
}));
vi.mock("@/lib/productClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/productClient")>("@/lib/productClient")), previewCapsuleExport: reads.previewCapsuleExport }));
vi.mock("@/lib/apiClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), fetchMemorySettings: reads.fetchMemorySettings, fetchMemoryProfile: reads.fetchMemoryProfile,
  updateMemorySettings: vi.fn(),
}));
vi.mock("@/lib/memoryMapFeature", () => ({ useMemoryMapFeature: () => reads.feature.value }));
vi.mock("@/components/memory/useMemoryWritePrompt", () => ({ useMemoryWritePrompt: () => {} }));
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: () => Promise.resolve([]) }));
vi.mock("./CapsuleTransferPanel", () => ({
  ShareDrawer: ({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) => <div role="dialog" aria-label="分享与导入" data-tab={initialTab}><button onClick={onClose}>关闭</button></div>,
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}
function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory/overview${search}`]}>
      <Where />
      <Routes>
        <Route path="/app/memory/overview" element={<MemoryOverviewPage />} />
        <Route path="/app/memory" element={<p>记忆页</p>} />
        <Route path="/app/memory/map" element={<p>地图页</p>} />
        <Route path="/app/chat" element={<p>对话页</p>} />
        <Route path="/app/files" element={<p>知识库页</p>} />
        <Route path="/app/files/:id" element={<p>资料页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;
const card = (part: string) => document.querySelector<HTMLElement>(`[data-overview-card="${part}"]`)!;
const PARTS = ["growth", "you", "projects", "methods", "knowledge", "received"];
/** The page's one sentence: its text is broken up by the links that are its numbers, so it is read whole. */
const sentenceOf = async () => {
  await waitFor(() => expect(document.querySelector("[data-headline]")).not.toBeNull());
  return document.querySelector<HTMLElement>("[data-headline]")!;
};
async function ready() {
  await waitFor(() => expect(document.querySelectorAll("[data-overview-card][data-state='loading']")).toHaveLength(0), { timeout: 4_000 });
}

beforeEach(() => {
  // Only the clock is held: "the last thirty days" is counted from a day the fixtures are dated against, and nothing else is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  reads.feature.value = "on";
  reads.fetchMemoryMap.mockReset().mockResolvedValue(ownerFirstDay());
  reads.fetchReceivedCapsules.mockReset().mockResolvedValue([]);
  reads.fetchMyCapsule.mockReset().mockResolvedValue({ capsule: { id: "cap_1" }, capsules: [], entries: [], forgotten: [] });
  reads.previewCapsuleExport.mockReset().mockResolvedValue({ scopes: [], empty: true, tooMany: false, card: null, entries: [] });
  reads.fetchProjectOverview.mockReset().mockResolvedValue({ projectId: "prj_b", paused: false, card: [{ slot: "field", label: "领域", recordId: "r1", text: "心血管", updatedAt: null }], capabilities: [], works: [], timeZone: "Asia/Shanghai" });
  reads.fetchMemorySettings.mockReset().mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
  reads.fetchMemoryProfile.mockReset().mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0 });
  reads.enableReceivedCapsule.mockReset().mockResolvedValue(null);
  reads.disableCapsule.mockReset().mockResolvedValue({ disabled: true, lists: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("总览 on the owner's first day: native memory, no memory file, documents in three projects, nothing learned or received", () => {
  it("is a page with something on it: the documents, the projects and the strip of what was put in, and recipes for the rest — never three zeros", async () => {
    open();
    expect(await sentenceOf()).toHaveTextContent("胶囊里有 47 份资料，还没有记下关于你的事；近 30 天新增 3 件。");
    await ready();
    expect(screen.queryByText(/还没有记住什么/u)).toBeNull();
    expect([...document.querySelectorAll("[data-overview-card]")].map((element) => element.getAttribute("data-overview-card"))).toEqual(PARTS);
    // 成长: the one lane it has, drawn.
    expect(card("growth")).toHaveAttribute("data-state", "content");
    expect(card("growth")).toHaveAttribute("data-count", "3");
    expect(within(card("growth")).getByRole("heading", { level: 2 })).toHaveTextContent("自9月22日起，放进 3 份资料");
    // 项目: the projects that hold something, each with its own documents; the empty one is not a row.
    expect(card("projects")).toHaveAttribute("data-count", "2");
    expect(within(card("projects")).getByRole("table", { name: "各个项目" })).toBeInTheDocument();
    expect(within(card("projects")).getByRole("link", { name: "阿司匹林一级预防" })).toHaveAttribute("href", "/app/memory?tab=project&project=prj_a");
    expect(within(card("projects")).queryByText("空项目")).toBeNull();
    // 知识: counted by the knowledge base, by kind.
    expect(card("knowledge")).toHaveAttribute("data-count", "47");
    expect(within(card("knowledge")).getByRole("list", { name: "资料的种类" })).toBeInTheDocument();
    expect(within(card("knowledge")).getByRole("link", { name: /文献与指南/u })).toHaveAttribute("href", "/app/files?kind=literature");
    // The other three are recipes with one button each.
    for (const [part, button] of [["you", "记住这一条"], ["methods", "去做一件事"], ["received", "导入一个胶囊"]] as const) {
      expect(card(part)).toHaveAttribute("data-state", "recipe");
      expect(within(card(part)).getAllByRole("button", { name: button })).toHaveLength(1);
    }
  });

  it("writes the first line from 关于你's own button, and 「记住这一条」 is the header's too", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.getAllByRole("button", { name: "记住这一条" })).toHaveLength(2);
    await user.click(within(card("you")).getByRole("button", { name: "记住这一条" }));
    expect(await screen.findByRole("dialog", { name: "记住这一条" })).toBeInTheDocument();
  });

  it("sends an account on the older engine to the conversation to say the first thing, since it cannot type one in", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ engine: "postgres" }));
    const user = userEvent.setup();
    open();
    await ready();
    expect(screen.queryByRole("button", { name: "记住这一条" })).toBeNull();
    await user.click(within(card("you")).getByRole("button", { name: "去对话" }));
    expect(await screen.findByText("对话页")).toBeInTheDocument();
  });

  it("opens 分享与导入 on 导入 from the recipe of 收到的, and on 导出 from the card of what could be handed over", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(within(card("received")).getByRole("button", { name: "导入一个胶囊" }));
    expect(await screen.findByRole("dialog", { name: "分享与导入" })).toHaveAttribute("data-tab", "import");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));
    await user.click(within(card("received")).getByRole("button", { name: "分享与导入" }));
    expect(await screen.findByRole("dialog", { name: "分享与导入" })).toHaveAttribute("data-tab", "export");
  });
});

describe("总览 of an account that has lived a while", () => {
  beforeEach(() => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a"), receivedPack("b", { importedAt: "2026-09-30T02:00:00.000Z", enabled: true })]);
    reads.previewCapsuleExport.mockResolvedValue({ scopes: [], empty: false, tooMany: false, card: null, entries: handoverEntries({ methods: 3, standards: 5, background: 12 }) });
  });

  it("says what it holds with each number a link to its part, and every card's number is the headline's", async () => {
    open();
    const sentence = await sentenceOf();
    await ready();
    // The last thirty days: seven memories noted, two methods learned, two documents added and two packs taken in.
    expect(sentence).toHaveTextContent("胶囊里有 7 件关于你和项目的事、2 种做法、39 份资料；近 30 天新增 13 件。");
    const link = (name: RegExp) => within(sentence).getByRole("link", { name });
    expect(link(/7 件关于你和项目的事/u)).toHaveAttribute("href", "/app/memory/map");
    expect(link(/2 种做法/u)).toHaveAttribute("href", "/app/memory/map?part=method");
    expect(link(/39 份资料/u)).toHaveAttribute("href", "/app/memory/map?part=knowledge");
    expect(link(/件，看时间/u)).toHaveAttribute("href", "/app/memory/map?view=time");
    // The cards: 关于你 and 项目 are the memories together, the others each their own number.
    expect(Number(card("you").dataset.count) + Number(card("projects").dataset.memories)).toBe(7);
    expect([card("methods").dataset.count, card("knowledge").dataset.count, card("received").dataset.count]).toEqual(["2", "39", "2"]);
    expect(card("you").dataset.count).toBe("4");
  });

  it("draws each part in the form its amount calls for, and headed by the sentence it proves", async () => {
    open();
    await ready();
    expect(within(card("growth")).getByRole("heading", { level: 2 }).textContent).toBe("自9月22日起，记下 7 件、学会 2 种做法、放进 2 份资料、收下 2 个胶囊");
    // 关于你: four statements, as themselves.
    expect(within(card("you")).getByRole("heading", { level: 2 })).toHaveTextContent("关于你 · 4 件");
    expect(within(within(card("you")).getByRole("list", { name: "关于你的记忆" })).getAllByRole("listitem")).toHaveLength(4);
    // 项目: two, a table with a bar in each row, the most recently active first.
    const table = within(card("projects")).getByRole("table", { name: "各个项目" });
    // The newest thing in 阿司匹林一级预防 (a memory of 10月8日) is later than the newest in 房颤抗凝; its row reads name, bar, 记忆 1, 资料 22 (and 房颤抗凝 a memory to look at).
    expect(within(table).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["阿司匹林一级预防122", "房颤抗凝2171"]);
    // 我的做法: two, as rows with their day, and no count of use anywhere.
    expect(within(within(card("methods")).getByRole("list", { name: "我的做法" })).getAllByRole("listitem")).toHaveLength(2);
    expect(card("methods").textContent).not.toMatch(/使用|调用|载入|用过/u);
    // 知识: counted by the knowledge base, with the memory resting on a changed source said in words and a link.
    expect(within(card("knowledge")).getByRole("link", { name: "1 条记忆依据的资料变了，只看这些" })).toHaveAttribute("href", "/app/memory/map?look=1");
    // 收到的: both packs, newest first, with the switch of each — and what could be handed over.
    const packs = within(card("received")).getByRole("list", { name: "收到的胶囊" });
    expect(within(packs).getAllByRole("listitem").map((row) => within(row).getByRole("switch").getAttribute("aria-label"))).toEqual(["启用“李主任的工作方式 a”", "启用“李主任的工作方式 b”"]);
    expect(within(packs).getByRole("switch", { name: "启用“李主任的工作方式 b”" })).toHaveAttribute("aria-checked", "true");
    expect(within(card("received")).getByRole("img", { name: "我能交出去的：方法 3 · 标准与偏好 5 · 背景 12" })).toBeInTheDocument();
  });

  it("drills each card into the map narrowed to its part, and 成长 into the time view", async () => {
    open();
    await ready();
    const hrefs = Object.fromEntries(["growth", "you", "projects", "methods", "knowledge"].map((part) => [part, within(card(part)).getByRole("link", { name: "在地图里看" }).getAttribute("href")]));
    expect(hrefs).toEqual({
      growth: "/app/memory/map?view=time", you: "/app/memory/map?part=you", projects: "/app/memory/map?part=project", methods: "/app/memory/map?part=method", knowledge: "/app/memory/map?part=knowledge",
    });
  });

  it("lists what needs a look, the sentence of its reason on each row, and opens it in the memory's own drawer", async () => {
    const user = userEvent.setup();
    reads.fetchMemoryProfile.mockResolvedValue({ records: [legacyRecord({ id: "p2", kind: "decision", summary: "主要结局取卒中和系统性栓塞", value: "主要结局取卒中和系统性栓塞" })], groups: {}, activeCount: 1, pendingCount: 0 });
    open();
    await ready();
    const section = screen.getByRole("heading", { name: "需要看一眼" }).closest("section")!;
    const row = within(section).getByRole("button", { name: "主要结局取卒中和系统性栓塞" });
    expect(within(row.closest("li")!).getByText("依据的资料有更新")).toBeInTheDocument();
    await user.click(row);
    expect(where()).toContain("open=record%3Ap2");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens a memory in the drawer from its row, a note of the capsule in the drawer of notes, and a document on its own page", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(within(card("you")).getByRole("button", { name: "回答先给结论" }));
    expect(where()).toContain("open=record%3Ay2");
    cleanup();
    reads.fetchMyCapsule.mockResolvedValue({ capsule: { id: "cap_1" }, capsules: [], entries: [], forgotten: [] });
    open();
    await ready();
    await user.click(within(card("you")).getByRole("button", { name: "引用写到页码" }));
    expect(where()).toContain("open=entry%3Ae4");
  });

  it("switches a received pack on and says so, with the way back in the toast, and reads the packs again", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const before = reads.fetchReceivedCapsules.mock.calls.length;
    await user.click(within(card("received")).getByRole("switch", { name: "启用“李主任的工作方式 a”" }));
    await waitFor(() => expect(reads.enableReceivedCapsule).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(reads.fetchReceivedCapsules.mock.calls.length).toBeGreaterThan(before));
  });

  it("carries 就这个提问 in each row's 「⋯」, which opens a conversation with the question begun", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const row = within(card("methods")).getByRole("button", { name: "证据矩阵先行" }).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("menuitem", { name: "就这个提问" })).toBeInTheDocument();
  });
});

describe("a read that failed is said, on its own card, and is never a zero", () => {
  it("names a card whose source failed and leaves the rest drawn; the sentence leaves that number out", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn({ missing: ["documents"] }));
    open();
    await ready();
    for (const part of ["projects", "knowledge", "growth"]) {
      expect(card(part)).toHaveAttribute("data-state", "error");
      expect(within(card(part)).getByRole("alert")).toHaveTextContent("这一部分有资料没有读到。");
      expect(card(part).dataset.count).toBeUndefined();
    }
    for (const part of ["you", "methods"]) expect(card(part)).toHaveAttribute("data-state", "content");
    const sentence = await sentenceOf();
    expect(sentence).toHaveTextContent("胶囊里有 7 件关于你和项目的事、2 种做法。");
    expect(sentence.textContent).not.toMatch(/份资料|新增/u);
  });

  it("says a failed memory read is not 'nothing remembered': 关于你 is an error, and no recipe stands in its place", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ missing: ["native-memory"] }));
    open();
    await ready();
    expect(card("you")).toHaveAttribute("data-state", "error");
    expect(within(card("you")).queryByRole("button", { name: "记住这一条" })).toBeNull();
    expect(screen.queryByText(/还没有记下关于你的事/u)).toBeNull();
  });

  it("fails all five cards of the map's document together when it cannot be read, each with 重试, and the received card is its own", async () => {
    reads.fetchMemoryMap.mockRejectedValueOnce(new Error("down")).mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a")]);
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(card("growth")).toHaveAttribute("data-state", "error"));
    for (const part of ["growth", "you", "projects", "methods", "knowledge"]) expect(card(part)).toHaveAttribute("data-state", "error");
    expect(card("received")).toHaveAttribute("data-state", "content");
    expect(screen.queryByText(/胶囊里有/u)).toBeNull();
    await user.click(within(card("you")).getByRole("button", { name: /重试/u }));
    await waitFor(() => expect(card("you")).toHaveAttribute("data-state", "content"));
    expect(card("growth")).toHaveAttribute("data-state", "content");
  });

  it("fails the received card alone, and the hand-over half alone: each has its own retry", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockRejectedValue(new Error("shelf down"));
    reads.previewCapsuleExport.mockRejectedValue(new Error("preview down"));
    open();
    await waitFor(() => expect(card("received")).toHaveAttribute("data-state", "error"));
    expect(card("you")).toHaveAttribute("data-state", "content");
    cleanup();
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a")]);
    open();
    await ready();
    expect(card("received")).toHaveAttribute("data-state", "content");
    const hand = card("received").querySelector<HTMLElement>("[data-overview-handover]")!;
    expect(await within(hand).findByRole("alert")).toHaveTextContent("暂时读不到你能交出去的内容。");
    expect(within(hand).getByRole("button", { name: /重试/u })).toBeInTheDocument();
  });
});

describe("总览 of an account with nothing at all", () => {
  it("has no sentence and six recipes, each one button — and says so as nothing to compare, not as a page that passed", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ nodes: [], summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, buckets: { unit: "day", series: [] },
      facets: { projects: [], kinds: [], aboutYou: [], documentTypes: [], topics: [], dimensions: [] } }));
    open();
    await ready();
    expect(screen.queryByText(/胶囊里有/u)).toBeNull();
    for (const part of PARTS) expect(card(part)).toHaveAttribute("data-state", "recipe");
    expect(within(card("growth")).getByRole("button", { name: "去对话" })).toBeInTheDocument();
    expect(within(card("knowledge")).getByRole("button", { name: "上传一份资料" })).toBeInTheDocument();
  });
});

describe("the page's place in the capsule", () => {
  it("is the first of five tabs and the one in force, with no toolbar and no scope menu, under one header holding the capsule's verbs", async () => {
    const { container } = open();
    await ready();
    const tabs = screen.getByRole("tablist", { name: "记忆" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["总览", "地图", "关于你", "项目", "做法"]);
    expect(within(tabs).getByRole("tab", { name: "总览" })).toHaveAttribute("aria-selected", "true");
    const facts = expectComposed(container, { tablists: 1 });
    expect(facts.toolbars).toHaveLength(0);
    expect(within(facts.header!).queryByRole("button", { name: /^项目：/u })).toBeNull();
    expect(await within(facts.header!).findByRole("switch", { name: "记忆" })).toBeInTheDocument();
    expect(within(facts.header!).getByRole("button", { name: "记忆设置" })).toBeInTheDocument();
    // The sentence is the page's one headline, between the band and the body.
    expect(container.querySelectorAll("[data-headline]")).toHaveLength(1);
  });

  it("goes to the lists from its tabs, and to the first list where the deployment draws no map", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    await user.click(within(screen.getByRole("tablist", { name: "记忆" })).getByRole("tab", { name: "关于你" }));
    expect(where()).toBe("/app/memory?tab=self");
    cleanup();
    reads.fetchMemoryMap.mockClear();
    reads.feature.value = "off";
    open();
    expect(await screen.findByText("记忆页")).toBeInTheDocument();
    expect(reads.fetchMemoryMap).not.toHaveBeenCalled();
  });

  it("asks nothing of the map before the deployment says whether it draws it", async () => {
    reads.feature.value = "loading";
    open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reads.fetchMemoryMap).not.toHaveBeenCalled();
    expect(document.querySelector("[data-overview-card]")).toBeNull();
  });

  it("reads the map once, for the blocks it draws and no others", async () => {
    open();
    await ready();
    expect(reads.fetchMemoryMap).toHaveBeenCalledTimes(1);
    const [query, , include] = reads.fetchMemoryMap.mock.calls[0]!;
    expect(query).toEqual({ projectId: null, range: "all", focus: null, depth: 1 });
    expect(include).toBe("summary,facets,nodes,buckets,events");
  });
});

// The map's document as a type, so a fixture that drifts from it fails here and not in a browser.
export type _Doc = MemoryMap;
