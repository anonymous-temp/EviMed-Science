import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frontierItemDetail } from "@/components/frontier/__fixtures__/frontierItems";
import { pendingFrontierEvents, resetFrontierTracking } from "@/lib/frontierTracking";
import { FrontierArticlePage } from "./FrontierArticlePage";

const client = vi.hoisted(() => ({
  useFrontierFeature: vi.fn(), fetchFrontierItem: vi.fn(), fetchFrontierAbstractZh: vi.fn(), markFrontierItemRead: vi.fn(),
  starFrontierItem: vi.fn(), unstarFrontierItem: vi.fn(), hideFrontierItem: vi.fn(), addFrontierFollow: vi.fn(),
}));
vi.mock("@/lib/frontierClient", async (original) => ({ ...(await original<typeof import("@/lib/frontierClient")>()), ...client }));

const ID = "a1b2c3d4e5f60718";

function show(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/items/${ID}${search}`]}>
      <Routes><Route path="/app/frontier/items/:itemId" element={<FrontierArticlePage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  resetFrontierTracking();
  sessionStorage.clear();
  client.useFrontierFeature.mockReturnValue("on");
  client.fetchFrontierItem.mockResolvedValue({ ...frontierItemDetail({ id: ID }), abstract: "Original abstract", abstractZh: "已保存的中文摘要" });
  client.markFrontierItemRead.mockResolvedValue({});
  client.fetchFrontierAbstractZh.mockResolvedValue(null);
});
afterEach(() => resetFrontierTracking());

describe("how a reading page was reached (G12, 2026-10-25)", () => {
  it("a link a notification carried opens the page as push", async () => {
    show("?from=push");
    await screen.findByRole("heading", { level: 1 });
    expect(pendingFrontierEvents().filter((event) => event.type === "open").map((event) => [event.item, event.surface])).toEqual([[ID, "push"]]);
  });

  it("an address with no marker opens it as direct", async () => {
    show("");
    await screen.findByRole("heading", { level: 1 });
    expect(pendingFrontierEvents().filter((event) => event.type === "open").map((event) => [event.item, event.surface])).toEqual([[ID, "direct"]]);
  });
});
