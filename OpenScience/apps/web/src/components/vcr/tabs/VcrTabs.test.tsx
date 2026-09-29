import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewTab } from "./OverviewTab";
import { PopulationTab } from "./PopulationTab";
import { PatientsTab } from "./PatientsTab";
import { ComparatorTab } from "./ComparatorTab";
import { TrialTab } from "./TrialTab";
import { MatchingTab } from "./MatchingTab";
import { DataTab } from "./DataTab";
import { comparator, counts, data, matching, patients, population, study, trial, value } from "../__fixtures__/vcrStudy";

const client = vi.hoisted(() => ({
  getVcrPopulation: vi.fn(),
  getVcrPatients: vi.fn(),
  getVcrComparator: vi.fn(),
  getVcrTrial: vi.fn(),
  getVcrMatching: vi.fn(),
  getVcrData: vi.fn(),
  contactVcrReferral: vi.fn(),
  recordVcrDecision: vi.fn(),
  runVcrStep: vi.fn(),
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

const props = { studyId: "std_1", study: study() };
const draw = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  client.getVcrPopulation.mockResolvedValue(population());
  client.getVcrPatients.mockResolvedValue(patients());
  client.getVcrComparator.mockResolvedValue(comparator());
  client.getVcrTrial.mockResolvedValue(trial());
  client.getVcrMatching.mockResolvedValue(matching());
  client.getVcrData.mockResolvedValue(data());
  client.runVcrStep.mockResolvedValue({ sessionId: "ses_1" });
});

describe("总览", () => {
  it("leads with the sentence the study came to, not with a description of the page", () => {
    draw(<OverviewTab {...props} />);
    expect(screen.getByText(/方案 B（2:1 随机，180 例）在当前证据下成功把握 71%/)).toBeInTheDocument();
    expect(screen.queryByText(/本页展示/)).not.toBeInTheDocument();
  });

  it("gives every number its source, its named interval and its review state", () => {
    draw(<OverviewTab {...props} />);
    expect(screen.getByText("汇总")).toBeInTheDocument();
    expect(screen.getByText("AI 设定")).toBeInTheDocument();
    expect(screen.getAllByText(/预测区间 3.0–5.6/).length).toBeGreaterThan(0);
    expect(screen.getByText("±0.40")).toBeInTheDocument();
  });

  it("gives a route that cannot be estimated a tile with its word, not a blank", () => {
    draw(<OverviewTab {...props} />);
    expect(screen.getByText("不可估计")).toBeInTheDocument();
  });

  it("fixes the four counts on the page", () => {
    draw(<OverviewTab {...props} />);
    for (const label of ["真实患者数", "事件数", "有效样本量", "生成记录数"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("names the three things to look at, and links each to where it is", () => {
    draw(<OverviewTab {...props} />);
    expect(screen.getByText("3 条关键假设由 AI 设定")).toBeInTheDocument();
    expect(screen.getAllByText("对照组中位 PFS").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "去复核" })).toHaveAttribute("href", "/app/virtual-research/std_1/data");
  });
});

describe("人群", () => {
  it("gives every rule three counts: kept, excluded and undecidable", async () => {
    draw(<PopulationTab {...props} />);
    await screen.findAllByText("一线含免疫治疗");
    expect(screen.getAllByText("保留").length).toBeGreaterThan(0);
    expect(screen.getByText("无法判断")).toBeInTheDocument();
    // 611 excluded and 22 undecidable are different facts about I6.
    expect(screen.getByText("611")).toBeInTheDocument();
    expect(screen.getByText("22")).toBeInTheDocument();
  });

  it("keeps 可能符合 apart from 不符合 in the outcome", async () => {
    draw(<PopulationTab {...props} />);
    expect(await screen.findByText("57")).toBeInTheDocument();
    expect(screen.getByText("612")).toBeInTheDocument();
    expect(screen.getByText("2,743")).toBeInTheDocument();
  });

  it("flags a covariate past the balance floor rather than printing it plain", async () => {
    draw(<PopulationTab {...props} />);
    await screen.findByText("既往免疫治疗");
    expect(screen.getByText("0.31")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /既往免疫治疗 标准化差异 0.31，超过界值/ })).toBeInTheDocument();
  });

  it("says why the undecidable ones cannot be judged", async () => {
    draw(<PopulationTab {...props} />);
    expect(await screen.findByText("证据超过时效")).toBeInTheDocument();
    expect(screen.getByText("291")).toBeInTheDocument();
  });

  it("offers 让 AI 做 when the step has produced nothing", async () => {
    client.getVcrPopulation.mockResolvedValue(population({ criteria: [], attrition: [], profile: [] }));
    draw(<PopulationTab {...props} study={study({ steps: { population: { status: "none" } } })} />);
    await userEvent.click(await screen.findByRole("button", { name: "让 AI 做" }));
    await waitFor(() => expect(client.runVcrStep).toHaveBeenCalledWith("std_1", "population"));
  });
});

describe("虚拟患者", () => {
  it("states the model's tier and the highest use its output can carry", async () => {
    draw(<PatientsTab {...props} />);
    expect(await screen.findByText("文献模型")).toBeInTheDocument();
    expect(screen.getByText("预期用途上限")).toBeInTheDocument();
    expect(screen.getByText("研究设计支持")).toBeInTheDocument();
  });

  it("draws a model's output as a band and says so under the chart", async () => {
    const { container } = draw(<PatientsTab {...props} />);
    await screen.findByText(/两种情景下的推演/);
    expect(container.querySelector("[data-vcr-band='prediction']")).not.toBeNull();
    expect(screen.getByText(/浅色带为模型的预测区间/)).toBeInTheDocument();
  });

  it("says what two scenarios of one virtual patient are, and are not", async () => {
    draw(<PatientsTab {...props} />);
    expect(await screen.findByText(/个体的两个结局不可能同时被观察到/)).toBeInTheDocument();
    expect(screen.getAllByText("合成").length).toBeGreaterThan(0);
  });

  it("says a binary panel is a model prediction rather than an observation", async () => {
    draw(<PatientsTab {...props} />);
    expect(await screen.findByText("模型预测，非观察")).toBeInTheDocument();
  });
});

describe("对照", () => {
  it("draws a reconstructed curve dashed, always, and says so", async () => {
    const { container } = draw(<ComparatorTab {...props} />);
    await screen.findByText(/文献对照有限制地可用/);
    const curve = container.querySelector("[data-vcr-curve='s1']");
    expect(curve?.getAttribute("data-vcr-curve-source")).toBe("reconstructed");
    expect(curve?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(screen.getByText(/虚线为从已发表图表重建的伪个体数据，不是观察到的曲线/)).toBeInTheDocument();
  });

  it("shows the reconstruction's own quality control beside the estimate", async () => {
    draw(<ComparatorTab {...props} />);
    expect(await screen.findByText("重建质控")).toBeInTheDocument();
    expect(screen.getByText("2 / 2 通过")).toBeInTheDocument();
    expect(screen.getByText("各时点风险人数")).toBeInTheDocument();
  });

  it("writes 「不可估计」 as a card with the gaps and what each would answer", async () => {
    draw(<ComparatorTab {...props} />);
    expect(await screen.findByText("真实外部对照：不可估计")).toBeInTheDocument();
    expect(screen.getByText("缺 3 项数据")).toBeInTheDocument();
    expect(screen.getByText("换药按治疗策略处理，伴随事件与试验一致")).toBeInTheDocument();
    expect(screen.getByText(/三项补齐后可估计/)).toBeInTheDocument();
  });

  // The three states are three states: the method's conclusion, the review
  // state, and the run state are never each other.
  it("says the scientific conclusion and the review state apart", async () => {
    const { container } = draw(<ComparatorTab {...props} />);
    await screen.findByText(/文献对照有限制地可用/);
    const verdict = container.querySelector("[data-vcr-verdict]");
    expect(verdict?.textContent).toContain("有限制地估计");
    expect(verdict?.textContent).toContain("AI 设定");
    expect(verdict?.textContent).toContain("未复核");
  });

  it("names a route that cannot apply here with its reason", async () => {
    draw(<ComparatorTab {...props} />);
    expect(await screen.findByText("预后校正")).toBeInTheDocument();
    expect(screen.getByText("不适用")).toBeInTheDocument();
    expect(screen.getByText("单臂设计无随机数据")).toBeInTheDocument();
  });
});

describe("试验", () => {
  it("prints the Monte-Carlo standard error beside every simulated number", async () => {
    draw(<TrialTab {...props} />);
    await screen.findAllByText("方案的运行特征");
    expect(screen.getAllByText("±0.40").length).toBeGreaterThan(0);
    expect(screen.getByText("± 为蒙特卡洛标准误")).toBeInTheDocument();
  });

  it("gives a dominated design no numbers, only the reason", async () => {
    const { container } = draw(<TrialTab {...props} />);
    await screen.findAllByText("方案的运行特征");
    const row = container.querySelector("[data-vcr-design='D']");
    expect(row).toHaveAttribute("data-vcr-dominated");
    expect(row?.textContent).toContain("被 C 占优");
    expect(row?.textContent).not.toContain("%");
  });

  it("never picks a design: 选定方案 waits for the reader", async () => {
    draw(<TrialTab {...props} />);
    const save = await screen.findByRole("button", { name: "写入决策记录" });
    expect(save).toBeDisabled();
    expect(screen.getByText("平台不自动选定方案。")).toBeInTheDocument();
    client.recordVcrDecision.mockResolvedValue({});
    await userEvent.click(screen.getByRole("radio", { name: "B" }));
    await userEvent.click(save);
    await waitFor(() => expect(client.recordVcrDecision).toHaveBeenCalledWith("std_1", { chosen: "d_b" }));
  });

  it("marks a scenario value as an assumption on the power curve", async () => {
    draw(<TrialTab {...props} />);
    await screen.findByText(/功效随真实效应的变化/);
    expect(screen.getByText("目标 HR 0.60")).toBeInTheDocument();
    expect(screen.getByText("假设")).toBeInTheDocument();
  });
});

describe("匹配与招募", () => {
  it("keeps 未知 apart from 不符合 on every rule", async () => {
    const { container } = draw(<MatchingTab {...props} />);
    await screen.findAllByText("P-0192");
    expect(container.querySelector("[data-vcr-criterion='E3']")).toHaveAttribute("data-vcr-criterion-state", "unknown");
    expect(container.querySelector("[data-vcr-criterion='I1']")).toHaveAttribute("data-vcr-criterion-state", "satisfied");
  });

  it("says why somebody cannot be judged eligible, rather than a bare no", async () => {
    const { container } = draw(<MatchingTab {...props} />);
    await screen.findAllByText("P-0192");
    expect(container.querySelector("[data-vcr-eligibility]")?.textContent).toContain("不能判为符合：排除标准 E3 未知");
    expect(screen.getByText("申请近 4 周头颅 MRI")).toBeInTheDocument();
  });

  // The one human stop in the module: contacting a person is outside the
  // platform and cannot be undone.
  it("asks a coordinator to confirm before anyone is contacted", async () => {
    draw(<MatchingTab {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "确认后联系" }));
    expect(await screen.findByText(/联系真实患者是平台之外、不可撤回的动作/)).toBeInTheDocument();
    expect(client.contactVcrReferral).not.toHaveBeenCalled();
    client.contactVcrReferral.mockResolvedValue({});
    await userEvent.click(screen.getByRole("button", { name: "确认联系" }));
    await waitFor(() => expect(client.contactVcrReferral).toHaveBeenCalledWith("std_1", "P-0192"));
  });

  it("switches to the referral ledger without leaving the tab", async () => {
    client.getVcrMatching.mockImplementation((_id: string, query?: Record<string, string>) => Promise.resolve(
      query?.view === "referral"
        ? matching({ view: "referral", ledger: [{ state: "contactable", count: 9, note: "4 人待你确认", waiting: true }], candidates: [], selected: null })
        : matching(),
    ));
    draw(<MatchingTab {...props} />);
    await screen.findAllByText("P-0192");
    await userEvent.click(screen.getByRole("radio", { name: "转诊" }));
    expect(await screen.findByText("可联系")).toBeInTheDocument();
    expect(screen.getByText("4 人待你确认")).toBeInTheDocument();
  });
});

describe("数据与证据", () => {
  it("draws the pooled estimate and the prediction interval as separate rows", async () => {
    const { container } = draw(<DataTab {...props} />);
    await screen.findByText("随机效应合并");
    expect(container.querySelector("[data-vcr-forest-row='pooled']")).not.toBeNull();
    expect(container.querySelector("[data-vcr-forest-row='pred']")?.textContent).toContain("预测区间");
  });

  it("shows the sentence a value was read out of, and where it is from", async () => {
    draw(<DataTab {...props} />);
    expect(await screen.findByText("“多西他赛组中位 PFS 为 4.0 个月（95% CI 3.3–4.2）”")).toBeInTheDocument();
    expect(screen.getByText("— 某试验 2024，第 6 页，表 2")).toBeInTheDocument();
  });

  it("names what the value is used by, and what changed between versions", async () => {
    draw(<DataTab {...props} />);
    expect(await screen.findByText("被这些结果使用")).toBeInTheDocument();
    expect(screen.getByText("人群 v3")).toBeInTheDocument();
    expect(screen.getByText("新增 CTR20990001（2024，中国人群）")).toBeInTheDocument();
  });

  it("opens another card without leaving the tab", async () => {
    draw(<DataTab {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: /目标 HR/ }));
    expect(await screen.findByText("情景假设 · 敏感性范围 0.50–0.75")).toBeInTheDocument();
  });

  it("keeps a precedent's planned and actual enrolment apart", async () => {
    draw(<DataTab {...props} />);
    await screen.findByText("CTR20990001");
    const row = screen.getByText("CTR20990001").closest("tr");
    expect(within(row!).getByText("420")).toBeInTheDocument();
    expect(within(row!).getByText("426")).toBeInTheDocument();
    expect(screen.getByText(/历史基准只用实际值/)).toBeInTheDocument();
  });
});

describe("a stale result", () => {
  it("stays on screen, greyed, under the bar that says a recomputation is queued", () => {
    draw(
      <OverviewTab
        studyId="std_1"
        study={study({
          overview: {
            ...study().overview,
            metrics: [{ key: "assurance", label: "方案 B 成功把握", value: value({ value: 71, unit: "%", source: "predicted", stale: true }) }],
            counts: counts(),
          },
        })}
      />,
    );
    expect(screen.getByText("71")).toBeInTheDocument();
  });
});
