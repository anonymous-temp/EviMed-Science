import { useState } from "react";
import { validateScenario, validateRowRule, VCR_ROW_RULE_OPS } from "@evimed/domain";
import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ScenarioField, schemas, examples, type Schema } from "./VcrScenarioEditor";
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

it("renders and edits the actual cohort example's structured single rules without changing the example", () => {
  const original = examples["cohort.build"][0].scenario;
  const preserved = structuredClone(original);
  let current = original;
  function Workbench() {
    const [scenario, setScenario] = useState(original);
    current = scenario;
    return <><ScenarioField schema={schemas["cohort.build"]} value={scenario} root={scenario} method="cohort.build" title="队列" change={next => setScenario(next as Record<string, unknown>)} /><button disabled={validateScenario("cohort.build", scenario).length > 0}>运行检查</button></>;
  }
  render(<Workbench />);
  expect(screen.getAllByLabelText("数据列")[0]).toHaveValue("age");
  const age = screen.getAllByLabelText("比较值")[0];
  fireEvent.change(age, { target: { value: "60" } });
  expect((current.rules as Array<{ rule: unknown }>)[0].rule).toEqual({ op: "compare", column: "age", comparator: "gte", value: 60 });
  expect(screen.getByRole("button", { name: "运行检查" })).toBeEnabled();
  fireEvent.change(age, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "运行检查" })).toBeDisabled();
  expect(screen.getByText(/请补齐条件/)).toBeInTheDocument();
  expect(original).toEqual(preserved);
});
it("retains an unknown saved rule until explicit replacement and never renders it as a blank scalar", () => {
  const change = vi.fn();
  const rule = { op: "legacy_filter", expression: "preserved", provenance: { source: "prior" } };
  render(<ScenarioField schema={{ t: "rule" }} value={rule} root={{}} title="条件" change={change} />);
  expect(screen.getByText(/已保留原条件/)).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull(); expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新配置条件" }));
  expect(change).toHaveBeenCalledWith({ op: "compare", column: "", comparator: "gte" });
  expect(rule).toEqual({ op: "legacy_filter", expression: "preserved", provenance: { source: "prior" } });
});

it("edits and removes nested negative group conditions without mutating the saved rule", () => {
  const original = { op: "not", operand: { op: "all", operands: [{ op: "compare", column: "age", comparator: "gte", value: 60 }, { op: "present", column: "prior" }] } };
  const frozen = structuredClone(original); let current: unknown = original;
  function Editor() { const [rule, setRule] = useState<unknown>(original); current = rule; return <ScenarioField schema={{ t: "rule" }} value={rule} root={{}} title="条件" change={setRule} />; }
  render(<Editor />);
  expect(screen.getAllByLabelText("运算").map(input => (input as HTMLSelectElement).value)).toEqual(["not", "all", "compare", "present"]);
  fireEvent.change(screen.getByLabelText("比较值"), { target: { value: "65" } });
  expect(validateRowRule(current)).toEqual([]);
  expect((current as typeof original).operand.operands[0].value).toBe(65);
  fireEvent.click(screen.getAllByRole("button", { name: "移除子条件" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "移除子条件" })[0]);
  expect(validateRowRule(current).length).toBeGreaterThan(0);
  expect(screen.getByRole("alert")).toHaveTextContent("请补齐条件");
  fireEvent.click(screen.getByRole("button", { name: "添加子条件" }));
  fireEvent.change(screen.getByLabelText("数据列"), { target: { value: "age" } });
  expect(validateRowRule(current)).toEqual([]); expect(original).toEqual(frozen);
});
it.each(VCR_ROW_RULE_OPS)("renders the %s rule operator with its typed saved values", op => {
  const rule = op === "all" || op === "any" ? { op, operands: [{ op: "present", column: "age" }] } : op === "not" ? { op, operand: { op: "missing", column: "age" } } : op === "compare" ? { op, column: "age", comparator: "gte", value: 60 } : op === "between" ? { op, column: "age", low: 60, high: 90 } : op === "in" || op === "not_in" ? { op, column: "group", values: [60, false, "source category"] } : { op, column: "age" };
  const change = vi.fn(); render(<ScenarioField schema={{ t: "rule" }} value={rule} root={{}} title="条件" change={change} />);
  expect(screen.getAllByLabelText("运算")[0]).toHaveValue(op);
  expect(screen.getByLabelText("数据列")).toHaveValue(op === "in" || op === "not_in" ? "group" : "age");
  if (op === "in" || op === "not_in") { expect(screen.getByLabelText("匹配值 1")).toHaveValue(60); expect(screen.getByLabelText("匹配值 2")).toHaveValue("false"); expect(screen.getByLabelText("匹配值 3")).toHaveValue("source category"); fireEvent.change(screen.getByLabelText("匹配值 1"), { target: { value: "65" } }); expect(change).toHaveBeenCalledWith({ ...rule, values: [65, false, "source category"] }); }
  else expect(change).not.toHaveBeenCalled();
});

const catalogueRules: Array<{ method: string; path: string; value: unknown }> = [];
const catalogueTypes = new Set<string>();
function catalogueFields(schema: Schema, value: unknown, method: string, path = "") {
  catalogueTypes.add(schema.t);
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (schema.t === "rule") catalogueRules.push({ method, path, value });
  for (const [key, field] of Object.entries(schema.fields ?? {})) catalogueFields(field, object[key], method, `${path}.${key}`);
  if (schema.items) (Array.isArray(value) && value.length ? value : [undefined]).forEach((entry, index) => catalogueFields(schema.items!, entry, method, `${path}[${index}]`));
  if (schema.values && !Array.isArray(schema.values)) catalogueFields(schema.values, undefined, method, `${path}.*`);
  for (const fields of Object.values(schema.variants ?? {})) for (const [key, field] of Object.entries(fields)) catalogueFields(field, object[key], method, `${path}.${key}`);
}
for (const [method, schema] of Object.entries(schemas)) for (const example of examples[method] ?? [{ scenario: {} }]) catalogueFields(schema, example.scenario, method);
it("audits every real catalogue schema kind against an explicit editor", () => {
  expect([...catalogueTypes].sort()).toEqual(["array", "boolean", "integer", "map", "matrix", "number", "object", "rule", "rules", "string", "variant"]);
});
it.each(catalogueRules)("displays the catalogue rule in $method $path without rewriting its scenario", ({ value }) => {
  const change = vi.fn(); const copy = structuredClone(value);
  render(<ScenarioField schema={{ t: "rule" }} value={value} root={{}} title="条件" change={change} />);
  expect(screen.getAllByLabelText("运算").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText("条件")).toBeNull();
  if (value === undefined) expect(screen.getByRole("alert")).toHaveTextContent("请补齐条件");
  expect(change).not.toHaveBeenCalled(); expect(value).toEqual(copy);
});
