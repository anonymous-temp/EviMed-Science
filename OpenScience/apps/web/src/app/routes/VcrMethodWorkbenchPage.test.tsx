import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, Link } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { VcrMethodWorkbenchPage } from "./VcrMethodWorkbenchPage";
const api = vi.hoisted(() => ({ getVcrJob: vi.fn(), getVcrMethodConfiguration: vi.fn(), getVcrMethodResult: vi.fn(), queueVcrJob: vi.fn(), createVcrStudy: vi.fn() }));
vi.mock("@/lib/vcrClient", async load => ({ ...await load<object>(), ...api }));
beforeEach(() => { vi.clearAllMocks(); api.getVcrJob.mockImplementation(async (_s, id) => ({ id, kind: "evalue", state: "succeeded" })); api.getVcrMethodConfiguration.mockResolvedValue({ method: "comparator.evalue", scenario: { riskRatio: 4 }, seed: 9, inputRefs: [] }); api.getVcrMethodResult.mockResolvedValue({ result: null, records: { state: "unavailable" } }); });
afterEach(cleanup);
function draw(path: string) { return render(<MemoryRouter initialEntries={[path]}><Link to="/app/capabilities/methods/evalue?study=b&job=job_b">Other history</Link><Routes><Route path="/app/capabilities/methods/:methodId" element={<VcrMethodWorkbenchPage />} /></Routes></MemoryRouter>); }
it.each(["", "?study=a"])("retires the unaddressed calculator %s without creating work", async query => {
  draw(`/app/capabilities/methods/evalue${query}`); expect(screen.getByText("计算已移入研究对话")).toBeInTheDocument();
  expect(api.getVcrJob).not.toHaveBeenCalled(); expect(api.queueVcrJob).not.toHaveBeenCalled(); expect(api.createVcrStudy).not.toHaveBeenCalled();
});
it("reads the exact historical job and its configuration without editable controls", async () => {
  draw("/app/capabilities/methods/evalue?study=a&job=job_a");
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("a", "job_a"));
  expect(api.getVcrMethodConfiguration).toHaveBeenCalledWith("a", "job_a");
  expect(screen.queryByRole("button", { name: /运行|保存|复用/ })).toBeNull(); expect(screen.queryByRole("spinbutton")).toBeNull();
});
it("keeps an actual historical result while independently retrying its unavailable configuration", async () => {
  api.getVcrMethodConfiguration.mockRejectedValueOnce(new Error("configuration unavailable"));
  api.getVcrMethodResult.mockResolvedValue({ result: { id: "saved_result", conclusion: "estimable", measures: [{ name: "e_value", value: 2 }] }, records: { available: false } });
  draw("/app/capabilities/methods/evalue?study=a&job=job_a");
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("a", "job_a"));
  expect(await screen.findByRole("table", { name: "本次计算指标" })).toHaveTextContent("E-value");
  await userEvent.click(screen.getByText("本次运行配置"));
  await userEvent.click(await screen.findByRole("button", { name: "重读配置" }));
  await waitFor(() => expect(api.getVcrMethodConfiguration).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("table", { name: "本次计算指标" })).toHaveTextContent("2");
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
it("discards a delayed previous study response after switching historical addresses", async () => {
  let resolve!: (value: object) => void; api.getVcrJob.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  draw("/app/capabilities/methods/evalue?study=a&job=job_a"); await userEvent.click(screen.getByRole("link", { name: "Other history" }));
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("b", "job_b"));
  await act(async () => resolve({ id: "job_a", kind: "evalue", state: "succeeded" }));
  expect(api.getVcrMethodResult).not.toHaveBeenCalledWith("a", "job_a");
});
it("preserves a visible read failure and retry without offering a new calculation", async () => {
  api.getVcrJob.mockRejectedValueOnce(new Error("unavailable")); draw("/app/capabilities/methods/evalue?study=a&job=job_a");
  await userEvent.click(await screen.findByRole("button", { name: "重试" }));
  await waitFor(() => expect(api.getVcrMethodResult).toHaveBeenCalledWith("a", "job_a"));
  expect(api.queueVcrJob).not.toHaveBeenCalled();
});
