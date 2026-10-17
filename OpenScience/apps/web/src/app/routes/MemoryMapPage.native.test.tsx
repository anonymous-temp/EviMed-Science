// The map of an account whose memory is kept as files: the same page as for the older kind of account, drawn from a document that
// has no replaced version, no disagreement and no use count. Each view says only what the document has; none draws an empty lane.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapEdge, MapNode, MemoryMap } from "@/lib/memoryMapClient";
import { nativeProfile } from "@/components/memory/__fixtures__/memoryProfiles";
import { MemoryMapPage } from "./MemoryMapPage";

const map = vi.hoisted(() => ({ fetchMemoryMap: vi.fn(), fetchRecordLinks: vi.fn() }));
const api = vi.hoisted(() => ({ fetchMemoryProfile: vi.fn() }));
vi.mock("@/lib/memoryMapClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/memoryMapClient")>("@/lib/memoryMapClient")), ...map }));
vi.mock("@/lib/apiClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/apiClient")>("@/lib/apiClient")), ...api }));
vi.mock("@/lib/methodsClient", async () => ({ ...(await vi.importActual<typeof import("@/lib/methodsClient")>("@/lib/methodsClient")), listAllMethods: () => Promise.resolve([]) }));
vi.mock("@/lib/sourceClient", () => ({ getSource: vi.fn() }));
vi.mock("@/components/markdown-viewer/MarkdownViewer", () => ({ MarkdownViewer: ({ children }: { children: string }) => <div>{children}</div> }));

/** The document the control plane draws from the native fixture: a mark per memory, every one in force, tied to its project or the account. */
function nativeMap(): MemoryMap {
  const memories: MapNode[] = nativeProfile.records.map((record) => ({
    id: `memory:${record.id}`, type: "memory", subtype: record.kind, group: "记忆", label: (record.summary || record.value).slice(0, 24), weight: 0.5, state: "current",
    at: record.createdAt ?? undefined, projectId: record.scope === "project" ? record.scopeId : null, open: { kind: "record", id: record.id },
  }));
  const nodes: MapNode[] = [{ id: "you:account", type: "you", label: "你", state: "current" }, { id: "project:prj_1", type: "project", label: "订单服务", state: "current", projectId: "prj_1" }, ...memories];
  const edges: MapEdge[] = memories.map((node) => ({ from: node.id, to: node.projectId ? "project:prj_1" : "you:account", type: "belongs-to" }));
  return {
    version: 1,
    scope: { projectId: null, range: { from: null, to: "2026-10-13", unit: "month" }, timeZone: "Asia/Shanghai", focus: null, depth: null },
    status: { topics: "empty" },
    summary: { memories: memories.length, documents: 0, methods: 0, projects: 1, needsLook: 0, since: "2026-10-12" },
    facets: {
      projects: [{ id: "prj_1", name: "订单服务", kind: "own", memories: 2, documents: 0 }], kinds: [{ id: "profile", label: "背景", count: 3 }, { id: "preference", label: "偏好", count: 2 }],
      topics: [],
      dimensions: [{ id: "memory", title: "各方面记了多少", previous: "30 天前", scale: "count", total: 7, previousTotal: 0, axes: [
        { id: "aspect:background", label: "背景", value: 3, previousValue: 0, count: 3, kinds: ["profile"] },
        { id: "aspect:preference", label: "偏好", value: 2, previousValue: 0, count: 2, kinds: ["preference"] },
        { id: "aspect:project", label: "项目事实", value: 1, previousValue: 0, count: 1, kinds: ["project_fact"] },
      ] }],
    },
    nodes, edges, buckets: { unit: "day", series: [{ t: "2026-10-12", memory: 7, run: 0, method: 0, feedback: 0 }] }, lanes: [],
    events: memories.slice(0, 3).map((node) => ({ id: `${node.id}:created`, at: node.at ?? "2026-10-12T02:00:00Z", type: "memory" as const, change: "created", ref: node.id, lane: "account", kind: node.subtype ?? undefined, text: node.label })),
    truncated: { nodes: 0, edges: 0 }, missing: [],
  };
}

function open(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/memory/map${search}`]}>
      <Routes><Route path="/app/memory/map" element={<MemoryMapPage />} /></Routes>
    </MemoryRouter>,
  );
}
const BACK_OFFICE = /viking|\.md\b|native|legacy|OpenViking|engine|nm_[0-9a-f]{6}|memories\//i;

beforeEach(() => {
  map.fetchMemoryMap.mockReset().mockResolvedValue(nativeMap());
  map.fetchRecordLinks.mockReset().mockResolvedValue({ rests: [], replaced: [], replacedBy: null, conflicts: [], usedIn: [] });
  api.fetchMemoryProfile.mockReset().mockResolvedValue(nativeProfile);
});
afterEach(cleanup);

describe("记忆地图 of an account whose memory is kept as files", () => {
  it("says what it remembers, draws the relation view with a legend of only what is in it, and offers no filter for nothing", async () => {
    open();
    expect(await screen.findByText("EviMed 记住了你的 7 件事。")).toBeInTheDocument();
    const legend = screen.getByRole("group", { name: "图例" });
    expect(legend).toHaveTextContent("现行");
    expect(legend).toHaveTextContent("● 记忆");
    // The account has one decision, so the diamond is named; it has no document, no method and no outside source.
    expect(legend).toHaveTextContent("◆ 决定与纠正");
    expect(legend).toHaveTextContent("⬢ 你、项目与折叠的一组");
    for (const absent of ["需要看一眼", "已被替代", "资料", "做法", "论文", "概念"]) expect(legend).not.toHaveTextContent(absent);
    expect(screen.queryByRole("button", { name: "只看需要看一眼的" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BACK_OFFICE);
  });

  it("says in the time view what happened and nothing of bars, grey or amber that the document has none of", async () => {
    open("?view=time");
    expect(await screen.findByRole("img", { name: /时间线：3 次变化/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/蓝条|灰条|琥珀|沿革/u);
    // The weekly bars are the card above it, and the window's one entry is that card's slider: nothing explains how to read either.
    expect(screen.getByRole("img", { name: /每周记下、合并和忘记的数量/u })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/拖下面的滑块/u);
  });

  it("draws the aspects it has and the calendar of the days it was written", async () => {
    open("?view=dims");
    expect(await screen.findByRole("img", { name: /各方面记了多少：背景 3，偏好 2，项目事实 1/u })).toBeInTheDocument();
    cleanup();
    open("?view=activity");
    expect(await screen.findByRole("img", { name: /近一年的活跃日历，共 1 天有记录/u })).toBeInTheDocument();
  });

  it("opens a mark in the memory's own drawer: a line of the profile with the document it belongs to, a file by its topic", async () => {
    open();
    const line = nativeProfile.records.find((record) => record.value === "所在科室是临床药学部。")!;
    await userEvent.click(await screen.findByRole("button", { name: /所在科室是临床药学部/ }));
    const drawer = await screen.findByRole("dialog", { name: "背景" });
    expect(within(drawer).getByText("个人档案里的其他内容")).toBeInTheDocument();
    expect(within(drawer).getByText("临床药师，关注老年人慢病管理。")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BACK_OFFICE);
    expect(line.document).toBeTruthy();
  });
});
