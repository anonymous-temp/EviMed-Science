import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceZonesPage } from "./EvidenceZonesPage";
const client = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), followEvidenceZone: vi.fn() }));
const features = vi.hoisted(() => ({ fetchEvidenceFeatures: vi.fn() }));
const topics = vi.hoisted(() => ({ listTopicRequests: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
vi.mock("@/lib/evidenceUpkeepClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceUpkeepClient")>()), ...features }));
vi.mock("@/lib/evidenceTopicRequestClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceTopicRequestClient")>()), ...topics }));
const zone = { id: "zone-one", revision: 1, title: "急诊医学", description: "急诊证据", evidenceCount: 3, following: false, canFollow: true };
const mount = () => render(<MemoryRouter><EvidenceZonesPage /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: false, upkeep: false });
  topics.listTopicRequests.mockResolvedValue({ items: [], seconded: [], remainingToday: 5 });
});
describe("evidence zone directory", () => {
  it("is headed by the way back to 前沿动态, then one row: the three scopes as tabs and the search box at its right", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null });
    mount();
    await screen.findByRole("link", { name: "急诊医学" });
    expect(screen.getByRole("heading", { level: 1, name: "证据专区" })).toBeInTheDocument();
    const back = within(screen.getByRole("navigation", { name: "返回" })).getByRole("link", { name: "前沿动态" });
    expect(back).toHaveAttribute("href", "/app/frontier");
    // No navigation row of the feed's own views, and no pill row for the scope.
    expect(screen.queryByRole("navigation", { name: "前沿动态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "专区范围" })).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "专区范围" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["全部专区", "我创建的", "我关注的"]);
    expect(within(tabs).getByRole("tab", { name: "全部专区" })).toHaveAttribute("aria-selected", "true");
    expect(tabs.parentElement).toContainElement(screen.getByRole("searchbox", { name: "搜索" }));
  });
  it("switches scope through the tabs, keeps it in the address and reads the other list", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null });
    mount();
    await screen.findByText("暂无证据专区");
    await userEvent.click(screen.getByRole("tab", { name: "我创建的" }));
    await waitFor(() => expect(client.listEvidenceZones).toHaveBeenLastCalledWith("", null, "owned"));
    expect(screen.getByRole("tab", { name: "我创建的" })).toHaveAttribute("aria-selected", "true");
  });
  it("searches as the reader types, without a button, and not in the middle of a composition", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null });
    mount();
    await screen.findByText("暂无证据专区");
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "房颤");
    await waitFor(() => expect(client.listEvidenceZones).toHaveBeenLastCalledWith("房颤", null, undefined));
  });
  it("offers only the reader's own zones while one is chosen for a feed item", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null });
    render(<MemoryRouter initialEntries={["/app/frontier/zones?fromItem=item-1"]}><EvidenceZonesPage /></MemoryRouter>);
    await screen.findByRole("link", { name: "急诊医学" });
    expect(screen.getByText("选择证据专区")).toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "专区范围" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["我创建的"]);
    expect(client.listEvidenceZones).toHaveBeenCalledWith("", null, "owned");
  });
  it("honors following directory scope from its address", async () => { client.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null }); render(<MemoryRouter initialEntries={["/app/frontier/zones?scope=following"]}><EvidenceZonesPage /></MemoryRouter>); await screen.findByText("暂无证据专区"); expect(client.listEvidenceZones).toHaveBeenCalledWith("", null, "following"); expect(screen.getByRole("tab", { name: "我关注的" })).toHaveAttribute("aria-selected", "true"); });
  it("groups the zones in three plain sections by kind, an older zone without a kind among the users' and an empty kind not drawn", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [
      { ...zone, id: "u1", title: "我的专区", kind: "user" },
      { ...zone, id: "o1", title: "房颤抗凝", kind: "official" },
      { ...zone, id: "legacy", title: "旧专区" },
      { ...zone, id: "o2", title: "研究解读", kind: "official" },
    ], nextCursor: null });
    mount();
    const official = await screen.findByRole("region", { name: "官方专区" });
    expect(Array.from(official.querySelectorAll("li")).map((row) => row.textContent)).toEqual([expect.stringContaining("房颤抗凝"), expect.stringContaining("研究解读")]);
    const users = screen.getByRole("region", { name: "用户专区" });
    expect(Array.from(users.querySelectorAll("li")).map((row) => row.textContent)).toEqual([expect.stringContaining("我的专区"), expect.stringContaining("旧专区")]);
    expect(screen.queryByRole("region", { name: "产品专区" })).not.toBeInTheDocument();
    // Official first, as the plan reads: 官方 / 产品 / 用户.
    expect(official.compareDocumentPosition(users) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("shows a retryable failure without pretending it is empty", async () => {
    client.listEvidenceZones.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ items: [zone], nextCursor: null });
    mount(); await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "急诊医学" })).toHaveAttribute("href", "/app/frontier/zones/zone-one");
    expect(screen.queryByText("暂无证据专区")).not.toBeInTheDocument();
  });
  it("searches and paginates with the same query and confirms follow from server", async () => {
    client.listEvidenceZones.mockResolvedValueOnce({ items: [], nextCursor: null }).mockResolvedValueOnce({ items: [zone], nextCursor: "next" }).mockResolvedValueOnce({ items: [{ ...zone, id: "two", title: "急诊药学" }], nextCursor: null });
    client.followEvidenceZone.mockResolvedValue({ ...zone, following: true }); mount();
    expect(await screen.findByText("暂无证据专区")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索" }), "急诊{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "关注" })); expect(await screen.findByRole("button", { name: "取消关注" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多" })); expect(await screen.findByRole("link", { name: "急诊药学" })).toBeInTheDocument();
    expect(client.listEvidenceZones).toHaveBeenLastCalledWith("急诊", "next", undefined);
  });
  it("offers 「申请选题」 under the list only where the public pages are on, with the official zones in view to choose from", async () => {
    client.listEvidenceZones.mockResolvedValue({ items: [
      { ...zone, id: "o1", title: "房颤抗凝", kind: "official", state: "published" },
      { ...zone, id: "o2", title: "还没发布", kind: "official", state: "draft" },
      { ...zone, id: "u1", title: "我的专区", kind: "user", state: "published" },
    ], nextCursor: null });
    mount();
    await screen.findByRole("link", { name: "房颤抗凝" });
    expect(screen.queryByRole("region", { name: "申请选题" })).not.toBeInTheDocument();
    expect(topics.listTopicRequests).not.toHaveBeenCalled();
    cleanup();
    features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    mount();
    const block = await screen.findByRole("region", { name: "申请选题" });
    expect(within(block).getByRole("combobox", { name: "关联专区（可选）" })).toHaveTextContent("房颤抗凝");
    expect(within(block).getByRole("combobox", { name: "关联专区（可选）" })).not.toHaveTextContent("还没发布");
    expect(within(block).getByRole("combobox", { name: "关联专区（可选）" })).not.toHaveTextContent("我的专区");
  });
  it("does not offer it while a zone is being chosen for a feed item", async () => {
    features.fetchEvidenceFeatures.mockResolvedValue({ publicPages: true, upkeep: false });
    client.listEvidenceZones.mockResolvedValue({ items: [zone], nextCursor: null });
    render(<MemoryRouter initialEntries={["/app/frontier/zones?fromItem=item-1"]}><EvidenceZonesPage /></MemoryRouter>);
    await screen.findByRole("link", { name: "急诊医学" });
    expect(screen.queryByRole("region", { name: "申请选题" })).not.toBeInTheDocument();
  });
});
