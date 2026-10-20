import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ScenarioField, schemas } from "./VcrScenarioEditor";
it("labels variants in Chinese but emits the original code", () => {
  const change = vi.fn(); const schema = schemas["population.scenario"].fields!.population.fields!.variables.items!;
  render(<ScenarioField method="population.scenario" path="population.variables[0]" schema={schema} value={{ name: "age", family: "normal" }} root={{}} title="变量" change={change} />);
  expect(screen.getByRole("option", { name: "正态分布" })).toHaveValue("normal");
  fireEvent.change(screen.getByLabelText("类型"), { target: { value: "bernoulli" } });
  expect(change).toHaveBeenLastCalledWith({ family: "bernoulli" });
});
it("labels booleans and rule controls without changing typed or source values", () => {
  const change = vi.fn();
  const { rerender } = render(<ScenarioField method="comparator.evalue" path="rare" schema={{ t: "boolean" }} value={true} root={{}} title="罕见事件" change={change} />);
  expect(screen.getByRole("option", { name: "是" })).toHaveValue("true");
  fireEvent.change(screen.getByLabelText("罕见事件"), { target: { value: "false" } }); expect(change).toHaveBeenLastCalledWith(false);
  rerender(<ScenarioField method="population.synthpop" path="constraints" schema={{ t: "rules" }} value={[{ name: "normal", rule: { op: "compare", column: "alpha", comparator: "gte", value: "normal" } }]} root={{}} title="条件" change={change} />);
  expect(screen.getByRole("option", { name: "比较" })).toHaveValue("compare");
  expect(screen.getByRole("option", { name: "大于或等于（≥）" })).toHaveValue("gte");
  expect(screen.getByLabelText("比较值")).toHaveValue("normal"); expect(screen.getByLabelText("数据列")).toHaveValue("alpha");
  fireEvent.change(screen.getByLabelText("比较方式"), { target: { value: "lt" } });
  expect(change.mock.calls.at(-1)![0][0].rule).toEqual({ op: "compare", column: "alpha", comparator: "lt", value: "normal" });
  fireEvent.change(screen.getByLabelText("运算"), { target: { value: "all" } }); expect(change.mock.calls.at(-1)![0][0].rule).toEqual({ op: "all" });
});
it("uses the dependent allowed sets and keeps an incompatible saved choice until explicitly changed", () => {
  const change = vi.fn(); const schema = schemas["comparator.tipping_point"].fields!.analysis.fields!.method;
  const { rerender } = render(<ScenarioField method="comparator.tipping_point" path="analysis.method" schema={schema} value="fisher_exact" root={{ design: { kind: "two_arm" } }} title="方法" change={change} />);
  expect(screen.getByRole("option", { name: "Fisher 精确检验" })).toHaveValue("fisher_exact"); expect(screen.queryByRole("option", { name: "精确二项检验" })).toBeNull();
  rerender(<ScenarioField method="comparator.tipping_point" path="analysis.method" schema={schema} value="fisher_exact" root={{ design: { kind: "single_arm" } }} title="方法" change={change} />);
  expect(screen.getByLabelText("方法")).toHaveValue("fisher_exact"); expect(screen.getByLabelText("方法")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("当前方法不适用于所选试验设计，请重新选择。")).toBeInTheDocument(); expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("方法"), { target: { value: "exact_binomial" } }); expect(change).toHaveBeenCalledWith("exact_binomial");
  rerender(<ScenarioField method="comparator.tipping_point" path="analysis.method" schema={schema} value={undefined} root={{}} title="方法" change={change} />);
  expect(screen.getByLabelText("方法")).toBeDisabled(); expect(screen.getByText("请选择试验设计后再选择方法。")).toBeInTheDocument();
});
it("does not translate user category strings", () => {
  render(<ScenarioField method="population.scenario" path="population.variables[0].levels[0]" schema={{ t: "string" }} value="normal" root={{}} title="来源类别" change={() => {}} />);
  expect(screen.getByLabelText("来源类别")).toHaveValue("normal");
});

it("keeps all four forecast forms localized without rewriting provider, model or endpoint strings", async () => {
  const { VcrForecastMethodInputs } = await import("./VcrForecastMethodInputs");
  const data = { available: true, providers: [{ id: "provider_1", name: "Source Predictor", version: "v1" }], records: ["history", "prediction", "prediction_set", "trial_prediction"].map((kind, index) => ({ id: `record_${index}`, kind, createdAt: "2026-10-20", hash: "hash", summary: { endpoint: { code: "source_endpoint", unit: "cycles", type: "continuous" }, model: { name: "Source Model", version: "source_v2" } } })), templates: { events: { columns: [], example: [] }, prediction: {} } };
  const changed = vi.fn();
  const { rerender } = render(<VcrForecastMethodInputs method="forecast.trajectories" data={data} value={{ endpoint: { code: "source_endpoint", unit: "cycles" } }} onChange={changed} />);
  expect(screen.getByRole("option", { name: "Source Predictor · v1" })).toHaveValue("provider_1");
  expect(screen.getByLabelText("预测终点")).toHaveValue("source_endpoint"); expect(screen.getByLabelText("终点单位")).toHaveValue("cycles");
  fireEvent.change(screen.getByLabelText("预测类型"), { target: { value: "survival_probability" } }); expect(changed).toHaveBeenCalledWith({ endpoint: { code: "source_endpoint", unit: "cycles", type: "survival_probability" } });
  rerender(<VcrForecastMethodInputs method="forecast.compare" data={data} value={{}} onChange={changed} />);
  expect(screen.getByRole("option", { name: "输入敏感性" })).toHaveValue("input_sensitivity");
  expect(screen.getAllByRole("option", { name: /source_endpoint.*source_v2/ }).length).toBeGreaterThan(0);
  rerender(<VcrForecastMethodInputs method="forecast.evaluate" data={data} value={{}} onChange={changed} />); expect(screen.getByLabelText("后续结局历史")).toBeInTheDocument();
  rerender(<VcrForecastMethodInputs method="forecast.trial_benchmark" data={data} value={{}} onChange={changed} />); expect(screen.getByLabelText("试验预测基准")).toBeInTheDocument();
});
