import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrontierStatus } from "@/lib/frontierClient";
import { expectComposed } from "@/test/expectComposed";
import { zone as zoneRecord } from "@/components/frontier/__fixtures__/evidenceCards";
import { FrontierPage } from "./FrontierPage";
import { EvidenceZonePage } from "./EvidenceZonePage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierStatus: vi.fn(), listFrontierItems: vi.fn(), listFrontierFollows: vi.fn(),
  fetchFrontierHotBoard: vi.fn(), fetchFrontierForYou: vi.fn(), listFrontierDailies: vi.fn(), fetchFrontierDaily: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));
const zones = vi.hoisted(() => ({
  listEvidenceZones: vi.fn(), followEvidenceZone: vi.fn(), listFollowedEvidence: vi.fn(),
  fetchEvidenceZoneDetail: vi.fn(), listZoneEvidence: vi.fn(),
}));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...zones }));
const features = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn() }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...features }));
const topics = vi.hoisted(() => ({ listTopicRequests: vi.fn() }));
vi.mock("@/lib/evidenceTopicRequestClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicRequestClient")>()), ...topics }));

const zone = { id: "zone-one", revision: 1, title: "急诊医学", description: "急诊证据", evidenceCount: 3, following: false, canFollow: true };
const status = (): FrontierStatus => ({
  enabled: true, audience: "all", plugin: { state: "ok", lastPullAt: null }, lastPublishedAt: null, lastDailyDay: null,
  sources: { total: 1, enabled: 1, healthy: 1, degraded: 0, unreadable: 0, drifted: 0, planned: 0 }, counts: { today: 0, selectedToday: 0 },
  personalization: "off", capabilities: { saveToLibrary: false, abstractZh: false, forYou: false, hot: false, daily: false },
  versions: { content: "1", hot: null, daily: null },
});

function Where() { const location = useLocation(); return <pre data-testid="where">{location.pathname + location.search}</pre>; }
const where = () => screen.getByTestId("where").textContent ?? "";
function mount(path = "/app/frontier?view=zones") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/frontier" element={<><FrontierPage /><Where /></>} />
        <Route path="/app/frontier/zones/:zoneId" element={<><EvidenceZonePage /><Where /></>} />
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
  features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
  topics.listTopicRequests.mockResolvedValue({ items: [], seconded: [], remainingToday: 5 });
  zones.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null });
});

describe("证据专区 opens in place", () => {
  it("is a tab of the feed page: the same band and tab row, the scope and the search in that row, the address ?view=zones", async () => {
    mount("/app/frontier");
    await userEvent.click(await screen.findByRole("tab", { name: "证据专区" }));
    expect(where()).toBe("/app/frontier?view=zones");
    expect(await screen.findByRole("link", { name: "急诊医学" })).toHaveAttribute("href", "/app/frontier/zones/zone-one");
    const facts = expectComposed(document.body, { tablists: 1, stepRail: false, toolbar: true });
    expect(screen.getByRole("heading", { level: 1, name: "前沿动态" })).toBeInTheDocument();
    expect(within(facts.toolbars[0]).getByRole("tab", { name: "证据专区" })).toHaveAttribute("aria-selected", "true");
    const scope = within(facts.toolbars[0]).getByRole("group", { name: "专区范围" });
    expect(within(scope).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["全部专区", "我创建的", "我关注的"]);
    expect(within(scope).getByRole("button", { name: "全部专区" })).toHaveAttribute("aria-pressed", "true");
    expect(within(facts.toolbars[0]).getByRole("searchbox", { name: "搜索" })).toBeInTheDocument();
    // The feed is not read for the directory.
    expect(client.listFrontierItems.mock.calls.filter(([query]) => !query.safety)).toHaveLength(1);
  });

  it("switches scope in the toolbar, keeps it in the address and reads the other list", async () => {
    mount();
    await screen.findByRole("link", { name: "急诊医学" });
    await userEvent.click(within(screen.getByRole("group", { name: "专区范围" })).getByRole("button", { name: "我创建的" }));
    await waitFor(() => expect(zones.listEvidenceZones).toHaveBeenLastCalledWith("", null, "owned"));
    expect(where()).toBe("/app/frontier?view=zones&scope=owned");
    // Another view lets go of the zones' scope.
    await userEvent.click(screen.getByRole("tab", { name: "全部" }));
    expect(where()).toBe("/app/frontier?view=all");
  });

  it("honours the scope its address names", async () => {
    zones.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null });
    mount("/app/frontier?view=zones&scope=following");
    await screen.findByText("暂无证据专区");
    expect(zones.listEvidenceZones).toHaveBeenCalledWith("", null, "following");
    // Out of the reader's followed zones the way on is every zone.
    await userEvent.click(screen.getByRole("button", { name: "看全部专区" }));
    await waitFor(() => expect(zones.listEvidenceZones).toHaveBeenLastCalledWith("", null, undefined));
    expect(where()).toBe("/app/frontier?view=zones");
  });

  it("searches the zones as the reader types and stays in 证据专区, counting the matches only while a search is on", async () => {
    zones.listEvidenceZones.mockResolvedValue({ items: [zone], total: 6, nextCursor: null });
    mount();
    await screen.findByRole("link", { name: "急诊医学" });
    expect(screen.queryByText(/个匹配专区/)).not.toBeInTheDocument();
    zones.listEvidenceZones.mockResolvedValue({ items: [zone], total: 1, nextCursor: null });
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "急诊");
    await waitFor(() => expect(zones.listEvidenceZones).toHaveBeenLastCalledWith("急诊", null, undefined));
    expect(where()).toBe(`/app/frontier?view=zones&q=${encodeURIComponent("急诊")}`);
    expect(await screen.findByText("1 个匹配专区")).toBeInTheDocument();
    // The feed's search is not run for it.
    expect(client.listFrontierItems.mock.calls.some(([query]) => query.q)).toBe(false);
  });

  it("follows in place and reads the next page with the same search", async () => {
    zones.listEvidenceZones.mockResolvedValueOnce({ items: [zone], nextCursor: "next" }).mockResolvedValueOnce({ items: [{ ...zone, id: "two", title: "急诊药学" }], nextCursor: null });
    zones.followEvidenceZone.mockResolvedValue({ ...zone, following: true });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "关注" }));
    expect(await screen.findByRole("button", { name: "取消关注" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示更多" }));
    expect(await screen.findByRole("link", { name: "急诊药学" })).toBeInTheDocument();
    expect(zones.listEvidenceZones).toHaveBeenLastCalledWith("", "next", undefined);
  });

  it("offers 「新建专区」 in the toolbar to a reader who may make one", async () => {
    zones.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null, canCreate: true });
    mount();
    await screen.findByRole("link", { name: "急诊医学" });
    expect(within(document.querySelector("[data-page-header]") as HTMLElement).queryAllByRole("button")).toEqual([]);
    await userEvent.click(within(document.querySelector("[data-toolbar]") as HTMLElement).getByRole("button", { name: "新建专区" }));
    expect(await screen.findByRole("textbox", { name: "专区名称" })).toBeInTheDocument();
  });

  it("groups the zones by kind, official first, and names a group only where there is more than one", async () => {
    zones.listEvidenceZones.mockResolvedValue({ items: [
      { ...zone, id: "u1", title: "我的专区", kind: "user" },
      { ...zone, id: "o1", title: "房颤抗凝", kind: "official" },
      { ...zone, id: "legacy", title: "旧专区" },
    ], nextCursor: null });
    mount();
    const official = await screen.findByRole("region", { name: "官方专区" });
    const users = screen.getByRole("region", { name: "用户专区" });
    expect(Array.from(users.querySelectorAll("li")).map((row) => row.textContent)).toEqual([expect.stringContaining("我的专区"), expect.stringContaining("旧专区")]);
    expect(official.compareDocumentPosition(users) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "官方专区" })).toBeInTheDocument();
  });

  it("shows a retryable failure without pretending it is empty", async () => {
    zones.listEvidenceZones.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ items: [zone], nextCursor: null });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "急诊医学" })).toBeInTheDocument();
    expect(screen.queryByText("暂无证据专区")).not.toBeInTheDocument();
  });

  it("opens 「申请选题」 with the topic a link names, once, where the public pages are on — and not where they are off", async () => {
    features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount(`/app/frontier?view=zones&request=${encodeURIComponent("乳腺癌")}`);
    const drawer = await screen.findByRole("dialog", { name: "申请选题" });
    expect(within(drawer).getByRole("textbox", { name: "选题" })).toHaveValue("乳腺癌");
    // The address lets go of it: reloading does not open it again.
    await waitFor(() => expect(where()).toBe("/app/frontier?view=zones"));
    cleanup();
    features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
    mount(`/app/frontier?view=zones&request=${encodeURIComponent("乳腺癌")}`);
    await screen.findByRole("link", { name: "急诊医学" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(topics.listTopicRequests).toHaveBeenCalledTimes(1);
  });
});

describe("a zone opened from the view", () => {
  it("goes back to the view as the reader left it — its scope and its search — by the history entry it came from", async () => {
    zones.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...zoneRecord, ...zone, kind: "official" }, feedback: [] });
    zones.listZoneEvidence.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    mount("/app/frontier?view=zones&scope=following");
    await userEvent.click(await screen.findByRole("link", { name: "急诊医学" }));
    expect(where()).toBe("/app/frontier/zones/zone-one");
    const back = within(await screen.findByRole("navigation", { name: "返回" })).getByRole("link", { name: "证据专区" });
    expect(back).toHaveAttribute("href", "/app/frontier?view=zones&scope=following");
    await userEvent.click(back);
    expect(where()).toBe("/app/frontier?view=zones&scope=following");
    expect(await screen.findByRole("link", { name: "急诊医学" })).toBeInTheDocument();
  });

  it("goes up to the view by its trail when it was opened from anywhere else", async () => {
    zones.fetchEvidenceZoneDetail.mockResolvedValue({ zone: { ...zoneRecord, ...zone, kind: "official" }, feedback: [] });
    zones.listZoneEvidence.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    mount("/app/frontier/zones/zone-one");
    const nav = await screen.findByRole("navigation", { name: "返回" });
    expect(within(nav).getByRole("link", { name: "证据专区" })).toHaveAttribute("href", "/app/frontier?view=zones");
    expect(within(nav).getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
  });
});
