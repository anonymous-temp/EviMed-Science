import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceFilled, geoProject, journeyFilled, sourcesFilled } from "../__fixtures__/geoTabs";
import { PlanTab } from "./PlanTab";
import { tierSentence } from "./PlanStrategy";

const client = vi.hoisted(() => ({
  getGeoValue: vi.fn(),
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  getGeoSources: vi.fn(),
  setGeoTier: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

const props = { geoId: "geo_1", project: geoProject({ evidence: "done", journey: "done", sources: "done" }) };

function renderPlan() {
  return render(<MemoryRouter><PlanTab {...props} /></MemoryRouter>);
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getGeoValue.mockResolvedValue({ version: 0, data: {}, research: [], impacts: [], observations: [], coverage: { assessed: 0, value: null } });
  client.getGeoEvidence.mockResolvedValue(evidenceFilled);
  client.getGeoJourney.mockResolvedValue(journeyFilled);
  client.getGeoSources.mockResolvedValue(sourcesFilled);
});

describe("方案", () => {
  it("reads measurement, target, layout, journey, then the product and its claims", async () => {
    renderPlan();
    await screen.findByText("证据最硬、竞品最弱。");
    const order = ["测量方案", "目标", "布局", "患者与医生的旅程", "产品与依据"].map((name) => screen.getByRole("heading", { name }));
    order.slice(1).forEach((heading, index) => {
      expect(order[index].compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING, `${heading.textContent} follows ${order[index].textContent}`).toBeTruthy();
    });
    // The settings panel keeps the three rows that are settings; the tier is chosen under 目标.
    expect(screen.getByText("测量的 AI 引擎")).toBeInTheDocument();
    expect(screen.getByText("覆盖周期")).toBeInTheDocument();
    expect(screen.getByText("投放预算")).toBeInTheDocument();
    expect(screen.queryByText("目标档位", { selector: "div,span,p,dt,dd" })).not.toBeInTheDocument();
  });

  it("never prints a tier without its numbers: the chosen tier is said with them, and the table has all three", async () => {
    renderPlan();
    expect(await screen.findByText("档二：综合可见度指数 55")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "档二（已选）" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "品牌提及率（增量）" })).toBeInTheDocument();
    expect(screen.getByText("15,000 灵豆")).toBeInTheDocument();
  });

  it("chooses the target tier here, and reads the new choice back", async () => {
    client.setGeoTier.mockResolvedValue({});
    renderPlan();
    await screen.findByText("档二：综合可见度指数 55");
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, chosenTier: "3" });
    await userEvent.click(screen.getByRole("button", { name: "档三" }));
    await waitFor(() => expect(client.setGeoTier).toHaveBeenCalledWith("geo_1", "3"));
    expect(await screen.findByText("档三：综合可见度指数 62")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "档三（已选）" })).toBeInTheDocument();
  });

  it("names the main battlefield by its groups, never by id, and each engine's expectation", async () => {
    renderPlan();
    await screen.findByText("证据最硬、竞品最弱。");
    const battlefield = document.querySelector("[data-geo-battlefield]") as HTMLElement;
    expect(battlefield).toHaveTextContent("恶心呕吐与胃肠反应");
    expect(document.body.textContent).not.toMatch(/ggr_/);
    const expectation = document.querySelector("[data-geo-expectation='deepseek']") as HTMLElement;
    expect(within(expectation).getByText("锚点 + 覆盖")).toBeInTheDocument();
    expect(within(document.querySelector("[data-geo-expectation='baidu']") as HTMLElement).getByText("只测提及")).toBeInTheDocument();
  });

  it("never prints a group id even from a server that sends no names", async () => {
    client.getGeoSources.mockResolvedValue({ ...sourcesFilled, battlefield: { groups: ["ggr_9", "恶心呕吐与胃肠反应"], reason: null } });
    renderPlan();
    await screen.findByText("各引擎的预期");
    expect(document.querySelector("[data-geo-battlefield]")).toHaveTextContent("恶心呕吐与胃肠反应");
    expect(document.body.textContent).not.toMatch(/ggr_/);
  });

  it("lists 8 of 108 claims and finds one by a word of it", async () => {
    const claims = Array.from({ length: 108 }, (_, index) => ({ ...evidenceFilled.claims[0], id: `clm_${index}`, statement: `第 ${index} 条：${index === 50 ? "饭后服用" : "按说明书使用"}。` }));
    client.getGeoEvidence.mockResolvedValue({ ...evidenceFilled, claims });
    renderPlan();
    const list = await screen.findByRole("list", { name: undefined });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "显示更多 · 还有 100 条" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索结论" }), "饭后");
    expect(screen.getByText("匹配 1 条结论")).toBeInTheDocument();
  });

  it("draws no target and no layout where the sources analysis produced none, and no tier word", async () => {
    client.getGeoSources.mockResolvedValue({ sources: [], expectations: [], battlefield: null, tiers: [], chosenTier: null });
    renderPlan();
    await screen.findByRole("heading", { name: "产品与依据" });
    expect(screen.queryByRole("heading", { name: "目标" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "布局" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/档[一二三]/);
  });

  it("a failed strategy read is said in its place with 重试, and the rest of the plan stays", async () => {
    client.getGeoSources.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(sourcesFilled);
    renderPlan();
    expect(await screen.findByRole("heading", { name: "产品与依据" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByText("档二：综合可见度指数 55")).toBeInTheDocument();
  });
});

describe("tierSentence", () => {
  const tier = (targets: Array<{ metricId: string; pool: string | null; target: number | null }>) =>
    ({ tier: "2" as const, targets: targets.map((target) => ({ baseline: null, ...target })) as never, placements: null, budgetCny: null });

  it("names the project-wide targets in the overview's order and leaves a pool's own goal out", () => {
    expect(tierSentence(tier([
      { metricId: "M-06", pool: "all", target: 98 },
      { metricId: "M-19", pool: "all", target: 50 },
      { metricId: "M-01", pool: "P2", target: 35 },
    ]))).toBe("档二：综合可见度指数 50，事实准确率 98%");
  });

  it("is null for a tier with no project-wide number", () => {
    expect(tierSentence(tier([{ metricId: "M-01", pool: "P2", target: 35 }, { metricId: "M-19", pool: null, target: null }]))).toBeNull();
    expect(tierSentence(undefined)).toBeNull();
  });
});
