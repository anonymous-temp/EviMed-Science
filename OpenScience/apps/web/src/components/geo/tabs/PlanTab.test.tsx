import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoStrategyView } from "@/lib/geoClient";
import { geoProject, strategyFilled } from "../__fixtures__/geoTabs";
import { GeoFrameHarness } from "../__fixtures__/geoFrameHarness";
import { PlanTab } from "./PlanTab";
import { headRows } from "./PlanStrategy";

const client = vi.hoisted(() => ({
  getGeoStrategy: vi.fn(),
  getGeoSources: vi.fn(),
  getGeoValue: vi.fn(),
  getGeoEvidence: vi.fn(),
  getGeoJourney: vi.fn(),
  setGeoTier: vi.fn(),
  skipGeoAction: vi.fn(),
  runGeoStep: vi.fn(),
}));
vi.mock("@/lib/geoClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/geoClient")>()),
  ...client,
}));

const open = vi.hoisted(() => vi.fn());
vi.mock("../useOpenGeoConversation", () => ({ useOpenGeoConversation: () => open }));

const project = geoProject({ evidence: "done", journey: "done", sources: "done" });
const props = { geoId: "geo_1", project };

function renderPlan(reload: () => void = () => undefined) {
  return render(
    <MemoryRouter>
      <GeoFrameHarness project={project} tab="plan" reload={reload}><PlanTab {...props} /></GeoFrameHarness>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  open.mockReset().mockResolvedValue(true);
  client.getGeoStrategy.mockResolvedValue(strategyFilled);
});

/** The headings of the page, by text, in document order. */
const headingsOf = () => screen.getAllByRole("heading").map((heading) => heading.textContent);

describe("方案: what it is", () => {
  it("is one plan in five blocks, in the order a reader asks — and nothing of the settings, the journey or the claims", async () => {
    renderPlan();
    await screen.findByRole("heading", { name: "目标" });
    const order = ["目标", "战场", "各引擎能承诺什么", "需要你做的", "假设"];
    const headings = order.map((name) => screen.getByRole("heading", { name }));
    headings.slice(1).forEach((heading, index) => {
      expect(headings[index].compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING, `${heading.textContent} follows ${headings[index].textContent}`).toBeTruthy();
    });
    for (const gone of ["测量方案", "患者与医生的旅程", "产品与依据", "药品价值分析", "布局"]) expect(headingsOf()).not.toContain(gone);
    expect(screen.queryByText("测量的 AI 引擎")).not.toBeInTheDocument();
  });

  it("reads the plan's one route, not the project's every source, and not the value analysis", async () => {
    renderPlan();
    await screen.findByRole("heading", { name: "目标" });
    expect(client.getGeoStrategy).toHaveBeenCalledWith("geo_1");
    expect(client.getGeoSources).not.toHaveBeenCalled();
    expect(client.getGeoValue).not.toHaveBeenCalled();
    expect(client.getGeoEvidence).not.toHaveBeenCalled();
    expect(client.getGeoJourney).not.toHaveBeenCalled();
  });

  it("draws no filter, no chip row and no tab list in its body: the tier is chosen in a column's header", async () => {
    const view = renderPlan();
    await screen.findByRole("heading", { name: "目标" });
    expect(view.container.querySelectorAll("[role=tablist], [data-toolbar], [role=searchbox], input")).toHaveLength(0);
    // The only controls on the page that can be pressed are 「选这一档」 buttons: none is a chip of a filter group.
    for (const group of view.container.querySelectorAll("[role=group]")) {
      expect(group.querySelectorAll("[aria-pressed]"), group.getAttribute("aria-label") ?? "").toHaveLength(0);
    }
  });
});

describe("方案: 目标", () => {
  it("puts the three tiers side by side as three columns, each with the choice in its header", async () => {
    renderPlan();
    const columns = await waitFor(() => {
      const found = document.querySelectorAll("[data-geo-tier]");
      expect(found).toHaveLength(3);
      return [...found] as HTMLElement[];
    });
    expect(columns.map((column) => column.getAttribute("data-geo-tier"))).toEqual(["1", "2", "3"]);
    // 档二 is the chosen one: it says so and offers no button; the other two offer 「选这一档」 in their header.
    expect(columns[1]).toHaveAttribute("aria-current", "true");
    expect(within(columns[1]).queryByRole("button", { name: "选这一档" })).not.toBeInTheDocument();
    expect(within(columns[1]).getByText("这一档")).toBeInTheDocument();
    for (const column of [columns[0], columns[2]]) {
      const header = column.querySelector("header") as HTMLElement;
      expect(within(header).getByRole("button", { name: "选这一档" })).toBeInTheDocument();
    }
    // A tier is never named without what it is: its name and its numbers.
    expect(within(columns[0]).getByRole("heading", { name: "档一：讲准为先" })).toBeInTheDocument();
    expect(within(columns[1]).getByRole("heading", { name: "档二：讲准 + 进入被提及" })).toBeInTheDocument();
  });

  it("draws each head metric as where it began, where it is and where this tier puts it, with the dates", async () => {
    renderPlan();
    const second = await waitFor(() => {
      const found = document.querySelector("[data-geo-tier='2']");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    const rows = within(second).getAllByRole("listitem").filter((row) => row.hasAttribute("data-geo-target"));
    expect(rows.map((row) => row.getAttribute("data-geo-target"))).toEqual(["M-19", "M-01S", "M-06"]);
    // One reader name per metric id: 品类问题可见率, never 品牌提及率.
    expect(within(second).getByText("品类问题可见率")).toBeInTheDocument();
    expect(within(second).queryByText("品牌提及率")).not.toBeInTheDocument();
    const mention = second.querySelector("[data-geo-target='M-01S']") as HTMLElement;
    expect(mention).toHaveTextContent("12%");
    expect(mention).toHaveTextContent("基线 7% · 9月25日 → 现在 21% · 10月12日");
    // The target falls due on the baseline round's day plus the plan's weeks — where the reading has not reached it. This one has
    // (21% against 12%): it says so, and gives no deadline for something done.
    const index = second.querySelector("[data-geo-target='M-19']") as HTMLElement;
    expect(index).toHaveTextContent("55");
    expect(index).toHaveTextContent("12月18日前");
    expect(index).not.toHaveTextContent("已达到");
    expect(mention).toHaveTextContent("已达到");
    expect(mention).not.toHaveTextContent("12月18日前");
    // A bar with the baseline's tick and the target's, under the figure.
    expect(mention.querySelector("[data-bullet-baseline]")).not.toBeNull();
    expect(mention.querySelector("[data-bullet-target]")).not.toBeNull();
    // The columns share the reading and differ in the target.
    const first = document.querySelector("[data-geo-tier='1'] [data-geo-target='M-01S']") as HTMLElement;
    expect(first).toHaveTextContent("9%");
    expect(first).toHaveTextContent("基线 7% · 9月25日 → 现在 21% · 10月12日");
  });

  it("says what the tier buys and what it does not promise, and keeps the pools' own rows behind the columns", async () => {
    renderPlan();
    const second = await waitFor(() => {
      const found = document.querySelector("[data-geo-tier='2']");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(second).toHaveTextContent("16 篇稿件 · 24 个投放位 · 预算 8,000 灵豆");
    expect(second).toHaveTextContent("12 个位次 + 16 篇稿件");
    const promised = within(second).getByRole("list", { name: "不承诺的" });
    expect(within(promised).getAllByRole("listitem").map((row) => row.textContent)).toEqual(["不承诺 P3 泛症状池被提及", "不承诺豆包任何变化（未测）"]);
    // 品牌提及率 is M-01 over 增量 questions: a row of the table behind the columns, under its own name.
    await userEvent.click(screen.getByText("各问句池和其余指标的目标"));
    expect(screen.getByRole("rowheader", { name: "品牌提及率（增量）" })).toBeInTheDocument();
  });

  it("writes the choice, says so, and reads the plan again — a person's reversible word, never an approval", async () => {
    client.setGeoTier.mockResolvedValue({});
    const reload = vi.fn();
    renderPlan(reload);
    const third = await waitFor(() => {
      const found = document.querySelector("[data-geo-tier='3']");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    client.getGeoStrategy.mockResolvedValue({
      ...strategyFilled,
      chosenTier: "3",
      tiers: strategyFilled.tiers.map((tier) => ({ ...tier, chosen: tier.tier === "3" })),
    });
    await userEvent.click(within(third).getByRole("button", { name: "选这一档" }));
    await waitFor(() => expect(client.setGeoTier).toHaveBeenCalledWith("geo_1", "3"));
    await waitFor(() => expect(document.querySelector("[data-geo-tier='3']")).toHaveAttribute("aria-current", "true"));
    expect(document.querySelector("[data-geo-tier='2']")).not.toHaveAttribute("aria-current");
    expect(reload).toHaveBeenCalled();
  });

  it("offers no choice to a person who may not edit the project", async () => {
    const viewer = { ...project, access: { roles: ["viewer"], abilities: ["read"], owner: false } };
    render(
      <MemoryRouter>
        <GeoFrameHarness project={viewer} tab="plan"><PlanTab geoId="geo_1" project={viewer} /></GeoFrameHarness>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "目标" });
    expect(screen.queryByRole("button", { name: "选这一档" })).not.toBeInTheDocument();
  });
});

describe("方案: 战场", () => {
  it("names the main battlefield by its groups — each a link to its question group where the plan resolved it — and says why", async () => {
    renderPlan();
    const field = await waitFor(() => {
      const found = document.querySelector("[data-geo-battlefield]");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(field).getByRole("link", { name: "恶心呕吐与胃肠反应" })).toHaveAttribute("href", "/app/geo/geo_1/questions?group=gq_1");
    // A group the plan could not resolve is its name, not a link and never an id.
    expect(within(field).getByText("说明书安全题组")).toBeInTheDocument();
    expect(within(field).queryByRole("link", { name: "说明书安全题组" })).not.toBeInTheDocument();
    expect(field).toHaveTextContent("品牌身份组事实准确率 36%（4/11）。");
    expect(field).toHaveTextContent("先写事实与安全稿，再补纠错稿。");
    expect(document.body.textContent).not.toMatch(/ggr_/);
  });

  it("names the secondary battlefields and what is not worth doing, each with its reason", async () => {
    renderPlan();
    const field = await waitFor(() => {
      const found = document.querySelector("[data-geo-battlefield]");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(field).getByRole("heading", { name: "次要战场" })).toBeInTheDocument();
    expect(within(field).getByRole("link", { name: "停药后体重反弹" })).toHaveAttribute("href", "/app/geo/geo_1/questions?group=gq_2");
    expect(field).toHaveTextContent("提及率 6%（1/16），可动但证据偏弱。");
    expect(within(field).getByRole("heading", { name: "不做" })).toBeInTheDocument();
    expect(field).toHaveTextContent("泛症状池的抢排名：品牌不在检索结果里，写了也不会被引");
  });
});

describe("方案: 各引擎能承诺什么", () => {
  it("merges the promise with the layout: the retrieval it rests on, the level, the layer, the account and its state", async () => {
    renderPlan();
    const deepseek = await waitFor(() => {
      const found = document.querySelector("[data-geo-expectation='deepseek']");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(deepseek).toHaveTextContent("DeepSeek");
    expect(deepseek).toHaveTextContent("96%");
    expect(deepseek).toHaveTextContent("62 次里 60 次");
    expect(within(deepseek).getByText("能承诺被提及，也能承诺讲对")).toBeInTheDocument();
    expect(within(deepseek).getByText("锚点 + 覆盖")).toBeInTheDocument();
    expect(deepseek).toHaveTextContent("认证自有公众号");
    expect(deepseek).toHaveTextContent("还没有");
    expect(deepseek).toHaveTextContent("进入引用：锚点层 + 覆盖层");
    const kimi = document.querySelector("[data-geo-expectation='kimi']") as HTMLElement;
    expect(within(kimi).getByText("只承诺讲对，不承诺被提及")).toBeInTheDocument();
    // An engine measured only for being mentioned says so, in the retrieval's place.
    expect(within(document.querySelector("[data-geo-expectation='baidu']") as HTMLElement).getByText("只测提及")).toBeInTheDocument();
  });
});

describe("方案: 需要你做的", () => {
  it("lists what the strategy asks of the client, the open ones first, and marks one done and back — reversible, the only thing written", async () => {
    client.skipGeoAction.mockResolvedValue({ key: "client:0a1b2c3d", skipped: true, sourceDomain: null, updatedAt: null, cleared: false });
    renderPlan();
    const heading = await screen.findByRole("heading", { name: "需要你做的" });
    const list = within(heading.closest("section") as HTMLElement).getByRole("list", { name: "需要你做的事" });
    expect(within(list).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("开通并认证自有微信公众号"),
      expect.stringContaining("提供说明书最新版 PDF"),
    ]);
    await userEvent.click(within(list).getByRole("button", { name: "已经做了" }));
    await waitFor(() => expect(client.skipGeoAction).toHaveBeenCalledWith("geo_1", "client:0a1b2c3d", true));
    await userEvent.click(within(list).getByRole("button", { name: "还没做" }));
    await waitFor(() => expect(client.skipGeoAction).toHaveBeenCalledWith("geo_1", "client:4e5f6a7b", false));
  });

  it("draws no block where the strategy asks nothing of the client", async () => {
    client.getGeoStrategy.mockResolvedValue({ ...strategyFilled, layout: { ...strategyFilled.layout, clientActions: [] } });
    renderPlan();
    await screen.findByRole("heading", { name: "目标" });
    expect(screen.queryByRole("heading", { name: "需要你做的" })).not.toBeInTheDocument();
  });
});

describe("方案: 假设", () => {
  it("lists what the plan took as given, one line each, and changes one in the conversation with the line in the draft, unsent", async () => {
    renderPlan();
    const heading = await screen.findByRole("heading", { name: "假设" });
    await userEvent.click(within(heading.closest("section") as HTMLElement).getByText("方案按这些假设做，不对的可以改"));
    const rows = within(heading.closest("section") as HTMLElement).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // A code is never printed: the line is the reason, with a plain value in front of it.
    expect(rows[0]).toHaveTextContent("没有指定档位，三档都给出，默认按档二执行");
    expect(rows[0]).not.toHaveTextContent("tier");
    expect(rows[1]).toHaveTextContent("豆包没有有效回答，本周期只写“未测”");
    await userEvent.click(within(rows[1]).getByRole("button", { name: "修改" }));
    expect(open).toHaveBeenCalledWith({ projectId: "prj_geo_1", sessionId: "ses_geo_1" }, expect.stringContaining("豆包没有有效回答"));
  });
});

describe("方案: before there is a plan, and when it cannot be read", () => {
  it("is the recipe of the step that makes it where no strategy has been written", async () => {
    client.getGeoStrategy.mockResolvedValue({
      ...strategyFilled, version: null, createdAt: null, runId: null, summary: null, chosenTier: null,
      tiers: [], battlefield: null, noGo: [], engines: [], layout: { layers: null, constraints: [], clientActions: [] }, assumptions: [],
    });
    renderPlan();
    expect(await screen.findByText("还没有信源分析")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分析引用的信源" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/档[一二三]/);
  });

  it("says a failed read in its place, with 重试", async () => {
    client.getGeoStrategy.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(strategyFilled);
    renderPlan();
    await userEvent.click(await screen.findByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("heading", { name: "目标" })).toBeInTheDocument();
  });
});

describe("headRows", () => {
  it("is the head metrics over the whole project, in the overview's order — and the rows there are when the plan names none of the four", () => {
    expect(headRows(strategyFilled.targets.rows).map((row) => row.metricId)).toEqual(["M-19", "M-01S", "M-06"]);
    const onlyPools: GeoStrategyView["targets"]["rows"] = strategyFilled.targets.rows.filter((row) => row.pool !== "all");
    expect(headRows(onlyPools).map((row) => row.metricId)).toEqual(["M-01"]);
  });
});
