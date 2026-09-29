import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrHomePage } from "./VcrHomePage";
import { studySummary } from "@/components/vcr/__fixtures__/vcrStudy";

const client = vi.hoisted(() => ({
  getVcrHome: vi.fn(),
  createVcrStudy: vi.fn(),
  useVcrFeature: vi.fn(() => "on"),
  getVcrModels: vi.fn(),
  getVcrPrecedents: vi.fn(),
}));
vi.mock("@/lib/vcrClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vcrClient")>()),
  ...client,
}));

const store = vi.hoisted(() => ({
  select: vi.fn(async (_projectId: string, land?: () => void) => { land?.(); }),
  load: vi.fn(async () => undefined),
}));
vi.mock("@/lib/projects", () => ({
  useProjectStore: { getState: () => ({ projects: [{ id: "prj_1" }], select: store.select, load: store.load }) },
}));

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}<span data-testid="draft">{JSON.stringify(location.state?.runtimeUiIntent?.draft ?? null)}</span></div>;
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

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn.mockReset === "function") fn.mockReset();
  client.useVcrFeature.mockReturnValue("on");
  client.getVcrHome.mockResolvedValue({ studies: [studySummary()] });
  client.createVcrStudy.mockResolvedValue({ id: "std_2", projectId: "prj_1", sessionId: "ses_2" });
  client.getVcrModels.mockResolvedValue({ models: [], methods: [] });
  client.getVcrPrecedents.mockResolvedValue({ precedents: [] });
  store.select.mockClear();
});

describe("the module being off for this account", () => {
  it("is one sentence, whether /api/me says so or the route does", async () => {
    client.useVcrFeature.mockReturnValue("off");
    draw();
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(client.getVcrHome).not.toHaveBeenCalled();
  });

  it("falls back to the same sentence when the route refuses", async () => {
    client.getVcrHome.mockRejectedValue(new WebApiError("no", { status: 404, code: "vcr_not_enabled" }));
    draw();
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

describe("the four actions", () => {
  // None of them opens a form: each creates the study and lands in its
  // conversation with a line already waiting in the composer (plan §9.3).
  it("offers exactly the four the vocabulary names, each with what it produces", async () => {
    draw();
    await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机");
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

  it("creates the study and lands in its conversation with the starting line, not a form", async () => {
    draw();
    await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机");
    await userEvent.click(screen.getByRole("button", { name: /模拟临床试验/ }));
    await waitFor(() => expect(client.createVcrStudy).toHaveBeenCalledWith({ action: "trial" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/chat"));
    expect(screen.getByTestId("draft").textContent).toContain("模拟几个试验方案");
    // No form page anywhere on the way.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("新建研究 creates a study with no starting point chosen", async () => {
    draw();
    await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机");
    await userEvent.click(screen.getByRole("button", { name: "新建研究" }));
    await waitFor(() => expect(client.createVcrStudy).toHaveBeenCalledWith({}));
  });
});

describe("the study list", () => {
  it("shows the question, the data tier, the latest conclusion and what needs attention", async () => {
    draw();
    expect(await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机")).toBeInTheDocument();
    expect(screen.getByText("单臂 II 期加外部对照行不行，还是必须做随机？")).toBeInTheDocument();
    expect(screen.getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.getByText(/成功把握 71%/)).toBeInTheDocument();
    expect(screen.getByText("有限制地估计")).toBeInTheDocument();
    expect(screen.getByText("3 条关键假设由 AI 设定")).toBeInTheDocument();
    expect(screen.getByText("1 个结果已过期")).toBeInTheDocument();
  });

  it("counts the seven steps and names the one being worked on", async () => {
    client.getVcrHome.mockResolvedValue({
      studies: [studySummary({ steps: { definition: { status: "done" }, population: { status: "running" } } })],
    });
    draw();
    expect(await screen.findByText("人群 · 进行中")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "七步中已完成 1 步" })).toBeInTheDocument();
  });

  it("says so rather than showing an empty page when there is no study yet", async () => {
    client.getVcrHome.mockResolvedValue({ studies: [] });
    draw();
    expect(await screen.findByText("还没有研究")).toBeInTheDocument();
  });

  it("offers 重试 when the list cannot be read", async () => {
    client.getVcrHome.mockRejectedValueOnce(new Error("offline"));
    draw();
    const retry = await screen.findByRole("button", { name: "重试" });
    client.getVcrHome.mockResolvedValue({ studies: [studySummary()] });
    await userEvent.click(retry);
    expect(await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机")).toBeInTheDocument();
  });
});

describe("招募待办", () => {
  // Only for an account whose routes sent it: a role thing, not everyone's.
  it("is absent when the server sent none", async () => {
    draw();
    await screen.findByText("EV-201 二线 NSCLC：单臂 II 期还是随机");
    expect(screen.queryByText("招募待办")).not.toBeInTheDocument();
  });

  it("is a column of its own when the account has a recruiting role", async () => {
    client.getVcrHome.mockResolvedValue({
      studies: [studySummary()],
      todos: [{ id: "t1", kind: "contact", title: "P-0192 等 4 人待确认联系", detail: "P-0192 · P-0217", studyId: "std_1", action: { label: "去确认", tab: "matching" } }],
    });
    draw();
    expect(await screen.findByText("招募待办")).toBeInTheDocument();
    expect(screen.getByText("P-0192 等 4 人待确认联系")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去确认" })).toHaveAttribute("href", "/app/virtual-research/std_1/matching");
  });
});

describe("the home's three views", () => {
  it("keeps the chosen view in the address so it can be linked to", async () => {
    draw("/app/virtual-research?tab=models");
    expect(await screen.findByRole("tab", { name: "模型与方法" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(client.getVcrModels).toHaveBeenCalled());
    // The study list is still read: the 研究 tab carries its count, and
    // switching back should not re-open a spinner.
    await waitFor(() => expect(client.getVcrHome).toHaveBeenCalled());
    expect(screen.queryByText("EV-201 二线 NSCLC：单臂 II 期还是随机")).not.toBeInTheDocument();
  });

  it("opens 试验先例 without asking for the study list", async () => {
    draw("/app/virtual-research?tab=precedents");
    await waitFor(() => expect(client.getVcrPrecedents).toHaveBeenCalled());
  });
});
