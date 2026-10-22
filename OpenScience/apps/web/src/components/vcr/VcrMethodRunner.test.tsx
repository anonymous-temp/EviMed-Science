import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VCR_SCENARIO_EXAMPLES, VCR_SCENARIO_SCHEMAS, validateScenario } from "@evimed/domain";
vi.mock("./VcrModelAdoptDialog", () => ({ VcrModelAdoptDialog: ({ onSaved, onClose }: { onSaved: (saved: { id: string }) => void; onClose: () => void }) => <button onClick={() => { onSaved({ id: "mapped_source" }); onClose(); }}>Save mapped source fixture</button> }));
import { methodExampleLabel } from "./vcrMethodChoiceText";
import { methodKind, methodTask, schemaDefault, VcrMethodRunner } from "./VcrMethodRunner";
const api = vi.hoisted(() => ({ queueVcrJob: vi.fn(), saveVcrMethodConfiguration: vi.fn(), getVcrHome: vi.fn(), getVcrData: vi.fn(), getVcrPopulation: vi.fn(), getVcrModels: vi.fn(), getVcrJob: vi.fn(), cancelVcrJob: vi.fn(), getVcrMethodHistory: vi.fn(), getVcrMethodConfiguration: vi.fn(), getVcrMethodResult: vi.fn(), createVcrStudy: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
const longitudinal = vi.hoisted(() => ({ getVcrLongitudinal: vi.fn() }));
vi.mock("@/lib/vcrLongitudinalClient", () => longitudinal);
const method = { id: "evalue", name: "E-value", method: "comparator.evalue" };
const draw = (selected = method) => render(<MemoryRouter><VcrMethodRunner method={selected} onClose={vi.fn()} /></MemoryRouter>);
function example(id: keyof typeof VCR_SCENARIO_EXAMPLES) { fireEvent.click(screen.getByText("载入可编辑示例")); fireEvent.click(screen.getByRole("button", { name: methodExampleLabel(id, VCR_SCENARIO_EXAMPLES[id][0].label) })); }
async function chooseStudy() { await screen.findByRole("option", { name: "Existing study" }); fireEvent.change(screen.getByLabelText("保存到研究或独立计算"), { target: { value: "study_1" } }); await screen.findByRole("button", { name: "保存配置并运行" }); await waitFor(() => expect(screen.queryByText("正在读取此配置的可用输入。")).toBeNull()); }
beforeEach(() => {
  vi.clearAllMocks();
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [] });
  api.getVcrHome.mockResolvedValue({ studies: [{ id: "study_1", projectId: "project_1", name: "Existing study" }] });
  api.getVcrData.mockResolvedValue({ snapshots: [{ id: "snapshot_saved", label: "Authorized snapshot", rows: 120 }] });
  api.getVcrMethodResult.mockResolvedValue({ result: null, records: { available: false, state: "unavailable" } });
  api.saveVcrMethodConfiguration.mockResolvedValue({ subjectId: "comparison_1", objectKind: "comparator", version: 1 });
  api.queueVcrJob.mockResolvedValue({ id: "job_1", kind: "evalue", label: "敏感性分析", state: "succeeded", seed: 42 });
});
describe("shared method workbench", () => {
  it.each([false, true])("keeps result headings one level below the method identity (embedded title: %s)", async showTitle => {
    render(<MemoryRouter><h1>Method page</h1><VcrMethodRunner method={method} showTitle={showTitle} /></MemoryRouter>);
    await screen.findByRole("option", { name: "Existing study" });
    expect(screen.getByRole("heading", { name: "运行与结果", level: showTitle ? 3 : 2 })).toBeInTheDocument();
    if (showTitle) expect(screen.getByRole("heading", { name: "E-value", level: 2 })).toBeInTheDocument();
    const workbench = screen.getByRole("button", { name: "保存配置并运行" }).closest("[data-vcr-method-workbench]")!;
    const bar = workbench.querySelector("[data-vcr-run-actions]")!;
    expect(workbench.querySelectorAll("[data-vcr-run-actions]")).toHaveLength(1);
    for (const selector of ["[data-vcr-method-configuration]", "[data-vcr-method-results]"]) {
      const region = workbench.querySelector(selector);
      expect(region).not.toBeNull();
      expect(bar.compareDocumentPosition(region!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
  it("retains canonical kinds, separates matching, and never turns an empty number into zero", () => {
    expect(methodKind("comparator.evalue")).toBe("evalue");
    expect(methodKind("model_comparator")).toBeNull();
    expect(methodKind("matching.evaluate")).toBeNull();
    expect(methodTask("matching.evaluate")).toBe("招募与匹配");
    expect(methodTask("comparator.covariate_sets")).toBe("稳健性分析");
    expect(validateScenario("comparator.evalue", schemaDefault(VCR_SCENARIO_SCHEMAS["comparator.evalue"] as never)).length).toBeGreaterThan(0);
  });
  it("shows the actual example label, loads editable values and never runs on example selection", async () => {
    draw(); await chooseStudy(); example("comparator.evalue");
    expect(validateScenario("comparator.evalue", VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].scenario)).toEqual([]);
    expect(api.queueVcrJob).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("saves an immutable subject before queueing exact typed inputs and reads this job's result", async () => {
    draw(); await chooseStudy(); example("comparator.evalue");
    fireEvent.click(screen.getByLabelText("Authorized snapshot · 120 行"));
    fireEvent.click(screen.getByText("随机与重复设置"));
    fireEvent.change(screen.getByLabelText("随机种子"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
    await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalledWith("study_1", expect.objectContaining({ method: "comparator.evalue", scenario: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].scenario })));
    expect(api.saveVcrMethodConfiguration.mock.invocationCallOrder[0]).toBeLessThan(api.queueVcrJob.mock.invocationCallOrder[0]);
    expect(api.queueVcrJob).toHaveBeenCalledWith("study_1", expect.objectContaining({ kind: "evalue", subjectId: "comparison_1", seed: 123, inputs: [{ kind: "snapshot", id: "snapshot_saved" }] }));
    await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_1", "job_1"));
    expect(screen.queryByLabelText("研究数据快照引用")).toBeNull();
  });
  it("creates one reusable calculation container without discarding edited inputs", async () => {
    api.createVcrStudy.mockResolvedValue({ id: "calculation_1", projectId: "project_calc" });
    draw(); await screen.findByRole("option", { name: "Existing study" }); example("comparator.evalue");
    const initial = (screen.getByLabelText(/风险比值|风险比/).getAttribute("value"));
    fireEvent.click(screen.getByRole("button", { name: "新建独立计算" }));
    await waitFor(() => expect(api.createVcrStudy).toHaveBeenCalledWith({ name: "独立计算", purpose: "calculation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled());
    expect(screen.getByLabelText(/风险比值|风险比/)).toHaveAttribute("value", initial);
    fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
    await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith("calculation_1", expect.anything()));
    expect(api.createVcrStudy).toHaveBeenCalledTimes(1);
  });
  it("reopens historical inputs and the precise original result, then keeps its subject for a new version", async () => {
    api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: "old_job", kind: "evalue", label: "Previous run", state: "succeeded" }] });
    api.getVcrMethodConfiguration.mockResolvedValue({ subjectId: "old_subject", kind: "evalue", method: "comparator.evalue", scenario: { riskRatio: 2 }, seed: 987, replicates: 1234, inputRefs: [{ kind: "snapshot", id: "snapshot_saved" }], unavailableInputs: 0 });
    draw(); await chooseStudy(); fireEvent.click(screen.getByText("历史运行与原始配置"));
    fireEvent.click(await screen.findByRole("button", { name: "打开原始配置与结果" }));
    await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_1", "old_job"));
    fireEvent.click(screen.getByRole("button", { name: "复用本次配置" }));
    fireEvent.click(screen.getByText("随机与重复设置")); expect(screen.getByLabelText("随机种子")).toHaveValue(987);
    fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
    await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalledWith("study_1", expect.objectContaining({ subjectId: "old_subject", scenario: { riskRatio: 2 } })));
  });
  it("detaches edited source parameters as a user scenario and permits explicit cross-study use", async () => {
    const scenario = VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].scenario;
    render(<MemoryRouter><VcrMethodRunner method={method} sourceModel={{ id: "source_model", version: "1.0.0", studyId: "other_study", scenario }} /></MemoryRouter>);
    await chooseStudy(); expect(screen.getByText(/编辑数值后将保存为用户情景/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/风险比值|风险比/), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
    await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalled());
    expect(api.saveVcrMethodConfiguration.mock.calls[0][1]).not.toHaveProperty("modelId");
    expect(api.queueVcrJob.mock.calls[0][1]).not.toHaveProperty("modelId");
  });
  it("keeps specialized matching and reconstruction in their existing authorized study flows", async () => {
    draw({ id: "matching", name: "Matching", method: "matching.evaluate" });
    await screen.findByRole("option", { name: "Existing study" });
    fireEvent.change(screen.getByLabelText("保存到研究或独立计算"), { target: { value: "study_1" } });
    expect(screen.getByRole("link", { name: "选择研究进行匹配" })).toHaveAttribute("href", "/app/virtual-research/study_1/matching");
    expect(screen.queryByRole("button", { name: "保存配置并运行" })).toBeNull();
  });
  it("shows submission failure and preserves typed settings", async () => {
    api.queueVcrJob.mockRejectedValue(new Error("refused")); draw(); await chooseStudy(); example("comparator.evalue");
    fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument(); expect(screen.queryByText(/运行完成/)).toBeNull();
  });
  it("does not require a prediction provider to evaluate an existing forecast", async () => {
    longitudinal.getVcrLongitudinal.mockResolvedValue({ available: true, providers: [], records: [{ id: "prediction_1", kind: "prediction", createdAt: "2026-10-20", summary: {} }, { id: "history_1", kind: "history", createdAt: "2026-10-21", summary: {} }] });
    draw({ id: "forecast.evaluate", method: "forecast.evaluate", name: "Forecast evaluation" }); await chooseStudy();
    fireEvent.change(screen.getByLabelText("预测版本"), { target: { value: "prediction_1" } }); fireEvent.change(screen.getByLabelText("后续结局历史"), { target: { value: "history_1" } });
    expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled();
  });
  it("allows multiple correlation-matrix rows while max constrains each cell", async () => {
    draw({ id: "population", name: "Population", method: "population.scenario" }); await chooseStudy(); example("population.scenario");
    fireEvent.click(screen.getByRole("button", { name: "添加相关矩阵" }));
    const matrix = screen.getByRole("group", { name: "相关矩阵" }); const add = () => within(matrix).getAllByRole("button", { name: "添加一项" }).at(-1)!;
    fireEvent.click(add()); expect(add()).not.toBeDisabled(); fireEvent.click(add()); expect(within(matrix).getByRole("group", { name: "相关矩阵 2" })).toBeInTheDocument();
  });
  it("retains Gamma recruitment shape units and the Beta screening prior semantics", async () => {
    draw({ id: "accrual", name: "Accrual", method: "accrual.poisson_gamma" }); await chooseStudy(); example("accrual.poisson_gamma");
    expect(screen.getAllByLabelText("招募强度 Gamma 形状 α（无量纲）")[0]).toHaveValue(2);
    expect(screen.getAllByLabelText("招募强度 Gamma 速率 β（月）")[0]).toHaveValue(4);
    expect(screen.queryByLabelText(/显著性水平/)).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "添加筛选失败率 Beta 先验" }));
    expect(screen.getByLabelText("筛选失败率 Beta 先验形状 α（无量纲）")).toBeInTheDocument();
  });
  it("retains test alpha and calendar units in trial-design examples", async () => {
    draw({ id: "trial", name: "Trial", method: "design.analytic" }); await chooseStudy(); example("design.analytic");
    expect(screen.getByLabelText("检验显著性水平 α（比例）")).toHaveValue(0.025); expect(screen.getByLabelText("对照中位时间（月（方法默认））")).toHaveValue(12);
  });
});


it("copies current parameters to an explicit study without running or converting the calculation container", async () => {
  const onUse = vi.fn();
  render(<MemoryRouter><VcrMethodRunner method={method} onUse={onUse} /></MemoryRouter>);
  await screen.findByRole("option", { name: "Existing study" }); example("comparator.evalue");
  fireEvent.click(screen.getByText("用于研究", { exact: true }));
  fireEvent.change(await screen.findByLabelText("选择目标研究"), { target: { value: "study_1" } });
  fireEvent.click(screen.getByRole("button", { name: "将配置复制到研究" }));
  await waitFor(() => expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ studyId: "study_1", subjectId: "comparison_1" })));
  expect(api.queueVcrJob).not.toHaveBeenCalled(); expect(api.createVcrStudy).not.toHaveBeenCalled();
});
it("creates a study draft and copies the configuration without running seven steps", async () => {
  api.createVcrStudy.mockResolvedValue({ id: "draft_study", projectId: "draft_project" });
  draw(); await screen.findByRole("option", { name: "Existing study" }); example("comparator.evalue");
  fireEvent.click(screen.getByText("用于研究", { exact: true })); fireEvent.change(await screen.findByLabelText("新研究名称"), { target: { value: "New research" } });
  fireEvent.click(screen.getByRole("button", { name: "新建研究草稿并使用配置" }));
  await waitFor(() => expect(api.createVcrStudy).toHaveBeenCalledWith({ name: "New research", purpose: "programme", draft: true }));
  expect(api.saveVcrMethodConfiguration).toHaveBeenCalledWith("draft_study", expect.objectContaining({ method: "comparator.evalue", scenario: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].scenario })); expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("keeps endpoint drafts separate and clears the previously selected result when the endpoint changes", async () => {
  const binary = { id: "binary", method: "patients.binary", name: "Binary" }; const repeated = { id: "longitudinal", method: "patients.longitudinal", name: "Longitudinal" };
  render(<MemoryRouter><VcrMethodRunner method={binary} methods={[binary, repeated]} /></MemoryRouter>);
  await chooseStudy(); example("patients.binary");
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("模拟结局类型"), { target: { value: "patients.longitudinal" } });
  expect(screen.queryByRole("button", { name: "复用本次配置" })).toBeNull(); expect(screen.queryByText(/运行完成/)).toBeNull();
  fireEvent.change(screen.getByLabelText("模拟结局类型"), { target: { value: "patients.binary" } });
  expect(screen.getByLabelText("对照发生率")).toHaveValue(VCR_SCENARIO_EXAMPLES["patients.binary"][0].scenario.truth.controlRate);
  expect(screen.queryByRole("button", { name: "复用本次配置" })).toBeNull();
});


const qualityBasis = { populationId: "population_1", populationVersion: 2, resultId: "generation_1", table: "population" as const, inputId: "server_owned_generation_reference", sha256: "a".repeat(64) };
function qualityData() { return { snapshots: [{ id: "training_snapshot", label: "Training" }, { id: "holdout_snapshot", label: "Holdout" }], intake: { snapshots: [
  { id: "training_snapshot", label: "Training", qualityInputs: [{ inputId: "server_training", kind: "analysis_table", shape: "subject", label: "Subject table", columns: ["col_1"], columnLabels: { col_1: "原结局" } }] },
  { id: "holdout_snapshot", label: "Holdout", qualityInputs: [{ inputId: "server_holdout", kind: "snapshot_file", shape: null, label: "Original table", columns: ["col_1"], columnLabels: { col_1: "原结局" } }] },
] } }; }
it("binds quality roles to returned authorized references and sends the exact immutable generation basis", async () => {
  api.getVcrData.mockResolvedValue(qualityData()); api.getVcrPopulation.mockResolvedValue({ versions: [{ id: "population_1", label: "Population v2", generationInput: qualityBasis }] });
  draw({ id: "quality", method: "population.quality", name: "Quality" }); await chooseStudy();
  fireEvent.change(screen.getByLabelText("要检查的人群生成版本"), { target: { value: qualityBasis.inputId } });
  fireEvent.change(screen.getByLabelText("训练或参考数据"), { target: { value: "server_training" } });
  fireEvent.change(screen.getByLabelText("独立留出数据（可选）"), { target: { value: "server_holdout" } });
  fireEvent.click(screen.getByText("质量检查参数的高级可选参数")); fireEvent.click(screen.getByRole("button", { name: "添加合成训练评估结局" }));
  expect(screen.getByRole("option", { name: "原结局" })).toHaveValue("col_1");
  fireEvent.change(screen.getByLabelText("合成训练评估结局"), { target: { value: "col_1" } });
  expect(screen.queryByLabelText("训练数据引用")).toBeNull(); expect(screen.queryByLabelText("合成数据引用")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
  await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith("study_1", expect.objectContaining({ qualityBasis, scenario: { syntheticInputId: qualityBasis.inputId, trainingInputId: "server_training", holdoutInputId: "server_holdout", tstrOutcome: "col_1" }, inputs: [{ kind: "snapshot", id: "training_snapshot" }, { kind: "snapshot", id: "holdout_snapshot" }] })));
});
it("keeps an unavailable historical quality basis unchanged until the user explicitly reselects it", async () => {
  const old = { ...qualityBasis }; // Even unchanged metadata cannot override a server readback that says the bytes are unavailable.
  api.getVcrData.mockResolvedValue(qualityData()); api.getVcrPopulation.mockResolvedValue({ versions: [{ id: "population_1", label: "Population v2", generationInput: qualityBasis }] });
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: "old_quality_job", kind: "population_quality", state: "succeeded" }] });
  api.getVcrMethodConfiguration.mockResolvedValue({ kind: "population_quality", method: "population.quality", subjectId: "population_1", qualityBasis: old, qualityBasisAvailable: false, scenario: { trainingInputId: "server_training", syntheticInputId: old.inputId }, seed: 42, inputRefs: [{ kind: "snapshot", id: "training_snapshot" }], unavailableInputs: 0 });
  draw({ id: "quality", method: "population.quality", name: "Quality" }); await chooseStudy(); fireEvent.click(screen.getByText("历史运行与原始配置")); fireEvent.click(await screen.findByRole("button", { name: "打开原始配置与结果" }));
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_1", "old_quality_job"));
  expect(screen.getByLabelText("要检查的人群生成版本")).toHaveValue("historical-unavailable"); expect(screen.getByRole("button", { name: "保存配置并运行" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("要检查的人群生成版本"), { target: { value: qualityBasis.inputId } });
  expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled();
});
it("scopes every endpoint draft to its study, including saved subjects and snapshot selections", async () => {
  api.getVcrHome.mockResolvedValue({ studies: [{ id: "study_1", name: "Existing study" }, { id: "study_b", name: "Study B" }] });
  api.getVcrData.mockImplementation(async (study: string) => ({ snapshots: [{ id: `${study}_snapshot`, label: `${study} snapshot` }] }));
  const binary = { id: "binary", method: "patients.binary", name: "Binary" }; const continuous = { id: "continuous", method: "patients.continuous", name: "Continuous" };
  render(<MemoryRouter><VcrMethodRunner method={binary} methods={[binary, continuous]} /></MemoryRouter>); await chooseStudy(); example("patients.binary");
  fireEvent.click(screen.getByLabelText("study_1 snapshot")); fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("模拟结局类型"), { target: { value: "patients.continuous" } });
  fireEvent.change(screen.getByLabelText("保存到研究或独立计算"), { target: { value: "study_b" } });
  fireEvent.change(screen.getByLabelText("模拟结局类型"), { target: { value: "patients.binary" } });
  await screen.findByLabelText("study_b snapshot"); expect(screen.getByLabelText("study_b snapshot")).not.toBeChecked();
  example("patients.binary"); fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
  await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalledTimes(2)); expect(api.saveVcrMethodConfiguration.mock.calls[1][1]).not.toHaveProperty("subjectId"); expect(api.queueVcrJob.mock.calls[1][1].inputs).toEqual([]);
  fireEvent.change(screen.getByLabelText("保存到研究或独立计算"), { target: { value: "study_1" } }); await screen.findByLabelText("study_1 snapshot"); expect(screen.getByLabelText("study_1 snapshot")).toBeChecked();
});
it("applies a versioned literature mapping at the configuration point without losing the current sample design", async () => {
  const binary = { id: "binary", method: "patients.binary", name: "Binary" };
  const sourced = { ...VCR_SCENARIO_EXAMPLES["patients.binary"][0].scenario, design: { nTreat: 5, nControl: 5 }, truth: { controlRate: 0.4, treatmentRate: 0.7 } };
  api.getVcrModels.mockResolvedValue({ methods: [binary], models: [{ id: "mapped_source", version: "2.1.0", executionSpec: { method: "patients.binary", scenario: sourced } }] });
  render(<MemoryRouter><VcrMethodRunner method={binary} /></MemoryRouter>); await chooseStudy(); example("patients.binary");
  const originalN = screen.getByLabelText("干预组人数").getAttribute("value");
  fireEvent.click(screen.getByRole("button", { name: "使用文献参数" })); fireEvent.click(screen.getByRole("button", { name: "Save mapped source fixture" }));
  await waitFor(() => expect(screen.getByLabelText("对照发生率")).toHaveValue(0.4)); expect(screen.getByLabelText("干预组人数")).toHaveAttribute("value", originalN);
  expect(screen.getByText(/文献参数版本 2.1.0/)).toBeInTheDocument();
  // Applied values can render before the input-admission effect is ready; a user can run only once the action is enabled.
  await waitFor(() => expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalledWith("study_1", expect.objectContaining({ modelId: "mapped_source" })));
});
it("marks a previous result when the current seed has changed", async () => {
  draw(); await chooseStudy(); example("comparator.evalue"); fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  fireEvent.click(screen.getByText("随机与重复设置")); fireEvent.change(screen.getByLabelText("随机种子"), { target: { value: "987" } });
  expect(screen.getByText(/参数已修改，下方仍为上次运行结果/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "恢复本次运行配置" })); expect(screen.getByLabelText("随机种子")).toHaveValue(42); expect(screen.queryByText(/参数已修改，下方仍为上次运行结果/)).toBeNull();
});


const reconstruction = { resultId: "owned_reconstruction", label: "Kaplan–Meier reconstruction", version: 2, createdAt: "2026-10-20", method: "evidence.reconstruct_km", valueSource: "reconstructed", table: "reconstructed-ipd", source: { kind: "published_curve", origin: { title: "Published curve fixture" } }, timeUnit: "months" };
const maic = { id: "maic_tte", method: "comparator.maic_time_to_event", name: "Survival MAIC" };
function maicExample() { const scenario = structuredClone(VCR_SCENARIO_EXAMPLES["comparator.maic_time_to_event"][0].scenario); delete (scenario as Record<string, unknown>).pseudoIpdInputId; return scenario; }
it("selects an owned reconstruction for the unanchored example without submitting the example's platform placeholder", async () => {
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [], reconstructionResults: [reconstruction] });
  api.saveVcrMethodConfiguration.mockResolvedValue({ subjectId: "maic_subject", objectKind: "comparator", version: 1, reconstructionResultId: reconstruction.resultId, scenario: maicExample() });
  draw(maic); await chooseStudy(); example("comparator.maic_time_to_event"); fireEvent.click(screen.getByLabelText("Authorized snapshot · 120 行"));
  expect(screen.queryByLabelText("重建数据引用")).toBeNull(); expect(screen.getByRole("button", { name: "保存配置并运行" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("曲线重建结果"), { target: { value: reconstruction.resultId } });
  expect(screen.getByText("Published curve fixture")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText("age"), { target: { value: "" } }); expect(screen.getByRole("button", { name: "保存配置并运行" })).toBeDisabled(); fireEvent.change(screen.getByLabelText("age"), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  expect(api.saveVcrMethodConfiguration).toHaveBeenCalledWith("study_1", expect.objectContaining({ reconstructionResultId: reconstruction.resultId, scenario: maicExample() }));
  expect(api.queueVcrJob).toHaveBeenCalledWith("study_1", expect.objectContaining({ reconstructionResultId: reconstruction.resultId, subjectId: "maic_subject", scenario: maicExample() }));
  expect(api.queueVcrJob.mock.calls[0][1].scenario).not.toHaveProperty("pseudoIpdInputId");
});
it("permits a valid anchored aggregate comparison without a reconstruction", async () => {
  const scenario = { covariates: ["age"], targets: { age: 60 }, anchored: true, aggregateEstimate: 0.1, aggregateSe: 0.2 };
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [], reconstructionResults: [] });
  render(<MemoryRouter><VcrMethodRunner method={maic} initialScenario={scenario} /></MemoryRouter>); await chooseStudy(); fireEvent.click(screen.getByLabelText("Authorized snapshot · 120 行"));
  expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  expect(api.queueVcrJob.mock.calls[0][1]).not.toHaveProperty("reconstructionResultId"); expect(api.queueVcrJob.mock.calls[0][1].scenario).toEqual({ ...scenario, endpoint: { type: "time_to_event" } });
});
it("reopens the original reconstruction identity and never substitutes the newest version when replay is unavailable", async () => {
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: "old_maic_job", kind: "maic_time_to_event_comparator", state: "succeeded" }], reconstructionResults: [reconstruction] });
  api.getVcrMethodConfiguration.mockResolvedValue({ kind: "maic_time_to_event_comparator", method: maic.method, reconstructionResultId: "old_reconstruction", reconstructionResultAvailable: false, subjectId: "old_comparator", scenario: maicExample(), seed: 987, inputRefs: [{ kind: "snapshot", id: "snapshot_saved" }], unavailableInputs: 0 });
  draw(maic); await chooseStudy(); fireEvent.click(screen.getByText("历史运行与原始配置")); fireEvent.click(await screen.findByRole("button", { name: "打开原始配置与结果" }));
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_1", "old_maic_job")); expect(screen.getByLabelText("曲线重建结果")).toHaveValue("historical-unavailable"); expect(screen.getByRole("button", { name: "保存配置并运行" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "复用本次配置" })); expect(screen.getByLabelText("曲线重建结果")).toHaveValue("historical-unavailable"); expect(api.queueVcrJob).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("曲线重建结果"), { target: { value: reconstruction.resultId } }); expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled();
});

it("keeps one run action before the form and submits a manually entered fixed-endpoint scenario without examples", async () => {
  draw({ id: "binary", method: "patients.binary", name: "Binary" }); await chooseStudy();
  expect(screen.getAllByRole("button", { name: "保存配置并运行" })).toHaveLength(1);
  expect(screen.queryByRole("group", { name: "终点" })).toBeNull();
  fireEvent.change(screen.getByLabelText("干预组人数"), { target: { value: "40" } });
  fireEvent.change(screen.getByLabelText("对照组人数"), { target: { value: "40" } });
  fireEvent.change(screen.getByLabelText("对照发生率"), { target: { value: "0.3" } });
  fireEvent.change(screen.getByLabelText("干预发生率"), { target: { value: "0.5" } });
  expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled();
  const action = document.querySelector("[data-vcr-run-actions]")!; const form = document.querySelector("form")!;
  expect(action.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" })); await waitFor(() => expect(api.queueVcrJob).toHaveBeenCalled());
  const scenario = api.queueVcrJob.mock.calls[0][1].scenario;
  expect(scenario).toMatchObject({ endpoint: { type: "binary" }, design: { nTreat: 40, nControl: 40 }, truth: { controlRate: 0.3, treatmentRate: 0.5 } }); expect(validateScenario("patients.binary", scenario)).toEqual([]);
});
it("does not render a slash for the real canceled-job empty progress shape", async () => {
  api.getVcrJob.mockResolvedValue({ id: "canceled_job", kind: "evalue", state: "canceled", progress: {} });
  api.getVcrMethodConfiguration.mockResolvedValue({ kind: "evalue", method: "comparator.evalue", scenario: { riskRatio: 2 }, seed: 42, inputRefs: [], unavailableInputs: 0 });
  render(<MemoryRouter><VcrMethodRunner method={method} initialStudyId="study_1" initialJobId="canceled_job" /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("[data-vcr-job-status]")).toHaveTextContent("已取消"));
  expect(document.querySelector("[data-vcr-job-status]")!.textContent).not.toContain("/");
});

it("locks edits for both delayed preparation and queue responses", async () => {
  let prepare: (value: unknown) => void = () => undefined, finish: (value: unknown) => void = () => undefined;
  api.saveVcrMethodConfiguration.mockImplementationOnce(() => new Promise(resolve => { prepare = resolve; })); api.queueVcrJob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  draw(); await chooseStudy(); example("comparator.evalue"); fireEvent.click(screen.getByText("随机与重复设置")); fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
  const input = screen.getByLabelText(/风险比值|风险比/); const original = input.getAttribute("value");
  expect(input).toBeDisabled(); expect(screen.getByLabelText("保存到研究或独立计算")).toBeDisabled(); expect(screen.getByLabelText("随机种子")).toBeDisabled(); expect(screen.getByLabelText("Authorized snapshot · 120 行")).toBeDisabled();
  await userEvent.type(input, "9"); expect(input).toHaveAttribute("value", original);
  await act(async () => prepare({ subjectId: "comparison_1", objectKind: "comparator", version: 1 })); expect(input).toBeDisabled();
  await act(async () => finish({ id: "delayed_job", kind: "evalue", state: "succeeded" })); await waitFor(() => expect(input).not.toBeDisabled()); expect(input).toHaveAttribute("value", original);
});
it("locks an in-flight history read so its result cannot overwrite concurrent edits", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.getVcrMethodHistory.mockResolvedValue({ jobs: [{ id: "old_job", kind: "evalue", state: "succeeded" }] }); api.getVcrMethodConfiguration.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  draw(); await chooseStudy(); example("comparator.evalue"); fireEvent.click(screen.getByText("历史运行与原始配置")); fireEvent.click(screen.getByRole("button", { name: "打开原始配置与结果" }));
  expect(screen.getByLabelText(/风险比值|风险比/)).toBeDisabled(); expect(screen.getByRole("button", { name: "使用文献参数" })).toBeDisabled();
  await act(async () => finish({ kind: "evalue", method: "comparator.evalue", scenario: { riskRatio: 4 }, seed: 42, inputRefs: [], unavailableInputs: 0 })); await waitFor(() => expect(screen.getByLabelText(/风险比值|风险比/)).toHaveValue(4));
});
it("holds the originating scope while a saved literature version is being fetched", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.getVcrModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const binary = { id: "binary", method: "patients.binary", name: "Binary" }, continuous = { id: "continuous", method: "patients.continuous", name: "Continuous" };
  render(<MemoryRouter><VcrMethodRunner method={binary} methods={[binary, continuous]} /></MemoryRouter>); await chooseStudy(); example("patients.binary");
  fireEvent.click(screen.getByRole("button", { name: "使用文献参数" })); fireEvent.click(screen.getByRole("button", { name: "Save mapped source fixture" }));
  expect(screen.getByLabelText("对照发生率")).toBeDisabled(); expect(screen.getByLabelText("模拟结局类型")).toBeDisabled(); expect(screen.getByLabelText("保存到研究或独立计算")).toBeDisabled(); await userEvent.type(screen.getByLabelText("对照发生率"), "9");
  await act(async () => finish({ methods: [binary], models: [{ id: "mapped_source", version: "3.0.0", executionSpec: { method: "patients.binary", scenario: { endpoint: { type: "binary" }, truth: { controlRate: 0.4, treatmentRate: 0.6 } } } }] }));
  await waitFor(() => expect(screen.getByLabelText("对照发生率")).not.toBeDisabled()); expect(screen.getByLabelText("对照发生率")).toHaveValue(0.4); expect(screen.getByLabelText("保存到研究或独立计算")).toHaveValue("study_1");
});
it("keeps authoritative provider-specific inputs outside browser persistence while restoring edited forecast fields", async () => {
  const drafts = await import("@/lib/vcrMethodDraft"); drafts.clearMethodDrafts(); drafts.activateMethodDraftOwner("owner", "tenant");
  longitudinal.getVcrLongitudinal.mockResolvedValue({ available: true, providers: [{ id: "provider_1", name: "Source provider", version: "1" }], records: [{ id: "history_1", kind: "history", createdAt: "2026-10-20", summary: {} }] });
  const draftScope = { userId: "owner", tenantId: "tenant", projectId: "project_1", studyId: "study_1", method: "forecast.trajectories", launchId: "source_launch" };
  const initialScenario = { historyId: "history_1", providerId: "provider_1", endpoint: { code: "outcome", unit: "cycles", type: "continuous" }, horizonsDays: [7], scenario: { treatment: "source_owned_marker" } };
  const tree = () => <MemoryRouter><VcrMethodRunner method={{ id: "forecast.trajectories", method: "forecast.trajectories", name: "Forecast" }} studyId="study_1" initialScenario={initialScenario} draftScope={draftScope} /></MemoryRouter>;
  const first = render(tree()); await screen.findByLabelText("预测终点"); await waitFor(() => expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("预测终点"), { target: { value: "edited_outcome" } }); first.unmount();
  expect(window.sessionStorage.getItem(drafts.methodDraftKey(draftScope))).not.toContain("source_owned_marker");
  render(tree()); await screen.findByLabelText("预测终点"); await waitFor(() => expect(screen.getByRole("button", { name: "保存配置并运行" })).not.toBeDisabled());
  expect(screen.getByLabelText("预测终点")).toHaveValue("edited_outcome");
  fireEvent.click(screen.getByRole("button", { name: "保存配置并运行" }));
  await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalledWith("study_1", expect.objectContaining({ scenario: expect.objectContaining({ scenario: { treatment: "source_owned_marker" }, endpoint: expect.objectContaining({ code: "edited_outcome" }) }) })));
  drafts.clearMethodDrafts();
});

it("edits the cohort age rule through shared controls and refuses incomplete conditions before any queue request", async () => {
  const original = VCR_SCENARIO_EXAMPLES["cohort.build"][0].scenario;
  const preserved = structuredClone(original);
  render(<MemoryRouter><VcrMethodRunner method={{ id: "cohort", name: "队列筛选", method: "cohort.build" }} initialScenario={structuredClone(original)} initialStudyId="study_1" /></MemoryRouter>);
  await screen.findByLabelText("Authorized snapshot · 120 行");
  fireEvent.click(screen.getByLabelText("Authorized snapshot · 120 行"));
  const age = screen.getAllByLabelText("比较值")[0];
  expect(age).toHaveValue(18);
  fireEvent.change(age, { target: { value: "60" } });
  const run = screen.getByRole("button", { name: "保存配置并运行" });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.change(age, { target: { value: "" } });
  expect(run).toBeDisabled(); fireEvent.click(run);
  expect(api.saveVcrMethodConfiguration).not.toHaveBeenCalled(); expect(api.queueVcrJob).not.toHaveBeenCalled();
  fireEvent.change(age, { target: { value: "65" } });
  expect(run).toBeEnabled(); expect(original).toEqual(preserved);
});
