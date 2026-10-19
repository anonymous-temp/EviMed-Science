import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierArticlePage } from "./FrontierArticlePage";
const client = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn() }));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));
beforeEach(() => {
  vi.resetAllMocks();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItem({ id: "item-1" }), abstract: "Original abstract", abstractZh: "已保存的中文摘要" });
  client.markFrontierItemRead.mockResolvedValue({});
});
function show() {
  render(<MemoryRouter initialEntries={["/app/frontier/items/item-1"]}><Routes><Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} /></Routes></MemoryRouter>);
}
it("opens a direct article address with a Chinese guide, stored abstract, original title and distinct original link", async () => {
  show();
  expect(await screen.findByRole("heading", { name: "口服 PCSK9 抑制剂降低主要心血管事件", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "AI 导读" })).toBeInTheDocument();
  expect(screen.getByText("已保存的中文摘要")).toBeInTheDocument();
  expect(screen.getByText("Oral PCSK9 Inhibition and Cardiovascular Outcomes")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "原文" })).toHaveAttribute("target", "_blank");
  expect(client.fetchFrontierAbstractZh).not.toHaveBeenCalled();
  expect(client.markFrontierItemRead).toHaveBeenCalled();
});
it("offers retry for a failed direct read", async () => {
  client.fetchFrontierItem.mockRejectedValueOnce(new Error("offline"));
  show();
  await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
  expect(await screen.findByText("已保存的中文摘要")).toBeInTheDocument();
});
it("distinguishes an unavailable article", async () => {
  client.fetchFrontierItem.mockRejectedValue(new WebApiError("missing", { status: 404, code: "frontier_item_not_found" }));
  show();
  expect(await screen.findByText("这条动态已下架，不再提供。")).toBeInTheDocument();
});
it("does not fetch an article when the module is off", () => {
  client.useFrontierFeature.mockReturnValue("off");
  show();
  expect(client.fetchFrontierItem).not.toHaveBeenCalled();
});

it("returns to the exact existing feed history entry and its reading position", async () => {
  const reading = { query: "view=all&lane=safety", pages: 3, scroll: 640, expanded: ["item-1"] };
  function Feed() { const location = useLocation(); return <pre data-testid="restored">{JSON.stringify({ search: location.search, state: location.state })}</pre>; }
  render(<MemoryRouter initialIndex={1} initialEntries={[
    { pathname: "/app/frontier", search: "?view=all&lane=safety", state: { frontierReading: reading } },
    { pathname: "/app/frontier/items/item-1", state: { evidenceFrom: { to: "/app/frontier?view=all&lane=safety", label: "前沿动态" } } },
  ]}><Routes><Route path="/app/frontier" element={<Feed />} /><Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} /></Routes></MemoryRouter>);
  await screen.findByText("已保存的中文摘要");
  await userEvent.click(screen.getByRole("link", { name: "前沿动态" }));
  expect(JSON.parse(screen.getByTestId("restored").textContent!)).toEqual({ search: "?view=all&lane=safety", state: { frontierReading: reading } });
});

it("requests the existing Chinese abstract when only an original is stored", async () => {
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItem({ id: "item-1" }), abstract: "Original abstract", abstractZh: null });
  client.fetchFrontierAbstractZh.mockResolvedValue({ abstractZh: "新生成的中文摘要", abstract: "Original abstract", note: null });
  show();
  expect(await screen.findByText("新生成的中文摘要")).toBeInTheDocument();
  expect(client.fetchFrontierAbstractZh).toHaveBeenCalledWith("item-1");
});
