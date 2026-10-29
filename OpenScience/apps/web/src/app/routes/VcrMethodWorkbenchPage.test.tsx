import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { fixture } from "@/components/vcr/__fixtures__/serverFixtures";
import { clearMethodDrafts } from "@/lib/vcrMethodDraft";
import { methodExampleLabel } from "@/components/vcr/vcrMethodChoiceText";
import { VCR_SCENARIO_EXAMPLES } from "@evimed/domain";
import userEvent from "@testing-library/user-event";
import { VcrCalculationWorkbenchPage } from "./VcrCalculationWorkbenchPage";
import { VcrMethodWorkbenchPage } from "./VcrMethodWorkbenchPage";
const api = vi.hoisted(() => ({ createVcrStudy: vi.fn(), getVcrStudy: vi.fn(), getVcrModels: vi.fn(), getVcrHome: vi.fn(), getVcrData: vi.fn(), getVcrMethodHistory: vi.fn(), getVcrJob: vi.fn(), getVcrMethodConfiguration: vi.fn(), getVcrMethodResult: vi.fn(), saveVcrMethodConfiguration: vi.fn(), queueVcrJob: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
const identity = vi.hoisted(() => ({ fetchWebMe: vi.fn() }));
vi.mock("@/lib/apiClient", async load => ({ ...await load<object>(), ...identity }));
const active = () => within(document.querySelector("[data-method-scope]:not([hidden])") as HTMLElement);
async function ready() { await waitFor(() => expect(active().getByRole("button", { name: "保存配置并运行" })).not.toHaveAttribute("aria-busy", "true")); }
function Navigation() { const navigate = useNavigate(); return <><Link to="/app/capabilities/methods/evalue?study=study_b">Study B</Link><Link to="/app/capabilities/methods/evalue?study=study_b&job=old_job">Old job B</Link><button onClick={() => void navigate(-1)}>Back</button><button onClick={() => void navigate(1)}>Forward</button></>; }
beforeEach(() => {
  vi.clearAllMocks();
  clearMethodDrafts(); window.sessionStorage.clear();
  identity.fetchWebMe.mockResolvedValue({ user: { id: "user_a" }, tenant: { id: "tenant_a" }, project: { id: "project_a" } });
  api.getVcrStudy.mockImplementation(async id => ({ ...fixture("ev201/study.json"), id, name: "Study context", purpose: "programme" }));
  api.getVcrModels.mockResolvedValue({ models: [], methods: [{ id: "evalue", method: "comparator.evalue", name: "E-value" }] });
  api.getVcrHome.mockResolvedValue({ studies: [{ id: "study_a", name: "Study A" }, { id: "study_b", name: "Study B" }] });
  api.getVcrData.mockResolvedValue({ snapshots: [] }); api.getVcrMethodHistory.mockResolvedValue({ jobs: [] });
  api.getVcrJob.mockResolvedValue({ id: "old_job", kind: "evalue", method: "comparator.evalue", state: "canceled" });
  api.getVcrMethodConfiguration.mockResolvedValue({ kind: "evalue", method: "comparator.evalue", scenario: { riskRatio: 4 }, seed: 9, inputRefs: [], unavailableInputs: 0 });
  api.getVcrMethodResult.mockResolvedValue({ result: null, records: { available: false } });
});
it("isolates same-route study and job addresses while Back and Forward restore each scope's unsent inputs", async () => {
  render(<MemoryRouter initialEntries={["/app/capabilities/methods/evalue?study=study_a"]}><Navigation /><Routes><Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} /></Routes></MemoryRouter>);
  await screen.findByRole("heading", { name: "E-value" });
  await ready(); fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: methodExampleLabel("comparator.evalue", VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label) }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "2.7" } });
  fireEvent.click(screen.getByRole("link", { name: "Study B" }));
  await waitFor(() => expect(JSON.parse(document.querySelector("[data-method-scope]:not([hidden])")!.getAttribute("data-method-scope")!)[1]).toBe("study_b"));
  await ready(); fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: methodExampleLabel("comparator.evalue", VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label) }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "1.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(2.7)); expect(active().queryByLabelText("保存到研究或独立计算")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Forward" })); await waitFor(() => expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.6));
  fireEvent.click(screen.getByRole("link", { name: "Old job B" }));
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("study_b", "old_job"));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(4);
  fireEvent.click(screen.getByRole("button", { name: "Back" })); expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.6);
});

it("clears the calculation catalogue search with its clear button and Escape", async () => {
  render(<MemoryRouter initialEntries={["/app/capabilities/calculations/study_a"]}><Routes><Route path="/app/capabilities/calculations/:studyId" element={<VcrCalculationWorkbenchPage />} /></Routes></MemoryRouter>);
  await screen.findByRole("list", { name: "选择计算任务" });
  const search = screen.getByRole("searchbox", { name: "搜索方法" });
  await userEvent.type(search, "E-value"); expect(await screen.findByRole("button", { name: "E-value" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" })); expect(search).toHaveValue(""); expect(screen.getByRole("list", { name: "选择计算任务" })).toBeInTheDocument();
  await userEvent.type(search, "E-value"); await screen.findByRole("button", { name: "E-value" }); await userEvent.keyboard("{Escape}");
  expect(search).toHaveValue(""); expect(screen.getByRole("list", { name: "选择计算任务" })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
});

it("keeps the study workflow and canonical conversation available inside a method", async () => {
  render(<MemoryRouter initialEntries={["/app/capabilities/methods/evalue?study=study_a"]}><Routes><Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} /></Routes></MemoryRouter>);
  const rail = await screen.findByRole("navigation", { name: "研究进度" });
  expect(within(rail).getAllByRole("listitem")).toHaveLength(7);
  expect(screen.getByRole("link", { name: "研究对话" })).toHaveAttribute("href", "/app/virtual-research/study_a/chat");
});
it("keeps independent calculations and specialized source views reachable without programme chrome", async () => {
  api.getVcrStudy.mockResolvedValue({ ...fixture("ev201/study.json"), id: "calculation_a", purpose: "calculation" });
  render(<MemoryRouter initialEntries={["/app/capabilities/methods/evalue?study=calculation_a"]}><Routes><Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "资料与证据" })).toHaveAttribute("href", "/app/virtual-research/calculation_a/data");
  expect(screen.queryByRole("navigation", { name: "研究进度" })).toBeNull();
  expect(screen.getByRole("link", { name: /EV-201/ })).toHaveAttribute("href", "/app/capabilities/calculations/calculation_a");
});

it("preserves parameters when creating a calculation from the unscoped workbench and returning through history", async () => {
  api.createVcrStudy.mockResolvedValue({ id: "calculation_new", projectId: "project_calc" });
  render(<MemoryRouter initialEntries={["/app/capabilities/methods/evalue"]}><Navigation /><Routes><Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} /></Routes></MemoryRouter>);
  await screen.findByRole("heading", { name: "E-value" });
  await ready(); fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: methodExampleLabel("comparator.evalue", VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label) }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "3.2" } });
  fireEvent.click(active().getByRole("button", { name: "新建独立计算" }));
  await waitFor(() => expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("calculation_new"));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(3.2);
  expect(api.createVcrStudy).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("link", { name: "Study B" }));
  await waitFor(() => expect(active().queryByLabelText("保存到研究或独立计算")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("calculation_new"));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(3.2);
});

it("retains an edited analytic form through study/chat return, Back and a remount without submitting", async () => {
  api.getVcrModels.mockResolvedValue({ models: [], methods: [{ id: "design.analytic", method: "design.analytic", name: "解析设计" }] });
  const path = "/app/capabilities/methods/design.analytic?study=study_a&view=trial";
  const tree = () => <MemoryRouter initialEntries={[path]}><Navigation /><Routes>
    <Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} />
    <Route path="/app/virtual-research/:studyId/trial" element={<Link to="/app/virtual-research/study_a/chat">Canonical chat</Link>} />
    <Route path="/app/virtual-research/:studyId/chat" element={<p>Canonical discussion</p>} />
  </Routes></MemoryRouter>;
  const first = render(tree());
  await screen.findByRole("heading", { name: "解析设计" });
  await ready(); fireEvent.click(active().getByText("载入可编辑示例"));
  fireEvent.click(active().getByRole("button", { name: methodExampleLabel("design.analytic", VCR_SCENARIO_EXAMPLES["design.analytic"][0].label) }));
  fireEvent.change(active().getByLabelText("瞬时风险比 HR（无量纲）"), { target: { value: "0.73" } });
  fireEvent.click(active().getByText("随机与重复设置")); fireEvent.change(active().getByLabelText("随机种子"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("link", { name: "Study context" })); await screen.findByRole("link", { name: "Canonical chat" });
  fireEvent.click(screen.getByRole("link", { name: "Canonical chat" })); await screen.findByText("Canonical discussion");
  fireEvent.click(screen.getByRole("button", { name: "Back" })); await screen.findByRole("link", { name: "Canonical chat" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(active().getByLabelText("瞬时风险比 HR（无量纲）")).toHaveValue(0.73));
  expect(active().getByLabelText("随机种子")).toHaveValue(123);
  first.unmount(); render(tree()); await waitFor(() => expect(active().getByLabelText("瞬时风险比 HR（无量纲）")).toHaveValue(0.73));
  expect(api.saveVcrMethodConfiguration).not.toHaveBeenCalled(); expect(api.queueVcrJob).not.toHaveBeenCalled();
});

function addressedTree(path = "/app/capabilities/methods/evalue?study=study_a") {
  return <MemoryRouter initialEntries={[path]}><Navigation /><Routes>
    <Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} />
    <Route path="/app/virtual-research/:studyId/:view" element={<p>Study destination</p>} /><Route path="/app/virtual-research/:studyId" element={<p>Study destination</p>} />
  </Routes></MemoryRouter>;
}
async function editRatio(value: string) {
  await screen.findByRole("heading", { name: "E-value" }); await ready();
  fireEvent.click(active().getByText("载入可编辑示例"));
  fireEvent.click(active().getByRole("button", { name: methodExampleLabel("comparator.evalue", VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label) }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value } });
}
it("does not restore another account or tenant's parameters for identical study/project IDs", async () => {
  const first = render(addressedTree()); await editRatio("2.7"); first.unmount();
  identity.fetchWebMe.mockResolvedValue({ user: { id: "user_b" }, tenant: { id: "tenant_a" }, project: { id: "project_a" } });
  const second = render(addressedTree()); await screen.findByRole("heading", { name: "E-value" }); await ready();
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(null); second.unmount();
  identity.fetchWebMe.mockResolvedValue({ user: { id: "user_a" }, tenant: { id: "tenant_b" }, project: { id: "project_a" } });
  render(addressedTree()); await screen.findByRole("heading", { name: "E-value" }); await ready();
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(null);
});
it("re-reads the historical result then restores only its edited form, apart from the ordinary working draft", async () => {
  const path = "/app/capabilities/methods/evalue?study=study_a&job=old_job";
  const first = render(addressedTree(path)); await screen.findByRole("heading", { name: "E-value" }); await ready();
  await waitFor(() => expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(4));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "3.3" } });
  first.unmount(); const second = render(addressedTree(path));
  await screen.findByRole("heading", { name: "E-value" }); await ready();
  await waitFor(() => expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(3.3));
  expect(api.getVcrMethodConfiguration).toHaveBeenCalledTimes(2);
  fireEvent.click(active().getByRole("button", { name: "恢复本次运行配置" }));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(4);
  second.unmount(); render(addressedTree()); await screen.findByRole("heading", { name: "E-value" }); await ready();
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(null);
  expect(api.saveVcrMethodConfiguration).not.toHaveBeenCalled(); expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("ignores an old owner's delayed historical response and gates editing until identity is known", async () => {
  let release!: (value: unknown) => void;
  api.getVcrMethodConfiguration.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const first = render(addressedTree("/app/capabilities/methods/evalue?study=study_a&job=old_job"));
  await waitFor(() => expect(api.getVcrMethodConfiguration).toHaveBeenCalled()); first.unmount();
  identity.fetchWebMe.mockResolvedValue({ user: { id: "user_b" }, tenant: { id: "tenant_a" }, project: { id: "project_a" } });
  render(addressedTree()); await editRatio("1.9");
  await act(async () => release({ kind: "evalue", scenario: { riskRatio: 9 }, seed: 9, inputRefs: [], unavailableInputs: 0 }));
  await waitFor(() => expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.9));
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("does not queue or restore busy state when configuration preparation finishes after leaving", async () => {
  let release!: (value: unknown) => void;
  api.saveVcrMethodConfiguration.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  render(addressedTree()); await editRatio("2.7");
  fireEvent.click(active().getByRole("button", { name: "保存配置并运行" }));
  await waitFor(() => expect(api.saveVcrMethodConfiguration).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("link", { name: "Study context" })); await screen.findByText("Study destination");
  await act(async () => release({ subjectId: "late_subject", scenario: { riskRatio: 9 } }));
  fireEvent.click(screen.getByRole("button", { name: "Back" })); await screen.findByRole("heading", { name: "E-value" }); await ready();
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(2.7);
  expect(api.queueVcrJob).not.toHaveBeenCalled(); expect(active().getByRole("button", { name: "保存配置并运行" })).not.toHaveAttribute("aria-busy", "true");
});
it("does not expose editable fields or accept a stale identity result before the current owner is verified", async () => {
  let release!: (value: unknown) => void;
  identity.fetchWebMe.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const first = render(addressedTree()); expect(screen.queryByLabelText(/风险比值|风险比/)).toBeNull();
  expect(api.getVcrModels).not.toHaveBeenCalled(); first.unmount();
  identity.fetchWebMe.mockResolvedValue({ user: { id: "user_b" }, tenant: { id: "tenant_b" }, project: { id: "project_a" } });
  render(addressedTree()); await editRatio("1.8");
  await act(async () => release({ user: { id: "user_a" }, tenant: { id: "tenant_a" }, project: { id: "project_a" } }));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.8);
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("retains each endpoint's independent form and active mode through leaving the route", async () => {
  api.getVcrModels.mockResolvedValue({ models: [], methods: ["patients.binary", "patients.continuous", "patients.time_to_event", "patients.longitudinal"].map(method => ({ id: method, method, name: method })) });
  const path = "/app/capabilities/methods/patients.binary?study=study_a";
  render(addressedTree(path)); await screen.findByRole("heading", { name: "模拟患者结局" }); await ready();
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: methodExampleLabel("patients.binary", VCR_SCENARIO_EXAMPLES["patients.binary"][0].label) }));
  fireEvent.change(active().getByLabelText("对照发生率"), { target: { value: "0.21" } });
  fireEvent.change(active().getByLabelText("模拟结局类型"), { target: { value: "patients.continuous" } });
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: methodExampleLabel("patients.continuous", VCR_SCENARIO_EXAMPLES["patients.continuous"][0].label) }));
  fireEvent.change(active().getByLabelText("标准差（结局原单位）"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("link", { name: "Study context" })); await screen.findByText("Study destination");
  fireEvent.click(screen.getByRole("button", { name: "Back" })); await screen.findByRole("heading", { name: "模拟患者结局" }); await ready();
  expect(active().getByLabelText("模拟结局类型")).toHaveValue("patients.continuous");
  expect(active().getByLabelText("标准差（结局原单位）")).toHaveValue(9);
  fireEvent.change(active().getByLabelText("模拟结局类型"), { target: { value: "patients.binary" } });
  expect(active().getByLabelText("对照发生率")).toHaveValue(0.21);
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("retains separate study forms when the unscoped method remembers its last selected save location", async () => {
  const path = "/app/capabilities/methods/evalue";
  const first = render(addressedTree(path)); await editRatio("2.7");
  fireEvent.change(active().getByLabelText("保存到研究或独立计算"), { target: { value: "study_a" } }); await ready();
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "2.7" } });
  fireEvent.change(active().getByLabelText("保存到研究或独立计算"), { target: { value: "study_b" } }); await ready();
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "1.6" } });
  first.unmount(); render(addressedTree(path)); await screen.findByRole("heading", { name: "E-value" }); await ready();
  expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("study_b");
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.6);
  fireEvent.change(active().getByLabelText("保存到研究或独立计算"), { target: { value: "study_a" } }); await ready();
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(2.7);
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
