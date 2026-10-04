import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { readVcrStudy } from "@/lib/vcrClient";
import { cpuTimeText, VcrBudgetDialog } from "./VcrBudgetDialog";
import { VcrModelsPanel } from "./VcrModelsPanel";
import { runFilePath, VcrPackageReader } from "./VcrPackageReader";
import { VcrPrecedentsPanel } from "./VcrPrecedentsPanel";
import { fixture, installVcrServer, STUDY_ID } from "./__fixtures__/serverFixtures";

// Only the network is doubled; every payload is the server's own fixture, or
// a copy of one with one field changed.
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: toasts }));

const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);
const off = () => { throw new WebApiError("off", { status: 404, code: "vcr_not_enabled" }); };

let server: ReturnType<typeof installVcrServer>;

beforeEach(() => {
  server = installVcrServer(network.productRequest);
  toasts.success.mockReset();
  toasts.error.mockReset();
});

/* ------------------------------------------------------------------ 模型与方法 */

describe("模型与方法", () => {
  const card = () => document.querySelector("[data-vcr-model-card]")?.closest("section") as HTMLElement;

  it("shows current numerical evidence with its source and leaves other methods unmeasured", async () => {
    const payload = fixture("ev201/models.json");
    Object.assign(payload.methods[0], { numeric: '1 个参考用例通过', validation: { status: 'passed', ciUrl: 'https://example.org/ci/101' },
      assumptions: [{ text: 'Constant event rate in the declared interval.', source: 'R/example.R:10' }] });
    Object.assign(payload.methods[1], { numeric: null, validation: { status: 'unmeasured' }, assumptions: [] });
    installVcrServer(network.productRequest, { "GET /vcr/models": payload });
    draw(<VcrModelsPanel />);
    expect(await screen.findByRole('link', { name: '查看验证来源' })).toHaveAttribute('href', 'https://example.org/ci/101');
    expect(screen.getByText('1 个参考用例通过')).toBeInTheDocument();
    expect(screen.getAllByText('当前版本尚无已核对的参考用例').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText('查看假设及来源'));
    expect(screen.getByText('Constant event rate in the declared interval.')).toBeVisible();
  });

  // UI-19: a one-shot prediction from baseline has a name of its own and is
  // never shown as 「不适用」.
  it("names a baseline-conditioned model's output as such, with what it lacks to be a twin", async () => {
    draw(<VcrModelsPanel />);
    expect(await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" })).toBeInTheDocument();
    const twin = card().querySelector("[data-vcr-twin]") as HTMLElement;
    expect(twin).toHaveTextContent("基线条件化预测");
    expect(twin).toHaveTextContent("缺少：以个体为条件、随新数据更新、不确定性已校准、验证记录");
    expect(card().textContent).not.toContain("不适用");
  });

  it("names the call shape of a model, and for the event-history shape what it reads, how far it projects and what its card still lacks", async () => {
    const payload = fixture("ev201/models.json");
    expect(payload.models[0].shapeLabel).toBe("基线 → 结局分布");
    Object.assign(payload.models[1], {
      shape: "event_history_to_trajectories", shapeLabel: "事件历史 → 未来轨迹", events: ["诊断", "处方"], horizon: "24 months", trajectoriesMax: 500,
      shapeMissing: ["事件历史 → 未来轨迹接口的模型卡缺「已知局限」"],
    });
    server = installVcrServer(network.productRequest, { "GET /vcr/models": payload });
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    expect(within(card()).getByText("调用接口").nextElementSibling).toHaveTextContent("基线 → 结局分布");
    expect(card().querySelector("[data-vcr-model-shape-missing]")).toBeNull();
    await userEvent.click(document.querySelector("[data-vcr-model='mdl_2']") as HTMLElement);
    await screen.findByRole("heading", { name: "二分类终点参考仿真器" });
    const facts = within(card());
    expect(facts.getByText("调用接口").nextElementSibling).toHaveTextContent("事件历史 → 未来轨迹");
    expect(facts.getByText("读取的事件").nextElementSibling).toHaveTextContent("诊断、处方");
    expect(facts.getByText("最长推演时间").nextElementSibling).toHaveTextContent("24 months");
    expect(facts.getByText("每份历史最多轨迹数").nextElementSibling).toHaveTextContent("500");
    expect(card().querySelector("[data-vcr-model-shape-missing]")).toHaveTextContent("缺「已知局限」");
  });

  it("says 数字孪生 only for a model that has earned it", async () => {
    const payload = fixture("ev201/models.json");
    Object.assign(payload.models[0], { twin: "digital_twin", twinLabel: null, twinReason: null });
    server = installVcrServer(network.productRequest, { "GET /vcr/models": payload });
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    expect(card().querySelector("[data-vcr-twin]")).toHaveTextContent("数字孪生");
  });

  it("gives the card's §8.2 sections, the regional population on a line of its own", async () => {
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    const facts = within(card());
    expect(facts.getByText("适用地区")).toBeInTheDocument();
    expect(facts.getByText("含中国人群的研究")).toBeInTheDocument();
    expect(facts.getByText("适用人群")).toBeInTheDocument();
    expect(facts.getByText("提供方")).toBeInTheDocument();
    expect(facts.getByText("vcr-engine patients.time_to_event")).toBeInTheDocument();
    expect(facts.getByText("拟合预测")).toBeInTheDocument();
    expect(facts.getByText("中位 PFS、形状参数")).toBeInTheDocument();
    expect(facts.getByText("缺项不插补。")).toBeInTheDocument();
    expect(facts.getByText("来源试验更新时复核。")).toBeInTheDocument();
    // An endpoint key is said in words, never as the key.
    expect(facts.getByText("终点").nextElementSibling).toHaveTextContent(/^事件时间$/);
    expect(facts.getByRole("table", { name: /的验证/ })).toHaveTextContent("重建 QC 通过");
    expect(facts.getByText("还缺的证据")).toBeInTheDocument();
    expect(facts.getByText("敏感性分析")).toBeInTheDocument();
    expect(facts.getByRole("link", { name: "EV-201 二线 NSCLC：单臂 II 期还是随机" })).toHaveAttribute("href", "/app/virtual-research/std_1");
  });

  it("opens another model's card, and lists the method packages by their own rows", async () => {
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    await userEvent.click(document.querySelector("[data-vcr-model='mdl_2']") as HTMLElement);
    expect(await screen.findByRole("heading", { name: "二分类终点参考仿真器" })).toBeInTheDocument();
    expect(document.querySelector("[data-vcr-method='mth_1']")).toHaveTextContent("当前版本尚无已核对的参考用例");
  });

  // UI-27: the ladder is a table, not a sentence about the system.
  it("draws the credibility ladder with no line explaining it", async () => {
    draw(<VcrModelsPanel />);
    expect(await screen.findByText("可信度要求（按用途）")).toBeInTheDocument();
    expect(screen.queryByText(/自动降一级/)).toBeNull();
    expect(document.querySelector("[data-vcr-engine-mismatch]")).toBeNull();
  });

  it("says, quietly, when the engine and the method catalogue disagree", async () => {
    const payload = fixture("ev201/models.json");
    payload.engineMismatch = ["目录有引擎没有：comparator.maic"];
    server = installVcrServer(network.productRequest, { "GET /vcr/models": payload });
    draw(<VcrModelsPanel />);
    expect(await screen.findByText("计算引擎与方法目录不一致：目录有引擎没有：comparator.maic")).toBeInTheDocument();
  });

  // C2-12: the library page is where a model a trial fitted is taken in; before, `POST /api/vcr/models` had no caller in the browser.
  it("takes a literature model into the library: the name, the risk, the endpoint and the trials it was fitted on, then re-reads the list", async () => {
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    await userEvent.click(screen.getByRole("button", { name: "引入文献模型" }));
    await userEvent.type(await screen.findByLabelText("模型名称"), "  EV-201 对照组 PFS 模型 ");
    await userEvent.type(screen.getByLabelText("版本"), "2.1.0");
    await userEvent.selectOptions(screen.getByLabelText("模型风险"), "medium");
    await userEvent.selectOptions(screen.getByLabelText("终点"), "time_to_event");
    await userEvent.type(screen.getByLabelText("来源试验（每行一项）"), "NCT02296125{enter}{enter}  CTR20990001 ");
    const reads = server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/models").length;
    await userEvent.click(screen.getByRole("button", { name: "引入" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/models", "POST", {
      name: "EV-201 对照组 PFS 模型", version: "2.1.0", risk: "medium", endpointType: "time_to_event", sources: ["NCT02296125", "CTR20990001"],
    }));
    expect(toasts.success).toHaveBeenCalledWith("已引入模型库。");
    await waitFor(() => expect(server.calls.filter((call) => call.method === "GET" && call.path === "/vcr/models").length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByLabelText("模型名称")).toBeNull());
  });

  it("never names a tier or a population for the model: the page has no such field to send", async () => {
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    await userEvent.click(screen.getByRole("button", { name: "引入文献模型" }));
    await userEvent.type(await screen.findByLabelText("模型名称"), "m");
    await userEvent.click(screen.getByRole("button", { name: "引入" }));
    await waitFor(() => expect(network.productRequest).toHaveBeenCalledWith("/vcr/models", "POST", { name: "m", risk: "low" }));
    const body = server.calls.find((call) => call.method === "POST")?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["name", "risk"]);
  });

  it("is a request that cannot be sent without a name, and one at a time", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, { "POST /vcr/models": () => new Promise((resolve) => { finish = resolve; }) });
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    await userEvent.click(screen.getByRole("button", { name: "引入文献模型" }));
    expect(await screen.findByRole("button", { name: "引入" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("模型名称"), "m");
    const adopt = screen.getByRole("button", { name: "引入" });
    await userEvent.click(adopt);
    await userEvent.click(adopt);
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    await act(async () => { finish({ id: "mdl_9" }); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("已引入模型库。"));
  });

  it("says a refusal in words and keeps what was typed", async () => {
    server = installVcrServer(network.productRequest, { "POST /vcr/models": () => { throw new WebApiError("exists", { status: 409, code: "vcr_model_exists" }); } });
    draw(<VcrModelsPanel />);
    await screen.findByRole("heading", { name: "二线 NSCLC 多西他赛组 PFS · Weibull" });
    await userEvent.click(screen.getByRole("button", { name: "引入文献模型" }));
    await userEvent.type(await screen.findByLabelText("模型名称"), "重名的模型");
    await userEvent.click(screen.getByRole("button", { name: "引入" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(screen.getByLabelText("模型名称")).toHaveValue("重名的模型");
  });

  it("is the module-off sentence, not an error, when the module is off", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/models": off });
    draw(<VcrModelsPanel />);
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ 试验先例 */

describe("试验先例", () => {
  it("keeps planned and actual apart, and opens a row to the registry's own words", async () => {
    draw(<VcrPrecedentsPanel />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-precedent='CTR20990001']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(screen.getByRole("columnheader", { name: "计划入组" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "实际入组" })).toBeInTheDocument();
    expect(row).toHaveTextContent("420");
    expect(row).toHaveTextContent("426");
    await userEvent.click(within(row).getByRole("button", { expanded: false }));
    const opened = document.querySelector("[data-vcr-precedent-detail='CTR20990001']") as HTMLElement;
    expect(within(opened).getByText("中国")).toBeInTheDocument();
    expect(within(opened).getByText("多西他赛")).toBeInTheDocument();
    expect(within(opened).getByText("无进展生存期（PFS）")).toBeInTheDocument();
    expect(within(opened).getByText("实际")).toBeInTheDocument();
    // The eligibility as written, beside the population it was reduced to.
    expect(within(opened).getByText("人群（标准化）").nextElementSibling).toHaveTextContent("非小细胞肺癌");
    expect(opened.querySelector("[data-vcr-eligibility-text]")).toHaveTextContent("组织学或细胞学确诊的晚期 NSCLC；一线含铂化疗后进展。");
    expect(within(opened).getByRole("link", { name: /打开登记记录/ })).toHaveAttribute("href", "https://example.org/CTR20990001");
  });

  it("never links a source that is not an http(s) address", async () => {
    const payload = fixture("ev201/precedents.json");
    payload.precedents[0].source = "javascript:alert(1)";
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": payload });
    draw(<VcrPrecedentsPanel />);
    const row = await waitFor(() => {
      const found = document.querySelector("[data-vcr-precedent='CTR20990001']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await userEvent.click(within(row).getByRole("button"));
    expect(document.querySelector("[data-vcr-precedent-detail='CTR20990001']")).toHaveTextContent("中国");
    expect(screen.queryByRole("link", { name: /打开登记记录/ })).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });

  // CW-12: `q` is the server's query word.
  it("asks the server with q= on Enter", async () => {
    draw(<VcrPrecedentsPanel />);
    await waitFor(() => expect(document.querySelector("[data-vcr-precedent]")).not.toBeNull());
    await userEvent.type(screen.getByLabelText("搜索先例"), "多西他赛{Enter}");
    await waitFor(() => expect(server.calls.some((call) => new URL(call.path, "http://x").searchParams.get("q") === "多西他赛")).toBe(true));
  });

  // A library that is not composed here is not an empty one.
  it("says the library is not here, in the server's words, with no table that reads as 「没有先例」", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": fixture("ev201/precedents-unavailable.json") });
    draw(<VcrPrecedentsPanel />);
    expect(await screen.findByText("试验先例库在本部署尚未接入。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/没有找到先例|还没有先例/)).toBeNull();
    expect(screen.queryByText("0 项")).toBeNull();
  });

  it("is the module-off sentence when the module is off", async () => {
    server = installVcrServer(network.productRequest, { "GET /vcr/precedents": off });
    draw(<VcrPrecedentsPanel />);
    expect(await screen.findByText("虚拟临研还没有在这个工作空间开放。")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ the package */

describe("the package reader", () => {
  it("prints the cover truthfully — 未复核 included — then the sections, the contents and the file", async () => {
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(screen.getByText("已复核（昨天）")).toBeInTheDocument();
    expect(screen.getByText("未复核")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /研究与分析概要/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "研究包目录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开完整研究包" })).toHaveAttribute("href", "/app/runs/run_12/files/package.pdf");
  });

  // CW-16: a reader with no body promises no numbers to click.
  it("with no sections is the cover and the file, and claims nothing about numbers", async () => {
    const payload = fixture("ev201/export.json");
    payload.document.sections = [];
    server = installVcrServer(network.productRequest, { [`GET /vcr/studies/${STUDY_ID}/export/exp_2`]: payload });
    draw(<VcrPackageReader studyId={STUDY_ID} exportId="exp_2" onBack={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "研究包 v1" })).toBeInTheDocument();
    expect(screen.getByText("未复核")).toBeInTheDocument();
    expect(screen.queryByText(/点开任何一个数字/)).toBeNull();
    expect(screen.queryByRole("navigation", { name: "研究包目录" })).toBeNull();
    expect(screen.getByRole("link", { name: "打开完整研究包" })).toBeInTheDocument();
  });

  it("encodes every segment of the file's path, and drops segments that climb", () => {
    expect(runFilePath("run 1", "out dir/研究包 v1.pdf")).toBe(`/app/runs/run%201/files/out%20dir/${encodeURIComponent("研究包 v1.pdf")}`);
    expect(runFilePath("run_1", "../../admin/x?y#z")).toBe("/app/runs/run_1/files/admin/x%3Fy%23z");
  });
});

/* ------------------------------------------------------------------ the budget */

describe("the compute budget", () => {
  const ev201 = () => readVcrStudy(fixture("ev201/study.json"));
  const dialog = (onSaved = vi.fn()) => {
    const study = ev201();
    draw(<VcrBudgetDialog studyId={STUDY_ID} budget={study.budget} jobs={study.jobs} onClose={() => undefined} onSaved={onSaved} />);
    return screen.getByRole("dialog", { name: "计算预算" });
  };

  it("says CPU time in the unit a reader reads", () => {
    expect(cpuTimeText(45)).toBe("45 秒");
    expect(cpuTimeText(222)).toBe("4 分钟");
    expect(cpuTimeText(7_200)).toBe("2 小时");
    expect(cpuTimeText(9_000)).toBe("2.5 小时");
    expect(cpuTimeText(null)).toBe("—");
  });

  it("shows used, what running work has reserved and the limit in time, and the job that waits with what it needs — never money", () => {
    const panel = dialog();
    for (const [label, value] of [["已用", "4 分钟"], ["运行中预留", "0 秒"], ["上限", "2 小时"]]) {
      expect(within(panel).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(panel.querySelector("[data-vcr-budget-job='job_seed_17']")).toHaveTextContent("设计网格需要 2.5 小时 CPU 时间");
    expect(panel.textContent).not.toMatch(/¥|元/);
    // UI-27: no paragraph explaining the budget.
    expect(panel.textContent).not.toMatch(/不会被静默降级/);
  });

  it("releases one job by its id, all of them by the time they need, and adds time in minutes", async () => {
    const onSaved = vi.fn();
    const panel = dialog(onSaved);
    const row = panel.querySelector("[data-vcr-budget-job='job_seed_17']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await userEvent.click(within(panel).getByRole("button", { name: "全部确认" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    await userEvent.type(within(panel).getByLabelText("增加计算时间（分钟）"), "30");
    await userEvent.click(within(panel).getByRole("button", { name: "增加" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3));
    expect(server.calls.map((call) => call.body)).toEqual([{ jobId: "job_seed_17" }, { cpuSeconds: 9000 }, { cpuSeconds: 1800 }]);
    expect(server.calls.every((call) => call.method === "POST" && call.path === `/vcr/studies/${STUDY_ID}/budget`)).toBe(true);
  });

  it("sends one confirmation however often it is pressed while the first is in flight", async () => {
    let finish: (value: unknown) => void = () => undefined;
    server = installVcrServer(network.productRequest, {
      [`POST /vcr/studies/${STUDY_ID}/budget`]: () => new Promise((resolve) => { finish = resolve; }),
    });
    const panel = dialog();
    const all = within(panel).getByRole("button", { name: "全部确认" });
    await userEvent.click(all);
    await userEvent.click(all);
    await userEvent.click(within(panel.querySelector("[data-vcr-budget-job='job_seed_17']") as HTMLElement).getByRole("button"));
    expect(server.calls).toHaveLength(1);
    await act(async () => { finish({ released: [], budget: null }); });
  });
});
