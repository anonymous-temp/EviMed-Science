import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceZonesPage } from "./EvidenceZonesPage";
const client = vi.hoisted(() => ({ listEvidenceZones: vi.fn(), followEvidenceZone: vi.fn() }));
vi.mock("@/lib/evidenceZoneClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/evidenceZoneClient")>()), ...client }));
const zone = { id: "zone-one", revision: 1, title: "急诊医学", description: "急诊证据", evidenceCount: 3, following: false, canFollow: true };
const mount = () => render(<MemoryRouter><EvidenceZonesPage /></MemoryRouter>);
beforeEach(() => vi.clearAllMocks());
describe("evidence zone directory", () => {
  it("honors following directory scope from its address", async () => { client.listEvidenceZones.mockResolvedValue({ items: [], nextCursor: null }); render(<MemoryRouter initialEntries={["/app/frontier/zones?scope=following"]}><EvidenceZonesPage /></MemoryRouter>); await screen.findByText("暂无证据专区"); expect(client.listEvidenceZones).toHaveBeenCalledWith("", null, "following"); expect(screen.getByRole("button", { name: "我关注的" })).toHaveAttribute("aria-pressed", "true"); });
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
});
