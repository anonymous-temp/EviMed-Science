import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { VcrMethodResult } from "./VcrMethodResult";
import { VcrMethodResultCharts, readMethodResultSeries } from "./VcrMethodResultCharts";
import { DistributionGrid } from "./patients/DistributionGrid";
import type { VcrGeneratedRow } from "@/lib/vcrClient";
const api = vi.hoisted(() => ({ getVcrMethodResult: vi.fn(), getVcrPatients: vi.fn(), getVcrTrial: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
beforeEach(() => vi.clearAllMocks());
it("labels generated counts and formats distribution percentages without altering retained values or suppressed levels", async () => {
  const percent = 0.575 * 100;
  const profile: VcrGeneratedRow = { key: "y", variable: "y", label: "结局", kind: "binary", histogram: null, mean: null, sd: null, missing: null, declared: null, declaredSpec: null,
    result: null, n: 40, median: null, q1: null, q3: null, min: null, max: null, violations: null, outOfBounds: false,
    levels: [{ level: "0", label: "未发生", n: 23, percent, suppressed: false }, { level: "1", label: "已发生", n: 17, percent: 42.5, suppressed: false }, { level: "unknown", label: "未知", n: null, percent: 1.2, suppressed: true }] };
  api.getVcrMethodResult.mockResolvedValue({ jobId: "binary_job", result: { id: "binary_result", kind: "patient_set", measures: [{ name: "generated_records", value: 40, source: "synthetic" }], diagnostics: {} }, execution: { method: "patients.binary" }, records: { available: false, profile: [profile] } });
  render(<VcrMethodResult studyId="study_1" job={{ id: "binary_job", kind: "generate_patients_binary", state: "succeeded" }} />);
  expect(await screen.findByRole("table", { name: "本次计算指标" })).toHaveTextContent("生成记录");
  expect(screen.queryByText("generated_records")).toBeNull();
  const { container } = render(<DistributionGrid rows={[profile]} />);
  expect(container).toHaveTextContent("57.5%");
  expect(container).not.toHaveTextContent("57.499999");
  expect(container).toHaveTextContent("小样本已隐藏");
  expect(container).not.toHaveTextContent("1.2%");
  expect(profile.levels?.[0].percent).toBe(percent);
});
it("reads only the addressed historical job and preserves a partial result with its source version", async () => {
  api.getVcrMethodResult.mockResolvedValue({ jobId: "old_job", result: { id: "old_result", kind: "comparator", conclusion: "limited", measures: [{ name: "risk_ratio", value: 1.5, source: "calculated" }], diagnostics: {} }, execution: { method: "comparator.evalue", methodVersion: "1.0.0", seed: 987, sourceModel: { id: "old_model", version: "2.1.0" } }, records: { available: false, state: "unavailable" } });
  render(<MemoryRouter><VcrMethodResult studyId="study_1" job={{ id: "old_job", kind: "evalue", state: "failed", error: { code: "budget", message: "Stopped", partial: true } }} /></MemoryRouter>);
  expect(await screen.findByRole("table", { name: "本次计算指标" })).toHaveTextContent("1.5");
  expect(screen.getByText(/这次运行没有完整结束/)).toBeInTheDocument();
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_1", "old_job"));
  expect(api.getVcrPatients).not.toHaveBeenCalled(); expect(api.getVcrTrial).not.toHaveBeenCalled();
  expect(screen.getByText("2.1.0")).toBeInTheDocument();
});
it("reuses survival, balance, grid and recruitment plots only when the job contains their actual values", () => {
  const series = [{ key: "treated", label: "模拟干预组", source: "synthetic", points: [{ x: 0, y: 1 }, { x: 12, y: 0.7 }] }];
  const { container } = render(<VcrMethodResultCharts method="patients.time_to_event" result={{ id: "result_1", kind: "patient_set", diagnostics: { trajectories: { series }, balance: [{ covariate: "Age", smdAdjusted: 0.04, smdUnadjusted: 0.2 }], cells: [{ designIndex: 1, truthIndex: 1, measures: [{ name: "power", value: 0.81 }] }] }, measures: [{ name: "last_patient_in_months", value: 18, interval: { kind: "prediction", low: 15, high: 24, level: 0.9 } }] }} />);
  expect(screen.getByRole("heading", { name: "结局轨迹" })).toBeInTheDocument();
  expect(container.querySelector("[data-vcr-balance]")).toBeInTheDocument();
  expect(screen.getByText("81.0%")).toBeInTheDocument();
  expect(container.querySelector("[data-vcr-milestones]")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "设计性能曲线" })).toBeNull();
});
it("does not label forecast evaluation metrics as predicted outcomes", async () => {
  api.getVcrMethodResult.mockResolvedValue({ jobId: "evaluation_job", result: { id: "evaluation", kind: "longitudinal", measures: [{ name: "rmse", label: "均方根误差", value: 0.12 }], diagnostics: {} }, execution: { method: "forecast.evaluate" }, records: { available: false } });
  render(<VcrMethodResult studyId="study_1" job={{ id: "evaluation_job", kind: "evaluate_forecast", state: "succeeded" }} />);
  expect(await screen.findByRole("table", { name: "本次计算指标" })).toHaveTextContent("0.12");
  expect(screen.queryByText("预测", { exact: true })).toBeNull();
  expect(screen.getByText("计算", { exact: true })).toBeInTheDocument();
});
it("uses one grid metric across all cells and leaves a different metric missing", () => {
  render(<VcrMethodResultCharts method="design.grid" result={{ id: "grid", kind: "design_grid", diagnostics: { cells: [{ designIndex: 1, truthIndex: 1, measures: [{ name: "power", value: 0.8 }] }, { designIndex: 1, truthIndex: 2, measures: [{ name: "type_one_error", value: 0.05 }] }] } }} />);
  expect(screen.getByRole("heading", { name: "设计与效应情景 · 把握度" })).toBeInTheDocument(); expect(screen.getByText("80.0%")).toBeInTheDocument(); expect(screen.getByText("未计算")).toBeInTheDocument(); expect(screen.queryByText("5.0%")).toBeNull();
});
it("shows actual quality diagnostics without inventing absent disclosure metrics", () => {
  render(<VcrMethodResultCharts method="population.quality" result={{ id: "quality", kind: "population_quality", diagnostics: { quality: { fidelity: { global: { sPMSE: 0.02 } }, disclosure: { available: false, membershipAuc: null } } } }} />);
  expect(screen.getByRole("table", { name: "本次人群质量指标" })).toHaveTextContent("0.02"); expect(screen.queryByText("成员推断 AUC")).toBeNull();
});

it("reads the actual R series contract with fractional band level, risk counts, individual traces and pooled status intact", () => {
  const raw = { key: "treated", label: "试验组", source: "synthetic", ours: true, pooled: true, bandKind: "prediction", bandLevel: 0.95,
    points: [{ x: 0, y: 1, low: 0.9, high: 1 }, { x: 12, y: 0.7, low: 0.5, high: 0.9 }], atRisk: [{ x: 0, n: 120 }, { x: 12, n: 60 }], individuals: [[{ x: 0, y: 1 }, { x: 12, y: 0.6 }]] };
  const parsed = readMethodResultSeries([raw], "synthetic")[0]; expect(parsed.bandLevel).toBe(95); expect(parsed.pooled).toBe(true); expect(parsed.atRisk).toEqual(raw.atRisk); expect(parsed.individuals).toEqual(raw.individuals);
  render(<VcrMethodResultCharts method="patients.time_to_event" result={{ id: "result", kind: "patient_set", diagnostics: { trajectories: { series: [raw] } } }} />);
  expect(screen.getByText("95% 预测区间")).toBeInTheDocument(); expect(screen.queryByText("0.95% 预测区间")).toBeNull(); expect(screen.getByRole("group", { name: "风险人数" })).toHaveTextContent("120");
});
it("renders the actual comparison artifact with means, paired differences and sampling intervals instead of inventing trajectories", () => {
  render(<VcrMethodResultCharts method="forecast.compare" result={{ id: "comparison_result", kind: "longitudinal", measures: [], diagnostics: { longitudinal: { id: "comparison", kind: "comparison", summary: { available: true, mode: "update", endpoint: { code: "systolic", type: "continuous", unit: "mmHg" }, origins: ["2026-10-01", "2026-10-11"], models: [{ name: "Model", version: "1" }, { name: "Model", version: "2" }], changedFactors: ["origin", "model"], causalEffectIdentified: false, groups: [{ horizonDays: 90, secondHorizonDays: 80, targetAt: "2026-12-30", subjects: 80, firstOnly: 4, secondOnly: 6, firstMean: 120, secondMean: 118, meanDifference: 2, lower: 1.1, upper: 2.8, intervalMeaning: "between_subject_sampling", modelUncertainty: "not_estimated" }] } } } }} />);
  const table = screen.getByRole("table", { name: "同一日期、相同受试者的预测差异" }); expect(table).toHaveTextContent("120"); expect(table).toHaveTextContent("118"); expect(table).toHaveTextContent("1.1–2.8");
  expect(screen.getByText(/95% 受试者配对抽样区间；模型预测不确定性未估计/)).toBeInTheDocument(); expect(screen.getByText(/差异不能归因于单一因素/)).toBeInTheDocument(); expect(screen.queryByRole("heading", { name: "后续预测轨迹" })).toBeNull();
});
it("keeps limited, failed, capped and refused grid cells visibly distinct while preserving available estimates", () => {
  render(<VcrMethodResultCharts method="design.grid" result={{ id: "grid", kind: "design_grid", conclusion: "limited", diagnostics: { cellsPlanned: 4, cells: [
    { designIndex: 1, truthIndex: 1, status: "succeeded", conclusion: "limited", replicatesCapped: true, measures: [{ name: "power", value: 0.8, mcse: 0.01 }] },
    { designIndex: 1, truthIndex: 2, status: "failed", conclusion: "limited", refusal: "design_not_supported", measures: [{ name: "power", value: 0.4, mcse: 0.03 }] },
  ] } }} />);
  const table = screen.getByRole("table", { name: "设计网格单元状态" }); expect(table).toHaveTextContent("重复次数达到上限"); expect(table).toHaveTextContent("未完成，保留部分结果"); expect(table).toHaveTextContent("有限制地估计"); expect(table).not.toHaveTextContent("design_not_supported"); expect(table).toHaveTextContent("0.01");
  expect(screen.getByText("80.0% · 部分")).toBeInTheDocument(); expect(screen.getByText("40.0% · 部分")).toBeInTheDocument(); expect(screen.getByText("2 / 计划 4")).toBeInTheDocument();
});

it("keeps entirely failed grid cells visible and never echoes an unknown refusal string", () => {
  render(<VcrMethodResultCharts method="design.grid" result={{ id: "grid_failed", kind: "design_grid", diagnostics: { cellsPlanned: 2, cells: [{ designIndex: 1, truthIndex: 1, status: "failed", refusal: "/private/operator/source-secret.txt", measures: [] }] } }} />);
  const table = screen.getByRole("table", { name: "设计网格单元状态" }); expect(table).toHaveTextContent("未完成"); expect(table).toHaveTextContent("此单元未满足方法计算条件，请核对设计和输入后重试。"); expect(document.body.textContent).not.toContain("source-secret"); expect(screen.queryByRole("columnheader", { name: /I 类错误/ })).toBeNull();
});

it("displays retained engine MAIC intervals and labels without mutating the result", async () => {
  const raw = { jobId: "maic", result: { id: "retained", kind: "comparator", measures: [{ name: "hazard_ratio_robust", label: "hazard_ratio_robust", value: 0.81, interval: { kind: "confidence", low: 0.61, high: 0.99, level: 0.95 } }, { name: "ph_test_p", value: 0.0123 }, { name: "custom", label: "β₁ (mg/L)", value: 2 }] }, records: { available: false } };
  const snapshot = JSON.stringify(raw);
  api.getVcrMethodResult.mockResolvedValue(raw);
  render(<VcrMethodResult studyId="study_1" job={{ id: "maic", kind: "maic", state: "succeeded" }} />);
  expect(await screen.findByRole("rowheader", { name: "风险比（稳健方差）" })).toBeVisible();
  expect(screen.getByRole("rowheader", { name: "等比例风险检验 P 值" })).toBeVisible();
  expect(screen.getByRole("rowheader", { name: "β₁ (mg/L)" })).toBeVisible();
  expect(screen.getAllByText(/95% 置信区间/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/1% 置信区间/)).not.toBeInTheDocument();
  expect(JSON.stringify(raw)).toBe(snapshot);
});
