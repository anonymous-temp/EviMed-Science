import { cleanup, render, screen, within } from "@testing-library/react";
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
  it("honors following directory scope from its address", async () => { client.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null }); render(<MemoryRouter initialEntries={["/app/frontier/zones?scope=following"]}><EvidenceZonesPage /></MemoryRouter>); await screen.findByText("暂无证据专区"); expect(client.listEvidenceZones).toHaveBeenCalledWith("", null, "following"); expect(screen.getByRole("button", { name: "我关注的" })).toHaveAttribute("aria-pressed", "true"); });
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
    await userEvent.type(screen.getByRole("textbox", { name: "搜索证据专区" }), "急诊"); await userEvent.click(screen.getByRole("button", { name: "搜索" }));
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
