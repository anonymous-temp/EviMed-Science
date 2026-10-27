import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainRecord } from "@/components/memory/__fixtures__/memoryProfiles";
import { handoverEntries, livedIn, ownerFirstDay, receivedPack, TODAY } from "@/components/memory/overview/__fixtures__/overviewDocs";
import type { MemoryMap } from "@/lib/memoryMapClient";
import type { WebMethod } from "@/lib/methodsClient";
import { expectComposed } from "@/test/expectComposed";
import { announceMemoryChanged } from "@/lib/memoryClient";
import { useProjectStore } from "@/lib/projects";
import { MemoryOverviewPage } from "./MemoryOverviewPage";

const reads = vi.hoisted(() => ({
  fetchMemoryMap: vi.fn(), fetchReceivedCapsules: vi.fn(), fetchMyCapsule: vi.fn(), previewCapsuleExport: vi.fn(), fetchProjectOverview: vi.fn(),
  fetchMemorySettings: vi.fn(), fetchMemoryProfile: vi.fn(), enableReceivedCapsule: vi.fn(), disableCapsule: vi.fn(), listAllMethods: vi.fn(), feature: { value: "on" as "on" | "off" | "loading" },
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
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: reads.listAllMethods }));
vi.mock("./CapsuleTransferPanel", () => ({
  ShareDrawer: ({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) => <div role="dialog" aria-label="分享与导入" data-tab={initialTab}><button onClick={onClose}>关闭</button></div>,
}));

function Where() {
  const location = useLocation();
  return <><p data-testid="where">{location.pathname}{location.search}</p><p data-testid="route-state">{JSON.stringify(location.state)}</p></>;
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
const part = (name: string) => document.querySelector<HTMLElement>(`[data-memory-summary-part="${name}"]`)!;
const learnedMethod = (id: string, title: string, at: string): WebMethod => ({
  id, projectId: null, revision: 1, name: `method-${id}`, title, description: "", whenToUse: "", status: "approved", statusReason: null, origin: "inferred", counts: null,
  promotion: { status: "approved", reasons: [], missing: [] }, body: "", createdAt: at, updatedAt: at,
});
const sentenceOf = async () => {
  await waitFor(() => expect(document.querySelector("[data-headline]")).not.toBeNull());
  return document.querySelector<HTMLElement>("[data-headline]")!;
};
async function ready() {
  await waitFor(() => {
    expect(document.querySelectorAll("[data-memory-summary-part]")).toHaveLength(5);
    expect(document.querySelectorAll("[data-memory-summary-part][data-state='loading']")).toHaveLength(0);
  }, { timeout: 4_000 });
}
const alertWith = (text: string) => [...document.querySelectorAll<HTMLElement>("[data-inline-alert]")].find(node => node.textContent?.includes(text))!;

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
  reads.listAllMethods.mockReset().mockResolvedValue([]);
  reads.enableReceivedCapsule.mockReset().mockResolvedValue(null);
  reads.disableCapsule.mockReset().mockResolvedValue({ disabled: true, lists: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("v3.2 memory task composition", () => {
  it("opens received-pack management deliberately and returns without losing query scope", async () => {
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a")]);
    open("?retained=scope");
    await ready();
    expect(screen.queryByRole("switch", { name: /启用/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /收到的胶囊/ }));
    expect(await screen.findByRole("switch", { name: /启用/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回记忆总览" })).toHaveFocus();
    expect(where()).toContain("retained=scope");
    expect(where()).toContain("section=received");
    await userEvent.click(screen.getByRole("link", { name: "返回记忆总览" }));
    expect(screen.queryByRole("switch", { name: /启用/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /收到的胶囊/ })).toHaveFocus();
    expect(where()).toContain("retained=scope");
  });

  it("leads with content and uses a compact list for sparse history", async () => {
    open();
    await ready();
    const contents = screen.getByRole("heading", { name: "记忆内容" });
    const history = screen.getByRole("heading", { name: "最近变化" });
    expect(contents.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("list", { name: "最近的记忆变化" })).toBeInTheDocument();
    expect(document.querySelector("[data-map-chart='growth']")).toBeNull();
  });

  it("preserves the known documents and projects on an owner's first day", async () => {
    open();
    expect(await sentenceOf()).toHaveTextContent("胶囊里有 47 份资料，还没有记下关于你的事；近 30 天新增 3 件。");
    await ready();
    expect(part("projects")).toHaveAttribute("data-count", "2");
    expect(part("knowledge")).toHaveAttribute("data-count", "47");
    expect(part("you")).toHaveAttribute("data-count", "0");
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
  });

  it("keeps the header's remember and import operations accessible", async () => {
    const user = userEvent.setup();
    open(); await ready();
    expect(screen.getAllByRole("button", { name: "记住这一条" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "记住这一条" }));
    expect(await screen.findByRole("dialog", { name: "记住这一条" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "记忆设置" }));
    await user.click(await screen.findByRole("menuitem", { name: "从其他 AI 导入" }));
    expect(await screen.findByRole("dialog", { name: "从其他 AI 导入" })).toBeInTheDocument();
  });

  it("retains import and share operations in received-pack management", async () => {
    const user = userEvent.setup();
    open(); await ready();
    await user.click(screen.getByRole("link", { name: /收到的胶囊/ }));
    await user.click(await screen.findByRole("button", { name: "导入一个胶囊" }));
    expect(await screen.findByRole("dialog", { name: "分享与导入" })).toHaveAttribute("data-tab", "import");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "分享与导入" }));
    expect(await screen.findByRole("dialog", { name: "分享与导入" })).toHaveAttribute("data-tab", "export");
  });

  it("does not show first-use guidance while any required read is unresolved", async () => {
    reads.fetchMemoryMap.mockReturnValue(new Promise(() => {}));
    open();
    expect(await screen.findByRole("list", { name: "记忆内容与入口" })).toBeInTheDocument();
    expect(part("you")).toHaveAttribute("data-state", "loading");
    expect(part("you")).not.toHaveAttribute("data-count");
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
  });

  it("shows one first-use guide only when every relevant read succeeded and is empty", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ nodes: [], events: [], summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null }, buckets: { unit: "day", series: [] },
      facets: { projects: [], kinds: [], aboutYou: [], documentTypes: [], topics: [], dimensions: [] } }));
    open(); await ready();
    expect(screen.getAllByText("开始积累你的记忆")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "开始对话" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "最近变化" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传资料" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "上传资料" }));
    expect(where()).toBe("/app/files");
  });

  it("does not mistake preserved historical activity for first use when current counts are empty", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ nodes: [], events: [], summary: { memories: 0, documents: 0, methods: 0, projects: 0, needsLook: 0, since: null },
      facets: { projects: [], kinds: [], aboutYou: [], documentTypes: [], topics: [], dimensions: [] } }));
    open(); await ready();
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "最近的记忆变化" })).toBeInTheDocument();
  });
});

describe("a populated account", () => {
  beforeEach(() => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a"), receivedPack("b", { importedAt: "2026-09-30T02:00:00.000Z", enabled: true })]);
    reads.listAllMethods.mockResolvedValue([learnedMethod("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z"), learnedMethod("m2", "先写方法学限制", "2026-10-02T02:00:00.000Z")]);
    reads.previewCapsuleExport.mockResolvedValue({ scopes: [], empty: false, tooMany: false, card: null, entries: handoverEntries({ methods: 3, standards: 5, background: 12 }) });
  });

  it("preserves exact headline counts and the original scoped destinations", async () => {
    open(); const sentence = await sentenceOf(); await ready();
    expect(sentence).toHaveTextContent("胶囊里有 7 件关于你和项目的事、2 种做法、39 份资料；近 30 天新增 13 件。");
    expect(part("you")).toHaveAttribute("data-count", "4");
    expect(part("projects")).toHaveAttribute("data-memories", "3");
    expect(part("methods")).toHaveAttribute("data-count", "2");
    expect(part("knowledge")).toHaveAttribute("data-count", "39");
    expect(part("received")).toHaveAttribute("data-count", "2");
    for (const [name, href] of [["you", "/app/memory/map?part=you"], ["projects", "/app/memory/map?part=project"], ["methods", "/app/memory?tab=methods"], ["knowledge", "/app/memory/map?part=knowledge"]]) {
      expect(part(name).closest("li")!.querySelector("a")).toHaveAttribute("href", href);
    }
  });

  it("puts a source-change item before the content and opens its own record", async () => {
    reads.fetchMemoryProfile.mockResolvedValue({ records: [plainRecord({ id: "p2", kind: "decision", summary: "主要结局取卒中和系统性栓塞", value: "主要结局取卒中和系统性栓塞" })], groups: {}, activeCount: 1, pendingCount: 0 });
    open(); await ready();
    const section = screen.getByRole("heading", { name: "需要看一眼" }).closest("section")!;
    expect(section.compareDocumentPosition(screen.getByRole("heading", { name: "记忆内容" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = within(section).getByRole("button", { name: "主要结局取卒中和系统性栓塞" });
    expect(within(row.closest("li")!).getByText("依据的资料有更新")).toBeInTheDocument();
    await userEvent.click(row);
    expect(where()).toContain("open=record%3Ap2");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens a visible memory or capsule note from the preview without losing identity", async () => {
    const user = userEvent.setup();
    open(); await ready();
    const preview = screen.getByRole("list", { name: "关于你的记忆预览" });
    await user.click(within(preview).getByRole("button", { name: "回答先给结论" }));
    expect(where()).toContain("open=record%3Ay2");
    cleanup(); open(); await ready();
    await user.click(within(screen.getByRole("list", { name: "关于你的记忆预览" })).getByRole("button", { name: "引用写到页码" }));
    expect(where()).toContain("open=entry%3Ae4");
  });

  it("keeps the preview's ask-about operation", async () => {
    const user = userEvent.setup();
    open(); await ready();
    const row = within(screen.getByRole("list", { name: "关于你的记忆预览" })).getByRole("button", { name: "回答先给结论" }).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "更多" }));
    expect(await screen.findByRole("menuitem", { name: "就这个提问" })).toBeInTheDocument();
  });

  it("opens a draft about an independently read method in the native conversation", async () => {
    const previous = useProjectStore.getState();
    useProjectStore.setState({ currentId: "project-test", select: async (_id, done) => { done?.(); } });
    try {
      const user = userEvent.setup();
      open(); await ready();
      const row = within(screen.getByRole("list", { name: "最近采用的做法" })).getByRole("button", { name: "证据矩阵先行" }).closest("li")!;
      await user.click(within(row).getByRole("button", { name: "更多" }));
      await user.click(await screen.findByRole("menuitem", { name: "就这个提问" }));
      await waitFor(() => expect(where()).toBe("/app/chat"));
      expect(screen.getByTestId("route-state")).toHaveTextContent("证据矩阵先行");
    } finally {
      useProjectStore.setState({ currentId: previous.currentId, select: previous.select });
    }
  });

  it("enables a received pack and refreshes its actual shelf", async () => {
    const user = userEvent.setup();
    open(); await ready();
    await user.click(screen.getByRole("link", { name: /收到的胶囊/ }));
    const toggle = await screen.findByRole("switch", { name: "启用“李主任的工作方式 a”" });
    const before = reads.fetchReceivedCapsules.mock.calls.length;
    await user.click(toggle);
    await waitFor(() => expect(reads.enableReceivedCapsule).toHaveBeenCalledWith("a"));
    await waitFor(() => expect(reads.fetchReceivedCapsules.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("read truth and recovery", () => {
  it("keeps independent valid data and omits unavailable document and project counts", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn({ missing: ["documents"] }));
    reads.listAllMethods.mockResolvedValue([learnedMethod("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z")]);
    open(); await ready();
    expect(part("projects")).toHaveAttribute("data-state", "error");
    expect(part("knowledge")).toHaveAttribute("data-state", "error");
    expect(part("knowledge")).not.toHaveAttribute("data-count");
    expect(part("you")).toHaveAttribute("data-count", "4");
    expect(part("methods")).toHaveAttribute("data-count", "1");
    expect(alertWith("部分来源暂未读到")).toBeInTheDocument();
    expect((await sentenceOf()).textContent).not.toMatch(/份资料|新增/u);
  });

  it("does not treat a failed memory read as an empty account", async () => {
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay({ missing: ["native-memory"] }));
    open(); await ready();
    expect(part("you")).toHaveAttribute("data-state", "error");
    expect(part("you")).not.toHaveAttribute("data-count");
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
    expect((await sentenceOf()).textContent).not.toMatch(/还没有记下关于你的事/u);
  });

  it("retries the common map failure without hiding independent methods or received packs", async () => {
    reads.fetchMemoryMap.mockRejectedValueOnce(new Error("down")).mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a")]);
    reads.listAllMethods.mockResolvedValue([learnedMethod("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z")]);
    open(); await ready();
    expect(part("you")).toHaveAttribute("data-state", "error");
    expect(part("received")).toHaveAttribute("data-count", "1");
    expect(part("methods")).toHaveAttribute("data-count", "1");
    expect(await sentenceOf()).toHaveTextContent("胶囊里有 1 种做法。");
    await userEvent.click(within(alertWith("暂时读不到记忆")).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(part("you")).toHaveAttribute("data-state", "content"));
  });

  it("reads methods independently of map folding and does not report an incomplete recent count", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn({ nodes: livedIn().nodes.filter((node) => node.type !== "method") }));
    reads.listAllMethods.mockRejectedValueOnce(new Error("methods down")).mockResolvedValue([learnedMethod("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z")]);
    open(); await ready();
    expect(part("methods")).toHaveAttribute("data-state", "error");
    expect(part("methods")).not.toHaveAttribute("data-count");
    expect((await sentenceOf()).textContent).not.toMatch(/种做法|近 30 天新增/u);
    await userEvent.click(within(alertWith("暂时读不到学到的做法")).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(part("methods")).toHaveAttribute("data-count", "1"));
    expect(screen.getByRole("button", { name: "证据矩阵先行" })).toBeInTheDocument();
    expect(part("methods").closest("li")!.querySelector("a")).toHaveAttribute("href", "/app/memory?tab=methods");
    await userEvent.click(screen.getByRole("button", { name: "证据矩阵先行" }));
    expect(where()).toContain("open=method%3Am1");
  });

  it("keeps known historical entries visible with an incomplete label when another source fails", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn());
    reads.listAllMethods.mockRejectedValue(new Error("methods down"));
    open(); await ready();
    const history = screen.getByRole("list", { name: "最近的记忆变化" });
    expect(within(history).getByRole("button", { name: "检索截止到今年九月" })).toBeInTheDocument();
    expect(screen.getByText("仅显示已读取的变化，其他来源尚未完整读取。")).toBeInTheDocument();
    expect((await sentenceOf()).textContent).not.toMatch(/近 30 天新增/u);
  });

  it("keeps received and handover errors independently recoverable", async () => {
    reads.fetchMemoryMap.mockResolvedValue(livedIn());
    reads.fetchReceivedCapsules.mockRejectedValueOnce(new Error("shelf down")).mockResolvedValue([receivedPack("a")]);
    reads.previewCapsuleExport.mockRejectedValue(new Error("preview down"));
    open(); await ready();
    expect(part("received")).toHaveAttribute("data-state", "error");
    expect(part("you")).toHaveAttribute("data-state", "content");
    await userEvent.click(within(alertWith("暂时读不到收到的胶囊")).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(part("received")).toHaveAttribute("data-count", "1"));
    await userEvent.click(screen.getByRole("link", { name: /收到的胶囊/ }));
    const hand = document.querySelector<HTMLElement>("[data-overview-handover]")!;
    expect(await within(hand).findByRole("note")).toHaveTextContent("暂时读不到你能交出去的内容。");
    expect(within(hand).getByRole("button", { name: /重试/u })).toBeInTheDocument();
  });

  it("retains the last valid values on a failed refresh and does not present a stale recent count as current", async () => {
    reads.fetchMemoryMap.mockResolvedValueOnce(livedIn()).mockRejectedValueOnce(new Error("refresh failed"));
    open(); await ready();
    expect(part("you")).toHaveAttribute("data-count", "4");
    act(() => announceMemoryChanged());
    await waitFor(() => expect(alertWith("记忆暂未刷新")).toBeInTheDocument());
    expect(part("you")).toHaveAttribute("data-count", "4");
    expect((await sentenceOf()).textContent).not.toMatch(/近 30 天新增/u);
    expect(screen.queryByText("开始积累你的记忆")).not.toBeInTheDocument();
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
