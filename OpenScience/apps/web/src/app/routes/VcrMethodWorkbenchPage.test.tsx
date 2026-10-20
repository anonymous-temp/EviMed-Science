import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link, useNavigate } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { VCR_SCENARIO_EXAMPLES } from "@evimed/domain";
import userEvent from "@testing-library/user-event";
import { VcrCalculationWorkbenchPage } from "./VcrCalculationWorkbenchPage";
import { VcrMethodWorkbenchPage } from "./VcrMethodWorkbenchPage";
const api = vi.hoisted(() => ({ getVcrModels: vi.fn(), getVcrHome: vi.fn(), getVcrData: vi.fn(), getVcrMethodHistory: vi.fn(), getVcrJob: vi.fn(), getVcrMethodConfiguration: vi.fn(), getVcrMethodResult: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
const active = () => within(document.querySelector("[data-method-scope]:not([hidden])") as HTMLElement);
function Navigation() { const navigate = useNavigate(); return <><Link to="/app/capabilities/methods/evalue?study=study_b">Study B</Link><Link to="/app/capabilities/methods/evalue?study=study_b&job=old_job">Old job B</Link><button onClick={() => void navigate(-1)}>Back</button><button onClick={() => void navigate(1)}>Forward</button></>; }
beforeEach(() => {
  vi.clearAllMocks();
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
  await waitFor(() => expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("study_b"));
  fireEvent.click(active().getByText("载入可编辑示例")); fireEvent.click(active().getByRole("button", { name: VCR_SCENARIO_EXAMPLES["comparator.evalue"][0].label }));
  fireEvent.change(active().getByLabelText(/风险比值|风险比/), { target: { value: "1.6" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(active().getByLabelText("保存到研究或独立计算")).toHaveValue("study_a"); expect(active().getByLabelText(/风险比值|风险比/)).toHaveValue(2.7);
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
