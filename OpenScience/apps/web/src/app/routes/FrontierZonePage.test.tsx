import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { Toaster } from "@/components/ui/Toaster";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { NotTopicZoneError, parseZoneDetail, type ZoneItemsPage } from "@/lib/evidenceTopicClient";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { cardRecord, overview, rawCard, rawItem, rawOverview, rawZone, zone } from "@/components/frontier/zone/__fixtures__/zones";
import { NOT_IN_UNDO_MS } from "@/components/frontier/zone/ZoneItemsTab";
import type { ZoneEditorProps } from "@/components/frontier/zone/zoneEditor";
import { expectComposed } from "@/test/expectComposed";
import { WIDE_QUERY } from "@/lib/useMediaQuery";
import { FrontierZonePage } from "./FrontierZonePage";

const topic = vi.hoisted(() => ({
  fetchZone: vi.fn(), fetchZoneOverview: vi.fn(), fetchZoneItems: vi.fn(), fetchZoneCards: vi.fn(),
  followZone: vi.fn(), updateZone: vi.fn(), deleteZone: vi.fn(), zoneItemFeedback: vi.fn(),
}));
vi.mock("@/lib/evidenceTopicClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicClient")>()), ...topic }));
// A zone of the old kind is read through the old zone client; its page is `LegacyZoneView`.
const old = vi.hoisted(() => ({ fetchEvidenceZoneDetail: vi.fn(), listZoneEvidence: vi.fn(), followEvidenceZone: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...old }));
// Whether the directory has said this reader may make a zone (it has not been read here: nothing says no).
const create = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/components/frontier/zone/useZoneCreate", () => ({ useZoneCreate: () => create.allowed }));
const frontier = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), starFrontierItem: vi.fn(), unstarFrontierItem: vi.fn(), hideFrontierItem: vi.fn(), unhideFrontierItem: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...frontier }));
// The project reference on the 证据卡片 tab asks whether the deployment offers it; here it does not.
vi.mock("@/lib/meFeature", () => ({ useMeFeature: () => "off" }));
vi.mock("@/lib/projects", () => {
  const state = { currentId: "project-a", projects: [{ id: "project-a", name: "房颤研究" }] };
  return { useProjectStore: (select: (value: typeof state) => unknown) => select(state) };
});

function Where() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="where" data-draft={intent?.draft}>{location.pathname + location.search}</div>;
}
const where = () => screen.getByTestId("where").textContent ?? "";

function mount(path = "/app/frontier/zones/zone-glp1", editor?: React.ComponentType<ZoneEditorProps>, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path.split("?")[0], search: path.includes("?") ? `?${path.split("?")[1]}` : "", state }]}>
      <Routes>
        <Route path="/app/frontier/zones/:zoneId" element={<><FrontierZonePage editor={editor ?? null} /><Where /></>} />
        <Route path="/app/frontier/zones/s/:slug" element={<><FrontierZonePage editor={editor ?? null} /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
      <Toaster />
    </MemoryRouter>,
  );
}

/** From 1024 px the page has its right column; the stub of the test environment never matches a query. */
function wideScreen(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query === WIDE_QUERY, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const page = (items: ReturnType<typeof rawItem>[], more: Partial<ZoneItemsPage> = {}): ZoneItemsPage => ({
  items: items.map((raw) => frontierItem(raw as Record<string, unknown>)),
  roleCounts: { research: 12, guideline: 3, approval: 2, news: 0 }, nextCursor: null, total: items.length, ...more,
});

beforeEach(() => {
  vi.clearAllMocks();
  create.allowed = true;
  wideScreen(false);
  frontier.useFrontierFeature.mockReturnValue("on");
  topic.fetchZone.mockResolvedValue(zone());
  topic.fetchZoneOverview.mockResolvedValue(overview());
  topic.fetchZoneItems.mockResolvedValue(page([rawItem("a1", "司美格鲁肽心血管获益再确认"), rawItem("a2", "指南更新：肥胖症药物治疗", { timelineAt: "2026-10-27T06:30:00.000Z" })]));
  topic.fetchZoneCards.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const header = async () => (await screen.findByRole("heading", { level: 1, name: "GLP-1 受体激动剂减重" })).closest("header")!;

describe("a zone's header", () => {
  it("names the zone, the way back to the directory, the keywords as labels, the scope and the counts as links to the 动态 tab", async () => {
    mount();
    const head = await header();
    const back = within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "证据专区" });
    expect(back).toHaveAttribute("href", "/app/frontier?view=zones");
    const keywords = screen.getByRole("list", { name: "关键词" });
    expect(within(keywords).getByText("GLP-1 受体激动剂")).toHaveAttribute("data-tag");
    expect(within(keywords).getByText("减重")).toHaveAttribute("data-tag");
    expect(keywords.querySelector("a, button")).toBeNull();
    expect(screen.getByText(/成人超重或肥胖者使用 GLP-1 类药物减重/)).toBeInTheDocument();
    // 内分泌 · 近 7 天 58 · 近 30 天 247 · 全部 610 条 · 截至 10月29日 14:20（北京时间）: each count opens the tab with its window.
    // (The dots between the facts are drawn marks, hidden from a screen reader, so they are not in the text.)
    const facts = screen.getByText(/截至 10月29日 14:20（北京时间）/).closest("p")!;
    expect(facts.textContent).toBe("内分泌·近 7 天 58·近 30 天 247·全部 610 条·截至 10月29日 14:20（北京时间）");
    expect(within(facts).getByRole("link", { name: /近 7 天 58 条/ })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=7d");
    expect(within(facts).getByRole("link", { name: /近 30 天 247 条/ })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=30d");
    expect(within(facts).getByRole("link", { name: /全部 610 条/ })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=all");
    // The title is not duplicated and the header holds one primary.
    expect(screen.getAllByRole("heading", { name: "GLP-1 受体激动剂减重" })).toHaveLength(1);
    expect(head).toBeInTheDocument();
  });

  it("says the number of cards only when there are some, and the tab with them is offered then and not before", async () => {
    mount();
    await header();
    expect(screen.queryByText(/证据卡片/)).toBeNull();
    expect(screen.queryByRole("tab", { name: "证据卡片" })).toBeNull();
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ cards: 3 }));
    mount();
    await header();
    expect(screen.getByRole("link", { name: /证据卡片 3 张/ })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=cards");
    expect(screen.getByRole("tab", { name: "证据卡片" })).toBeInTheDocument();
  });

  it("has 关注 as the primary for a platform zone, 已关注 for one the reader follows, and each press goes through the server's answer", async () => {
    topic.followZone.mockImplementation(async (_zone: { id: string }, follow: boolean) => zone({ following: follow }));
    mount();
    const head = await header();
    await userEvent.click(within(head).getByRole("button", { name: "关注" }));
    expect(topic.followZone).toHaveBeenLastCalledWith(expect.objectContaining({ id: "zone-glp1", revision: 3 }), true);
    await userEvent.click(await within(head).findByRole("button", { name: "已关注" }));
    expect(topic.followZone).toHaveBeenLastCalledWith(expect.objectContaining({ id: "zone-glp1" }), false);
    expect(await within(head).findByRole("button", { name: "关注" })).toBeInTheDocument();
    expect(within(head).queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("offers 编辑 to the owner of a zone (not 关注), says it is theirs, and opens the drawer with the zone", async () => {
    const editor = vi.fn((props: ZoneEditorProps) => <div role="dialog" aria-label="编辑专区">{props.mode}:{props.zone?.id}</div>);
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: true, canDelete: true, published: false, creator: "李研究", definition: { type: "drug-indication", keywords: [], perspective: null, scope: "", include: "", exclude: "", excludeTerms: [], specialties: [], group: "" } }));
    mount("/app/frontier/zones/zone-glp1", editor);
    const head = await header();
    expect(screen.getByText(/我的专区/, { selector: "span" })).toHaveTextContent("我的专区");
    expect(screen.queryByText("我的专区 · 已公开")).toBeNull();
    expect(within(head).queryByRole("button", { name: /关注/ })).toBeNull();
    await userEvent.click(within(head).getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("dialog", { name: "编辑专区" })).toHaveTextContent("edit:zone-glp1");
  });

  it("says 「我的专区 · 已公开」 for the owner's published zone and the creator's name for someone else's", async () => {
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: true, published: true }));
    mount();
    await header();
    expect(screen.getByText("我的专区 · 已公开")).toBeInTheDocument();
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: false, published: true, creator: "王研究" }));
    mount();
    await header();
    expect(screen.getByText("王研究 创建")).toBeInTheDocument();
    expect(screen.queryByText(/我的专区/)).toBeNull();
  });

  it("puts 深入研究, 复制链接 and 以此新建我的专区 in the ⋯ menu, and 公开到平台 and 删除 only for the owner's own zone", async () => {
    const editor = (props: ZoneEditorProps) => <div role="dialog" aria-label="新建专区">{props.mode}:{props.seed?.baseZoneId}</div>;
    mount("/app/frontier/zones/zone-glp1", editor);
    const head = await header();
    await userEvent.click(within(head).getByRole("button", { name: "更多操作" }));
    const entries = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(entries).toEqual(["深入研究", "复制链接", "以此新建我的专区"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "以此新建我的专区" }));
    expect(await screen.findByRole("dialog", { name: "新建专区" })).toHaveTextContent("create:zone-glp1");
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: true, canDelete: true, published: false }));
    mount("/app/frontier/zones/zone-glp1", editor);
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["深入研究", "复制链接", "以此新建我的专区", "公开到平台", "删除"]);
  });

  it("publishes the owner's zone to the platform with one press, unreviewed, and takes it back the same way", async () => {
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: true, canDelete: true, published: false }));
    topic.updateZone.mockResolvedValue(zone({ kind: "user", canEdit: true, canDelete: true, published: true }));
    mount();
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "公开到平台" }));
    await waitFor(() => expect(topic.updateZone).toHaveBeenCalledWith(expect.objectContaining({ id: "zone-glp1" }), { published: true }));
    expect(await screen.findByText("我的专区 · 已公开")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "取消公开" })).toBeInTheDocument();
  });

  it("deletes the owner's zone after one confirmation and returns to the directory", async () => {
    topic.fetchZone.mockResolvedValue(zone({ kind: "user", canEdit: true, canDelete: true }));
    topic.deleteZone.mockResolvedValue(undefined);
    mount();
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("删除专区“GLP-1 受体激动剂减重”？");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(topic.deleteZone).toHaveBeenCalledWith("zone-glp1"));
    await waitFor(() => expect(where()).toBe("/app/frontier?view=zones"));
  });

  it("opens a conversation with a draft that is not sent: the scope, what is new and the key updates by the line the assistant reads them through", async () => {
    mount();
    await screen.findByText("重要更新");
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "深入研究" }));
    expect(where()).toBe("/app/chat");
    const draft = screen.getByTestId("where").getAttribute("data-draft")!;
    expect(draft).toContain("“GLP-1 受体激动剂减重”");
    expect(draft).toContain("范围：成人超重或肥胖者使用 GLP-1 类药物减重");
    expect(draft).toContain("最新进展：司美格鲁肽获批新适应症，替尔泊肽的安全性数据更新");
    expect(draft).not.toMatch(/\[\d\]/);
    expect(draft).toContain("frontier:k1");
  });

  it("copies the link by the readable name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mount();
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/app/frontier/zones/s/glp1-obesity`);
  });

  it("goes back to where it was opened from by the history entry, and to the directory otherwise", async () => {
    mount("/app/frontier/zones/zone-glp1", undefined, { evidenceFrom: { to: "/app/frontier?view=zones&scope=following", label: "证据专区" } });
    await header();
    expect(within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "证据专区" })).toHaveAttribute("href", "/app/frontier?view=zones&scope=following");
  });
});

describe("a zone's overview", () => {
  it("draws the modules in the order the server sent them, each under its own heading, and none that came empty", async () => {
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [...(rawOverview().modules as unknown[]), { key: "safety", items: [], more: null }] }));
    mount();
    await screen.findByRole("heading", { level: 2, name: "最新进展" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 6)).toEqual(["最新进展", "重要更新", "已获批药物", "指南与共识", "多方报道", "最新动态"]);
    expect(headings).not.toContain("安全信号");
  });

  it("writes 最新进展 with no 「AI」 in its name, each mark a link to the item it came from, a mark that names no ref left as words, and the day it was written", async () => {
    mount();
    const heading = await screen.findByRole("heading", { level: 2, name: "最新进展" });
    expect(screen.queryByText(/AI/)).toBeNull();
    const section = heading.closest("section")!;
    expect(within(section).getByText("截至 10月29日")).toBeInTheDocument();
    const first = within(section).getByRole("link", { name: "司美格鲁肽获批新适应症" });
    expect(first).toHaveTextContent("[1]");
    expect(first).toHaveAttribute("href", "/app/frontier/items/k1");
    expect(within(section).getByRole("link", { name: "替尔泊肽安全性更新" })).toHaveAttribute("href", "/app/frontier/items/k2");
    expect(section).toHaveTextContent("[9]不是引用");
    expect(within(section).getAllByRole("link")).toHaveLength(2);
  });

  it("lists items as compact rows — the title as the reader's link, source and kind under it — and a key update leads with its day", async () => {
    mount();
    const updates = (await screen.findByRole("heading", { level: 2, name: "重要更新" })).closest("section")!;
    const row = within(updates).getByRole("link", { name: "司美格鲁肽获批新适应症" });
    expect(row).toHaveAttribute("href", "/app/frontier/items/k1");
    expect(row.closest("li")).toHaveTextContent("10月29日");
    expect(row.closest("li")).toHaveTextContent("丁香园");
    const guidelines = screen.getByRole("heading", { level: 2, name: "指南与共识" }).closest("section")!;
    expect(within(guidelines).getByRole("link", { name: "中国肥胖症诊疗指南更新" }).closest("li")).toHaveTextContent(/丁香园 · 10月28日/);
    // The feed's full card (☆, ⋯, the score) is the 动态 tab's, not the overview's.
    expect(within(updates).queryByRole("button", { name: "收藏" })).toBeNull();
  });

  it("links 查看全部 of a module to the 动态 tab narrowed to what the module holds", async () => {
    mount();
    const updates = (await screen.findByRole("heading", { level: 2, name: "重要更新" })).closest("section")!;
    expect(within(updates).getByRole("link", { name: "查看全部 ›" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&role=approval&window=30d");
    const guidelines = screen.getByRole("heading", { level: 2, name: "指南与共识" }).closest("section")!;
    expect(within(guidelines).getByRole("link", { name: "查看全部 ›" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&role=guideline&window=90d");
    const latest = screen.getByRole("heading", { level: 2, name: "最新动态" }).closest("section")!;
    expect(within(latest).getByRole("link", { name: "查看全部动态 ›" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=30d");
  });

  it("draws the approved drugs as a small table whose approval is a link to its item and whose count opens the drug's items", async () => {
    mount();
    const section = (await screen.findByRole("heading", { level: 2, name: "已获批药物" })).closest("section")!;
    const table = within(section).getByRole("table", { name: "已获批药物" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["药物", "最近获批", "近 30 天"]);
    const row = within(table).getByRole("row", { name: /司美格鲁肽/ });
    expect(within(row).getByRole("link", { name: "NMPA · 10月20日 · 新适应症" })).toHaveAttribute("href", "/app/frontier/items/k1");
    expect(within(row).getByRole("link", { name: "31 条" })).toHaveAttribute("href", `/app/frontier/zones/s/glp1-obesity?tab=items&window=30d&q=${encodeURIComponent("司美格鲁肽")}`);
    expect(within(within(table).getByRole("row", { name: /替尔泊肽/ })).queryByRole("link")).toBeNull();
  });

  it("draws 多方报道 as rows that open the event, with how many institutions and whether the first-hand text is among them", async () => {
    mount();
    const section = (await screen.findByRole("heading", { level: 2, name: "多方报道" })).closest("section")!;
    const row = within(section).getByRole("link", { name: "替尔泊肽减重研究发表" });
    expect(row).toHaveAttribute("href", "/app/frontier/events/ev1");
    expect(row.closest("li")).toHaveTextContent("5 家机构报道 · 含一手材料");
  });

  it("sets evidence cards apart from the item rows — a bordered block with the question, the conclusion, the certainty and the producer — opening in the app or on the other site", async () => {
    topic.fetchZone.mockResolvedValue(zone({ cards: 2 }));
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [
      { key: "cards", total: 5, cards: [rawCard(), rawCard({ id: "card-2", title: "替尔泊肽与睡眠呼吸暂停", conclusion: "", status: "updating", certainty: null, detail: { kind: "link", url: "https://example.org/card-2" } })] },
      ...(rawOverview().modules as unknown[]).slice(1, 2),
    ] }));
    mount();
    const section = (await screen.findByRole("heading", { level: 2, name: "证据卡片" })).closest("section")!;
    const blocks = within(section).getAllByRole("listitem");
    expect(blocks[0]).toHaveClass("border", "rounded-card");
    const inline = within(blocks[0]).getByRole("link", { name: "司美格鲁肽能降低非糖尿病肥胖者的心血管事件吗" });
    expect(inline).toHaveAttribute("href", "/app/frontier/zones/zone-glp1/evidence/card-1");
    expect(blocks[0]).toHaveTextContent("能：主要心血管事件相对下降约 20%。");
    expect(within(blocks[0]).getByText("中等确定性")).toHaveAttribute("data-tag");
    expect(blocks[0]).toHaveTextContent("4 项研究");
    expect(blocks[0]).toHaveTextContent("EviMed 证据中心");
    const outside = within(blocks[1]).getByRole("link", { name: /替尔泊肽与睡眠呼吸暂停/ });
    expect(outside).toHaveAttribute("href", "https://example.org/card-2");
    expect(outside).toHaveAttribute("target", "_blank");
    expect(within(blocks[1]).getByText("有新进展")).toBeInTheDocument();
    // More cards than the overview shows: the way to all of them is the tab.
    expect(within(section).getByRole("link", { name: "查看全部 ›" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=cards");
  });

  it("puts the right column beside the page from 1024 px — related zones, the names that come up, twelve weeks as bars that open a week, topics, congresses — and none of a block that is empty", async () => {
    wideScreen(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
    mount();
    const rail = await screen.findByRole("complementary", { name: "专区侧栏" });
    expect(within(rail).getByRole("link", { name: "GLP-1 受体激动剂与 MASH" })).toHaveAttribute("href", "/app/frontier/zones/zone-mash");
    const drugs = within(rail).getByRole("list", { name: "常见药物" });
    expect(within(drugs).getByRole("link", { name: /司美格鲁肽/ })).toHaveAttribute("href", `/app/frontier/zones/s/glp1-obesity?tab=items&window=30d&q=${encodeURIComponent("司美格鲁肽")}`);
    expect(within(rail).getByRole("list", { name: "常见疾病" })).toBeInTheDocument();
    expect(within(rail).getByRole("list", { name: "常见机构" })).toBeInTheDocument();
    const weeks = within(rail).getByRole("list", { name: /近 12 周每周动态条数，共 \d+ 条/ });
    const bars = within(weeks).getAllByRole("link");
    expect(bars).toHaveLength(12);
    expect(bars[11]).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=7d&week=2026-10-26");
    expect(bars[11].getAttribute("aria-label")).toMatch(/^10月26日起一周，\d+ 条$/);
    expect(bars[0]).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=90d&week=2026-08-10");
    expect(within(rail).getByRole("link", { name: "司美格鲁肽停药后体重反弹吗" })).toHaveAttribute("href", "/app/frontier/topics/topic-1");
    expect(within(rail).getByRole("link", { name: /EASD 2026/ })).toHaveAttribute("href", "/app/frontier/congress/cong-1");
    cleanup();
    topic.fetchZoneOverview.mockResolvedValue(overview({ side: { related: [], entities: { drugs: [], diseases: [], orgs: [] }, weekly: [], topics: [], congresses: [] } }));
    mount();
    await screen.findByRole("heading", { level: 2, name: "最新进展" });
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("stacks the right column under the modules on a narrow screen, as the same blocks", async () => {
    mount();
    await screen.findByRole("heading", { level: 2, name: "最新动态" });
    expect(screen.queryByRole("complementary")).toBeNull();
    const rail = screen.getByRole("heading", { level: 2, name: "相关专区" });
    expect(screen.getByRole("heading", { level: 2, name: "最新动态" }).compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says a new zone is being filled, with a way to look again, instead of an empty page — the server sends its 最新动态 empty, never no modules", async () => {
    topic.fetchZone.mockResolvedValue(zone({ counts: { week: 0, month: 0, all: 0 }, updatedAt: null }));
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [{ key: "latest", items: [], more: { role: null, window: "30d" } }] }));
    mount();
    expect(await screen.findByText("正在为这个专区搜集内容，通常几分钟内出现第一批")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "最新动态" })).toBeNull();
    topic.fetchZoneOverview.mockResolvedValue(overview());
    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("heading", { level: 2, name: "最新进展" })).toBeInTheDocument();
  });

  it("counts a module as content only when it holds something: every kind of module that came empty leaves the page as the empty state", async () => {
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [
      { key: "cards", cards: [], total: 0 }, { key: "approved-drugs", rows: [] }, { key: "multi-source", events: [] }, { key: "key-updates", items: [], more: null },
      { key: "latest", items: [], more: { role: null, window: "30d" } },
    ] }));
    mount();
    expect(await screen.findByText("正在为这个专区搜集内容，通常几分钟内出现第一批")).toBeInTheDocument();
    cleanup();
    // One module with something in it is a page: the empty ones around it are not drawn.
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [{ key: "key-updates", items: [], more: null }, { key: "latest", items: [rawItem("l1", "肥胖患者用药依从性研究")], more: { role: null, window: "30d" } }] }));
    mount();
    expect(await screen.findByRole("heading", { level: 2, name: "最新动态" })).toBeInTheDocument();
    expect(screen.queryByText("正在为这个专区搜集内容，通常几分钟内出现第一批")).toBeNull();
  });

  it("does not say a quiet or an archived zone is being filled: it has nothing new, and the way on is what it holds", async () => {
    topic.fetchZone.mockResolvedValue(zone({ lifecycle: "quiet", lastItemAt: "2026-09-02T08:00:00.000Z" }));
    topic.fetchZoneOverview.mockResolvedValue(overview({ modules: [{ key: "latest", items: [], more: { role: null, window: "30d" } }] }));
    mount();
    expect(await screen.findByText("近期没有新的内容")).toBeInTheDocument();
    expect(screen.queryByText(/正在为这个专区搜集内容/)).toBeNull();
    expect(screen.getByRole("link", { name: "看全部动态" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items&window=all");
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ lifecycle: "archived", counts: { week: 0, month: 0, all: 0 } }));
    mount();
    expect(await screen.findByText("近期没有新的内容")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "看全部动态" })).toBeNull();
  });

  it("says why it could not read the overview and reads again on 重试", async () => {
    topic.fetchZoneOverview.mockRejectedValueOnce(new WebApiError("boom", { status: 500 }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 2, name: "最新进展" })).toBeInTheDocument();
    expect(topic.fetchZoneOverview).toHaveBeenCalledTimes(2);
  });

  it("is composed by the page framework: the header before the body, the tab row in the band, one primary, no tag that is a control", async () => {
    const { container } = mount();
    await screen.findByRole("heading", { level: 2, name: "最新进展" });
    expectComposed(container, { tablists: 1, toolbar: false });
  });

  it("shows no back-office word anywhere on the page", async () => {
    wideScreen(true);
    topic.fetchZone.mockResolvedValue(zone({ cards: 1 }));
    mount();
    await screen.findByRole("heading", { level: 2, name: "最新进展" });
    expect(document.body.textContent).not.toMatch(/模型判定|置信度|归入方式|接口未接入|deepseek|token|AI 近况/i);
  });
});

describe("a zone that went quiet, was archived, or is not a topic zone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
  });

  it("says when a quiet zone last had something, first among the facts, and says the same of one that never had", async () => {
    topic.fetchZone.mockResolvedValue(zone({ lifecycle: "quiet", lastItemAt: "2026-09-02T08:00:00.000Z" }));
    mount();
    await header();
    const facts = screen.getByText(/截至 10月29日 14:20（北京时间）/).closest("p")!;
    expect(facts.textContent).toMatch(/^最近更新于 9月2日·内分泌·近 7 天 58/);
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ lifecycle: "quiet", lastItemAt: null }));
    mount();
    await header();
    expect(screen.getByText("近期没有新动态")).toBeInTheDocument();
    expect(screen.queryByText(/最近更新于/)).toBeNull();
  });

  it("says an archived zone is no longer updated and, after a merge or a split, links the zones that took over", async () => {
    topic.fetchZone.mockResolvedValue(zone({
      lifecycle: "archived", lastItemAt: "2026-05-03T08:00:00.000Z",
      successors: [{ id: "zone-a", slug: "glp1-weight", title: "GLP-1 受体激动剂减重" }, { id: "zone-b", slug: null, title: "替尔泊肽心血管结局" }],
    }));
    mount();
    await header();
    const line = screen.getByText(/这个专区不再更新，最后更新于 5月3日。/).closest("p")!;
    expect(within(line).getByRole("link", { name: "GLP-1 受体激动剂减重" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-weight");
    expect(within(line).getByRole("link", { name: "替尔泊肽心血管结局" })).toHaveAttribute("href", "/app/frontier/zones/zone-b");
    expect(line).toHaveTextContent("现在请看：");
    cleanup();
    topic.fetchZone.mockResolvedValue(zone({ lifecycle: "archived" }));
    mount();
    await header();
    expect(screen.getByText("这个专区不再更新。")).toBeInTheDocument();
    expect(screen.queryByText(/现在请看/)).toBeNull();
  });

  it("reads a zone whose detail has neither successors nor a last item time as it did, and an active zone says nothing of either", async () => {
    const raw = rawZone();
    delete raw.successors;
    delete raw.lastItemAt;
    expect(parseZoneDetail(raw)).toMatchObject({ successors: [], lastItemAt: null });
    expect(parseZoneDetail(rawZone({ successors: [{ id: "", title: "" }, "x", { id: "z", slug: "s", title: "T" }], lastItemAt: 7 }))).toMatchObject({ successors: [{ id: "z", slug: "s", title: "T" }], lastItemAt: null });
    mount();
    await header();
    expect(screen.queryByText(/不再更新|最近更新于|近期没有新动态/)).toBeNull();
  });

  it("opens a zone of the old kind on its own page — the zone, its cards, no editor of a topic's definition and no 「已不存在」", async () => {
    topic.fetchZone.mockRejectedValue(new NotTopicZoneError());
    old.fetchEvidenceZoneDetail.mockResolvedValue({ zone: {
      id: "ez_result", revision: 2, state: "published", kind: "user", visibility: "platform", canEdit: true, title: "我的研究结果", description: "我把几次分析的结论放在这里",
      background: null, experts: [], following: false, canFollow: true, canFeedback: true, canResearch: true, evidenceCount: 1, creator: "李研究", createdAt: "2026-10-01T08:00:00.000Z",
    }, feedback: [] });
    old.listZoneEvidence.mockResolvedValue({ items: [{ id: "c1", revision: 1, state: "published", canEdit: true, zoneId: "ez_result", title: "替尔泊肽的体重结局", summary: "三项研究合并后体重下降约 12%", claims: [], subtype: null, body: "", creator: null, reviewer: null, reviewedAt: null }], total: 1, nextCursor: null });
    const editor = vi.fn(() => <div role="dialog" aria-label="编辑专区" />);
    mount("/app/frontier/zones/ez_result", editor);
    expect(await screen.findByRole("heading", { level: 1, name: "我的研究结果" })).toBeInTheDocument();
    expect(screen.getByText("我把几次分析的结论放在这里")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /替尔泊肽的体重结局/ })).toHaveAttribute("href", "/app/frontier/zones/ez_result/evidence/c1");
    expect(screen.queryByText("这个专区已不存在")).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(topic.fetchZoneOverview).not.toHaveBeenCalled();
    expect(old.listZoneEvidence).toHaveBeenCalledWith("ez_result", "", null, "owned");
    expect(editor).not.toHaveBeenCalled();
  });

  it("leaves 以此新建我的专区 out of the ⋯ menu once the directory has said this reader may not make one", async () => {
    create.allowed = false;
    const editor = (props: ZoneEditorProps) => <div role="dialog" aria-label="新建专区">{props.mode}</div>;
    mount("/app/frontier/zones/zone-glp1", editor);
    await userEvent.click(within(await header()).getByRole("button", { name: "更多操作" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["深入研究", "复制链接"]);
  });

  it("makes the counts of the header links on the overview and plain figures on the other tabs, where the toolbar already holds the window", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=items");
    await screen.findByRole("region", { name: "专区动态" });
    const facts = screen.getByText(/截至 10月29日 14:20（北京时间）/).closest("p")!;
    expect(facts.textContent).toBe("内分泌·近 7 天 58·近 30 天 247·全部 610 条·截至 10月29日 14:20（北京时间）");
    expect(within(facts).queryAllByRole("link")).toHaveLength(0);
  });
});

describe("the address", () => {
  it("is read by the zone's id or by its readable name, the same page", async () => {
    mount("/app/frontier/zones/s/glp1-obesity");
    await header();
    expect(topic.fetchZone).toHaveBeenCalledWith("glp1-obesity");
    cleanup();
    mount("/app/frontier/zones/zone-glp1");
    await header();
    expect(topic.fetchZone).toHaveBeenLastCalledWith("zone-glp1");
  });

  it("holds the tab, and a tab that is not offered is the overview", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=cards");
    await header();
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "证据卡片" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "动态" }));
    expect(where()).toBe("/app/frontier/zones/zone-glp1?tab=items");
    expect(screen.getByRole("tab", { name: "动态" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "概览" }));
    expect(where()).toBe("/app/frontier/zones/zone-glp1");
  });

  it("says a zone that is gone, and that the module is off, in a sentence and a way on", async () => {
    topic.fetchZone.mockRejectedValue(new WebApiError("missing", { status: 404, code: "evidence_not_found" }));
    mount();
    expect(await screen.findByRole("heading", { level: 1, name: "这个专区已不存在" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看全部专区" })).toHaveAttribute("href", "/app/frontier?view=zones");
    cleanup();
    frontier.useFrontierFeature.mockReturnValue("off");
    mount();
    expect(await screen.findByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
  });

  it("says why the zone could not be read and reads again on 重试", async () => {
    topic.fetchZone.mockRejectedValueOnce(new WebApiError("boom", { status: 500 }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    await header();
    expect(topic.fetchZone).toHaveBeenCalledTimes(2);
  });
});

describe("the 动态 tab", () => {
  it("groups the zone's items under their Beijing day as the feed does, and opens an item's reader with the zone as the way back", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=items");
    const list = await screen.findByRole("region", { name: "专区动态" });
    const days = within(list).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(days[0]).toMatch(/^10月28日 周三/);
    expect(days[1]).toMatch(/^10月27日 周二/);
    const link = within(list).getByRole("link", { name: "司美格鲁肽心血管获益再确认" });
    expect(link).toHaveAttribute("href", "/app/frontier/items/a1");
    expect(topic.fetchZoneItems).toHaveBeenCalledWith("zone-glp1", { role: null, picked: false, window: "30d", q: "" });
    // The card's own ⋯, with the zone's entry among the first group.
    const menuButtons = within(list).getAllByRole("button", { name: "更多操作" });
    await userEvent.click(menuButtons[0]);
    const entries = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(entries).toContain("不属于这个专区");
    expect(entries.indexOf("不属于这个专区")).toBeLessThan(entries.indexOf("关注 丁香园"));
  });

  it("offers a chip for each kind of item the window holds, with its count — none for a kind with 0 — and asks the server for the one chosen", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=items");
    await screen.findByRole("region", { name: "专区动态" });
    const toolbar = screen.getByRole("group", { name: "专区动态筛选" });
    const kinds = within(toolbar).getByRole("group", { name: "类型" });
    expect(within(kinds).getAllByRole("button").map((button) => button.textContent)).toEqual(["全部17", "研究12", "指南共识3", "审批监管2"]);
    topic.fetchZoneItems.mockClear();
    await userEvent.click(within(kinds).getByRole("button", { name: /指南共识/ }));
    await waitFor(() => expect(topic.fetchZoneItems).toHaveBeenCalledWith("zone-glp1", { role: "guideline", picked: false, window: "30d", q: "" }));
    expect(where()).toBe("/app/frontier/zones/zone-glp1?tab=items&role=guideline");
  });

  it("filters by 精选, by window and by a search that commits after typing stops, each into the address", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=items");
    await screen.findByRole("region", { name: "专区动态" });
    const toolbar = screen.getByRole("group", { name: "专区动态筛选" });
    await userEvent.click(within(within(toolbar).getByRole("group", { name: "范围" })).getByRole("button", { name: "精选" }));
    await waitFor(() => expect(topic.fetchZoneItems).toHaveBeenLastCalledWith("zone-glp1", expect.objectContaining({ picked: true })));
    await userEvent.click(within(within(toolbar).getByRole("group", { name: "时间" })).getByRole("button", { name: "7 天" }));
    await waitFor(() => expect(topic.fetchZoneItems).toHaveBeenLastCalledWith("zone-glp1", expect.objectContaining({ picked: true, window: "7d" })));
    expect(where()).toBe("/app/frontier/zones/zone-glp1?tab=items&picked=1&window=7d");
    await userEvent.type(within(toolbar).getByRole("searchbox", { name: "搜索专区动态" }), "司美");
    await waitFor(() => expect(topic.fetchZoneItems).toHaveBeenLastCalledWith("zone-glp1", expect.objectContaining({ q: "司美" })));
    expect(where()).toContain("q=%E5%8F%B8%E7%BE%8E");
    // A search is not cut into days.
    expect(within(screen.getByRole("region", { name: "专区动态" })).getByRole("list", { name: "搜索结果" })).toBeInTheDocument();
  });

  it("reads the filters from the address, so a link to a narrowed list shows the same list", async () => {
    mount("/app/frontier/zones/zone-glp1?tab=items&role=approval&window=90d&picked=1&q=%E5%8F%B8%E7%BE%8E");
    await screen.findByRole("region", { name: "专区动态" });
    expect(topic.fetchZoneItems).toHaveBeenCalledWith("zone-glp1", { role: "approval", picked: true, window: "90d", q: "司美" });
    expect(screen.getByRole("searchbox", { name: "搜索专区动态" })).toHaveValue("司美");
  });

  it("reads on by the cursor, one page at a time, and shows each item once", async () => {
    topic.fetchZoneItems.mockResolvedValueOnce(page([rawItem("a1", "第一页")], { nextCursor: "c2" }));
    topic.fetchZoneItems.mockResolvedValueOnce(page([rawItem("a1", "第一页"), rawItem("a3", "第二页")]));
    mount("/app/frontier/zones/zone-glp1?tab=items");
    await userEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    expect(await screen.findByRole("link", { name: "第二页" })).toBeInTheDocument();
    expect(topic.fetchZoneItems).toHaveBeenLastCalledWith("zone-glp1", expect.objectContaining({ cursor: "c2" }));
    expect(screen.getAllByRole("link", { name: "第一页" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("opens on 30 days and looks further back, 90 days and then all of it, while the window the reader did not choose holds nothing", async () => {
    topic.fetchZoneItems.mockImplementation(async (_zone: string, query: { window?: string }) => (query.window === "all" ? page([rawItem("old", "去年的指南")]) : page([])));
    mount("/app/frontier/zones/zone-glp1?tab=items");
    expect(await screen.findByRole("link", { name: "去年的指南" })).toBeInTheDocument();
    expect(topic.fetchZoneItems.mock.calls.map((call) => (call[1] as { window: string }).window)).toEqual(["30d", "90d", "all"]);
    // A window the reader chose is not widened.
    cleanup();
    topic.fetchZoneItems.mockClear();
    mount("/app/frontier/zones/zone-glp1?tab=items&window=7d");
    expect(await screen.findByText("没有结果")).toBeInTheDocument();
    expect(topic.fetchZoneItems).toHaveBeenCalledTimes(1);
  });

  it("narrows to the week a bar of the chart stands for: the narrowest window that holds it, the list cut to the week, the mark that lets go of it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T08:00:00Z"));
    topic.fetchZoneItems.mockResolvedValue(page([
      rawItem("w1", "本周的一条", { timelineAt: "2026-10-28T06:30:00.000Z" }),
      rawItem("w0", "上周的一条", { timelineAt: "2026-10-22T06:30:00.000Z" }),
    ]));
    mount("/app/frontier/zones/zone-glp1?tab=items&week=2026-10-26&window=7d");
    expect(await screen.findByRole("link", { name: "本周的一条" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "上周的一条" })).toBeNull();
    expect(topic.fetchZoneItems).toHaveBeenCalledWith("zone-glp1", expect.objectContaining({ window: "7d" }));
    const mark = screen.getByRole("button", { name: /10月26日起一周/ });
    vi.useRealTimers();
    await userEvent.click(mark);
    expect(where()).not.toContain("week=");
  });

  it("hides a row at once on 不属于这个专区, sends the word after a while, and brings the row back on 撤销 without sending it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    topic.zoneItemFeedback.mockResolvedValue(undefined);
    mount("/app/frontier/zones/zone-glp1?tab=items");
    const list = await screen.findByRole("region", { name: "专区动态" });
    await userEvent.click(within(list).getAllByRole("button", { name: "更多操作" })[0]);
    await userEvent.click(screen.getByRole("menuitem", { name: "不属于这个专区" }));
    expect(screen.queryByRole("link", { name: "司美格鲁肽心血管获益再确认" })).toBeNull();
    expect(topic.zoneItemFeedback).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(NOT_IN_UNDO_MS + 100); });
    expect(topic.zoneItemFeedback).toHaveBeenCalledWith("zone-glp1", "a1", "not-in");
    // Taken back before it is sent.
    topic.zoneItemFeedback.mockClear();
    await userEvent.click(within(list).getAllByRole("button", { name: "更多操作" })[0]);
    await userEvent.click(screen.getByRole("menuitem", { name: "不属于这个专区" }));
    await userEvent.click((await screen.findAllByRole("button", { name: "撤销" })).at(-1)!);
    expect(await screen.findByRole("link", { name: "指南更新：肥胖症药物治疗" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(NOT_IN_UNDO_MS + 100); });
    expect(topic.zoneItemFeedback).not.toHaveBeenCalled();
  });

  it("sends the word of a row hidden as 不属于这个专区 when the reader leaves the page", async () => {
    topic.zoneItemFeedback.mockResolvedValue(undefined);
    const { unmount } = mount("/app/frontier/zones/zone-glp1?tab=items");
    const list = await screen.findByRole("region", { name: "专区动态" });
    await userEvent.click(within(list).getAllByRole("button", { name: "更多操作" })[0]);
    await userEvent.click(screen.getByRole("menuitem", { name: "不属于这个专区" }));
    unmount();
    expect(topic.zoneItemFeedback).toHaveBeenCalledWith("zone-glp1", "a1", "not-in");
  });

  it("says a zone with no items yet is being filled, a search with no match says so, and an error has 重试", async () => {
    topic.fetchZoneItems.mockResolvedValue(page([]));
    mount("/app/frontier/zones/zone-glp1?tab=items");
    expect(await screen.findByText("正在为这个专区搜集内容，通常几分钟内出现第一批")).toBeInTheDocument();
    cleanup();
    mount("/app/frontier/zones/zone-glp1?tab=items&q=%E5%8F%B8%E7%BE%8E");
    const none = (await screen.findByText("没有找到和“司美”相关的动态")).closest("[data-empty]") as HTMLElement;
    await userEvent.click(within(none).getByRole("button", { name: "清除搜索" }));
    await waitFor(() => expect(where()).toBe("/app/frontier/zones/zone-glp1?tab=items"));
    cleanup();
    topic.fetchZoneItems.mockRejectedValueOnce(new WebApiError("boom", { status: 500 }));
    topic.fetchZoneItems.mockResolvedValue(page([rawItem("a1", "司美格鲁肽心血管获益再确认")]));
    mount("/app/frontier/zones/zone-glp1?tab=items");
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "司美格鲁肽心血管获益再确认" })).toBeInTheDocument();
  });

  it("is composed by the page framework with one toolbar row in the band above the list", async () => {
    const { container } = mount("/app/frontier/zones/zone-glp1?tab=items");
    await screen.findByRole("region", { name: "专区动态" });
    expectComposed(container, { tablists: 1, toolbar: true });
  });
});

describe("the 证据卡片 tab", () => {
  it("lists the cards of the team's interface with the same blocks as the overview, and says nothing is there when the list comes back empty", async () => {
    topic.fetchZone.mockResolvedValue(zone({ cards: 2 }));
    topic.fetchZoneCards.mockResolvedValue([cardRecord(), cardRecord({ id: "card-2", title: "替尔泊肽与睡眠呼吸暂停" })].map((card) => card));
    mount("/app/frontier/zones/zone-glp1?tab=cards");
    const list = await screen.findByRole("list", { name: "证据卡片" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(topic.fetchZoneCards).toHaveBeenCalledWith("zone-glp1");
    cleanup();
    topic.fetchZoneCards.mockResolvedValue([]);
    mount("/app/frontier/zones/zone-glp1?tab=cards");
    expect(await screen.findByText("这个专区还没有证据卡片")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看专区动态" })).toHaveAttribute("href", "/app/frontier/zones/s/glp1-obesity?tab=items");
  });
});

it("reads a zone's detail through the client's own parser (the fixture is the contract's shape)", () => {
  expect(parseZoneDetail(rawZone())).toMatchObject({ id: "zone-glp1", slug: "glp1-obesity", counts: { week: 58, month: 247, all: 610 }, cards: 0 });
});
