import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrStudyPage } from "./VcrStudyPage";
import { comparator, data, matching, patients, population, study, trial } from "@/components/vcr/__fixtures__/vcrStudy";

const client = vi.hoisted(() => ({
  getVcrStudy: vi.fn(),
  getVcrPopulation: vi.fn(),
  getVcrPatients: vi.fn(),
  getVcrComparator: vi.fn(),
  getVcrTrial: vi.fn(),
  getVcrMatching: vi.fn(),
  getVcrData: vi.fn(),
  getVcrExport: vi.fn(),
  exportVcrStudy: vi.fn(),
  patchVcrStudy: vi.fn(),
  deleteVcrStudy: vi.fn(),
  confirmVcrBudget: vi.fn(),
  runVcrStep: vi.fn(),
  useVcrFeature: vi.fn(() => "on"),
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
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function draw(path = "/app/virtual-research/std_1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research/:studyId/:tab?" element={<><VcrStudyPage /><Probe /></>} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(client)) if (typeof fn.mockReset === "function") fn.mockReset();
  client.useVcrFeature.mockReturnValue("on");
  client.getVcrStudy.mockResolvedValue(study());
  client.getVcrPopulation.mockResolvedValue(population());
  client.getVcrPatients.mockResolvedValue(patients());
  client.getVcrComparator.mockResolvedValue(comparator());
  client.getVcrTrial.mockResolvedValue(trial());
  client.getVcrMatching.mockResolvedValue(matching());
  client.getVcrData.mockResolvedValue(data());
  client.exportVcrStudy.mockResolvedValue({ sessionId: "ses_1" });
  store.select.mockClear();
});

describe("the study page's header", () => {
  it("carries the study's name, its data tier and what its results may be used for", async () => {
    draw();
    expect(await screen.findByRole("heading", { name: "EV-201 二线 NSCLC：单臂 II 期还是随机" })).toBeInTheDocument();
    expect(screen.getByText("T0 公开资料")).toBeInTheDocument();
    expect(screen.getByText("研究设计支持")).toBeInTheDocument();
  });

  // The rail is the seven steps of the programme, with what each produced; the
  // tabs are the reader's questions. They are not the same list.
  it("draws the seven steps as one rail, each linking to the tab that holds its result", async () => {
    draw();
    const rail = await screen.findByRole("list", { name: "七步进度" });
    const steps = within(rail).getAllByRole("listitem");
    expect(steps).toHaveLength(7);
    expect(within(rail).getByText("12 张假设卡")).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: /证据/ })).toHaveAttribute("href", "/app/virtual-research/std_1/data");
    expect(steps.at(-1)).toHaveAttribute("data-rail-state", "todo");
  });

  it("offers exactly the seven tabs the vocabulary names", async () => {
    draw();
    await screen.findByRole("heading", { name: /EV-201/ });
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["总览", "人群", "虚拟患者", "对照", "试验", "匹配与招募", "数据与证据"]);
  });

  // 2026-09-20 ruling: the tools hang off the one composer, so the study page
  // grows no second one. 「对话」 is the only way into the conversation.
  it("has no composer of its own: 对话 opens the study's conversation", async () => {
    draw();
    await screen.findByRole("heading", { name: /EV-201/ });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /对话/ }));
    await waitFor(() => expect(store.select).toHaveBeenCalledWith("prj_1", expect.any(Function)));
  });
});

describe("the study page's addresses", () => {
  it("shows 总览 when the address names no tab", async () => {
    draw();
    expect(await screen.findByText(/成功把握 71%/)).toBeInTheDocument();
  });

  it("opens the tab the address names", async () => {
    draw("/app/virtual-research/std_1/trial");
    await waitFor(() => expect(client.getVcrTrial).toHaveBeenCalledWith("std_1"));
    expect(await screen.findByRole("tab", { name: "试验" })).toHaveAttribute("aria-selected", "true");
  });

  it("rewrites a step name to the tab that holds it, in place", async () => {
    draw("/app/virtual-research/std_1/evidence");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/virtual-research/std_1/data"));
  });

  it("says a study is gone rather than showing an error", async () => {
    client.getVcrStudy.mockRejectedValue(new WebApiError("gone", { status: 404, code: "vcr_study_not_found" }));
    draw();
    expect(await screen.findByText("这个研究不存在或已删除。")).toBeInTheDocument();
  });

  it("falls back to the module-off sentence when the route says the module is off", async () => {
    client.getVcrStudy.mockRejectedValue(new WebApiError("off", { status: 404, code: "vcr_not_enabled" }));
    draw();
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

describe("the study package", () => {
  // A package is read on the study's own address, so a link to it carries the
  // study around it rather than opening a page with no context.
  it("opens in the reader from 交付物, and closes back to the tabs", async () => {
    client.getVcrExport.mockResolvedValue({
      id: "exp_1", kind: "study_package", title: "EV-201 二线 NSCLC 研究设计包", meta: "今天 14:32 · PDF · 42 页",
      document: {
        status: [{ label: "统计复核", value: "未复核", state: "attention" }],
        sections: [{ id: "s1", number: "1", title: "研究与分析概要", body: "本研究包回答……" }],
      },
    });
    draw();
    await userEvent.click(await screen.findByRole("link", { name: "研究包 v2" }));
    await waitFor(() => expect(client.getVcrExport).toHaveBeenCalledWith("std_1", "exp_1"));
    expect(await screen.findByRole("heading", { name: "EV-201 二线 NSCLC 研究设计包" })).toBeInTheDocument();
    // 未复核 is printed rather than hidden: an export is never blocked for a
    // missing review, and a package that stayed quiet would be claiming a
    // standing it has not got.
    expect(screen.getByText("未复核")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "研究包目录" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "人群" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /返回研究/ }));
    expect(await screen.findByRole("tab", { name: "人群" })).toBeInTheDocument();
  });
});

describe("the 「⋯」 menu", () => {
  it("exports the study package into the study's own conversation", async () => {
    draw();
    await screen.findByRole("heading", { name: /EV-201/ });
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "导出研究包" }));
    await waitFor(() => expect(client.exportVcrStudy).toHaveBeenCalledWith("std_1", "study_package"));
  });

  // The second of the three human stops: more compute than the study's budget.
  it("opens the compute budget with what is already spent beside the ceiling", async () => {
    draw();
    await screen.findByRole("heading", { name: /EV-201/ });
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "设定计算预算" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¥ 128.40")).toBeInTheDocument();
    client.confirmVcrBudget.mockResolvedValue({});
    await userEvent.clear(within(dialog).getByLabelText("新的上限（元）"));
    await userEvent.type(within(dialog).getByLabelText("新的上限（元）"), "800");
    await userEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(client.confirmVcrBudget).toHaveBeenCalledWith("std_1", { limitCny: 800 }));
  });

  it("asks before deleting, and says what goes with it", async () => {
    draw();
    await screen.findByRole("heading", { name: /EV-201/ });
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(await screen.findByText(/这个研究的对话、文件、假设卡/)).toBeInTheDocument();
    expect(client.deleteVcrStudy).not.toHaveBeenCalled();
  });
});
