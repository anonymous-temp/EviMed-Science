import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import type { FrontierEvent } from "@/lib/frontierClient";
import { frontierItem } from "@/components/frontier/__fixtures__/frontierItems";
import { FrontierEventPage } from "./FrontierEventPage";

const client = vi.hoisted(() => ({ useFrontierFeature: vi.fn(), fetchFrontierEvent: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  ...client,
}));

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function event(overrides: Partial<FrontierEvent> = {}): FrontierEvent {
  return {
    id: "ev1",
    title: "FDA 批准首个皮下注射的阿尔茨海默病抗淀粉样蛋白抗体",
    digest: "FDA 于 9 月 19 日批准某抗淀粉样蛋白单抗的皮下注射剂型。",
    latest: { text: "企业公布了居家给药的患者支持计划。", at: ago(1) },
    status: "developing",
    lane: "regulatory", laneLabel: "审批监管",
    specialties: [{ key: "neurology", label: "神经" }],
    sourceCount72h: 7, reportCount: 3,
    firstAt: ago(60), lastAt: ago(1),
    items: [
      { ...frontierItem({ id: "p1", title: "批准公告原文", source: { id: "fda", name: "FDA Press Announcement" }, sourceType: "regulator", sourceTypeLabel: "监管", url: "https://www.fda.gov/news/x", timelineAt: ago(50), selected: true }), role: "primary" },
      { ...frontierItem({ id: "r1", title: "居家给药会不会放大监测缺口", source: { id: "stat", name: "STAT" }, sourceType: "media", sourceTypeLabel: "媒体", url: "https://www.statnews.com/x", timelineAt: ago(10), selected: false }), role: "report" },
      { ...frontierItem({ id: "r2", title: "公布患者支持计划与定价区间", source: { id: "co", name: "企业新闻室" }, sourceType: "company", sourceTypeLabel: "企业", url: "https://example.com/pr", timelineAt: ago(1), selected: true }), role: "report" },
    ],
    related: [{ id: "ev0", title: "同类药物 EMA 审评意见", relation: "follows", at: ago(24 * 60) }],
    ...overrides,
  };
}

function Probe() {
  const location = useLocation();
  const intent = (location.state as { runtimeUiIntent?: { draft?: string } } | null)?.runtimeUiIntent;
  return <div data-testid="location">{location.pathname}{intent?.draft ? `|${intent.draft}` : ""}</div>;
}

function renderEvent(id = "ev1") {
  return render(
    <MemoryRouter initialEntries={[`/app/frontier/events/${id}`]}>
      <Routes>
        <Route path="/app/frontier/events/:eventId" element={<><FrontierEventPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  client.useFrontierFeature.mockReset().mockReturnValue("on");
  client.fetchFrontierEvent.mockReset().mockResolvedValue(event());
});

describe("an event", () => {
  it("leads with what is known, the latest turn and the parties' own texts", async () => {
    renderEvent();
    expect(await screen.findByRole("heading", { level: 1, name: "FDA 批准首个皮下注射的阿尔茨海默病抗淀粉样蛋白抗体" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "位置" })).toHaveTextContent("前沿动态›热点›事件");
    expect(screen.getByText("仍在发展")).toBeInTheDocument();
    expect(screen.getByText("3 篇报道")).toBeInTheDocument();
    expect(screen.getByText("FDA 于 9 月 19 日批准某抗淀粉样蛋白单抗的皮下注射剂型。")).toBeInTheDocument();
    expect(screen.getByText("企业公布了居家给药的患者支持计划。")).toBeInTheDocument();
    const primary = screen.getByRole("heading", { name: "一手来源" }).closest("section")!;
    expect(primary).toHaveTextContent("FDA Press Announcement");
    expect(primary).not.toHaveTextContent("STAT");
    expect(screen.getByRole("link", { name: "同类药物 EMA 审评意见" })).toHaveAttribute("href", "/app/frontier/events/ev0");
  });

  it("filters its timeline to first-hand texts or to 精选", async () => {
    renderEvent();
    const timeline = (await screen.findByRole("heading", { name: "报道时间线" })).closest("section")!;
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.click(within(timeline).getByRole("radio", { name: "一手 1" }));
    expect(within(timeline).getAllByRole("listitem").map((row) => row.textContent)).toEqual([expect.stringContaining("批准公告原文")]);
    await userEvent.click(within(timeline).getByRole("radio", { name: "精选 2" }));
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says there is no digest yet rather than inventing one", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ digest: null, latest: null }));
    renderEvent();
    expect(await screen.findByText("暂无综述")).toBeInTheDocument();
  });

  it("opens a new conversation with the event and its first-hand sources in the composer", async () => {
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "深入研究这个事件" }));
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent(/^\/app\/chat\|请围绕这个事件做一次深入研究/);
    expect(location).toHaveTextContent("一手来源：");
    expect(location).toHaveTextContent("FDA Press Announcement：批准公告原文（https://www.fda.gov/news/x）");
  });

  it("moves its own address to the surviving event when the old id was merged", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ id: "ev-survivor" }));
    renderEvent("ev-old");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/frontier/events/ev-survivor"));
    expect(client.fetchFrontierEvent).toHaveBeenCalledWith("ev-old");
    expect(await screen.findByRole("heading", { level: 1, name: /阿尔茨海默病/ })).toBeInTheDocument();
  });
});

describe("where there is no event to show", () => {
  it("says the event page is still being prepared on a server without it", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("no route", { status: 404, code: "not_found" }));
    renderEvent();
    expect(await screen.findByText("事件页还在准备")).toBeInTheDocument();
  });

  it("says the event is gone when the server does not know it", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_event_not_found" }));
    renderEvent();
    expect(await screen.findByText("这个事件已不存在")).toBeInTheDocument();
  });

  it("offers a retry on a failure", async () => {
    client.fetchFrontierEvent.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }));
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 1, name: /阿尔茨海默病/ })).toBeInTheDocument();
  });

  it("is the one sentence where the module is off", async () => {
    client.useFrontierFeature.mockReturnValue("off");
    renderEvent();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.fetchFrontierEvent).not.toHaveBeenCalled();
  });
});
