import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainRecord } from "@/components/memory/__fixtures__/memoryProfiles";
import { livedIn, memoryMark, ownerFirstDay, receivedPack, TODAY } from "@/components/memory/overview/__fixtures__/overviewDocs";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import type { WebMethod } from "@/lib/methodsClient";
import { MemoryOverviewPage } from "./MemoryOverviewPage";

const reads = vi.hoisted(() => ({
  fetchMemoryMap: vi.fn(), fetchReceivedCapsules: vi.fn(), fetchMyCapsule: vi.fn(), fetchMemorySettings: vi.fn(), fetchMemoryProfile: vi.fn(), listAllMethods: vi.fn(),
  feature: { value: "on" as "on" | "off" | "loading" },
}));
vi.mock("@/lib/memoryMapClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")), fetchMemoryMap: reads.fetchMemoryMap }));
vi.mock("@/lib/memoryClient", async () => ({
  ...(await vi.importActual<typeof import("@/lib/memoryClient")>("@/lib/memoryClient")),
  fetchReceivedCapsules: reads.fetchReceivedCapsules, fetchMyCapsule: reads.fetchMyCapsule,
}));
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
// A canvas is not drawn in jsdom: the chart says in words what it holds, and a mark that is pressed is pressed through the chart's own handler.
const chart = vi.hoisted(() => ({ on: null as null | { click?: (params: unknown) => void } }));
vi.mock("@/components/charts/MapChart", () => ({
  MapChart: ({ label, on }: { label: string; on?: { click?: (params: unknown) => void } }) => { chart.on = on ?? null; return <div role="img" aria-label={label} data-chart="growth" />; },
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
        <Route path="/app/files" element={<p>知识库页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;
const learnedMethod = (id: string, title: string, at: string): WebMethod => ({
  id, projectId: null, revision: 1, name: `method-${id}`, title, description: "", whenToUse: "", status: "approved", statusReason: null, origin: "inferred", counts: null,
  promotion: { status: "approved", reasons: [], missing: [] }, body: "", createdAt: at, updatedAt: at,
});
/** The page's one sentence: its text is broken up by the links that are its numbers, so it is read whole. */
const sentence = async () => {
  await waitFor(() => expect(document.querySelector("[data-headline]")).not.toBeNull());
  return document.querySelector<HTMLElement>("[data-headline]")!;
};
const band = () => screen.getByRole("region", { name: "记忆胶囊的五个数字" });
const tile = (label: string) => within(band()).getByRole("link", { name: new RegExp(`^${label} `, "u") });
const tileValue = (label: string) => tile(label).querySelector("[data-stat-value]")!.textContent;
async function ready() {
  await waitFor(() => expect(within(band()).queryAllByRole("link")).toHaveLength(5), { timeout: 4_000 });
}
/** A capsule with `count` memories about the person, relations between them and a topic grouping, for the panel that waits for enough to see. */
function manyMemories(count: number, relations: number): MemoryMap {
  const memories: MapNode[] = Array.from({ length: count }, (_unused, index) => memoryMark(`m${index}`, { label: `第 ${index} 条`, at: `2026-10-${String(1 + (index % 9)).padStart(2, "0")}T02:00:00.000Z` }));
  const edges: MapEdge[] = Array.from({ length: relations }, (_unused, index) => ({ id: `e${index}`, from: `memory:m${index}`, to: "document:src_1", type: "rests-on" as const }));
  const doc = livedIn();
  return {
    ...doc,
    summary: { ...doc.summary, memories: count },
    facets: { ...doc.facets, aboutYou: [{ id: "preference", label: "偏好", count }] },
    nodes: [...doc.nodes.filter((node) => node.type !== "memory"), ...memories], edges,
    events: memories.map((node) => ({ id: `${node.id}:created`, at: node.at as string, type: "memory" as const, change: "created", ref: node.id, text: node.label })),
  };
}

beforeEach(() => {
  // Only the clock is held: "the last thirty days" is counted from a day the fixtures are dated against, and nothing else is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TODAY);
  chart.on = null;
  reads.feature.value = "on";
  reads.fetchMemoryMap.mockReset().mockResolvedValue(livedIn());
  reads.fetchReceivedCapsules.mockReset().mockResolvedValue([receivedPack("a", { enabled: true }), receivedPack("b", { enabled: false, importedAt: "2026-10-10T02:00:00.000Z" })]);
  reads.fetchMyCapsule.mockReset().mockResolvedValue({ capsule: { id: "cap_1" }, capsules: [], entries: [], forgotten: [] });
  reads.fetchMemorySettings.mockReset().mockResolvedValue({ learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null });
  reads.fetchMemoryProfile.mockReset().mockResolvedValue({ records: [], groups: {}, activeCount: 0, pendingCount: 0 });
  reads.listAllMethods.mockReset().mockResolvedValue([learnedMethod("m1", "证据矩阵先行", "2026-09-24T02:00:00.000Z"), learnedMethod("m2", "先写方法学限制", "2026-10-02T02:00:00.000Z")]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("总览 as a data page", () => {
  it("is five tiles, each a whole link to the list it counts, and the knowledge base's the one that leaves", async () => {
    open();
    await ready();
    expect(within(band()).getAllByRole("link").map((link) => [link.getAttribute("aria-label"), link.getAttribute("href")])).toEqual([
      ["关于你 4，查看", "/app/memory?tab=self"], ["项目 2，查看", "/app/memory?tab=project"], ["做法 2，查看", "/app/memory?tab=methods"],
      ["收到的 1，查看", "/app/memory?tab=received"], ["知识 39，查看", "/app/files"],
    ]);
    expect(tile("项目")).toHaveTextContent("3 条记忆");
    expect(tile("收到的")).toHaveTextContent("共 2 个");
    // The last thirty days from 2026-10-12 are counted from 2026-09-13: every note and both methods are inside.
    expect(tile("关于你")).toHaveTextContent("近 30 天 +4");
    expect(tile("做法")).toHaveTextContent("近 30 天 +2");
  });

  it("says in one sentence what is the tiles' numbers, each number a link to the list it counts, with no package in it counted as a memory", async () => {
    open();
    await ready();
    const text = await sentence();
    expect(text).toHaveTextContent("记住了 4 条关于你的事、2 个项目的 3 条记忆，学会了 2 种做法；最近一次在10月8日。");
    expect(within(text).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["4", "/app/memory?tab=self"], ["2", "/app/memory?tab=project"], ["3", "/app/memory?tab=project"], ["2", "/app/memory?tab=methods"],
    ]);
    // The headline's numbers are the tiles': nothing on the page counts the received packs as something remembered.
    expect([tileValue("关于你"), tileValue("项目"), tileValue("做法")]).toEqual(["4", "2", "2"]);
    for (const link of within(text).getAllByRole("link")) expect(link).toHaveClass("underline");
  });

  it("has the five tabs and no 地图 among them, the numbers of the lists on the tabs that have one", async () => {
    open();
    await ready();
    const tabs = within(screen.getByRole("tablist", { name: "记忆" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["总览", "关于你4", "项目", "做法2", "收到的1"]);
    expect(screen.queryByRole("tab", { name: "地图" })).toBeNull();
  });

  it("draws the changes as a chart and, behind it, a table of the same changes whose rows open the drawer of what they are", async () => {
    const user = userEvent.setup();
    reads.fetchMemoryProfile.mockResolvedValue({ records: [plainRecord({ id: "p2", kind: "decision", summary: "主要结局取卒中和系统性栓塞", value: "主要结局取卒中和系统性栓塞" })], groups: {}, activeCount: 1, pendingCount: 0 });
    open();
    await ready();
    expect(screen.getByRole("heading", { name: "变化" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "最近变化" });
    // The newest first; a row says what happened, when and where.
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("李主任的工作方式 b收下 · 10月10日 · 收到的");
    expect(within(list).getAllByRole("listitem")[2]).toHaveTextContent("检索截止到今年九月");
    expect(within(list).getAllByRole("listitem")[2]).toHaveTextContent("记下 · 10月8日 · 阿司匹林一级预防");
    await user.click(within(list).getByRole("button", { name: "主要结局取卒中和系统性栓塞" }));
    expect(where()).toContain("open=record%3Ap2");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens a method's row in the method's drawer and a pack's in the pack's, and sends the documents' row to the knowledge base with the ↗ that says it leaves", async () => {
    const user = userEvent.setup();
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a", { enabled: true, title: "李主任的工作方式", importedAt: "2026-10-09T02:00:00.000Z" })]);
    open();
    await ready();
    const list = await screen.findByRole("list", { name: "最近变化" });
    await user.click(within(list).getByRole("button", { name: "李主任的工作方式" }));
    expect(where()).toContain("open=pack%3Aa");
    expect(await screen.findByRole("dialog", { name: "李主任的工作方式" })).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /关闭/ }));
    const documents = within(list).getAllByRole("link", { name: "放进 1 份资料" })[0]!;
    expect(documents).toHaveAttribute("href", "/app/files");
    expect(documents.closest("li")!.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();
  });

  it("narrows the table, the chart and the panel by the range, and the toolbar's mark lets go", async () => {
    const user = userEvent.setup();
    // A memory from June: inside the whole range, outside the last thirty days.
    const doc = livedIn();
    const old = memoryMark("old", { at: "2026-06-01T02:00:00.000Z", label: "六月的一句话" });
    reads.fetchMemoryMap.mockResolvedValue({ ...doc, nodes: [...doc.nodes, old], events: [...doc.events, { id: "memory:old:created", at: old.at as string, type: "memory", change: "created", ref: old.id, text: old.label }] });
    open();
    await ready();
    await screen.findByRole("list", { name: "最近变化" });
    const count = () => Number(screen.getByRole("heading", { name: "最近变化" }).nextElementSibling!.textContent);
    const before = count();
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    await user.click(within(toolbar).getByRole("button", { name: "近 30 天" }));
    await waitFor(() => expect(where()).toContain("range=30d"));
    await waitFor(() => expect(count()).toBeLessThan(before));
    expect(within(screen.getByRole("heading", { name: "变化" }).closest("section")!).getByText("近 30 天")).toBeInTheDocument();
    // The numbers are the capsule's, whatever the range: the tiles and the sentence did not move.
    expect(tileValue("关于你")).toBe("4");
  });

  it("selects the week of a weekly cell in the address, shows it as a mark that lets go, and narrows the table to it", async () => {
    const user = userEvent.setup();
    // Past thirty changes the chart counts weeks.
    reads.fetchMemoryMap.mockResolvedValue(manyMemories(32, 0));
    open();
    await ready();
    await screen.findByRole("list", { name: "最近变化" });
    chart.on!.click!({ data: { value: [3, 0, 5, 3] } });
    await waitFor(() => expect(where()).toMatch(/week=2026-\d\d-\d\d/));
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    const mark = await within(toolbar).findByRole("button", { name: /这一周/ });
    await user.click(mark);
    await waitFor(() => expect(where()).not.toContain("week="));
  });

  it("is only what needs a look under 「只看需要看一眼」, each row saying why, and the toggle carries the count", async () => {
    const user = userEvent.setup();
    open();
    await ready();
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    await user.click(within(toolbar).getByRole("button", { name: "只看需要看一眼 1" }));
    await waitFor(() => expect(where()).toContain("look=1"));
    const list = await screen.findByRole("list", { name: "需要看一眼的记忆" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("listitem")).toHaveTextContent("主要结局取卒中和系统性栓塞");
    expect(within(list).getByRole("listitem")).toHaveTextContent("依据的资料有更新");
    expect(screen.getByRole("heading", { name: "需要看一眼" })).toBeInTheDocument();
  });

  it("is one recipe with one button for an account with no memory and no learned method, and the tiles still stand", async () => {
    const user = userEvent.setup();
    reads.fetchMemoryMap.mockResolvedValue(ownerFirstDay());
    reads.listAllMethods.mockResolvedValue([]);
    reads.fetchReceivedCapsules.mockResolvedValue([receivedPack("a", { enabled: true }), receivedPack("b", { enabled: true })]);
    open();
    await ready();
    expect(screen.getByText("还没有记下关于你的事。")).toBeInTheDocument();
    expect(screen.getByText("在对话里说“记住…”，或把其他 AI 记住的内容搬过来。")).toBeInTheDocument();
    const body = document.querySelector("[data-page-body]") as HTMLElement;
    expect(within(body).getAllByRole("button")).toHaveLength(1);
    // No sentence, no chart, no table: nothing of what there is to show is a number about nothing.
    expect(document.querySelector("[data-headline]")).toBeNull();
    expect(document.querySelector("[data-chart]")).toBeNull();
    expect(screen.queryByRole("list", { name: "最近变化" })).toBeNull();
    expect(tileValue("收到的")).toBe("2");
    expect(tileValue("关于你")).toBe("0");
    await user.click(within(body).getByRole("button", { name: "从其他 AI 导入" }));
    expect(await screen.findByRole("dialog", { name: "从其他 AI 导入" })).toBeInTheDocument();
  });
});

describe("the relations and topics", () => {
  const panel = () => screen.queryByRole("tablist", { name: "关系与主题" });

  it("are not drawn below twelve memories: there is no empty frame for them", async () => {
    reads.fetchMemoryMap.mockResolvedValue(manyMemories(11, 5));
    open();
    await ready();
    await screen.findByRole("list", { name: "最近变化" });
    expect(panel()).toBeNull();
  });

  it("are not drawn from twelve memories with fewer than three relations and no topics", async () => {
    reads.fetchMemoryMap.mockResolvedValue(manyMemories(12, 2));
    open();
    await ready();
    await screen.findByRole("list", { name: "最近变化" });
    expect(panel()).toBeNull();
  });

  it("are drawn from twelve memories with three relations, the relations first, and switched to the topics by the card's own two-way switch kept in the address", async () => {
    const user = userEvent.setup();
    reads.fetchMemoryMap.mockResolvedValue(manyMemories(12, 3));
    open();
    await ready();
    const switcher = await screen.findByRole("tablist", { name: "关系与主题" });
    // The card's heading is its conclusion, and the switch is at the heading's end.
    const card = switcher.closest("section")!;
    expect(within(card).getByRole("heading")).toHaveTextContent("12 件现行的记忆");
    expect(within(switcher).getByRole("tab", { name: "关系" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(switcher).getByRole("tab", { name: "主题" }));
    expect(where()).toContain("explore=topics");
    expect(within(await screen.findByRole("tablist", { name: "关系与主题" })).getByRole("tab", { name: "主题" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("list", { name: "主题排行" })).toBeInTheDocument();
  });

  it("open on the topics when there are too few relations to draw and the model has grouped the memories", async () => {
    const grouped = manyMemories(12, 0);
    reads.fetchMemoryMap.mockResolvedValue({ ...grouped, facets: { ...grouped.facets, topics: [{ id: "t1", label: "写作习惯", weight: 6, trend: 1, members: [] }] } });
    open();
    await ready();
    const switcher = await screen.findByRole("tablist", { name: "关系与主题" });
    expect(within(switcher).getByRole("tab", { name: "主题" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("写作习惯")).toBeInTheDocument();
  });
});

describe("a part that could not be read", () => {
  it("says so in place of its number and never draws a zero: a failed methods read leaves the other four tiles and their sentence", async () => {
    reads.listAllMethods.mockRejectedValue(new Error("down"));
    open();
    await waitFor(() => expect(within(band()).getAllByText("暂时读不到")).toHaveLength(1));
    expect(tileValue("关于你")).toBe("4");
    expect(await sentence()).toHaveTextContent("记住了 4 条关于你的事、2 个项目的 3 条记忆；最近一次在10月8日。");
    expect(within(band()).queryByRole("link", { name: /^做法 / })).toBeNull();
  });

  it("names the memories a failed source of the map takes away, with its retry, and keeps the part that was read", async () => {
    reads.fetchMemoryMap.mockResolvedValue({ ...livedIn(), missing: ["documents"] });
    open();
    expect(await screen.findByText("有一部分记忆没有读到，对应的数字先不显示。")).toBeInTheDocument();
    await waitFor(() => expect(within(band()).getAllByText("暂时读不到").length).toBeGreaterThan(0));
    expect(tileValue("关于你")).toBe("4");
    expect(within(band()).queryByRole("link", { name: /^知识 / })).toBeNull();
    expect(screen.queryByRole("list", { name: "最近变化" })).toBeNull();
  });

  it("is a failed read with a retry when the map cannot be read at all, and the packs and methods are still counted", async () => {
    reads.fetchMemoryMap.mockRejectedValue(new Error("down"));
    open();
    expect(await screen.findByText("暂时读不到记忆。")).toBeInTheDocument();
    await waitFor(() => expect(tileValue("收到的")).toBe("1"));
    expect(tileValue("做法")).toBe("2");
    expect(document.querySelector("[data-headline]")).not.toBeNull();
    expect(await sentence()).toHaveTextContent("学会了 2 种做法");
  });
});

describe("an address of the retired map", () => {
  it("narrows by the project it names and shows it as a mark that lets go", async () => {
    const user = userEvent.setup();
    open("?project=prj_b");
    await ready();
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    await user.click(await within(toolbar).findByRole("button", { name: /项目：/ }));
    await waitFor(() => expect(where()).not.toContain("project="));
  });

  it("goes to the lists when the deployment draws no map", () => {
    reads.feature.value = "off";
    open();
    expect(screen.getByText("记忆页")).toBeInTheDocument();
    expect(where()).toBe("/app/memory?tab=self");
  });
});
