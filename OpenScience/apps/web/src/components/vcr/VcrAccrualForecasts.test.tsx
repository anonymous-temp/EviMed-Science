import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { VcrValue } from "@/lib/vcrClient";
import { VcrAccrualForecasts } from "./VcrAccrualForecasts";
const value = (n: number) => ({ value: n, unit: "月", source: "predicted", interval: null, mcse: null, review: null, precision: 1, reason: null, stale: false, detail: null } as VcrValue);
afterEach(cleanup);
it("labels the retained last-patient-in estimate separately and plots actual monthly probabilities", () => {
  const { container } = render(<VcrAccrualForecasts forecasts={[{ id: "res_accrual", version: 3, scenarioId: "scenario_a", scenarioVersion: 2, design: "A", name: "方案 A", lastPatientIn: value(11.7), targetEvents: value(19), probabilityByMonth: [{ month: 0, probability: 0 }, { month: 6, probability: 0.35 }, { month: 12, probability: 0.8 }] }]} />);
  const table = screen.getByRole("table", { name: "保留的入组时间预测" });
  expect(table).toHaveTextContent("末例入组时间（月）"); expect(table).toHaveTextContent("11.7");
  expect(table).not.toHaveTextContent("平均研究时长");
  expect(screen.getByText("截至该月完成入组的概率")).toBeInTheDocument();
  expect(container.querySelector('[data-vcr-series="res_accrual"]')).toHaveAttribute("data-vcr-series-source", "predicted");
});
it("keeps absent estimates unavailable without manufacturing a duration or a curve", () => {
  const { container } = render(<VcrAccrualForecasts forecasts={[{ id: "old_result", version: 1, scenarioId: null, scenarioVersion: null, design: null, name: "入组假设模拟", lastPatientIn: null, targetEvents: null, probabilityByMonth: [] }]} />);
  expect(screen.getByRole("table", { name: "保留的入组时间预测" })).toHaveTextContent("未提供");
  expect(container.querySelector("[data-vcr-series]")).toBeNull();
});
