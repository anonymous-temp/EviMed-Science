import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierStatus } from "@/lib/frontierClient";
import { WebApiError } from "@/lib/apiClient";
import { expectComposed } from "@/test/expectComposed";
import { topicDefinition, topicDirectory, topicPreview, topicZone } from "@/components/frontier/__fixtures__/zoneDirectory";
import { FrontierPage } from "./FrontierPage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierStatus: vi.fn(), listFrontierItems: vi.fn(), listFrontierFollows: vi.fn(),
  fetchFrontierHotBoard: vi.fn(), fetchFrontierForYou: vi.fn(), listFrontierDailies: vi.fn(), fetchFrontierDaily: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));
const topics = vi.hoisted(() => ({ fetchZoneDirectory: vi.fn(), followZoneSummary: vi.fn(), fetchZone: vi.fn(), draftZone: vi.fn(), previewZone: vi.fn(), createZone: vi.fn() }));
vi.mock("@/lib/evidenceTopicClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicClient")>()), ...topics }));

const status = (): FrontierStatus => ({
  enabled: true, audience: "all", plugin: { state: "ok", lastPullAt: null }, lastPublishedAt: null, lastDailyDay: null,
  sources: { total: 1, enabled: 1, healthy: 1, degraded: 0, unreadable: 0, drifted: 0, planned: 0 }, counts: { today: 0, selectedToday: 0 },
  personalization: "off", capabilities: { saveToLibrary: false, abstractZh: false, forYou: false, hot: false, daily: false },
  versions: { content: "1", hot: null, daily: null },
});

const glp1 = topicZone({ latest: { itemId: "i1", title: "司美格鲁肽心血管结局的新分析", at: "2026-10-28T08:00:00Z" }, cards: 2 });
const adc = topicZone({ id: "zone_adc", title: "ADC 治疗 HER2 低表达乳腺癌", group: "乳腺癌", specialties: [{ key: "oncology", label: "肿瘤" }], counts: { week: 12, month: 40, all: 90 }, slug: "adc-her2-low" });
const quiet = topicZone({ id: "zone_quiet", title: "沉寂的专区", group: "乳腺癌", specialties: [{ key: "oncology", label: "肿瘤" }], lifecycle: "quiet", latest: { itemId: "i9", title: "很久前的一条", at: "2026-09-02T08:00:00Z" } });
const mineOwn = topicZone({ id: "zone_own", title: "我关心的 SGLT2", kind: "user", published: false, following: true, creator: "我" });
const minePublished = topicZone({ id: "zone_pub", title: "我公开的专区", kind: "user", published: true, following: true });
const followed = topicZone({ id: "zone_f", title: "关注的平台专区", following: true });

function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
function ZoneStub() { const location = useLocation(); return <><pre data-testid="state">{JSON.stringify(location.state)}</pre><Where /></>; }
const where = () => screen.getByTestId("where").textContent ?? "";
function mount(path = "/app/frontier?view=zones") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/frontier" element={<><FrontierPage /><Where /></>} />
        <Route path="/app/frontier/zones/*" element={<ZoneStub />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierStatus.mockResolvedValue(status());
  client.listFrontierItems.mockResolvedValue({ items: [], nextCursor: null, version: "1", mode: "list", related: false, restarted: false });
  client.listFrontierFollows.mockResolvedValue([]);
  client.fetchFrontierHotBoard.mockResolvedValue(null);
  topics.fetchZoneDirectory.mockImplementation(async (view: "recommended" | "mine" | "community") =>
    topicDirectory(view, view === "recommended" ? [glp1, adc, quiet] : view === "mine" ? [mineOwn, minePublished, followed] : [followed], view === "mine" ? { userZones: { count: 2, max: 30 } } : {}));
});

describe("证据专区 opens in place", () => {
  it("is a tab of the feed page: the same band and tab row, the view first in that row, the specialty and the search, the address ?view=zones", async () => {
    mount("/app/frontier");
    await userEvent.click(await screen.findByRole("tab", { name: "证据专区" }));
    expect(where()).toBe("/app/frontier?view=zones");
    expect(await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" })).toHaveAttribute("href", "/app/frontier/zones/zone_glp1");
    const facts = expectComposed(document.body, { tablists: 1, stepRail: false, toolbar: true });
    expect(screen.getByRole("heading", { level: 1, name: "前沿动态" })).toBeInTheDocument();
    const row = facts.toolbars[0];
    expect(within(row).getByRole("tab", { name: "证据专区" })).toHaveAttribute("aria-selected", "true");
    // 推荐 · 我的 · 大家建的 first among the view's controls, 推荐 pressed.
    expect(within(row).getByRole("button", { name: "推荐" })).toHaveAttribute("aria-pressed", "true");
    expect(within(row).getByRole("button", { name: "我的" })).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByRole("button", { name: "大家建的" })).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByRole("button", { name: "专科" })).toHaveTextContent("全部专科");
    expect(within(row).getByRole("searchbox", { name: "搜索" })).toBeInTheDocument();
    expect(within(row).getByText("3 个专区")).toBeInTheDocument();
    // The feed is not read for the directory.
    expect(client.listFrontierItems.mock.calls.filter(([query]) => !query.safety)).toHaveLength(1);
  });

  it("lists 推荐 as specialty, then group, then zones: the week's count, the cards when there are any, the latest item, a star", async () => {
    mount();
    const endocrine = (await screen.findByRole("heading", { name: "内分泌" })).closest("section")!;
    expect(within(endocrine).getByRole("heading", { name: "肥胖" })).toBeInTheDocument();
    const row = within(endocrine).getByRole("link", { name: "GLP-1 受体激动剂减重" }).closest("li")!;
    expect(row).toHaveTextContent("近 7 天 37 条 · 卡片 2");
    expect(row).toHaveTextContent("最新：司美格鲁肽心血管结局的新分析");
    expect(within(row).getByRole("button", { name: "关注“GLP-1 受体激动剂减重”" })).toHaveAttribute("aria-pressed", "false");
    const oncology = screen.getByRole("heading", { name: "肿瘤" }).closest("section")!;
    expect(within(oncology).getByRole("heading", { name: "乳腺癌" })).toBeInTheDocument();
    // A zone with a slug opens by it; no cards, no 「卡片」.
    const adcRow = within(oncology).getByRole("link", { name: "ADC 治疗 HER2 低表达乳腺癌" });
    expect(adcRow).toHaveAttribute("href", "/app/frontier/zones/s/adc-her2-low");
    expect(adcRow.closest("li")).toHaveTextContent("近 7 天 12 条");
    expect(adcRow.closest("li")).not.toHaveTextContent("卡片");
    // A quiet zone says when it last moved instead of a week's count.
    const quietRow = within(oncology).getByRole("link", { name: "沉寂的专区" }).closest("li")!;
    expect(quietRow).toHaveTextContent("最近更新于 9月2日");
    expect(quietRow).not.toHaveTextContent("近 7 天");
  });

  it("switches view in the toolbar, keeps it in the address, and reads the other list", async () => {
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    await userEvent.click(screen.getByRole("button", { name: "我的" }));
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenLastCalledWith("mine", { specialty: null, q: "" }));
    expect(where()).toBe("/app/frontier?view=zones&scope=mine");
    await screen.findByRole("link", { name: "我关心的 SGLT2" });
    await userEvent.click(screen.getByRole("button", { name: "大家建的" }));
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenLastCalledWith("community", { specialty: null, q: "" }));
    expect(where()).toBe("/app/frontier?view=zones&scope=community");
    await userEvent.click(screen.getByRole("button", { name: "推荐" }));
    expect(where()).toBe("/app/frontier?view=zones");
    // Another view lets go of the zones' view.
    await userEvent.click(screen.getByRole("button", { name: "我的" }));
    await userEvent.click(screen.getByRole("tab", { name: "全部" }));
    expect(where()).toBe("/app/frontier?view=all");
  });

  it("lists 我的 with the reader's own zones first, saying who can see them and with no star, then the zones they follow", async () => {
    mount("/app/frontier?view=zones&scope=mine");
    const list = await screen.findByRole("list", { name: "我的专区" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual(["我关心的 SGLT2", "我公开的专区", "关注的平台专区"]);
    expect(rows[0]).toHaveTextContent("仅自己可见");
    expect(rows[1]).toHaveTextContent("已公开");
    expect(rows[2]).not.toHaveTextContent("仅自己可见");
    expect(rows[2]).not.toHaveTextContent("已公开");
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "取消关注“关注的平台专区”" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("已建 2 / 30 个")).toBeInTheDocument();
  });

  it("takes the server's word on which zones are the reader's own, where it gives one", async () => {
    topics.fetchZoneDirectory.mockResolvedValue(topicDirectory("mine", [followed, { ...mineOwn, owned: true }], { userZones: { count: 0, max: 30 } }));
    mount("/app/frontier?view=zones&scope=mine");
    const list = await screen.findByRole("list", { name: "我的专区" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first!).getByRole("button")).toBeInTheDocument();
    expect(within(second!).queryByRole("button")).not.toBeInTheDocument();
    expect(second).toHaveTextContent("仅自己可见");
  });

  it("names the creator in 大家建的 and reads an older link's scope as 我的", async () => {
    mount("/app/frontier?view=zones&scope=community");
    topics.fetchZoneDirectory.mockImplementation(async () => topicDirectory("community", [{ ...topicZone({ id: "z_c", title: "别人建的专区", kind: "user", creator: "李研究" }), followers: 12 }]));
    await userEvent.click(screen.getByRole("button", { name: "推荐" }));
    await userEvent.click(screen.getByRole("button", { name: "大家建的" }));
    expect((await screen.findByRole("link", { name: "别人建的专区" })).closest("li")).toHaveTextContent("李研究 创建 · 12 人关注");
    for (const scope of ["owned", "following"]) {
      topics.fetchZoneDirectory.mockClear();
      mount(`/app/frontier?view=zones&scope=${scope}`);
      await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenCalledWith("mine", { specialty: null, q: "" }));
    }
  });

  it("narrows by specialty in the toolbar, in its own address word so the feed's 专科 stays where it is", async () => {
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    await userEvent.click(screen.getByRole("button", { name: "专科" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "肿瘤" }));
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenLastCalledWith("recommended", { specialty: "oncology", q: "" }));
    expect(where()).toBe("/app/frontier?view=zones&zoneSpecialty=oncology");
  });

  it("searches the zones as the reader types and stays in 证据专区, counting what is listed", async () => {
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [adc]));
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "ADC");
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenLastCalledWith("recommended", { specialty: null, q: "ADC" }));
    expect(where()).toBe("/app/frontier?view=zones&q=ADC");
    expect(await screen.findByText("1 个专区")).toBeInTheDocument();
    // The feed's search is not run for it.
    expect(client.listFrontierItems.mock.calls.some(([query]) => query.q)).toBe(false);
  });

  it("follows in place from the star, with the zone read first where the row carries no revision", async () => {
    topics.followZoneSummary.mockResolvedValue({ ...glp1, following: true, revision: 8, definition: null, canEdit: false, canDelete: false, band: null, overviewAt: null, related: [] });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "关注“GLP-1 受体激动剂减重”" }));
    expect(topics.followZoneSummary).toHaveBeenCalledWith(expect.objectContaining({ id: "zone_glp1" }), true);
    expect(await screen.findByRole("button", { name: "取消关注“GLP-1 受体激动剂减重”" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers 「新建专区」 as the page's action, in its header, to a reader who may make one, and opens the editor", async () => {
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    // The page's one primary is the header's, at every width (the toolbar is under the title on a phone).
    expect(within(document.querySelector("[data-toolbar]") as HTMLElement).queryByRole("button", { name: "新建专区" })).toBeNull();
    await userEvent.click(within(document.querySelector("[data-page-header]") as HTMLElement).getByRole("button", { name: "新建专区" }));
    const drawer = await screen.findByRole("dialog", { name: "新建专区" });
    expect(within(drawer).getByRole("textbox", { name: "想持续看什么？" })).toBeInTheDocument();
  });

  it("offers no 「新建专区」 to a reader who may not make one", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [glp1], { canCreate: false }));
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    expect(within(document.querySelector("[data-page-header]") as HTMLElement).queryByRole("button", { name: "新建专区" })).toBeNull();
  });

  it("ends a search for a group's name with 「新建专区：…」, which opens the editor with the name in it", async () => {
    mount("/app/frontier?view=zones&q=%E4%B9%B3%E8%85%BA%E7%99%8C");
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [adc, quiet]));
    const button = await screen.findByRole("button", { name: "新建专区：乳腺癌 + …" });
    await userEvent.click(button);
    const drawer = await screen.findByRole("dialog", { name: "新建专区" });
    expect(within(drawer).getByRole("textbox", { name: "想持续看什么？" })).toHaveValue("乳腺癌");
    expect(topics.draftZone).not.toHaveBeenCalled();
  });

  it("opens the editor on a card's 「以此新建专区」 (?new=1&fromItem=), drafts from that item, and lets the address go of it", async () => {
    topics.draftZone.mockResolvedValue({ draft: { title: "来自这条动态", definition: topicDefinition }, readings: [], suggestions: { narrower: [], broader: [] }, preview: topicPreview(), similar: [] });
    mount("/app/frontier?view=zones&new=1&fromItem=item-7");
    const drawer = await screen.findByRole("dialog", { name: "新建专区" });
    expect(await within(drawer).findByRole("textbox", { name: "名称" })).toHaveValue("来自这条动态");
    expect(topics.draftZone).toHaveBeenCalledWith({ text: "", baseZoneId: null, fromItemId: "item-7" });
    await waitFor(() => expect(where()).toBe("/app/frontier?view=zones"));
  });

  it("opens the zone a reader made, handing the page the way back to the view as it stood", async () => {
    topics.draftZone.mockResolvedValue({ draft: { title: "我的新专区", definition: topicDefinition }, readings: [], suggestions: { narrower: [], broader: [] }, preview: topicPreview({ borderline: [] }), similar: [] });
    topics.createZone.mockResolvedValue({ ...glp1, id: "zone_new", title: "我的新专区", revision: 1, definition: topicDefinition, canEdit: true, canDelete: true, band: "normal", overviewAt: null, related: [] });
    mount("/app/frontier?view=zones&scope=mine");
    await screen.findByRole("link", { name: "我关心的 SGLT2" });
    await userEvent.click(within(document.querySelector("[data-page-header]") as HTMLElement).getByRole("button", { name: "新建专区" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "想持续看什么？" }), "SGLT2 抑制剂心肾保护");
    await userEvent.click(screen.getByRole("button", { name: "生成" }));
    await userEvent.click(await screen.findByRole("button", { name: "建立" }));
    await waitFor(() => expect(where()).toBe("/app/frontier/zones/zone_new"));
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toMatchObject({ evidenceFrom: { to: "/app/frontier?view=zones&scope=mine", label: "证据专区" } });
  });

  it("shows a retryable failure without pretending it is empty", async () => {
    topics.fetchZoneDirectory.mockRejectedValueOnce(new WebApiError("unavailable", { status: 502 }));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" })).toBeInTheDocument();
    expect(screen.queryByText("暂无证据专区")).not.toBeInTheDocument();
  });

  it("says what 我的 can do when it is empty: one sentence and the button", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "mine") => topicDirectory(view, []));
    mount("/app/frontier?view=zones&scope=mine");
    expect(await screen.findByText("还没有自己的专区。用一句话说出想持续看什么，就能建一个。")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "新建专区" }).find((button) => !button.closest("[data-page-header]"))!);
    expect(await screen.findByRole("dialog", { name: "新建专区" })).toBeInTheDocument();
  });

  it("says no match for a search, clears it from the button, and drafts the words at once from 「以此新建专区」", async () => {
    topics.draftZone.mockResolvedValue({ draft: { title: "长新冠", definition: topicDefinition }, readings: [], suggestions: { narrower: [], broader: [] }, preview: topicPreview({ borderline: [] }), similar: [] });
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, []));
    mount(`/app/frontier?view=zones&q=${encodeURIComponent("长新冠")}`);
    expect(await screen.findByText("没有找到匹配的专区")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "以此新建专区" }));
    expect(await screen.findByRole("textbox", { name: "名称" })).toHaveValue("长新冠");
    expect(topics.draftZone).toHaveBeenCalledWith({ text: "长新冠", baseZoneId: null, fromItemId: null });
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    // The empty list's own button (the search box has a 「清除搜索」 of its own, in the band).
    const clear = screen.getAllByRole("button", { name: "清除搜索" }).find((button) => !button.closest("[data-toolbar]"));
    await userEvent.click(clear!);
    await waitFor(() => expect(where()).toBe("/app/frontier?view=zones"));
  });

  it("has no 「申请选题」 any more: the reader makes the zone", async () => {
    mount();
    await screen.findByRole("link", { name: "GLP-1 受体激动剂减重" });
    expect(screen.queryByRole("button", { name: "申请选题" })).not.toBeInTheDocument();
  });
});

describe("a zone opened from the view", () => {
  it("is opened with the view as it was left — its view and its search — for its way back", async () => {
    mount("/app/frontier?view=zones&scope=mine");
    await userEvent.click(await screen.findByRole("link", { name: "我关心的 SGLT2" }));
    expect(where()).toBe("/app/frontier/zones/zone_own");
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual({ evidenceFrom: { to: "/app/frontier?view=zones&scope=mine", label: "证据专区" } });
  });
});

describe("the leads from the feed to the zones its words belong to", () => {
  const sibling = (n: number) => topicZone({ id: `zone_glp1_${n}`, title: `GLP-1 专题 ${n}` });

  it("puts one line over a search's results naming the zones the words belong to, two at most, each a link", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [glp1, sibling(1), sibling(2), adc]));
    mount("/app/frontier?view=all&q=GLP-1");
    const line = (await screen.findByText("专区：")).closest("[data-note]") as HTMLElement;
    expect(topics.fetchZoneDirectory).toHaveBeenCalledWith("recommended", { q: "GLP-1" });
    expect(within(line).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["GLP-1 受体激动剂减重 ›", "/app/frontier/zones/zone_glp1"], ["GLP-1 专题 1 ›", "/app/frontier/zones/zone_glp1_1"],
    ]);
    // It sits over the results, not in the band.
    expect(document.querySelector("[data-toolbar]")).not.toContainElement(line);
  });

  it("offers 「以此新建专区」 when the words name no zone, drafts those words at once, and not for a single character", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [adc]));
    topics.draftZone.mockResolvedValue({ draft: { title: "长新冠", definition: topicDefinition }, readings: [], suggestions: { narrower: [], broader: [] }, preview: topicPreview({ borderline: [] }), similar: [] });
    const { unmount } = mount(`/app/frontier?view=all&q=${encodeURIComponent("长新冠")}`);
    await userEvent.click(await screen.findByRole("button", { name: "以此新建专区" }));
    const drawer = await screen.findByRole("dialog", { name: "新建专区" });
    expect(await within(drawer).findByRole("textbox", { name: "名称" })).toHaveValue("长新冠");
    expect(topics.draftZone).toHaveBeenCalledWith({ text: "长新冠", baseZoneId: null, fromItemId: null });
    unmount();
    mount(`/app/frontier?view=all&q=${encodeURIComponent("癌")}`);
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenLastCalledWith("recommended", { q: "癌" }));
    expect(screen.queryByRole("button", { name: "以此新建专区" })).not.toBeInTheDocument();
  });

  it("says nothing where the zones cannot be read: the results stand alone", async () => {
    topics.fetchZoneDirectory.mockRejectedValue(new WebApiError("down", { status: 502 }));
    mount("/app/frontier?view=all&q=GLP-1");
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenCalled());
    expect(screen.queryByText("专区：")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "以此新建专区" })).not.toBeInTheDocument();
  });

  it("leads from a chosen tag to the zones it is in and to the directory searched for it", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, [glp1, adc]));
    mount("/app/frontier?view=all&tag=semaglutide");
    const line = (await screen.findByText("含“semaglutide”的专区：")).closest("[data-note]") as HTMLElement;
    expect(within(line).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["GLP-1 受体激动剂减重 ›", "/app/frontier/zones/zone_glp1"], ["ADC 治疗 HER2 低表达乳腺癌 ›", "/app/frontier/zones/s/adc-her2-low"], ["全部专区 ›", "/app/frontier?view=zones&q=semaglutide"],
    ]);
  });

  it("draws no line for a tag that is in no zone", async () => {
    topics.fetchZoneDirectory.mockImplementation(async (view: "recommended") => topicDirectory(view, []));
    mount("/app/frontier?view=all&tag=semaglutide");
    await waitFor(() => expect(topics.fetchZoneDirectory).toHaveBeenCalled());
    expect(screen.queryByText(/的专区：/)).not.toBeInTheDocument();
  });
});
