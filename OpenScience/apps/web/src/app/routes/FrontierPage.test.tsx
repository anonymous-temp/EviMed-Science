import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
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
  removeFrontierFollow: vi.fn(),
  listFrontierCongresses: vi.fn(),
  listFrontierApprovals: vi.fn(),
  listFrontierGuidelines: vi.fn(),
  markFrontierFollowSeen: vi.fn(),
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
// The onboarding answer 关注 reads: answered unless a test says otherwise.
const prefs = vi.hoisted(() => ({ fetchFrontierPrefs: vi.fn(), saveFrontierPrefs: vi.fn() }));
vi.mock("@/lib/frontierPrefs", () => prefs);
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  getWebProjectId: () => "project-one",
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
// Day groups are Beijing calendar days (whatever the machine's zone is), so the fixtures sit on known days
// whatever hour the suite runs at: "today" a second ago, the rest before Beijing's midnight.
const BEIJING_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const MIDNIGHT = Date.parse(`${BEIJING_DAY}T00:00:00+08:00`);
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
const today = frontierItem({ id: "today-1", title: "今天的一条 RCT", timelineAt: new Date(Date.now() - 1000).toISOString(), visibleAt: new Date(Date.now() - 1000).toISOString(), score: 86, scoreBand: "high" });
const yesterday = frontierItem({ id: "yesterday-1", title: "昨天的一条指南", timelineAt: beforeMidnight(6) });
const alert = frontierItem({ id: "alert-1", title: "I 级召回：葡萄糖注射液含不锈钢颗粒", safetyAlert: true, lane: "safety", laneLabel: "药物安全",
  evidenceType: "safety-notice", evidenceTypeLabel: "安全通告", source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(2) });
const alert2 = frontierItem({ id: "alert-2", title: "氯巴占口服混悬液条形码错误", safetyAlert: true, source: { id: "mhra", name: "英国 MHRA" }, timelineAt: ago(30) });
const oldAlert = frontierItem({ id: "alert-old", title: "三天前的召回", safetyAlert: true, source: { id: "fda-recalls", name: "FDA" }, timelineAt: ago(60) });
/** Newer than `today`, for what arrives above the top of the list. */
const newer = frontierItem({ id: "newer-1", title: "刚发布的一条", timelineAt: new Date().toISOString(), visibleAt: new Date().toISOString() });

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
  client.markFrontierFollowSeen.mockResolvedValue(undefined);
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
  const answered = { role: "physician", specialties: ["oncology"], interests: ["hcc"], interestTags: [{ slug: "hcc", name: "肝细胞癌" }], onboardedAt: ago(48), skippedAt: null };
  client.listFrontierCongresses.mockReset().mockResolvedValue([]);
  client.listFrontierApprovals.mockReset().mockResolvedValue(null);
  client.listFrontierGuidelines.mockReset().mockResolvedValue(null);
  prefs.fetchFrontierPrefs.mockReset().mockResolvedValue(answered);
  prefs.saveFrontierPrefs.mockReset().mockResolvedValue(answered);
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
/** The page's toolbar: one row — the views, the open view's controls, what is applied, 「筛选」 and the search. */
const controlRow = () => screen.getByRole("group", { name: "动态筛选与搜索" });
/** A phone's line under the row, while something narrows the list (never on a wide screen). */
const secondRow = () => controlRow().querySelector<HTMLElement>("[data-toolbar-row]");
/** The open 「筛选」 panel (a card under the button on a wide screen). */
const filtersPanel = () => screen.getByRole("dialog", { name: "筛选" });
const filterGroup = (name: string) => within(filtersPanel()).getByRole("group", { name });
async function openFilters() {
  await userEvent.click(within(controlRow()).getByRole("button", { name: /^筛选/ }));
  return filtersPanel();
}

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
    // Six views: the three lists of items first, then the ranking, the issues and the zones (owner, 2026-10-25).
    expect(viewTabs().getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["精选", "全部", "关注", "热榜", "追踪", "简报", "证据专区"]);
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
    ["/app/frontier?view=foryou", "关注"],
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

  it("writes an older ?view=foryou as the entry of 关注 it now is, in place, and reads 与我相关 there", async () => {
    renderPage("/app/frontier?view=foryou");
    await waitFor(() => expect(location()).toBe("/app/frontier?view=following&follow=foryou"));
    await waitFor(() => expect(client.fetchFrontierForYou).toHaveBeenCalled());
    expect(viewTabs().getByRole("tab", { name: "关注" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("the control row", () => {
  it("is one row on every view: the views at the left, 「筛选」 and the search at its right, and no chip row of 栏目", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const tabsRow = screen.getByRole("tablist", { name: "动态视图" }).parentElement!;
    expect(tabsRow).toContainElement(screen.getByRole("combobox", { name: "搜索" }));
    expect(tabsRow).toContainElement(within(controlRow()).getByRole("button", { name: "筛选" }));
    expect(secondRow()).toBeNull();
    expect(within(controlRow()).getByRole("button", { name: "筛选" })).toHaveAttribute("aria-haspopup", "dialog");
    for (const gone of ["专科", "更多筛选", "全部栏目", "管理关注"]) expect(within(controlRow()).queryByRole("button", { name: gone })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "栏目" })).not.toBeInTheDocument();
    for (const path of ["/app/frontier?view=all", "/app/frontier?view=hot", "/app/frontier?view=daily", "/app/frontier?view=following&follow=all", "/app/frontier?view=zones"]) {
      const view = renderPage(path);
      expect(view.container.querySelector("[data-toolbar-row]"), path).toBeNull();
      view.unmount();
    }
  });

  it("opens 「筛选」 on 栏目, 专科, 来源, 证据类型 and 只看收藏, in that order — and 只看未读 is not one of them", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const panel = await openFilters();
    expect(within(panel).getAllByRole("group").map((group) => group.getAttribute("aria-label") ?? group.querySelector("p")?.textContent)
      .filter((name) => ["栏目", "专科", "来源", "证据类型", "时间"].includes(name ?? ""))).toEqual(["栏目", "专科", "来源", "证据类型"]);
    expect(within(filterGroup("栏目")).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "临床证据", "指南共识", "药物安全", "审批监管", "研发产业", "公共卫生", "科研与基金", "AI 与医学"]);
    expect(within(panel).getByRole("switch", { name: "只看收藏" })).toBeInTheDocument();
    expect(within(panel).queryByRole("switch", { name: "只看未读" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("narrows by 栏目 at once, keeps it in the address, says it as a token on the row, and lets go of it with the token", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await openFilters();
    await userEvent.click(within(filterGroup("栏目")).getByRole("button", { name: "药物安全" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ lane: "safety" }));
    expect(location()).toBe("/app/frontier?lane=safety");
    expect(within(filterGroup("栏目")).getByRole("button", { name: "药物安全" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");
    expect(within(controlRow()).getByRole("button", { name: "筛选，已选 1 项" })).toHaveTextContent("筛选 · 1");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "移除筛选：药物安全" }));
    await waitFor(() => expect(lastFeedQuery()?.lane).toBeNull());
    expect(within(controlRow()).getByRole("button", { name: "筛选" })).toBeInTheDocument();
  });

  it("narrows by several specialties from their groups, follows one of them from the panel, then narrows by one of their popular tags", async () => {
    client.listFrontierTags.mockResolvedValue([{ slug: "hcc", name: "肝细胞癌", count: 34, specialties: [] }, { slug: "af", name: "心房颤动", count: 20, specialties: [] }]);
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const panel = await openFilters();
    // The thirty, under 内科 / 外科 / 妇儿 / 五官与皮肤 / 医技与其他.
    expect(within(panel).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["内科", "外科", "妇儿", "五官与皮肤", "医技与其他"]));
    expect(within(within(panel).getByRole("group", { name: "外科" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["普通外科", "骨科", "心胸外科", "神经外科", "泌尿外科"]);
    expect(within(panel).queryByRole("group", { name: "热门标签" })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "肿瘤" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology"] }));
    await userEvent.click(within(filtersPanel()).getByRole("button", { name: "心血管" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology", "cardiology"] }));
    expect(new URLSearchParams(location().split("?")[1]).get("specialty")).toBe("oncology,cardiology");
    // Each chosen specialty has its 「关注」 in the panel.
    await userEvent.click(await within(filtersPanel()).findByRole("button", { name: "关注：肿瘤" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "specialty", key: "oncology", label: "肿瘤" });
    expect(await within(filtersPanel()).findByRole("button", { name: "已关注：肿瘤" })).toBeDisabled();
    // Their popular tags, the second level of 专科.
    await waitFor(() => expect(client.listFrontierTags).toHaveBeenLastCalledWith({ specialties: ["oncology", "cardiology"], limit: 24 }));
    const hot = within(filtersPanel()).getByRole("group", { name: "热门标签" });
    await userEvent.click(within(hot).getByRole("button", { name: "#肝细胞癌" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: ["oncology", "cardiology"], tag: "hcc" }));
    await userEvent.keyboard("{Escape}");
    // The tag and the specialties are tokens on the row; the tag counts once.
    expect(within(controlRow()).getByRole("button", { name: "移除筛选：#肝细胞癌" })).toBeInTheDocument();
    expect(within(controlRow()).getByRole("button", { name: "移除筛选：肿瘤 等 2 个" })).toBeInTheDocument();
    expect(within(controlRow()).getByRole("button", { name: "筛选，已选 2 项" })).toBeInTheDocument();
    // 「清除」 lets go of all of them.
    await userEvent.click(within(controlRow()).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: [], tag: null }));
  });

  it("follows the chosen tag from beside its token, and lets go of the tag with a press on the token", async () => {
    client.fetchFrontierTag.mockResolvedValue({ slug: "hcc", name: "肝细胞癌", nameEn: null, specialties: [], broader: null, narrower: [], count30d: 34, mergedFrom: null });
    renderPage("/app/frontier?tag=hcc");
    const token = await within(controlRow()).findByRole("button", { name: "移除筛选：#肝细胞癌" });
    expect(lastFeedQuery()).toMatchObject({ tag: "hcc" });
    await userEvent.click(await within(controlRow()).findByRole("button", { name: "关注：#肝细胞癌" }));
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "tag", key: "hcc", label: "肝细胞癌" });
    expect(await within(controlRow()).findByRole("button", { name: "已关注：#肝细胞癌" })).toBeDisabled();
    await userEvent.click(token);
    await waitFor(() => expect(lastFeedQuery()?.tag).toBeNull());
    expect(location()).not.toContain("tag=");
  });

  it("says 已关注 beside a tag the reader already follows", async () => {
    client.listFrontierFollows.mockResolvedValue([{ id: "8", kind: "tag", key: "hcc", label: "肝细胞癌", muted: false }]);
    renderPage("/app/frontier?view=all&tag=hcc");
    // The tag's name is the slug until it is known (and known for the rest of the visit once another test read it).
    expect(await within(controlRow()).findByRole("button", { name: /^已关注：#(hcc|肝细胞癌)$/ })).toBeDisabled();
  });

  it("reads a tag merged into another as that one, and puts it in the address", async () => {
    client.fetchFrontierTag.mockResolvedValue({ slug: "hcc", name: "肝细胞癌", nameEn: null, specialties: [], broader: null, narrower: [], count30d: 34, mergedFrom: "liver-cell-cancer" });
    renderPage("/app/frontier?view=all&tag=liver-cell-cancer");
    await waitFor(() => expect(location()).toBe("/app/frontier?view=all&tag=hcc"));
    expect(await within(controlRow()).findByRole("button", { name: "移除筛选：#肝细胞癌" })).toBeInTheDocument();
  });

  it("narrows by source, evidence type, time and stars from 「筛选」, at most two tokens then 「+N」, and lets go of all of them with 「清除」", async () => {
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    const panel = await openFilters();
    const group = (name: string) => within(filterGroup(name));
    expect(group("来源").getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "文献", "资讯", "社媒", "官方"]);
    expect(group("证据类型").getAllByRole("button")[0]).toHaveTextContent("全部");
    expect(group("时间").getAllByRole("button").map((chip) => chip.textContent)).toEqual(["不限", "24 小时", "3 天", "7 天", "30 天"]);
    await userEvent.click(group("来源").getByRole("button", { name: "社媒" }));
    await userEvent.click(group("证据类型").getByRole("button", { name: "RCT" }));
    await userEvent.click(group("时间").getByRole("button", { name: "7 天" }));
    await userEvent.click(within(panel).getByRole("switch", { name: "只看收藏" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ channel: "social", evidence: "rct", window: "7d", starred: true }));
    for (const part of ["channel=social", "evidence=rct", "window=7d", "starred=1"]) expect(location()).toContain(part);
    await userEvent.keyboard("{Escape}");
    expect(within(controlRow()).getByRole("button", { name: "筛选，已选 4 项" })).toBeInTheDocument();
    expect(within(controlRow()).getAllByRole("button", { name: /^移除筛选：/ }).map((token) => token.textContent)).toEqual(["社媒", "RCT"]);
    await userEvent.click(within(controlRow()).getByRole("button", { name: "另有 2 项筛选，打开筛选" }));
    expect(filtersPanel()).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ channel: null, evidence: null, window: null, starred: false, unread: false }));
    expect(location()).toBe("/app/frontier?view=all");
  });

  it("narrows 行业动态 by kind from 「筛选」 (c5-biz): one choice, in the address, a token on the row that lets go of it", async () => {
    renderPage("/app/frontier?view=all");
    await screen.findByText("今天的一条 RCT");
    const panel = await openFilters();
    const kinds = within(within(panel).getByRole("group", { name: "行业动态" }));
    expect(kinds.getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部", "交易与授权", "融资与上市", "人事与组织", "公司经营", "研发管线", "其他"]);
    await userEvent.click(kinds.getByRole("button", { name: "融资与上市" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ industryKind: "financing" }));
    expect(location()).toContain("kind=financing");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "移除筛选：融资与上市" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ industryKind: null }));
    expect(location()).toBe("/app/frontier?view=all");
  });

  it("offers the time range in 全部 only", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    const panel = await openFilters();
    expect(within(panel).queryByRole("group", { name: "时间" })).not.toBeInTheDocument();
  });

  it("puts 只看未读 at the right end of the list's first day heading, and keeps it above a list it emptied", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { level: 2, name: /^今天/ });
    const toggles = screen.getAllByRole("button", { name: "只看未读" });
    expect(toggles).toHaveLength(1);
    expect(heading.parentElement).toContainElement(toggles[0]);
    expect(toggles[0]).toHaveAttribute("aria-pressed", "false");
    feed = async () => page([]);
    await userEvent.click(toggles[0]);
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ unread: true }));
    expect(location()).toBe("/app/frontier?unread=1");
    expect(await screen.findByText("没有结果")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "只看未读" }));
    await waitFor(() => expect(lastFeedQuery()).toMatchObject({ unread: false }));
  });

  it("puts 「/」 in the search", async () => {
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await userEvent.keyboard("/");
    expect(screen.getByRole("combobox", { name: "搜索" })).toHaveFocus();
  });

  it.each([
    ["/app/frontier?view=all&channel=literature&evidence=rct&unread=1", { channel: "literature", evidence: "rct", unread: true }],
    ["/app/frontier?view=all&channel=podcast&evidence=anecdote", { channel: null, evidence: null }],
    ["/app/frontier?view=all&kind=people&lane=pipeline", { industryKind: "people", lane: "pipeline" }],
    ["/app/frontier?view=all&kind=merger", { industryKind: null }],
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

  it("says the chosen specialty as a token from an older address", async () => {
    renderPage("/app/frontier?specialty=surgery-anesthesia");
    await screen.findByText("今天的一条 RCT");
    expect(within(controlRow()).getByRole("button", { name: "移除筛选：普通外科" })).toHaveTextContent("普通外科");
  });

  it("narrows by a card's tag in place, and from 与我相关 opens 全部 with it", async () => {
    feed = async () => page([frontierItem({ id: "tagged", title: "带标签的一条", timelineAt: ago(0.1), tags: [{ slug: "heart-failure", name: "心力衰竭" }] })]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "#心力衰竭" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?tag=heart-failure"));
    expect(lastFeedQuery()).toMatchObject({ view: "selected", tag: "heart-failure" });
    expect(within(controlRow()).getByRole("button", { name: "移除筛选：#心力衰竭" })).toBeInTheDocument();
  });

  it("opens 全部 with a tag chosen in 与我相关, which no filter narrows", async () => {
    client.fetchFrontierForYou.mockResolvedValue({ state: "available", basis: "tags", paused: false, items: [
      { item: frontierItem({ id: "fy", title: "为你推荐的一条", timelineAt: ago(0.1), tags: [{ slug: "heart-failure", name: "心力衰竭" }] }), reason: { text: "心衰", topic: "心衰", memoryId: null } },
    ] });
    renderPage("/app/frontier?view=following&follow=foryou");
    await userEvent.click(await screen.findByRole("button", { name: "#心力衰竭" }));
    await waitFor(() => expect(location()).toBe("/app/frontier?view=all&tag=heart-failure"));
  });

  it("puts the hot list's time range and the briefing's period on the views' own row", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
    renderPage("/app/frontier?view=hot");
    const range = await screen.findByRole("group", { name: "时间范围" });
    const tabsRow = () => screen.getByRole("tablist", { name: "动态视图" }).parentElement!;
    expect(tabsRow()).toContainElement(range);
    expect(within(range).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["当前", "本周", "本月"]);
    expect(within(controlRow()).queryByRole("button", { name: "筛选" })).not.toBeInTheDocument();
    await userEvent.click(viewTabs().getByRole("tab", { name: "简报" }));
    const period = await screen.findByRole("group", { name: "简报周期" });
    expect(tabsRow()).toContainElement(period);
    expect(within(period).getByRole("button", { name: "日报" })).toHaveAttribute("aria-pressed", "true");
    // Pressing the tab again on the weekly stays on it; the chip is the way between the two.
    await userEvent.click(within(period).getByRole("button", { name: "周报" }));
    expect(location()).toBe("/app/frontier?view=weekly");
    expect(viewTabs().getByRole("tab", { name: "简报" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(viewTabs().getByRole("tab", { name: "简报" }));
    expect(location()).toBe("/app/frontier?view=weekly");
  });

  it("has no 「筛选」 on 与我相关, which the server ranks and no filter narrows", async () => {
    renderPage("/app/frontier?view=following");
    await waitFor(() => expect(client.fetchFrontierForYou).toHaveBeenCalled());
    expect(within(controlRow()).queryByRole("button", { name: /^筛选/ })).not.toBeInTheDocument();
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

    it("is the scrolling views with 「筛选」 and the search as icons, a line of tokens only while something narrows, and one sheet", async () => {
      const first = renderPage("/app/frontier?view=all");
      await screen.findByText("今天的一条 RCT");
      expect(first.container.querySelector("[data-toolbar-row]")).toBeNull();
      expect(within(controlRow()).getByRole("button", { name: "搜索" })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "搜索" })).not.toBeInTheDocument();
      first.unmount();
      const { container } = renderPage("/app/frontier?view=all&specialty=oncology&starred=1");
      await screen.findByText("今天的一条 RCT");
      expect(screen.queryByRole("group", { name: "栏目" })).not.toBeInTheDocument();
      const line = container.querySelector<HTMLElement>("[data-toolbar-row]")!;
      expect(within(line).getAllByRole("button", { name: /^移除筛选：/ }).map((token) => token.textContent)).toEqual(["肿瘤", "只看收藏"]);
      await userEvent.click(within(controlRow()).getByRole("button", { name: "筛选，已选 2 项" }));
      const sheet = screen.getByRole("dialog", { name: "筛选" });
      for (const name of ["栏目", "内科", "外科", "热门标签", "来源", "证据类型", "时间"]) expect(within(sheet).getByRole("group", { name })).toBeInTheDocument();
      expect(within(sheet).getByRole("switch", { name: "只看收藏" })).toHaveAttribute("aria-checked", "true");
      expect(within(sheet).queryByRole("switch", { name: "只看未读" })).not.toBeInTheDocument();
      // 「重置」 lets go of the filters at once and leaves the search alone.
      await userEvent.click(within(sheet).getByRole("button", { name: "重置" }));
      await waitFor(() => expect(lastFeedQuery()).toMatchObject({ specialties: [], starred: false }));
      expect(location()).toBe("/app/frontier?view=all");
    });

    it("keeps 热榜's window and 简报's period in sight under the views, and the issue's other controls in the sheet", async () => {
      client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
      const { container } = renderPage("/app/frontier?view=hot");
      const range = await screen.findByRole("group", { name: "时间范围" });
      expect(container.querySelector("[data-toolbar-row]")).toContainElement(range);
    });

    it("puts the followed things first in 关注's sheet, and says the one the list is narrowed to as a token", async () => {
      const { container } = renderPage("/app/frontier?view=following&follow=7");
      await screen.findByText("今天的一条 RCT");
      expect(screen.queryByRole("navigation", { name: "我的关注" })).not.toBeInTheDocument();
      const line = container.querySelector<HTMLElement>("[data-toolbar-row]")!;
      expect(within(line).getByRole("button", { name: "移除筛选：只看：肥胖研究" })).toBeInTheDocument();
      await userEvent.click(within(controlRow()).getByRole("button", { name: "筛选，已选 1 项" }));
      const sheet = screen.getByRole("dialog", { name: "筛选" });
      const list = within(sheet).getByRole("navigation", { name: "我的关注" });
      expect(list.compareDocumentPosition(within(sheet).getByRole("group", { name: "栏目" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.click(within(list).getByRole("link", { name: "全部关注" }));
      expect(location()).toBe("/app/frontier?view=following&follow=all");
      expect(screen.queryByRole("dialog", { name: "筛选" })).not.toBeInTheDocument();
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
    expect(within(controlRow()).getByRole("button", { name: "移除筛选：#肝细胞癌" })).toBeInTheDocument();
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
    await openFilters();
    await userEvent.click(within(filterGroup("栏目")).getByRole("button", { name: "临床证据" }));
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
    // The heading's row stays under the band, 只看未读 at its end.
    expect(headings[0].parentElement).toHaveClass("sticky", "top-[var(--page-chrome-h,0px)]");
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

describe("the new-items hint", () => {
  const publishedNow = (id: string, title: string, timelineAt: string) => frontierItem({ id, title, timelineAt, visibleAt: new Date().toISOString() });

  it("counts an item that arrives with an older timeline instant (a source's own time) by when it was published", async () => {
    const late = publishedNow("late-1", "来源自己的时间更早的一条", beforeMidnight(30));
    let calls = 0;
    feed = async () => {
      calls += 1;
      return calls === 1 ? page([today], { version: "1" }) : page([late, today], { version: "2" });
    };
    client.fetchFrontierStatus.mockResolvedValue(status({ versions: { content: "2", hot: null, daily: null } }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "有 1 条新的" }));
    expect(await screen.findByText("来源自己的时间更早的一条")).toBeInTheDocument();
  });

  it("does not count an unseen item that was published before the newest one on screen", async () => {
    const earlier = frontierItem({ id: "earlier-1", title: "更早发布的一条", timelineAt: beforeMidnight(30), visibleAt: new Date(Date.now() - 3 * HOUR).toISOString() });
    let calls = 0;
    feed = async () => {
      calls += 1;
      return calls === 1 ? page([today], { version: "1" }) : page([today, earlier], { version: "2" });
    };
    client.fetchFrontierStatus.mockResolvedValue(status({ versions: { content: "2", hot: null, daily: null } }));
    renderPage();
    await screen.findByText("今天的一条 RCT");
    await waitFor(() => expect(feedQueries().length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByRole("button", { name: /条新的/ })).not.toBeInTheDocument();
  });

  it("tells the newest publication on screen from the list's first row", async () => {
    // The first row was published long ago; a later row most recently. An unseen item published before that newest one is not new, even
    // though its source's own time is later than the first row's.
    const first = frontierItem({ id: "first-1", title: "第一行", timelineAt: beforeMidnight(1), visibleAt: new Date(Date.now() - 5 * HOUR).toISOString() });
    const second = frontierItem({ id: "second-1", title: "第二行", timelineAt: beforeMidnight(2), visibleAt: new Date(Date.now() - 1 * HOUR).toISOString() });
    const between = frontierItem({ id: "between-1", title: "中间发布的一条", timelineAt: beforeMidnight(0.5), visibleAt: new Date(Date.now() - 3 * HOUR).toISOString() });
    let calls = 0;
    feed = async () => {
      calls += 1;
      return calls === 1 ? page([first, second], { version: "1" }) : page([first, second, between], { version: "2" });
    };
    client.fetchFrontierStatus.mockResolvedValue(status({ versions: { content: "2", hot: null, daily: null } }));
    renderPage();
    await screen.findByText("第二行");
    await waitFor(() => expect(feedQueries().length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByRole("button", { name: /条新的/ })).not.toBeInTheDocument();
  });
});

describe("the four states", () => {
  it("shows the feed's skeleton after 300ms while the first page is on its way", async () => {
    feed = () => new Promise(() => {});
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    await waitFor(() => expect(container.querySelector(".animate-pulse")).not.toBeNull());
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
    const alertBox = await screen.findByRole("note");
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

  /** 不感兴趣 on the first card, as a reader presses it. */
  async function chooseHide() {
    const card = await screen.findByRole("article", { name: "今天的一条 RCT" });
    await userEvent.click(within(card).getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "不感兴趣" }));
  }

  it("hides an item at once and leaves one line in its place that asks why, in the domain's order; 撤销 brings the card back (c2-hide)", async () => {
    client.unhideFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
    renderPage();
    await chooseHide();
    expect(screen.queryByRole("article", { name: "今天的一条 RCT" })).not.toBeInTheDocument();
    expect(client.hideFrontierItem).toHaveBeenCalledWith("today-1");
    expect(client.hideFrontierItem.mock.calls[0]).toHaveLength(1);
    const line = await screen.findByRole("group", { name: "不感兴趣" });
    expect(line).toHaveTextContent("已隐藏 · 说说原因（可不选）");
    expect(within(line).getAllByRole("button").map((button) => button.textContent)).toEqual(
      ["与我无关", "看过了", "内容质量不高", "像广告或软文", "不是我的专科", `不想看“${today.source.name}”`, "撤销"]);
    expect(screen.queryByText("已隐藏")).not.toBeInTheDocument(); // no toast: the line is the way back
    // The line stands where the card was, between its neighbours.
    expect(screen.getByRole("article", { name: "昨天的一条指南" })).toBeInTheDocument();
    await userEvent.click(within(line).getByRole("button", { name: "撤销" }));
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "不感兴趣" })).not.toBeInTheDocument();
    await waitFor(() => expect(client.unhideFrontierItem).toHaveBeenCalledWith("today-1"));
  });

  it("sends the reason chosen on the line, says 「已记下」, and the card is gone when it closes (c2-hide)", async () => {
    client.hideFrontierItem.mockResolvedValue({ starred: false, hidden: true, read: false });
    renderPage();
    await chooseHide();
    await userEvent.click(within(await screen.findByRole("group", { name: "不感兴趣" })).getByRole("button", { name: "像广告或软文" }));
    await waitFor(() => expect(client.hideFrontierItem).toHaveBeenLastCalledWith("today-1", "promotional"));
    expect(screen.getByText("已记下")).toBeInTheDocument();
    expect(client.addFrontierFollow).not.toHaveBeenCalled(); // only the source's own reason mutes it
    await waitFor(() => expect(screen.queryByRole("group", { name: "不感兴趣" })).not.toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.queryByRole("article", { name: "今天的一条 RCT" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "昨天的一条指南" })).toBeInTheDocument();
  });

  it("mutes the source for 「不想看这个来源」, and 撤销 gives the follow back as it was (c2-hide)", async () => {
    client.hideFrontierItem.mockResolvedValue({ starred: false, hidden: true, read: false });
    client.unhideFrontierItem.mockResolvedValue({ starred: false, hidden: false, read: false });
    client.listFrontierFollows.mockResolvedValue([]);
    client.addFrontierFollow.mockResolvedValue({ id: "55", kind: "source", key: today.source.id, label: today.source.name, muted: true });
    client.removeFrontierFollow.mockResolvedValue(undefined);
    renderPage();
    await chooseHide();
    await userEvent.click(within(await screen.findByRole("group", { name: "不感兴趣" })).getByRole("button", { name: `不想看“${today.source.name}”` }));
    await waitFor(() => expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "source", key: today.source.id, label: today.source.name, muted: true }));
    expect(client.hideFrontierItem).toHaveBeenLastCalledWith("today-1", "source");
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(client.removeFrontierFollow).toHaveBeenCalledWith("55"));
    expect(client.unhideFrontierItem).toHaveBeenCalledWith("today-1");
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
  });

  it("brings the card back with the error when the hide itself is refused (c2-hide)", async () => {
    client.hideFrontierItem.mockRejectedValue(new WebApiError("down", { status: 503, code: null }));
    renderPage();
    await chooseHide();
    await waitFor(() => expect(screen.queryByRole("group", { name: "不感兴趣" })).not.toBeInTheDocument());
    expect(await screen.findByRole("article", { name: "今天的一条 RCT" })).toBeInTheDocument();
    expect(client.unhideFrontierItem).not.toHaveBeenCalled();
    const failureMessage = await screen.findByText("服务暂时不可用，请稍后重试。", { selector: "[data-toast] button" });
    const failureToast = failureMessage.closest("[data-toast]");
    expect(failureToast).toBeVisible();
    expect(failureToast).toHaveAttribute("data-toast-tone", "error");
    expect(failureToast).not.toHaveAttribute("role");
    expect(client.hideFrontierItem).toHaveBeenCalledTimes(1);
    expect(client.hideFrontierItem).toHaveBeenCalledWith("today-1");
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
    // The card's time is today's 17:23 (Beijing time) seen from today's 20:00: with the real clock, a run between 17:00 and 17:59 saw a
    // future timestamp, which the card shows as now (「17:4x」), and the "no 17 anywhere else" check below failed.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${BEIJING_DAY}T20:00:00+08:00`) });
    onTestFinished(() => { vi.useRealTimers(); });
    const timelineAt = new Date(`${BEIJING_DAY}T17:23:00+08:00`).toISOString();
    const title = "87 项研究中的 RCT";
    const summary = "29 个中心纳入 17 至 87 岁患者，随访 13 个月。";
    feed = async () => page([frontierItem({ ...today, title, summary, timelineAt })]);
    renderPage();
    const card = await screen.findByRole("article", { name: title });
    expect(within(card).getByText("17:23")).toBeInTheDocument();
    expect(within(card).getByText(summary)).toBeInTheDocument();
    expect(card.querySelector("[data-score]")).toHaveTextContent(/^AI 评分\s*86$/);
    expect(card).not.toHaveTextContent("编辑评分");
    expect(card.querySelectorAll("[data-score]")).toHaveLength(1);
    // Numbers in source metadata and editorial content are not scores. Check every
    // other part of the card for leakage of the fixture's private score fields.
    const scoreContent = card.cloneNode(true) as HTMLElement;
    scoreContent.querySelectorAll("time, [data-row-title]").forEach((element) => element.remove());
    within(scoreContent).getByText("17:23").remove();
    within(scoreContent).getByText(summary).remove();
    for (const number of ["87", "29", "17", "13"]) expect(scoreContent.textContent).not.toContain(number);
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
    client.fetchFrontierHotBoard.mockResolvedValue(board(events, { takenAt: new Date(`${BEIJING_DAY}T22:40:00+08:00`).toISOString() }));
    renderPage("/app/frontier?view=hot");
    const list = await screen.findByRole("list", { name: "热榜" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("01");
    expect(within(rows[0]).getByRole("link", { name: "不饱和磷脂脂质体实现亲水药物超缓释" })).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(rows[0]).toHaveTextContent("2 家机构报道 · 含原始论文 · 3 小时前更新");
    expect(rows[0]).toHaveTextContent("38 热度");
    expect(rows[0].querySelector("svg[data-sparkline] path")).not.toBeNull();
    expect(within(rows[2]).getByText("新")).toHaveClass("bg-surface-2", "text-text-2");
    expect(within(rows[2]).getByText("暂无走势")).toBeInTheDocument();
    expect(within(rows[3]).getByText("升温")).toHaveClass("bg-surface-2", "text-text-2");
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


describe("关注, the reader's own place (owner, 2026-10-25)", () => {
  const followList = () => within(screen.getByRole("navigation", { name: "我的关注" }));

  it("opens on 与我相关 beside the list of what is followed: 与我相关, 全部关注, each follow under its kind, the zones, 添加关注 · 管理", async () => {
    client.listFrontierFollows.mockResolvedValue([
      { id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false },
      { id: "9", kind: "specialty", key: "oncology", label: "肿瘤", muted: false },
    ]);
    renderPage("/app/frontier?view=following");
    await waitFor(() => expect(client.fetchFrontierForYou).toHaveBeenCalled());
    expect(followList().getAllByRole("link").map((link) => link.textContent)).toEqual(["与我相关", "全部关注", "肿瘤", "肥胖研究", "房颤抗凝"]);
    expect(followList().getByRole("link", { name: "与我相关" })).toHaveAttribute("aria-current", "page");
    expect(followList().getByRole("link", { name: "肿瘤" })).toHaveAttribute("href", "/app/frontier?view=following&follow=9");
    expect(followList().getByRole("button", { name: "添加关注 · 管理" })).toBeInTheDocument();
    // 与我相关 is not a list of items the feed reads.
    expect(feedQueries()).toEqual([]);
  });

  it("narrows to one follow by its address, 「筛选」 still applying, and widens to 全部关注 from the list", async () => {
    const user = userEvent.setup();
    renderPage("/app/frontier?view=following&follow=7&lane=safety");
    expect(await viewTabs().findByRole("tab", { name: "关注" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ view: "all", follow: "7", lane: "safety" })));
    expect(followList().getByRole("link", { name: "肥胖研究" })).toHaveAttribute("aria-current", "page");
    expect(within(controlRow()).getByRole("button", { name: "筛选，已选 1 项" })).toBeInTheDocument();
    // On a wide screen the list says which follow is open: no token for it on the row.
    expect(within(controlRow()).queryByRole("button", { name: /只看：/ })).not.toBeInTheDocument();
    await user.click(followList().getByRole("link", { name: "全部关注" }));
    expect(location()).toBe("/app/frontier?view=following&follow=all&lane=safety");
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

  it("lists the followed evidence zones as the first group of 全部关注, and one zone's cards from its entry", async () => {
    renderPage("/app/frontier?view=following&follow=all");
    const group = await screen.findByRole("region", { name: "关注的证据专区" });
    expect(within(group).getByRole("link", { name: "房颤抗凝" })).toHaveAttribute("href", "/app/frontier/zones/ez_1");
    expect(within(controlRow()).queryByRole("button", { name: "管理关注" })).not.toBeInTheDocument();
    await userEvent.click(followList().getByRole("link", { name: "房颤抗凝" }));
    expect(location()).toBe("/app/frontier?view=following&follow=zone%3Aez_1");
    expect(await screen.findByRole("region", { name: "关注的证据专区" })).toBeInTheDocument();
  });

  it("selects a saved follow from 管理关注 into the address, and a removed one leaves 全部关注", async () => {
    const user = userEvent.setup();
    renderPage("/app/frontier?view=following&follow=all");
    await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ follow: "all" })));
    await user.click(followList().getByRole("button", { name: "添加关注 · 管理" }));
    const drawer = await screen.findByRole("dialog", { name: "管理关注" });
    await user.click(await within(drawer).findByRole("button", { name: "肥胖研究" }));
    expect(location()).toContain("follow=7");
    expect(client.fetchFrontierForYou).not.toHaveBeenCalled();
  });

  it("says 「关注的内容暂时没有新动态」 — not 「没有结果」 — when what is followed has nothing new", async () => {
    feed = async () => page([]);
    renderPage("/app/frontier?view=following&follow=all");
    expect(await screen.findByText("关注的内容暂时没有新动态")).toBeInTheDocument();
    expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
  });

  it("keeps 「没有结果」 for a narrowed follow or a filter that excluded everything", async () => {
    feed = async () => page([]);
    renderPage("/app/frontier?view=following&follow=7");
    expect(await screen.findByText("没有结果")).toBeInTheDocument();
  });

  it("says what a typed follow is waiting for when nothing matched it yet — not 「没有结果」 — and keeps 「没有结果」 once a filter is set too", async () => {
    client.listFrontierFollows.mockResolvedValue([{ id: "7", kind: "query", key: "长新冠", label: "长新冠", muted: false, query: { kind: "topic", concepts: [["长新冠"]] } }]);
    feed = async () => page([]);
    renderPage("/app/frontier?view=following&follow=7");
    expect(await screen.findByText("暂时没有匹配“长新冠”的动态，有新的会出现在这里")).toBeInTheDocument();
    expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
    cleanup();
    renderPage("/app/frontier?view=following&follow=7&lane=safety");
    expect(await screen.findByText("没有结果")).toBeInTheDocument();
  });

  it("opening a follow's feed tells the server it was looked at, once, and not for 与我相关 or all follows", async () => {
    client.listFrontierFollows.mockResolvedValue([{ id: "7", kind: "query", key: "长新冠", label: "长新冠", muted: false, newItems: 3 }]);
    renderPage("/app/frontier?view=following&follow=7");
    await waitFor(() => expect(client.markFrontierFollowSeen).toHaveBeenCalledWith("7"));
    expect(client.markFrontierFollowSeen).toHaveBeenCalledTimes(1);
    cleanup();
    client.markFrontierFollowSeen.mockClear();
    renderPage("/app/frontier?view=following&follow=all");
    await screen.findByText("今天的一条 RCT");
    expect(client.markFrontierFollowSeen).not.toHaveBeenCalled();
  });

  it("with only zones followed shows the zones and no feed block, no 「没有结果」, no filters", async () => {
    client.listFrontierFollows.mockResolvedValue([]);
    renderPage("/app/frontier?view=following&follow=all");
    await screen.findByRole("region", { name: "关注的证据专区" });
    expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
    expect(feedQueries()).toEqual([]);
    expect(within(controlRow()).queryByRole("button", { name: /^筛选/ })).not.toBeInTheDocument();
  });

  describe("with nothing followed yet", () => {
    beforeEach(() => {
      client.listFrontierFollows.mockResolvedValue([]);
      zones.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null });
    });

    it("is one sentence and the way to start once the card was answered — no 「没有结果」, no filters, and no read of the feed", async () => {
      renderPage("/app/frontier?view=following&follow=all");
      expect(await screen.findByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "添加关注" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "添加关注" })).toHaveClass("bg-accent");
      expect(screen.getByRole("link", { name: "浏览证据专区" })).toHaveAttribute("href", "/app/frontier?view=zones");
      expect(screen.queryByText("没有结果")).not.toBeInTheDocument();
      expect(within(controlRow()).queryByRole("button", { name: /^筛选/ })).not.toBeInTheDocument();
      expect(secondRow()).toBeNull();
      expect(feedQueries()).toEqual([]);
    });

    it("is the onboarding card where it was never answered, and its answers become the first follows", async () => {
      prefs.fetchFrontierPrefs.mockResolvedValue({ role: null, specialties: [], interests: [], interestTags: [], onboardedAt: null, skippedAt: null });
      prefs.saveFrontierPrefs.mockResolvedValue({ role: "physician", specialties: ["oncology"], interests: ["hcc"], interestTags: [{ slug: "hcc", name: "肝细胞癌" }], onboardedAt: ago(0), skippedAt: null });
      renderPage("/app/frontier?view=following&follow=all");
      expect(await screen.findByRole("heading", { name: "你的角色" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "添加关注" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "跳过" }));
      await waitFor(() => expect(client.addFrontierFollow.mock.calls.map(([input]) => input)).toEqual([
        { kind: "specialty", key: "oncology", label: "肿瘤" },
        { kind: "tag", key: "hcc", label: "肝细胞癌" },
      ]));
    });

    it("opens 管理关注 from the one button, and shows the first follow's results as soon as it is made", async () => {
      const user = userEvent.setup();
      renderPage("/app/frontier?view=following&follow=all");
      await user.click(await screen.findByRole("button", { name: "添加关注" }));
      const drawer = await screen.findByRole("dialog", { name: "管理关注" });
      client.listFrontierFollows.mockResolvedValue([{ id: "7", kind: "topic", key: "obesity", label: "肥胖研究", muted: false }]);
      await act(async () => { window.dispatchEvent(new Event("evimed:frontier-follows-changed")); });
      await waitFor(() => expect(client.listFrontierItems).toHaveBeenCalledWith(expect.objectContaining({ follow: "all", view: "all" })));
      expect(await screen.findByText("今天的一条 RCT")).toBeInTheDocument();
      expect(screen.queryByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).not.toBeInTheDocument();
      expect(within(controlRow()).getByRole("button", { name: "筛选" })).toBeInTheDocument();
      expect(drawer).toBeInTheDocument();
    });

    it("says that the follows could not be read, rather than that there are none", async () => {
      client.listFrontierFollows.mockRejectedValue(new WebApiError("down", { status: 502 }));
      renderPage("/app/frontier?view=following&follow=all");
      expect(await screen.findByRole("note")).toHaveTextContent("服务暂时不可用，请稍后重试。");
      expect(screen.queryByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).not.toBeInTheDocument();
      client.listFrontierFollows.mockResolvedValue([]);
      await userEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(await screen.findByText("关注药物、主题、专科或证据专区，它们的新动态会汇总在这里。")).toBeInTheDocument();
    });
  });

  it("offers 「关注“<词>”」 on a search's results, as a topic follow", async () => {
    client.listFrontierFollows.mockResolvedValue([]);
    renderPage("/app/frontier?view=all&q=%E5%8F%B8%E7%BE%8E%E6%A0%BC%E9%B2%81%E8%82%BD");
    const button = await screen.findByRole("button", { name: "关注“司美格鲁肽”" });
    await userEvent.click(button);
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "topic", key: "司美格鲁肽", label: "司美格鲁肽" });
    expect(await screen.findByRole("button", { name: "已关注“司美格鲁肽”" })).toBeDisabled();
  });
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
  // Beijing's wall clock is UTC+8: shift the instant and read its UTC fields.
  const date = new Date(MIDNIGHT - 30 * HOUR + 8 * HOUR);
  expect(card).toHaveTextContent(`肿瘤学年鉴 · ${date.getUTCMonth() + 1}月${date.getUTCDate()}日`);
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


describe("追踪", () => {
  const approvals = (over: Record<string, unknown> = {}) => ({
    items: [
      { item: frontierItem({ id: "ap-1", title: "FDA approval: Hibsago" }), at: "2026-10-24", approval: "new-drug", approvalLabel: "首次获批", agency: { key: "fda", label: "FDA" }, drug: "Hibsago（bepirovirsen）", indication: "慢性乙型肝炎" },
      { item: frontierItem({ id: "ap-2", title: "EMA: Ximluci" }), at: "2026-10-10", approval: "new-indication", approvalLabel: "新增适应症", agency: { key: "ema", label: "EMA" }, drug: "Ximluci", indication: null },
    ],
    nextCursor: null, from: "2026-07-27", listId: "approvals-list",
    agencies: [{ key: "fda", label: "FDA", region: "us", regionLabel: "美国", count: 1 }, { key: "ema", label: "EMA", region: "eu", regionLabel: "欧洲", count: 1 }],
    ytd: { year: 2026, since: "2026-09-22", total: 2, byAgency: [{ key: "fda", label: "FDA", count: 1 }, { key: "ema", label: "EMA", count: 1 }] },
    ...over,
  });
  const guidelines = () => ({
    items: [{ item: frontierItem({ id: "gl-1", title: "ACP 指南" }), at: "2026-10-24", body: "美国内科医师学会", scope: "绝经症状", recommendations: [{ text: "使用雌激素", grade: "强推荐" }] }],
    nextCursor: null, listId: "guidelines-list", specialties: [{ key: "oncology", label: "肿瘤", count: 1 }],
  });
  const congress = (over: Record<string, unknown> = {}) => ({ id: "esmo-2026", code: "ESMO 2026", name: "欧洲肿瘤内科学会年会", nameEn: "ESMO Congress 2026", start: "2026-10-23", end: "2026-10-27",
    city: "Madrid", specialty: "oncology", specialtyLabel: "肿瘤学", status: "ongoing", itemCount: 57, ...over });

  it("is the fifth tab after 热榜; it opens on 审批 with one row of controls: the segment chips and the agency", async () => {
    client.listFrontierApprovals.mockResolvedValue(approvals());
    renderPage("/app/frontier?view=track");
    expect(viewTabs().getByRole("tab", { name: "追踪" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Hibsago（bepirovirsen）")).toBeInTheDocument();
    expect(client.listFrontierApprovals).toHaveBeenCalledWith({ agency: null, cursor: null });
    expect(client.listFrontierGuidelines).not.toHaveBeenCalled();
    expect(client.listFrontierItems).not.toHaveBeenCalled();
    const row = controlRow();
    expect(within(row).getByRole("button", { name: "审批" })).toHaveAttribute("aria-pressed", "true");
    expect(within(row).getByRole("button", { name: "指南" })).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByRole("button", { name: "会议" })).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByRole("button", { name: /^机构/ })).toBeInTheDocument();
    expect(document.querySelector("[data-note]")).toHaveTextContent("9月22日以来共收录 2 项审批");
    expectComposed(document.body, { tablists: 1 });
  });

  it("switches segments through the chips, keeps them in the address, and asks only for the open segment", async () => {
    client.listFrontierApprovals.mockResolvedValue(approvals());
    client.listFrontierGuidelines.mockResolvedValue(guidelines());
    client.listFrontierCongresses.mockResolvedValue([congress()]);
    renderPage("/app/frontier?view=track");
    await screen.findByText("Hibsago（bepirovirsen）");
    await userEvent.click(within(controlRow()).getByRole("button", { name: "指南" }));
    expect(location()).toBe("/app/frontier?view=track&segment=guidelines");
    expect(await screen.findByText("ACP 指南")).toBeInTheDocument();
    expect(screen.getByText("使用雌激素")).toBeInTheDocument();
    expect(within(controlRow()).getByRole("button", { name: /^专科/ })).toBeInTheDocument();
    await userEvent.click(within(controlRow()).getByRole("button", { name: "会议" }));
    expect(location()).toBe("/app/frontier?view=track&segment=congresses");
    const link = await screen.findByRole("link", { name: /ESMO 2026/ });
    expect(link).toHaveAttribute("href", "/app/frontier/congress/esmo-2026");
    expect(within(controlRow()).queryByRole("button", { name: /^(机构|专科)/ })).toBeNull();
    await userEvent.click(within(controlRow()).getByRole("button", { name: "审批" }));
    expect(location()).toBe("/app/frontier?view=track");
  });

  it("opens on the segment and the agency the address names, and narrows to an agency from the line above the list", async () => {
    client.listFrontierApprovals.mockResolvedValue(approvals());
    renderPage("/app/frontier?view=track&agency=fda");
    await screen.findByText("Hibsago（bepirovirsen）");
    expect(client.listFrontierApprovals).toHaveBeenCalledWith({ agency: "fda", cursor: null });
    await userEvent.click(within(document.querySelector("[data-note]") as HTMLElement).getByRole("button", { name: "EMA 1 项，只看这个机构" }));
    expect(location()).toBe("/app/frontier?view=track&agency=ema");
    await waitFor(() => expect(client.listFrontierApprovals).toHaveBeenLastCalledWith({ agency: "ema", cursor: null }));
  });

  it("says so, with a way on, when the server has no tracker yet", async () => {
    renderPage("/app/frontier?view=track");
    expect(await screen.findByText("审批追踪还在准备")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看官方来源的动态" })).toBeInTheDocument();
  });

  it("is the congress on now above 热榜's ranking, one line that opens its hub", async () => {
    client.fetchFrontierHotBoard.mockResolvedValue(board([hotEvent(1)]));
    client.listFrontierCongresses.mockResolvedValue([congress()]);
    renderPage("/app/frontier?view=hot");
    const link = await screen.findByRole("link", { name: /ESMO 2026/ });
    expect(link).toHaveTextContent("ESMO 2026进行中·57 条");
    expect(link).toHaveAttribute("href", "/app/frontier/congress/esmo-2026");
    expect(await screen.findByRole("list", { name: "热榜" })).toBeInTheDocument();
  });

  it("reads an unknown segment in the address as 审批", async () => {
    client.listFrontierApprovals.mockResolvedValue(approvals());
    renderPage("/app/frontier?view=track&segment=whatever");
    await screen.findByText("Hibsago（bepirovirsen）");
    expect(within(controlRow()).getByRole("button", { name: "审批" })).toHaveAttribute("aria-pressed", "true");
  });
});
