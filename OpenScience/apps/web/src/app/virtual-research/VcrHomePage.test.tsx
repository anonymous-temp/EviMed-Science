import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { fixture, installVcrServer } from "@/components/vcr/__fixtures__/serverFixtures";
import { VcrHomePage } from "./VcrHomePage";

// Only the network is doubled: `/api/me` and `productRequest`. The readers,
// the route functions and the page are the real ones, fed the server's own
// home payload (`ev201/home.json`).
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const me = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  fetchWebMe: me.fetchWebMe,
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_new" }], select: store.select, load: store.load }) },
}));

function Probe() {
  const location = useLocation();
  const state = location.state as { runtimeUiIntent?: { draft?: string } } | null;
  return <div data-testid="location">{location.pathname}<span data-testid="draft">{JSON.stringify(state?.runtimeUiIntent?.draft ?? null)}</span></div>;
}

function draw(path = "/app/virtual-research") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research" element={<><VcrHomePage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const EV201 = "EV-201 二线 NSCLC：单臂 II 期还是随机";
const GLP1 = "GLP-1 周制剂 III 期：样本量与脱落情景";
const row = (name: string) => screen.getByRole("link", { name }).closest("li") as HTMLElement;

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest, {
    "POST /vcr/studies": { id: "std_9", projectId: "prj_new", sessionId: "ses_9" },
  });
  me.fetchWebMe.mockReset();
  me.fetchWebMe.mockResolvedValue({ features: { vcr: true } });
  toasts.error.mockReset();
  store.select.mockClear();
});

describe("the module being off for this account", () => {
  it("is one sentence when /api/me says so, and the list is never asked for", async () => {
    me.fetchWebMe.mockResolvedValue({ features: { vcr: false } });
    draw();
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
  });

  it("is the same sentence when the route refuses", async () => {
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies": () => { throw new WebApiError("no", { status: 404, code: "vcr_not_enabled" }); },
    });
    draw();
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

describe("the study list", () => {
  it("lists both studies the server sent, each with its tier tag", async () => {
    draw();
    expect(await screen.findByRole("link", { name: EV201 })).toHaveAttribute("href", "/app/virtual-research/std_1");
    expect(screen.getByRole("link", { name: GLP1 })).toHaveAttribute("href", "/app/virtual-research/std_2");
    expect(within(row(EV201)).getByText("T0 公开资料")).toBeInTheDocument();
    expect(within(row(GLP1)).getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /研究/ })).toHaveTextContent("2");
  });

  it("shows the question, the latest conclusion in the study's own words, and what needs attention", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    const ev201 = row(EV201);
    expect(within(ev201).getByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeInTheDocument();
    expect(within(ev201).getByText("已模拟 3 个方案，成功把握 58%～74%；真实外部对照不可估计，缺 3 项数据")).toBeInTheDocument();
    expect(within(ev201).getByText("可估计")).toBeInTheDocument();
    expect(within(ev201).getByText("2 条关键假设由 AI 设定")).toBeInTheDocument();
    expect(within(ev201).getByText("1 项计算在等你确认计算预算")).toBeInTheDocument();
    expect(within(ev201).getByText("今天 09:09")).toBeInTheDocument();
    // A study that has concluded nothing prints no conclusion line at all.
    expect(within(row(GLP1)).queryByText("最近结论")).toBeNull();
  });

  it("counts the steps that are done, and does not count a failed one", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    expect(within(row(EV201)).getByRole("img", { name: "七步中已完成 6 步" })).toBeInTheDocument();
    expect(within(row(EV201)).getByText("6 / 7 步")).toBeInTheDocument();
    expect(row(EV201).querySelector("[data-vcr-step-dot='failed']")).not.toBeNull();
    expect(within(row(GLP1)).getByRole("img", { name: "七步中已完成 0 步" })).toBeInTheDocument();
  });

  it("says so, in one line, when there is no study yet", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": { studies: [] } });
    draw();
    expect(await screen.findByText("还没有研究")).toBeInTheDocument();
    // UI-27: no sentence under the title explaining what to do.
    expect(screen.queryByText(/从上面四个动作/)).toBeNull();
  });

  it("offers 重试 when the list cannot be read", async () => {
    let first = true;
    server = installVcrServer(network.productRequest, {
      "GET /vcr/studies": () => {
        if (first) { first = false; throw new WebApiError("down", { status: 503, code: "vcr_unavailable" }); }
        return fixture("ev201/home.json");
      },
    });
    draw();
    await userEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: EV201 })).toBeInTheDocument();
  });
});

describe("招募待办 and 最近复核", () => {
  it("shows the coordinator's to-dos, each linking to the tab it is about", async () => {
    draw();
    const todos = await waitFor(() => {
      const card = document.querySelector("[data-vcr-todos]");
      expect(card).not.toBeNull();
      return card as HTMLElement;
    });
    expect(within(todos).getByText("招募待办")).toBeInTheDocument();
    expect(within(todos).getByText("P-0192 待确认联系")).toBeInTheDocument();
    expect(within(todos).getByText("中心 07 的资料还没有核实过")).toBeInTheDocument();
    expect(within(todos).getByRole("link", { name: "去确认" })).toHaveAttribute("href", "/app/virtual-research/std_1/matching");
    expect(screen.getByText("最近复核")).toBeInTheDocument();
    expect(screen.getByText("统计复核：假设卡「orr_control」v1 · 已复核")).toBeInTheDocument();
    expect(screen.queryByText(/u_stat/)).toBeNull();
  });

  // Only where the server sent them: a recruiting role, not everyone's column.
  it("is absent when the payload has neither", async () => {
    const home = fixture("ev201/home.json");
    delete home.todos;
    delete home.reviews;
    server = installVcrServer(network.productRequest, { "GET /vcr/studies": home });
    draw();
    await screen.findByRole("link", { name: EV201 });
    expect(screen.queryByText("招募待办")).toBeNull();
    expect(screen.queryByText("最近复核")).toBeNull();
  });
});

describe("the four actions", () => {
  it("offers exactly the four the vocabulary names, each with what it produces", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    for (const [label, produces] of [
      ["创建虚拟队列", "人群定义与筛选流程"],
      ["创建虚拟患者", "个体轨迹与不确定性"],
      ["构建合成对照", "对照、诊断或缺口清单"],
      ["模拟临床试验", "方案对比与成功把握"],
    ]) {
      const card = screen.getByRole("button", { name: new RegExp(label) });
      expect(within(card).getByText(produces)).toBeInTheDocument();
    }
  });

  // None of them opens a form (plan §9.3).
  it("creates the study and lands in its conversation with the starting line", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.click(screen.getByRole("button", { name: /模拟临床试验/ }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", { action: "trial" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(screen.getByTestId("draft").textContent).toContain("模拟几个试验方案");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("新建研究 creates a study with no starting point chosen", async () => {
    draw();
    await screen.findByRole("link", { name: EV201 });
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/studies", "POST", {}));
  });
});

describe("the home's three views", () => {
  it("keeps the chosen view in the address and reads the model library there", async () => {
    draw("/app/virtual-research?tab=models");
    expect(await screen.findByRole("tab", { name: "模型与方法" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(server.calls.some((call) => call.path === "/vcr/models")).toBe(true));
    expect(await screen.findByRole("button", { name: /二线 NSCLC 多西他赛组 PFS · Weibull/ })).toBeInTheDocument();
    // The study list is not on this view; the one link to EV-201 is the model card's own 「被使用」 line.
    expect(screen.queryByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeNull();
    expect(screen.getByRole("link", { name: EV201 }).closest("[data-vcr-model-card], section")).not.toBeNull();
  });

  it("opens 试验先例 on the library", async () => {
    draw("/app/virtual-research?tab=precedents");
    await waitFor(() => expect(server.calls.some((call) => call.path === "/vcr/precedents")).toBe(true));
    expect(await screen.findByText("CTR20990001")).toBeInTheDocument();
  });
});
