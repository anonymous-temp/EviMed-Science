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
const FIRST = new Date(2026, 8, 22, 18, 1).toISOString();

function event(overrides: Partial<FrontierEvent> = {}): FrontierEvent {
  return {
    id: "ev1",
    title: "不饱和磷脂多层多囊脂质体实现亲水药物超缓释",
    digest: "DOPC 脂质体包封率约为饱和类似物的 3 倍，初始释放低 11 倍。",
    latest: { text: "缓释脂质体注射剂在大鼠中实现持续 2 至 3 周神经阻滞", at: ago(3) },
    status: "developing",
    lane: "evidence", laneLabel: "临床证据",
    specialties: [{ key: "pharmacy", label: "药学" }],
    sourceCount72h: 2, reportCount: 2,
    firstAt: FIRST, lastAt: ago(3),
    heat: 38, hasPrimary: true, primary: "paper",
    institutions72h: { total: 2, byType: [{ type: "journal", label: "期刊", count: 1 }, { type: "media", label: "媒体", count: 1 }] },
    trend: Array.from({ length: 12 }, (_, index) => ({ at: ago(11 - index), heat: 20 + index })),
    items: [
      { ...frontierItem({ id: "p1", title: "不饱和磷脂脂质体原文", source: { id: "nbe", name: "自然-生物医学工程" }, sourceType: "journal", sourceTypeLabel: "期刊",
        url: "https://www.nature.com/x", timelineAt: ago(5) }), role: "primary" },
      { ...frontierItem({ id: "r1", title: "缓释脂质体注射剂在大鼠中实现持续神经阻滞", source: { id: "mx", name: "Medical Xpress" }, sourceType: "media", sourceTypeLabel: "媒体",
        url: "https://medicalxpress.com/x", timelineAt: ago(4), selected: false }), role: "report" },
    ],
    related: [{ id: "ev0", title: "同类缓释制剂的早先报道", relation: "follows", at: ago(24 * 6) }],
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
  it("heads the page with the way back, the title, one line of facts and 深入研究", async () => {
    renderEvent();
    const title = await screen.findByRole("heading", { level: 1, name: "不饱和磷脂多层多囊脂质体实现亲水药物超缓释" });
    expect(screen.getByRole("link", { name: "前沿动态" })).toHaveAttribute("href", "/app/frontier");
    expect(title.closest("header")).toContainElement(screen.getByRole("button", { name: "深入研究" }));
    const facts = title.closest("header")!.nextElementSibling!;
    expect(facts).toHaveTextContent("2 家机构报道·3 小时前更新药学");
    expect(within(facts as HTMLElement).getByText("药学")).toHaveClass("rounded-tag");
    // No explanation under any heading: the old cards each said how they were made.
    for (const gone of ["由多篇报道综合", "当事方自己的说法", "最新在前", "仍在发展", "篇报道"]) expect(document.body).not.toHaveTextContent(gone);
  });

  it("says what is known, and the latest turn", async () => {
    renderEvent();
    const digest = (await screen.findByRole("heading", { name: "概要" })).closest("section")!;
    expect(digest).toHaveTextContent("DOPC 脂质体包封率约为饱和类似物的 3 倍，初始释放低 11 倍。");
    expect(digest).toHaveTextContent("最新缓释脂质体注射剂在大鼠中实现持续 2 至 3 周神经阻滞 · 3 小时前");
  });

  it("puts every report on one timeline, newest first, the parties' own texts as filled dots and no filter", async () => {
    renderEvent();
    const reports = await screen.findByRole("list", { name: "报道" });
    const rows = within(reports).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(["缓释脂质体注射剂在大鼠中实现持续神经阻滞", "一手来源：不饱和磷脂脂质体原文"]);
    expect(rows[1].querySelector(".bg-accent")).not.toBeNull();
    expect(rows[0].querySelector(".bg-accent")).toBeNull();
    expect(rows[1]).toHaveTextContent("自然-生物医学工程·期刊·5 小时前·原文");
    expect(within(rows[1]).getByRole("link", { name: "原文" })).toHaveAttribute("href", "https://www.nature.com/x");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "同类缓释制剂的早先报道" })).toHaveAttribute("href", "/app/frontier/events/ev0");
  });

  it("carries the heat, its trend and where the reports come from in the right column", async () => {
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "热度与来源" });
    expect(side).toHaveTextContent("38热度");
    expect(side.querySelector("svg[data-sparkline] path")).not.toBeNull();
    const facts = within(side).getAllByRole("definition").map((entry) => entry.textContent);
    expect(within(side).getAllByRole("term").map((entry) => entry.textContent)).toEqual(["机构", "首报", "一手材料"]);
    expect(facts).toEqual(["期刊 1 · 媒体 1", "9月22日 18:01", "有论文原文"]);
  });

  it("keeps the column honest on a server that sends no heat yet", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ heat: undefined, trend: undefined, institutions72h: undefined, primary: undefined, hasPrimary: undefined, sourceCount72h: 7 }));
    renderEvent();
    const side = await screen.findByRole("complementary", { name: "热度与来源" });
    expect(side).not.toHaveTextContent("热度");
    expect(within(side).getAllByRole("definition").map((entry) => entry.textContent)).toEqual(["7 家", "9月22日 18:01", "有一手材料"]);
  });

  it("says there is no digest yet rather than inventing one", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ digest: null, latest: null }));
    renderEvent();
    expect(await screen.findByText("暂无综述")).toBeInTheDocument();
  });

  it("opens a new conversation with the event and its first-hand sources in the composer", async () => {
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "深入研究" }));
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent(/^\/app\/chat\|请围绕这个事件做一次深入研究/);
    expect(location).toHaveTextContent("一手来源：");
    expect(location).toHaveTextContent("自然-生物医学工程：不饱和磷脂脂质体原文（https://www.nature.com/x）");
  });

  it("moves its own address to the surviving event when the old id was merged", async () => {
    client.fetchFrontierEvent.mockResolvedValue(event({ id: "ev-survivor" }));
    renderEvent("ev-old");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/frontier/events/ev-survivor"));
    expect(client.fetchFrontierEvent).toHaveBeenCalledWith("ev-old");
    expect(await screen.findByRole("heading", { level: 1, name: /脂质体/ })).toBeInTheDocument();
  });
});

describe("where there is no event to show", () => {
  it("says the event page is still being prepared on a server without it, with the way back", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("no route", { status: 404, code: "not_found" }));
    renderEvent();
    expect(await screen.findByText("事件页还在准备")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回到前沿动态" })).toHaveAttribute("href", "/app/frontier");
  });

  it("says the event is gone when the server does not know it", async () => {
    client.fetchFrontierEvent.mockRejectedValue(new WebApiError("gone", { status: 404, code: "frontier_event_not_found" }));
    renderEvent();
    expect(await screen.findByText("这个事件已不存在")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "看热榜" })).toHaveAttribute("href", "/app/frontier?view=hot");
  });

  it("offers a retry on a failure", async () => {
    client.fetchFrontierEvent.mockRejectedValueOnce(new WebApiError("down", { status: 503, code: null }));
    renderEvent();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { level: 1, name: /脂质体/ })).toBeInTheDocument();
  });

  it("is the one sentence where the module is off", async () => {
    client.useFrontierFeature.mockReturnValue("off");
    renderEvent();
    expect(screen.getByText("前沿动态还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.fetchFrontierEvent).not.toHaveBeenCalled();
  });
});
