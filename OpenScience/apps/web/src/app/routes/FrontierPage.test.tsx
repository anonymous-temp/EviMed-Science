import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type {
  FrontierDaily,
  FrontierHotBoard,
  FrontierHotEvent,
  FrontierItem,
  FrontierItemsPage,
  FrontierItemsQuery,
  FrontierStatus,
} from "@/lib/frontierClient";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierPage } from "./FrontierPage";
import { expectComposed } from "@/test/expectComposed";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(),
  listFrontierFollows: vi.fn(),
  fetchFrontierStatus: vi.fn(),
  listFrontierItems: vi.fn(),
  fetchFrontierForYou: vi.fn(),
  fetchFrontierHotBoard: vi.fn(),
  listFrontierDailies: vi.fn(),
  fetchFrontierDaily: vi.fn(),
  fetchFrontierItem: vi.fn(),
  listFrontierWeeklies: vi.fn(),
  fetchFrontierWeekly: vi.fn(),
  fetchFrontierSources: vi.fn(),
  starFrontierItem: vi.fn(),
  unstarFrontierItem: vi.fn(),
  hideFrontierItem: vi.fn(),
  unhideFrontierItem: vi.fn(),
  markFrontierItemRead: vi.fn(),
  saveFrontierItemToLibrary: vi.fn(),
  listFrontierTags: vi.fn(),
  fetchFrontierTag: vi.fn(),
  addFrontierFollow: vi.fn(),
}));
// Partial: the vocabulary, the parsers and the error words stay real.
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));
// The followed zones the 关注 view reads (the page itself needs only their number).
const zones = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), listFollowedEvidence: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()),
  ...zones,
}));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebProjectId: () => "project-one",
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
// Day groups are the reader's calendar days, so the fixtures sit on known days
// whatever hour the suite runs at: "today" a second ago, the rest before midnight.
const MIDNIGHT = new Date().setHours(0, 0, 0, 0);
const beforeMidnight = (hours: number) => new Date(MIDNIGHT - hours * HOUR).toISOString();

function status(overrides: Partial<FrontierStatus> = {}): FrontierStatus {
  return {
    enabled: true, audience: "all",
    plugin: { state: "ok", lastPullAt: ago(0) },
    lastPublishedAt: ago(1), lastDailyDay: null,
    sources: { total: 753, enabled: 267, healthy: 250, degraded: 10, unreadable: 7, drifted: 0, planned: 486 },
    counts: { today: 40, selectedToday: 18 },
    personalization: "available",
    capabilities: { saveToLibrary: true, abstractZh: true, forYou: true, hot: true, daily: true },
    versions: { content: "1", hot: null, daily: null },
    ...overrides,
  };
}

function page(items: FrontierItem[], overrides: Partial<FrontierItemsPage> = {}): FrontierItemsPage {
  return { items, nextCursor: null, version: "1", mode: "list", related: false, restarted: false, ...overrides };
}

function hotEvent(rank: number, overrides: Partial<FrontierHotEvent> = {}): FrontierHotEvent {
  return {
    rank, id: `ev${rank}`, title: `热点事件 ${rank}`, latest: null, sourceCount72h: 2, reportCount: 3, primary: null, hasPrimary: false,
    firstAt: ago(30), lastAt: ago(3), status: "developing", heat: 40 - rank * 3, rankChange: null, badge: null,
    trend: [20, 22, 25, 27, 30, 33, 37].map((heat, index) => ({ at: ago(24 - index * 4), heat })), period: null,
    ...overrides,
  };
}

function board(events: FrontierHotEvent[], overrides: Partial<FrontierHotBoard> = {}): FrontierHotBoard {
  return { window: "current", takenAt: ago(0.2), since: ago(72.2), events, ...overrides };
}

const followedZone = { id: "ez_1", title: "房颤抗凝", evidenceCount: 4 };
const today = frontierItem({ id: "today-1", title: "今天的一条 RCT", timelineAt: new Date(Date.now() - 1000).toISOString(), score: 86, scoreBand: "high" });
const yesterday = frontierItem({ id: "yesterday-1", title: "昨天的一条指南", timelineAt: beforeMidnight(6) });
const alert = frontierItem({ id: "alert-1", title: "I 级召回：葡萄糖注射液含不锈钢颗粒", safetyAlert: true, lane: "safety", laneLabel: "药物安全",
  evidenceType: "safety-notice", evidenceTypeLabel: "安全通告", source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(2) });
const alert2 = frontierItem({ id: "alert-2", title: "氯巴占口服混悬液条形码错误", safetyAlert: true, source: { id: "mhra", name: "英国 MHRA" }, timelineAt: ago(30) });
const oldAlert = frontierItem({ id: "alert-old", title: "三天前的召回", safetyAlert: true, source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(60) });
/** Newer than `today`, for what arrives above the top of the list. */
const newer = frontierItem({ id: "newer-1", title: "刚发布的一条", timelineAt: new Date().toISOString() });

/** The main list; the strip's safety notices are asked with `safety`. */
let feed: (query: FrontierItemsQuery) => Promise<FrontierItemsPage>;
let alerts: () => Promise<FrontierItemsPage>;
const feedQueries = () => client.listFrontierItems.mock.calls.map(([query]) => query as FrontierItemsQuery).filter((query) => !query.safety);
const lastFeedQuery = () => feedQueries().at(-1);

function Probe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(path = "/app/frontier") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/frontier" element={<><FrontierPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent ?? "";

beforeEach(() => {
  Object.values(client).forEach((mock) => mock.mockReset());
  useToastStore.setState({ toasts: [] });
  client.useFrontierFeature.mockReturnValue("on");
  client.listFrontierFollows.mockResolvedValue([{ id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false }]);
  Object.values(zones).forEach((mock) => mock.mockReset());
  zones.listEvidenceZones.mockResolvedValue({ items: [followedZone], nextCursor: null });
  zones.listFollowedEvidence.mockResolvedValue({ items: [], nextCursor: null });
  client.fetchFrontierStatus.mockResolvedValue(status());
  feed = async () => page([today, yesterday]);
  alerts = async () => page([alert, alert2, oldAlert]);
  client.listFrontierItems.mockImplementation(async (query: FrontierItemsQuery) => (query.safety ? alerts() : feed(query)));
  client.fetchFrontierForYou.mockResolvedValue(null);
  client.fetchFrontierHotBoard.mockResolvedValue(null);
  client.listFrontierDailies.mockResolvedValue(null);
  client.fetchFrontierDaily.mockResolvedValue(null);
  client.starFrontierItem.mockResolvedValue({ starred: true, hidden: false, read: false });
  client.unstarFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
  client.hideFrontierItem.mockResolvedValue({ starred: false, hidden: true, read: false });
  client.unhideFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
  client.markFrontierItemRead.mockResolvedValue({ starred: false, hidden: false, read: true });
  client.listFrontierTags.mockResolvedValue([]);
  client.fetchFrontierTag.mockResolvedValue(null);
  client.addFrontierFollow.mockImplementation(async (input: { kind: string; key: string; label: string }) => ({ id: "f-new", muted: false, ...input }));
});

describe("where the module is not offered", () => {
  it("says one sentence and reads nothing", async () => {
    client.useFrontierFeature.mockReturnValue("off");
    renderPage();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.listFrontierItems).not.toHaveBeenCalled();
    expect(client.fetchFrontierStatus).not.toHaveBeenCalled();
  });

  it("turns into that sentence when the server answers frontier_not_enabled", async () => {
    client.fetchFrontierStatus.mockRejectedValue(new WebApiError("off", { status: 404, code: "frontier_not_enabled" }));
    renderPage();
    expect(await screen.findByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

/** The one row of controls: the six view tabs, and the right-hand controls of the view that is open. */
const viewTabs = () => within(screen.getByRole("tablist", { name: "动态视图" }));
/** The page's toolbar: the views and the search on its first row, the open view's controls on its second. */
const controlRow = () => screen.getByRole("group", { name: "动态筛选与搜索" });
/** The second row alone, where the open view has one. */
const secondRow = () => controlRow().querySelector<HTMLElement>("[data-toolbar-row]");
const lanes = () => within(screen.getByRole("group", { name: "栏目" }));

describe("the page and its views", () => {
  it("opens on 精选 under a one-line header — the title and a link to the evidence zones — with the search in the toolbar of the sticky band, no sentence under it", async () => {
    renderPage();
    const title = screen.getByRole("heading", { level: 1, name: "前沿动态" });
    const header = title.closest("header")!;
    expect(within(header).queryByRole("link", { name: "证据专区" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "证据专区" })).toBeInTheDocument();
    // The views, the filters and the search are one toolbar, in the band the shell keeps at the top of the page (R19, audit D C1d).
    const toolbar = screen.getByRole("group", { name: "动态筛选与搜索" });
    expect(toolbar).toContainElement(screen.getByRole("combobox", { name: "搜索" }));
    expect(toolbar).toContainElement(screen.getByRole("tablist", { name: "动态视图" }));
    expect(toolbar.closest("[data-page-chrome]")).toHaveClass("sticky", "top-0");
    expect(header).not.toContainElement(screen.getByRole("combobox", { name: "搜索" }));
    expect(toolbar.compareDocumentPosition(screen.getByRole("tabpanel")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByText("今天的一条 RCT");
    expect(screen.queryByText(/每天替你读/)).not.toBeInTheDocument();
    expect(header.querySelector("p")).toBeNull();
    // The old second navigation row and the pill row of views are gone: the tabs are the one switch.
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "动态视图" })).not.toBeInTheDocument();
    expect(viewTabs().getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["精选", "全部", "证据专区", "热榜", "与我相关", "关注", "简报"]);
    expect(viewTabs().getByRole("tab", { name: "精选" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("精选");
    expect(lastFeedQuery()).toMatchObject({ view: "selected", q: null, lane: null, starred: false });
  });

  it("shows no update time under the title, even when the plugin stopped being read", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ plugin: { state: "degraded", lastPullAt: "2026-09-22T00:05:00.000Z" } }));
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await waitFor(() => expect(client.fetchFrontierStatus).toHaveBeenCalled());
    expect(screen.queryByText(/更新$/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).parentElement).toHaveTextContent(/^前沿动态$/);
  });

  it("switches views through the tabs and keeps them in the address", async () => {
    renderPage();
    await userEvent.click(viewTabs().getByRole("tab", { name: "热榜" }));
    expect(location()).toBe("/app/frontier?view=hot");
    expect(viewTabs().getByRole("tab", { name: "热榜" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(viewTabs().getByRole("tab", { name: "与我相关" }));
    expect(location()).toBe("/app/frontier?view=foryou");
    await userEvent.click(viewTabs().getByRole("tab", { name: "关注" }));
    expect(location()).toBe("/app/frontier?view=following");
    await userEvent.click(viewTabs().getByRole("tab", { name: "简报" }));
    expect(location()).toBe("/app/frontier?view=daily");
    await userEvent.click(viewTabs().getByRole("tab", { name: "精选" }));
    expect(location()).toBe("/app/frontier");
  });

  it("moves between the tabs with the arrow keys, as a tab list does", async () => {
    renderPage();
    viewTabs().getByRole("tab", { name: "精选" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(location()).toBe("/app/frontier?view=all");
    expect(viewTabs().getByRole("tab", { name: "全部" })).toHaveFocus();
  });

  it.each([
    ["/app/frontier?view=hot", "热榜"],
    ["/app/frontier?view=daily&day=2026-09-20", "简报"],
    ["/app/frontier?view=weekly", "简报"],
    ["/app/frontier?view=all", "全部"],
    ["/app/frontier?view=selected", "精选"],
    ["/app/frontier?view=foryou", "与我相关"],
    ["/app/frontier?view=following", "关注"],
    ["/app/frontier?view=unknown", "精选"],
  ])("lands %s — an address older pages and notifications carry — on %s", async (path, tab) => {
    renderPage(path);
    expect(viewTabs().getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName(tab);
    // The view's own read settles before the page goes away.
    await waitFor(() => expect(screen.getByRole("tabpanel").querySelector(".animate-pulse")).toBeNull());
    await waitFor(() => expect(client.fetchFrontierStatus).toHaveBeenCalled());
  });
});

describe("the control row", () => {
  it("has the views and the search on its first row and, for 精选, the nine 栏目, 「专科 ▾」 and 「更多筛选 ▾」 on a second", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const tabsRow = screen.getByRole("tablist", { name: "动态视图" }).parentElement!;
    expect(tabsRow).toContainElement(screen.getByRole("combobox", { name: "搜索" }));
    const row = secondRow()!;
    expect(row).not.toBeNull();
    // 栏目 is a row of chips, one choice, all nine in sight; nothing of it is a menu.
    const group = screen.getByRole("group", { name: "栏目" });
    expect(row).toContainElement(group);
    expect(lanes().getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "指南共识", "药物安全", "审批监管", "研发产业", "公共卫生", "科研与基金", "AI 与医学"]);
    expect(lanes().getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(within(row).getByRole("button", { name: "专科" })).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(row).getByRole("button", { name: "更多筛选" })).toHaveAttribute("aria-haspopup", "dialog");
    // The old menus are gone: 全部渠道 is 来源 inside 更多筛选, and nothing stacks two dimensions in one list.
    for (const gone of ["全部渠道", "全部栏目", "全部专科", "收藏", "时间"]) expect(within(row).queryByRole("button", { name: gone })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "管理关注" })).not.toBeInTheDocument();
  });

  it("narrows by 栏目 at once, keeps it in the address, and lets go of it with 全部", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(lanes().getByRole("button", { name: "药物安全" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety" }));
    expect(location()).toBe("/app/frontier?lane=safety");
    expect(lanes().getByRole("button", { name: "药物安全" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(lanes().getByRole("button", { name: "全部" }));
    await waitFor(() => expect(lastFeedQuery()?.lane).toBeNull());
  });

  it("narrows by several specialties from their groups, then by one of their popular tags, and keeps both in the address", async () => {
    client.listFrontierTags.mockResolvedValue([{ slug: "hcc", name: "肝细胞癌", count: 34, specialties: [] }, { slug: "af", name: "心房颤动", count: 20, specialties: [] }]);
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(within(secondRow()!).getByRole("button", { name: "专科" }));
    const panel = screen.getByRole("dialog", { name: "专科" });
    // The thirty, under 内科 / 外科 / 妇儿 / 五官与皮肤 / 医技与其他.
    expect(within(panel).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["内科", "外科", "妇儿", "五官与皮肤", "医技与其他"]));
    expect(within(within(panel).getByRole("group", { name: "外科" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["普通外科", "骨科", "心胸外科", "神经外科", "泌尿外科"]);
    expect(within(panel).queryByRole("group", { name: "热门标签" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "肿瘤" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology"] }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "专科" })).getByRole("button", { name: "心血管" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology", "cardiology"] }));
    expect(new URLSearchParams(location().split("?")[1]).get("specialty")).toBe("oncology,cardiology");
    expect(screen.getByRole("button", { name: "专科：肿瘤 等 2 个" })).toBeInTheDocument();
    // Their popular tags, the second level of the same panel.
    await waitFor(() => expect(client.listFrontierTags).toHaveBeenLastCalledWith({ specialties: ["oncology", "cardiology"], limit: 24 }));
    const hot = within(screen.getByRole("dialog", { name: "专科" })).getByRole("group", { name: "热门标签" });
    await userEvent.click(within(hot).getByRole("button", { name: "#肝细胞癌" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology", "cardiology"], tag: "hcc" }));
    // The chosen tag is a pressed chip of its own on the row, with 「关注」 beside it.
    expect(within(secondRow()!).getByRole("button", { name: "#肝细胞癌" })).toHaveAttribute("aria-pressed", "true");
    // 「清除」 inside the panel lets go of the specialties and the tag.
    await userEvent.click(within(screen.getByRole("dialog", { name: "专科" })).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: [], tag: null }));
  });

  it("follows the chosen tag from beside its chip, and lets go of the tag with a press on it", async () => {
    client.fetchFrontierTag.mockResolvedValue({ slug: "hcc", name: "肝细胞癌", nameEn: null, specialties: [], broader: null, narrower: [], count30d: 34, mergedFrom: null });
    renderPage("/app/frontier?tag=hcc");
    const chip = await within(controlRow()).findByRole("button", { name: "#肝细胞癌" });
    expect(lastFeedQuery()).toMatchObject({ tag: "hcc" });
    await userEvent.click(await within(controlRow()).findByRole("button", { name: "关注" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "tag", key: "hcc", label: "肝细胞癌" });
    expect(await within(controlRow()).findByRole("button", { name: "已关注" })).toBeDisabled();
    await userEvent.click(chip);
    await waitFor(() => expect(lastFeedQuery()?.tag).toBeNull());
    expect(location()).not.toContain("tag=");
  });

  it("says 已关注 beside a tag the reader already follows", async () => {
    client.listFrontierFollows.mockResolvedValue([{ id: "8", kind: "tag", key: "hcc", label: "肝细胞癌", muted: false }]);
    renderPage("/app/frontier?view=all&tag=hcc");
    expect(await within(controlRow()).findByRole("button", { name: "已关注" })).toBeDisabled();
  });

  it("reads a tag merged into another as that one, and puts it in the address", async () => {
    client.fetchFrontierTag.mockResolvedValue({ slug: "hcc", name: "肝细胞癌", nameEn: null, specialties: [], broader: null, narrower: [], count30d: 34, mergedFrom: "liver-cell-cancer" });
    renderPage("/app/frontier?view=all&tag=liver-cell-cancer");
    await waitFor(() => expect(location()).toBe("/app/frontier?view=all&tag=hcc"));
    expect(await within(controlRow()).findByRole("button", { name: "#肝细胞癌" })).toBeInTheDocument();
  });

  it("narrows by source, evidence type, time, stars and unread from 「更多筛选」, and lets go of all of them with 「清除筛选」", async () => {
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(within(secondRow()!).getByRole("button", { name: "更多筛选" }));
    const panel = () => screen.getByRole("dialog", { name: "更多筛选" });
    const group = (name: string) => within(within(panel()).getByRole("group", { name }));
    expect(group("来源").getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "文献", "资讯", "社媒", "官方"]);
    expect(group("证据类型").getAllByRole("button")[0]).toHaveTextContent("全部");
    expect(group("时间").getAllByRole("button").map((chip) => chip.textContent)).toEqual(["不限", "24 小时", "3 天", "7 天", "30 天"]);
    await userEvent.click(group("来源").getByRole("button", { name: "社媒" }));
    await userEvent.click(group("证据类型").getByRole("button", { name: "RCT" }));
    await userEvent.click(group("时间").getByRole("button", { name: "7 天" }));
    await userEvent.click(within(panel()).getByRole("switch", { name: "只看收藏" }));
    await userEvent.click(within(panel()).getByRole("switch", { name: "只看未读" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ channel: "social", evidence: "rct", window: "7d", starred: true, unread: true }));
    for (const part of ["channel=social", "evidence=rct", "window=7d", "starred=1", "unread=1"]) expect(location()).toContain(part);
    expect(screen.getByRole("button", { name: "更多筛选：更多筛选 · 5" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ channel: null, evidence: null, window: null, starred: false, unread: false }));
    expect(location()).toBe("/app/frontier?view=all");
  });

  it("offers the time range in 全部 only", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(within(secondRow()!).getByRole("button", { name: "更多筛选" }));
    expect(within(screen.getByRole("dialog", { name: "更多筛选" })).queryByRole("group", { name: "时间" })).not.toBeInTheDocument();
  });

  it.each([
    ["/app/frontier?view=all&channel=literature&evidence=rct&unread=1", { channel: "literature", evidence: "rct", unread: true }],
    ["/app/frontier?view=all&channel=podcast&evidence=anecdote", { channel: null, evidence: null }],
    ["/app/frontier?lane=pipeline&specialty=oncology&starred=1", { lane: "pipeline", specialties: ["oncology"], starred: true }],
    ["/app/frontier?specialty=oncology,cardiology", { specialties: ["oncology", "cardiology"] }],
    // A retired specialty reads as its successor, or as nothing.
    ["/app/frontier?specialty=surgery-anesthesia", { specialties: ["general-surgery"] }],
    ["/app/frontier?specialty=geriatrics,public-health,rheumatology,no-such", { specialties: ["rheumatology"] }],
  ])("reads %s from the address", async (path, expected) => {
    renderPage(path);
    await screen.findByText("今天的一条 RCT");
    expect(lastFeedQuery()).toMatchObject(expected);
  });

  it("says the chosen specialty on its chip from an older address", async () => {
    renderPage("/app/frontier?specialty=surgery-anesthesia");
    await screen.findByText("今天的一条 RCT");
    expect(within(secondRow()!).getByRole("button", { name: "专科：普通外科" })).toHaveTextContent("普通外科");
  });

  it("narrows by a card's tag in place, and from 与我相关 opens 全部 with it", async () => {
    feed = async () => page([frontierItem({ id: "tagged", title: "带标签的一条", timelineAt: ago(0.1), tags: [{ slug: "heart-failure", name: "心力衰竭" }] })]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "#心力衰竭" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?tag=heart-failure"));
    expect(lastFeedQuery()).toMatchObject({ view: "selected", tag: "heart-failure" });
    expect(within(controlRow()).getByRole("button", { name: "#心力衰竭" })).toHaveAttribute("aria-pressed", "true");
  });

  it("puts the hot list's time range on the second row, and the briefing's period", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
    renderPage("/app/frontier?view=hot");
    const range = await screen.findByRole("group", { name: "时间范围" });
    expect(secondRow()).toContainElement(range);
    expect(within(range).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["当前", "本周", "本月"]);
    expect(screen.queryByRole("group", { name: "栏目" })).not.toBeInTheDocument();
    await userEvent.click(viewTabs().getByRole("tab", { name: "简报" }));
    const period = await screen.findByRole("group", { name: "简报周期" });
    expect(secondRow()).toContainElement(period);
    expect(within(period).getByRole("button", { name: "日报" })).toHaveAttribute("aria-pressed", "true");
    // Pressing the tab again on the weekly stays on it; the chip is the way between the two.
    await userEvent.click(within(period).getByRole("button", { name: "周报" }));
    expect(location()).toBe("/app/frontier?view=weekly");
    expect(viewTabs().getByRole("tab", { name: "简报" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(viewTabs().getByRole("tab", { name: "简报" }));
    expect(location()).toBe("/app/frontier?view=weekly");
  });

  it("has no second row in 与我相关, which has no controls", async () => {
    renderPage("/app/frontier?view=foryou");
    await waitFor(() => expect(client.fetchFrontierForYou).toHaveBeenCalled());
    expect(secondRow()).toBeNull();
    expect(controlRow()).toContainElement(screen.getByRole("combobox", { name: "搜索" }));
  });

  describe("on a phone", () => {
    beforeEach(() => {
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query === "(max-width: 639px)", media: query, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("keeps the 栏目 chips on the second row, scrolling, and puts the rest behind one 「筛选」 sheet", async () => {
      renderPage("/app/frontier?view=all&specialty=oncology&starred=1");
      await screen.findByText("今天的一条 RCT");
      expect(screen.getByRole("group", { name: "栏目" }).className).toMatch(/overflow-x-auto/);
      expect(screen.queryByRole("button", { name: /^专科/ })).not.toBeInTheDocument();
      await userEvent.click(within(secondRow()!).getByRole("button", { name: "筛选，已选 2 项" }));
      const sheet = screen.getByRole("dialog", { name: "筛选" });
      for (const name of ["内科", "外科", "热门标签", "来源", "证据类型", "时间"]) expect(within(sheet).getByRole("group", { name })).toBeInTheDocument();
      expect(within(sheet).getByRole("switch", { name: "只看收藏" })).toHaveAttribute("aria-checked", "true");
      expect(within(sheet).getByRole("switch", { name: "只看未读" })).toBeInTheDocument();
      // 「重置」 lets go of the filters at once and leaves the search alone.
      await userEvent.click(within(sheet).getByRole("button", { name: "重置" }));
      await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: [], starred: false }));
      expect(location()).toBe("/app/frontier?view=all");
    });
  });
});

describe("search", () => {
  it("searches the whole feed, orders it by time on request, and goes back where it began", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.type(screen.getByRole("combobox", { name: "搜索" }), "司美格鲁肽");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", q: "司美格鲁肽" }));
    const results = await screen.findByRole("region", { name: "搜索结果" });
    expect(within(results).getAllByRole("article")).toHaveLength(2);
    // 精选 is the dot and words for a screen reader, not a chip.
    expect(within(results).getAllByText("精选")[0]).toHaveClass("sr-only");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "按时间" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ q: "司美格鲁肽", sort: "time" }));
    await userEvent.clear(screen.getByRole("combobox", { name: "搜索" }));
    await waitFor(() => expect(location()).toBe("/app/frontier"));
    expect(viewTabs().getByRole("tab", { name: "精选" })).toHaveAttribute("aria-selected", "true");
  });

  it("says once, above the results, that a search found words nowhere and these are the nearest by meaning", async () => {
    feed = async (query) => (query.q ? page([today], { mode: "hybrid", related: true }) : page([today]));
    renderPage("/app/frontier?view=all&q=ui-audit-no-match-20261007");
    const results = await screen.findByRole("region", { name: "搜索结果" });
    expect(within(results).getByText("没有找到包含“ui-audit-no-match-20261007”的动态，下面是意思相近的内容")).toBeInTheDocument();
    expect(within(results).getAllByRole("article")).toHaveLength(1);
  });

  it("says nothing of the kind about a search that matched its words", async () => {
    feed = async (query) => (query.q ? page([today], { mode: "keyword", related: false }) : page([today]));
    renderPage("/app/frontier?view=all&q=%E5%8F%B8%E7%BE%8E");
    const results = await screen.findByRole("region", { name: "搜索结果" });
    expect(results).not.toHaveTextContent("意思相近");
  });

  it("clears the query with the box's ✕ and with Escape, and the view it began in comes back", async () => {
    // The default `userEvent`: `setup()` would replace the clipboard the 日报 tests below stub.
    const user = userEvent;
    renderPage("/app/frontier?view=hot");
    await user.type(screen.getByRole("combobox", { name: "搜索" }), "司美");
    await waitFor(() => expect(location()).toContain("q="));
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?view=hot"));
    expect(screen.getByRole("combobox", { name: "搜索" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "搜索" })).toHaveFocus();
    await user.type(screen.getByRole("combobox", { name: "搜索" }), "司美");
    await waitFor(() => expect(location()).toContain("q="));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(location()).toBe("/app/frontier?view=hot"));
  });

  it("says in one sentence that nothing matched", async () => {
    feed = async (query) => (query.q ? page([]) : page([today]));
    renderPage("/app/frontier?view=all&q=%E6%97%A0%E6%AD%A4%E8%8D%AF");
    expect(await screen.findByText("没有找到和“无此药”相关的动态")).toBeInTheDocument();
  });

  it("offers the tags whose name holds the words, narrows the feed to the one chosen and empties the box; Enter still searches the words", async () => {
    client.listFrontierTags.mockImplementation(async ({ q }: { q?: string }) => (q ? [{ slug: "hcc", name: "肝细胞癌", count: 34, specialties: ["oncology"] }] : []));
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const box = screen.getByRole("combobox", { name: "搜索" });
    await userEvent.type(box, "肝细胞");
    const list = await screen.findByRole("listbox", { name: "标签建议" });
    expect(client.listFrontierTags).toHaveBeenCalledWith({ q: "肝细胞", limit: 8 });
    await userEvent.click(within(list).getByRole("option", { name: "#肝细胞癌" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?tag=hcc"));
    expect(box).toHaveValue("");
    expect(lastFeedQuery()).toMatchObject({ view: "selected", tag: "hcc", q: null });
    expect(within(controlRow()).getByRole("button", { name: "#肝细胞癌" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(box, "肝癌{Enter}");
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ view: "all", q: "肝癌", tag: "hcc" }));
  });
});

describe("精选's safety strip", () => {
  it("leads 精选 with the last 48 hours' alerts: how many, the newest, who issued it, and the rest on request", async () => {
    renderPage();
    const strip = await screen.findByRole("region", { name: "安全警示" });
    expect(strip).toHaveTextContent("安全警示 2");
    const newest = within(strip).getByRole("link", { name: /I 级召回：葡萄糖注射液含不锈钢颗粒/ });
    expect(newest).toHaveTextContent("· FDA · 2 小时前");
    expect(newest).toHaveAttribute("href", "/app/frontier/items/alert-1");
    // Every lane's alerts, three days of them, cut to 48 hours here.
    expect(client.listFrontierItems).toHaveBeenCalledWith({ view: "all", safety: true, window: "3d", limit: 50 });
    expect(strip).not.toHaveTextContent("三天前的召回");
    expect(strip).not.toHaveTextContent("氯巴占");
    await userEvent.click(within(strip).getByRole("button", { name: "全部 ›" }));
    expect(within(strip).getByRole("link", { name: /氯巴占口服混悬液条形码错误/ })).toHaveTextContent("英国 MHRA");
    // It stands above the filters' reach and above the hot list.
    const hot = screen.queryByRole("heading", { name: "当前热点" });
    if (hot) expect(strip.compareDocumentPosition(hot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not there when nothing was issued in the last 48 hours", async () => {
    alerts = async () => page([oldAlert]);
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ safety: true })));
    expect(screen.queryByRole("region", { name: "安全警示" })).not.toBeInTheDocument();
  });

  it("says so when the alerts could not be read, rather than looking like there are none", async () => {
    let fail = true;
    alerts = async () => {
      if (fail) throw new WebApiError("down", { status: 503, code: null });
      return page([alert]);
    };
    renderPage();
    const failed = await screen.findByText("无法读取安全警示");
    fail = false;
    await userEvent.click(within(failed.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("region", { name: "安全警示" })).toHaveTextContent("安全警示 1");
  });

  it("stays in 精选 whatever the filters say", async () => {
    renderPage("/app/frontier?lane=pipeline");
    expect(await screen.findByRole("region", { name: "安全警示" })).toBeInTheDocument();
  });
});

describe("当前热点", () => {
  it("shows the three hottest with their heat and how they moved, and opens the whole list", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board([
      hotEvent(1, { title: "不饱和磷脂脂质体实现亲水药物超缓释", heat: 38, rankChange: 2 }),
      hotEvent(2, { heat: 31, rankChange: -1 }),
      hotEvent(3, { heat: 27, rankChange: "new" }),
      hotEvent(4), hotEvent(5), hotEvent(6), hotEvent(7),
    ]));
    renderPage();
    const card = (await screen.findByRole("heading", { name: "当前热点" })).closest("section")!;
    expect(client.fetchFrontierHotBoard).toHaveBeenCalledWith("current");
    const rows = within(card).getAllByRole("link");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(rows[0]).toHaveTextContent("1不饱和磷脂脂质体实现亲水药物超缓释38 热度↑2");
    // A fall is not said; a first appearance is.
    expect(rows[1]).toHaveTextContent(/31 热度$/);
    expect(rows[2]).toHaveTextContent(/27 热度新$/);
    expect(within(card).queryByText("热点事件 4")).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "完整热榜 ›" }));
    expect(location()).toBe("/app/frontier?view=hot");
  });

  it("is not there without hot events, nor while the feed is narrowed", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    expect(screen.queryByRole("heading", { name: "当前热点" })).not.toBeInTheDocument();
    client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
    await userEvent.click(lanes().getByRole("button", { name: "临床证据" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "evidence" }));
    expect(screen.queryByRole("heading", { name: "当前热点" })).not.toBeInTheDocument();
  });
});

describe("the feed", () => {
  it("falls into days headed 「今天 · 10月23日 周四 · 11 条」, counting a day once it is whole, the heading held under the band", async () => {
    feed = async () => page([today, yesterday], { nextCursor: "c1" });
    renderPage();
    const headings = await screen.findAllByRole("heading", { level: 2, name: /^(今天 · )?\d+月\d+日 周./ });
    // Today is whole (the next page cannot reach back to it); the last day may continue.
    expect(headings[0]).toHaveTextContent(/^今天 · \d+月\d+日 周.· 1 条$/);
    expect(headings[1]).not.toHaveTextContent("今天");
    expect(headings[1]).not.toHaveTextContent("条");
    expect(headings[0]).toHaveClass("sticky", "top-[var(--page-chrome-h,0px)]");
    const lists = headings.map((heading) => heading.closest("section")!.querySelector("ul")!);
    expect(within(lists[0]).getByRole("heading", { level: 3 })).toHaveAttribute("data-row-title");
    // A day group's card has its clock in its own column.
    expect(within(lists[0]).getByRole("listitem").querySelector(".w-14 time")).not.toBeNull();
  });

  it("restarts from page one, quietly, when the list changed under a stale cursor", async () => {
    feed = async (query) => (query.cursor
      ? page([newer, today], { restarted: true, version: "2" })
      : page([today, yesterday], { nextCursor: "c1" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("刚发布的一条")).toBeInTheDocument();
    expect(screen.queryByText("昨天的一条指南")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("appends the next page when the cursor still holds", async () => {
    const older = frontierItem({ id: "older-1", title: "三天前的一条", timelineAt: beforeMidnight(60) });
    feed = async (query) => (query.cursor ? page([older]) : page([today], { nextCursor: "c1" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("三天前的一条")).toBeInTheDocument();
    expect(screen.getByText("今天的一条 RCT")).toBeInTheDocument();
    expect(lastFeedQuery()).toMatchObject({ cursor: "c1" });
  });

  it("says how many new items arrived above the list when the content version moves", async () => {
    let calls = 0;
    feed = async () => {
      calls += 1;
      return calls === 1 ? page([today], { version: "1" }) : page([newer, today], { version: "2" });
    };
    client.fetchFrontierStatus.mockResolvedValue(status({ versions: { content: "2", hot: null, daily: null } }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "有 1 条新的" }));
    expect(await screen.findByText("刚发布的一条")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /条新的/ })).not.toBeInTheDocument();
  });
});

describe("the four states", () => {
  it("shows the feed's skeleton while the first page is on its way", async () => {
    feed = () => new Promise(() => {});
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Everything around the list still arrives; the list alone is waiting.
    expect(await screen.findByRole("region", { name: "安全警示" })).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it.each([
    ["on a first run", { lastPublishedAt: null }, "/app/frontier", "暂无内容"],
    ["when a filter found nothing", {}, "/app/frontier?lane=safety", "没有结果"],
    ["when nothing is selected yet", {}, "/app/frontier", "暂无精选"],
  ])("says so in one sentence %s", async (_case, overrides, path, sentence) => {
    feed = async () => page([]);
    client.fetchFrontierStatus.mockResolvedValue(status(overrides));
    renderPage(path);
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it("offers a retry when nothing could be read", async () => {
    let fail = true;
    feed = async () => {
      if (fail) throw new WebApiError("down", { status: 503, code: null });
      return page([today]);
    };
    renderPage();
    const alertBox = await screen.findByRole("alert");
    fail = false;
    await userEvent.click(within(alertBox).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("今天的一条 RCT")).toBeInTheDocument();
  });

  it("keeps the last content on screen when a refresh fails", async () => {
    let calls = 0;
    feed = async () => {
      calls += 1;
      if (calls === 3) throw new WebApiError("down", { status: 503, code: null });
      return page([today]);
    };
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.click(viewTabs().getByRole("tab", { name: "全部" }));
    await waitFor(() => expect(calls).toBe(2));
    await userEvent.click(viewTabs().getByRole("tab", { name: "精选" }));
    expect(await screen.findByText("未能刷新")).toBeInTheDocument();
    expect(screen.getByText("今天的一条 RCT")).toBeInTheDocument();
  });
});

describe("the actions on a card", () => {
  it("stars an item, and puts the star back when the server refuses", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    expect(client.starFrontierItem).toHaveBeenCalledWith("today-1");
    expect(within(card).getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true");
    client.unstarFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    await userEvent.click(within(card).getByRole("button", { name: "收藏" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "收藏" })).toHaveAttribute("aria-pressed", "true"));
  });

  it("hides an item with a toast that can undo it", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
    expect(screen.queryByRole("article", { name: "今天的一条 RCT" })).not.toBeInTheDocument();
    expect(client.hideFrontierItem).toHaveBeenCalledWith("today-1");
    expect(screen.getByText("已隐藏")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
    await waitFor(() => expect(client.unhideFrontierItem).toHaveBeenCalledWith("today-1"));
  });

  it("saves to the knowledge base, and stops offering it where the server has no such route", async () => {
    client.saveFrontierItemToLibrary.mockResolvedValueOnce({ kind: "md", path: "knowledge-base/frontier/x.md", note: null }).mockResolvedValueOnce(null);
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "存入知识库" }));
    expect(client.saveFrontierItemToLibrary).toHaveBeenCalledWith("today-1", "project-one");
    expect(await screen.findByText("已存入知识库")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "存入知识库" }));
    expect(await screen.findByText("暂时不能存入知识库")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("does not offer 存入知识库 until /status names it among the deployment's capabilities", async () => {
    client.fetchFrontierStatus.mockResolvedValue(status({ capabilities: { saveToLibrary: false, abstractZh: false, forYou: false, hot: true, daily: true } }));
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await waitFor(() => expect(client.fetchFrontierStatus).toHaveBeenCalled());
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "存入知识库" })).not.toBeInTheDocument();
  });

  it("greys the title of an item once its original was opened", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    const title = () => within(within(card).getByRole("heading", { level: 3 })).getByRole("link");
    expect(title()).toHaveClass("text-title-ink");
    await userEvent.click(title());
    expect(client.markFrontierItemRead).toHaveBeenCalledWith("today-1");
    expect(title()).toHaveClass("text-text-2");
  });

  it("shows 「AI 评分」 and never a number the contract does not send", async () => {
    renderPage();
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    expect(card.querySelector("[data-score]")).toHaveTextContent(/^AI 评分\s*86$/);
    expect(card).not.toHaveTextContent("编辑评分");
    // The fixture carries scoreTotal 87 and scores 29 / 17 / 13, which the contract never sends.
    for (const number of ["87", "29", "17", "13"]) expect(card.textContent).not.toContain(number);
  });
});

describe("热榜", () => {
  const events = [
    hotEvent(1, { title: "不饱和磷脂脂质体实现亲水药物超缓释", heat: 38, primary: "paper", hasPrimary: true }),
    hotEvent(2, { heat: 31 }),
    hotEvent(3, { heat: 27, badge: "new", trend: null }),
    hotEvent(4, { heat: 24, badge: "rising" }),
  ];

  it("ranks the events with their heat over a 24-hour trend, and explains nothing about how heat is counted", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board(events, { takenAt: new Date(new Date().setHours(22, 40, 0, 0)).toISOString() }));
    renderPage("/app/frontier?view=hot");
    const list = await screen.findByRole("list", { name: "热榜" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("01");
    expect(within(rows[0]).getByRole("link", { name: "不饱和磷脂脂质体实现亲水药物超缓释" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(rows[0]).toHaveTextContent("2 家机构报道 · 含原始论文 · 3 小时前更新");
    expect(rows[0]).toHaveTextContent("38 热度");
    expect(rows[0].querySelector("svg[data-sparkline] path")).not.toBeNull();
    expect(within(rows[2]).getByText("新")).toHaveClass("bg-accent-soft");
    expect(within(rows[2]).getByText("暂无走势")).toBeInTheDocument();
    expect(within(rows[3]).getByText("升温")).toHaveClass("bg-warn-soft");
    // One title edge: every row's title link carries the marker the release walk measures.
    for (const row of rows) expect(row.querySelector("[data-row-title]")).not.toBeNull();
    expect(screen.getByText("近 72 小时 · 22:40 更新")).toBeInTheDocument();
    // The number is shown; the page does not explain the system (2026-10-07: 「热度怎么算」 is gone).
    expect(screen.queryByText("热度怎么算")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("热度衡量关注程度");
    expect(document.body.textContent).not.toContain("爆");
  });

  it("reads this week's ranking when asked, with each row's own count, and keeps the chips while it reads", async () => {
    let release: () => void = () => {};
    const week = new Promise<void>((resolve) => { release = resolve; });
    client.fetchFrontierHotBoard.mockImplementation(async (window: string) => {
      if (window !== "week") return board(events);
      await week;
      return board([hotEvent(1, { heat: null, trend: null, period: { institutions: 9, reports: 14, hoursOnList: 31, bestRank: 2 }, primary: "official", hasPrimary: true })], { window: "week" });
    });
    renderPage("/app/frontier?view=hot");
    await screen.findByRole("list", { name: "热榜" });
    expect(within(controlRow()).getByRole("button", { name: "当前" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "本周" }));
    await waitFor(() => expect(client.fetchFrontierHotBoard).toHaveBeenLastCalledWith("week"));
    expect(location()).toBe("/app/frontier?view=hot&window=week");
    expect(within(controlRow()).getByRole("button", { name: "本周" })).toHaveAttribute("aria-pressed", "true");
    release();
    expect(await screen.findByText("9 家机构报道 · 含官方公告 · 在榜 31 小时 · 最高第 2 名")).toBeInTheDocument();
    expect(screen.getByText(/^近 7 天 · \d{2}:\d{2} 更新$/)).toBeInTheDocument();
    expect(screen.queryByText("热度")).not.toBeInTheDocument();
  });

  it("leaves out what a server that stamps no ranking cannot back: the window chips and the heat", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board(events.map((event) => ({ ...event, heat: null, trend: null })), { takenAt: null }));
    renderPage("/app/frontier?view=hot");
    await screen.findByRole("list", { name: "热榜" });
    expect(screen.queryByRole("button", { name: "本周" })).not.toBeInTheDocument();
    expect(screen.queryByText("热度怎么算")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无走势")).not.toBeInTheDocument();
  });

  it("says it is still being prepared where the server has no hot list", async () => {
    renderPage("/app/frontier?view=hot");
    expect(await screen.findByText("热榜还在准备")).toBeInTheDocument();
  });
});

describe("日报", () => {
  function issue(day: string, overrides: Partial<FrontierDaily> = {}): FrontierDaily {
    return {
      day, windowStart: ago(53), windowEnd: ago(29), generatedAt: ago(28),
      lead: { item: frontierItem({ id: "lead", title: "FDA 发布新方法学（NAMs）专题" }), text: "FDA 发布直接最终规则。", event: { id: "ev1", title: "x" } },
      sections: [{ lane: "evidence", laneLabel: "临床证据", items: [today, yesterday] }],
      safety: [alert, alert2], aiMinute: null, markdown: `# EviMed 医学前沿日报 ${day}`, itemCount: 52,
      readingMinutes: 9, previousDay: null, nextDay: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    client.listFrontierDailies.mockResolvedValue({
      dailies: [
        { day: "2026-09-21", title: "口服 PCSK9 抑制剂拿到硬终点证据", itemCount: 18, generatedAt: ago(5) },
        { day: "2026-09-20", title: "FDA 批准皮下注射阿尔茨海默病抗体", itemCount: 9, generatedAt: ago(29) },
        { day: "2026-09-19", title: "医保目录初审", itemCount: 12, generatedAt: ago(53) },
      ],
      schedule: { time: "07:30", timeZone: "Asia/Shanghai" },
    });
    client.fetchFrontierDaily.mockImplementation(async (day: string) => issue(day));
  });

  it("opens the issue a notification names: the day, its size and reading time, the lead and its event", async () => {
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const header = await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    expect(client.fetchFrontierDaily).toHaveBeenCalledWith("2026-09-20");
    expect(header.parentElement).toHaveTextContent("52 条 · 约 9 分钟");
    expect(screen.getByRole("heading", { level: 3, name: "FDA 发布新方法学（NAMs）专题" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "事件页 ›" })).toHaveAttribute("href", "/app/frontier/events/ev1");
  });

  it("puts the safety alerts first, names institutions and never an interface, and starts every title on one line", async () => {
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const safety = await screen.findByRole("list", { name: "安全警示" });
    const sections = screen.getAllByRole("list").filter((list) => list.tagName === "OL");
    expect(sections[0]).toBe(safety);
    expect(within(safety).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^01I 级召回：葡萄糖注射液含不锈钢颗粒FDA详情$/),
      expect.stringMatching(/^02氯巴占口服混悬液条形码错误英国 MHRA详情$/),
    ]);
    expect(document.body.textContent).not.toMatch(/API|openFDA/);
    for (const list of sections) {
      for (const row of within(list).getAllByRole("listitem")) {
        // A fixed number column, then the title first in its own column: nothing of variable width before it.
        const [number, column] = [...row.children];
        expect(number).toHaveClass("w-8", "tabular-nums");
        expect(column.firstElementChild).toHaveAttribute("data-row-title");
      }
    }
  });

  it("copies the issue, and moves by 往期 and by 前一日 / 后一日", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("# EviMed 医学前沿日报 2026-09-20");
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "往期" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "9月21日 周一" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-21"));
    // From the archive's neighbours, where the server names none.
    await userEvent.click(await screen.findByRole("button", { name: "‹ 前一日" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-20"));
    await userEvent.click(await screen.findByRole("button", { name: "‹ 前一日" }));
    await waitFor(() => expect(client.fetchFrontierDaily).toHaveBeenLastCalledWith("2026-09-19"));
    expect(location()).toBe("/app/frontier?view=daily&day=2026-09-19");
  });

  it("leaves out the reading time a server has not counted", async () => {
    client.fetchFrontierDaily.mockImplementation(async (day: string) => issue(day, { readingMinutes: 0 }));
    renderPage("/app/frontier?view=daily&day=2026-09-20");
    const header = await screen.findByRole("heading", { level: 2, name: "9月20日 周日" });
    expect(header.parentElement).toHaveTextContent("52 条");
    expect(header.parentElement).not.toHaveTextContent("分钟");
  });

  it("says in one sentence where there is no daily yet", async () => {
    client.listFrontierDailies.mockResolvedValue(null);
    renderPage("/app/frontier?view=daily");
    expect(await screen.findByText("暂无日报")).toBeInTheDocument();
  });
});

describe("与我相关", () => {
  it("groups the items under the reader's own topics, and no card says why", async () => {
    client.fetchFrontierForYou.mockResolvedValue({
      state: "available", basis: "vector", paused: false,
      items: [
        { item: frontierItem({ id: "fy-1", title: "SGLT2 抑制剂用于射血分数保留的心衰" }), reason: { text: "因为你在做：SGLT2 与心衰的 Meta 分析", topic: "SGLT2 与心衰的 Meta 分析", memoryId: "m1" } },
        { item: frontierItem({ id: "fy-2", title: "替尔泊肽心衰结局试验" }), reason: { text: "因为你在做：SGLT2 与心衰的 Meta 分析", topic: "SGLT2 与心衰的 Meta 分析", memoryId: "m1" } },
        // A server that sends only the sentence: the topic is what follows 「因为你关注：」.
        { item: frontierItem({ id: "fy-3", title: "阿司匹林一级预防" }), reason: { text: "因为你关注：老年人阿司匹林", topic: null, memoryId: "m2" } },
      ],
    });
    renderPage("/app/frontier?view=foryou");
    const first = await screen.findByRole("heading", { level: 2, name: "SGLT2 与心衰的 Meta 分析" });
    expect(within(first.closest("section")!).getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2, name: "老年人阿司匹林" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("因为你");
  });

  it("with nothing yet, says in one line what the reader can do and what comes of it — never how it is ranked", async () => {
    client.fetchFrontierForYou.mockResolvedValue({ state: "available", basis: "tags", paused: false, items: [] });
    renderPage("/app/frontier?view=foryou");
    expect(await screen.findByText("收藏或打开几条动态、或在对话里提几个问题后，这里会按你的兴趣推荐")).toBeInTheDocument();
    for (const word of ["tags", "vector", "关键词", "向量", "记忆", "画像"]) expect(document.body.textContent).not.toContain(word);
  });

  it("promises nothing where this deployment cannot recommend, and asks a reader whose memory is off to switch it on", async () => {
    client.fetchFrontierForYou.mockResolvedValue({ state: "off", basis: null, paused: false, items: [] });
    const first = renderPage("/app/frontier?view=foryou");
    expect(await screen.findByText("暂无与你相关的动态")).toBeInTheDocument();
    first.unmount();
    client.fetchFrontierForYou.mockResolvedValue({ state: "off", basis: null, paused: true, items: [] });
    renderPage("/app/frontier?view=foryou");
    expect(await screen.findByText("开启记忆后，这里会按你的兴趣推荐")).toBeInTheDocument();
  });
});

describe("the sources", () => {
  it("are a quiet link at the end of 全部, read only when opened, one row per institution with its selections", async () => {
    client.fetchFrontierSources.mockResolvedValue({
      mirroredAt: ago(1), counts: { planned: 486 },
      sources: [
        { id: "nejm", name: "NEJM Crossref", displayName: "新英格兰医学杂志", homepage: "https://www.nejm.org", lane: "evidence", laneLabel: "临床证据", sourceType: "journal", sourceTypeLabel: "期刊", access: "crossref-issn", health: "healthy", healthLabel: "正常", lastOkAt: ago(2), lastNewEntryAt: ago(2), entries7d: 40, selected30d: 12, enabled: true, retired: false },
        { id: "fda-recalls", name: "openFDA 药品召回（enforcement）API", displayName: "FDA", homepage: null, lane: "safety", laneLabel: "药物安全", sourceType: "regulator", sourceTypeLabel: "监管", access: "json-api", health: "healthy", healthLabel: "正常", lastOkAt: ago(1), lastNewEntryAt: ago(1), entries7d: 9, selected30d: 7, enabled: true, retired: false },
        { id: "fda-shortage", name: "openFDA 药品短缺 API", displayName: "FDA", homepage: "https://www.fda.gov", lane: "safety", laneLabel: "药物安全", sourceType: "regulator", sourceTypeLabel: "监管", access: "json-api", health: "healthy", healthLabel: "正常", lastOkAt: ago(1), lastNewEntryAt: ago(1), entries7d: 3, selected30d: 8, enabled: true, retired: false },
        { id: "nmpa", name: "国家药监局", displayName: "国家药监局", homepage: null, lane: "regulatory", laneLabel: "审批监管", sourceType: "regulator", sourceTypeLabel: "监管", access: "browser-list", health: "disabled", healthLabel: "已停用", lastOkAt: null, lastNewEntryAt: null, entries7d: 0, selected30d: 0, enabled: false, retired: false },
      ],
    });
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    const link = screen.getByRole("button", { name: "我们在读的信源（267）" });
    expect(client.fetchFrontierSources).not.toHaveBeenCalled();
    await userEvent.click(link);
    const drawer = await screen.findByRole("dialog", { name: "我们在读的信源" });
    const list = await within(drawer).findByRole("list", { name: "信源" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "FDA近 30 天精选 15 条",
      "新英格兰医学杂志近 30 天精选 12 条",
    ]);
    expect(drawer).not.toHaveTextContent(/API|读法|状态|国家药监局/);
    await userEvent.click(within(drawer).getByRole("button", { name: "按名称" }));
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent?.split("近")[0])).toEqual(["FDA", "新英格兰医学杂志"].sort((a, b) => a.localeCompare(b, "zh")));
  });
});


it("restores an owned follow from the URL and clears it when changing views", async () => {
  const user = userEvent.setup();
  renderPage("/app/frontier?view=following&follow=7");
  expect(await viewTabs().findByRole("tab", { name: "关注" })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ view: "all", follow: "7" })));
  // One follow narrows the feed; 「全部关注」, beside the filters, widens it again and stays on the view.
  await user.click(within(controlRow()).getByRole("button", { name: "全部关注" }));
  expect(location()).toBe("/app/frontier?view=following");
  expect(within(controlRow()).queryByRole("button", { name: "全部关注" })).not.toBeInTheDocument();
  await waitFor(() => expect(client.listFrontierItems).toHaveBeenLastCalledWith(expect.objectContaining({ view: "all", follow: "all" })));
});

it("clears an owned follow when the reader changes view", async () => {
  const user = userEvent.setup();
  renderPage("/app/frontier?view=following&follow=7");
  await viewTabs().findByRole("tab", { name: "关注" });
  await user.click(viewTabs().getByRole("tab", { name: "全部" }));
  expect(location()).toBe("/app/frontier?view=all");
  expect(location()).not.toContain("follow=");
});

it("lists the followed evidence zones as the first group of the feed, under the one control row", async () => {
  renderPage("/app/frontier?view=following");
  const group = await screen.findByRole("region", { name: "关注的证据专区" });
  const panel = screen.getByRole("tabpanel");
  expect(panel).toContainElement(group);
  expect(within(group).getByRole("link", { name: "房颤抗凝" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
  // The filters and 「管理关注」 are in the row above, not in a row of their own below it.
  expect(within(panel).queryByRole("button", { name: "管理关注" })).not.toBeInTheDocument();
  expect(within(controlRow()).getByRole("button", { name: "管理关注" })).toBeInTheDocument();
  expect(within(controlRow()).getByRole("button", { name: "管理关注" })).toHaveClass("bg-transparent");
  expect(within(controlRow()).getByRole("group", { name: "栏目" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "全部关注" })).not.toBeInTheDocument();
});

describe("关注 with nothing to show yet", () => {
  beforeEach(() => {
    client.listFrontierFollows.mockResolvedValue([]);
    zones.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("is one sentence and the way to start — no 「没有结果」, no filters, no second 「管理关注」, and no read of the feed", async () => {
    renderPage("/app/frontier?view=following");
    expect(await screen.findByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "添加关注" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "添加关注" })).toHaveClass("bg-accent");
    expect(screen.getByRole("link", { name: "浏览证据专区" })).toHaveAttribute("href", "/app/frontier?view=zones");
    expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "关注的证据专区" })).not.toBeInTheDocument();
    const row = within(controlRow());
    expect(row.queryByRole("button", { name: "管理关注" })).not.toBeInTheDocument();
    expect(row.queryByRole("group", { name: "栏目" })).not.toBeInTheDocument();
    expect(row.queryByRole("button", { name: "更多筛选" })).not.toBeInTheDocument();
    expect(secondRow()).toBeNull();
    expect(feedQueries()).toEqual([]);
  });

  it("opens 管理关注 from the one button, and shows the first follow's results as soon as it is made", async () => {
    const user = userEvent.setup();
    renderPage("/app/frontier?view=following");
    await user.click(await screen.findByRole("button", { name: "添加关注" }));
    const drawer = await screen.findByRole("dialog", { name: "管理关注" });
    client.listFrontierFollows.mockResolvedValue([{ id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false }]);
    await act(async () => { window.dispatchEvent(new Event("evimed:frontier-follows-changed")); });
    await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ follow: "all", view: "all" })));
    expect(await screen.findByText("今天的一条 RCT")).toBeInTheDocument();
    expect(screen.queryByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).not.toBeInTheDocument();
    expect(within(controlRow()).getByRole("group", { name: "栏目" })).toBeInTheDocument();
    expect(drawer).toBeInTheDocument();
  });

  it("says that the follows could not be read, rather than that there are none", async () => {
    client.listFrontierFollows.mockRejectedValue(new WebApiError("down", { status: 502 }));
    renderPage("/app/frontier?view=following");
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用，请稍后重试。");
    expect(screen.queryByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).not.toBeInTheDocument();
    client.listFrontierFollows.mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
  });
});

it("with only zones followed shows the zones and no feed block, no 「没有结果」, no filters — only the way to add a follow", async () => {
  client.listFrontierFollows.mockResolvedValue([]);
  renderPage("/app/frontier?view=following");
  await screen.findByRole("region", { name: "关注的证据专区" });
  expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
  expect(feedQueries()).toEqual([]);
  expect(within(controlRow()).getByRole("button", { name: "管理关注" })).toBeInTheDocument();
  expect(within(controlRow()).queryByRole("group", { name: "栏目" })).not.toBeInTheDocument();
});

it("says 「关注的内容暂时没有新动态」 — not 「没有结果」 — when what is followed has nothing new", async () => {
  feed = async () => page([]);
  renderPage("/app/frontier?view=following");
  expect(await screen.findByText("关注的内容暂时没有新动态")).toBeInTheDocument();
  expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
});

it("keeps 「没有结果」 for a narrowed follow or a filter that excluded everything", async () => {
  feed = async () => page([]);
  renderPage("/app/frontier?view=following&follow=7");
  expect(await screen.findByText("没有结果")).toBeInTheDocument();
});

it("selects a saved topic into the URL without using private memory", async () => {
  const user = userEvent.setup();
  renderPage("/app/frontier?view=following");
  await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ follow: "all" })));
  await user.click(screen.getByRole("button", { name: "管理关注" }));
  await user.click(await screen.findByRole("button", { name: "肥胖研究" }));
  expect(location()).toContain("follow=7");
  expect(client.fetchFrontierForYou).not.toHaveBeenCalled();
});

it("a safety deep link loads its item while the ordinary feed remains usable", async () => {
  const linked = frontierItem({ id: "linked", title: "指定安全公告" }); client.fetchFrontierItem.mockResolvedValue(linked);
  renderPage("/app/frontier?item=linked"); await screen.findByText("指定安全公告");
  expect(client.fetchFrontierItem).toHaveBeenCalledWith("linked"); expect(client.listFrontierItems).toHaveBeenCalled();
  const related = screen.getByRole("region", { name: "相关动态" });
  expect(controlRow().compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(related).getByRole("listitem").parentElement?.tagName).toBe("UL");
});
it("a linked item that is gone for good is one grey line over the feed, and 「关闭」 takes it out of the address", async () => {
  client.fetchFrontierItem.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_item_not_found" }));
  renderPage("/app/frontier?view=all&item=gone"); await waitFor(() => expect(client.fetchFrontierItem).toHaveBeenCalledWith("gone"));
  expect(await screen.findByText("这条动态已下架，不再提供。")).toBeInTheDocument();
  // Not a failure: no red box, nothing to retry, no heading over a list that is not there.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "相关动态" })).not.toBeInTheDocument();
  expect(viewTabs().getByRole("tab", { name: "全部" })).toBeEnabled();
  expect(await screen.findByText("今天的一条 RCT")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(location()).toBe("/app/frontier?view=all");
  expect(screen.queryByText("这条动态已下架，不再提供。")).not.toBeInTheDocument();
});
it("a linked item that could not be read still offers 「重试」", async () => {
  client.fetchFrontierItem.mockRejectedValueOnce(new WebApiError("down", { status: 502 })).mockResolvedValueOnce(frontierItem({ id: "linked", title: "指定安全公告" }));
  renderPage("/app/frontier?item=linked");
  await userEvent.click(await screen.findByRole("button", { name: "重试" }));
  expect(await screen.findByText("指定安全公告")).toBeInTheDocument();
});
it("weekly selection is restored from the URL and an empty archive stays in its own view", async () => {
  client.listFrontierWeeklies.mockResolvedValue([]); client.fetchFrontierWeekly.mockResolvedValue(null);
  renderPage("/app/frontier?view=weekly&week=2026-09-21"); await screen.findByText("暂无周报");
  expect(client.fetchFrontierWeekly).toHaveBeenCalledWith("2026-09-21"); expect(within(controlRow()).getByRole("button", { name: "周报" })).toHaveAttribute("aria-pressed", "true"); expect(viewTabs().getByRole("tab", { name: "简报" })).toHaveAttribute("aria-selected", "true");
});

it("shows the aggregate following feed before opening its management drawer", async () => {
  renderPage("/app/frontier?view=following");
  await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ follow: "all", view: "all" })));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "管理关注" }));
  expect(await screen.findByRole("dialog", { name: "管理关注" })).toBeInTheDocument();
});
it("opens the reader from anywhere on a card, keeps the original out of the feed, and records the reading", async () => {
  renderPage();
  const title = await screen.findByRole("link", { name: "今天的一条 RCT" });
  const card = title.closest("article")!;
  expect(within(card).queryByRole("button", { name: /展开摘要|收起摘要|详情/ })).not.toBeInTheDocument();
  expect(title).toHaveAttribute("href", "/app/frontier/items/today-1");
  await userEvent.click(title);
  expect(location()).toBe("/app/frontier/items/today-1");
  expect(client.markFrontierItemRead).toHaveBeenCalledWith("today-1");
});

it("puts the date in the meta row, and no time column, in the lists that are not cut into days", async () => {
  client.fetchFrontierForYou.mockResolvedValue({ state: "available", basis: "tags", paused: false, items: [
    { item: frontierItem({ id: "fy-1", title: "与你相关的一条", timelineAt: beforeMidnight(30), source: { id: "annonc", name: "肿瘤学年鉴" } }), reason: { text: "因为你在做：肝癌", topic: "肝癌", memoryId: null } },
  ] });
  renderPage("/app/frontier?view=foryou");
  const card = await screen.findByRole("article", { name: "与你相关的一条" });
  const date = new Date(MIDNIGHT - 30 * HOUR);
  expect(card).toHaveTextContent(`肿瘤学年鉴 · ${date.getMonth() + 1}月${date.getDate()}日`);
  expect(card.closest("li")!.querySelector(".w-14")).toBeNull();
});

it("restores loaded pages by fetching fresh authenticated content", async () => {
  const first = frontierItem({ id: "first", title: "First preserved page", summary: "Fresh account content" });
  const second = frontierItem({ id: "second", title: "Second preserved page" });
  client.listFrontierItems.mockImplementation(async (query: FrontierItemsQuery) => ({
    items: query.cursor ? [second] : [first], nextCursor: query.cursor ? null : "page-two", version: "fresh",
  }));
  render(<MemoryRouter initialEntries={[{ pathname: "/app/frontier", search: "?view=all", state: {
    frontierReading: { query: "view=all", pages: 2, scroll: 80, expanded: ["first"] },
  } }]}><FrontierPage /></MemoryRouter>);
  await screen.findByRole("link", { name: "Second preserved page" });
  expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-two" }));
  const article = screen.getByRole("link", { name: "First preserved page" }).closest("article")!;
  expect(within(article).getByText("Fresh account content")).toBeInTheDocument();
});

it("discards pagination replies after leaving a listing view", async () => {
  let resolveMore!: (value: FrontierItemsPage) => void;
  let resolveRefresh!: (value: FrontierItemsPage) => void;
  let starts = 0;
  feed = (query) => {
    if (query.cursor) return new Promise(resolve => { resolveMore = resolve; });
    starts += 1;
    return starts === 1 ? Promise.resolve(page([today], { nextCursor: "older" })) : new Promise(resolve => { resolveRefresh = resolve; });
  };
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
  await userEvent.click(viewTabs().getByRole("tab", { name: "热榜" }));
  await act(async () => resolveMore(page([frontierItem({ title: "Late pagination reply" })])));
  await userEvent.click(viewTabs().getByRole("tab", { name: "精选" }));
  await screen.findByRole("link", { name: "今天的一条 RCT" });
  expect(screen.queryByText("Late pagination reply")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "加载更多" })).toBeEnabled();
  await act(async () => resolveRefresh(page([today])));
});

describe("the feed's composition", () => {
  it("has its header, then one toolbar in the sticky band — views, filters and the search — then the feed, in every view", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const feed = expectComposed(document.body, { tablists: 1, stepRail: false, toolbar: true });
    expect(feed.toolbars).toHaveLength(1);
    expect(feed.chrome).toContainElement(feed.toolbars[0]);
    for (const name of ["热榜", "简报", "关注"]) {
      await userEvent.click(viewTabs().getByRole("tab", { name }));
      const facts = expectComposed(document.body, { tablists: 1, stepRail: false, toolbar: true });
      expect(facts.toolbars, `${name}: one toolbar`).toHaveLength(1);
      expect(within(facts.toolbars[0]).getByRole("combobox", { name: "搜索" }), `${name}: the search is in it`).toBeInTheDocument();
    }
  });
});

it("opens the evidence-zone directory in place, as a view of the page (owner, 2026-10-22)", async () => {
  renderPage();
  await screen.findByText("今天的一条 RCT");
  await userEvent.click(screen.getByRole("tab", { name: "证据专区" }));
  expect(location()).toBe("/app/frontier?view=zones");
  expect(await screen.findByRole("link", { name: "房颤抗凝" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
  expect(screen.getByRole("tab", { name: "证据专区" })).toHaveAttribute("aria-selected", "true");
});
