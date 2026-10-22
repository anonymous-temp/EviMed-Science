import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import { VcrUseMethodInStudy } from "./VcrUseMethodInStudy";
const api = vi.hoisted(() => ({ getVcrHome: vi.fn(), createVcrStudy: vi.fn(), saveVcrMethodConfiguration: vi.fn(), queueVcrJob: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
function Destination() { const location = useLocation(); return <output data-testid="destination">{JSON.stringify({ path: location.pathname, query: location.search, state: location.state })}</output>; }
it("carries numeric settings into a target scope for data selection without copying a source prediction reference", async () => {
  api.getVcrHome.mockResolvedValue({ studies: [{ id: "target_study", name: "Target study", purpose: "programme" }, { id: "calculation_1", name: "Independent calculation", purpose: "calculation" }] });
  render(<MemoryRouter initialEntries={["/source"]}><Routes><Route path="/source" element={<VcrUseMethodInStudy method="forecast.evaluate" name="Forecast evaluation" valid disabled={false} scenario={{ predictionId: "source_prediction", outcomeHistoryId: "source_history", bootstrap: 100, windowDays: 90 }} />} /><Route path="/app/capabilities/methods/:methodId" element={<Destination />} /></Routes></MemoryRouter>);
  await userEvent.click(screen.getByText("用于研究"));
  await userEvent.selectOptions(await screen.findByLabelText("选择目标研究"), "target_study");
  expect(screen.queryByRole("option", { name: "Independent calculation" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "在目标研究继续配置" }));
  await waitFor(() => expect(screen.getByTestId("destination")).toHaveTextContent("target_study"));
  const destination = JSON.parse(screen.getByTestId("destination").textContent!);
  expect(destination.state.methodScenario).toEqual({ bootstrap: 100, windowDays: 90 });
  expect(api.saveVcrMethodConfiguration).not.toHaveBeenCalled(); expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("carries a no-subject method as an unrun draft instead of claiming it was saved", async () => {
  vi.clearAllMocks(); api.getVcrHome.mockResolvedValue({ studies: [{ id: "target_study", name: "Target study", purpose: "programme" }] }); api.saveVcrMethodConfiguration.mockResolvedValue({ subjectId: null, objectKind: null, version: null });
  render(<MemoryRouter initialEntries={["/source"]}><Routes><Route path="/source" element={<VcrUseMethodInStudy method="evidence.pool" name="Evidence pooling" valid disabled={false} scenario={{ studies: [{ estimate: 0.3, se: 0.1 }] }} />} /><Route path="/app/capabilities/methods/:methodId" element={<Destination />} /></Routes></MemoryRouter>);
  await userEvent.click(screen.getByText("用于研究")); await userEvent.selectOptions(await screen.findByLabelText("选择目标研究"), "target_study"); await userEvent.click(screen.getByRole("button", { name: "将配置复制到研究" }));
  const destination = await screen.findByTestId("destination"); expect(destination).toHaveTextContent("未运行草稿"); expect(destination).toHaveTextContent('"estimate":0.3'); expect(screen.queryByText(/配置已保存/)).toBeNull(); expect(api.queueVcrJob).not.toHaveBeenCalled();
});

it("validates a new study name at 40 Unicode characters before creation", async () => {
  vi.clearAllMocks(); api.getVcrHome.mockResolvedValue({ studies: [] });
  api.createVcrStudy.mockResolvedValue({ id: "new_study" });
  api.saveVcrMethodConfiguration.mockResolvedValue({ subjectId: "saved", objectKind: "analysis", version: 1 });
  render(<MemoryRouter><VcrUseMethodInStudy method="evidence.pool" name="Evidence pooling" valid disabled={false} scenario={{}} /></MemoryRouter>);
  await userEvent.click(screen.getByText("用于研究"));
  const input = await screen.findByRole("textbox", { name: "新研究名称" });
  await userEvent.type(input, "名".repeat(41));
  const create = screen.getByRole("button", { name: "新建研究草稿并使用配置" });
  expect(create).toBeDisabled(); expect(api.createVcrStudy).not.toHaveBeenCalled();
  expect(input).toHaveValue("名".repeat(41));
  await userEvent.clear(input); await userEvent.type(input, "🧪".repeat(40));
  await userEvent.click(create);
  await waitFor(() => expect(api.createVcrStudy).toHaveBeenCalledWith({ name: "🧪".repeat(40), purpose: "programme", draft: true }));
});
