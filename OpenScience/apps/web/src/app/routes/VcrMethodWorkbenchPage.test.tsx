import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { fixture } from "@/components/vcr/__fixtures__/serverFixtures";
import { VCR_SCENARIO_EXAMPLES } from "@evimed/domain";
import userEvent from "@testing-library/user-event";
import { VcrCalculationWorkbenchPage } from "./VcrCalculationWorkbenchPage";
import { VcrMethodWorkbenchPage } from "./VcrMethodWorkbenchPage";
const api = vi.hoisted(() => ({ createVcrStudy: vi.fn(), getVcrStudy: vi.fn(), getVcrModels: vi.fn(), getVcrHome: vi.fn(), getVcrData: vi.fn(), getVcrMethodHistory: vi.fn(), getVcrJob: vi.fn(), getVcrMethodConfiguration: vi.fn(), getVcrMethodResult: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
const active = () => within(document.querySelector("[data-method-scope]:not([hidden])") as HTMLElement);
function Navigation() { const navigate = useNavigate(); return <><Link to="/app/capabilities/methods/evalue?study=study_b">Study B</Link><Link to="/app/capabilities/methods/evalue?study=study_b&job=old_job">Old job B</Link><button onClick={() => void navigate(-1)}>Back</button><button onClick={() => void navigate(1)}>Forward</button></>; }
beforeEach(() => {
  vi.clearAllMocks();
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
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "2.7" } });
  fireEvent.click(screen.getByRole("link", { name: "Study B" }));
  await waitFor(() => expect(JSON.parse(document.querySelector("[data-method-scope]:not([hidden])")!.getAttribute("data-method-scope")!)[1]).toBe("study_b"));
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "1.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(active().queryByLabelText("保存到研究或独立计算")).toBeNull(); expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(2.7);
  fireEvent.click(screen.getByRole("button", { name: "Forward" })); expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(1.6);
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
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "3.2" } });
  fireEvent.click(active().getByRole("button", { name: "新建独立计算" }));
  await waitFor(() => expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("calculation_new"));
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(3.2);
  expect(api.createVcrStudy).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("link", { name: "Study B" }));
  await waitFor(() => expect(active().queryByLabelText("保存到研究或独立计算")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("calculation_new");
  expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(3.2);
});
